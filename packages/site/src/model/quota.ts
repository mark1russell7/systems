/**
 * The quota of a key: the model behind the page `lab/quota`. The reader takes units, gives units back and
 * moves the clock. Each step is the pure step `quotaStep` of `@mark1russell7/service/limiter`. The page copies
 * none of its arithmetic of dates. The bounds of a window and the test of a bucket come from probes of that step.
 */
import { localTime } from "@mark1russell7/automata/clock";
import type { Quantity } from "@mark1russell7/quantity";
import { quotaRule, quotaStep, type QuotaRecord, type QuotaRule, type QuotaSpec, type QuotaState, type QuotaVerdict } from "@mark1russell7/service/limiter";
import { duration } from "../lib/format.ts";

const MINUTE = 60_000;

/** The limit of each preset: 4 units in a window. With a small limit, a reader fills the window with a few clicks. */
export const LIMIT = 4;

/** A preset is one quota, and a first instant that shows one case of its window. */
export interface Preset {
  readonly id: string;
  readonly label: string;
  /** The zone of the clock of the page. */
  readonly zone: string;
  readonly spec: QuotaSpec;
  readonly rule: QuotaRule;
  /** The first instant of the lab, in milliseconds from 1970-01-01T00:00:00Z. */
  readonly start: number;
  /** The case that the preset shows. */
  readonly note: string;
}

const count = (value: number): Quantity => ({ value, unit: "count" });

/** This function gives a quota of 4 units for each day in `zone`. The day starts at `hour` on the clock of the zone. */
const daily = (zone: string, hour: number): QuotaSpec => ({
  limit: count(LIMIT),
  reserve: count(0),
  window: { kind: "calendar", unit: "day", zone, start: { value: hour, unit: "h" } },
});

const preset = (fields: Omit<Preset, "rule">): Preset => ({ ...fields, rule: quotaRule(fields.id, fields.spec) });

export const PRESETS: readonly Preset[] = [
  preset({
    id: "back",
    label: "Clocks go back",
    zone: "America/Chicago",
    spec: daily("America/Chicago", 0),
    start: Date.parse("2026-11-01T06:30:00Z"),
    note: "On 1 November 2026 at 02:00, the clocks of Chicago go back to 01:00. That day has 25 hours, and its window counts each of them.",
  }),
  preset({
    id: "forward",
    label: "Clocks go forward",
    zone: "America/Chicago",
    spec: daily("America/Chicago", 0),
    start: Date.parse("2026-03-08T07:30:00Z"),
    note: "On 8 March 2026 at 02:00, the clocks of Chicago go forward to 03:00. That day has 23 hours.",
  }),
  preset({
    id: "skipped",
    label: "No midnight",
    zone: "America/Santiago",
    spec: daily("America/Santiago", 0),
    start: Date.parse("2026-09-06T03:30:00Z"),
    note: "On 6 September 2026, the clocks of Santiago go from 00:00 to 01:00. That day has no midnight, thus its window starts at 01:00.",
  }),
  preset({
    id: "half",
    label: "Half-hour zone",
    zone: "Asia/Kolkata",
    spec: daily("Asia/Kolkata", 6),
    start: Date.parse("2026-11-14T00:00:00Z"),
    note: "The day of this quota starts at 06:00 in Kolkata, 5 h 30 min ahead of UTC. At 05:30, the window of the day before still counts.",
  }),
  preset({
    id: "rolling",
    label: "Rolling hour",
    zone: "UTC",
    spec: { limit: count(LIMIT), reserve: count(0), window: { kind: "rolling", span: { value: 1, unit: "h" }, buckets: count(6) } },
    start: Date.parse("2026-11-14T15:03:00Z"),
    note: "The window is the last hour, in 6 buckets of 10 min. A unit stops counting when its whole bucket is more than one hour old: 60 to 70 min after its take.",
  }),
];

const TAKE_ONE = { type: "take", units: 1 } as const;
const READ = { type: "read" } as const;

/** This function gives the start of the bucket of the instant `t`: the start that a take at `t` writes in an empty record. */
export const bucketOf = (rule: QuotaRule, t: number): number => {
  const bucket = quotaStep(rule, undefined, t, TAKE_ONE).record.spent[0];
  if (bucket === undefined) throw new Error(`a take of 1 unit at ${new Date(t).toISOString()} wrote no bucket`);
  return bucket[0];
};

/** This function tells if a unit that a take at the instant `t` counted still counts at the instant `at`. */
export const counts = (rule: QuotaRule, t: number, at: number): boolean => quotaStep(rule, { spent: [[bucketOf(rule, t), 1]] }, at, READ).state.used > 0;

/** The frame of a strip starts at the oldest bucket that counts at an instant. It ends at the end of the bucket of that instant. */
export interface Frame {
  readonly from: number;
  readonly to: number;
  /** The start of each bucket in the frame, the oldest first. */
  readonly buckets: readonly number[];
}

