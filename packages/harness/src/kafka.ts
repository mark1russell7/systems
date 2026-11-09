import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { valueIn } from "@mark1russell7/quantity";
import type { Cell, GroupPlace, Kafka, KernelRecord, ProbeEvent, Run, RunPart } from "./cell.ts";
import type { GroupClient, GroupNetworkFault, GroupView, Stamp } from "./group.ts";
import { CONVERGE_MS, deadlineOf } from "./group.ts";
import { harnessImage, kafkaClientImage, shippedSource } from "./image.ts";
import type { Manifest } from "./lab.ts";
import { STOP, buildOf, containers, harnessRecord, lines, netnsOf, output, withPid } from "./lab.ts";
import { isFenceLine, namesGroup, pauseReady } from "./pause.ts";
import type { Cut } from "./replset.ts";

/**
 * This module is the lab of a group of Kafka brokers in KRaft mode with one controller. It opens one
 * environment for a Kafka cell, for the runs of the cell. Each node is a container from the stock
 * image, in its own network namespace, and an injector sidecar shares its network and process
 * namespaces. The image starts by its own command, and each setting comes from the environment.
 *
 * Each run makes one new topic, thus each run starts with an empty log and its client counts from 1.
 * The client is the producer of kafka-clients. The commander holds the admin, on the network but
 * not in the namespace that the prober watches. The record of a run is the lines of the client and
 * the whole partition, read to its high watermark after the group converged.
 */

/**
 * This function gives the record of the Kafka client for a manifest: its image, its source and its
 * build record. The pins check refuses a record of a built client without its build record.
 */
export const kafkaClientRecord = (image: string): Manifest["client"] => {
  const source = shippedSource("kafka");
  return { kind: "image", image, source, ...buildOf(source) };
};

/** This path is the class path of the Kafka image: the JVM expands the star itself. */
const CLASS_PATH = "/opt/harness/kafka/classes:/opt/harness/kafka/lib/*";

/** This option is the heap of the client and of the admin. It has no source: the two hold a producer or a read of one partition. */
const CLIENT_HEAP = "-Xmx256m";

/** This function gives the node id of a name. A broker has its place in the list from 1, and the controller has the id after them. */
export const nodeIdOf = (kafka: Kafka, name: string): number => {
  const at = kafka.brokers.indexOf(name);
  if (at !== -1) return at + 1;
  if (name === kafka.controller) return kafka.brokers.length + 1;
  throw new Error(`the Kafka group has no node ${name}`);
};

/**
 * This function gives the variable of a server property for the image. The wrapper of the image
 * reverses this map (KafkaDockerWrapper.scala:188-203). After the prefix `KAFKA_`, `___` is a
 * hyphen, `__` is an underscore and `_` is a dot.
 */
export const envOf = (property: string): string =>
  `KAFKA_${property.replace(/_/g, "__").replace(/-/g, "___").replace(/\./g, "_").toUpperCase()}`;

/** This function gives the variables of each node: the listener names, the voters, the log and the settings of the group. */
const commonEnv = (kafka: Kafka): Record<string, string> => ({
  CLUSTER_ID: kafka.clusterId,
  KAFKA_HEAP_OPTS: kafka.heap,
  KAFKA_CONTROLLER_QUORUM_VOTERS: `${nodeIdOf(kafka, kafka.controller)}@${kafka.controller}:${kafka.controllerPort}`,
  KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
  KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT",
  // the wrapper writes the server properties from these variables alone (KafkaDockerWrapper.scala:147)
  KAFKA_LOG_DIRS: "/var/lib/kafka/data",
  ...Object.fromEntries(Object.entries(kafka.settings).map(([property, value]) => [envOf(property), value])),
});

