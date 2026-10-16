import { valueIn } from "@mark1russell7/quantity";
import type { Cell, FaultPlace, KernelRecord, ProbeEvent, Run } from "./cell.ts";
import type { FaultOptions, Lab, Manifest, Probe } from "./lab.ts";
import { openLab } from "./lab.ts";
import type { Measured } from "./observe.ts";
import { measure, socketOf } from "./observe.ts";
import type { Verdict } from "./verdict.ts";
import { STEPS, verdictOf } from "./verdict.ts";

/** A cell result is a cell with its manifests, its runs, their measurements and its verdict. */
export interface CellResult {
  readonly cell: Cell;
  readonly manifests: readonly Manifest[];
  readonly runs: readonly Run[];
  /** These are the warm-up runs, one for each environment before its counted runs. The verdict does not count them. */
  readonly warmups: readonly Run[];
  readonly measured: readonly Measured[];
  readonly verdict: Verdict;
  /** These times are when its first environment opened and its last environment closed, on the wall clock. */
  readonly at: { readonly started: string; readonly ended: string };
}

/**
 * This function measures and judges the raw records of a cell, with the code of the harness at
 * this time. `runCell` uses it during a cell. A holder of the raw records of a cell can use it
 * again later. Thus the records get a new analysis after a change to observe.ts or to the verdict.
 */
export const judge = (
  cell: Cell,
  runs: readonly Run[],
): { measured: Measured[]; verdict: Verdict } => {
  // a warm-up run is a record, not a sample: the verdict never counts it
  const measured = runs.filter((run) => run.warmup !== true).map((run) => measure(cell, run));
  return { measured, verdict: verdictOf(cell.prediction, measured) };
};

/** This function gives the count of lost records in the latest clock line of the prober, since it began. */
const droppedSoFar = (records: readonly KernelRecord[]): number => {
  for (let at = records.length - 1; at >= 0; at -= 1)
    if (records[at]!.ev === "clock") return Number(records[at]!["lost"] ?? 0);
  return 0;
};

/** This function gives the argv of the client for a cell, with a deadline far after all that it waits for. */
const probeArgs = (cell: Cell, lab: Lab): string[] => {
  const { prediction, probe } = cell;
  const longest =
    (prediction.detects ? valueIn(prediction.high, "s") : valueIn(prediction.window, "s")) +
    (cell.idleBefore === undefined ? 0 : valueIn(cell.idleBefore, "s"));
  const args = [lab.targetIp, String(lab.targetPort), "--mode", probe.mode];
  if (probe.request !== undefined) args.push("--request", probe.request);
  if (probe.count !== undefined) args.push("--count", String(probe.count));
  if (probe.interval !== undefined) args.push("--interval-ms", String(valueIn(probe.interval, "ms")));
  if (probe.driver !== undefined) {
    // a driver sets its socket options from its own options: the keepAlive of ioredis
    args.push("--keepalive-ms", String(valueIn(probe.driver.keepAlive, "ms")));
    args.push("--max-s", String(Math.ceil(longest * 2 + 10)));
    return args;
  }
  if (probe.keepalive) args.push("--keepalive");
  if (probe.userTimeout !== undefined)
    args.push("--user-timeout-ms", String(valueIn(probe.userTimeout, "ms")));
  args.push("--max-s", String(Math.ceil(longest * 2 + 10)));
  return args;
};

/**
 * This function waits for an error on the socket of the observer, or for its end of file
 * (CLOSE_WAIT, state 8). The prober records both. A cell whose observer is the server, or a proxy
 * of a topology, waits for that. The promise resolves after `within` ms at the latest.
 */
const observerError = (
  cell: Cell,
  partial: () => Run,
  within: number,
): Promise<void> =>
  new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const run = partial();
      const at = socketOf(cell, run);
      const seen =
        at !== undefined &&
        run.kernel.some(
          (record) =>
            record.netns === at.netns &&
            record.cookie === at.cookie &&
            ((record.ev === "error" && (record.err ?? 0) !== 0) ||
              (record.ev === "state" && (record as { readonly new?: number }).new === 8)),
        );
      if (seen || Date.now() - started > within) resolve();
      else setTimeout(look, 50);
    };
    look();
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * This time is the pause between the client's first reply and the fault. It is more than Linux's
 * TCP_DELACK_MAX of 200 ms. Thus the delayed ACK of the reply is out before the fault.
 */
export const QUIET_MS = 250;

/**
 * This function waits for the request that an in-flight client sends on the signal: its second
 * send, after the PING that made it ready. Its stamp is when the request first met the fault.
 */
