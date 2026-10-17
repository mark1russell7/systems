import { timerOf } from "@mark1russell7/algebra";
import { LINUX_TCP } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { RTT_MS, count, given, predict, seconds } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Alias, GroupPlace, MongoBand, MongoCell, MongoGroupPrediction, MongoPrediction, MongoSpec, StageBand, Waiting } from "./cells.ts";
import { sec } from "./cells.ts";
import type { GroupCause, Span, Timeline } from "./model.ts";
import { INTERVAL, driverTimes, driverValues, firstOn, linuxValues, lostOf, plus, replTimes, span, timelineOf } from "./model.ts";
import { FAULT, POOL_SENT, WRITE_OFF, bandOf } from "./single.ts";

/**
 * The MongoDB catalog of T11: the driver of MongoDB 7.7.0 and a replica set of three members of
 * mongod 9.0.4. The members elect their own primary, and the driver finds it by its monitors. The
 * client writes a stream of sequence numbers, one at a time, 50 ms after each reply. Each cell is
 * named by the cell of the plan that it stands for.
 */

/** This time is the longest round trip of the network of the set that a band assumes, in ms. */
export const GROUP_RTT_MS = 2;

const PRIMARY = (cuts: GroupPlace["cuts"]): GroupPlace => ({ role: "primary", cuts });
const TUNED = { heartbeatFrequencyMS: 2000, connectTimeoutMS: 5000 };

/** These are the cells of T11 over mongodb-node-7.7 and mongodb-replset. */
export const T11_MONGO_SPECS: readonly MongoSpec[] = [
  // ---- the defaults stage
  { plan: "T11.defaults.1", name: "event:stepdown, replSetStepDown at the primary", fault: "step-down", mode: "stream" },
  { plan: "T11.defaults.8", name: "freeze-process at the primary, 60 s", fault: "freeze-process", mode: "stream", at: PRIMARY("all"), hold: 60 },
  { plan: "T11.defaults.9", name: "blackhole at the primary, the clients too, 60 s", fault: "blackhole", mode: "stream", at: PRIMARY("all"), hold: 60 },
  {
    plan: "T11.defaults.10",
    name: "partition:complete, the primary cut from the other members, not from the clients, 40 s",
    fault: "partition",
    mode: "stream",
    at: PRIMARY("group"),
    hold: 40,
  },
  {
    plan: "T11.defaults.11",
    name: "partition:partial, the primary cut from one secondary, 40 s",
    fault: "partition",
    mode: "stream",
    at: PRIMARY("one"),
    hold: 40,
  },
  {
    plan: "T11.defaults.11",
    name: "partition:partial, the primary cut from the clients, a 20 s stall",
    fault: "partition",
    mode: "stream",
    at: PRIMARY("clients"),
    stall: 20,
  },
  {
    plan: "T11.defaults.12",
    name: "partition:simplex, the segments from the primary to one secondary dropped, 40 s",
    fault: "partition",
    mode: "stream",
    at: PRIMARY("one-way"),
    hold: 40,
  },
  // ---- the border stage
  {
    plan: "T11.border-off.5",
    name: "freeze-process at the primary, 8 s, inside electionTimeoutMillis 10 s",
    fault: "freeze-process",
    mode: "stream",
    at: PRIMARY("all"),
    hold: 8,
  },
  {
    plan: "T11.border-off.6",
    name: "freeze-process at the primary, 13 s, outside electionTimeoutMillis and its offset",
    fault: "freeze-process",
    mode: "stream",
    at: PRIMARY("all"),
    hold: 13,
  },
  {
    plan: "T11.border-off.24",
    name: "freeze-process at the primary, 60 s, heartbeatFrequencyMS 2000 and connectTimeoutMS 5000: the write-off before the election",
    fault: "freeze-process",
    mode: "stream",
    at: PRIMARY("all"),
    hold: 60,
    options: TUNED,
  },
  {
    plan: "T11.border-off.31",
    name: "blackhole at the primary, 60 s, tcp_retries2 = 5: the kernel gives up before the write-off",
    fault: "blackhole",
    mode: "stream",
    at: PRIMARY("all"),
    hold: 60,
    linux: { tcp_retries2: count(5) },
  },
  {
    plan: "T11.border-off.32",
    name: "blackhole at the primary, 60 s, tcp_retries2 = 7: the write-off comes first",
    fault: "blackhole",
    mode: "stream",
    at: PRIMARY("all"),
    hold: 60,
    linux: { tcp_retries2: count(7) },
  },
  { plan: "T11.border-off.39", name: "freeze-process at the primary, 29 s, inside the write-off", fault: "freeze-process", mode: "stream", at: PRIMARY("all"), hold: 29 },
  { plan: "T11.border-off.40", name: "freeze-process at the primary, 41 s, outside the write-off", fault: "freeze-process", mode: "stream", at: PRIMARY("all"), hold: 41 },
  {
    plan: "T11.border-off.48",
    name: "freeze-process at the primary, 90 s, the tuned write-off, electionTimeoutMillis 40000: the retry's selection times out first",
    fault: "freeze-process",
    mode: "stream",
    at: PRIMARY("all"),
    hold: 90,
    options: TUNED,
    settings: { electionTimeoutMillis: 40000 },
  },
  {
    plan: "T11.border-off.66",
    name: "partition:complete, the primary cut from the other members, 40 s, writes with w 1",
    fault: "partition",
    mode: "stream",
    at: PRIMARY("group"),
    hold: 40,
    w: 1,
  },
  {
    plan: "T11.border-off.68",
    name: "partition:complete, the primary cut from the other members, 40 s, catchUpTimeoutMillis 0",
    fault: "partition",
    mode: "stream",
    at: PRIMARY("group"),
    hold: 40,
    settings: { catchUpTimeoutMillis: 0 },
  },
];

