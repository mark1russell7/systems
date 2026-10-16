import type { KnobValues, Machine } from "@mark1russell7/algebra";
import { timerOf } from "@mark1russell7/algebra";
import type { Cell, Fault, Group, GroupPlace, GroupPrediction, Prediction, StageBand, Target } from "@mark1russell7/harness";
import type { Extent, Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { HZ, LINUX_66, RTT_MS, RUNS, given, ms, predict, q, s, seconds, sysctlsOf } from "./catalog.ts";
import { IOREDIS_SENTINEL } from "./ioredis-sentinel.ts";
import { assuming } from "./rtt.ts";
import { SENTINEL } from "./sentinel.ts";

/** This image is Valkey 9.1.2, pinned by the digest of its index: each member and each Sentinel of T12. */
export const VALKEY_IMAGE = "valkey/valkey:9.1@sha256:418652cfb58ef879d4978c33553735d7147016032d5aefaa14c828e611eb9dfd";

/** These are the settings of each member, at the defaults of Valkey 9.1.2 but for three that a group of the harness needs. */
export const MEMBER_SETTINGS: Readonly<Record<string, string>> = {
  // the network of the group is private, and no member keeps its data on disk
  "protected-mode": "no",
  save: '""',
  appendonly: "no",
  // the replicas' settings, at their defaults
  "replica-priority": "100",
  "repl-timeout": "60",
  "repl-ping-replica-period": "10",
  "min-replicas-to-write": "0",
  "min-replicas-max-lag": "10",
  "repl-diskless-sync": "yes",
  "repl-diskless-sync-delay": "5",
};

/** These are the settings of each Sentinel for the group, at the defaults of Valkey 9.1.2. */
export const SENTINEL_DEFAULTS: Readonly<Record<string, string>> = {
  "down-after-milliseconds": "30000",
  "failover-timeout": "180000",
  "parallel-syncs": "1",
};

/** This function gives the group of T12: three members and three Sentinels of Valkey 9.1.2, quorum 2, with the settings of each Sentinel. */
export const group = (sentinelSettings: Readonly<Record<string, string>> = SENTINEL_DEFAULTS): Group => ({
  name: "mymaster",
  image: VALKEY_IMAGE,
  programs: { server: "valkey-server", sentinel: "valkey-sentinel", cli: "valkey-cli" },
  port: 6379,
  sentinelPort: 26379,
  members: ["m1", "m2", "m3"],
  sentinels: ["s1", "s2", "s3"],
  quorum: 2,
  memberSettings: MEMBER_SETTINGS,
  sentinelSettings,
  ready: { member: "Ready to accept connections", sentinel: "+monitor master" },
});

/** This target is the image of the group, for the record of a cell: a group cell does not connect to it. */
export const GROUP_TARGET: Target = { image: VALKEY_IMAGE, port: 6379, ready: "Ready to accept connections" };

/**
 * This time is the error of the stamps of the observer. It is the 99.9th percentile of the delay
 * from the write of a Sentinel to the stamp of the observer that read it. The calibration cell of
 * the Sentinels measured it on 2026-10-16 (`T12_CAL`), on a runner of GitHub with Linux 6.17. Its
 * 397 stamps had a median of 0.208 ms, a 99th percentile of 0.552 ms and a maximum of 0.705 ms.
 * Each stage band includes it.
 */
export const STAMPS: Quantity = { value: 0.705, unit: "ms" };

/** This interval is the pause of the stream of writes after each reply: 50 ms. */
const INTERVAL_MS = 50;

// ---------------------------------------------------------------------------------------------
// the composition: the stages of the group from the Sentinel document, then the client
// ---------------------------------------------------------------------------------------------

/** A span is an interval of time in seconds: the earliest and the latest. */
export interface Span {
  readonly lo: number;
  readonly hi: number;
}
const span = (lo: number, hi: number): Span => ({ lo, hi });
const plus = (a: Span, b: Span): Span => span(a.lo + b.lo, a.hi + b.hi);
const at = (value: number): Span => span(value, value);

/** This function gives the values of the knobs of the Sentinel document: its defaults, then the settings of the group. */
export const sentinelValues = (settings: Readonly<Record<string, string>>): KnobValues => {
  const values: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(SENTINEL.knobs))
    if (knob.default !== null && knob.unit !== null) values[name] = { value: knob.default, unit: knob.unit };
  values["down_after"] = ms(Number(settings["down-after-milliseconds"]));
  values["failover_timeout"] = ms(Number(settings["failover-timeout"]));
  values["parallel_syncs"] = { value: Number(settings["parallel-syncs"]), unit: "count" };
  values["quorum"] = { value: 2, unit: "count" };
  return given(values);
};

