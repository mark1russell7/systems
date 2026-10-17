import { valueIn } from "@mark1russell7/quantity";
import type { Cell, FaultPlace, KernelRecord, ProbeEvent, Run } from "./cell.ts";
import { isHopPlace } from "./cell.ts";
import { longestOf, settled as driverSettled } from "./driver.ts";
import { groupOnce, openGroupLab } from "./group.ts";
import type { FaultOptions, Lab, Manifest, Probe } from "./lab.ts";
import { openLab } from "./lab.ts";
import type { Measured } from "./observe.ts";
import { measure, socketOf } from "./observe.ts";
import { openReplicaSetLab, replicaSetOnce } from "./replset.ts";
import type { Verdict } from "./verdict.ts";
import { STEPS, noiseOf, verdictOf } from "./verdict.ts";

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
  return { measured, verdict: verdictOf(cell.prediction, measured, noiseOf(cell)) };
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
    (prediction.detects === true && prediction.driver !== undefined
      ? longestOf(cell)
      : prediction.detects
        ? valueIn(prediction.high, "s")
        : valueIn(prediction.window, "s")) + (cell.idleBefore === undefined ? 0 : valueIn(cell.idleBefore, "s"));
  const args = [lab.targetIp, String(lab.targetPort), "--mode", probe.mode];
  if (probe.ws !== undefined) {
    // a WebSocket client gets each of its settings as a flag, and it has no default
    const { ws } = probe;
    const reconnects = prediction.detects !== false ? (prediction.reconnects?.waits ?? []) : [];
    const waits = reconnects.reduce((sum, wait) => sum + valueIn(wait.high, "s"), 0);
    args.push("--websocket", ws.socket);
    args.push("--heartbeat", ws.heartbeat === null ? "off" : "on");
    if (ws.heartbeat !== null)
      args.push(
        "--heartbeat-interval-ms",
        String(valueIn(ws.heartbeat.interval, "ms")),
        "--heartbeat-timeout-ms",
        String(valueIn(ws.heartbeat.timeout, "ms")),
        "--heartbeat-misses",
        String(ws.heartbeat.misses),
      );
    args.push("--reconnect", ws.reconnect === null ? "off" : "on");
    if (ws.reconnect !== null)
      args.push(
        "--reconnect-initial-ms",
        String(valueIn(ws.reconnect.initialDelay, "ms")),
        "--reconnect-multiplier",
        String(ws.reconnect.multiplier),
        "--reconnect-max-ms",
        String(valueIn(ws.reconnect.maxDelay, "ms")),
        "--reconnect-attempts",
        String(ws.reconnect.attempts),
        "--reconnect-jitter",
        String(ws.reconnect.jitter),
      );
    args.push("--request-timeout-ms", String(valueIn(ws.requestTimeout, "ms")));
    args.push("--connection-timeout-ms", String(valueIn(ws.connectionTimeout, "ms")));
    if (ws.hold !== undefined) args.push("--hold-ms", String(valueIn(ws.hold, "ms")));
    args.push("--max-s", String(Math.ceil((longest + waits) * 2 + 10)));
    return args;
  }
  if (probe.http !== undefined) {
    // an HTTP client sets its socket options from its own settings, and sends its own requests
    const { http } = probe;
    const gap = http.gap === undefined ? 0 : valueIn(http.gap, "s");
    args.push("--method", http.method);
    if (http.gap !== undefined) args.push("--gap-ms", String(valueIn(http.gap, "ms")));
    if (http.hold !== undefined) args.push("--hold-ms", String(valueIn(http.hold, "ms")));
    if (http.bytes !== undefined) args.push("--bytes", String(http.bytes));
    for (const [name, value] of Object.entries(http.options ?? {})) args.push(`--${name}`, String(value));
    // the client waits after its second request, thus its own close comes after the window
    args.push("--linger-ms", String(LINGER_MS));
    args.push("--max-s", String(Math.ceil(longest * 2 + gap + 10)));
    return args;
  }
  if (probe.request !== undefined) args.push("--request", probe.request);
  if (probe.count !== undefined) args.push("--count", String(probe.count));
  if (probe.interval !== undefined) args.push("--interval-ms", String(valueIn(probe.interval, "ms")));
  if (probe.driver?.name === "mongodb") {
    // the MongoDB driver: its replica set, its operation, its write concern and its own options
    args.push("--set", probe.driver.set);
    if (probe.driver.op !== undefined) args.push("--op", probe.driver.op);
    if (cell.writeConcern !== undefined) args.push("--w", String(cell.writeConcern));
    if (cell.before === true) args.push("--before");
    if (cell.driverOptions !== undefined) args.push("--options", JSON.stringify(cell.driverOptions));
    args.push("--max-s", String(Math.ceil(longest * 2 + 10)));
    return args;
  }
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
 * of a topology, waits for that. A target with its own detector can also drop the connection
 * itself (`dropped`). The promise resolves after `within` ms at the latest.
 */
