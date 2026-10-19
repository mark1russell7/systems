import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { valueIn } from "@mark1russell7/quantity";
import type { Cell, Cluster, GroupPlace, GroupRole, KernelRecord, ProbeEvent, Run, RunPart, SentinelEvent } from "./cell.ts";
import type { GroupClient, GroupNetworkFault, GroupView, Stamp } from "./group.ts";
import { CONVERGE_MS, deadlineOf } from "./group.ts";
import { amqpClientImage, harnessImage } from "./image.ts";
import type { Manifest } from "./lab.ts";
import { STOP, containers, lines, netnsOf, output, withPid } from "./lab.ts";
import type { Cut } from "./replset.ts";
import { clockOffsetOf } from "./replset.ts";

/**
 * This module is the lab of a cluster of RabbitMQ with one quorum queue. The members of the queue
 * elect its leader by Raft, one member on each node. It opens one environment for a cluster cell,
 * for the runs of the cell. Each node is a container from the stock image of the cluster, in its own
 * network namespace. An injector sidecar shares its network and process namespaces.
 *
 * The client of each run is amqplib. It publishes a stream of sequence numbers with confirms through
 * one node, and it connects to the next node when its connection ends. The timeline comes from
 * the log of each node and from the lines of the client. The prober watches the namespace of the client.
 */

/**
 * A node line is one log line of a node, as RabbitMQ writes it to its console. `real` is its time on
 * the wall clock in ms, with its microseconds. `t` is its time on the monotonic clock: the run gives
 * it from the clock lines of its client.
 */
export interface NodeLine extends SentinelEvent {
  readonly ev: "rabbit";
  readonly member: string;
  readonly real: number;
  readonly level: string;
  readonly msg: string;
}

/** This form is a line of the console log of RabbitMQ 4.3: the time with its offset, the level, the process and the message. */
const LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\.(\d{3})(\d*)([+-]\d\d:\d\d) \[(\w+)\] <[^>]*> (.*)$/;

/** This text is the name of a quorum queue in the log of Ra: its friendly name. */
export const logNameOf = (queue: string): string => `queue '${queue}' in vhost '/'`;

/**
 * This function reads one log line of a node, or gives null for a line that a run does not keep. A
 * run keeps each line of the queue, each warning and each error, and each line of the maintenance
 * mode of a drain.
 */
export const nodeLineOf = (member: string, text: string, queue: string): NodeLine | null => {
  const found = LINE.exec(text);
  if (found === null) return null;
  const [, day, time, ms, us, offset, level, msg] = found as unknown as [string, string, string, string, string, string, string, string];
  const kept = msg.includes(logNameOf(queue)) || level === "warning" || level === "error" || msg.includes("maintenance");
  if (!kept) return null;
  const real = Date.parse(`${day}T${time}.${ms}${offset}`) + (us === "" ? 0 : Number(`0.${us}`));
  if (!Number.isFinite(real)) return null;
  return { ev: "rabbit", t: 0, member, real, level, msg };
};

/** This function puts the log lines of the nodes on the monotonic clock, with the offset of a client. */
export const nodesOnMonotonic = (log: readonly NodeLine[], offset: number | null): NodeLine[] =>
  log.map((line) => ({ ...line, t: offset === null ? 0 : Math.round(line.real * 1e6 - offset) }));

/**
 * This function reads the JSON output of a tool of RabbitMQ (`--formatter json`). The tools print a
 * value over one line or over more than one, thus it reads from the first bracket to the end.
 */