const requestSent = (probe: Probe, within: number): Promise<ProbeEvent> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const look = () => {
      const sent = probe.events.filter((event) => event.ev === "sent")[1];
      if (sent !== undefined) resolve(sent);
      else if (Date.now() - started > within)
        reject(new Error(`the client sent no request within ${within} ms of being told to`));
      else setTimeout(look, 1);
    };
    look();
  });

/** This function gives the netem specification of a cell: its latency, then the netem of its fault when it has one. */
const netemSpec = (cell: Cell, fault: string | undefined): string | null => {
  const parts = [
    ...(cell.latency === undefined ? [] : [`delay ${valueIn(cell.latency, "ms")}ms`]),
    ...(fault === undefined ? [] : [fault]),
  ];
  return parts.length === 0 ? null : parts.join(" ");
};

/**
 * This function does one run. The client connects and gets its reply, the fault occurs, and an
 * in-flight client sends into it. The harness then waits for the observer to see the fault, or for
 * the silent window to end. The observer is the client, or the socket of the target for a cell on
 * the server side. It can also be a socket of a proxy of a topology.
 *
 * A stall stops by itself, at its length after the send of the request, and the
 * run waits for the reply. Then the harness removes the fault, thus the environment can serve the
 * next run. The run keeps the records of the prober from its start to its end. The frozen process
 * is the peer of the observer: the target, or the client for the server.
 *
 * A dry run does all of this but the fault: the warm-up of a cell whose fault ends its environment.
 */
