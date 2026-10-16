import type { KnobValues, Manifestation } from "@mark1russell7/algebra";
import { timerOf, transitionOn } from "@mark1russell7/algebra";
import { valueIn } from "@mark1russell7/quantity";
import { LINUX, RTT_MS, given, predict, seconds } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { MongoBand, MongoPrediction, MongoReference, MongoSpec } from "./cells.ts";
import { sec } from "./cells.ts";
import type { First, Span } from "./model.ts";
import { MONGOD_SESSION, driverSpan, driverValues, firstOn, interrupts, linuxValues, plus, replTimes, secondsOf, sessionValues, span, spanOf } from "./model.ts";

/**
 * This module predicts a cell of the driver against a replica set of one member: T01 and T03.
 * The driver's document goes over Linux TCP on each socket: the monitor's, and the pool's. The
 * first detection on the monitor socket writes the server off, or ends its stream. The pool then
 * interrupts the operation in flight, or the operation waits for its own socket. Its retry selects
 * again, and with one member there is no other server: the selection times out while the fault
 * holds.
 */

export const MONITOR_RX: MongoReference = { socket: "monitor", event: "last-received" };
export const MONITOR_PEER: MongoReference = { socket: "monitor", event: "peer-closed" };
export const POOL_RX: MongoReference = { socket: "pool", event: "last-received" };
export const POOL_SENT: MongoReference = { socket: "pool", event: "request-sent" };
export const POOL_RETX: MongoReference = { socket: "pool", event: "first-retransmission" };
export const FAULT: MongoReference = { event: "fault" };
export const START: MongoReference = { event: "start" };

/** These are the events that a silent cell names, so that a run can find one in its window. */
export const WRITE_OFF = "the monitor writes the server off";
export const SOCKET_END = "the kernel ends a socket of the driver";
export const OP_ERROR = "an operation fails to the application";

/** This function gives a band from a span in seconds. */
export const bandOf = (what: string, name: string, from: MongoReference, s: Span, labels?: readonly string[]): MongoBand => ({
  what,
  name,
  ...(labels === undefined ? {} : { labels }),
  from,
  low: sec(s.lo),
  high: sec(s.hi),
});

/**
 * This function gives the manifestation of a fault to the kernel of the client, and what reaches
 * the monitor. `replies` is the count of replies of the monitor's stream that still reach the
 * driver after the fault.
 */
const faultAt = (spec: MongoSpec): { manifestation: Manifestation; monitor: Manifestation; passes: readonly string[]; replies: number } => {
  if (spec.fault === "freeze-process") return { manifestation: MANIFESTATIONS["freeze-process"], monitor: MANIFESTATIONS["freeze-process"], passes: [], replies: 0 };
  if (spec.fault === "unreachable" || (spec.fault === "simplex" && spec.drops === "to-server")) {
    // The client's ACKs do not reach the server, and each ICMP is a soft error on the monitor's
    // socket (Linux v6.6 tcp_ipv4.c:628-633). The server's RTO fires before its next reply, and
    // its window of one segment holds that reply behind the one without an ACK (tcp_input.c:2154-2176,
    // tcp_output.c:2044-2064). Thus one reply reaches the driver, then only its retransmissions.
    const name = spec.fault === "unreachable" ? `unreachable-${spec.icmp ?? "host"}` : "simplex-to-server";
    return { manifestation: MANIFESTATIONS[name as keyof typeof MANIFESTATIONS], monitor: { name, passes: ["rx.ack"] }, passes: [], replies: 1 };
  }
  if (spec.fault === "fin") return { manifestation: MANIFESTATIONS.fin, monitor: MANIFESTATIONS.fin, passes: [], replies: 0 };
  return { manifestation: MANIFESTATIONS.blackhole, monitor: MANIFESTATIONS.blackhole, passes: [], replies: 0 };
};

/**
 * This function gives when the replies of the monitor's stream that still come end, from the
 * monitor's last segment with data before the fault. That segment is its awaitable request or a
 * reply. `mongod` sends each reply `heartbeatFrequencyMS` after it (the `hello_await` of mongod's
 * session document). The harness commits the fault 250 ms after the client's `ready` line, thus the
 * client acknowledged each earlier reply before the fault.
 */
