import type { Detector, KnobValues, Machine, Manifestation } from "@mark1russell7/algebra";
import { detection, errnoOf, evaluate, overValues, timerOf, timerUnder, transitionOn } from "@mark1russell7/algebra";
import { LINUX_TCP, MONGOD_REPL, MONGOD_SESSION, MONGODB_NODE } from "@mark1russell7/machines";
import type { Extent, Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { HZ, LINUX_66, RTT_MS, given, ms, seconds } from "../catalog.ts";

/**
 * This module composes the machine documents of MongoDB. The driver's document goes over the
 * document of Linux TCP for each socket of the driver. The document of mongod's replication gives
 * the timeline of a replica set after a fault. The driver's document gives what the client does
 * in it. Each time is in seconds, as a span: its earliest and its latest.
 */

/** A span is an interval of time in seconds: the earliest and the latest. */
export interface Span {
  readonly lo: number;
  readonly hi: number;
}
export const span = (lo: number, hi: number): Span => ({ lo, hi });
export const at = (value: number): Span => span(value, value);
export const plus = (a: Span, b: Span): Span => span(a.lo + b.lo, a.hi + b.hi);
/** This function gives the span of the later of two events: the later of the two earliest, to the later of the two latest. */
export const later = (a: Span, b: Span): Span => span(Math.max(a.lo, b.lo), Math.max(a.hi, b.hi));
/** This function gives the span of the earlier of two events. */
export const earlier = (a: Span, b: Span): Span => span(Math.min(a.lo, b.lo), Math.min(a.hi, b.hi));
/** This function gives the smallest span that holds two spans. */
export const hull = (a: Span, b: Span): Span => span(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi));

// ---------------------------------------------------------------------------------------------
// the values of the knobs of each document
// ---------------------------------------------------------------------------------------------

/** These knobs of the driver have no timer at 0, thus a value of 0 is no bound. */
const NONE_AT_ZERO = new Set(["connectTimeoutMS", "socketTimeoutMS", "waitQueueTimeoutMS", "maxIdleTimeMS", "serverSelectionTimeoutMS"]);

/** This function gives the defaults of the knobs of a document that have a default and a unit. */
export const defaultsOf = (doc: Machine): Record<string, Extent> => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(doc.knobs))
    if (knob.default !== null && knob.unit !== null) out[name] = { value: knob.default, unit: knob.unit };
  return out;
};

/** This function gives an amount in the unit of a knob of a document. */
const inUnit = (doc: Machine, name: string, value: number): Extent => {
  const unit = doc.knobs[name]?.unit;
  if (unit === undefined || unit === null) throw new Error(`${doc.id} has no amount ${name}`);
  return { value, unit };
};

/** These are options of the driver, by the names of its connection string, in the unit of each knob. */
export type DriverOptions = Readonly<Record<string, number>>;

/** This function gives the values of the driver's knobs: the defaults of 7.7.0, then the options, at a round trip in ms. */
export const driverValues = (options: DriverOptions = {}, rttMs = RTT_MS): Record<string, Extent> => {
  const out = defaultsOf(MONGODB_NODE);
  for (const [name, value] of Object.entries(options)) out[name] = inUnit(MONGODB_NODE, name, value);
  for (const name of NONE_AT_ZERO) if (out[name]?.value === 0) out[name] = { value: "infinite", unit: "ms" };
  out["hz"] = { value: HZ, unit: "Hz" };
  out["rtt"] = ms(rttMs);
  return out;
};

/** These are the settings of a replica set, by the names of mongod, in the unit of each knob. */
export type ReplSettings = Readonly<Record<string, number>>;

/**
 * This function gives the values of mongod's replication: the defaults of 9.0.4, then the settings.
 * A catch-up timeout of -1 is no bound. The receive timeout of the oplog fetcher comes from the
 * expression of its timer, because the timer wheel reads it as a knob.
 */