/** This function gives the environment of a broker. */
export const brokerEnv = (kafka: Kafka, name: string): Record<string, string> => ({
  ...commonEnv(kafka),
  KAFKA_PROCESS_ROLES: "broker",
  KAFKA_NODE_ID: String(nodeIdOf(kafka, name)),
  KAFKA_LISTENERS: `PLAINTEXT://0.0.0.0:${kafka.port}`,
  KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${name}:${kafka.port}`,
  KAFKA_INTER_BROKER_LISTENER_NAME: "PLAINTEXT",
});

/** This function gives the environment of the controller. The start script of the image stops on an advertised listener here (configure:43-48). */
export const controllerEnv = (kafka: Kafka): Record<string, string> => ({
  ...commonEnv(kafka),
  KAFKA_PROCESS_ROLES: "controller",
  KAFKA_NODE_ID: String(nodeIdOf(kafka, kafka.controller)),
  KAFKA_LISTENERS: `CONTROLLER://0.0.0.0:${kafka.controllerPort}`,
});

/** A partition view is the output of the command `view` of the admin. Without a topic it has only the brokers. */
export interface PartitionView {
  readonly brokers: readonly number[];
  readonly leader?: number | null;
  readonly isr?: readonly number[];
  readonly replicas?: readonly number[];
}

/**
 * This function judges a view of a partition: its leader, and if the group is healthy. A healthy
 * group has each broker not fenced, one leader, and each broker in the in-sync replicas.
 */
export const kafkaViewOf = (kafka: Kafka, view: PartitionView): GroupView => {
  const primary = view.leader === undefined || view.leader === null ? null : (kafka.brokers[view.leader - 1] ?? null);
  const all = kafka.brokers.length;
  if (view.brokers.length !== all) return { primary, healthy: false, why: `${view.brokers.length} brokers are not fenced` };
  if (primary === null) return { primary, healthy: false, why: "the partition has no leader" };
  if (view.replicas?.length !== all) return { primary, healthy: false, why: `the partition has ${view.replicas?.length ?? 0} replicas` };
  if (view.isr?.length !== all) return { primary, healthy: false, why: `the partition has ${view.isr?.length ?? 0} in-sync replicas` };
  return { primary, healthy: true, why: "healthy" };
};

/**
 * This function gives the peers that a fault on a broker cuts it from. Only `group` has a law: the
 * other brokers and the controller, and the client keeps its route to the broker.
 */
export const kafkaCutOf = (
  kafka: Kafka,
  members: Readonly<Record<string, RunPart>>,
  controller: RunPart,
  part: string,
  cuts: NonNullable<GroupPlace["cuts"]>,
): Cut => {
  if (cuts !== "group") throw new Error(`a Kafka cell has no cut ${cuts}`);
  return { peers: [...kafka.brokers.filter((name) => name !== part).map((name) => members[name]!.ip), controller.ip] };
};

/** This function gives the addresses that the client and the admin bootstrap from. */
export const bootstrapOf = (kafka: Kafka): string => kafka.brokers.map((name) => `${name}:${kafka.port}`).join(",");

/** This function gives the name of the topic of a run. A warm-up has the index -1. */
export const topicOf = (environment: number, index: number): string => `cells-e${environment}-r${index + 1}`;

/** A Kafka member is one member of a consumer group. A signal goes from a sidecar in its process namespace. */
export interface KafkaMember extends GroupClient {
  /** This method sends a signal to the process of the member, at once or at an instant of the VM. The injector stamps it. */
  signal(signal: "STOP" | "CONT", at?: number): Promise<Stamp>;
}