/** This function gives the values of the knobs of the ioredis document: its defaults, and the round trip of the group in ms. */
export const ioredisValues = (rttMs: number): KnobValues => {
  const values: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(IOREDIS_SENTINEL.knobs))
    if (knob.default !== null && knob.unit !== null) values[name] = { value: knob.default, unit: knob.unit };
  values["rtt"] = ms(rttMs);
  return given(values);
};

/** This function gives the span of one timer of a document in seconds: its duration less its early bound, to its duration plus its lateness. */
const spanOf = (doc: Machine, timer: string, values: KnobValues, fired?: number): Span => {
  const bounds = timerOf(doc, timer, values, fired);
  const duration = seconds(bounds.duration, timer);
  return span(duration - seconds(bounds.early, `${timer}'s early bound`), duration + seconds(bounds.lateness, `${timer}'s lateness`));
};

/**
 * The stages of a failover, from the fault, as spans:
 * - `sdown` is the first `+sdown`, `odown` the first `+odown` and `+try-failover`.
 * - `elected` is `+elected-leader`, `selected` is `+selected-slave`, and `noone` is the REPLICAOF NO ONE that promotes the replica.
 * - `promoted` is `+promoted-slave` at the leader. From it, the leader names the new primary.
 * - `switched` is the first `+switch-master`: another Sentinel, on the hello of the leader.
 * - `advertised` is when the Sentinel that the client asks names the new primary.
 */
export interface Failover {
  readonly sdown: Span | null;
  readonly odown: Span | null;
  readonly elected: Span;
  readonly selected: Span;
  readonly noone: Span;
  readonly promoted: Span;
  readonly switched: Span;
  readonly advertised: Span;
}

/** This name is what makes the Sentinels start a failover: a primary that goes silent, a primary that closes its links, or a request. */
export type Cause = "silence" | "closes" | "request";

/**
 * This function gives the stages of a failover from the Sentinel document, at a round trip in ms:
 * - A silence: the first PING without a PONG goes up to one ping period and a tick after the
 *   fault. A primary that closes its links: the reconnect sends a PING at the next tick.
 * - Each Sentinel is down at down-after-milliseconds after that PING, and 1 ms, at its next tick.
 * - The second Sentinel that is down asks the first, and it is objectively down at its next tick.
 * - The election ends at the next tick after the votes. A request (SENTINEL FAILOVER) needs no
 *   votes: the next tick elects. The selection and the promotion each take a tick.
 * - The leader sees the promotion at the next INFO of the replica, at its failover period.
 * - The other Sentinels switch on the hello that the leader sends at its next tick.
 */
export const failoverOf = (cause: Cause, settings: Readonly<Record<string, string>>, rttMs: number): Failover => {
  const values = sentinelValues(settings);
  const rtt = rttMs / 1000;
  const tick = spanOf(SENTINEL, "tick", values);
  const next = span(0, tick.hi);
  const elect = (from: Span): Span => (cause === "request" ? plus(from, next) : plus(from, span(tick.lo, tick.hi + 2 * rtt)));
  let sdown: Span | null = null;
  let odown: Span | null = null;
  let elected: Span;
  if (cause === "request") {
    elected = plus(span(0, rtt), next);
  } else {
    const ping = spanOf(SENTINEL, "ping", values);
    const act = cause === "silence" ? span(-rtt, ping.hi) : span(-rtt, tick.hi + rtt);
    const down = timerOf(SENTINEL, "down_after", values);
    const after = seconds(down.duration, "down_after");
    // elapsed > down_after in whole ms: 1 ms more, then the next tick
    sdown = plus(act, span(after + 0.001, after + 0.001 + tick.hi));
    odown = span(sdown.lo, sdown.hi + rtt + tick.hi);
    elected = elect(odown);
  }
  const selected = plus(elected, tick);
  const noone = plus(plus(selected, tick), span(0, rtt));
  const info = spanOf(SENTINEL, "info_failover", values);
  const promoted = plus(noone, span(rtt, info.hi + rtt));
  const switched = plus(promoted, span(0, tick.hi + rtt));
  return { sdown, odown, elected, selected, noone, promoted, switched, advertised: span(promoted.lo, switched.hi) };
};