const once = async (
  lab: Lab,
  cell: Cell,
  environment: number,
  index: number,
  dry = false,
): Promise<Run> => {
  // each run starts from kernels that keep nothing from the runs before it
  await lab.forget();
  const from = lab.kernel.length;
  const middleboxFrom = lab.middlebox.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const probe = await lab.probe(probeArgs(cell, lab));
  const server = cell.observer === "server";
  const peer = server
    ? { freeze: () => probe.freeze(), thaw: () => probe.thaw() }
    : { freeze: () => lab.freeze(), thaw: () => lab.thaw() };
  // a client that stopped before the signal to send tells why in its last lines
  const go = () =>
    probe.go().catch((error: unknown) => {
      const last = probe.events.slice(-3).map((event) => JSON.stringify(event));
      throw new Error(`${(error as Error).message}; the client's last lines: ${last.join(" ")}`);
    });
  const placed = lab.topology === null ? {} : { topology: lab.topology };
  /** This function gives the run as the records show it so far: the waits read it. */
  const partial = (): Run => ({
    environment,
    index,
    events: probe.events,
    fault: null,
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.netns.target,
    lost: 0,
    ...placed,
  });
  let fault: Run["fault"] = null;
  let heal: { t0: number; t1: number } | null = null;
  try {
    await probe.until(["ready"], 15_000);
    if (dry) {
      if (cell.probe.mode !== "idle") await go();
      await sleep(500);
    } else {
      // the in-flight data of a run on the server side is the reply of the server. The request goes
      // out first, and the fault occurs while the server holds it (the timeout of BLPOP). A fin with
      // a request in flight kills the server while it holds the request, so it goes first too
      const replyInFlight =
        cell.probe.mode === "inflight" &&
        ((server && cell.fault !== "mtu-blackhole") || cell.fault === "fin");
      if (replyInFlight) {
        // the client sends one sample after the file appears. The request reaches the server well
        // in the pause, and the reply waits for the timeout of the request
        await go();
        await sleep(200);
      } else {
        // The client acknowledges its first reply with a delayed ACK, 40 to 200 ms later
        // (TCP_DELACK_MIN to TCP_DELACK_MAX). A fault that comes first meets that ACK, not the
        // request or the idle time that the cell measures. So the fault waits until the ACK is out.
        await sleep(QUIET_MS);
      }
      const faultAt: FaultPlace = cell.faultAt ?? (server ? "client" : "target");
      // the direction of a simplex drop, relative to the namespace of the rule: in the target, or at
      // a proxy toward the client, the segments to the server come in; in the client, they go out
      const towardServerComesIn =
        faultAt === "target" || (typeof faultAt === "object" && faultAt.toward === "client");
      const direction: FaultOptions["direction"] =
        cell.drops === undefined
          ? undefined
          : (cell.drops === "to-server") === towardServerComesIn
            ? "in"
            : "out";
      const options: FaultOptions = {
        ...(direction === undefined ? {} : { direction }),
        ...(cell.icmp === undefined ? {} : { code: cell.icmp }),
        ...(cell.mtu === undefined ? {} : { above: cell.mtu }),
      };
      // a toxic of a cell whose fault is another one goes first: a slow close, then the close
      const toxicFirst = cell.toxic !== undefined && cell.fault !== "toxic";
      if (toxicFirst) await lab.toxic(cell.toxic!);
      // netem at the target shares its qdisc with the latency of the cell. At a hop, it is alone
      const netemAt: FaultPlace = cell.faultAt ?? "target";
      const netemOn = (fault: string | undefined) =>
        netemAt === "target" ? lab.netem(netemSpec(cell, fault), "target") : lab.netem(fault ?? null, netemAt);
      // an MTU drop goes where the long reply arrives: the namespace of the client
      const apply = async (): Promise<Run["fault"]> => {
        switch (cell.fault) {
          case "freeze-process":
            await peer.freeze();
            return null;
          case "fin":
            await (server ? probe.kill() : lab.kill());
            return null;
          case "unreachable":
            return lab.fault("reject", faultAt, { code: cell.icmp ?? "host" });
          case "simplex":
            return lab.fault("blackhole", faultAt, options);
          case "mtu-blackhole":
            return lab.fault("mtu", "client", { above: cell.mtu ?? 1200 });
          case "netem":
            return netemOn(cell.netem);
          case "rst":
            return lab.fault("rst", faultAt);
          // the router or the proxy of the topology is the fault, or a calibration has none: nothing to inject
          case "middlebox-forget":
          case "proxy-idle":
          case "none":
            return null;
          case "toxic":
            if (cell.toxic === undefined) throw new Error(`${cell.name} names no toxic`);
            return lab.toxic(cell.toxic);
          case "server-close":
            await lab.serverClose();
            return null;
          default:
            // a stall is a black hole that stops by itself
            return lab.fault("blackhole", faultAt);
        }
      };
      const lift = async (): Promise<void> => {
        switch (cell.fault) {
          case "freeze-process":
            return peer.thaw();
          case "fin":
          case "middlebox-forget":
          case "proxy-idle":
          case "server-close":
          case "none":
            return undefined;
          case "unreachable":
            return lab.lift("reject", faultAt, { code: cell.icmp ?? "host" });
          case "simplex":
            return lab.lift("blackhole", faultAt, options);
          case "mtu-blackhole":
            return lab.lift("mtu", "client", { above: cell.mtu ?? 1200 });
          case "netem":
            await netemOn(undefined);
            return undefined;
          case "rst":
            return lab.lift("rst", faultAt);
          case "toxic":
            await lab.toxic(null);
            return undefined;
          default:
            return heal === null ? lab.lift("blackhole", faultAt) : undefined;
        }
      };
      fault = await apply();
      try {
        // an idle time before the request: a router forgets the flow in it, or a keepalive keeps it
        if (cell.idleBefore !== undefined && cell.probe.mode !== "idle")
          await sleep(valueIn(cell.idleBefore, "ms"));
        if (cell.probe.mode !== "idle" && !replyInFlight) await go();
        const { prediction } = cell;
        if (cell.fault === "stall") {
          if (cell.stall === undefined) throw new Error(`${cell.name} says no stall's length`);
          // the injector holds the end in the VM until the length of the stall after the send
          const sent = await requestSent(probe, 5_000);
          heal = await lab.heal(faultAt, sent.t + valueIn(cell.stall, "s") * 1e9);
          const window = valueIn(prediction.detects ? prediction.high : prediction.window, "s");
          await probe.until(["data", "error", "eof"], window * 1_000).catch(() => undefined);
        } else if (prediction.detects === null) {
          // a distribution: the stream ends by itself, or the connection does
          const window = valueIn(prediction.window, "s") * 1_000;
          await probe.until(["done", "error", "eof", "deadline"], window).catch(() => undefined);
        } else if (prediction.detects) {
          const within = valueIn(prediction.high, "s") * 2_000 + 10_000;
          if (cell.observer !== undefined && cell.observer !== "client") {
            await observerError(cell, partial, within);
          } else {
            await probe.until(["error", "eof", "deadline"], within).catch(() => undefined);
          }
        } else {
          await sleep(valueIn(prediction.window, "s") * 1_000);
        }
      } finally {
        await lift();
        if (toxicFirst) await lab.toxic(null);
      }
      // a thawed target answers the request that it held: the client sees the late reply
      if (cell.fault === "freeze-process" && !server)
        await probe.until(["data"], 5_000).catch(() => undefined);
    }
  } finally {
    await probe.stop();
  }
  // the prober drains its ring each 20 ms. Its next clock line closes the records of the run
  const settled = await lab.settle();
  const lost = settled === null ? null : settled - lostBefore;
  return {
    environment,
    index,
    events: [...probe.events],
    fault,
    ...(cell.fault === "stall" ? { heal } : {}),
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.netns.target,
    lost,
    ...placed,
    ...(lab.topology === null ? {} : { middlebox: lab.middlebox.slice(middleboxFrom) }),
  };
};

