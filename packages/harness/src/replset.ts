import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import { valueIn } from "@mark1russell7/quantity";
import type { Cell, GroupPlace, GroupRole, KernelRecord, ProbeEvent, ReplicaSet, Run, RunPart, SentinelEvent } from "./cell.ts";
import type { GroupClient, GroupNetworkFault, GroupView, Stamp } from "./group.ts";
import { CONVERGE_MS, deadlineOf } from "./group.ts";
import type { Manifest } from "./lab.ts";
import { STOP, containers, harnessImage, lines, mongoClientImage, netnsOf, output, withPid } from "./lab.ts";

/**
 * This module is the lab of a replica set: a replicated group with no external authority, whose
 * members elect their own primary. It opens one environment for a replica set cell, for the runs
 * of the cell. Each member is a container from the stock image of the set, in its own network
 * namespace. An injector sidecar shares its network and process namespaces.
 *
 * The client of each run is the MongoDB driver, which finds the primary with its own monitors. The
 * timeline comes from the log of each member and from the lines of the client. The prober watches
 * the namespace of the client.
 */

/**
 * A member line is one log line of a member, as mongod writes it in JSON. `real` is its time on
 * the wall clock in ms, and `t` is its time on the monotonic clock. The run gives `t` from the
 * clock lines of its client.
 */
export interface MemberLine extends SentinelEvent {
  readonly ev: "mongod";
  readonly member: string;
  readonly real: number;
  readonly id: number;
  readonly c: string;
  readonly msg: string;
  readonly attr: Readonly<Record<string, unknown>>;
}

/** These are the components of the log of mongod that a run keeps: replication, its heartbeats, the elections, the rollbacks and the commands. */
export const KEPT: ReadonlySet<string> = new Set(["REPL", "REPL_HB", "ELECTION", "ROLLBACK", "COMMAND"]);

/** This function reads one log line of a member, or gives null for a line of another component or a line that is not JSON. */
export const memberLineOf = (member: string, text: string): MemberLine | null => {
  if (!text.startsWith("{")) return null;
  let line: { t?: { $date?: string }; c?: string; id?: number; msg?: string; attr?: Record<string, unknown> };
  try {
    line = JSON.parse(text) as typeof line;
  } catch {
    return null;
  }
  const real = Date.parse(line.t?.$date ?? "");
  if (!Number.isFinite(real) || !KEPT.has(line.c ?? "")) return null;
  return { ev: "mongod", t: 0, member, real, id: Number(line.id ?? 0), c: line.c ?? "", msg: line.msg ?? "", attr: line.attr ?? {} };
};

/**
 * This function gives the offset of the wall clock from the monotonic clock, in ns, from the clock
 * lines of a client. Each line pairs its stamp with the wall clock in whole ms, which truncates.
 * Thus each pair is the offset or less, and the largest pair is the nearest. It is null without a clock line.
 */
export const clockOffsetOf = (events: readonly ProbeEvent[]): number | null => {
  const offsets = events.filter((event) => event.ev === "clocks").map((event) => Number(event["real"]) * 1e6 - event.t);
  return offsets.length === 0 ? null : Math.max(...offsets);
};

/** This function puts the log lines of the members on the monotonic clock, with the offset of a client. */
export const onMonotonic = (log: readonly MemberLine[], offset: number | null): MemberLine[] =>
  log.map((line) => ({ ...line, t: offset === null ? 0 : Math.round(line.real * 1e6 - offset) }));

/** A cut is the peers that a network fault on a part cuts it from, by their addresses, and the direction of the rules. */
export interface Cut {
  readonly peers: readonly string[];
  readonly direction?: "out";
}

/**
 * This function gives the peers that a fault on a member of a replica set cuts it from. `all` is
 * each other member and the client, `group` is the other members, and `clients` is the client.
 * `one` is the first other member in the sequence of the set, and `one-way` is the same member for
 * the segments from the part only.
 */
export const cutOf = (
  set: ReplicaSet,
  members: Readonly<Record<string, RunPart>>,
  client: string,
  part: string,
  cuts: NonNullable<GroupPlace["cuts"]>,
): Cut => {
  const others = set.members.filter((name) => name !== part).map((name) => members[name]!.ip);
  if (cuts === "clients") return { peers: [client] };
  if (cuts === "group") return { peers: others };
  if (cuts === "one") return { peers: others.slice(0, 1) };
  if (cuts === "one-way") return { peers: others.slice(0, 1), direction: "out" };
  return { peers: [...others, client] };
};