/** This function gives the give-up of the kernel for the write in flight on a black-holed primary, from the fault. A low tcp_retries2 makes it come first. */
const giveUpOf = (spec: MongoSpec, rttMs: number): Span | null => {
  if (spec.fault !== "blackhole" || spec.linux === undefined) return null;
  const driver = given(driverValues(spec.options, rttMs));
  const linux = given(linuxValues(spec.linux, rttMs));
  const pool = firstOn({ role: "pool", inFlight: true, manifestation: MANIFESTATIONS.blackhole }, driver, linux);
  if (pool.kind !== "timer") return null;
  // the write goes into the fault after the pause at the latest, and its first retransmission two RTOs later
  const rto = seconds(timerOf(LINUX_TCP, "retransmit", linux, 0).duration, "the RTO");
  return plus(span(0, INTERVAL + 2 * rto + 0.01), pool.band);
};

/** This function gives the cause of a fault at the primary, for the timeline. */
const causeOf = (spec: MongoSpec): GroupCause => {
  if (spec.fault === "step-down") return { kind: "step-down" };
  if (spec.fault === "freeze-process") return { kind: "silent", alive: false, back: spec.hold ?? null };
  if (spec.fault === "blackhole") return { kind: "silent", alive: true, back: null };
  if (spec.at?.cuts === "group") return { kind: "cut-from-group", w: spec.w ?? "majority" };
  throw new Error(`${spec.name}: no timeline for this fault`);
};

/** This function gives the stage bands of a timeline. */
const stagesOf = (t: Timeline): StageBand[] => {
  const out: StageBand[] = [];
  const add = (stage: StageBand["stage"], s: Span | null, modes?: readonly Span[]) => {
    if (s === null) return;
    out.push({
      stage,
      low: sec(s.lo),
      high: sec(s.hi),
      ...(modes === undefined || modes.length < 2 ? {} : { modes: modes.map((m) => ({ low: sec(m.lo), high: sec(m.hi) })) }),
    });
  };
  add("member-down", t.down);
  add("election-start", t.start);
  add("elected", t.elected);
  add("caught-up", t.caughtUp, t.modes);
  add("writable", t.writable);
  add("old-primary-steps-down", t.steppedDown);
  add("discovered", t.discovered);
  add("written-off", t.writtenOff);
  add("first-write", t.first, t.firstModes);
  return out;
};

/** This text is the event that a cell with no failover names: no new primary in its window. */
const NO_FAILOVER = "a member other than the old primary becomes primary";