/** This function gives the stage bands of a failover for a prediction, from the fault. */
export const stageBands = (stages: Failover): StageBand[] => [
  ...(stages.sdown === null ? [] : [{ stage: "+sdown" as const, low: q(stages.sdown.lo), high: q(stages.sdown.hi) }]),
  ...(stages.odown === null ? [] : [{ stage: "+odown" as const, low: q(stages.odown.lo), high: q(stages.odown.hi) }]),
  { stage: "+elected-leader", low: q(stages.elected.lo), high: q(stages.elected.hi) },
  { stage: "+selected-slave", low: q(stages.selected.lo), high: q(stages.selected.hi) },
  { stage: "+promoted-slave", low: q(stages.promoted.lo), high: q(stages.promoted.hi) },
  { stage: "+switch-master", low: q(stages.switched.lo), high: q(stages.switched.hi) },
];

/** A ladder step is one connect of ioredis after a close: when it can start, from the first close, and what fired it. */
export interface Attempt {
  readonly fired: number;
  readonly start: Span;
}

/**
 * This function gives the connects of ioredis after the close that lost the primary, from the
 * ioredis document. Connect k starts after k + 1 waits of `retry_delay` and k connects that
 * failed. A connect fails when its Sentinel still names the old primary, which refuses it.
 */
export const ladderOf = (close: Span, rttMs: number, count: number): Attempt[] => {
  const values = ioredisValues(rttMs);
  const fail = spanOf(IOREDIS_SENTINEL, "attempt", values);
  const out: Attempt[] = [];
  let start = close;
  for (let fired = 0; fired < count; fired += 1) {
    start = plus(start, spanOf(IOREDIS_SENTINEL, "retry_delay", values, fired));
    out.push({ fired, start });
    start = plus(start, fail);
  }
  return out;
};

/**
 * This function gives when the first connect after the advertisement succeeds, and its first write
 * then lands. The span starts at the earliest connect that can start after the earliest
 * advertisement. It ends at the first connect that surely starts after the latest one. The
 * algebra's `recovery` reads a backoff the same way after a stall.
 */
export const firstAfter = (
  ladder: readonly Attempt[],
  advertised: Span,
  rttMs: number,
): { lands: Span; first: number; last: number } => {
  const values = ioredisValues(rttMs);
  const success = spanOf(IOREDIS_SENTINEL, "success", values);
  const first = ladder.find((each) => each.start.hi >= advertised.lo);
  const last = ladder.find((each) => each.start.lo >= advertised.hi);
  if (first === undefined || last === undefined) throw new Error("the ladder ends before the advertisement");
  const attempt = span(Math.max(first.start.lo, advertised.lo), last.start.hi);
  // the connects that can succeed: from the first, by the count of the waits before each
  return { lands: plus(attempt, success), first: first.fired, last: last.fired };
};

/** This function gives the close that ends the queue: close maxRetriesPerRequest + 1, at the end of the connect before it. */
export const flushOf = (ladder: readonly Attempt[], rttMs: number): Span => {
  const values = ioredisValues(rttMs);
  const max = Number(IOREDIS_SENTINEL.knobs["maxRetriesPerRequest"]!.default);
  const fail = spanOf(IOREDIS_SENTINEL, "attempt", values);
  // close 1 is the fault's: the close that makes retryAttempts max + 1 ends connect max - 1
  const last = ladder[max - 1];
  if (last === undefined) throw new Error("the ladder is shorter than maxRetriesPerRequest");
  return plus(last.start, fail);
};

