import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { valueIn } from "@mark1russell7/quantity";
import type {
  Cell,
  Group,
  GroupPlace,
  GroupRole,
  KernelRecord,
  ProbeEvent,
  Run,
  RunPart,
  SentinelEvent,
} from "./cell.ts";
import type { Manifest } from "./lab.ts";
import { STOP, containers, harnessImage, lines, netnsOf, nodeClientImage, output, withPid } from "./lab.ts";

/**
 * This module is the lab of a replicated group: a primary and its replicas, and the Sentinels
 * that decide which member is the primary. It opens one environment for a group cell, and it does
 * the runs of the cell in it. Each member and each Sentinel is a container from the stock image of
 * the group, in its own network namespace. An injector sidecar shares its network and process
 * namespaces. The client of each run is ioredis in Sentinel mode. An observer subscribes to the
 * events of each Sentinel, and the prober watches the namespace of the client.
 */

/** A stamp is the time of the injector around one commit, on CLOCK_MONOTONIC in nanoseconds. */
export interface Stamp {
  readonly t0: number;
  readonly t1: number;
}

/** A group network fault is a black hole between a part and its peers, or a reset of each segment from them. */
export type GroupNetworkFault = "blackhole" | "rst";

/** A group client is the client container of one run of a group cell. */
export interface GroupClient {
  readonly events: readonly ProbeEvent[];
  until(kinds: readonly string[], within: number): Promise<ProbeEvent>;
  stop(): Promise<void>;
}