const observerError = (
  cell: Cell,
  partial: () => Run,
  within: number,
  dropped: () => boolean = () => false,
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
      if (seen || dropped() || Date.now() - started > within) resolve();
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
 * This time is how long an HTTP client waits after its second request, before it exits. The exit
 * closes its sockets, thus that close comes after the window of the cell.
 */
export const LINGER_MS = 1000;

/** These are the lines that end the workload of an HTTP client: the end of its second request, its deadline, or its failure. */
const HTTP_DONE = ["done", "deadline", "fail"];

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

/** This time is how long a run of a driver cell continues after its outcome, so that the record shows what came next. */
const TAIL_MS = 1_000;

/** This function waits for the outcome of a run of a driver cell, or for `within` ms. The outcome is the end of its band and of each later band. */
const driverOutcome = async (cell: Cell, current: () => Run, within: number): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < within) {
    if (driverSettled(cell, current())) return;
    await sleep(250);
  }
};

/** This function gives the longest wait of a run of a driver cell for its outcome, in ms. */
const driverWithin = (cell: Cell): number => (longestOf(cell) * 1.2 + 10) * 1_000;

/**
 * This function does one run of a cell whose fault holds before the client starts (`Cell.before`).
 * The fault is a network fault at its place. The client then starts into it, and the run waits for
 * each band of the driver. Then the fault lifts.
 */
const beforeOnce = async (lab: Lab, cell: Cell, environment: number, index: number): Promise<Run> => {
  if (cell.fault !== "rst" && cell.fault !== "blackhole" && cell.fault !== "unreachable")
    throw new Error(`${cell.name}: a fault before the client starts is a network fault, not ${cell.fault}`);
  await lab.forget();
  const from = lab.kernel.length;
  const middleboxFrom = lab.middlebox.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const faultAt: FaultPlace = cell.faultAt ?? "target";
  const kind = cell.fault === "unreachable" ? "reject" : cell.fault;
  const options: FaultOptions = cell.fault === "unreachable" ? { code: cell.icmp ?? "host" } : {};
  const fault = await lab.fault(kind, faultAt, options);
  let probe: Probe | undefined;
  try {
    probe = await lab.probe(probeArgs(cell, lab));
    const started = probe;
    const current = (): Run => ({
      environment,
      index,
      events: started.events,
      fault,
      kernel: lab.kernel.slice(from),
      netns: lab.netns.client,
      targetNetns: lab.netns.target,
      lost: 0,
    });
    await driverOutcome(cell, current, driverWithin(cell));
    await sleep(TAIL_MS);
  } finally {
    await lab.lift(kind, faultAt, options);
    await probe?.stop();
  }
  const settled = await lab.settle();
  return {
    environment,
    index,
    events: [...(probe?.events ?? [])],
    fault,
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.netns.target,
    lost: settled === null ? null : settled - lostBefore,
    ...(lab.topology === null ? {} : { topology: lab.topology, middlebox: lab.middlebox.slice(middleboxFrom) }),
  };
};
/** This function waits for the first ping of the heartbeat of the client at the instant `after` or later: its first ping into a stall. */
const pingSent = (probe: Probe, after: number, within: number): Promise<ProbeEvent> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const look = () => {
      const ping = probe.events.find((event) => event.ev === "ping" && event.t >= after);
      if (ping !== undefined) resolve(ping);
      else if (Date.now() - started > within) reject(new Error(`the client sent no ping into the stall within ${within} ms`));
      else setTimeout(look, 1);
    };
    look();
  });

/**
 * This function waits until the client wrote `count` lines `dial`, one before each connection
 * that it tries, or until its deadline. It resolves after `within` ms at the latest.
 */