export const replValues = (settings: ReplSettings = {}, rttMs = RTT_MS): Record<string, Extent> => {
  const out = defaultsOf(MONGOD_REPL);
  out["catchUpTimeoutMillis"] = { value: "infinite", unit: "ms" };
  for (const [name, value] of Object.entries(settings))
    out[name] = name === "catchUpTimeoutMillis" && value === -1 ? { value: "infinite", unit: "ms" } : inUnit(MONGOD_REPL, name, value);
  out["rtt"] = ms(rttMs);
  out["hz"] = { value: HZ, unit: "Hz" };
  const read = evaluate(MONGOD_REPL, MONGOD_REPL.timers["oplog_read"]!.duration, given(out));
  if ("unknown" in read) throw new Error(`the oplog read timeout: ${read.unknown}`);
  out["oplog_read_timeout"] = read;
  return out;
};

/** This function gives the values of the session document of mongod: the sysctls of its namespace, as Linux 6.6 sets them, then the overrides. */
export const sessionValues = (sysctls: Readonly<Record<string, number>> = {}): Record<string, Extent> => {
  const out = defaultsOf(MONGOD_SESSION);
  for (const [name, value] of Object.entries(sysctls)) out[name] = inUnit(MONGOD_SESSION, name, value);
  out["hz"] = { value: HZ, unit: "Hz" };
  return out;
};

/** This function gives the values of Linux TCP at the client: Linux 6.6, then the overrides, at a round trip in ms. */
export const linuxValues = (overrides: Readonly<Record<string, Extent>> = {}, rttMs = RTT_MS): Record<string, Extent> => ({
  ...LINUX_66,
  ...overrides,
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(rttMs),
});

/** This function gives the span of a timer of a document: its duration less its early bound, to its duration plus its lateness. */
export const spanOf = (doc: Machine, timer: string, values: KnobValues, fired?: number): Span => {
  const bounds = timerOf(doc, timer, values, fired);
  const duration = seconds(bounds.duration, timer);
  return span(duration - seconds(bounds.early, `${timer}'s early bound`), duration + seconds(bounds.lateness, `${timer}'s lateness`));
};

/** This function gives the value of one knob in seconds. */
export const secondsOf = (values: Readonly<Record<string, Extent>>, name: string): number => {
  const value = values[name];
  if (value === undefined) throw new Error(`no value for ${name}`);
  if (value.value === "infinite") return Number.POSITIVE_INFINITY;
  return valueIn(value as Quantity, "s");
};

// ---------------------------------------------------------------------------------------------
// one socket of the driver, over Linux TCP
// ---------------------------------------------------------------------------------------------

/** A role is what a socket of the driver does: the monitor of the server, or a connection of the pool. */
export type Role = "monitor" | "pool";

/** A socket case is one socket of the driver under a fault: its role, its data in flight, and what the fault lets through. */
export interface SocketCase {
  readonly role: Role;
  readonly inFlight: boolean;
  /** This manifestation is what the fault lets back to the kernel of the client. */
  readonly manifestation: Manifestation;
  /** These are the events of the driver that the fault lets through: `rx.hello` when the replies of the server still arrive. */
  readonly passes?: readonly string[];
}

/**
 * A first detection is the detector of a socket that fires first. It is a timer of the driver or
 * of the kernel, or an event that the fault delivers. Its span counts from the reference of the
 * socket: its last received segment, its first retransmission, or the close of its peer.
 */
export type First =
  | { readonly kind: "timer"; readonly timer: string; readonly layer: "driver" | "kernel"; readonly name: string; readonly band: Span }
  | { readonly kind: "delivered"; readonly event: string; readonly name: string }
  | { readonly kind: "silent"; readonly held: readonly string[] };

/** This function gives the state of the driver's document for a socket case. */
const stateOf = (c: SocketCase): string => (c.role === "monitor" ? "streaming" : c.inFlight ? "in-use" : "pooled");

const finite = (d: Detector): boolean => !("unknown" in d.duration) && d.duration.value !== "infinite";