/**
 * This function gives when an old primary that comes back is a replica again, and closes its
 * clients: the first `+convert-to-slave`. Each Sentinel has the old primary as a replica from its
 * switch. Its first INFO reply after the old primary is back marks the change of the role. The
 * next INFO, one INFO period later, finds the change older than the wait of `convert`. The
 * Sentinel then sends REPLICAOF, and a `CLIENT` command that closes each client.
 */
export const conversionOf = (back: Span, switched: Span, settings: Readonly<Record<string, string>>, rttMs: number): Span => {
  const values = sentinelValues(settings);
  const rtt = rttMs / 1000;
  const tick = spanOf(SENTINEL, "tick", values);
  const info = spanOf(SENTINEL, "info", values);
  const wait = seconds(timerOf(SENTINEL, "convert", values).duration, "convert");
  if (!(info.lo > wait)) throw new Error("an INFO period no longer than the wait of the conversion: the second INFO does not convert");
  const slack = seconds(ioredisValues(rttMs)("slack") as Quantity, "slack");
  // the first INFO reply: at the return, or for an entry made later, at its first tick
  const first = span(Math.max(back.lo + rtt, switched.lo + 2 * rtt), Math.max(back.hi + rtt + slack, switched.hi + tick.hi + 2 * rtt + slack));
  return plus(first, span(info.lo + rtt, info.hi + rtt));
};

/** This function gives when the first write lands on the new primary after the old primary closed the client: one wait and one connect. */
export const afterKill = (kill: Span, rttMs: number): Span => {
  const values = ioredisValues(rttMs);
  return plus(plus(kill, spanOf(IOREDIS_SENTINEL, "retry_delay", values, 0)), spanOf(IOREDIS_SENTINEL, "success", values));
};

// ---------------------------------------------------------------------------------------------
// the specs of T12, by the cells of the plan that they stand for
// ---------------------------------------------------------------------------------------------

/** A T12 spec is one cell of the catalog, before its prediction. */
export interface T12Spec {
  /** This identifier is the cell of the plan that this cell stands for, for example `T12.defaults.6`. */
  readonly plan: string;
  /** This text is the rest of the name: the trigger, its position and its settings. */
  readonly name: string;
  readonly fault: Fault;
  readonly at?: GroupPlace;
  /** This time is how long the fault holds, in seconds. */
  readonly hold?: number;
  /** This time is the length of a stall from the first write into it, in seconds. */
  readonly stall?: number;
  readonly coordinated?: boolean;
  /** These are the settings of each Sentinel, when they are not the defaults. */
  readonly sentinel?: Readonly<Record<string, string>>;
  /** This text is the reason that the cell is measurement-only. */
  readonly why?: string;
  /** This flag marks the calibration of the stamps: the prober watches the Sentinels too. */
  readonly calibrates?: true;
}

/** This time is the hold of a fault whose failover the group completes before the fault lifts. */
const HOLD = 40;
/** This time is the window of a measurement-only cell: the move of a pinned client after its fault lifts. */
const MEASURED_WINDOW = 120;

const PRIMARY: GroupPlace = { role: "primary" };
/** This reason is why a client that stays on its old primary through the fault has no band. */
const PINNED =
  "the client stays on the old primary while the fault holds: ioredis has no timer for the group, and its write waits. After the lift, the old primary is a replica again only when a Sentinel reaches it, on the SYN backoff of its kernel, from a time that no document gives";