const dials = (probe: Probe, count: number, within: number): Promise<void> =>
  new Promise((resolve) => {
    const started = Date.now();
    const look = () => {
      const tried = probe.events.filter((event) => event.ev === "dial").length;
      const ended = probe.events.some((event) => event.ev === "deadline");
      if (tried >= count || ended || Date.now() - started > within) resolve();
      else setTimeout(look, 20);
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
  if (cell.before === true) return beforeOnce(lab, cell, environment, index);
  // each run starts from kernels that keep nothing from the runs before it
  await lab.forget();
  const from = lab.kernel.length;
  const middleboxFrom = lab.middlebox.length;
  const serverFrom = lab.server.length;
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
  // a target with a named process freezes by SIGSTOP, with stamps, and a hold thaws it at its instant
  const signalled = !server && cell.target.program !== undefined;
  let thawing: Promise<{ t0: number; t1: number }> | null = null;
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
        faultAt === "target" || (isHopPlace(faultAt) && faultAt.toward === "client");
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
          case "freeze-process": {
            if (signalled) {
              const stamp = await lab.signal("STOP");
              if (cell.hold !== undefined) {
                thawing = lab.signal("CONT", stamp.t0 + valueIn(cell.hold, "s") * 1e9).then((thawed) => {
                  heal = thawed;
                  return thawed;
                });
                thawing.catch(() => undefined);
              }
              return stamp;
            }
            await peer.freeze();
            return null;
          }
          case "fin":
            await (server ? probe.kill() : lab.kill());
            return null;
          case "unreachable":
            return lab.fault("reject", faultAt, { code: cell.icmp ?? "host" });
          case "simplex":
            return lab.fault("blackhole", faultAt, options);
          case "mtu-blackhole":
            return lab.fault("mtu", cell.faultAt ?? "client", { above: cell.mtu ?? 1200 });
          case "netem":
            return netemOn(cell.netem);
          case "rst":
            return lab.fault("rst", faultAt);
          // the router or the proxy of the topology is the fault, or a calibration has none, or the
          // server holds the reply by itself: nothing to inject
          case "middlebox-forget":
          case "proxy-idle":
          case "app-stall":
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
            if (signalled) {
              if (thawing !== null) await thawing.catch(() => lab.signal("CONT"));
              else await lab.signal("CONT");
              return undefined;
            }
            return peer.thaw();
          case "fin":
          case "middlebox-forget":
          case "proxy-idle":
          case "server-close":
          case "app-stall":
          case "none":
            return undefined;
          case "unreachable":
            return lab.lift("reject", faultAt, { code: cell.icmp ?? "host" });
          case "simplex":
            return lab.lift("blackhole", faultAt, options);
          case "mtu-blackhole":
            return lab.lift("mtu", cell.faultAt ?? "client", { above: cell.mtu ?? 1200 });
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
        // a client in a gap sends its second request by itself, a gap after its first reply
        if ((cell.probe.mode === "inflight" || cell.probe.mode === "stream") && !replyInFlight) await go();
        const { prediction } = cell;
        const http = cell.probe.http !== undefined;
        if (prediction.detects !== null && prediction.driver !== undefined) {
          // a driver cell: each of its bands ends, or its silent window passes from the fault
          if (prediction.detects) {
            await driverOutcome(cell, () => ({ ...partial(), fault }), driverWithin(cell));
          } else {
            await sleep(valueIn(prediction.window, "s") * 1_000);
          }
          await sleep(TAIL_MS);
        } else if (cell.probe.mode === "gap") {
          // the run ends when the second request does: its outcome is a part of the record
          const gap = cell.probe.http?.gap === undefined ? 0 : valueIn(cell.probe.http.gap, "s");
          const window = valueIn(prediction.detects ? prediction.high : prediction.window, "s");
          await probe.until(HTTP_DONE, (gap + window) * 2_000 + 10_000).catch(() => undefined);
        } else if (cell.fault === "stall") {
          if (cell.stall === undefined) throw new Error(`${cell.name} says no stall's length`);
          // the injector holds the end in the VM until the length of the stall after the send. An idle
          // client sends only the pings of its heartbeat: the stall counts from its first ping into it
          const window = valueIn(prediction.detects ? prediction.high : prediction.window, "s");
          const sent =
            cell.probe.mode === "idle"
              ? await pingSent(probe, fault?.t1 ?? 0, window * 1_000)
              : await requestSent(probe, 5_000);
          heal = await lab.heal(faultAt, sent.t + valueIn(cell.stall, "s") * 1e9);
          await probe.until(["data", "error", "eof", "drop"], window * 1_000).catch(() => undefined);
        } else if (prediction.detects === null) {
          // a distribution: the stream ends by itself, or the connection does
          const window = valueIn(prediction.window, "s") * 1_000;
          await probe.until(["done", "error", "eof", "deadline"], window).catch(() => undefined);
        } else if (prediction.detects) {
          const within = valueIn(prediction.high, "s") * 2_000 + 10_000;
          if (cell.observer !== undefined && cell.observer !== "client") {
            // a target with its own detector writes a drop line when it drops the connection itself
            await observerError(cell, partial, within, () => lab.server.slice(serverFrom).some((line) => line.ev === "drop"));
          } else if (http && cell.probe.mode !== "idle") {
            // an HTTP client can send the request again on a new connection: its outcome ends the run
            await probe.until(HTTP_DONE, within).catch(() => undefined);
          } else {
            // an HTTP client writes `closed` when its pool closes an idle connection by itself, and
            // a program with its own detector writes `drop` when it drops the connection
            await probe.until(["error", "eof", "deadline", "drop", ...(http ? ["closed"] : [])], within).catch(() => undefined);
          }
        } else {
          await sleep(valueIn(prediction.window, "s") * 1_000);
        }
      } finally {
        await lift();
        if (toxicFirst) await lab.toxic(null);
      }
      // a thawed target answers the request that it held: the client sees the late reply. An idle
      // client sent no request
      if (cell.fault === "freeze-process" && !server && cell.probe.mode !== "idle")
        await probe.until(["data"], 5_000).catch(() => undefined);
      // the client tries its new connections after the fault lifted: one `dial` line for each try.
      // A measurement-only cell can give the waits too: the end of its connection has no band
      const expected = cell.prediction.detects !== false ? cell.prediction.reconnects : undefined;
      if (expected !== undefined) {
        const waits = expected.waits.reduce((sum, wait) => sum + valueIn(wait.high, "s"), 0);
        await dials(probe, 1 + expected.waits.length, waits * 2_000 + 5_000);
      }
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
    ...(cell.fault === "stall" || thawing !== null ? { heal } : {}),
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.netns.target,
    lost,
    ...placed,
    ...(lab.topology === null ? {} : { middlebox: lab.middlebox.slice(middleboxFrom) }),
    ...(cell.target.lines === true ? { server: lab.server.slice(serverFrom) } : {}),
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
  if (cell.group !== undefined) return inGroupEnvironment(cell, environment, count, say);
  if (cell.replicaSet !== undefined) return inReplicaSetEnvironment(cell, environment, count, say);
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
      if (isHopPlace(cell.faultAt)) await lab.offload(false, cell.faultAt);
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
 * This function does the part of the runs of a group cell in one environment. The warm-up is a
 * whole run with its fault, because no fault of a group ends its environment. A server that a
 * fin stopped starts again, and the group converges before each run.
 */
const inGroupEnvironment = async (
  cell: Cell,
  environment: number,
  count: number,
  say: (line: string) => void,
): Promise<{ manifest: Manifest; runs: Run[]; warmup: Run }> => {
  const lab = await openGroupLab(cell.group!, { watchSentinels: cell.calibrates === "sentinels" });
  try {
    const manifest = await lab.manifest(await lab.sysctl(cell.sysctls));
    const warmed = await groupOnce(lab, cell, environment, -1);
    const warmup: Run = { ...warmed, warmup: true };
    say(line(cell, warmup, measure(cell, warmup)));
    const runs: Run[] = [];
    for (let index = 0; index < count; index += 1) {
      const run = await groupOnce(lab, cell, environment, index);
      runs.push(run);
      say(line(cell, run, measure(cell, run)));
    }
    return { manifest, runs, warmup };
  } finally {
    await lab.close();
  }
};

/**
 * This function does the part of the runs of a replica set cell in one environment. The warm-up
 * is a whole run with its fault, as for a group under Sentinels. The set converges before each run.
 */
const inReplicaSetEnvironment = async (
  cell: Cell,
  environment: number,
  count: number,
  say: (line: string) => void,
): Promise<{ manifest: Manifest; runs: Run[]; warmup: Run }> => {
  const lab = await openReplicaSetLab(cell.replicaSet!);
  try {
    const manifest = await lab.manifest(await lab.sysctl(cell.sysctls));
    const warmed = await replicaSetOnce(lab, cell, environment, -1);
    const warmup: Run = { ...warmed, warmup: true };
    say(line(cell, warmup, measure(cell, warmup)));
    const runs: Run[] = [];
    for (let index = 0; index < count; index += 1) {
      const run = await replicaSetOnce(lab, cell, environment, index);
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
        // each run carries the HZ of its environment, which the rule of a late timer reads
        const hz = each.manifest.hz === null ? undefined : Number(each.manifest.hz);
        const withHz = (run: Run): Run => (hz === undefined ? run : { ...run, hz });
        runs.push(...each.runs.map(withHz));
        warmups.push(withHz(each.warmup));
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