const repliesAfter = (replies: number, heartbeatFrequencyMS: number, rtt: number): Span => {
  if (replies === 0) return span(0, 0);
  const values = given({ ...sessionValues(), maxAwaitTimeMS: { value: heartbeatFrequencyMS, unit: "ms" } });
  const wait = spanOf(MONGOD_SESSION, "hello_await", values);
  return span(replies * wait.lo, replies * (wait.hi + rtt));
};

/** This function gives the interruption of the operation in flight after the first detection on the monitor socket. Its span counts from that socket's last segment. */
const interruptionAfter = (first: First, spec: MongoSpec, driver: KnobValues): Span | null => {
  if (first.kind !== "timer") return null;
  const slack = driverSpan("interrupt", driver);
  if (first.layer === "driver") return interrupts("written-off") ? plus(first.band, slack) : null;
  // the kernel ends the stream: the monitor resets, checks again after heartbeatFrequencyMS, and
  // its connect meets the fault. A silent server makes the connect, or its handshake, time out
  if (spec.fault === "fin" || spec.fault === "rst") return null;
  const check = driverSpan("check_period", driver);
  const timeout = spec.fault === "freeze-process" ? driverSpan("handshake_timeout", driver) : driverSpan("connect_timeout", driver);
  const transition = spec.fault === "freeze-process" ? "handshake-timed-out" : "connect-timed-out";
  if (!interrupts(transition)) return null;
  return plus(plus(plus(first.band, check), timeout), slack);
};

/**
 * This function gives the prediction of a cell of the driver against one member, at a round trip in
 * ms. The bands count from their own references. The first band is the band of the cell.
 */