/** These are the cells of T12 over valkey-9.1-sentinel: each trigger at each position that the plan names, then the border points. */
export const T12_SPECS: readonly T12Spec[] = [
  // ---- partition:partial, DV-40: the primary keeps its clients and loses its Sentinels and its replicas
  {
    plan: "T12.defaults.1",
    name: "partition:partial, the primary cut from the Sentinels and the replicas, its clients with it, 40 s",
    fault: "partition",
    at: { role: "primary", cuts: "group" },
    hold: HOLD,
    why: `a split brain: ${PINNED}`,
  },
  // ---- partition:partial the other way: the primary keeps its group and loses its clients
  {
    plan: "T12.defaults.1",
    name: "partition:partial, the primary cut from the clients, a 40 s stall",
    fault: "partition",
    at: { role: "primary", cuts: "clients" },
    stall: HOLD,
  },
  { plan: "T12.defaults.6", name: "blackhole at the primary, 40 s", fault: "blackhole", at: PRIMARY, hold: HOLD, why: PINNED },
  { plan: "T12.defaults.7", name: "freeze-process at the primary, 40 s", fault: "freeze-process", at: PRIMARY, hold: HOLD },
  { plan: "T12.defaults.8", name: "fin at the primary", fault: "fin", at: PRIMARY },
  { plan: "T12.defaults.9", name: "event:planned, SENTINEL FAILOVER", fault: "planned-failover" },
  {
    plan: "T12.defaults.9",
    name: "event:planned, SENTINEL FAILOVER COORDINATED",
    fault: "planned-failover",
    coordinated: true,
    why: "the server's own FAILOVER command pauses the writes and hands over the primary, and no machine document gives its time",
  },
  { plan: "T12.defaults.10", name: "rst at the primary: each peer refused", fault: "rst", at: PRIMARY },
  // ---- K-failover's border: a primary silence shorter or longer than down-after-milliseconds (30 s)
  { plan: "T12.border-off.1", name: "freeze-process at the primary, 29 s, inside down-after-milliseconds 30 s", fault: "freeze-process", at: PRIMARY, hold: 29 },
  { plan: "T12.border-off.2", name: "freeze-process at the primary, 33 s, outside down-after-milliseconds 30 s", fault: "freeze-process", at: PRIMARY, hold: 33 },
  // ---- K-client-retries' border: the failover against the give-up of the offline queue, at the 21st close of ioredis 6
  {
    plan: "T12.border-off.15",
    name: "fin at the primary, down-after-milliseconds 69 s, inside the give-up of the offline queue",
    fault: "fin",
    at: PRIMARY,
    sentinel: { ...SENTINEL_DEFAULTS, "down-after-milliseconds": "69000" },
  },
  {
    plan: "T12.border-off.16",
    name: "fin at the primary, down-after-milliseconds 76 s, outside the give-up of the offline queue",
    fault: "fin",
    at: PRIMARY,
    sentinel: { ...SENTINEL_DEFAULTS, "down-after-milliseconds": "76000" },
  },
];

/** This calibration measures the error of the stamps of the observer, on the events of a planned failover. */
export const T12_CAL_SPEC: T12Spec = {
  plan: "CAL",
  name: "the stamps of the observer of the Sentinels, event:planned SENTINEL FAILOVER",
  fault: "planned-failover",
  why: "a calibration: each stamp of the observer against the write of its Sentinel that it read",
  calibrates: true,
};

/** These are the triggers of the plan's T12 cells over valkey-9.1-sentinel that the harness cannot do, each with its reason. */
export const T12_WAITING: ReadonlyArray<{ readonly plan: string; readonly trigger: string; readonly why: string }> = [
  {
    plan: "T12.defaults.11",
    trigger: "event:bundle",
    why: "a bundle unload is an event of Pulsar's brokers: a Valkey group has no bundles, and Pulsar is in the S2 slice",
  },
];

/** This function gives the round trip of a cell in ms: the network of the group. */
const nominal = (): number => RTT_MS;

/**
 * This function gives the prediction of a T12 cell from the Sentinel and the ioredis documents,
 * at a round trip in ms. The band is the first write that a primary accepts after the fault.
 */