/**
 * This function gives the first detection of one socket of the driver. It composes the driver's
 * document over Linux TCP, as `stackedDetection` of the algebra does. The driver's timers see the
 * events that the fault lets through to the driver, and the kernel's timers use the keepalive that
 * the driver sets.
 */
export const firstOn = (c: SocketCase, driver: KnobValues, linux: KnobValues): First => {
  const state = stateOf(c);
  const own = detection(MONGODB_NODE, { state, inFlight: c.inFlight }, { name: c.manifestation.name, passes: [...(c.passes ?? [])] }, driver);
  const lower = overValues(MONGODB_NODE, driver, linux);
  const below = detection(LINUX_TCP, { state: "ESTABLISHED", inFlight: c.inFlight }, c.manifestation, lower);
  const [delivered] = below.delivered;
  if (delivered !== undefined) return { kind: "delivered", event: delivered.event, name: delivered.errno ?? "EOF" };
  const all = [
    ...own.detectors.filter(finite).map((d) => ({ d, layer: "driver" as const })),
    ...below.detectors.filter(finite).map((d) => ({ d, layer: "kernel" as const })),
  ].map((each) => {
    const bounds = each.layer === "driver" ? timerOf(MONGODB_NODE, each.d.timer, driver) : timerUnder(LINUX_TCP, each.d.timer, lower, c.manifestation);
    const duration = seconds(bounds.duration, each.d.timer);
    return {
      ...each,
      band: span(duration - seconds(bounds.early, "early"), duration + seconds(bounds.lateness, "lateness")),
    };
  });
  all.sort((a, b) => a.band.lo - b.band.lo);
  const [winner, next] = all;
  if (winner === undefined) return { kind: "silent", held: [...own.held, ...below.held].map((h) => `${h.timer}: ${h.why}`) };
  if (next !== undefined && next.band.lo <= winner.band.hi)
    throw new Error(`${winner.d.timer} and ${next.d.timer} can both fire first on the ${c.role} socket`);
  const name =
    winner.layer === "driver"
      ? (transitionOn(MONGODB_NODE, state, winner.d.fires)?.errno ?? winner.d.fires)
      : (errnoOf(LINUX_TCP, "ESTABLISHED", winner.d, c.manifestation) ?? "ETIMEDOUT");
  return { kind: "timer", timer: winner.d.timer, layer: winner.layer, name, band: winner.band };
};

/** This function gives the span of a timer of the driver's document, at its values. */
export const driverSpan = (timer: string, driver: KnobValues): Span => spanOf(MONGODB_NODE, timer, driver);

/** This function tells if a transition of the driver's document interrupts the operations in flight: it emits `local.interrupt`. */
export const interrupts = (transition: string): boolean =>
  MONGODB_NODE.transitions.find((t) => t.id === transition)?.emits?.includes("local.interrupt") === true;

// ---------------------------------------------------------------------------------------------
// the replica set after a fault: the timeline of mongod, then the client
// ---------------------------------------------------------------------------------------------

/** This time is the pause of the stream of writes after each reply: 50 ms, as the group cells of the harness use. */
export const INTERVAL = 0.05;

/** These are the times of the replica set that a timeline reads, in seconds, from mongod's document at its values. */
export interface ReplTimes {
  readonly heartbeat: number;
  readonly fast: number;
  readonly window: number;
  readonly election: Span;
  readonly liveness: Span;
  readonly catchup: number;
  readonly stepDownWait: number;
  readonly slack: number;
  readonly work: number;
  /** This span is the receive timeout of the exhaust read of an oplog fetcher, on the timer wheel. */
  readonly oplogRead: Span;
  /** This span is the restart of the fetcher: its sleep, then the timeout of its new cursor on the same source. */
  readonly refind: Span;
  /** This time is the network timeout of a replSetUpdatePosition. */
  readonly feedbackTimeout: number;
  /** This time is the keepalive of a reporter with no news. */
  readonly feedbackKeepalive: number;
}