/** This function gives the command of the server of each member. The server is the child of a shell, thus a fin can stop it and the container stays up. */
export const memberCommand = (set: ReplicaSet): string =>
  `${set.programs.server} --replSet ${set.name} --bind_ip_all --port ${set.port} ${(set.args ?? []).join(" ")}`.trim();

/** This function gives the script of the shell that starts the set: each member by its address, and the settings of the set. */
export const initiateScript = (set: ReplicaSet, ips: Readonly<Record<string, string>>): string => {
  const config = {
    _id: set.name,
    members: set.members.map((name, at) => ({ _id: at, host: `${ips[name]}:${set.port}` })),
    settings: set.settings,
  };
  return `print(JSON.stringify(rs.initiate(${JSON.stringify(config)})))`;
};

/** This script prints the view of a member: itself, if it accepts writes, and the state of each member as it sees them. */
export const STATUS_SCRIPT: string =
  "const s = rs.status(); const h = db.hello(); print(JSON.stringify({ me: h.me, writable: h.isWritablePrimary === true, " +
  "members: s.members.map((m) => ({ name: m.name, state: m.stateStr, health: m.health, optime: m.optimeDate ? m.optimeDate.getTime() : null })) }))";

/** A status is the view of one member, as `STATUS_SCRIPT` prints it. */
export interface Status {
  readonly me: string;
  readonly writable: boolean;
  readonly members: ReadonlyArray<{ readonly name: string; readonly state: string; readonly health: number; readonly optime: number | null }>;
}

/**
 * This function judges the view of a member: the primary of the set, and if the set is healthy.
 * The set is healthy when the member is the one primary and accepts writes. Each other member must
 * be a healthy secondary at the optime of the primary.
 */
export const statusViewOf = (set: ReplicaSet, ips: Readonly<Record<string, string>>, status: Status): GroupView => {
  const byAddress = new Map(set.members.map((name) => [`${ips[name]}:${set.port}`, name]));
  const primaries = status.members.filter((member) => member.state === "PRIMARY");
  if (primaries.length !== 1) return { primary: null, healthy: false, why: `the set has ${primaries.length} primaries` };
  const primary = byAddress.get(primaries[0]!.name) ?? null;
  if (primary === null) return { primary: null, healthy: false, why: `no member has the address ${primaries[0]!.name}` };
  if (status.me !== primaries[0]!.name || !status.writable) return { primary, healthy: false, why: `${primary} does not accept writes yet` };
  if (status.members.length !== set.members.length) return { primary, healthy: false, why: `the set has ${status.members.length} members` };
  for (const member of status.members) {
    if (member.health !== 1) return { primary, healthy: false, why: `${member.name} is not healthy` };
    if (member.state !== "PRIMARY" && member.state !== "SECONDARY") return { primary, healthy: false, why: `${member.name} is ${member.state}` };
    if (member.optime !== primaries[0]!.optime) return { primary, healthy: false, why: `${member.name} is behind the primary` };
  }
  return { primary, healthy: true, why: "healthy" };
};