export const predictT12At = (spec: T12Spec, rttMs: number): Prediction => {
  const settings = spec.sentinel ?? SENTINEL_DEFAULTS;
  const rtt = rttMs / 1000;
  const slack = seconds(ioredisValues(rttMs)("slack") as Quantity, "slack");
  const timer = (path: string) => ({ timer: path, errno: "OK", from: "fault" as const });
  const withGroup = (
    failover: Failover | null,
    lands: GroupPrediction["lands"],
    errors?: GroupPrediction["errors"],
    fails = failover !== null,
  ): GroupPrediction => ({
    lands,
    failover: fails,
    stages: failover === null ? [] : stageBands(failover),
    stamps: STAMPS,
    ...(errors === undefined ? {} : { errors }),
  });
  const measured = (failover: Failover | null, lands: GroupPrediction["lands"]): Prediction => ({
    detects: null,
    window: q(MEASURED_WINDOW),
    why: spec.why!,
    from: "fault",
    // each measured cell of T12 fails over: a coordinated failover too, with no stage bands
    group: withGroup(failover, lands, undefined, true),
  });

  if (spec.fault === "planned-failover") {
    const failover = failoverOf("request", settings, rttMs);
    if (spec.why !== undefined) return measured(spec.coordinated === true ? null : failover, "new");
    // the old primary stays a primary: each Sentinel converts it one INFO period after its switch
    const kill = plus(conversionOf(at(0), failover.switched, settings, rttMs), span(0, rtt));
    const lands = afterKill(kill, rttMs);
    return { detects: true, ...timer("SENTINEL FAILOVER, the conversion of the old primary, then the reconnect of ioredis"), low: q(lands.lo), high: q(lands.hi), group: withGroup(failover, "new") };
  }
  if (spec.fault === "partition" && spec.at?.cuts === "clients") {
    // no Sentinel loses the primary: the client's write waits for the retransmissions of its kernel
    const stall = predict({ name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall! });
    if (stall.detects !== false || stall.recovers === undefined) throw new Error(`${spec.name}: Linux TCP gives no recovery`);
    return { ...stall, window: q(valueIn(stall.recovers.high, "s") + 10), group: withGroup(null, "same") };
  }
  if (spec.fault === "freeze-process") {
    const hold = spec.hold!;
    const failover = failoverOf("silence", settings, rttMs);
    if (failover.sdown!.lo > hold) {
      // the thaw comes before any Sentinel is down: the frozen write gets its reply at the thaw
      return { detects: true, ...timer("SIGCONT: the frozen primary answers"), low: q(hold), high: q(hold + rtt + slack), group: withGroup(null, "same") };
    }
    if (!(failover.odown!.hi < hold)) throw new Error(`${spec.name}: the thaw can come before the failover starts`);
    const low = seconds(timerOf(SENTINEL, "low_activity", sentinelValues(settings)).duration, "low_activity");
    if (!(hold - failover.switched.lo < low)) throw new Error(`${spec.name}: a Sentinel can close its link to the frozen primary first`);
    const kill = plus(conversionOf(at(hold), failover.switched, settings, rttMs), span(0, rtt));
    const lands = afterKill(kill, rttMs);
    return { detects: true, ...timer("Sentinel failover, the conversion of the thawed primary, then the reconnect of ioredis"), low: q(lands.lo), high: q(lands.hi), group: withGroup(failover, "new") };
  }
  if (spec.fault === "fin" || spec.fault === "rst") {
    const failover = failoverOf(spec.fault === "fin" ? "closes" : "silence", settings, rttMs);
    // a fin closes the client at once. A refusal closes it at its next write, one interval later at most
    const close = spec.fault === "fin" ? span(0, rtt + slack) : span(0, INTERVAL_MS / 1000 + rtt + slack);
    const ladder = ladderOf(close, rttMs, 64);
    const { lands, first, last } = firstAfter(ladder, failover.advertised, rttMs);
    const flush = flushOf(ladder, rttMs);
    // the queue goes at the close after connect maxRetriesPerRequest - 1: a success before it keeps the queue
    const max = Number(IOREDIS_SENTINEL.knobs["maxRetriesPerRequest"]!.default);
    if (last >= max && first < max) throw new Error(`${spec.name}: the first write can land on either side of the give-up of the queue`);
    const errors = first >= max ? [{ name: "MaxRetriesPerRequestError", low: q(flush.lo), high: q(flush.hi) }] : undefined;
    const path = spec.fault === "fin" ? "Sentinel failover, then the reconnect ladder of ioredis" : "Sentinel failover behind a refusal, then the reconnect ladder of ioredis";
    return { detects: true, ...timer(path), low: q(lands.lo), high: q(lands.hi), group: withGroup(failover, "new", errors) };
  }
  // a black hole and a partition from the group: the group fails over, and the client stays pinned
  return measured(failoverOf("silence", settings, rttMs), "new");
};