/** This function divides a count of runs across environments, as equally as possible. */
export const spread = (runs: number, environments: number): number[] =>
  Array.from(
    { length: environments },
    (_, at) => Math.floor(runs / environments) + (at < runs % environments ? 1 : 0),
  ).filter((count) => count > 0);

/** This function tells if the fault of a cell ends its environment: a server that stopped cannot serve the next run. */
const endsEnvironment = (cell: Cell): boolean =>
  cell.fault === "fin" && (cell.observer === undefined || cell.observer === "client");

/** This function says one line for a run. */
const line = (cell: Cell, run: Run, read: Measured): string =>
  `${cell.name}: env ${run.environment} ${run.warmup === true ? "warm-up" : `run ${run.index}`} ${read.outcome.kind}` +
  `${read.elapsed === null ? "" : ` ${read.elapsed.value} s`}` +
  `${read.void === null ? "" : ` (void: ${read.void})`}`;

/**
 * This function does the part of the runs of a cell in one environment, and records its manifest.
 * A warm-up goes first, and the verdict does not count it. On a loaded machine, a new environment is
 * sometimes slow at first: its first exec, its first client, its first fault. The warm-up
 * of a cell whose fault ends the environment is a dry run, without the fault.
 */
const inEnvironment = async (
  cell: Cell,
  environment: number,
  count: number,
  say: (line: string) => void,
): Promise<{ manifest: Manifest; runs: Run[]; warmup: Run }> => {
  const lab = await openLab(cell.target, cell.client ?? cell.probe.driver?.name ?? "tcp", cell.topology);
  try {
    // the settings of the target first: Redis applies tcp-keepalive to a client when it accepts it
    const settings = await lab.configure(cell.targetSettings ?? {});
    const targetSysctls = await lab.targetSysctl(cell.targetSysctls ?? {});
    if (cell.targetSetup !== undefined) await lab.setup(cell.targetSetup);
    // netem and a length match act on segments only when TSO, GSO and GRO are off on the two ends,
    // and on the hop that the fault is at
    if (cell.fault === "mtu-blackhole" || cell.fault === "netem") {
      await lab.offload(false, "target");
      await lab.offload(false, "client");
      if (typeof cell.faultAt === "object") await lab.offload(false, cell.faultAt);
    }
    // a latency is on the path before the client connects, thus its round trip and RTO include it
    const latency = netemSpec(cell, undefined);
    if (latency !== null) await lab.netem(latency, "target");
    // the first connection must not wait for ARP: under a delay, that is a longer first round trip
    await lab.warm();
    const manifest = await lab.manifest(await lab.sysctl(cell.sysctls), settings, targetSysctls);
    const warmed = await once(lab, cell, environment, -1, endsEnvironment(cell));
    const warmup: Run = { ...warmed, warmup: true };
    say(line(cell, warmup, measure(cell, warmup)));
    const runs: Run[] = [];
    for (let index = 0; index < count; index += 1) {
      const run = await once(lab, cell, environment, index);
      runs.push(run);
      say(line(cell, run, measure(cell, run)));
    }
    return { manifest, runs, warmup };
  } finally {
    await lab.close();
  }
};

/**
 * This function does the runs of a cell. They go across new environments, and each environment records
 * its manifest. Then the verdict judges the runs. A median across the edge of the band extends
 * the cell from 11 runs to 22, and then to 44, each extension in new environments. With a
 * concurrency of more than one, that many environments operate at the same time, each with its
 * own prober. The runs then go across at least as many environments.
 *
 * Each environment does a warm-up first, and the result keeps it apart from the counted runs.
 */
export const runCell = async (
  cell: Cell,
  say: (line: string) => void = () => {},
): Promise<CellResult> => {
  const started = new Date().toISOString();
  const manifests: Manifest[] = [];
  const runs: Run[] = [];
  const warmups: Run[] = [];
  const concurrency = Math.max(1, cell.concurrency ?? 1);
  let target: number = cell.runs;
  let next = 0;
  for (;;) {
    const counts = spread(target - runs.length, Math.max(cell.environments, concurrency));
    for (let at = 0; at < counts.length; at += concurrency) {
      const batch = counts.slice(at, at + concurrency).map((count) => ({ count, env: next++ }));
      const done = await Promise.all(
        batch.map(({ count, env }) => inEnvironment(cell, env, count, say)),
      );
      for (const each of done) {
        manifests.push(each.manifest);
        runs.push(...each.runs);
        warmups.push(each.warmup);
      }
    }
    const { measured, verdict } = judge(cell, runs);
    const larger = STEPS.find((step) => step > runs.length);
    if (verdict.decision !== "extend" || larger === undefined) {
      const at = { started, ended: new Date().toISOString() };
      return { cell, manifests, runs, warmups, measured, verdict, at };
    }
    target = larger;
  }
};