/** This function gives the frame of the instant `at`. A rolling window has at most 1000 buckets, and each step goes back one bucket. */
export const frameOf = (rule: QuotaRule, at: number): Frame => {
  const current = bucketOf(rule, at);
  const buckets = [current];
  for (let start = bucketOf(rule, current - 1); buckets.length <= 1000 && counts(rule, start, at); start = bucketOf(rule, start - 1)) buckets.unshift(start);
  // a calendar window is one bucket, and its units stop counting at the start of the next window
  const to = rule.window.kind === "calendar" ? (quotaStep(rule, undefined, at, TAKE_ONE).state.resetAt ?? at) : current + (current - bucketOf(rule, current - 1));
  return { from: buckets[0] ?? current, to, buckets };
};

/** This function gives the start of each bucket from the bucket of `from` to the bucket of `to`, the oldest first. It goes back one bucket at each step, at most 1000 steps. */
export const bucketsBetween = (rule: QuotaRule, from: number, to: number): number[] => {
  const starts: number[] = [];
  for (let start = bucketOf(rule, to); starts.length < 1000; start = bucketOf(rule, start - 1)) {
    starts.unshift(start);
    if (start <= from) break;
  }
  return starts;
};

const offsetAt = (t: number, zone: string): number => localTime(t, zone)?.offset ?? 0;

/** This function writes the wall clock at the instant `t` for an offset from UTC in minutes, as 01:30. */
const wall = (t: number, offset: number): string => new Date(t + offset * MINUTE).toISOString().slice(11, 16);

/** This function writes the clock of `zone` at the instant `t`, as 01:30. */
export const clockOf = (t: number, zone: string): string => wall(t, offsetAt(t, zone));

/** This function writes an offset from UTC in minutes, as UTC−5 or UTC+5:30. */
export const offsetText = (minutes: number): string => {
  if (minutes === 0) return "UTC";
  const size = Math.abs(minutes);
  const rest = size % 60;
  return `UTC${minutes < 0 ? "−" : "+"}${Math.floor(size / 60)}${rest === 0 ? "" : `:${String(rest).padStart(2, "0")}`}`;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** This function writes the instant `t` on the clock of `zone`, as Sun 1 Nov, 01:30 UTC−5. The offset tells the two 01:30 of a day apart. */
export const stamp = (t: number, zone: string): string => {
  const local = localTime(t, zone);
  if (local === undefined) return new Date(t).toISOString();
  return `${DAYS[local.weekday] ?? ""} ${local.day} ${MONTHS[local.month - 1] ?? ""}, ${wall(t, local.offset)} ${offsetText(local.offset)}`;
};

/** A shift is an instant at which the clock of a zone goes forward or back. */
export interface Shift {
  readonly at: number;
  /** The wall clock before the shift, as 02:00. */
  readonly before: string;
  /** The wall clock after the shift, as 01:00. */
  readonly after: string;
}

/**
 * This function gives the shifts of the clock of `zone` from `from` to `to`. It reads the offset each 15 min, and a
 * binary search finds the instant of each change to the millisecond. No zone changes its offset twice in 15 min.
 */
export const shiftsOf = (zone: string, from: number, to: number): Shift[] => {
  const shifts: Shift[] = [];
  let low = from;
  let before = offsetAt(from, zone);
  while (low < to) {
    const high = Math.min(low + 15 * MINUTE, to);
    const after = offsetAt(high, zone);
    if (after !== before) {
      // the offset is `before` at `a`, and `after` at `b`
      let [a, b] = [low, high];
      while (b - a > 1) {
        const middle = Math.floor((a + b) / 2);
        if (offsetAt(middle, zone) === before) a = middle;
        else b = middle;
      }
      shifts.push({ at: b, before: wall(b, before), after: wall(b, after) });
      before = after;
    }
    low = high;
  }
  return shifts;
};

/** A tick is a whole time of the wall clock on the axis of a strip. */
export interface Tick {
  readonly at: number;
  /** The wall clock, as 06:00. */
  readonly text: string;
  /** A major tick has a label. */
  readonly major: boolean;
}

/**
 * This function gives a tick each `every` minutes of the clock of `zone`, from `from` to `to`, and a label each
 * `major` minutes. The offset of each zone of 2026 is a whole count of 15 min. Thus each whole 5 min of its clock
 * is a whole 5 min of UTC, and the function reads the clock each 5 min.
 */
export const ticksOf = (zone: string, from: number, to: number, every: number, major: number): Tick[] => {
  const ticks: Tick[] = [];
  const step = 5 * MINUTE;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    const local = localTime(t, zone);
    if (local === undefined) continue;
    const minutes = local.hour * 60 + local.minute;
    if (minutes % every === 0) ticks.push({ at: t, text: wall(t, local.offset), major: minutes % major === 0 });
  }
  return ticks;
};

/** An act of the reader: a take of one unit, or the give-back of the unit of an earlier take. */
export type Act = { readonly kind: "take"; readonly at: number } | { readonly kind: "give-back"; readonly at: number; /** The index of the take in the acts. */ readonly take: number };

/** One step of a replay: the act, the state after it, and the verdict of a take. */
export interface Entry {
  readonly act: Act;
  readonly state: QuotaState;
  readonly verdict?: QuotaVerdict | undefined;
}