/** A group lab is one environment of a group cell. */
export interface GroupLab {
  readonly group: Group;
  readonly clientIp: string;
  readonly observerIp: string;
  readonly members: Readonly<Record<string, RunPart>>;
  readonly sentinels: Readonly<Record<string, RunPart>>;
  /** These are the namespaces that the prober watches: the client, and the Sentinels for a calibration. */
  readonly netns: { readonly client: number; readonly watched: readonly number[] };
  /** These are all the records that the prober wrote, in sequence. */
  readonly kernel: readonly KernelRecord[];
  /** These are all the lines of the observer of the Sentinels, in sequence. */
  readonly timeline: readonly SentinelEvent[];
  /** This method sets the sysctls of the client namespace through its privileged sidecar, and reads them back. */
  sysctl(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /** This method waits until the group is whole and calm, and gives the name of its primary. */
  converge(within?: number): Promise<string>;
  /** This method removes each key from the group, and waits until each replica has the removal. */
  flush(primary: string): Promise<void>;
  /** This method makes each Sentinel forget the state of the group (`SENTINEL RESET`): an aborted failover then holds off no later attempt. */
  reset(): Promise<void>;
  /** This method gives the sequence numbers that the group holds, from its primary. */
  holds(primary: string): Promise<number[]>;
  /** This method gives the part that has a role in the group, when `primary` is the primary. */
  partOf(role: GroupRole, primary: string): string;
  /** This method starts the client of a run, with the arguments of `client-sentinel.mjs`. */
  client(args: readonly string[]): Promise<GroupClient>;
  /** This method applies a network fault between a part and some of its peers, at once or at an instant of the VM. */
  fault(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method removes a network fault, at once or at an instant of the VM. */
  lift(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method sends a signal to the server process of a part, at once or at an instant of the VM. */
  signal(part: string, signal: "KILL" | "STOP" | "CONT", at?: number): Promise<Stamp>;
  /** This method starts the server of a member again, after a fin. */
  restart(member: string): Promise<void>;
  /** This method asks the first Sentinel for a failover of the group. */
  failover(coordinated: boolean): Promise<Stamp>;
  /** This method removes the TCP metrics of the client namespace: each run starts from a kernel that keeps nothing. */
  forget(): Promise<void>;
  /** This method waits for the next clock line of the prober, which gives the count of lost records. */
  settle(): Promise<number | null>;
  manifest(sysctls: Readonly<Record<string, string>>): Promise<Manifest>;
  close(): Promise<void>;
}

/** This function gives the configuration file of a member: its port, its settings, and the primary that a replica follows. */
export const memberConfig = (group: Group, primary: string | null): string =>
  [
    `port ${group.port}`,
    ...Object.entries(group.memberSettings).map(([key, value]) => `${key} ${value}`),
    ...(primary === null ? [] : [`replicaof ${primary} ${group.port}`]),
    "",
  ].join("\n");

/** This function gives the configuration file of a Sentinel: its port, the group that it monitors, and the settings of the group. */
export const sentinelConfig = (group: Group, primary: string): string =>
  [
    `port ${group.sentinelPort}`,
    `sentinel monitor ${group.name} ${primary} ${group.port} ${group.quorum}`,
    ...Object.entries(group.sentinelSettings).map(([key, value]) => `sentinel ${key} ${group.name} ${value}`),
    "",
  ].join("\n");

/**
 * This function gives the peers that a fault on a part cuts it from, by their addresses. `all` is
 * each other part and the client, `group` is the other parts, and `clients` is the client. The
 * observer is not a peer, thus the timeline of the group stays whole.
 */
export const peersOf = (
  parts: { readonly members: Readonly<Record<string, RunPart>>; readonly sentinels: Readonly<Record<string, RunPart>> },
  client: string,
  part: string,
  cuts: NonNullable<GroupPlace["cuts"]>,
): string[] => {
  const others = [...Object.entries(parts.members), ...Object.entries(parts.sentinels)]
    .filter(([name]) => name !== part)
    .map(([, at]) => at.ip);
  if (cuts === "clients") return [client];
  if (cuts === "group") return others;
  return [...others, client];
};

/** This function reads the flat reply of a command line client into its fields: name, value, name, value. */
export const fieldsOf = (text: string): Array<Record<string, string>> => {
  const out: Array<Record<string, string>> = [];
  const words = text.split("\n").map((line) => line.replace(/\r$/, ""));
  let current: Record<string, string> | null = null;
  for (let at = 0; at + 1 < words.length; at += 2) {
    const [key, value] = [words[at]!, words[at + 1]!];
    // each entry of a list starts again at its name
    if (key === "name" || current === null) {
      current = {};
      out.push(current);
    }
    current[key] = value;
  }
  return out;
};

/** This function reads the INFO of a server into its fields. */
export const infoOf = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (line.startsWith("#") || at === -1) continue;
    out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
};

/**
 * A view of the group is what its parts tell at one time. `healthy` tells if each Sentinel agrees
 * on one primary with no flag but `master`, and knows each replica and each other Sentinel. Each
 * replica must follow that primary with its link up, and the primary must have each replica online,
 * with no failover in progress.
 */
export interface GroupView {
  readonly primary: string | null;
  readonly healthy: boolean;
  readonly why: string;
}

/** This function judges the views of the Sentinels and of the members: the primary that they agree on, if the group is healthy. */
export const viewOf = (
  group: Group,
  ips: Readonly<Record<string, string>>,
  sentinels: ReadonlyArray<{ readonly master: Record<string, string>; readonly replicas: ReadonlyArray<Record<string, string>> }>,
  members: Readonly<Record<string, Record<string, string>>>,
): GroupView => {
  const others = String(group.sentinels.length - 1);
  const replicas = group.members.length - 1;
  const addresses = new Set(sentinels.map((each) => each.master["ip"]));
  if (addresses.size !== 1) return { primary: null, healthy: false, why: `the Sentinels name ${addresses.size} primaries` };
  const ip = [...addresses][0]!;
  const primary = Object.entries(ips).find(([, at]) => at === ip)?.[0] ?? null;
  if (primary === null) return { primary: null, healthy: false, why: `no member has the address ${ip}` };
  for (const [at, each] of sentinels.entries()) {
    if (each.master["flags"] !== "master") return { primary, healthy: false, why: `Sentinel ${at} flags the primary ${each.master["flags"]}` };
    if (each.master["num-other-sentinels"] !== others) return { primary, healthy: false, why: `Sentinel ${at} knows ${each.master["num-other-sentinels"]} other Sentinels` };
    const good = each.replicas.filter(
      (replica) => replica["flags"] === "slave" && replica["master-link-status"] === "ok" && replica["master-host"] === ip,
    );
    if (good.length !== replicas || each.replicas.length !== replicas)
      return { primary, healthy: false, why: `Sentinel ${at} has ${good.length} healthy replicas of ${each.replicas.length}` };
  }
  const info = members[primary] ?? {};
  if (info["role"] !== "master") return { primary, healthy: false, why: `${primary} reports the role ${info["role"]}` };
  if (info["master_failover_state"] !== undefined && info["master_failover_state"] !== "no-failover")
    return { primary, healthy: false, why: `${primary} is in the failover state ${info["master_failover_state"]}` };
  const online = Object.entries(info).filter(([key, value]) => /^slave\d+$/.test(key) && value.includes("state=online")).length;
  if (online !== replicas) return { primary, healthy: false, why: `${primary} has ${online} replicas online` };
  for (const name of group.members) {
    if (name === primary) continue;
    const each = members[name] ?? {};
    if (each["role"] !== "slave" || each["master_host"] !== ip || each["master_link_status"] !== "up")
      return { primary, healthy: false, why: `${name} is not a replica of ${primary} with its link up` };
  }
  return { primary, healthy: true, why: "healthy" };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** This time is the longest that a group takes to converge before a run, or after it. */
export const CONVERGE_MS = 240_000;

/**
 * This function opens one environment of a group cell:
 * - one new network, with each member, each Sentinel, the client and the observer on it.
 * - each member: the stock image, its server as the child of a shell, thus a fin can stop the
 *   server and the container stays up. The first member is the primary, and the others follow it.
 * - each Sentinel: the stock image, its Sentinel as the child of a shell, which monitors the first member.
 * - an injector sidecar for each part, in its network and process namespaces.
 * - a client that holds its own network namespace, with a privileged sidecar for its sysctls.
 * - the observer of the Sentinels, in a namespace of its own.
 * - the prober, which watches the namespace of the client, and of each Sentinel for a calibration.
 */
export const openGroupLab = async (group: Group, options: { readonly watchSentinels?: boolean } = {}): Promise<GroupLab> => {
  const image = await harnessImage();
  const node = await nodeClientImage();
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
    const parts = { members: {} as Record<string, RunPart>, sentinels: {} as Record<string, RunPart> };
    /** This function starts one part: the stock image with its configuration, its program as the child of a shell, and its injector. */
    const start = async (name: string, program: string, file: string, content: string, ready: string) => {
      const box = await new GenericContainer(group.image)
        .withNetwork(network!)
        .withNetworkAliases(name)
        .withCopyContentToContainer([{ content, target: file }])
        .withCommand(["sh", "-c", `${program} ${file} & while :; do sleep 3600; done`])
        .withWaitStrategy(Wait.forLogMessage(ready))
        .start();
      opened.push(box);
      boxes.set(name, box);
      const injector = await withPid(
        new GenericContainer(image).withNetworkMode(`container:${box.getId()}`).withAddedCapabilities("NET_ADMIN", "NET_RAW"),
        `container:${box.getId()}`,
      ).start();
      opened.push(injector);
      injectors.set(name, injector);
      return { ip: await ipOf(box), netns: await netnsOf(injector) };
    };
    const [first, ...rest] = group.members;
    if (first === undefined) throw new Error("a group has no member");
    parts.members[first] = await start(first, group.programs.server, "/data/server.conf", memberConfig(group, null), group.ready.member);
    const primaryIp = parts.members[first].ip;
    for (const name of rest)
      parts.members[name] = await start(name, group.programs.server, "/data/server.conf", memberConfig(group, primaryIp), group.ready.member);
    for (const name of group.sentinels)
      parts.sentinels[name] = await start(name, group.programs.sentinel, "/data/sentinel.conf", sentinelConfig(group, primaryIp), group.ready.sentinel);

    const holder = await new GenericContainer(image).withNetwork(network).start();
    opened.push(holder);
    const admin = await new GenericContainer(image)
      .withNetworkMode(`container:${holder.getId()}`)
      .withPrivilegedMode()
      .start();
    opened.push(admin);
    const clientIp = await ipOf(holder);

    const sentinelAddresses = group.sentinels.map((name) => `${parts.sentinels[name]!.ip}:${group.sentinelPort}`);
    const timeline = lines<SentinelEvent>();
    const observer = await new GenericContainer(node)
      .withNetwork(network)
      .withCommand(["node", "/opt/harness/node/observer.mjs", sentinelAddresses.join(",")])
      .withLogConsumer(timeline.consume)
      .start();
    opened.push(observer);
    const observerIp = await ipOf(observer);
    for (const address of sentinelAddresses)
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const look = () => {
          if (timeline.seen.some((line) => line.ev === "subscribed" && line["sentinel"] === address)) resolve();
          else if (Date.now() - started > 30_000) reject(new Error(`the observer never subscribed to ${address}`));
          else setTimeout(look, 50);
        };
        look();
      });

    const clientNetns = await netnsOf(admin);
    const watched = [clientNetns, ...(options.watchSentinels === true ? group.sentinels.map((name) => parts.sentinels[name]!.netns) : [])];
    const records = lines<KernelRecord>();
    const prober = await new GenericContainer(image)
      .withPrivilegedMode()
      .withNetworkMode("none")
      .withCommand(["/opt/harness/prober", ...watched.map(String)])
      .withLogConsumer(records.consume)
      .start();
    opened.push(prober);
    const begun = await records.until(["begin", "fail"], 30_000, "prober");
    if (begun.ev === "fail") throw new Error(`the prober failed: ${String(begun["why"])}`);

    const box = (name: string): StartedTestContainer => {
      const found = boxes.get(name);
      if (found === undefined) throw new Error(`the group has no part ${name}`);
      return found;
    };
    const injectorOf = (name: string): StartedTestContainer => {
      const found = injectors.get(name);
      if (found === undefined) throw new Error(`the group has no part ${name}`);
      return found;
    };
    const cli = (name: string, args: readonly string[]): Promise<string> => {
      const port = group.sentinels.includes(name) ? group.sentinelPort : group.port;
      return output(box(name), [group.programs.cli, "-p", String(port), ...args]);
    };
    const stamped = async (where: StartedTestContainer, argv: string[]): Promise<Stamp> => {
      const stamp = JSON.parse((await output(where, argv)).split("\n").at(-1)!) as Stamp;
      return { t0: stamp.t0, t1: stamp.t1 };
    };
    const ips: Record<string, string> = Object.fromEntries(Object.entries(parts.members).map(([name, at]) => [name, at.ip]));
    const view = async (): Promise<GroupView> => {
      const sentinels = [];
      for (const name of group.sentinels) {
        const master = fieldsOf(await cli(name, ["SENTINEL", "MASTER", group.name]))[0] ?? {};
        const replicas = fieldsOf(await cli(name, ["SENTINEL", "REPLICAS", group.name]));
        sentinels.push({ master, replicas });
      }
      const members: Record<string, Record<string, string>> = {};
      for (const name of group.members) members[name] = infoOf(await cli(name, ["INFO", "replication"]));
      return viewOf(group, ips, sentinels, members);
    };
    const after = (at: number | undefined): string[] => (at === undefined ? [] : ["--at", String(Math.round(at))]);
    const roles = (role: GroupRole, primary: string): string => {
      if (role === "primary") return primary;
      if (role === "sentinel") return group.sentinels[0]!;
      const replica = group.members.find((name) => name !== primary);
      if (replica === undefined) throw new Error("the group has no replica");
      return replica;
    };

    return {
      group,
      clientIp,
      observerIp,
      members: parts.members,
      sentinels: parts.sentinels,
      netns: { client: clientNetns, watched },
      kernel: records.seen,
      timeline: timeline.seen,
      async sysctl(values) {
        const settings = Object.entries(values).map(([key, value]) => `${key}=${value}`);
        if (settings.length > 0) await output(admin, ["sysctl", "-q", "-w", ...settings]);
        const read: Record<string, string> = {};
        for (const key of Object.keys(values)) read[key] = await output(admin, ["sysctl", "-n", key]);
        return read;
      },
      async converge(within = CONVERGE_MS) {
        const started = Date.now();
        let calm = 0;
        let last: GroupView = { primary: null, healthy: false, why: "no view yet" };
        while (Date.now() - started < within) {
          last = await view().catch((error: unknown) => ({ primary: null, healthy: false, why: (error as Error).message }));
          // two healthy views in a row: one view can come in the middle of a change
          calm = last.healthy ? calm + 1 : 0;
          if (calm >= 2 && last.primary !== null) return last.primary;
          await sleep(1_000);
        }
        throw new Error(`the group did not converge in ${within} ms: ${last.why}`);
      },
      async flush(primary) {
        await cli(primary, ["FLUSHALL"]);
        const acked = Number(await cli(primary, ["WAIT", String(group.members.length - 1), "5000"]));
        if (acked !== group.members.length - 1) throw new Error(`${acked} replicas acknowledged the flush`);
      },
      async reset() {
        for (const name of group.sentinels) await cli(name, ["SENTINEL", "RESET", group.name]);
      },
      async holds(primary) {
        const keys = await cli(primary, ["--scan", "--pattern", "w:*"]);
        return keys
          .split("\n")
          .map((key) => Number(key.trim().slice(2)))
          .filter((n) => Number.isInteger(n) && n > 0)
          .sort((a, b) => a - b);
      },
      partOf: roles,
      async client(args) {
        const events = lines<ProbeEvent>();
        const container = await new GenericContainer(node)
          .withNetworkMode(`container:${holder.getId()}`)
          .withCommand(["node", "/opt/harness/node/client-sentinel.mjs", ...args])
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
        const peers = peersOf(parts, clientIp, part, cuts).join(",");
        return stamped(injectorOf(part), ["/opt/harness/inject", kind, peers, ...after(at)]);
      },
      lift(kind, part, cuts, at) {
        const peers = peersOf(parts, clientIp, part, cuts).join(",");
        return stamped(injectorOf(part), ["/opt/harness/inject", kind === "rst" ? "clear-rst" : "clear", peers, ...after(at)]);
      },
      signal(part, signal, at) {
        const program = group.sentinels.includes(part) ? group.programs.sentinel : group.programs.server;
        return stamped(injectorOf(part), ["/opt/harness/inject", "signal", program, signal, ...after(at)]);
      },
      async restart(member) {
        await output(box(member), ["sh", "-c", `${group.programs.server} /data/server.conf --daemonize yes`]);
        const started = Date.now();
        while ((await cli(member, ["PING"]).catch(() => "")) !== "PONG") {
          if (Date.now() - started > 30_000) throw new Error(`${member} did not start again`);
          await sleep(200);
        }
      },
      failover(coordinated) {
        const sentinel = group.sentinels[0]!;
        return stamped(injectorOf(sentinel), [
          "/opt/harness/inject",
          "resp",
          `127.0.0.1:${group.sentinelPort}`,
          "SENTINEL",
          "FAILOVER",
          group.name,
          ...(coordinated ? ["COORDINATED"] : []),
        ]);
      },
      async forget() {
        await output(admin, ["ip", "tcp_metrics", "flush", "all"]);
      },
      async settle() {
        const from = records.seen.length;
        const clock = await new Promise<KernelRecord | null>((resolve) => {
          const started = Date.now();
          const look = () => {
            const line = records.seen.slice(from).find((record) => record.ev === "clock");
            if (line !== undefined) resolve(line);
            else if (Date.now() - started > 5_000) resolve(null);
            else setTimeout(look, 50);
          };
          look();
        });
        return clock === null ? null : Number(clock["lost"] ?? 0);
      },
      async manifest(sysctls) {
        const config = await output(admin, ["zcat", "/proc/config.gz"]).catch(() => "");
        const inspect = async (container: StartedTestContainer) =>
          runtime.container.inspect(runtime.container.getById(container.getId()));
        const memberSettings = async (name: string) => {
          const read: Record<string, string> = {};
          // the reply is the name, then the value: an empty value is the end of the reply
          for (const key of Object.keys(group.memberSettings)) read[key] = (await cli(name, ["CONFIG", "GET", key])).split("\n")[1] ?? "";
          return read;
        };
        const sentinelSettings = async (name: string) => {
          const master = fieldsOf(await cli(name, ["SENTINEL", "MASTER", group.name]))[0] ?? {};
          const read: Record<string, string> = { quorum: master["quorum"] ?? "" };
          for (const key of Object.keys(group.sentinelSettings)) read[key] = master[key] ?? "";
          return read;
        };
        const members = [];
        for (const name of group.members)
          members.push({ name, ip: parts.members[name]!.ip, id: (await inspect(box(name))).Image, settings: await memberSettings(name) });
        const sentinels = [];
        for (const name of group.sentinels)
          sentinels.push({ name, ip: parts.sentinels[name]!.ip, id: (await inspect(box(name))).Image, settings: await sentinelSettings(name) });
        return {
          kernel: await output(holder, ["uname", "-r"]),
          architecture: await output(holder, ["uname", "-m"]),
          hz: /^CONFIG_HZ=(\d+)$/m.exec(config)?.[1] ?? null,
          boot_id: await output(holder, ["cat", "/proc/sys/kernel/random/boot_id"]),
          docker: `${runtime.info.containerRuntime.serverVersion} on ${runtime.info.containerRuntime.operatingSystem}`,
          target: { image: group.image, id: members[0]!.id, settings: members[0]!.settings, sysctls: {} },
          harness: {
            image,
            id: (await inspect(holder)).Image,
            packages: (await output(holder, ["apk", "info", "-v"])).split("\n").sort(),
          },
          client: { kind: "ioredis", image: node },
          netns: { client: clientNetns, target: parts.members[first]!.netns },
          sysctls,
          group: { members, sentinels, observer: { image: node } },
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
// the runs of a group cell
// ---------------------------------------------------------------------------------------------

/** This count is the number of accepted writes that a run waits for before its fault: the stream is steady then. */
const STEADY = 20;
/** This time is how long a run continues after its outcome, so that the record shows what came next. */
const TAIL_MS = 2_000;

/** This function gives the address of a member, with the port of the group. */
const addressOf = (lab: GroupLab, member: string): string => `${lab.members[member]!.ip}:${lab.group.port}`;

/** This function gives the latest time that a group cell waits for its outcome, in ms from the fault. */
export const deadlineOf = (cell: Cell): number => {
  const { prediction } = cell;
  const seconds =
    prediction.detects === true
      ? valueIn(prediction.high, "s")
      : prediction.detects === false && prediction.recovers !== undefined
        ? valueIn(prediction.recovers.high, "s")
        : valueIn(prediction.window, "s");
  return seconds * 1_000 + 10_000;
};

/** This function gives the arguments of the client of a group cell. */
const clientArgs = (cell: Cell, lab: GroupLab): string[] => {
  const sentinels = cell.group!.sentinels.map((name) => `${lab.sentinels[name]!.ip}:${cell.group!.sentinelPort}`);
  return [
    "--sentinels",
    sentinels.join(","),
    "--name",
    cell.group!.name,
    "--interval-ms",
    String(cell.probe.interval === undefined ? 50 : valueIn(cell.probe.interval, "ms")),
    "--max-s",
    String(Math.ceil(deadlineOf(cell) / 1_000 + 120)),
    ...(cell.driverOptions === undefined ? [] : ["--options", JSON.stringify(cell.driverOptions)]),
  ];
};

/** This function waits until a condition on the lines of the client holds, or for `within` ms. It gives the first line that matches. */
const waitFor = (
  client: GroupClient,
  match: (event: ProbeEvent) => boolean,
  within: number,
): Promise<ProbeEvent | undefined> =>
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
  for (let at = records.length - 1; at >= 0; at -= 1)
    if (records[at]!.ev === "clock") return Number(records[at]!["lost"] ?? 0);
  return 0;
};

/**
 * This function does one run of a group cell:
 * - The group converges, and its keys go. The client connects through the Sentinels, and its
 *   stream of writes gets steady.
 * - The fault occurs on its part, as the primary of this run makes the roles. A fault with a
 *   hold lifts at its instant in the VM. A stall lifts at its length after the first write into it.
 * - The run waits for its outcome: the first write that a new primary accepts, or the first one
 *   after the lift on the same primary. Then it continues for a moment.
 * - Each fault goes, the client stops, and the group converges again. The keys that it then holds
 *   tell which writes it kept.
 */
export const groupOnce = async (lab: GroupLab, cell: Cell, environment: number, index: number): Promise<Run> => {
  const group = cell.group!;
  const primary = await lab.converge();
  await lab.flush(primary);
  await lab.forget();
  const from = lab.kernel.length;
  const timelineFrom = lab.timeline.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const client = await lab.client(clientArgs(cell, lab));
  const lands = cell.prediction.group?.lands ?? "new";
  const place = (cell.faultAt ?? { role: "primary" }) as GroupPlace;
  let fault: Run["fault"] = null;
  let heal: Run["heal"] = null;
  let at: string | null = null;
  const undo: Array<() => Promise<unknown>> = [];
  try {
    await client.until(["ready"], 60_000);
    const steady = await waitFor(client, (event) => event.ev === "ack" && Number(event["n"]) >= STEADY, 30_000);
    if (steady === undefined) throw new Error(`the client did not write ${STEADY} times in 30 s`);
    let healing: Promise<Run["heal"]> | null = null;
    switch (cell.fault) {
      case "blackhole":
      case "partition":
      case "rst": {
        const kind = cell.fault === "rst" ? "rst" : "blackhole";
        const cuts = place.cuts ?? (cell.fault === "partition" ? "group" : "all");
        const part = lab.partOf(place.role, primary);
        at = part;
        fault = await lab.fault(kind, part, cuts);
        undo.push(() => lab.lift(kind, part, cuts));
        if (cell.stall !== undefined) {
          // the first write into the fault arms the retransmissions: the stall counts from it
          const t1 = fault.t1;
          const sent = await waitFor(client, (event) => event.ev === "sent" && event.t > t1, 5_000);
          if (sent !== undefined) healing = lab.lift(kind, part, cuts, sent.t + valueIn(cell.stall, "s") * 1e9);
        } else if (cell.hold !== undefined) {
          healing = lab.lift(kind, part, cuts, fault.t0 + valueIn(cell.hold, "s") * 1e9);
        }
        break;
      }
      case "freeze-process": {
        const part = lab.partOf(place.role, primary);
        at = part;
        fault = await lab.signal(part, "STOP");
        undo.push(() => lab.signal(part, "CONT"));
        if (cell.hold !== undefined) healing = lab.signal(part, "CONT", fault.t0 + valueIn(cell.hold, "s") * 1e9);
        break;
      }
      case "fin": {
        const part = lab.partOf(place.role, primary);
        at = part;
        fault = await lab.signal(part, "KILL");
        if (group.members.includes(part)) undo.push(() => lab.restart(part));
        break;
      }
      case "planned-failover":
        fault = await lab.failover(cell.coordinated === true);
        break;
      default:
        throw new Error(`a group cell has no fault ${cell.fault}`);
    }
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
    const t0 = fault.t0;
    const old = addressOf(lab, primary);
    const deadline = deadlineOf(cell);
    const outcome =
      lands === "new"
        ? await waitFor(
            client,
            (event) => event.ev === "ack" && event.t > t0 && typeof event["at"] === "string" && event["at"] !== old,
            deadline,
          )
        : await (async () => {
            await healed;
            const after = (heal as Run["heal"])?.t0 ?? t0;
            return waitFor(client, (event) => event.ev === "ack" && event.t > after, deadline);
          })();
    if (outcome !== undefined) await sleep(TAIL_MS);
    await healed;
  } finally {
    // each fault that is still on goes, and a killed server starts again
    for (const step of undo.reverse()) await step().catch(() => undefined);
    await client.stop();
  }
  const settled = await lab.settle();
  const lost = settled === null ? null : settled - lostBefore;
  const after = await lab.converge().catch(() => null);
  const holds = after === null ? null : await lab.holds(after);
  // a failover that a Sentinel aborted holds off its next attempt for 2 × failover-timeout. The
  // next run must not inherit that hold-off: each Sentinel forgets the state of the group, and the
  // next converge waits until each one knows the group again
  if (lab.timeline.slice(timelineFrom).some((line) => line.ev === "sentinel" && String(line.event).startsWith("-failover-abort")))
    await lab.reset();
  return {
    environment,
    index,
    events: [...client.events],
    fault,
    ...(heal === null ? {} : { heal }),
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.members[primary]!.netns,
    lost,
    group: {
      members: lab.members,
      sentinels: lab.sentinels,
      primary,
      at,
      timeline: lab.timeline.slice(timelineFrom),
      after,
      holds,
    },
  };
};