export const predictSingle = (spec: MongoSpec, rttMs = RTT_MS): MongoPrediction => {
  if (spec.why !== undefined) return { detects: null, bands: [], window: sec(120), quiet: [], why: spec.why };
  const rtt = rttMs / 1000;
  const values = driverValues(spec.options, rttMs);
  const driver = given(values);
  const linux = given(linuxValues(spec.linux, rttMs));
  const selection = driverSpan("selection_timeout", driver);
  const slack = secondsOf(values, "slack");
  const work = replTimes({}, rttMs).work;
  const h = secondsOf(values, "heartbeatFrequencyMS");

  // a fault that holds before the client starts: its first selection meets it
  if (spec.before === true) {
    const connect = driverSpan("connect_timeout", driver);
    if (spec.fault === "rst" || connect.lo > selection.hi)
      return {
        detects: true,
        bands: [bandOf("the first selection times out", "MongoServerSelectionError", START, selection)],
        window: sec(selection.hi + 5),
        quiet: [],
      };
    if (!(connect.hi < selection.lo)) throw new Error(`${spec.name}: the connect and the selection can time out in either order`);
    return {
      detects: true,
      bands: [
        bandOf("the first selection times out, after the monitor's connect", "MongoServerSelectionError", START, selection),
        bandOf("the monitor's first connect times out", "MongoNetworkTimeoutError", START, connect),
      ],
      window: sec(selection.hi + 5),
      quiet: [],
    };
  }

  // a stall: the kernel's retransmissions carry the request through, as for the TCP client
  if (spec.fault === "stall") {
    const stall = predict({ name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall!, linux: spec.linux ?? {} });
    if (stall.detects !== false || stall.recovers === undefined) throw new Error(`${spec.name}: Linux TCP gives no recovery`);
    const reply = span(valueIn(stall.recovers.low, "s"), valueIn(stall.recovers.high, "s"));
    if (!(reply.hi < h)) throw new Error(`${spec.name}: the stall is near the monitor's write-off`);
    return {
      detects: false,
      bands: [bandOf("the reply comes after the stall", "OK", POOL_SENT, reply)],
      window: sec(valueIn(stall.window, "s")),
      quiet: [WRITE_OFF, OP_ERROR],
      ...(stall.rtt === undefined ? {} : { rtt: stall.rtt }),
    };
  }

  // no fault: the monitor and the keepalive of each socket keep the connections
  if (spec.fault === "none")
    return { detects: false, bands: [], window: sec(spec.hold ?? 200), quiet: [WRITE_OFF, SOCKET_END, OP_ERROR] };

  // an MTU black hole drops each long segment: the replies of the monitor are short and pass, the
  // long reply of the read does not. The client has no data in flight, and each keepalive probe
  // gets its short answer. Nothing of the driver ends the read: socketTimeoutMS is 0
  if (spec.fault === "mtu-blackhole") {
    const short: Manifestation = { name: "mtu-blackhole", passes: ["rx.ack"] };
    const quietMonitor = firstOn({ role: "monitor", inFlight: false, manifestation: short, passes: ["rx.hello"] }, driver, linux);
    const quietPool = firstOn({ role: "pool", inFlight: false, manifestation: short }, driver, linux);
    if (quietMonitor.kind !== "silent" || quietPool.kind !== "silent") throw new Error(`${spec.name}: a detector can end the long read`);
    return { detects: false, bands: [], window: sec(spec.hold ?? 60), quiet: [WRITE_OFF, SOCKET_END, OP_ERROR] };
  }

  const { manifestation, monitor, passes, replies } = faultAt(spec);
  // the replies of the stream that still come move the monitor's last data after the fault
  const after = repliesAfter(replies, h * 1000, rtt);

  // a reset answers the request at once
  if (spec.fault === "rst") {
    const errno = transitionOn(LINUX, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET";
    const reset = span(0, rtt);
    return {
      detects: true,
      bands: [
        bandOf("the request meets a reset", errno, POOL_SENT, reset, ["RetryableWriteError"]),
        bandOf("the retry's selection times out", "MongoServerSelectionError", POOL_SENT, plus(plus(reset, span(0, slack)), selection)),
      ],
      window: sec(selection.hi + 5),
      quiet: [],
    };
  }

  const onMonitor = firstOn({ role: "monitor", inFlight: false, manifestation: monitor, passes }, driver, linux);

  // the process of the server ends: its kernel closes each socket with a FIN
  if (onMonitor.kind === "delivered") {
    return {
      detects: true,
      bands: [bandOf("the monitor's stream ends", onMonitor.name, MONITOR_PEER, span(0, rtt + slack))],
      window: sec(10),
      quiet: [],
    };
  }

  const onPool = firstOn({ role: "pool", inFlight: spec.mode !== "idle", manifestation }, driver, linux);

  if (spec.mode === "idle") {
    const bands: MongoBand[] = [];
    if (onPool.kind === "timer") bands.push(bandOf(`the ${onPool.layer} ends the idle pool socket: ${onPool.timer}`, onPool.name, POOL_RX, onPool.band));
    if (onMonitor.kind === "timer") bands.push(bandOf(`${WRITE_OFF}: ${onMonitor.timer}`, onMonitor.name, MONITOR_RX, plus(after, onMonitor.band)));
    const quiet = onMonitor.kind === "silent" ? [WRITE_OFF] : [];
    if (bands.length === 0) return { detects: false, bands, window: sec(spec.hold ?? 200), quiet: [WRITE_OFF, SOCKET_END] };
    return { detects: true, bands, window: sec(Math.max(...bands.map((b) => valueIn(b.high, "s"))) + 5), quiet };
  }

  // an operation in flight: the monitor interrupts it, or its own socket ends first. Each is set on
  // the clock of the fault: the monitor's last reply came up to one heartbeat before the fault, and
  // the request goes into the fault, its first retransmission two RTOs later
  const rto = seconds(timerOf(LINUX, "retransmit", linux, 0).duration, "the RTO");
  const fromLast = interruptionAfter(onMonitor, spec, driver);
  const interrupt = fromLast === null ? null : plus(after, fromLast);
  const monitorOnFault = interrupt === null ? null : plus(span(-h, 0), interrupt);
  const poolOffset = onPool.kind === "timer" && onPool.timer === "retrans_giveup" ? span(0, 2 * rto + 0.01) : span(0, 0.01);
  const poolOnFault = onPool.kind === "timer" ? plus(poolOffset, onPool.band) : null;

  const hold = spec.hold;
  const bands: MongoBand[] = [];
  let failed: { at: Span; from: MongoReference } | null = null;
  if (monitorOnFault !== null && (poolOnFault === null || monitorOnFault.hi < poolOnFault.lo)) {
    // the monitor writes the server off first, and the pool interrupts the operation
    if (onMonitor.kind !== "timer" || interrupt === null) throw new Error("unreachable");
    if (hold !== undefined && hold < monitorOnFault.lo) {
      // the fault lifts before the write-off: the operation gets its reply
      const reply = span(hold, hold + rtt + work + slack);
      return { detects: false, bands: [bandOf("the reply comes when the fault lifts", "OK", FAULT, reply)], window: sec(hold + 10), quiet: [WRITE_OFF, OP_ERROR] };
    }
    if (hold !== undefined && !(hold > monitorOnFault.hi)) throw new Error(`${spec.name}: the fault can lift before or after the write-off`);
    bands.push(bandOf(`${WRITE_OFF}: ${onMonitor.timer}`, onMonitor.name, MONITOR_RX, plus(after, onMonitor.band)));
    bands.push(bandOf("the pool interrupts the operation in flight", "PoolClearedOnNetworkError", MONITOR_RX, interrupt, ["PoolRequestedRetry"]));
    failed = { at: interrupt, from: MONITOR_RX };
  } else if (poolOnFault !== null && (monitorOnFault === null || poolOnFault.hi < monitorOnFault.lo)) {
    if (onPool.kind !== "timer") throw new Error("unreachable");
    bands.push(bandOf(`the kernel ends the request's socket: ${onPool.timer}`, onPool.name, onPool.timer === "retrans_giveup" ? POOL_RETX : POOL_SENT, onPool.band, ["RetryableWriteError"]));
    failed = { at: onPool.band, from: onPool.timer === "retrans_giveup" ? POOL_RETX : POOL_SENT };
  } else if (monitorOnFault === null && poolOnFault === null) {
    return { detects: false, bands: [], window: sec(hold ?? 60), quiet: [WRITE_OFF, OP_ERROR] };
  } else throw new Error(`${spec.name}: the monitor and the request's socket can end it in either order`);

  // the retry selects again: the one member is Unknown, until the fault lifts
  const deadline = plus(plus(failed.at, span(0, slack)), selection);
  const deadlineOnFault = failed.from === MONITOR_RX ? plus(span(-h, 0), deadline) : plus(poolOffset, deadline);
  if (hold !== undefined && hold < deadlineOnFault.lo) {
    const lands = span(hold + 3 * rtt, hold + 4 * rtt + work + 3 * slack);
    bands.push(bandOf("the retry lands when the fault lifts", "OK", FAULT, lands));
    return { detects: true, bands, window: sec(hold + 10), quiet: [OP_ERROR] };
  }
  if (hold !== undefined && !(hold > deadlineOnFault.hi)) throw new Error(`${spec.name}: the fault can lift before or after the retry's selection times out`);
  bands.push(bandOf("the retry's selection times out", "MongoServerSelectionError", failed.from, deadline));
  return { detects: true, bands, window: sec(Math.max(...bands.map((b) => valueIn(b.high, "s"))) + 5), quiet: [] };
};

/**
 * This function gives a prediction with the range of round trips that it assumes. The bands of
 * the driver read few round trips: the prediction holds from 0 to `SINGLE_RTT_MS`. Its low edges
 * are the bands at 0, and its high edges the bands at `SINGLE_RTT_MS`. A stall reads the RTO of
 * the kernel, which the TCP client's catalog gives with its own range.
 */
export const SINGLE_RTT_MS = 2;

export const assumingSingle = (spec: MongoSpec, at: (spec: MongoSpec, rttMs: number) => MongoPrediction = predictSingle): MongoPrediction => {
  const nominal = at(spec, RTT_MS);
  if (nominal.detects === null || nominal.rtt !== undefined) return nominal;
  const low = at(spec, 0);
  const high = at(spec, SINGLE_RTT_MS);
  if (low.bands.length !== high.bands.length || low.detects !== high.detects) throw new Error(`${spec.name}: the outcome changes over the range of round trips`);
  return {
    ...high,
    bands: high.bands.map((band, index) => ({ ...band, low: low.bands[index]!.low })),
    rtt: { low: { value: 0, unit: "ms" }, high: { value: SINGLE_RTT_MS, unit: "ms" } },
  };
};
