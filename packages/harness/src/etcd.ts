import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { valueIn } from "@mark1russell7/quantity";
import type { Cell, ClientImage, EtcdCluster, GroupPlace, GroupRole, HistoryVerdict, ProbeEvent, Run, RunPart, SentinelEvent } from "./cell.ts";
import { clusterCutOf } from "./cluster.ts";
import type { GroupClient, GroupNetworkFault, GroupView, Stamp } from "./group.ts";
import { CONVERGE_MS } from "./group.ts";
import { harnessImage, imageOf } from "./image.ts";
import type { Manifest } from "./lab.ts";
import { STOP, buildOf, clientOf, containers, harnessRecord, lines, netnsOf, output, withPid } from "./lab.ts";
import { historyOf, historyText, verdictOfText } from "./history.ts";
import { clockOffsetOf } from "./replset.ts";
import { substrateHere } from "./substrate.ts";

/**
 * This module is the lab of a cluster of etcd (SYS-75). The members elect their leader by Raft. It
 * opens one environment for an etcd cell, for the runs of the cell. Each member is a container of
 * the image of the cell, in its own network namespace. Its injector sidecar is in its network and
 * process namespaces. Thus a partition cuts one member from the others, and its clients stay
 * connected to it.
 *
 * The client of each run is the image of `etcd-kv` (`Cell.client`). Each worker of it talks to one
 * member. Its lines give the history of the run, and the checker of linearizability in the commander
 * judges it. The commander is the same image: it holds `etcdctl` and the checker. A run has no
 * prober: the history is the measure, and no socket is.
 */

/**
 * An etcd line is one log line of a member, as etcd writes it in JSON with zap. `real` is its time
 * on the wall clock in ms, with its microseconds. `t` is its time on the monotonic clock: the run
 * gives it from the clock lines of its client.
 */
export interface EtcdLine extends SentinelEvent {
  readonly ev: "etcd";
  readonly member: string;
  readonly real: number;
  readonly level: string;
  readonly msg: string;
}

/** This form is the time of a line of zap in etcd. It is ISO 8601, with up to nine digits of the second, and Z or an offset. */
const TIME = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3})(\d*))?(Z|[+-]\d\d:?\d\d)$/;

/** This function gives the time of a zap line on the wall clock in ms, or null. A number is seconds since the epoch. */
export const realOf = (ts: unknown): number | null => {
  if (typeof ts === "number") return Number.isFinite(ts) ? ts * 1_000 : null;
  if (typeof ts !== "string") return null;
  const found = TIME.exec(ts);
  if (found === null) return null;
  const [, second, ms = "", rest = "", zone] = found as unknown as [string, string, string | undefined, string | undefined, string];
  const offset = zone === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const whole = Date.parse(`${second}.${ms.padEnd(3, "0")}${offset}`);
  if (!Number.isFinite(whole)) return null;
  return whole + (rest === "" ? 0 : Number(`0.${rest}`));
};

/** This form is a message of Raft that a run keeps: a change of the leader, a vote or an election. */
const RAFT = /leader|elect|candidate|vote|term/i;

/**
 * This function reads one log line of a member, or gives null for a line that a run does not keep.
 * A run keeps each line of Raft on the leader, the votes and the elections, each warning and each
 * error.
 */
export const etcdLineOf = (member: string, text: string): EtcdLine | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const { level, msg, ts } = parsed as { level?: unknown; msg?: unknown; ts?: unknown };
  if (typeof level !== "string" || typeof msg !== "string") return null;
  const kept = RAFT.test(msg) || level === "warn" || level === "error";
  if (!kept) return null;
  const real = realOf(ts);
  return real === null ? null : { ev: "etcd", t: 0, member, real, level, msg };
};

/** This function puts the log lines of the members on the monotonic clock, with the offset of a client. */
export const etcdOnMonotonic = (log: readonly EtcdLine[], offset: number | null): EtcdLine[] =>
  log.map((line) => ({ ...line, t: offset === null ? 0 : Math.round(line.real * 1e6 - offset) }));