/** This function gives the times of mongod's replication at its settings. */
export const replTimes = (settings: ReplSettings = {}, rttMs = RTT_MS): ReplTimes => {
  const values = replValues(settings, rttMs);
  const known = given(values);
  const slack = secondsOf(values, "executor_slack");
  return {
    heartbeat: seconds(timerOf(MONGOD_REPL, "heartbeat", known).duration, "heartbeat"),
    fast: seconds(timerOf(MONGOD_REPL, "heartbeat_fast", known).duration, "heartbeat_fast"),
    window: seconds(timerOf(MONGOD_REPL, "heartbeat_window", known).duration, "heartbeat_window"),
    election: spanOf(MONGOD_REPL, "election", known),
    liveness: spanOf(MONGOD_REPL, "liveness", known),
    catchup: secondsOf(values, "catchUpTimeoutMillis"),
    stepDownWait: seconds(timerOf(MONGOD_REPL, "step_down_wait", known).duration, "step_down_wait"),
    slack,
    work: secondsOf(values, "election_work"),
    oplogRead: spanOf(MONGOD_REPL, "oplog_read", known),
    refind: plus(spanOf(MONGOD_REPL, "oplog_restart", known), spanOf(MONGOD_REPL, "oplog_refind", known)),
    feedbackTimeout: seconds(timerOf(MONGOD_REPL, "feedback_update", known).duration, "feedback_update"),
    feedbackKeepalive: seconds(timerOf(MONGOD_REPL, "feedback_keepalive", known).duration, "feedback_keepalive"),
  };
};

/** These are the times of the driver that a timeline reads, in seconds. */
export interface DriverTimes {
  readonly writeOff: Span;
  readonly selection: Span;
  readonly slack: number;
}

/** This function gives the times of the driver at its options. */
export const driverTimes = (options: DriverOptions = {}, rttMs = RTT_MS): DriverTimes => {
  const values = driverValues(options, rttMs);
  const known = given(values);
  return {
    writeOff: driverSpan("stream_timeout", known),
    selection: driverSpan("selection_timeout", known),
    slack: secondsOf(values, "slack"),
  };
};

/**
 * A timeline is the stages of a replica set after a fault, each a span from the fault. A stage
 * that does not occur is null.
 * - `down`: the first member that marks the primary DOWN.
 * - `start`: the first election that a secondary starts, and `elected` its win.
 * - `caughtUp`: the end of the catch-up of the new primary, and `writable`: its first write.
 * - `steppedDown`: the old primary steps down while it is cut from the group.
 * - `discovered`: the client learns of the new primary.
 * - `writtenOff`: the client's monitor writes the old primary off.
 * - `first`: the first write that a primary accepts after the fault.
 */
export interface Timeline {
  readonly down: Span | null;
  readonly start: Span | null;
  readonly elected: Span | null;
  readonly caughtUp: Span | null;
  /** These are the parts of `caughtUp` that can occur, when there is more than one. */
  readonly modes: readonly Span[];
  readonly writable: Span | null;
  readonly steppedDown: Span | null;
  readonly discovered: Span | null;
  readonly writtenOff: Span | null;
  readonly first: Span | null;
  /** These are the parts of `first` that can occur, when there is more than one (`landingOf`). */
  readonly firstModes: readonly Span[];
  readonly lands: "new" | "same";
  /** This span is when the client's write fails to the application, when it does. */
  readonly fails: Span | null;
}

/**
 * This function gives the longest gap between two writes at a secondary. The gap is the pause of
 * the stream, a round trip to the primary and one for the replication. It is also the local work
 * and a step of the client.
 */
const gapOf = (rtt: number, repl: ReplTimes, driver: DriverTimes): number => INTERVAL + 2 * rtt + repl.work + driver.slack;

/** This function gives the write of the client on a new connection to a primary: the connect, the hello, and the write with its majority. */
const writeOnNew = (rtt: number, repl: ReplTimes, driver: DriverTimes): Span => span(3 * rtt, 4 * rtt + repl.work + 2 * driver.slack);