/** A replica set lab is one environment of a replica set cell. */
export interface ReplicaSetLab {
  readonly set: ReplicaSet;
  readonly clientIp: string;
  readonly members: Readonly<Record<string, RunPart>>;
  readonly netns: { readonly client: number };
  /** These are all the records that the prober wrote, in sequence. */
  readonly kernel: readonly KernelRecord[];
  /** These are the log lines of the members that a run keeps, in the sequence of their arrival, with `t` at 0. */
  readonly log: readonly MemberLine[];
  /** This method sets the sysctls of the client namespace through its privileged sidecar, and reads them back. */
  sysctl(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /** This method waits until the set is whole and calm, and gives the name of its primary. */
  converge(within?: number): Promise<string>;
  /** This method removes each write from the set, and waits until each member has the removal. */
  flush(primary: string): Promise<void>;
  /** This method gives the sequence numbers that the set holds, from its primary. */
  holds(primary: string): Promise<number[]>;
  /** This method gives the member that has a role in the set, when `primary` is the primary. */
  partOf(role: GroupRole, primary: string): string;
  /** This method starts the client of a run, with the arguments of `client-mongo.mjs`. */
  client(args: readonly string[]): Promise<GroupClient>;
  /** This method applies a network fault between a member and some of its peers, at once or at an instant of the VM. */
  fault(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method removes a network fault, at once or at an instant of the VM. */
  lift(kind: GroupNetworkFault, part: string, cuts: NonNullable<GroupPlace["cuts"]>, at?: number): Promise<Stamp>;
  /** This method sends a signal to the server process of a member, at once or at an instant of the VM. */
  signal(part: string, signal: "KILL" | "STOP" | "CONT", at?: number): Promise<Stamp>;
  /** This method starts the server of a member again, after a fin. */
  restart(member: string): Promise<void>;
  /** This method sends replSetStepDown to the primary. */
  stepDown(primary: string): Promise<Stamp>;
  /** This method removes the TCP metrics of the client namespace: each run starts from a kernel that keeps nothing. */
  forget(): Promise<void>;
  /** This method waits for the next clock line of the prober, which gives the count of lost records. */
  settle(): Promise<number | null>;
  manifest(sysctls: Readonly<Record<string, string>>): Promise<Manifest>;
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** These are the arguments of replSetStepDown: the time that the old primary cannot stand again, and the wait for a secondary to catch up. */
export const STEP_DOWN = { seconds: 60, catchUp: 10 } as const;

/**
 * This function opens one environment of a replica set cell:
 * - one new network, with each member, the client and the sender of a step-down on it.
 * - each member: the stock image, its server as the child of a shell. A log consumer reads its
 *   JSON log. The first member starts the set with the address of each member, and the lab
 *   waits for a primary.
 * - an injector sidecar for each member, in its network and process namespaces.
 * - a client that holds its own network namespace, with a privileged sidecar for its sysctls.
 * - the prober, which watches the namespace of the client.
 */
export const openReplicaSetLab = async (set: ReplicaSet): Promise<ReplicaSetLab> => {
  const image = await harnessImage();
  const mongo = await mongoClientImage();
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
    const log: MemberLine[] = [];
    for (const name of set.members) {
      let partial = "";
      const box = await new GenericContainer(set.image)
        .withNetwork(network)
        .withNetworkAliases(name)
        .withCommand(["sh", "-c", `${memberCommand(set)} & echo $! > /tmp/server.pid; while :; do sleep 3600; done`])
        .withWaitStrategy(Wait.forLogMessage(set.ready))
        .withLogConsumer((stream) =>
          stream.on("data", (chunk: Buffer | string) => {
            partial += chunk.toString();
            const split = partial.split("\n");
            partial = split.pop() ?? "";
            for (const text of split) {
              const line = memberLineOf(name, text.trim());
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
    const ips: Record<string, string> = Object.fromEntries(Object.entries(members).map(([name, at]) => [name, at.ip]));

    const holder = await new GenericContainer(image).withNetwork(network).start();
    opened.push(holder);
    const admin = await new GenericContainer(image).withNetworkMode(`container:${holder.getId()}`).withPrivilegedMode().start();
    opened.push(admin);
    const clientIp = await ipOf(holder);
    // the sender of a step-down is a client of its own, on the network but not in the watched namespace
    const commander = await new GenericContainer(mongo)
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
      if (found === undefined) throw new Error(`the set has no member ${name}`);
      return found;
    };
    const injectorOf = (name: string): StartedTestContainer => {
      const found = injectors.get(name);
      if (found === undefined) throw new Error(`the set has no member ${name}`);
      return found;
    };
    /** This function starts a script of the shell on a member, against its own server only. */
    const shell = (name: string, script: string): Promise<string> =>
      output(box(name), [
        set.programs.shell,
        "--quiet",
        "--norc",
        `mongodb://127.0.0.1:${set.port}/?directConnection=true&serverSelectionTimeoutMS=3000`,
        "--eval",
        script,
      ]);
    const lastLine = (text: string): string => text.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "";
    const stamped = async (where: StartedTestContainer, argv: string[]): Promise<Stamp> => {
      const stamp = JSON.parse(lastLine(await output(where, argv))) as Stamp;
      return { t0: stamp.t0, t1: stamp.t1 };
    };
    const after = (at: number | undefined): string[] => (at === undefined ? [] : ["--at", String(Math.round(at))]);
    let known: string = set.members[0]!;
    /** This function gives the view of the set: from the member that was the primary last, then from each other member. */
    const view = async (): Promise<GroupView> => {
      let last: GroupView = { primary: null, healthy: false, why: "no member answered" };
      for (const name of [known, ...set.members.filter((each) => each !== known)]) {
        const read = await shell(name, STATUS_SCRIPT)
          .then((text) => statusViewOf(set, ips, JSON.parse(lastLine(text)) as Status))
          .catch((error: unknown) => ({ primary: null, healthy: false, why: `${name}: ${(error as Error).message.slice(0, 200)}` }));
        if (read.primary !== null && read.primary === name) return read;
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
      throw new Error(`the set did not converge in ${within} ms: ${last.why}`);
    };

    // the first member starts the set, with the address of each member as the client reaches it
    const initiated = await shell(set.members[0]!, initiateScript(set, ips));
    if (!lastLine(initiated).includes('"ok":1')) throw new Error(`rs.initiate failed: ${lastLine(initiated)}`);
    await converge();

    return {
      set,
      clientIp,
      members,
      netns: { client: clientNetns },
      kernel: records.seen,
      log,
      async sysctl(values) {
        const settings = Object.entries(values).map(([key, value]) => `${key}=${value}`);
        if (settings.length > 0) await output(admin, ["sysctl", "-q", "-w", ...settings]);
        const read: Record<string, string> = {};
        for (const key of Object.keys(values)) read[key] = await output(admin, ["sysctl", "-n", key]);
        return read;
      },
      converge,
      async flush(primary) {
        const script =
          `const r = db.getSiblingDB("cells").w.deleteMany({}, { writeConcern: { w: ${set.members.length}, wtimeout: 10000 } }); ` +
          "print(JSON.stringify({ ok: r.acknowledged === true }))";
        const reply = lastLine(await shell(primary, script));
        if (!reply.includes('"ok":true')) throw new Error(`the flush failed: ${reply}`);
      },
      async holds(primary) {
        const script = 'print(JSON.stringify(db.getSiblingDB("cells").w.find({}, { n: 1, _id: 0 }).toArray().map((d) => d.n)))';
        const held = JSON.parse(lastLine(await shell(primary, script))) as unknown[];
        return held
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
          .sort((a, b) => a - b);
      },
      partOf(role, primary) {
        if (role === "primary") return primary;
        if (role === "sentinel") throw new Error("a replica set has no Sentinel");
        const secondary = set.members.find((name) => name !== primary);
        if (secondary === undefined) throw new Error("the set has no secondary");
        return secondary;
      },
      async client(args) {
        const events = lines<ProbeEvent>();
        const container = await new GenericContainer(mongo)
          .withNetworkMode(`container:${holder.getId()}`)
          .withCommand(["node", "/opt/harness/mongo/client-mongo.mjs", ...args])
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
        const cut = cutOf(set, members, clientIp, part, cuts);
        const direction = cut.direction === undefined ? [] : ["--direction", cut.direction];
        return stamped(injectorOf(part), ["/opt/harness/inject", kind, cut.peers.join(","), ...direction, ...after(at)]);
      },
      lift(kind, part, cuts, at) {
        const cut = cutOf(set, members, clientIp, part, cuts);
        const direction = cut.direction === undefined ? [] : ["--direction", cut.direction];
        return stamped(injectorOf(part), ["/opt/harness/inject", kind === "rst" ? "clear-rst" : "clear", cut.peers.join(","), ...direction, ...after(at)]);
      },
      signal(part, signal, at) {
        return stamped(injectorOf(part), ["/opt/harness/inject", "signal", set.programs.server, signal, ...after(at)]);
      },
      async restart(member) {
        // the restarted server writes to the output of the container, thus its log consumer reads it
        await output(box(member), ["sh", "-c", `${memberCommand(set)} > /proc/1/fd/1 2>&1 & echo $! > /tmp/server.pid`]);
        const started = Date.now();
        while (!(await shell(member, "print(db.hello().ok)").catch(() => "")).includes("1")) {
          if (Date.now() - started > 60_000) throw new Error(`${member} did not start again`);
          await sleep(500);
        }
      },
      stepDown(primary) {
        return stamped(commander, [
          "node",
          "/opt/harness/mongo/stepdown-mongo.mjs",
          `${members[primary]!.ip}:${set.port}`,
          String(STEP_DOWN.seconds),
          String(STEP_DOWN.catchUp),
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
        const inspect = async (container: StartedTestContainer) => runtime.container.inspect(runtime.container.getById(container.getId()));
        const script = "print(JSON.stringify({ version: db.version(), settings: rs.conf().settings }))";
        const list = [];
        for (const name of set.members) {
          const read = JSON.parse(lastLine(await shell(name, script))) as { version: string; settings: Record<string, unknown> };
          const settings: Record<string, string> = { version: read.version };
          for (const key of Object.keys(set.settings)) settings[key] = String(read.settings[key] ?? "");
          list.push({ name, ip: members[name]!.ip, id: (await inspect(box(name))).Image, settings });
        }
        return {
          kernel: await output(holder, ["uname", "-r"]),
          architecture: await output(holder, ["uname", "-m"]),
          hz: /^CONFIG_HZ=(\d+)$/m.exec(config)?.[1] ?? null,
          boot_id: await output(holder, ["cat", "/proc/sys/kernel/random/boot_id"]),
          docker: `${runtime.info.containerRuntime.serverVersion} on ${runtime.info.containerRuntime.operatingSystem}`,
          target: { image: set.image, id: list[0]!.id, settings: list[0]!.settings, sysctls: {} },
          harness: {
            image,
            id: (await inspect(holder)).Image,
            packages: (await output(holder, ["apk", "info", "-v"])).split("\n").sort(),
          },
          client: { kind: "mongodb", image: mongo },
          netns: { client: clientNetns, target: members[set.members[0]!]!.netns },
          sysctls,
          group: { members: list, sentinels: [], observer: { image: mongo } },
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
// the runs of a replica set cell
// ---------------------------------------------------------------------------------------------

/** This count is the number of accepted writes that a run waits for before its fault: the stream is steady then. */
const STEADY = 20;
/** This time is how long a run continues after its outcome, so that the record shows what came next. */
const TAIL_MS = 2_000;

/** This function gives the arguments of the client of a replica set cell: each member, and the stream of writes. */
export const replicaSetArgs = (cell: Cell, members: Readonly<Record<string, RunPart>>): string[] => {
  const set = cell.replicaSet!;
  const hosts = set.members.map((name) => `${members[name]!.ip}:${set.port}`);
  return [
    members[set.members[0]!]!.ip,
    String(set.port),
    "--mode",
    "stream",
    "--hosts",
    hosts.join(","),
    "--set",
    set.name,
    "--interval-ms",
    String(cell.probe.interval === undefined ? 50 : valueIn(cell.probe.interval, "ms")),
    "--max-s",
    String(Math.ceil(deadlineOf(cell) / 1_000 + (cell.hold === undefined ? 0 : valueIn(cell.hold, "s")) + 120)),
    "--w",
    String(cell.writeConcern ?? "majority"),
    ...(cell.driverOptions === undefined ? [] : ["--options", JSON.stringify(cell.driverOptions)]),
  ];
};

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
 * This function does one run of a replica set cell:
 * - The set converges, and its writes go. The client finds the primary with its monitors, and its
 *   stream of writes gets steady.
 * - The fault occurs on its member, as the primary of this run makes the roles. A fault with a
 *   hold lifts at its instant in the VM. A stall lifts at its length after the first write into
 *   it. A step-down is replSetStepDown to the primary.
 * - The run waits for its outcome: the first accepted write of a write sent after the commit of
 *   the fault. It is on a new primary, or on any primary. Then the run waits for the end of the
 *   hold, thus the record shows what the set did in the whole hold.
 * - Each fault goes, the client stops, and the set converges again. The writes that it then holds
 *   tell which writes it kept. The log lines of the members go onto the monotonic clock.
 */
export const replicaSetOnce = async (lab: ReplicaSetLab, cell: Cell, environment: number, index: number): Promise<Run> => {
  const set = cell.replicaSet!;
  const primary = await lab.converge();
  await lab.flush(primary);
  await lab.forget();
  const from = lab.kernel.length;
  const logFrom = lab.log.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const client = await lab.client(replicaSetArgs(cell, lab.members));
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
          // the first write into the fault arms the retransmissions: the stall counts from it. A
          // write that was in flight at the commit holds the stream, and then the stall counts from
          // the commit. The measurement then voids the run
          const t1 = fault.t1;
          const sent = await waitFor(client, (event) => event.ev === "sent" && event.t > t1, 5_000);
          healing = lab.lift(kind, part, cuts, (sent?.t ?? t1) + valueIn(cell.stall, "s") * 1e9);
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
        undo.push(() => lab.restart(part));
        break;
      }
      case "step-down":
        at = primary;
        fault = await lab.stepDown(primary);
        break;
      default:
        throw new Error(`a replica set cell has no fault ${cell.fault}`);
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
    const t1 = fault.t1;
    const old = `${lab.members[primary]!.ip}:${set.port}`;
    const sentAt = (n: number): number => client.events.find((event) => event.ev === "sent" && Number(event["n"]) === n)?.t ?? -Infinity;
    const outcome = await waitFor(
      client,
      (event) => event.ev === "ack" && sentAt(Number(event["n"])) > t1 && (lands === "same" || (typeof event["at"] === "string" && event["at"] !== old)),
      deadlineOf(cell),
    );
    if (outcome !== undefined) await sleep(TAIL_MS);
    // the whole hold: a prediction that no failover occurs reads the set in each moment of it
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
    targetNetns: lab.members[primary]!.netns,
    lost,
    group: {
      members: lab.members,
      sentinels: {},
      primary,
      at,
      timeline: onMonotonic(lab.log.slice(logFrom), clockOffsetOf(client.events)),
      after,
      holds,
    },
  };
};