/** This function gives the prediction of a cell of T11 at a round trip in ms, from mongod's document and the driver's. */
export const predictT11At = (spec: MongoSpec, rttMs: number): MongoPrediction => {
  const rtt = rttMs / 1000;
  const window = sec((spec.hold ?? 40) + 20);
  // a primary cut from one secondary, or its segments to one secondary dropped: the other secondary
  // keeps the majority, and it has the newest data, thus it refuses each vote to the one that is cut
  if (spec.at?.cuts === "one" || spec.at?.cuts === "one-way") {
    const repl = replTimes(spec.settings, rttMs);
    const driver = driverTimes(spec.options, rttMs);
    const first = span(0, INTERVAL + 2 * rtt + repl.work + 2 * driver.slack);
    const group: MongoGroupPrediction = { lands: "same", failover: false, stages: [], lost: { low: 0, high: 0 } };
    return { detects: true, bands: [bandOf("the first write after the fault, on the same primary", "OK", FAULT, first)], window, quiet: [NO_FAILOVER, WRITE_OFF], group };
  }
  // the primary cut from the clients: the members keep it, and the kernel of the client carries the write through the cut
  if (spec.at?.cuts === "clients") {
    const stall = predict({ name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall! });
    if (stall.detects !== false || stall.recovers === undefined) throw new Error(`${spec.name}: Linux TCP gives no recovery`);
    const reply = span(valueIn(stall.recovers.low, "s"), valueIn(stall.recovers.high, "s"));
    const writeOff = driverTimes(spec.options, rttMs).writeOff;
    if (!(reply.hi + INTERVAL < writeOff.lo - 10)) throw new Error(`${spec.name}: the write-off can come before the recovery`);
    const group: MongoGroupPrediction = { lands: "same", failover: false, stages: [], lost: { low: 0, high: 0 } };
    return {
      detects: true,
      bands: [bandOf("the write in the cut gets its reply after the cut", "OK", POOL_SENT, reply)],
      window: sec(valueIn(stall.recovers.high, "s") + 10),
      quiet: [NO_FAILOVER, WRITE_OFF],
      ...(stall.rtt === undefined ? {} : { rtt: stall.rtt }),
      group,
    };
  }
  const cause = causeOf(spec);
  const giveUp = giveUpOf(spec, rttMs);
  const t = timelineOf(cause, spec.settings ?? {}, spec.options ?? {}, rttMs, giveUp);
  const lost = spec.w === 1 ? lostOf(spec.settings ?? {}, spec.options ?? {}, rttMs) : span(0, 0);
  const group: MongoGroupPrediction = {
    lands: t.lands,
    failover: t.elected !== null,
    stages: stagesOf(t),
    ...(t.fails === null ? {} : { errors: [{ name: "MongoServerSelectionError", low: sec(t.fails.lo), high: sec(t.fails.hi) }] }),
    lost: { low: lost.lo, high: lost.hi },
  };
  const what = t.lands === "new" ? "the first write on the new primary" : "the first write after the fault, on the same primary";
  const bands: MongoBand[] = [bandOf(what, "OK", FAULT, t.first!)];
  if (t.fails !== null) bands.push(bandOf("the retry's selection times out", "MongoServerSelectionError", FAULT, t.fails));
  return { detects: true, bands, window: sec(Math.max(t.first!.hi, (spec.hold ?? 0)) + 15), quiet: t.elected === null ? [NO_FAILOVER] : [], group };
};

/**
 * This function gives the prediction of a cell of T11, with the range of round trips that its band
 * assumes. Each stage reads round trips: the prediction holds from 0 to `GROUP_RTT_MS`. Its low
 * edges are the bands at 0, and its high edges the bands at `GROUP_RTT_MS`.
 */
export const predictT11 = (spec: MongoSpec): MongoPrediction => {
  if (spec.why !== undefined) return { detects: null, bands: [], window: sec(120), quiet: [], why: spec.why };
  const nominal = predictT11At(spec, RTT_MS);
  if (nominal.rtt !== undefined) return nominal;
  const low = predictT11At(spec, 0);
  const high = predictT11At(spec, GROUP_RTT_MS);
  if (low.bands.length !== high.bands.length || low.group?.stages.length !== high.group?.stages.length)
    throw new Error(`${spec.name}: the outcome changes over the range of round trips`);
  const joinStages = (h: readonly StageBand[], l: readonly StageBand[]): StageBand[] =>
    h.map((stage, at) => ({
      ...stage,
      low: l[at]!.low,
      ...(stage.modes === undefined ? {} : { modes: stage.modes.map((m, k) => ({ ...m, low: l[at]!.modes?.[k]?.low ?? m.low })) }),
    }));
  return {
    ...high,
    bands: high.bands.map((band, at) => ({ ...band, low: low.bands[at]!.low })),
    rtt: { low: { value: 0, unit: "ms" }, high: { value: GROUP_RTT_MS, unit: "ms" } },
    ...(high.group === undefined
      ? {}
      : {
          group: {
            ...high.group,
            stages: joinStages(high.group.stages, low.group!.stages),
            ...(high.group.errors === undefined ? {} : { errors: high.group.errors.map((e, at) => ({ ...e, low: low.group!.errors![at]!.low })) }),
            lost: { low: Math.min(low.group!.lost.low, high.group.lost.low), high: Math.max(low.group!.lost.high, high.group.lost.high) },
          },
        }),
  };
};