/** This function gives the next write of the stream after a reply: the pause, then the write on the same connection with its majority. */
const nextWrite = (reply: Span, rtt: number, repl: ReplTimes, driver: DriverTimes): Span =>
  plus(reply, span(INTERVAL + rtt, INTERVAL + 2 * rtt + repl.work + 3 * driver.slack));

/**
 * A sync is how the other secondary sends its position to a new primary, when it syncs from the old
 * primary (`direct`). The other mode is `chained`: it syncs from the new primary already, and its
 * reporter sends each new position at once.
 * - `takes`: the other secondary takes the new primary as its sync source.
 * - `released`: its reporter ends its replSetUpdatePosition to the old primary. Until then, no
 *   position goes to the new primary, which learns it from the response to each heartbeat.
 */
export interface Sync {
  readonly takes: Span;
  readonly released: Span;
}

/**
 * This function gives the sync of a secondary whose sync source goes silent at 0, from the other
 * members. The old primary answers again at `back`: a thaw, or the end of a cut.
 * - Its oplog fetcher reads the last batch at `contact`. The read times out on the wheel, and its
 *   one new cursor times out too: then the member clears its sync source (`drops`).
 * - It takes the new primary at once when the new primary wrote before the drop: the loss of a
 *   source starts each heartbeat again (replication_coordinator_impl.cpp:4947-4972). Otherwise it
 *   takes it at a heartbeat after the first write of the term, each 500 ms without a source.
 * - Its reporter sent its last replSetUpdatePosition at the last batch, or at the keepalive after
 *   it. That command ends at the network timeout, or at the answer of the old primary when it is back.
 */
export const syncOf = (repl: ReplTimes, driver: DriverTimes, rtt: number, writable: Span, back: number | null = null): Sync => {
  const gap = gapOf(rtt, repl, driver);
  const contact = span(-gap, rtt);
  let drops = plus(plus(contact, repl.oplogRead), repl.refind);
  // a source that is back answers the new cursor, and its step-down on the newer term ends the fetch
  if (back !== null) drops = span(Math.min(drops.lo, back), Math.min(drops.hi, back + 2 * rtt + repl.work + 2 * repl.slack));
  const takes =
    writable.hi < drops.lo
      ? plus(drops, span(0, rtt + repl.slack))
      : span(Math.max(drops.lo, writable.lo), Math.max(drops.hi, writable.hi) + repl.fast + rtt + repl.slack);
  let released = span(contact.lo + repl.feedbackTimeout, repl.feedbackKeepalive + repl.slack + repl.feedbackTimeout + repl.slack);
  if (back !== null) released = span(Math.min(released.lo, back), Math.min(released.hi, back + rtt + repl.slack));
  return { takes, released };
};

/**
 * This function gives the sync after replSetStepDown. The step-up of the new primary ends the
 * cursor of a secondary on it. The new primary is not ahead of that secondary until its next write.
 * The secondary then takes it at a heartbeat, each 500 ms without a source
 * (topology_coordinator.cpp:1124-1136). No command to the old primary waits.
 */
export const handOffSyncOf = (repl: ReplTimes, rtt: number, writable: Span): Sync => ({
  takes: span(writable.lo, writable.hi + repl.fast + rtt + repl.slack),
  released: at(Number.NEGATIVE_INFINITY),
});

/**
 * This function gives when the first counted write of the client lands on a new primary. The client
 * starts the write on a new connection at `start`. The harness counts the first write that the
 * client sends after the commit of the fault. The write in flight at the commit can go out before
 * it, thus the counted write can be the next one. Each mode is the span of the two:
 * - `chained`: the write lands on its majority in a round trip of the other secondary.
 * - `direct` (with w majority and a `sync`): the other secondary has the write only after it takes
 *   the new primary. The new primary learns that at the next response to its heartbeat. It sends
 *   each heartbeat heartbeatIntervalMillis after the last response (topology_coordinator.cpp:1124-1147),
 *   and a response moves its commit point (replication_coordinator_impl_heartbeat.cpp:367-376).
 */