/** The mark of a take at the instant of the reader. */
export type TakeMark = "counted" | "refused" | "given back" | "expired";

export interface Replay {
  readonly entries: readonly Entry[];
  readonly record: QuotaRecord;
  /** The state at the instant of the reader. */
  readonly state: QuotaState;
  /** The mark of each take, by the index of its act. */
  readonly marks: ReadonlyMap<number, TakeMark>;
}

/**
 * This function replays the acts on an empty record, one pure step for each act, and reads the record at the
 * instant `at`. The acts are in the order of their instants, and no act is after `at`.
 */
export const replay = (rule: QuotaRule, acts: readonly Act[], at: number): Replay => {
  let record: unknown;
  const entries: Entry[] = [];
  for (const act of acts) {
    const step =
      act.kind === "take" ? quotaStep(rule, record, act.at, TAKE_ONE) : quotaStep(rule, record, act.at, { type: "give-back", units: 1, at: acts[act.take]?.at ?? act.at });
    record = step.record;
    entries.push({ act, state: step.state, verdict: step.verdict });
  }
  const end = quotaStep(rule, record, at, READ);
  // a give-back changes the count only while the bucket of its take counts
  const givenBack = new Set(acts.flatMap((act) => (act.kind === "give-back" && counts(rule, acts[act.take]?.at ?? act.at, act.at) ? [act.take] : [])));
  const marks = new Map<number, TakeMark>();
  entries.forEach((entry, n) => {
    if (entry.act.kind !== "take") return;
    marks.set(n, entry.verdict?.allowed !== true ? "refused" : givenBack.has(n) ? "given back" : counts(rule, entry.act.at, at) ? "counted" : "expired");
  });
  return { entries, record: end.record, state: end.state, marks };
};

/**
 * This function gives the first acts and the first instant of a preset: one take at its start, and one take one
 * hour later. In Chicago on the day of 25 hours, the two takes both stamp 01:30, with two offsets. In Santiago
 * and in Kolkata, the second take is in the next window, and the first take stops counting.
 */
export const opening = (preset: Preset): { readonly acts: readonly Act[]; readonly at: number } => {
  const later = preset.start + 60 * MINUTE;
  return { acts: [{ kind: "take", at: preset.start }, { kind: "take", at: later }], at: later };
};

/** This function gives the index of the newest take that still counts, or -1. The lab gives that take back. */
export const newestCounted = (result: Replay): number => {
  for (let n = result.entries.length - 1; n >= 0; n -= 1) if (result.marks.get(n) === "counted") return n;
  return -1;
};

/** The headline of the lab: a verdict, a title and one sentence. */
export interface Saying {
  readonly status: "good" | "critical" | "neutral";
  readonly verdict: string;
  readonly title: string;
  readonly detail: string;
}

/** This function gives the headline at the instant `at`. A refused take at that instant leads it. */
export const say = (result: Replay, zone: string, at: number): Saying => {
  const { state } = result;
  const until = (end: number): string => `${stamp(end, zone)}, in ${duration(end - at)}`;
  const last = result.entries.at(-1);
  const refusal = last?.act.kind === "take" && last.act.at === at && last.verdict !== undefined && !last.verdict.allowed ? last.verdict : undefined;
  if (refusal !== undefined)
    return {
      status: "critical",
      verdict: "Refused",
      title: `${String(state.used)} of ${String(LIMIT)} used`,
      detail: refusal.cause === "capacity" ? "The take is more than the limit." : `The next unit opens at ${until(refusal.resetAt)}.`,
    };
  return {
    status: state.left > 0 ? "good" : "neutral",
    verdict: state.left > 0 ? "Room" : "Full",
    title: `${String(state.used)} of ${String(LIMIT)} used, ${String(state.left)} left`,
    detail: state.resetAt === undefined ? "No unit counts in this window." : `The oldest unit stops counting at ${until(state.resetAt)}.`,
  };
};

/** One row of the table of the lab. */
export interface Row {
  readonly when: string;
  readonly what: string;
  readonly verdict: string;
  readonly used: number;
  readonly left: number;
  /** The mark of a take at the instant of the reader, or an empty text for a give-back. */
  readonly mark: string;
}

/** This function gives the rows of the table: one row for each act. Each take has a number, from 1. */
export const rowsOf = (result: Replay, zone: string): Row[] => {
  const numbers = new Map<number, number>();
  result.entries.forEach((entry, n) => {
    if (entry.act.kind === "take") numbers.set(n, numbers.size + 1);
  });
  return result.entries.map((entry, n): Row => {
    const { act, state, verdict } = entry;
    const what = act.kind === "take" ? `Take ${String(numbers.get(n))}` : `Give back take ${String(numbers.get(act.take))}`;
    const answer =
      verdict === undefined ? "given back" : verdict.allowed ? "allowed" : verdict.cause === "capacity" ? "refused: capacity" : `refused until ${clockOf(verdict.resetAt, zone)}`;
    return { when: stamp(act.at, zone), what, verdict: answer, used: state.used, left: state.left, mark: act.kind === "take" ? (result.marks.get(n) ?? "") : "" };
  });
};