/** A Kafka lab is one environment of a Kafka cell. */
export interface KafkaLab {
  readonly kafka: Kafka;
  readonly clientIp: string;
  readonly members: Readonly<Record<string, RunPart>>;
  readonly controller: RunPart;
  readonly netns: { readonly client: number };
  /** These are all the records that the prober wrote, in sequence. */
  readonly kernel: readonly KernelRecord[];
  /** These are the last raw lines of the console of each node, for the diagnosis of a lab: at most RAW_TAIL of each. */
  readonly raw: Readonly<Record<string, readonly string[]>>;
  /** This method sets the sysctls of the client namespace through its privileged sidecar, and reads them back. */
  sysctl(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /** This method waits until each broker is not fenced. */
  brokersUp(within?: number): Promise<void>;
  /** These are the log lines of the brokers that tell that a member left a group (`isFenceLine`), in sequence. */
  readonly fences: readonly string[];
  /** This method makes the topic of a run, with one partition or more. */
  create(topic: string, partitions?: number): Promise<void>;
  /** This method writes `count` records in each partition of a topic, each acknowledged by each in-sync replica. */
  fill(topic: string, partitions: number, count: number): Promise<void>;
  /** This method starts one member of a consumer group, with the arguments of `ConsumerKafka` after the bootstrap. */
  consumer(args: readonly string[]): Promise<KafkaMember>;
  /** This method waits until the partition is whole and calm, and gives the name of the broker of its leader. */
  converge(topic: string, within?: number): Promise<string>;
  /** This method gives the sequence numbers that the partition holds, one entry for each copy. */
  holds(topic: string): Promise<number[]>;
  /** This method starts the client of a run, with the arguments of `ClientKafka`. */
  client(args: readonly string[]): Promise<GroupClient>;
  /** This method applies a network fault between a broker and some of its peers, at once or at an instant of the VM. */
  fault(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method removes a network fault, at once or at an instant of the VM. */
  lift(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method removes the TCP metrics of the client namespace: each run starts from a kernel that keeps nothing. */
  forget(): Promise<void>;
  /** This method waits for the next clock line of the prober, which gives the count of lost records. */
  settle(): Promise<number | null>;
  manifest(sysctls: Readonly<Record<string, string>>): Promise<Manifest>;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** This count is the number of raw lines of the console of each node that a lab keeps. */
export const RAW_TAIL = 400;

/**
 * This function opens one environment of a Kafka cell:
 * - one new network, with each node, the client and the commander on it.
 * - the controller first, then each broker: the stock image with its own command. The brokers
 *   register with the controller, thus they need it first.
 * - an injector sidecar for each node, in its network and process namespaces.
 * - a client that holds its own network namespace, with a privileged sidecar for its sysctls.
 * - the prober, which watches the namespace of the client.
 */
export const openKafkaLab = async (kafka: Kafka): Promise<KafkaLab> => {
  const image = await harnessImage();
  const clientImage = await kafkaClientImage();
  const { GenericContainer, Network, Wait, getContainerRuntimeClient } = await containers();
  const runtime = await getContainerRuntimeClient();
  const opened: StartedTestContainer[] = [];
  let network: StartedNetwork | undefined;
  const close = async () => {
    for (const container of opened.reverse()) await container.stop(STOP).catch(() => undefined);
    await network?.stop().catch(() => undefined);
  };
  const ipOf = async (container: StartedTestContainer): Promise<string> => {
    const info = await runtime.container.inspect(runtime.container.getById(container.getId()));
    const ip = info.NetworkSettings.Networks[network!.getName()]?.IPAddress;
    if (ip === undefined || ip === "") throw new Error(`${container.getName()} has no address on ${network!.getName()}`);
    return ip;
  };
  try {
    network = await new Network().start();
    const started = network;
    const boxes = new Map<string, StartedTestContainer>();
    const injectors = new Map<string, StartedTestContainer>();
    const parts: Record<string, RunPart> = {};
    const raw: Record<string, string[]> = {};
    const fences: string[] = [];
    const openNode = async (name: string, environment: Record<string, string>): Promise<void> => {
      let partial = "";
      const box = await new GenericContainer(kafka.image)
        .withNetwork(started)
        .withNetworkAliases(name)
        .withHostname(name)
        .withEnvironment(environment)
        .withWaitStrategy(Wait.forLogMessage(kafka.ready))
        .withStartupTimeout(180_000)
        .withLogConsumer((stream) =>
          stream.on("data", (chunk: Buffer | string) => {
            partial += chunk.toString();
            const split = partial.split("\n");
            partial = split.pop() ?? "";
            for (const text of split) {
              const tail = (raw[name] ??= []);
              tail.push(text);
              if (tail.length > RAW_TAIL) tail.shift();
              if (isFenceLine(text)) fences.push(text);
            }
          }),
        )
        .start();
      opened.push(box);
      boxes.set(name, box);
      const injector = await withPid(
        new GenericContainer(image).withNetworkMode(`container:${box.getId()}`).withAddedCapabilities("NET_ADMIN", "NET_RAW"),
        `container:${box.getId()}`,
      ).start();
      opened.push(injector);
      injectors.set(name, injector);
      parts[name] = { ip: await ipOf(box), netns: await netnsOf(injector) };
    };
    await openNode(kafka.controller, controllerEnv(kafka));
    for (const name of kafka.brokers) await openNode(name, brokerEnv(kafka, name));
    const members: Record<string, RunPart> = Object.fromEntries(kafka.brokers.map((name) => [name, parts[name]!]));
    const controller = parts[kafka.controller]!;

    const holder = await new GenericContainer(image).withNetwork(network).start();
    opened.push(holder);
    const admin = await new GenericContainer(image).withNetworkMode(`container:${holder.getId()}`).withPrivilegedMode().start();
    opened.push(admin);
    const clientIp = await ipOf(holder);
    const commander = await new GenericContainer(clientImage)
      .withNetwork(network)
      .withCommand(["sh", "-c", "while :; do sleep 3600; done"])
      .start();
    opened.push(commander);

    const clientNetns = await netnsOf(admin);
    const records = lines<KernelRecord>();
    const prober = await new GenericContainer(image)
      .withPrivilegedMode()
      .withNetworkMode("none")
      .withCommand(["/opt/harness/prober", String(clientNetns)])
      .withLogConsumer(records.consume)
      .start();
    opened.push(prober);
    const begun = await records.until(["begin", "fail"], 30_000, "prober");
    if (begun.ev === "fail") throw new Error(`the prober failed: ${String(begun["why"])}`);

    const box = (name: string): StartedTestContainer => {
      const found = boxes.get(name);
      if (found === undefined) throw new Error(`the group has no node ${name}`);
      return found;
    };
    const injectorOf = (name: string): StartedTestContainer => {
      const found = injectors.get(name);
      if (found === undefined) throw new Error(`the group has no node ${name}`);
      return found;
    };
    const lastLine = (text: string): string => text.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
    const stamped = async (where: StartedTestContainer, argv: string[]): Promise<Stamp> => {
      const stamp = JSON.parse(lastLine(await output(where, argv))) as Stamp;
      return { t0: stamp.t0, t1: stamp.t1 };
    };
    const after = (at: number | undefined): string[] => (at === undefined ? [] : ["--at", String(Math.round(at))]);
    const bootstrap = bootstrapOf(kafka);
    const tool = async (...argv: string[]): Promise<string> =>
      lastLine(await output(commander, ["java", CLIENT_HEAP, "-cp", CLASS_PATH, "AdminKafka", bootstrap, ...argv]));
    const view = async (topic?: string): Promise<PartitionView> =>
      JSON.parse(await tool("view", ...(topic === undefined ? [] : [topic]))) as PartitionView;

    return {
      kafka,
      clientIp,
      members,
      controller,
      netns: { client: clientNetns },
      kernel: records.seen,
      raw,
      fences,
      async sysctl(values) {
        const settings = Object.entries(values).map(([key, value]) => `${key}=${value}`);
        if (settings.length > 0) await output(admin, ["sysctl", "-q", "-w", ...settings]);
        const read: Record<string, string> = {};
        for (const key of Object.keys(values)) read[key] = await output(admin, ["sysctl", "-n", key]);
        return read;
      },
      async brokersUp(within = CONVERGE_MS) {
        const begin = Date.now();
        let last = "no view yet";
        while (Date.now() - begin < within) {
          const read = await view().catch((error: unknown) => (error as Error).message.slice(0, 200));
          if (typeof read !== "string" && read.brokers.length === kafka.brokers.length) return;
          last = typeof read === "string" ? read : `${read.brokers.length} brokers are not fenced`;
          await sleep(1_000);
        }
        throw new Error(`the brokers did not come up in ${within} ms: ${last}`);
      },
      async create(topic, partitions = 1) {
        const ids = kafka.brokers.map((name) => nodeIdOf(kafka, name)).join(",");
        const reply = await tool("create", topic, String(kafka.minInsync), ids, String(partitions));
        if (!reply.includes('"ok":true')) throw new Error(`the create of the topic failed: ${reply}`);
      },
      async fill(topic, partitions, count) {
        const reply = await tool("fill", topic, String(partitions), String(count));
        if (!reply.includes('"ok":true')) throw new Error(`the fill of the topic failed: ${reply}`);
      },
      async consumer(args) {
        const events = lines<ProbeEvent>();
        // sh stays as process 1, because a signal from inside a process namespace to its process 1 has no effect
        const container = await new GenericContainer(clientImage)
          .withNetworkMode(`container:${holder.getId()}`)
          .withCommand(["sh", "-c", 'java "$@"; :', "consumer", CLIENT_HEAP, "-cp", CLASS_PATH, "ConsumerKafka", bootstrap, ...args])
          .withLogConsumer(events.consume)
          .start();
        const signaller = await withPid(
          new GenericContainer(image).withNetworkMode(`container:${holder.getId()}`).withAddedCapabilities("NET_ADMIN", "NET_RAW"),
          `container:${container.getId()}`,
        ).start();
        return {
          events: events.seen,
          until: (kinds, within) => events.until(kinds, within, "client"),
          signal: (signal, at) => stamped(signaller, ["/opt/harness/inject", "signal", "java", signal, ...after(at)]),
          // process 1 is sh and it ignores a TERM, thus this stop ends with a KILL, and it writes no done line
          stop: async () => {
            await container.stop({ timeout: 2 }).catch(() => undefined);
            await signaller.stop(STOP).catch(() => undefined);
          },
        };
      },
      async converge(topic, within = CONVERGE_MS) {
        const begin = Date.now();
        let calm = 0;
        let last: GroupView = { primary: null, healthy: false, why: "no view yet" };
        while (Date.now() - begin < within) {
          last = await view(topic).then(
            (read) => kafkaViewOf(kafka, read),
            (error: unknown) => ({ primary: null, healthy: false, why: (error as Error).message.slice(0, 200) }),
          );
          // two healthy views in a row: one view can come in the middle of a change, and the
          // high watermark moves with the fetch after the one that put a broker back in sync
          calm = last.healthy ? calm + 1 : 0;
          if (calm >= 2 && last.primary !== null) return last.primary;
          await sleep(1_000);
        }
        throw new Error(`the partition did not converge in ${within} ms: ${last.why}`);
      },
      async holds(topic) {
        const reply = await tool("holds", topic);
        const { held } = JSON.parse(reply) as { held?: unknown[] };
        if (held === undefined) throw new Error(`the read of the partition failed: ${reply}`);
        return held.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      },
      async client(args) {
        const events = lines<ProbeEvent>();
        const container = await new GenericContainer(clientImage)
          .withNetworkMode(`container:${holder.getId()}`)
          .withCommand(["java", CLIENT_HEAP, "-cp", CLASS_PATH, "ClientKafka", bootstrap, ...args])
          .withLogConsumer(events.consume)
          .start();
        return {
          events: events.seen,
          until: (kinds, within) => events.until(kinds, within, "client"),
          // a TERM first: the client writes its done line, then stops
          stop: () =>
            container
              .stop({ timeout: 2 })
              .then(() => undefined)
              .catch(() => undefined),
        };
      },
      fault(kind, part, cuts, at) {
        const cut = kafkaCutOf(kafka, members, controller, part, cuts);
        return stamped(injectorOf(part), ["/opt/harness/inject", kind, cut.peers.join(","), ...after(at)]);
      },
      lift(kind, part, cuts, at) {
        const cut = kafkaCutOf(kafka, members, controller, part, cuts);
        return stamped(injectorOf(part), ["/opt/harness/inject", kind === "rst" ? "clear-rst" : "clear", cut.peers.join(","), ...after(at)]);
      },
      async forget() {
        await output(admin, ["ip", "tcp_metrics", "flush", "all"]);
      },
      async settle() {
        const from = records.seen.length;
        const clock = await new Promise<KernelRecord | null>((resolve) => {
          const begin = Date.now();
          const look = () => {
            const line = records.seen.slice(from).find((record) => record.ev === "clock");
            if (line !== undefined) resolve(line);
            else if (Date.now() - begin > 5_000) resolve(null);
            else setTimeout(look, 50);
          };
          look();
        });
        return clock === null ? null : Number(clock["lost"] ?? 0);
      },
      async manifest(sysctls) {
        const config = await output(admin, ["zcat", "/proc/config.gz"]).catch(() => "");
        const inspect = async (container: StartedTestContainer) => runtime.container.inspect(runtime.container.getById(container.getId()));
        const settings = {
          settings: Object.entries(kafka.settings)
            .map(([property, value]) => `${property}=${value}`)
            .join("; "),
          heap: kafka.heap,
          "min.insync.replicas": String(kafka.minInsync),
        };
        const list = async (names: readonly string[]) => {
          const out = [];
          for (const name of names) {
            const version = lastLine(await output(box(name), ["/opt/kafka/bin/kafka-topics.sh", "--version"]).catch(() => ""));
            out.push({ name, ip: parts[name]!.ip, id: (await inspect(box(name))).Image, settings: { version, ...settings } });
          }
          return out;
        };
        const brokers = await list(kafka.brokers);
        return {
          kernel: await output(holder, ["uname", "-r"]),
          architecture: await output(holder, ["uname", "-m"]),
          hz: /^CONFIG_HZ=(\d+)$/m.exec(config)?.[1] ?? null,
          boot_id: await output(holder, ["cat", "/proc/sys/kernel/random/boot_id"]),
          docker: `${runtime.info.containerRuntime.serverVersion} on ${runtime.info.containerRuntime.operatingSystem}`,
          target: { image: kafka.image, id: brokers[0]!.id, settings: brokers[0]!.settings, sysctls: {} },
          harness: {
            image,
            id: (await inspect(holder)).Image,
            packages: (await output(holder, ["apk", "info", "-v"])).split("\n").sort(),
            ...harnessRecord(),
          },
          client: kafkaClientRecord(clientImage),
          netns: { client: clientNetns, target: members[kafka.brokers[0]!]!.netns },
          sysctls,
          group: { members: brokers, sentinels: await list([kafka.controller]), observer: { image: clientImage } },
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
};

// ---------------------------------------------------------------------------------------------
// the runs of a Kafka cell
// ---------------------------------------------------------------------------------------------

/** This count is the number of acknowledged writes that a run waits for before its fault: the stream is steady then. */
const STEADY = 20;

/**
 * This time is how long a run continues after its lift. The record then shows the step-down of the
 * leader and the writes after it. It has no source. It is above the largest step-down of the
 * law, which is approximately 2 s after the lift.
 */
export const KAFKA_TAIL_MS = 10_000;

/** This function gives the arguments of the client of a Kafka cell: the topic, the writers, the stream of writes and the settings. */
export const kafkaArgs = (cell: Cell, topic: string): string[] => [
  "--topic",
  topic,
  "--writers",
  String(cell.kafka!.writers),
  "--interval-ms",
  String(cell.probe.interval === undefined ? 50 : valueIn(cell.probe.interval, "ms")),
  "--max-s",
  String(Math.ceil(deadlineOf(cell) / 1_000 + (cell.hold === undefined ? 0 : valueIn(cell.hold, "s")) + 120)),
  ...Object.entries(cell.driverOptions ?? {}).flatMap(([name, value]) => ["--set", `${name}=${String(value)}`]),
];

/** This function waits until a condition on the lines of the client holds, or for `within` ms. It gives the first line that matches. */
const waitFor = (client: GroupClient, match: (event: ProbeEvent) => boolean, within: number): Promise<ProbeEvent | undefined> =>
  new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const found = client.events.find(match);
      if (found !== undefined || Date.now() - started > within) resolve(found);
      else setTimeout(look, 20);
    };
    look();
  });

/** This function gives the count of lost records in the latest clock line of the prober. */
const droppedSoFar = (records: readonly KernelRecord[]): number => {
  for (let at = records.length - 1; at >= 0; at -= 1) if (records[at]!.ev === "clock") return Number(records[at]!["lost"] ?? 0);
  return 0;
};

/**
 * This function does one run of a Kafka cell:
 * - Each broker is up, the topic of the run exists, and its partition is whole. The client starts,
 *   and its stream of writes gets steady.
 * - The fault cuts the leader from the other brokers and the controller, and it lifts at its instant
 *   in the VM. The client keeps its route to the leader, thus only the group knows of the cut.
 * - The run waits for the lift and for the tail after it.
 * - Each fault goes, the client stops, and the partition converges again. The admin then reads
 *   the whole partition, thus the record tells which writes the group kept.
 */
export const kafkaOnce = async (lab: KafkaLab, cell: Cell, environment: number, index: number): Promise<Run> => {
  if (cell.fault !== "partition") throw new Error(`a Kafka cell has no fault ${cell.fault}`);
  if (cell.hold === undefined) throw new Error("a Kafka cell needs a hold: its law reads it");
  const place = (cell.faultAt ?? { role: "primary" }) as GroupPlace;
  if (place.role !== "primary") throw new Error(`a Kafka cell has no fault on the ${place.role}`);
  const cuts = place.cuts ?? "group";
  const topic = topicOf(environment, index);
  await lab.brokersUp();
  await lab.create(topic);
  const leader = await lab.converge(topic);
  await lab.forget();
  const from = lab.kernel.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const client = await lab.client(kafkaArgs(cell, topic));
  let fault: Run["fault"] = null;
  let heal: Run["heal"] = null;
  const undo: Array<() => Promise<unknown>> = [];
  try {
    await client.until(["ready"], 60_000);
    const steady = await waitFor(client, (event) => event.ev === "ack" && Number(event["n"]) >= STEADY, 30_000);
    if (steady === undefined) throw new Error(`the client did not write ${STEADY} times in 30 s`);
    fault = await lab.fault("blackhole", leader, cuts);
    undo.push(() => lab.lift("blackhole", leader, cuts));
    // the injector holds the lift in the VM: its exec returns at the instant, and the stamps come with it
    heal = await lab.lift("blackhole", leader, cuts, fault.t0 + valueIn(cell.hold, "s") * 1e9);
    // the lift came: nothing is left to undo
    undo.length = 0;
    await sleep(KAFKA_TAIL_MS);
  } finally {
    // a fault that is still on goes
    for (const step of undo.reverse()) await step().catch(() => undefined);
    await client.stop();
  }
  const settled = await lab.settle();
  const lost = settled === null ? null : settled - lostBefore;
  const after = await lab.converge(topic).catch(() => null);
  const holds = after === null ? null : await lab.holds(topic);
  return {
    environment,
    index,
    events: [...client.events],
    fault,
    ...(heal === null ? {} : { heal }),
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.members[leader]!.netns,
    lost,
    group: {
      members: lab.members,
      sentinels: { [lab.kafka.controller]: lab.controller },
      primary: leader,
      at: leader,
      timeline: [],
      after,
      holds,
    },
  };
};

/** This count is the partitions of the topic of a run of a paused consumer: one for each member. */
const PAUSE_PARTITIONS = 2;

/** This time bounds the wait for one partition for each member and for two commits, in ms. It has no source: it is far above two batches and one rebalance. */
const PAUSE_READY_MS = 90_000;

/** This time bounds the wait for the next batch of the first member, in ms. It has no source: it is far above one batch. */
const PAUSE_BATCH_MS = 30_000;

/**
 * This function does one run of a paused consumer:
 * - The topic of the run has two partitions, each with records that a run does not finish.
 * - Two members join one group, and the run waits until each member holds one partition and the
 *   first member has two commits on its partition.
 * - A SIGSTOP stops the first member while it holds its next batch, and a SIGCONT ends the stop
 *   after the hold of the cell. The run then waits for the tail.
 *
 * The fault is null when the members did not get one partition each. The measure then voids the run.
 * The law reads no kernel record, thus a lost record does not void this run.
 */
export const kafkaPauseOnce = async (lab: KafkaLab, cell: Cell, environment: number, index: number): Promise<Run> => {
  const pause = cell.kafka?.pause;
  if (pause === undefined) throw new Error("a run of a paused consumer needs `Kafka.pause`");
  if (cell.fault !== "freeze-process") throw new Error(`a paused consumer has no fault ${cell.fault}`);
  if (cell.hold === undefined) throw new Error("a paused consumer needs a hold: its law reads it");
  const hold = valueIn(cell.hold, "s");
  const topic = topicOf(environment, index);
  const group = `pause-e${environment}-r${index + 1}`;
  await lab.brokersUp();
  await lab.create(topic, PAUSE_PARTITIONS);
  const leader = await lab.converge(topic);
  await lab.fill(topic, PAUSE_PARTITIONS, pause.fill);
  await lab.forget();
  const from = lab.kernel.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const common = [
    "--topic",
    topic,
    "--group",
    group,
    "--protocol",
    pause.protocol,
    "--max-s",
    String(Math.ceil(hold + 180)),
    ...Object.entries(cell.driverOptions ?? {}).flatMap(([name, value]) => ["--set", `${name}=${String(value)}`]),
  ];
  const members: KafkaMember[] = [];
  let fault: Run["fault"] = null;
  let heal: Run["heal"] = null;
  let otherEvents: readonly ProbeEvent[] = [];
  let firstEvents: readonly ProbeEvent[] = [];
  try {
    const first = await lab.consumer([...common, "--process-ms", String(valueIn(pause.process, "ms")), "--after-pause", pause.afterPause]);
    members.push(first);
    const other = await lab.consumer([...common, "--process-ms", "0", "--after-pause", "commit"]);
    members.push(other);
    firstEvents = first.events;
    otherEvents = other.events;
    const begun = Date.now();
    while (Date.now() - begun < PAUSE_READY_MS && !pauseReady(first.events, other.events)) await sleep(100);
    if (pauseReady(first.events, other.events)) {
      const seen = first.events.at(-1)?.t ?? 0;
      const batch = await waitFor(first, (event) => event.ev === "processing" && event.t > seen, PAUSE_BATCH_MS);
      if (batch !== undefined) {
        fault = await first.signal("STOP", batch.t + valueIn(pause.stopAfter, "s") * 1e9);
        // the injector holds the signal in the VM: its exec returns at the instant, and the stamps come with it
        heal = await first.signal("CONT", fault.t0 + hold * 1e9);
        await sleep(KAFKA_TAIL_MS);
      }
    }
  } finally {
    for (const member of members) await member.stop();
  }
  const settled = await lab.settle();
  return {
    environment,
    index,
    events: [...firstEvents],
    fault,
    ...(heal === null ? {} : { heal }),
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.members[leader]!.netns,
    lost: settled === null ? null : settled - lostBefore,
    pause: { other: [...otherEvents], fences: lab.fences.filter((line) => namesGroup(line, group)), group },
  };
};