export const landingOf = (
  start: Span,
  repl: ReplTimes,
  driver: DriverTimes,
  rtt: number,
  sync: Sync | null,
): { readonly first: Span; readonly modes: readonly Span[] } => {
  const chained1 = plus(start, writeOnNew(rtt, repl, driver));
  const chained = span(chained1.lo, nextWrite(chained1, rtt, repl, driver).hi);
  if (sync === null) return { first: chained, modes: [chained] };
  const cycle = repl.heartbeat + rtt + repl.slack;
  // a write that reaches the new primary at `reach` is on the other secondary at `durable`, and its reply comes back after the acknowledgement
  const lands = (reach: Span): Span => {
    const durable = plus(later(reach, sync.takes), span(rtt / 2, rtt + repl.work));
    const acknowledged = span(durable.lo, Math.min(durable.hi + cycle, Math.max(durable.hi, sync.released.hi) + rtt + repl.slack));
    return plus(acknowledged, span(rtt / 2, rtt / 2 + driver.slack));
  };
  const direct1 = lands(plus(start, span(2 * rtt, 3 * rtt + driver.slack)));
  const direct2 = lands(plus(direct1, span(INTERVAL + rtt / 2, INTERVAL + rtt / 2 + driver.slack)));
  const direct = span(direct1.lo, direct2.hi);
  return { first: span(Math.min(chained.lo, direct.lo), Math.max(chained.hi, direct.hi)), modes: [chained, direct] };
};

/**
 * This function gives the election and the catch-up of a new primary. The primary goes silent to
 * the other members at 0, and it stays silent past the catch-up. The silent primary answers again
 * at `back`: a thaw, or the end of a cut. Without `back`, it does not answer.
 * - Each secondary hears the primary last at `contact`: the last write's oplog batch.
 * - Its first heartbeat without an answer starts in (-rtt, heartbeat]. The end of that window marks
 *   the primary DOWN.
 * - The election timeout fires at contact + electionTimeoutMillis + its offset. A dry run and the
 *   real vote take one round trip each, and the durable vote takes the local work.
 * - The catch-up waits for the heartbeat window to the old primary that is open at the win. It
 *   ends at the end of that window, or at the answer when the old primary is back. A win in the
 *   gap after a window opens a new window.
 */
export const electionOf = (repl: ReplTimes, driver: DriverTimes, rtt: number, back: number | null = null) => {
  const gap = gapOf(rtt, repl, driver);
  const contact = span(-gap, rtt);
  // the first heartbeat without an answer, and the end of its window: the primary is DOWN
  const s1 = span(-rtt, repl.heartbeat + repl.slack);
  const down = plus(s1, span(repl.window, repl.window + repl.slack));
  const start = plus(contact, repl.election);
  const elected = plus(start, span(2 * rtt, 2 * rtt + repl.work + 2 * repl.slack));
  // the old primary answers its open heartbeat when it is back
  const answer = back === null ? Number.POSITIVE_INFINITY : back + rtt + repl.slack;
  const capped = (m: Span): Span => span(Math.min(m.lo, answer), Math.min(m.hi, answer));
  // the restarted heartbeat to the other secondary comes back in one round trip
  const other = plus(elected, span(rtt, rtt + repl.slack));
  let modes: Span[] = [];
  if (repl.catchup === 0) modes = [elected];
  else {
    // the win comes before the first window ends: the catch-up ends at that end
    if (elected.lo < down.hi) modes.push(capped(span(Math.max(down.lo, elected.lo), down.hi)));
    // the win comes after it: a new window opens at the win, or at the next heartbeat before the win
    if (elected.hi >= down.lo) {
      const lo = down.lo + repl.window + Math.min(Math.max(elected.lo - down.lo, 0), repl.fast);
      modes.push(capped(span(lo, elected.hi + repl.window + repl.slack)));
    }
    if (Number.isFinite(repl.catchup)) modes = modes.map((m) => span(Math.min(m.lo, elected.lo + repl.catchup), Math.min(m.hi, elected.hi + repl.catchup + repl.slack)));
    modes = modes.map((m) => later(m, other));
  }
  const caughtUp = modes.reduce(hull);
  const writable = plus(caughtUp, span(0, repl.work + repl.slack));
  const discovered = plus(writable, span(0, rtt + driver.slack));
  return { contact, down, start, elected, modes, caughtUp, writable, discovered };
};