/** This function gives the URL of a member on a port: its name on the network, or its address. */
const urlOf = (host: string, port: number): string => `http://${host}:${port}`;

/**
 * This function gives the command of a member. The members form the cluster from the list of their
 * names. The server runs as the child of a shell, thus a signal stops the server and the container
 * stays up.
 */
export const etcdCommand = (etcd: EtcdCluster, member: string): string =>
  [
    "etcd",
    `--name ${member}`,
    "--data-dir /var/lib/etcd",
    `--listen-client-urls ${urlOf("0.0.0.0", etcd.port)}`,
    `--advertise-client-urls ${urlOf(member, etcd.port)}`,
    `--listen-peer-urls ${urlOf("0.0.0.0", etcd.peerPort)}`,
    `--initial-advertise-peer-urls ${urlOf(member, etcd.peerPort)}`,
    `--initial-cluster ${etcd.members.map((name) => `${name}=${urlOf(name, etcd.peerPort)}`).join(",")}`,
    "--initial-cluster-token cells",
    "--initial-cluster-state new",
    ...(etcd.args ?? []),
    // a command in the background ends with its &, and the shell takes no ; after it
    "& while :; do sleep 3600; done",
  ].join(" ");

/**
 * This function quotes each integer of 16 digits or more in a JSON text. The IDs of the members of
 * etcd are 64 bits, and a JavaScript number keeps 53 bits. Thus the IDs stay exact as texts.
 */