/** This time is the longest round trip of the network of a group that a band of T12 assumes, in ms. */
export const GROUP_RTT_MS = 2;

/** This function joins two bands: the low edge of the first, and the high edge of the second. */
const joined = (low: Prediction, high: Prediction): Prediction => {
  if (low.detects !== true || high.detects !== true) return high;
  if ((low.group?.errors === undefined) !== (high.group?.errors === undefined))
    throw new Error("the outcome of the band changes over the range of round trips");
  const stages = (high.group?.stages ?? []).map((band, at) => ({ ...band, low: low.group!.stages[at]!.low }));
  const errors = high.group?.errors?.map((error, at) => ({ ...error, low: low.group!.errors![at]!.low }));
  return {
    ...high,
    low: low.low,
    group: { ...high.group!, stages, ...(errors === undefined ? {} : { errors }) },
    rtt: { low: ms(0), high: ms(GROUP_RTT_MS) },
  };
};

/**
 * This function gives the prediction of a T12 cell, with the range of round trips that its band
 * assumes. A band of the group reads many round trips: each connect of the ladder reads five. It
 * holds for each round trip from 0 to `GROUP_RTT_MS`. Its low edge is the band at 0, and its high
 * edge is the band at `GROUP_RTT_MS`. A stall reads the RTO of the kernel, which `assuming` gives.
 */
export const predictT12 = (spec: T12Spec): Prediction => {
  if (spec.stall !== undefined) return assuming((rtt) => predictT12At(spec, rtt), nominal());
  const low = predictT12At(spec, 0);
  const high = predictT12At(spec, GROUP_RTT_MS);
  if (high.detects !== true) return { ...high, ...(high.group === undefined ? {} : { group: joinStages(low, high) }) };
  return joined(low, high);
};

/** This function gives the group prediction of a measurement-only band, with the stage bands over the range of round trips. */
const joinStages = (low: Prediction, high: Prediction): GroupPrediction => ({
  ...high.group!,
  stages: (high.group?.stages ?? []).map((band, at) => ({ ...band, low: low.group!.stages[at]!.low })),
});

/** These are the sysctls of the client of a group cell: Linux 6.6, each one given. */
const CLIENT_SYSCTLS = sysctlsOf({ ...LINUX_66, hz: { value: HZ, unit: "Hz" }, rtt: ms(RTT_MS) });

/** This function gives the cell of a T12 spec for the harness. */
export const t12Cell = (spec: T12Spec): Cell => ({
  name: `${spec.plan} ${spec.name}`,
  target: GROUP_TARGET,
  sysctls: CLIENT_SYSCTLS,
  probe: { mode: "stream", keepalive: false, interval: ms(INTERVAL_MS), driver: { name: "ioredis", keepAlive: s(30) } },
  fault: spec.fault,
  ...(spec.at === undefined ? {} : { faultAt: spec.at }),
  group: group(spec.sentinel),
  ...(spec.hold === undefined ? {} : { hold: s(spec.hold) }),
  ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
  ...(spec.coordinated === true ? { coordinated: true } : {}),
  ...(spec.calibrates === true ? { calibrates: "sentinels" } : {}),
  prediction: predictT12(spec),
  runs: RUNS,
  environments: 2,
  // a group has 16 containers and its timeline reads the scheduler of six processes: one cell at a time
  concurrency: 1,
});

/** These are the cells of the T12 catalog, in the sequence of the specs. */
export const T12_CELLS: readonly Cell[] = T12_SPECS.map(t12Cell);
/** This cell is the calibration of the stamps of the observer. */
export const T12_CAL: Cell = t12Cell(T12_CAL_SPEC);