/** This function gives when a primary that is cut from the other members steps down: the last update from each, plus the election timeout. */
export const stepDownOf = (repl: ReplTimes, driver: DriverTimes, rtt: number): Span => {
  const gap = gapOf(rtt, repl, driver);
  return plus(span(-gap, rtt), repl.liveness);
};

/** This function gives when the monitor writes off a primary that goes silent at 0. Its last reply came in the heartbeat before. */
export const writeOffOf = (driver: DriverTimes, heartbeatFrequency: number): Span =>
  plus(span(-heartbeatFrequency, 0), driver.writeOff);

/** These are what a fault does to a replica set of three members, at the primary. */
export type GroupCause =
  /** The primary is silent to the members and to the client: a black hole, or a frozen process. */
  | { readonly kind: "silent"; readonly alive: boolean; readonly back: number | null }
  /** The primary is cut from the other members, and the client still reaches it. */
  | { readonly kind: "cut-from-group"; readonly w: "majority" | 1 }
  /** The command replSetStepDown at the primary. */
  | { readonly kind: "step-down" };

/**
 * This function gives the timeline of a fault at the primary, from mongod's document and the
 * driver's, at a round trip in ms.
 */
export const timelineOf = (
  cause: GroupCause,
  settings: ReplSettings,
  options: DriverOptions,
  rttMs: number,
  giveUp: Span | null = null,
): Timeline => {
  const rtt = rttMs / 1000;
  const repl = replTimes(settings, rttMs);
  const driver = driverTimes(options, rttMs);
  const heartbeatFrequency = secondsOf(driverValues(options, rttMs), "heartbeatFrequencyMS");
  const land = (from: Span, sync: Sync | null) => {
    const { first, modes } = landingOf(from, repl, driver, rtt, sync);
    return { first, firstModes: modes.length < 2 ? [] : modes };
  };

  if (cause.kind === "step-down") {
    // the wait for a caught-up secondary: one write's replication. Then the hand-off skips the dry run
    const stepped = span(0, 2 * rtt + repl.work + repl.slack);
    const elected = plus(stepped, span(rtt, 2 * rtt + repl.work + 2 * repl.slack));
    const caughtUp = plus(elected, span(rtt, rtt + repl.slack));
    const writable = plus(caughtUp, span(0, repl.work + repl.slack));
    const discovered = plus(writable, span(0, rtt + driver.slack));
    const landed = land(discovered, handOffSyncOf(repl, rtt, writable));
    return { down: null, start: elected, elected, caughtUp, modes: [caughtUp], writable, steppedDown: stepped, discovered, writtenOff: null, ...landed, lands: "new", fails: null };
  }

  if (cause.kind === "silent") {
    const e = electionOf(repl, driver, rtt, cause.back);
    const writtenOff = writeOffOf(driver, heartbeatFrequency);
    const back = cause.back;
    const sync = syncOf(repl, driver, rtt, e.writable, back);
    // a primary that comes back before the client's write-off: its kernel or the thaw ends the wait
    if (back !== null && back < writtenOff.lo) {
      if (back < e.start.lo) {
        // no election: the primary answers the write in flight when it is back, and the next write follows
        const reply = span(back, back + 2 * rtt + repl.work + driver.slack);
        const first = span(reply.lo, nextWrite(reply, rtt, repl, driver).hi);
        return { down: back > e.down.hi ? e.down : null, start: null, elected: null, caughtUp: null, modes: [], writable: null, steppedDown: null, discovered: null, writtenOff: null, first, firstModes: [], lands: "same", fails: null };
      }
      if (!(back > e.start.hi)) throw new Error("the primary can be back before or after the election starts");
      if (!(e.discovered.hi < writtenOff.lo)) throw new Error("the new primary can come after the write-off");
      // the old primary is back and steps down on the newer term: the write fails, and the retry finds the new primary
      const fails = span(back, back + 2 * rtt + repl.work + 2 * repl.slack);
      const landed = land(later(fails, e.discovered), sync);
      return { down: e.down, start: e.start, elected: e.elected, caughtUp: e.caughtUp, modes: e.modes, writable: e.writable, steppedDown: null, discovered: e.discovered, writtenOff: null, ...landed, lands: "new", fails: null };
    }
    const steppedDown = cause.alive ? stepDownOf(repl, driver, rtt) : null;
    // the write-off interrupts the write in flight, or the kernel gives up on it first, and its retry selects again
    if (giveUp !== null && !(giveUp.hi < writtenOff.lo || giveUp.lo > writtenOff.hi))
      throw new Error("the kernel's give-up and the write-off can end the write in either order");
    const ended = giveUp !== null && giveUp.hi < writtenOff.lo ? giveUp : writtenOff;
    const retry = plus(ended, span(0, driver.slack));
    const deadline = plus(retry, driver.selection);
    if (e.discovered.hi < deadline.lo) {
      const landed = land(later(retry, e.discovered), sync);
      return { down: e.down, start: e.start, elected: e.elected, caughtUp: e.caughtUp, modes: e.modes, writable: e.writable, steppedDown, discovered: e.discovered, writtenOff, ...landed, lands: "new", fails: null };
    }
    if (!(e.discovered.lo > deadline.hi)) throw new Error("the new primary can come on either side of the retry's selection timeout");
    // the retry's selection times out first: the write fails to the application
    const landed = land(e.discovered, sync);
    return { down: e.down, start: e.start, elected: e.elected, caughtUp: e.caughtUp, modes: e.modes, writable: e.writable, steppedDown, discovered: e.discovered, writtenOff, ...landed, lands: "new", fails: deadline };
  }

  // the primary is cut from the group, and the client reaches it
  const e = electionOf(repl, driver, rtt, null);
  const steppedDown = stepDownOf(repl, driver, rtt);
  // with w: majority, the write waits for the replication and fails at the step-down. With w: 1, each write is acknowledged until then
  const fails = plus(steppedDown, span(rtt / 2, rtt + driver.slack));
  // a write with w: 1 does not wait for the other secondary
  const sync = cause.w === "majority" ? syncOf(repl, driver, rtt, e.writable) : null;
  const landed = land(later(fails, e.discovered), sync);
  return { down: e.down, start: e.start, elected: e.elected, caughtUp: e.caughtUp, modes: e.modes, writable: e.writable, steppedDown, discovered: e.discovered, writtenOff: null, ...landed, lands: "new", fails: null };
};

/**
 * This function gives the count of writes that the old primary acknowledges with w: 1 after the
 * fault and before it steps down. The group does not keep them. A write cycle is the pause at
 * least. At most it is the pause, a round trip, and a step of mongod and of the client. A write
 * with w: 1 does not wait for the journal.
 */
export const lostOf = (settings: ReplSettings, options: DriverOptions, rttMs: number): Span => {
  const rtt = rttMs / 1000;
  const repl = replTimes(settings, rttMs);
  const driver = driverTimes(options, rttMs);
  const steppedDown = stepDownOf(repl, driver, rtt);
  const cycle = span(INTERVAL, INTERVAL + rtt + repl.slack + driver.slack);
  return span(Math.floor(steppedDown.lo / cycle.hi) - 1, Math.ceil(steppedDown.hi / cycle.lo) + 1);
};

/** This function gives the window of mongod's keepalive on a client connection: its values over Linux TCP, in seconds. */
export const sessionKeepalive = (sysctls: Readonly<Record<string, number>> = {}): Span => {
  const values = given(sessionValues(sysctls));
  const lower = overValues(MONGOD_SESSION, values, given(linuxValues()));
  return spanOf(LINUX_TCP, "keepalive", lower);
};