/** These are the cells of the plan that are another cell of this catalog. */
export const T11_MONGO_ALIASES: readonly Alias[] = [
  { plan: "T11.border-off.9", is: "T11.defaults.9", why: "the loss of the primary: the members find it DOWN, then elect" },
  { plan: "T11.border-off.10", is: "T11.defaults.1", why: "a step-down: the hand-off elects the new primary at once" },
  { plan: "T11.border-off.23", is: "T11.defaults.8", why: "the write-off at the defaults, 40 s, comes after the election" },
  { plan: "T11.border-off.47", is: "T11.border-off.24", why: "the tuned write-off at 7 s: the retry waits for the new primary inside serverSelectionTimeoutMS" },
  { plan: "T11.border-off.33", is: "T11.border-off.39", why: "a frozen primary with its kernel up: inside the write-off" },
  { plan: "T11.border-off.34", is: "T11.border-off.40", why: "a frozen primary with its kernel up: outside the write-off" },
  { plan: "T11.border-off.65", is: "T11.defaults.10", why: "w majority, the default: the cut primary acknowledges no write" },
  { plan: "T11.border-off.67", is: "T11.defaults.10", why: "catchUpTimeoutMillis -1, the default" },
];

const NOT_THIS = "the breakpoint names another system's setting: this chain has no such knob";
/** These are the reasons of the waiting border cells of T11, by range. */
const REASONS: ReadonlyArray<readonly [number, number, string]> = [
  [1, 2, NOT_THIS],
  [3, 4, "the harness has no CPU limit of a member"],
  [7, 8, NOT_THIS],
  [11, 22, NOT_THIS],
  [25, 30, NOT_THIS],
  [35, 36, NOT_THIS],
  [37, 38, "no document gives the sequence of the timers of Node that are late after a block of its event loop"],
  [41, 42, NOT_THIS],
  [43, 44, "the driver has no reconnect schedule of its own: T11.border-off.47 and .48 place its one retry"],
  [45, 46, "the attempts are two at the defaults: T11.border-off.47 and .48 place the second one"],
  [49, 50, "the harness has no CPU limit of a member, and no document gives the service time under load"],
  [51, 52, NOT_THIS],
  [53, 60, "the harness has no planned stop of a member with a grace period"],
  [61, 64, NOT_THIS],
  [69, 76, NOT_THIS],
  [77, 78, "the rule compares the liveness probe of a pod: no pod is on this chain"],
];

/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T11_MONGO_WAITING: readonly Waiting[] = [
  { plan: "T11.defaults.13", trigger: "event:broker-drain", why: "a drain of a broker is an event of RabbitMQ: a replica set has no brokers" },
  { plan: "T11.defaults.14", trigger: "event:node-drain", why: "nodetool drain is an event of Cassandra: mongod has no such command" },
  { plan: "T11.defaults.15", trigger: "cpu-throttle", why: "the harness has no CPU limit of a member" },
  { plan: "T11.defaults.16", trigger: "event:rolling-upgrade", why: "the harness has no restart of a member on a second image" },
  { plan: "T11.defaults.17", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  { plan: "T11.defaults.18", trigger: "event:restore-without-volume", why: "the harness has no restart of a member without its volume" },
  ...REASONS.flatMap(([from, to, why]) =>
    Array.from({ length: to - from + 1 }, (_, at) => from + at).map((n): Waiting => ({ plan: `T11.border-off.${n}`, trigger: "border", why })),
  ),
];

/** This function gives the name of a cell of T11: the cell of the plan, then the rest. */
export const nameOfT11 = (spec: MongoSpec): string => `${spec.plan} mongodb-node-7.7 to mongodb-replset of three, ${spec.name}`;

/** These are the cells of the MongoDB catalog of T11, with their predictions. */
export const T11_MONGO: readonly MongoCell[] = T11_MONGO_SPECS.map((spec) => ({ spec, name: nameOfT11(spec), prediction: predictT11(spec) }));