export const quoteLongIntegers = (text: string): string => text.replace(/([:[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"');

/** A status row is one endpoint in the output of `etcdctl endpoint status -w json`, with its IDs as texts. */
export interface StatusRow {
  readonly Endpoint: string;
  readonly Status: {
    readonly header: { readonly member_id: string | number };
    readonly leader: string | number;
    readonly raftTerm: number | string;
    readonly raftAppliedIndex: number | string;
  };
}

/**
 * This function judges the status of the cluster: its leader, and if the cluster is healthy. A
 * healthy cluster has a status from each member. Each member names the same leader, which is one of
 * them, in the same term and at the same applied index.
 */
export const etcdViewOf = (endpoints: Readonly<Record<string, string>>, rows: readonly StatusRow[]): GroupView => {
  const names = Object.keys(endpoints);
  const byEndpoint = new Map(Object.entries(endpoints).map(([name, endpoint]) => [endpoint, name]));
  const byId = new Map<string, string>();
  for (const row of rows) {
    const name = byEndpoint.get(row.Endpoint);
    if (name !== undefined) byId.set(String(row.Status.header.member_id), name);
  }
  const leaders = new Set(rows.map((row) => String(row.Status.leader)));
  if (leaders.size !== 1) return { primary: null, healthy: false, why: `the members name ${leaders.size} leaders` };
  const [id] = [...leaders];
  const primary = byId.get(id!) ?? null;
  if (primary === null) return { primary: null, healthy: false, why: `no member that answered has the ID ${id}` };
  if (rows.length !== names.length) return { primary, healthy: false, why: `${rows.length} of ${names.length} members answered` };
  const first = rows[0]!.Status;
  for (const row of rows) {
    const name = byEndpoint.get(row.Endpoint) ?? row.Endpoint;
    if (String(row.Status.raftTerm) !== String(first.raftTerm)) return { primary, healthy: false, why: `${name} is in term ${row.Status.raftTerm}` };
    if (String(row.Status.raftAppliedIndex) !== String(first.raftAppliedIndex)) return { primary, healthy: false, why: `${name} is at another applied index` };
  }
  return { primary, healthy: true, why: "healthy" };
};

/** An etcd lab is one environment of an etcd cell. */
export interface EtcdLab {
  readonly etcd: EtcdCluster;
  readonly clientIp: string;
  readonly members: Readonly<Record<string, RunPart>>;
  readonly netns: { readonly client: number };
  /** These are the log lines of the members that a run keeps, in the sequence of their arrival, with `t` at 0. */
  readonly log: readonly EtcdLine[];
  /** These are the last raw lines of each member, for the diagnosis of a lab: at most RAW_TAIL of each. */
  readonly raw: Readonly<Record<string, readonly string[]>>;
  /** This method sets the sysctls of the client namespace through its privileged sidecar, and reads them back. */
  sysctl(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /** This method waits until the cluster is whole and calm, and gives the name of its leader. */
  converge(within?: number): Promise<string>;
  /** This method gives the member that has a role, when `leader` is the leader. The role is the leader, or a follower. */
  partOf(role: GroupRole, leader: string): string;
  /** This method starts the client of a run, with its arguments after the endpoints. */
  client(args: readonly string[]): Promise<GroupClient>;
  /** This method applies a network fault between a member and some of its peers, at once or at an instant of the VM. */
  fault(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method removes a network fault, at once or at an instant of the VM. */
  lift(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method sends a signal to the server process of a member, at once or at an instant of the VM. */
  signal(part: string, signal: "STOP" | "CONT", at?: number): Promise<Stamp>;
  /** This method gives a history to the checker of linearizability, and gives its verdict, or null with no verdict. */
  check(history: string): Promise<HistoryVerdict | null>;
  manifest(sysctls: Readonly<Record<string, string>>): Promise<Manifest>;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** This count is the number of raw lines of each member that a lab keeps. */
export const RAW_TAIL = 400;

/** This time is the longest check of one key by the checker of linearizability. */
export const CHECK_TIMEOUT = "60s";

/**
 * This function opens one environment of an etcd cell:
 * - one new network, with each member, the client and the commander on it.
 * - each member: the image of the cell, its server as the child of a shell, with its hostname as
 *   its name. A log consumer reads its lines. The lab waits until the cluster is whole and calm.
 * - an injector sidecar for each member, in its network and process namespaces.
 * - a client that holds its own network namespace, with a privileged sidecar for its sysctls.
 * - the commander, from the image of the client: `etcdctl` reads the status of the members, and the
 *   checker judges each history.
 */
export const openEtcdLab = async (etcd: EtcdCluster, kind: ClientImage): Promise<EtcdLab> => {
  const image = await harnessImage();
  const memberImage = await imageOf(etcd.image);
  const { clientImage, command, source } = await clientOf(kind);
  const { GenericContainer, Network, getContainerRuntimeClient } = await containers();
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
    const log: EtcdLine[] = [];
    const raw: Record<string, string[]> = {};
    // a member alone is not ready: each one starts with no wait, and the cluster converges after the last
    for (const name of etcd.members) {
      let partial = "";
      const box = await new GenericContainer(memberImage)
        .withNetwork(network)
        .withNetworkAliases(name)
        .withHostname(name)
        .withCommand(["sh", "-c", etcdCommand(etcd, name)])
        .withLogConsumer((stream) =>
          stream.on("data", (chunk: Buffer | string) => {
            partial += chunk.toString();
            const split = partial.split("\n");
            partial = split.pop() ?? "";
            for (const text of split) {
              const tail = (raw[name] ??= []);
              tail.push(text);
              if (tail.length > RAW_TAIL) tail.shift();
              const line = etcdLineOf(name, text.trim());
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
    const clientNetns = await netnsOf(admin);
    // the commander reads the cluster from its own namespace, thus its reads are not in the history
    const commander = await new GenericContainer(clientImage)
      .withNetwork(network)
      .withCommand(["sh", "-c", "while :; do sleep 3600; done"])
      .start();
    opened.push(commander);

    const box = (name: string): StartedTestContainer => {
      const found = boxes.get(name);
      if (found === undefined) throw new Error(`the cluster has no member ${name}`);
      return found;
    };
    const injectorOf = (name: string): StartedTestContainer => {
      const found = injectors.get(name);
      if (found === undefined) throw new Error(`the cluster has no member ${name}`);
      return found;
    };
    const lastLine = (text: string): string => text.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
    const stamped = async (where: StartedTestContainer, argv: string[]): Promise<Stamp> => {
      const stamp = JSON.parse(lastLine(await output(where, argv))) as Stamp;
      return { t0: stamp.t0, t1: stamp.t1 };
    };
    const after = (at: number | undefined): string[] => (at === undefined ? [] : ["--at", String(Math.round(at))]);
    const endpoints: Record<string, string> = Object.fromEntries(etcd.members.map((name) => [name, urlOf(members[name]!.ip, etcd.port)]));

    /**
     * This function gives the view of the cluster. etcdctl prints the status of each member that
     * answered. It exits with an error when one did not, thus the lab reads its output after each exit.
     */
    const view = async (): Promise<GroupView> => {
      const argv = ["etcdctl", `--endpoints=${Object.values(endpoints).join(",")}`, "--command-timeout=2s", "endpoint", "status", "-w", "json"];
      const result = await commander.exec(argv);
      const text = result.stdout.trim();
      const at = text.indexOf("[");
      if (at === -1) return { primary: null, healthy: false, why: `no status: ${result.output.trim().slice(0, 200)}` };
      try {
        return etcdViewOf(endpoints, JSON.parse(quoteLongIntegers(text.slice(at))) as StatusRow[]);
      } catch (error) {
        return { primary: null, healthy: false, why: `the status is not JSON: ${(error as Error).message.slice(0, 200)}` };
      }
    };
    const converge = async (within = CONVERGE_MS): Promise<string> => {
      const started = Date.now();
      let calm = 0;
      let last: GroupView = { primary: null, healthy: false, why: "no view yet" };
      while (Date.now() - started < within) {
        last = await view();
        // two healthy views in a row: one view can come in the middle of a change
        calm = last.healthy ? calm + 1 : 0;
        if (calm >= 2 && last.primary !== null) return last.primary;
        await sleep(1_000);
      }
      throw new Error(`the cluster did not converge in ${within} ms: ${last.why}`);
    };
    await converge();

    return {
      etcd,
      clientIp,
      members,
      netns: { client: clientNetns },
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
      partOf(role, leader) {
        if (role === "primary") return leader;
        if (role === "sentinel") throw new Error("a cluster of etcd has no Sentinel");
        const follower = etcd.members.find((name) => name !== leader);
        if (follower === undefined) throw new Error("the cluster has no follower");
        return follower;
      },
      async client(args) {
        const events = lines<ProbeEvent>();
        const container = await new GenericContainer(clientImage)
          .withNetworkMode(`container:${holder.getId()}`)
          .withCommand([...command, Object.values(endpoints).join(","), ...args])
          .withLogConsumer(events.consume)
          .start();
        return {
          events: events.seen,
          until: (kinds, within) => events.until(kinds, within, "client"),
          // a TERM first: the client ends each operation in flight, writes its line and its done line, then stops
          stop: () =>
            container
              .stop({ timeout: 5 })
              .then(() => undefined)
              .catch(() => undefined),
        };
      },
      fault(kind, part, cuts, at) {
        const cut = clusterCutOf(etcd, members, clientIp, part, cuts);
        const direction = cut.direction === undefined ? [] : ["--direction", cut.direction];
        return stamped(injectorOf(part), ["/opt/harness/inject", kind, cut.peers.join(","), ...direction, ...after(at)]);
      },
      lift(kind, part, cuts, at) {
        const cut = clusterCutOf(etcd, members, clientIp, part, cuts);
        const direction = cut.direction === undefined ? [] : ["--direction", cut.direction];
        return stamped(injectorOf(part), ["/opt/harness/inject", kind === "rst" ? "clear-rst" : "clear", cut.peers.join(","), ...direction, ...after(at)]);
      },
      signal(part, signal, at) {
        return stamped(injectorOf(part), ["/opt/harness/inject", "signal", etcd.programs.server, signal, ...after(at)]);
      },
      async check(history) {
        const path = `/tmp/history-${Date.now()}.jsonl`;
        await commander.copyContentToContainer([{ content: history, target: path }]);
        // exit 0 is Ok, 1 is Illegal or Unknown, and 2 is a history that the checker refuses
        const result = await commander.exec(["sh", "-c", `linearizability -timeout ${CHECK_TIMEOUT} < ${path}; code=$?; rm -f ${path}; exit $code`]);
        if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`the checker exited ${result.exitCode}: ${result.output.trim().slice(0, 500)}`);
        return verdictOfText(result.stdout);
      },
      async manifest(sysctls) {
        const config = await output(admin, ["zcat", "/proc/config.gz"]).catch(() => "");
        const inspect = async (container: StartedTestContainer) => runtime.container.inspect(runtime.container.getById(container.getId()));
        const list = [];
        for (const name of etcd.members) {
          const version = (await output(box(name), ["etcd", "--version"]).catch(() => "")).split("\n")[0]?.trim() ?? "";
          list.push({ name, ip: members[name]!.ip, id: (await inspect(box(name))).Image, settings: { version, args: (etcd.args ?? []).join(" ") } });
        }
        return {
          kernel: await output(holder, ["uname", "-r"]),
          architecture: await output(holder, ["uname", "-m"]),
          hz: /^CONFIG_HZ=(\d+)$/m.exec(config)?.[1] ?? null,
          boot_id: await output(holder, ["cat", "/proc/sys/kernel/random/boot_id"]),
          substrate: substrateHere("E1"),
          docker: `${runtime.info.containerRuntime.serverVersion} on ${runtime.info.containerRuntime.operatingSystem}`,
          target: { image: memberImage, subject: etcd.image, id: list[0]!.id, settings: list[0]!.settings, sysctls: {}, ...buildOf(etcd.image) },
          harness: {
            image,
            id: (await inspect(holder)).Image,
            packages: (await output(holder, ["apk", "info", "-v"])).split("\n").sort(),
            ...harnessRecord(),
          },
          client: { kind: "image", image: clientImage, ...(source === undefined ? {} : { source, ...buildOf(source) }) },
          netns: { client: clientNetns, target: members[etcd.members[0]!]!.netns },
          sysctls,
          group: { members: list, sentinels: [], observer: { image: clientImage } },
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
// the runs of an etcd cell
// ---------------------------------------------------------------------------------------------

/** This count is the number of operations with a response that a run waits for before its fault: the workers are steady then. */
const STEADY = 20;
/** This time is how long a run continues after the lift of a fault, when its cell gives no `watch`. */
const AFTER_MS = 5_000;
/** This time is how long a run waits for the done line of its client after the TERM. */
const DONE_MS = 5_000;

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

/** This function waits until the client wrote `count` operations with a response, or for `within` ms. */
const steadyAfter = (client: GroupClient, count: number, within: number): Promise<boolean> =>
  new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const ok = client.events.filter((event) => event.ev === "op" && event["result"] === "ok").length;
      if (ok >= count) resolve(true);
      else if (Date.now() - started > within) resolve(false);
      else setTimeout(look, 20);
    };
    look();
  });

/**
 * This function gives the time in ms that a run of an etcd cell observes the cluster after the commit
 * of its fault. With a hold, it is the hold, then `watch` after the lift. Without a hold, it is the
 * window of the prediction, and the fault stays on to its end.
 */
export const observeMsOf = (cell: Cell): number => {
  if (cell.hold !== undefined) return valueIn(cell.hold, "ms") + (cell.watch === undefined ? AFTER_MS : valueIn(cell.watch, "ms"));
  return cell.prediction.detects === null ? valueIn(cell.prediction.window, "ms") : AFTER_MS;
};

/**
 * This function gives the arguments of the client of an etcd cell, after its endpoints. The keys of
 * each run have a prefix of their own, thus each history starts from keys with no value.
 */
export const etcdArgs = (cell: Cell, environment: number, index: number): string[] => {
  const kv = cell.probe.kv;
  if (kv === undefined) throw new Error(`the etcd cell ${cell.name} has no probe.kv`);
  return [
    "--prefix",
    `r${environment}-${index}-`,
    "--clients",
    String(kv.workers),
    "--keys",
    String(kv.keys),
    "--interval-ms",
    String(cell.probe.interval === undefined ? 20 : valueIn(cell.probe.interval, "ms")),
    "--max-s",
    String(Math.ceil(observeMsOf(cell) / 1_000 + 120)),
    "--reads",
    kv.reads,
    "--timeout-ms",
    String(valueIn(kv.timeout, "ms")),
    "--seed",
    String(1 + environment * 1_000 + (index + 1)),
  ];
};

/**
 * This function does one run of an etcd cell:
 * - The cluster converges. The client starts with keys of its own, and its workers get steady.
 * - The fault occurs on its member, as the leader of this run makes the roles. A fault with a hold
 *   lifts at its instant in the VM. The run observes the cluster through the hold and `watch` after
 *   it, or through the window of the prediction.
 * - Each fault goes, and the client stops: each operation in flight ends with its line.
 * - The checker judges the history of the client. The cluster converges again, and the log lines of
 *   the members go onto the monotonic clock.
 */
export const etcdOnce = async (lab: EtcdLab, cell: Cell, environment: number, index: number): Promise<Run> => {
  const leader = await lab.converge();
  const logFrom = lab.log.length;
  const client = await lab.client(etcdArgs(cell, environment, index));
  const place = (cell.faultAt ?? { role: "primary" }) as GroupPlace;
  let fault: Run["fault"] = null;
  let heal: Run["heal"] = null;
  let at: string | null = null;
  const undo: Array<() => Promise<unknown>> = [];
  try {
    await client.until(["ready"], 60_000);
    if (!(await steadyAfter(client, STEADY, 30_000))) throw new Error(`the client did not end ${STEADY} operations in 30 s`);
    let healing: Promise<Run["heal"]> | null = null;
    const part = lab.partOf(place.role, leader);
    at = part;
    switch (cell.fault) {
      case "blackhole":
      case "partition":
      case "rst": {
        const kind = cell.fault === "rst" ? "rst" : "blackhole";
        const cuts = place.cuts ?? (cell.fault === "partition" ? "group" : "all");
        fault = await lab.fault(kind, part, cuts);
        undo.push(() => lab.lift(kind, part, cuts));
        if (cell.hold !== undefined) healing = lab.lift(kind, part, cuts, fault.t0 + valueIn(cell.hold, "s") * 1e9);
        break;
      }
      case "freeze-process": {
        fault = await lab.signal(part, "STOP");
        undo.push(() => lab.signal(part, "CONT"));
        if (cell.hold !== undefined) healing = lab.signal(part, "CONT", fault.t0 + valueIn(cell.hold, "s") * 1e9);
        break;
      }
      default:
        throw new Error(`an etcd cell has no fault ${cell.fault}`);
    }
    if (healing === null) await sleep(observeMsOf(cell));
    else {
      // the injector holds the lift in the VM: its exec returns at the instant, and the stamps come with it
      heal = await healing;
      undo.length = 0;
      await sleep(observeMsOf(cell) - valueIn(cell.hold!, "ms"));
    }
  } finally {
    // each fault that is still on goes
    for (const step of undo.reverse()) await step().catch(() => undefined);
    await client.stop();
  }
  await waitFor(client, (event) => event.ev === "done", DONE_MS);
  const events = [...client.events];
  const history = await lab.check(historyText(historyOf(events)));
  const after = await lab.converge().catch(() => null);
  return {
    environment,
    index,
    events,
    fault,
    ...(heal === null || heal === undefined ? {} : { heal }),
    kernel: [],
    netns: lab.netns.client,
    targetNetns: lab.members[at ?? leader]!.netns,
    lost: null,
    history,
    group: {
      members: lab.members,
      sentinels: {},
      primary: leader,
      at,
      timeline: etcdOnMonotonic(lab.log.slice(logFrom), clockOffsetOf(events)),
      after,
      holds: null,
    },
  };
};