export const toolJsonOf = (text: string): unknown => {
  const at = text.search(/[[{]/);
  if (at === -1) throw new Error(`no JSON in the output: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(at));
};

/** This function gives the name of a node in the Erlang distribution: `rabbit@<name>`. */
export const nodeNameOf = (member: string): string => `rabbit@${member}`;

/**
 * This function gives the file of rabbitmq.conf of each node. The nodes form the cluster from the list
 * of their names, and the user guest connects from each address. The lines of the cluster come last.
 */
export const clusterConf = (cluster: Cluster): string =>
  [
    "cluster_formation.peer_discovery_backend = classic_config",
    ...cluster.members.map((name, at) => `cluster_formation.classic_config.nodes.${at + 1} = ${nodeNameOf(name)}`),
    "loopback_users.guest = false",
    ...cluster.conf,
    "",
  ].join("\n");

/**
 * This function gives the command of each node. It writes the cookie of the server and of the tools.
 * Then it starts the server as the child of a shell. A fin can then stop the server, and the container
 * stays up.
 */
export const nodeCommand = (cluster: Cluster): string =>
  [
    "for f in /var/lib/rabbitmq/.erlang.cookie /root/.erlang.cookie; do cp /tmp/cookie $f; chmod 400 $f; done",
    "chown rabbitmq:rabbitmq /var/lib/rabbitmq/.erlang.cookie",
    // a command in the background ends with its &, and the shell takes no ; after it
    `${cluster.programs.start} & while :; do sleep 3600; done`,
  ].join("; ");

/** A status row is one member of the queue in the output of `rabbitmq-queues quorum_status`. */
export interface StatusRow {
  readonly "Node Name": string;
  readonly "Raft State": string;
  readonly Term: number | string;
  readonly "Commit Index": number | string;
}

/**
 * This function judges the status of the queue: its leader, and if the queue is healthy. A healthy
 * queue has one leader and a follower on each other node. Each follower is in the term of the leader,
 * at the commit index of the leader.
 */
export const clusterViewOf = (cluster: Cluster, rows: readonly StatusRow[]): GroupView => {
  const byNode = new Map(cluster.members.map((name) => [nodeNameOf(name), name]));
  const leaders = rows.filter((row) => row["Raft State"] === "leader");
  if (leaders.length !== 1) return { primary: null, healthy: false, why: `the queue has ${leaders.length} leaders` };
  const leader = leaders[0]!;
  const primary = byNode.get(leader["Node Name"]) ?? null;
  if (primary === null) return { primary: null, healthy: false, why: `no node has the name ${leader["Node Name"]}` };
  if (rows.length !== cluster.members.length) return { primary, healthy: false, why: `the queue has ${rows.length} members` };
  for (const row of rows) {
    if (row !== leader && row["Raft State"] !== "follower") return { primary, healthy: false, why: `${row["Node Name"]} is ${row["Raft State"]}` };
    if (row.Term !== leader.Term) return { primary, healthy: false, why: `${row["Node Name"]} is in term ${row.Term}` };
    if (row["Commit Index"] !== leader["Commit Index"]) return { primary, healthy: false, why: `${row["Node Name"]} is behind the leader` };
  }
  return { primary, healthy: true, why: "healthy" };
};

/**
 * This function gives the peers that a fault on a node cuts it from. `all` is each other node and the
 * client, `group` is the other nodes, and `clients` is the client. `one` is the first other node in
 * the sequence of the cluster, and `one-way` is the same node for the segments from the part only.
 */
export const clusterCutOf = (
  cluster: Cluster,
  members: Readonly<Record<string, RunPart>>,
  client: string,
  part: string,
  cuts: NonNullable<GroupPlace["cuts"]>,
): Cut => {
  const others = cluster.members.filter((name) => name !== part).map((name) => members[name]!.ip);
  if (cuts === "clients") return { peers: [client] };
  if (cuts === "group") return { peers: others };
  if (cuts === "one") return { peers: others.slice(0, 1) };
  if (cuts === "one-way") return { peers: others.slice(0, 1), direction: "out" };
  return { peers: [...others, client] };
};

/** A wall stamp is the wall clock in ns around a command of a node: the run puts it on the monotonic clock. */
export interface WallStamp {
  readonly wall0: number;
  readonly wall1: number;
}

/** A cluster lab is one environment of a cluster cell. */
export interface ClusterLab {
  readonly cluster: Cluster;
  readonly clientIp: string;
  readonly members: Readonly<Record<string, RunPart>>;
  readonly netns: { readonly client: number };
  /** These are all the records that the prober wrote, in sequence. */
  readonly kernel: readonly KernelRecord[];
  /** These are the log lines of the nodes that a run keeps, in the sequence of their arrival, with `t` at 0. */
  readonly log: readonly NodeLine[];
  /** These are the last raw lines of the console of each node, for the diagnosis of a lab: at most RAW_TAIL of each. */
  readonly raw: Readonly<Record<string, readonly string[]>>;
  /** This method sets the sysctls of the client namespace through its privileged sidecar, and reads them back. */
  sysctl(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /** This method waits until the queue is whole and calm, and gives the name of the node of its leader. */
  converge(within?: number): Promise<string>;
  /** This method removes each message from the queue. */
  flush(leader: string): Promise<void>;
  /** This method gives the sequence numbers that the queue holds, through the node of its leader. The queue is empty after it. */
  holds(leader: string): Promise<number[]>;
  /** This method gives the node that has a role, when `leader` is the node of the leader. The role is the leader, or a follower. */
  partOf(role: GroupRole, leader: string): string;
  /** This method starts the client of a run, with the arguments of `client-cluster.mjs`. */
  client(args: readonly string[]): Promise<GroupClient>;
  /** This method applies a network fault between a node and some of its peers, at once or at an instant of the VM. */
  fault(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method removes a network fault, at once or at an instant of the VM. */
  lift(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method sends a signal to the server process of a node, at once or at an instant of the VM. */
  signal(part: string, signal: "KILL" | "STOP" | "CONT", at?: number): Promise<Stamp>;
  /** This method starts the server of a node again, after a fin. */
  restart(member: string): Promise<void>;
  /** This method moves the leadership of the queue from the node of `leader` to the node `to`: `rabbitmq-queues transfer_leadership`. */
  stepDown(leader: string, to: string): Promise<WallStamp>;
  /** This method puts a node in maintenance mode (`rabbitmq-upgrade drain`). */
  drain(member: string): Promise<WallStamp>;
  /** This method ends the maintenance mode of a node (`rabbitmq-upgrade revive`). */
  revive(member: string): Promise<void>;
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
 * This function opens one environment of a cluster cell:
 * - one new network, with each node, the client and the admin on it.
 * - each node: the stock image, its server as the child of a shell, with its hostname as the name of
 *   the node. A log consumer reads its console. The nodes form the cluster from the list of their
 *   names, and the lab waits until each node runs in it.
 * - the admin declares the quorum queue on the first node, thus its member there is the first leader.
 * - an injector sidecar for each node, in its network and process namespaces.
 * - a client that holds its own network namespace, with a privileged sidecar for its sysctls.
 * - the prober, which watches the namespace of the client.
 */
export const openClusterLab = async (cluster: Cluster): Promise<ClusterLab> => {
  const image = await harnessImage();
  const amqp = await amqpClientImage();
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
    const boxes = new Map<string, StartedTestContainer>();
    const injectors = new Map<string, StartedTestContainer>();
    const members: Record<string, RunPart> = {};
    const log: NodeLine[] = [];
    const raw: Record<string, string[]> = {};
    for (const name of cluster.members) {
      let partial = "";
      const box = await new GenericContainer(cluster.image)
        .withNetwork(network)
        .withNetworkAliases(name)
        .withHostname(name)
        .withCopyContentToContainer([
          { content: clusterConf(cluster), target: "/etc/rabbitmq/conf.d/90-harness.conf" },
          { content: cluster.cookie, target: "/tmp/cookie" },
        ])
        .withCommand(["sh", "-c", nodeCommand(cluster)])
        .withWaitStrategy(Wait.forLogMessage(cluster.ready))
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
              const line = nodeLineOf(name, text.trim(), cluster.queue);
              if (line !== null) log.push(line);
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
      members[name] = { ip: await ipOf(box), netns: await netnsOf(injector) };
    }

    const holder = await new GenericContainer(image).withNetwork(network).start();
    opened.push(holder);
    const admin = await new GenericContainer(image).withNetworkMode(`container:${holder.getId()}`).withPrivilegedMode().start();
    opened.push(admin);
    const clientIp = await ipOf(holder);
    // the admin of the queue is a client of its own, on the network but not in the watched namespace
    const commander = await new GenericContainer(amqp)
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
      if (found === undefined) throw new Error(`the cluster has no node ${name}`);
      return found;
    };
    const injectorOf = (name: string): StartedTestContainer => {
      const found = injectors.get(name);
      if (found === undefined) throw new Error(`the cluster has no node ${name}`);
      return found;
    };
    const lastLine = (text: string): string => text.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
    const stamped = async (where: StartedTestContainer, argv: string[]): Promise<Stamp> => {
      const stamp = JSON.parse(lastLine(await output(where, argv))) as Stamp;
      return { t0: stamp.t0, t1: stamp.t1 };
    };
    const after = (at: number | undefined): string[] => (at === undefined ? [] : ["--at", String(Math.round(at))]);
    /** This function runs a command of the tools of RabbitMQ on a node, between two stamps of its wall clock. */
    const walled = async (name: string, command: string): Promise<WallStamp> => {
      const text = await output(box(name), ["sh", "-c", `date +%s%N; ${command} >&2; date +%s%N`]);
      const stamps = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\d{18,}$/.test(line))
        .map(Number);
      if (stamps.length < 2) throw new Error(`${name}: no stamps around ${command}: ${text.slice(0, 300)}`);
      return { wall0: stamps[0]!, wall1: stamps.at(-1)! };
    };
    const status = async (name: string): Promise<GroupView> => {
      const text = await output(box(name), ["rabbitmq-queues", "-q", "quorum_status", cluster.queue, "--formatter", "json"]);
      return clusterViewOf(cluster, toolJsonOf(text) as StatusRow[]);
    };
    let known: string = cluster.members[0]!;
    /** This function gives the view of the queue: from the node that had the leader last, then from each other node. */
    const view = async (): Promise<GroupView> => {
      let last: GroupView = { primary: null, healthy: false, why: "no node answered" };
      for (const name of [known, ...cluster.members.filter((each) => each !== known)]) {
        const read = await status(name).catch((error: unknown) => ({ primary: null, healthy: false, why: `${name}: ${(error as Error).message.slice(0, 200)}` }));
        if (read.primary !== null) return read;
        last = read;
      }
      return last;
    };
    const converge = async (within = CONVERGE_MS): Promise<string> => {
      const started = Date.now();
      let calm = 0;
      let last: GroupView = { primary: null, healthy: false, why: "no view yet" };
      while (Date.now() - started < within) {
        last = await view();
        // two healthy views in a row: one view can come in the middle of a change
        calm = last.healthy ? calm + 1 : 0;
        if (last.primary !== null) known = last.primary;
        if (calm >= 2 && last.primary !== null) return last.primary;
        await sleep(1_000);
      }
      throw new Error(`the queue did not converge in ${within} ms: ${last.why}`);
    };

    // each node runs in the cluster, and then the first node declares the queue
    const started = Date.now();
    for (;;) {
      const text = await output(box(cluster.members[0]!), ["rabbitmq-diagnostics", "-q", "cluster_status", "--formatter", "json"]).catch(() => "{}");
      const running = ((text.trim() === "" ? {} : toolJsonOf(text)) as { running_nodes?: string[] }).running_nodes ?? [];
      if (cluster.members.every((name) => running.includes(nodeNameOf(name)))) break;
      if (Date.now() - started > 120_000) throw new Error(`the cluster did not form in 120 s: ${running.join(", ")} run`);
      await sleep(1_000);
    }
    const declared = lastLine(await output(commander, ["node", "/opt/harness/amqp/admin-cluster.mjs", `${members[cluster.members[0]!]!.ip}:${cluster.port}`, "declare", cluster.queue]));
    if (!declared.includes('"ok":true')) throw new Error(`the declare of the queue failed: ${declared}`);
    await converge();

    return {
      cluster,
      clientIp,
      members,
      netns: { client: clientNetns },
      kernel: records.seen,
      log,
      raw,
      async sysctl(values) {
        const settings = Object.entries(values).map(([key, value]) => `${key}=${value}`);
        if (settings.length > 0) await output(admin, ["sysctl", "-q", "-w", ...settings]);
        const read: Record<string, string> = {};
        for (const key of Object.keys(values)) read[key] = await output(admin, ["sysctl", "-n", key]);
        return read;
      },
      converge,
      async flush(leader) {
        await output(box(leader), ["rabbitmqctl", "-q", "purge_queue", cluster.queue]);
      },
      async holds(leader) {
        const reply = lastLine(await output(commander, ["node", "/opt/harness/amqp/admin-cluster.mjs", `${members[leader]!.ip}:${cluster.port}`, "holds", cluster.queue]));
        const held = (JSON.parse(reply) as { held?: unknown[] }).held;
        if (held === undefined) throw new Error(`the read of the queue failed: ${reply}`);
        return held.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      },
      partOf(role, leader) {
        if (role === "primary") return leader;
        if (role === "sentinel") throw new Error("a cluster has no Sentinel");
        const follower = cluster.members.find((name) => name !== leader);
        if (follower === undefined) throw new Error("the cluster has no follower");
        return follower;
      },
      async client(args) {
        const events = lines<ProbeEvent>();
        const container = await new GenericContainer(amqp)
          .withNetworkMode(`container:${holder.getId()}`)
          .withCommand(["node", "/opt/harness/amqp/client-cluster.mjs", ...args])
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
        const cut = clusterCutOf(cluster, members, clientIp, part, cuts);
        const direction = cut.direction === undefined ? [] : ["--direction", cut.direction];
        return stamped(injectorOf(part), ["/opt/harness/inject", kind, cut.peers.join(","), ...direction, ...after(at)]);
      },
      lift(kind, part, cuts, at) {
        const cut = clusterCutOf(cluster, members, clientIp, part, cuts);
        const direction = cut.direction === undefined ? [] : ["--direction", cut.direction];
        return stamped(injectorOf(part), ["/opt/harness/inject", kind === "rst" ? "clear-rst" : "clear", cut.peers.join(","), ...direction, ...after(at)]);
      },
      signal(part, signal, at) {
        return stamped(injectorOf(part), ["/opt/harness/inject", "signal", cluster.programs.server, signal, ...after(at)]);
      },
      async restart(member) {
        // the restarted server writes to the output of the container, thus its log consumer reads it
        await output(box(member), ["sh", "-c", `${cluster.programs.start} > /proc/1/fd/1 2>&1 &`]);
        const begun = Date.now();
        while (!(await output(box(member), ["rabbitmq-diagnostics", "-q", "check_running"]).then(() => true).catch(() => false))) {
          if (Date.now() - begun > 120_000) throw new Error(`${member} did not start again`);
          await sleep(1_000);
        }
      },
      stepDown(leader, to) {
        return walled(leader, `rabbitmq-queues -q transfer_leadership ${cluster.queue} ${nodeNameOf(to)}`);
      },
      drain(member) {
        return walled(member, "rabbitmq-upgrade -q drain");
      },
      async revive(member) {
        await output(box(member), ["rabbitmq-upgrade", "-q", "revive"]);
      },
      async forget() {
        await output(admin, ["ip", "tcp_metrics", "flush", "all"]);
      },
      async settle() {
        const from = records.seen.length;
        const clock = await new Promise<KernelRecord | null>((resolve) => {
          const begun = Date.now();
          const look = () => {
            const line = records.seen.slice(from).find((record) => record.ev === "clock");
            if (line !== undefined) resolve(line);
            else if (Date.now() - begun > 5_000) resolve(null);
            else setTimeout(look, 50);
          };
          look();
        });
        return clock === null ? null : Number(clock["lost"] ?? 0);
      },
      async manifest(sysctls) {
        const config = await output(admin, ["zcat", "/proc/config.gz"]).catch(() => "");
        const inspect = async (container: StartedTestContainer) => runtime.container.inspect(runtime.container.getById(container.getId()));
        const list = [];
        for (const name of cluster.members) {
          const version = lastLine(await output(box(name), ["rabbitmqctl", "-q", "version"]).catch(() => ""));
          list.push({ name, ip: members[name]!.ip, id: (await inspect(box(name))).Image, settings: { version, conf: cluster.conf.join("; ") } });
        }
        return {
          kernel: await output(holder, ["uname", "-r"]),
          architecture: await output(holder, ["uname", "-m"]),
          hz: /^CONFIG_HZ=(\d+)$/m.exec(config)?.[1] ?? null,
          boot_id: await output(holder, ["cat", "/proc/sys/kernel/random/boot_id"]),
          docker: `${runtime.info.containerRuntime.serverVersion} on ${runtime.info.containerRuntime.operatingSystem}`,
          target: { image: cluster.image, id: list[0]!.id, settings: list[0]!.settings, sysctls: {} },
          harness: {
            image,
            id: (await inspect(holder)).Image,
            packages: (await output(holder, ["apk", "info", "-v"])).split("\n").sort(),
          },
          client: { kind: "amqp", image: amqp },
          netns: { client: clientNetns, target: members[cluster.members[0]!]!.netns },
          sysctls,
          group: { members: list, sentinels: [], observer: { image: amqp } },
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
// the runs of a cluster cell
// ---------------------------------------------------------------------------------------------

/** This count is the number of confirmed publishes that a run waits for before its fault: the stream is steady then. */
const STEADY = 20;
/** This time is how long a run continues after its outcome, so that the record shows what came next. */
const TAIL_MS = 2_000;

/**
 * This function gives the hosts of the client, in the sequence of its connects: its node first, then
 * each other node. The node of a follower is the last follower in the sequence of the cluster. A fault
 * on one member (`one`, `one-way`) cuts the first follower, thus not the node of the client.
 */
export const clusterHostsOf = (cell: Cell, members: Readonly<Record<string, RunPart>>, leader: string): string[] => {
  const cluster = cell.cluster!;
  const first = cell.clientAt === "leader" ? leader : cluster.members.filter((name) => name !== leader).at(-1)!;
  return [first, ...cluster.members.filter((name) => name !== first)].map((name) => `${members[name]!.ip}:${cluster.port}`);
};

/** This form is the NOTICE of a leader of the queue that starts to give its leadership away: to await_condition, for a transfer. */
export const GIVES_AWAY: RegExp = /: leader -> await_condition in term/;
/** This form is the INFO of a follower whose monitor of the leader goes down (ra_server_proc.erl:871). A drain stops the leader so. */
export const MONITOR_DOWN: RegExp = /Leader monitor down/;

/** This function gives the arguments of the client of a cluster cell: its hosts, the queue, and the stream of publishes. */
export const clusterArgs = (cell: Cell, members: Readonly<Record<string, RunPart>>, leader: string): string[] => [
  clusterHostsOf(cell, members, leader).join(","),
  "--queue",
  cell.cluster!.queue,
  "--interval-ms",
  String(cell.probe.interval === undefined ? 50 : valueIn(cell.probe.interval, "ms")),
  "--max-s",
  String(Math.ceil(deadlineOf(cell) / 1_000 + (cell.hold === undefined ? 0 : valueIn(cell.hold, "s")) + 120)),
  ...(cell.driverOptions === undefined ? [] : ["--options", JSON.stringify(cell.driverOptions)]),
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

/** This function puts a wall stamp on the monotonic clock, with the clock lines of the client. Without one it gives null. */
export const monotonicOf = (stamp: WallStamp, events: readonly ProbeEvent[]): Stamp | null => {
  const offset = clockOffsetOf(events);
  return offset === null ? null : { t0: Math.round(stamp.wall0 - offset), t1: Math.round(stamp.wall1 - offset) };
};

/**
 * This function gives the instant of a change of the leader that a command of the tools starts, as the
 * stamps of a fault. The command starts an Erlang VM first, thus its stamps hold more than the change.
 * A line of the log marks the start of the change. For a step-down it is the NOTICE of the old leader
 * (ra_server_proc.erl:1336-1345), and for a drain the INFO of a follower. Its time on the monotonic
 * clock is the stamp. Without that line, the stamps of the command are the stamps.
 */
const stampOf = async (lab: ClusterLab, client: GroupClient, logFrom: number, marks: (line: NodeLine) => boolean, wall: WallStamp): Promise<Stamp | null> => {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const lines = nodesOnMonotonic(lab.log.slice(logFrom), clockOffsetOf(client.events));
    const line = lines.find(marks);
    if (line !== undefined && line.t > 0) return { t0: line.t, t1: line.t };
    await sleep(100);
  }
  return monotonicOf(wall, client.events);
};

/**
 * This function does one run of a cluster cell:
 * - The queue converges, and it is empty. The client connects through its node, and its stream of
 *   publishes gets steady.
 * - The fault occurs on its node, as the leader of this run makes the roles. A fault with a hold
 *   lifts at its instant in the VM. A step-down moves the leadership to a follower, and a drain puts
 *   the node in maintenance mode. The stamp of each of them is a line of the log (`stampOf`).
 * - The run waits for its outcome: the first confirm of a publish sent after the commit of the fault.
 *   Then it waits for the end of the hold, thus the record shows what the cluster did in the whole hold.
 * - Each fault goes, the client stops, and the queue converges again. The sequence numbers that it
 *   then holds tell which publishes it kept. The log lines of the nodes go onto the monotonic clock.
 */
export const clusterOnce = async (lab: ClusterLab, cell: Cell, environment: number, index: number): Promise<Run> => {
  const leader = await lab.converge();
  await lab.flush(leader);
  await lab.forget();
  const from = lab.kernel.length;
  const logFrom = lab.log.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const client = await lab.client(clusterArgs(cell, lab.members, leader));
  const place = (cell.faultAt ?? { role: "primary" }) as GroupPlace;
  let fault: Run["fault"] = null;
  let heal: Run["heal"] = null;
  let at: string | null = null;
  let wall: WallStamp | null = null;
  const undo: Array<() => Promise<unknown>> = [];
  try {
    await client.until(["ready"], 60_000);
    const steady = await waitFor(client, (event) => event.ev === "ack" && Number(event["n"]) >= STEADY, 30_000);
    if (steady === undefined) throw new Error(`the client did not publish ${STEADY} times in 30 s`);
    let healing: Promise<Run["heal"]> | null = null;
    switch (cell.fault) {
      case "blackhole":
      case "partition":
      case "rst": {
        const kind = cell.fault === "rst" ? "rst" : "blackhole";
        const cuts = place.cuts ?? (cell.fault === "partition" ? "group" : "all");
        const part = lab.partOf(place.role, leader);
        at = part;
        fault = await lab.fault(kind, part, cuts);
        undo.push(() => lab.lift(kind, part, cuts));
        if (cell.hold !== undefined) healing = lab.lift(kind, part, cuts, fault.t0 + valueIn(cell.hold, "s") * 1e9);
        break;
      }
      case "freeze-process": {
        const part = lab.partOf(place.role, leader);
        at = part;
        fault = await lab.signal(part, "STOP");
        undo.push(() => lab.signal(part, "CONT"));
        if (cell.hold !== undefined) healing = lab.signal(part, "CONT", fault.t0 + valueIn(cell.hold, "s") * 1e9);
        break;
      }
      case "fin": {
        const part = lab.partOf(place.role, leader);
        at = part;
        fault = await lab.signal(part, "KILL");
        undo.push(() => lab.restart(part));
        break;
      }
      case "step-down": {
        at = leader;
        wall = await lab.stepDown(leader, lab.partOf("replica", leader));
        fault = await stampOf(lab, client, logFrom, (line) => line.member === leader && GIVES_AWAY.test(line.msg), wall);
        break;
      }
      case "drain": {
        const part = lab.partOf(place.role, leader);
        at = part;
        wall = await lab.drain(part);
        undo.push(() => lab.revive(part));
        // a drain stops the member of the leader (rabbit_quorum_queue.erl:2787-2838): a follower sees its monitor go down
        fault = await stampOf(lab, client, logFrom, (line) => line.member !== part && MONITOR_DOWN.test(line.msg), wall);
        break;
      }
      default:
        throw new Error(`a cluster cell has no fault ${cell.fault}`);
    }
    if (fault === null) throw new Error("the client wrote no clock line: the stamps of the command have no place on the monotonic clock");
    // the injector holds the lift in the VM: its exec returns at the instant, and the stamps come with it
    const healed =
      healing === null
        ? Promise.resolve(null)
        : healing.then((stamp) => {
            heal = stamp;
            // the lift came: nothing is left to undo
            undo.length = 0;
            return stamp;
          });
    // a run that stops early lifts the fault itself, and the late lift then has nothing to remove
    healed.catch(() => undefined);
    const t1 = fault.t1;
    const sentAt = (n: number): number => client.events.find((event) => event.ev === "sent" && Number(event["n"]) === n)?.t ?? -Infinity;
    const outcome = await waitFor(client, (event) => event.ev === "ack" && sentAt(Number(event["n"])) > t1, deadlineOf(cell));
    if (outcome !== undefined) await sleep(TAIL_MS);
    // the whole hold: a prediction that reads the cluster in each moment of it
    if (healing !== null) {
      await healed.catch(() => undefined);
      await sleep(TAIL_MS);
    }
  } finally {
    // each fault that is still on goes, and a killed server starts again
    for (const step of undo.reverse()) await step().catch(() => undefined);
    await client.stop();
  }
  const settled = await lab.settle();
  const lost = settled === null ? null : settled - lostBefore;
  const after = await lab.converge().catch(() => null);
  const holds = after === null ? null : await lab.holds(after);
  return {
    environment,
    index,
    events: [...client.events],
    fault,
    ...(heal === null ? {} : { heal }),
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.members[at ?? leader]!.netns,
    lost,
    group: {
      members: lab.members,
      sentinels: {},
      primary: leader,
      at,
      timeline: nodesOnMonotonic(lab.log.slice(logFrom), clockOffsetOf(client.events)),
      after,
      holds,
    },
  };
};
