// The quota of a key: at most `limit` units in each window of a calendar or of a rolling span. A
// provider of an API gives such a quota, and the gate refuses a take over it before the provider
// does. The count of the gate is not lower than the count of the provider: a reading of the
// provider can make the count larger, but not smaller.
//
// A quota is data before it starts, with no defaults. Its pure step `quotaStep` takes the stored
// record, an instant and an event, and gives the next record and the state. A store applies the
// step to the record of one key in one atomic change. The time of a quota is the instant of a wall
// clock, because a calendar window needs civil time.

import type { WallClock } from "@mark1russell7/algebra/clock";
import { firstInstantOf, localTime } from "@mark1russell7/algebra/clock";
import type { Quantity } from "@mark1russell7/quantity";
import { countOf, finiteAbove, isCount, isTime, milliseconds, safely, wholeCount } from "./policy.ts";

/**
 * A rolling window counts the units of the last `span`. Use it when the provider does not tell when
 * its count starts again. The window puts each take in a time bucket. A unit counts until all of
 * its bucket is out of the window. Thus the count is not lower than the count of a fixed window.
 */
export interface RollingWindow {
  readonly kind: "rolling";
  /** This time is the length of the window, for example `{ value: 24, unit: "h" }`. */
  readonly span: Quantity;
  /** This count is the count of time buckets in the window: a whole count from 1 to 1000. */
  readonly buckets: Quantity;
}

/**
 * A calendar window counts the units of a day or of a month in a time zone. Each window starts at
 * the time of day `start`, on each day or on the first day of each month. When the clock of the
 * zone skips that time, the window starts at the end of the gap. When the clock shows that time
 * two times, the window starts at the first of the two.
 */
export interface CalendarWindow {
  readonly kind: "calendar";
  readonly unit: "day" | "month";
  /** The IANA name of the time zone, for example `America/Chicago` or `UTC`. */
  readonly zone: string;
  /** This time of day starts each window: from 0 to less than 24 hours, in whole milliseconds. */
  readonly start: Quantity;
}

/** A quota window is a rolling window or a calendar window. */
export type QuotaWindow = RollingWindow | CalendarWindow;

/** A quota spec is the declaration of a quota. It has no defaults. */
export interface QuotaSpec {
  /** This count is the count of units that the provider gives in one window. */
  readonly limit: Quantity;
  /** The gate keeps this count of units unused: from 0 to less than the limit. */
  readonly reserve: Quantity;
  readonly window: QuotaWindow;
  /**
   * This value is the longest block that a reading of the provider can set: a time above zero, or
   * `window`. A reading at the instant `t` blocks the key until `t` plus the time at the latest. With
   * `window`, the block ends at the latest when the bucket of `t` stops counting. Thus a reset of the
   * provider in a wrong form does not stop a key for much longer than one window. The step also
   * applies this bound to a block that the stored record keeps. When it is absent, no block has a bound.
   */
  readonly maxBlock?: Quantity | "window" | undefined;
}

/** A quota rule is a spec in numbers: each count as a number, and each time in milliseconds. */
export interface QuotaRule {
  readonly limit: number;
  readonly reserve: number;
  readonly window:
    | { readonly kind: "rolling"; readonly span: number; readonly buckets: number }
    | { readonly kind: "calendar"; readonly unit: "day" | "month"; readonly zone: string; readonly start: number };
  /** This value is the longest block in milliseconds, or `window`. When it is absent, no block has a bound. */
  readonly maxBlock?: number | "window" | undefined;
}

/**
 * A quota record is what a store keeps for one key. A store can keep it as JSON. Each instant is in
 * milliseconds from 1970-01-01T00:00:00Z.
 */
export interface QuotaRecord {
  /** Each item is a time bucket: its start, and its count of units. The oldest bucket is first. */
  readonly spent: readonly (readonly [start: number, units: number])[];
  /** The provider refused the key until this instant. */
  readonly blockedUntil?: number | undefined;
  /** This instant is the last reading of the provider with a count. A give-back for a take at or before it changes nothing. */
  readonly readAt?: number | undefined;
}

/** A quota reading is what an answer of the provider tells of its count. */
export interface QuotaReading {
  /** This count is the count of units that the provider gives before its next reset. */
  readonly remaining?: number | undefined;
  /**
   * This instant is the next reset of the provider. When `remaining` is 0 or absent, the gate
   * refuses each take until this instant.
   */
  readonly resetAt?: number | undefined;
}

/** A quota state is the state of one key at the instant `at`. */
export interface QuotaState {
  /** This instant is the instant of the step. */
  readonly at: number;
  /** This count is the count of units in the window. */
  readonly used: number;
  /** This count is the count of units that the gate gives: the limit, less the reserve and `used`. It is 0 while the provider refuses the key. */
  readonly left: number;
  /** The oldest units stop counting at this instant. With no unit in the window, it is absent. */
  readonly resetAt?: number | undefined;
  /** The provider refused the key until this instant. */
  readonly blockedUntil?: number | undefined;
}

/** A permitted take counted its units at the instant `state.at`. */
export interface QuotaAllowed {
  readonly allowed: true;
  readonly state: QuotaState;
}

/**
 * A wait refusal counted nothing. Its cause is `limit` when the window has no room for the units,
 * and `provider` when the provider refused the key. At `resetAt`, the gate gives the same take,
 * when no other take comes first.
 */
export interface QuotaWaitRefused {
  readonly allowed: false;
  readonly cause: "limit" | "provider";
  readonly resetAt: number;
  /** This time is the time from `state.at` to `resetAt`. It is always above zero. */
  readonly retryAfter: Quantity;
  readonly state: QuotaState;
}

/**
 * A capacity refusal counted nothing, and the gate refuses the same take at each time. Its units
 * are more than the `capacity` of one window: the limit less the reserve.
 */
export interface QuotaCapacityRefused {
  readonly allowed: false;
  readonly cause: "capacity";
  readonly units: number;
  readonly capacity: number;
  readonly state: QuotaState;
}

/** A quota refusal is a wait refusal or a capacity refusal. */
export type QuotaRefused = QuotaWaitRefused | QuotaCapacityRefused;

/** A quota verdict is the answer of a quota to one take. */
export type QuotaVerdict = QuotaAllowed | QuotaRefused;

/**
 * A quota event is one change of a key:
 * - `take`: count `units` for a call that starts at the instant of the step, or refuse it.
 * - `note`: add what an answer of the provider tells. The count can only become larger.
 * - `give-back`: remove `units` that a take counted at the instant `at`, for a call that did not
 *   start. It changes nothing when the bucket of `at` is out of the window, or when a reading of the
 *   provider came at or after `at`.
 * - `read`: change nothing, and give the state.
 */
export type QuotaEvent =
  | { readonly type: "take"; readonly units: number }
  | { readonly type: "note"; readonly reading: QuotaReading }
  | { readonly type: "give-back"; readonly units: number; readonly at: number }
  | { readonly type: "read" };

/** A quota step is the next record of a key and its state. Only a take gives a verdict. */
export interface QuotaStep {
  readonly record: QuotaRecord;
  readonly state: QuotaState;
  readonly verdict?: QuotaVerdict | undefined;
}

/** A take step is the step of a take: it always has a verdict. */
export interface QuotaTakeStep extends QuotaStep {
  readonly verdict: QuotaVerdict;
}

const MAX_BUCKETS = 1000;
const DAY_MS = 86_400_000;
/** The largest instant of a `Date`, in milliseconds from the epoch. */
const MAX_TIME = 8.64e15;
/**
 * This slack is a part of a count. A comparison of counts permits it. The reason: a sum of units
 * with a fraction is not exact in floating point, and 0.1 + 0.2 is more than 0.3.
 */
const SLACK = 1e-9;

/** This function tells if `total` is over `bound` by more than the slack. */
const over = (total: number, bound: number): boolean => total - bound > SLACK * Math.max(1, Math.abs(bound));

const isInstant = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_TIME;

const iso = (instant: number): string => (isInstant(instant) ? new Date(instant).toISOString() : String(instant));

/** A loose window is a window from any source, with each part optional, for the check of its parts. */
interface LooseWindow {
  readonly kind?: string;
  readonly span?: Quantity;
  readonly buckets?: Quantity;
  readonly unit?: string;
  readonly zone?: string;
  readonly start?: Quantity;
}

const atLeastZero = (amount: Quantity): boolean => typeof amount.value === "number" && Number.isFinite(amount.value) && amount.value >= 0;

/**
 * This function gives the problems of a quota spec. `keyedQuota` and `quotaRule` refuse a spec with
 * a problem. A part that is absent is a problem, because a quota has no defaults.
 */
export const quotaProblems = (name: string, spec: Partial<QuotaSpec> | undefined): string[] => {
  const owner = `quota ${name}`;
  if (spec === undefined || (spec as unknown) === null) return [`${owner} has no spec: a quota has no defaults`];
  const problems: string[] = [];
  const missing = (part: string): void => {
    problems.push(`${owner} does not declare ${part}: a quota has no defaults`);
  };
  let limit: number | undefined;
  if (spec.limit === undefined) missing("its limit (limit)");
  else if (!safely(isCount, spec.limit)) problems.push(`${owner}'s limit is not a count`);
  else if (!finiteAbove(spec.limit)) problems.push(`${owner}'s limit is not a finite count above zero`);
  else limit = countOf(spec.limit);
  if (spec.reserve === undefined) missing("its reserve (reserve), 0 for no reserve");
  else if (!safely(isCount, spec.reserve)) problems.push(`${owner}'s reserve is not a count`);
  else if (!atLeastZero(spec.reserve)) problems.push(`${owner}'s reserve is not a finite count of 0 or more`);
  else if (limit !== undefined && countOf(spec.reserve) >= limit) problems.push(`${owner}'s reserve is not less than its limit`);
  const window = spec.window as LooseWindow | undefined;
  if (window === undefined || (window as unknown) === null) missing("its window (window)");
  else if (window.kind === "rolling") {
    if (window.span === undefined) missing("the span of its window (window.span)");
    else if (!safely(isTime, window.span)) problems.push(`${owner}'s span is not a time`);
    else if (!finiteAbove(window.span)) problems.push(`${owner}'s span is not a finite time above zero`);
    if (window.buckets === undefined) missing("the count of buckets of its window (window.buckets)");
    else if (!safely(isCount, window.buckets)) problems.push(`${owner}'s buckets is not a count`);
    else if (!wholeCount(window.buckets) || countOf(window.buckets) > MAX_BUCKETS)
      problems.push(`${owner}'s buckets is not a whole count from 1 to ${String(MAX_BUCKETS)}`);
  } else if (window.kind === "calendar") {
    if (window.unit === undefined) missing("the unit of its window (window.unit)");
    else if (window.unit !== "day" && window.unit !== "month") problems.push(`${owner}'s unit is not day or month`);
    if (window.zone === undefined) missing("the time zone of its window (window.zone)");
    else if (typeof window.zone !== "string" || localTime(0, window.zone) === undefined)
      problems.push(`${owner}'s zone is not an IANA time zone: ${String(window.zone)}`);
    if (window.start === undefined) missing("the time of day that starts its window (window.start), 0 h for midnight");
    else if (!safely(isTime, window.start)) problems.push(`${owner}'s start is not a time`);
    else if (!atLeastZero(window.start) || !Number.isInteger(milliseconds(window.start)) || milliseconds(window.start) >= DAY_MS)
      problems.push(`${owner}'s start is not a whole count of milliseconds from 0 to less than 24 h`);
  } else problems.push(`${owner}'s window is not rolling or calendar`);
  const { maxBlock } = spec;
  if (maxBlock !== undefined && maxBlock !== "window") {
    if (typeof maxBlock !== "object" || maxBlock === null || !safely(isTime, maxBlock)) problems.push(`${owner}'s maxBlock is not a time or "window"`);
    else if (!finiteAbove(maxBlock)) problems.push(`${owner}'s maxBlock is not a finite time above zero`);
  }
  return problems;
};

/** This function gives the rule of a quota spec. It throws an error with the problems of a spec that has a problem. */
export const quotaRule = (name: string, spec: QuotaSpec): QuotaRule => {
  const problems = quotaProblems(name, spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { window, maxBlock } = spec;
  return {
    limit: countOf(spec.limit),
    reserve: countOf(spec.reserve),
    window:
      window.kind === "rolling"
        ? { kind: "rolling", span: milliseconds(window.span), buckets: countOf(window.buckets) }
        : { kind: "calendar", unit: window.unit, zone: window.zone, start: milliseconds(window.start) },
    ...(maxBlock === undefined ? {} : { maxBlock: maxBlock === "window" ? "window" : milliseconds(maxBlock) }),
  };
};

/** The buckets of a window: the bucket of an instant, and the test of a bucket. */
interface Buckets {
  /** This function gives the start and the end of the bucket of the instant `t`. */
  bucket(t: number): readonly [start: number, end: number];
  /**
   * This function gives the test of the buckets that count at the instant `t`. A bucket of a later
   * window counts too: after a step back of the clock, the takes of that window still count.
   */
  counting(t: number): (start: number) => boolean;
  /** This function gives the instant at which the bucket that starts at `start` stops counting. */
  freeAt(start: number): number;
}

/** This function gives the calendar window of the instant `t`: its start, and the start of the next window. */
const calendarOf = (unit: "day" | "month", zone: string, start: number, t: number): readonly [number, number] => {
  const local = localTime(t, zone);
  if (local === undefined) throw new RangeError(`the instant ${String(t)} is not a date in the zone ${zone}`);
  const { year, month, day } = local;
  // the start of the window that is `back` windows before the window of the date of `t`
  const startOf = (back: number): number => {
    const wall = (unit === "day" ? Date.UTC(year, month - 1, day - back) : Date.UTC(year, month - 1 - back, 1)) + start;
    const instant = firstInstantOf(wall, zone);
    if (instant === undefined) throw new RangeError(`the clock of ${zone} does not show or skip the local time ${iso(wall)}`);
    return instant;
  };
  const first = startOf(0);
  return first <= t ? [first, startOf(-1)] : [startOf(1), first];
};

const bucketsOf = (window: QuotaRule["window"]): Buckets => {
  if (window.kind === "rolling") {
    const { span } = window;
    const size = Math.ceil(span / window.buckets);
    return {
      bucket: (t) => {
        const start = Math.floor(t / size) * size;
        return [start, start + size];
      },
      counting: (t) => (start) => start + size + span > t,
      freeAt: (start) => start + size + span,
    };
  }
  const { unit, zone, start } = window;
  return {
    bucket: (t) => calendarOf(unit, zone, start, t),
    // only the windows before the window of `t` stop counting
    counting: (t) => {
      const [first] = calendarOf(unit, zone, start, t);
      return (bucket) => bucket >= first;
    },
    freeAt: (bucket) => calendarOf(unit, zone, start, bucket)[1],
  };
};

/**
 * This function gives the record of a store. A value that is not a record gives an empty record.
 * The function removes each item that is not valid and keeps the other items, thus the count stays
 * as high as the record lets it. It adds the items of one bucket together.
 */
const recordOf = (value: unknown): QuotaRecord => {
  if (typeof value !== "object" || value === null) return { spent: [] };
  const { spent, blockedUntil, readAt } = value as { spent?: unknown; blockedUntil?: unknown; readAt?: unknown };
  const counts = new Map<number, number>();
  if (Array.isArray(spent))
    for (const item of spent as unknown[]) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [start, units] = item as unknown[];
      if (isInstant(start) && typeof units === "number" && Number.isFinite(units) && units > 0) counts.set(start, (counts.get(start) ?? 0) + units);
    }
  const items = [...counts].sort((a, b) => a[0] - b[0]);
  return {
    spent: items,
    ...(isInstant(blockedUntil) ? { blockedUntil } : {}),
    ...(isInstant(readAt) ? { readAt } : {}),
  };
};

/** This function removes the buckets that do not count at the instant `t`, an ended refusal, and a reading that no give-back can meet. */
const prune = (buckets: Buckets, record: QuotaRecord, t: number): QuotaRecord => {
  const counts = buckets.counting(t);
  const { blockedUntil, readAt } = record;
  return {
    spent: record.spent.filter(([start]) => counts(start)),
    ...(blockedUntil !== undefined && blockedUntil > t ? { blockedUntil } : {}),
    // a give-back changes only a bucket that counts, and each such bucket starts after the bucket of an older reading
    ...(readAt !== undefined && counts(buckets.bucket(readAt)[0]) ? { readAt } : {}),
  };
};

/**
 * This function applies the bound of the rule to the block of a record at the instant `t`. The
 * block ends at `t` plus the longest block at the latest. With `window`, it ends at the latest when
 * the bucket of `t` stops counting. The bound is after `t`, thus a capped block stays a block.
 */
const capBlock = (rule: QuotaRule, buckets: Buckets, record: QuotaRecord, t: number): QuotaRecord => {
  const { maxBlock } = rule;
  const { blockedUntil } = record;
  if (maxBlock === undefined || blockedUntil === undefined) return record;
  const bound = maxBlock === "window" ? buckets.freeAt(buckets.bucket(t)[0]) : t + maxBlock;
  return blockedUntil > bound ? { ...record, blockedUntil: bound } : record;
};

const usedOf = (record: QuotaRecord): number => record.spent.reduce((sum, [, units]) => sum + units, 0);

/** This function adds units to the bucket of the instant `t`. */
const add = (buckets: Buckets, record: QuotaRecord, t: number, units: number): QuotaRecord => {
  const [start] = buckets.bucket(t);
  let found = false;
  const spent = record.spent.map(([at, count]): readonly [number, number] => {
    if (at !== start) return [at, count];
    found = true;
    return [at, count + units];
  });
  if (!found) spent.push([start, units]);
  spent.sort((a, b) => a[0] - b[0]);
  return { ...record, spent };
};

/** This function gives the instant at which `need` units of the oldest buckets stop counting. */
const freeTime = (buckets: Buckets, record: QuotaRecord, need: number): number | undefined => {
  let freed = 0;
  for (const [start, units] of record.spent) {
    freed += units;
    if (!over(need, freed)) return buckets.freeAt(start);
  }
  return undefined;
};

const stateOf = (rule: QuotaRule, buckets: Buckets, record: QuotaRecord, t: number): QuotaState => {
  const used = usedOf(record);
  const oldest = record.spent[0];
  const { blockedUntil } = record;
  return {
    at: t,
    used,
    left: blockedUntil === undefined ? Math.max(0, rule.limit - rule.reserve - used) : 0,
    ...(oldest === undefined ? {} : { resetAt: buckets.freeAt(oldest[0]) }),
    ...(blockedUntil === undefined ? {} : { blockedUntil }),
  };
};

/** This function checks the units of a take or of a give-back: a finite count of 0 or more. */
const checkUnits = (units: unknown): number => {
  if (typeof units !== "number" || !Number.isFinite(units) || units < 0) throw new RangeError(`the units of a quota are not a finite count of 0 or more: ${String(units)}`);
  return units;
};

/** This function checks an event before a store gets it, thus a store does not start a change for an event that is not valid. */
const checkEvent = (event: QuotaEvent): void => {
  if (event.type === "take") checkUnits(event.units);
  else if (event.type === "give-back") {
    checkUnits(event.units);
    if (!isInstant(event.at)) throw new RangeError(`the instant of a give-back is not a date: ${String(event.at)}`);
  }
};

/**
 * This function is the pure step of a quota. It reads the stored record of one key at the instant
 * `instant`, applies the event, and gives the next record and the state. It removes what does not
 * count at the instant first. Only a take can be refused, and a refusal counts nothing.
 * - A take of 0 units is permitted and counts nothing, also while the provider refuses the key.
 * - A take over the capacity is refused with the cause `capacity`.
 * - While the provider refuses the key, a take is refused with the cause `provider`. Its `resetAt`
 *   is the end of that refusal, or a later instant when the window has room for the units.
 * - A take over the room of the window is refused with the cause `limit`, until enough of the
 *   oldest units stop counting.
 * - With `maxBlock` in the rule, a block ends at the latest at the bound of the instant. The step
 *   applies the bound to the stored block before the event, and to the block of a note after it.
 *
 * It throws a `RangeError` for an instant that is not a date, and for units that are not a finite
 * count of 0 or more.
 */
export function quotaStep(rule: QuotaRule, stored: unknown, instant: number, event: Extract<QuotaEvent, { type: "take" }>): QuotaTakeStep;
export function quotaStep(rule: QuotaRule, stored: unknown, instant: number, event: QuotaEvent): QuotaStep;
export function quotaStep(rule: QuotaRule, stored: unknown, instant: number, event: QuotaEvent): QuotaStep {
  if (!isInstant(instant)) throw new RangeError(`the instant of a quota step is not a date: ${String(instant)}`);
  checkEvent(event);
  const buckets = bucketsOf(rule.window);
  // the bound of the rule applies to the stored block before the event, thus the step writes back the capped record
  const record = capBlock(rule, buckets, prune(buckets, recordOf(stored), instant), instant);
  const done = (next: QuotaRecord): QuotaStep => ({ record: next, state: stateOf(rule, buckets, next, instant) });
  switch (event.type) {
    case "read":
      return done(record);
    case "note": {
      let next = record;
      const { remaining, resetAt } = event.reading;
      if (typeof remaining === "number" && Number.isFinite(remaining) && remaining >= 0) {
        const more = rule.limit - remaining - usedOf(next);
        if (over(more, 0)) next = add(buckets, next, instant, more);
        next = { ...next, readAt: Math.max(next.readAt ?? instant, instant) };
      }
      const exhausted = remaining === undefined || remaining <= 0;
      if (exhausted && isInstant(resetAt) && resetAt > instant)
        next = capBlock(rule, buckets, { ...next, blockedUntil: Math.max(next.blockedUntil ?? resetAt, resetAt) }, instant);
      return done(next);
    }
    case "give-back": {
      const { units, at } = event;
      if (units === 0 || (record.readAt !== undefined && record.readAt >= at)) return done(record);
      const [start] = buckets.bucket(at);
      if (!record.spent.some(([bucket]) => bucket === start)) return done(record);
      const spent: (readonly [number, number])[] = [];
      for (const [bucket, count] of record.spent) {
        const left = bucket === start ? count - Math.min(units, count) : count;
        if (over(left, 0)) spent.push([bucket, left]);
      }
      return done({ ...record, spent });
    }
    case "take": {
      const { units } = event;
      const allowed = rule.limit - rule.reserve;
      const refuse = (verdict: QuotaRefused): QuotaTakeStep => ({ record, state: verdict.state, verdict });
      const state = stateOf(rule, buckets, record, instant);
      if (units === 0) return { record, state, verdict: { allowed: true, state } };
      if (over(units, allowed)) return refuse({ allowed: false, cause: "capacity", units, capacity: allowed, state });
      const used = usedOf(record);
      // the need is not more than the units of the window, because the units are not over the capacity
      const free = over(used + units, allowed) ? (freeTime(buckets, record, used + units - allowed) ?? buckets.bucket(instant)[1]) : undefined;
      const wait = (cause: "limit" | "provider", resetAt: number): QuotaTakeStep =>
        refuse({ allowed: false, cause, resetAt, retryAfter: { value: resetAt - instant, unit: "ms" }, state });
      if (record.blockedUntil !== undefined) return wait("provider", Math.max(record.blockedUntil, free ?? record.blockedUntil));
      if (free !== undefined) return wait("limit", free);
      const next = done(add(buckets, record, instant, units));
      return { ...next, verdict: { allowed: true, state: next.state } };
    }
  }
}

/** A quota answer is a value at once for a store that answers at once, else a promise. */
export type QuotaAnswer<Sync extends boolean, T> = Sync extends true ? T : Promise<T>;

/** A quota change is what a step gives a store: the record to keep, and the result for the caller. */
export interface QuotaChange<T> {
  readonly record: QuotaRecord;
  readonly result: T;
}

/**
 * A quota store keeps the record of each quota and key, and it changes one record in one atomic
 * step. Thus two takes of one key do not read the same record. A store of this process can answer
 * at once (`sync: true`), for example a store in memory or in SQLite. A store that the replicas
 * share answers with a promise (`sync: false`).
 */
export interface QuotaStore<Sync extends boolean = boolean> {
  readonly sync: Sync;
  /**
   * This method gives `step` the stored record of the quota and the key, or undefined for a new key.
   * It keeps the record that `step` gives, and it gives the result. The record of a new key is
   * empty: a store can remove a key whose record has no item and no instant. A store can call
   * `step` again, for example after a conflict of a write. Thus `step` must have no other effect.
   */
  change<T>(quota: string, key: string, step: (stored: unknown) => QuotaChange<T>): QuotaAnswer<Sync, T>;
}

/** A memory quota store is the store of one process. Its records are in memory. */
export interface MemoryQuotaStore extends QuotaStore<true> {
  /** This method gives the count of keys that the store holds for a quota. */
  size(quota: string): number;
}

/** This function tells if a record is equal to the record of a new key. */
const isEmpty = (record: QuotaRecord): boolean => record.spent.length === 0 && record.blockedUntil === undefined && record.readAt === undefined;

/**
 * This function makes a store of records in memory. Each quota of one process can share it, and it
 * keeps the records of each quota apart. It removes a key when its record is equal to the record
 * of a new key. It does not sweep the other keys: use it for a set of keys with a bound, for
 * example the accounts of an API.
 */
export const memoryQuotaStore = (): MemoryQuotaStore => {
  const tables = new Map<string, Map<string, QuotaRecord>>();
  return {
    sync: true,
    change(quota, key, step) {
      let table = tables.get(quota);
      if (table === undefined) {
        table = new Map();
        tables.set(quota, table);
      }
      const { record, result } = step(table.get(key));
      if (isEmpty(record)) table.delete(key);
      else table.set(key, record);
      if (table.size === 0) tables.delete(quota);
      return result;
    },
    size(quota) {
      return tables.get(quota)?.size ?? 0;
    },
  };
};

/** A keyed quota is the runtime of one quota: its spec, its rule in numbers, its store and its wall clock. */
export interface KeyedQuota<Sync extends boolean = boolean> {
  /** This name is the quota. A store keeps the keys of each quota apart. */
  readonly name: string;
  readonly spec: QuotaSpec;
  readonly rule: QuotaRule;
  /** True: each method gives its answer at once. False: each method gives a promise. */
  readonly sync: Sync;
  /** This method counts `units` units (1 when absent) for a call of the key that starts at this instant, or refuses the call. */
  take(key: string, units?: number): QuotaAnswer<Sync, QuotaVerdict>;
  /** This method adds what an answer of the provider tells. The count can only become larger. */
  note(key: string, reading: QuotaReading): QuotaAnswer<Sync, QuotaState>;
  /** This method removes `units` that a take counted at the instant `at`, for a call that did not start. */
  giveBack(key: string, units: number, at: number): QuotaAnswer<Sync, QuotaState>;
  /** This method gives the state of the key, and changes nothing. */
  state(key: string): QuotaAnswer<Sync, QuotaState>;
}

/** This function tells if a value is a promise. */
const isPromise = (value: unknown): value is Promise<unknown> =>
  typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";

/**
 * This function makes the runtime of a quota from its spec, its store and a wall clock. It refuses
 * a spec with a problem, because a quota has no defaults. It reads the instant inside the change of
 * the store, thus a store that waits for a lock reads the instant after the wait.
 * - With a store that answers at once, each method answers at once. A `RangeError` throws, and a
 *   store that gives a promise throws an error.
 * - With a store that answers with a promise, each method gives a promise. A `RangeError` rejects.
 */
export function keyedQuota<Sync extends boolean>(
  name: string,
  spec: QuotaSpec,
  store: QuotaStore<Sync>,
  clock: Pick<WallClock, "time" | "now">,
): KeyedQuota<Sync> {
  const rule = quotaRule(name, spec);
  if (clock.time !== "wall") throw new Error(`quota ${name} needs a wall clock, which gives the instant: a calendar window needs civil time`);
  const answer = <T>(compute: () => T | Promise<T>): QuotaAnswer<Sync, T> => {
    if (!store.sync) return (async () => compute())() as QuotaAnswer<Sync, T>;
    const value = compute();
    if (isPromise(value)) {
      // the change of the store happened: its promise has the result, and its rejection is not left unhandled
      value.then(undefined, () => {});
      throw new Error(`quota ${name} has a store that says it answers at once, but its change gave a promise`);
    }
    return value as QuotaAnswer<Sync, T>;
  };
  const change = <T>(key: string, event: QuotaEvent, pick: (step: QuotaStep) => T): QuotaAnswer<Sync, T> =>
    answer(() => {
      checkEvent(event);
      return store.change(name, key, (stored) => {
        const step = quotaStep(rule, stored, clock.now(), event);
        return { record: step.record, result: pick(step) };
      }) as T | Promise<T>;
    });
  const verdictOf = (step: QuotaStep): QuotaVerdict => step.verdict as QuotaVerdict;
  const stateOfStep = (step: QuotaStep): QuotaState => step.state;
  const { window, maxBlock } = spec;
  return {
    name,
    spec: {
      limit: { ...spec.limit },
      reserve: { ...spec.reserve },
      window:
        window.kind === "rolling"
          ? { kind: "rolling", span: { ...window.span }, buckets: { ...window.buckets } }
          : { kind: "calendar", unit: window.unit, zone: window.zone, start: { ...window.start } },
      ...(maxBlock === undefined ? {} : { maxBlock: maxBlock === "window" ? "window" : { ...maxBlock } }),
    },
    rule,
    sync: store.sync,
    take: (key, units = 1) => change(key, { type: "take", units }, verdictOf),
    note: (key, reading) => change(key, { type: "note", reading: { ...reading } }, stateOfStep),
    giveBack: (key, units, at) => change(key, { type: "give-back", units, at }, stateOfStep),
    state: (key) => change(key, { type: "read" }, stateOfStep),
  };
}

/**
 * A quota part is one take of a multi-quota take: a quota, a key, and the units of the take. The
 * quota needs only `sync`, `take` and `giveBack`. Thus a gate of your own with these members can be
 * a part, and a `KeyedQuota` is one.
 */
export interface QuotaPart<Sync extends boolean = boolean> {
  readonly quota: Pick<KeyedQuota<Sync>, "sync" | "take" | "giveBack">;
  readonly key: string;
  readonly units: number;
}

/**
 * A quotas verdict is the answer of a take of several quotas, all or none. Each state is the state
 * of its part after the take, and after the give-back of a refused take.
 * - A permitted take counted the units of each part.
 * - A refused take counted nothing. `refusal` is the refusal of the part `index`: the first
 *   capacity refusal, else the wait refusal with the latest `resetAt`.
 */
export type QuotasVerdict =
  | { readonly allowed: true; readonly states: readonly QuotaState[] }
  | { readonly allowed: false; readonly index: number; readonly refusal: QuotaRefused; readonly states: readonly QuotaState[] };

/** The options of `takeQuotas`. */
export interface TakeQuotasOptions {
  /**
   * This function gets each error of a give-back, with the index of its part. The units of that
   * part stay counted, thus its quota refuses sooner, not later. It gets the errors after the last
   * give-back, thus its own error stops no give-back. An error that it throws ends the take.
   */
  readonly onGiveBackError?: ((error: unknown, index: number) => void) | undefined;
}

/** A request of the walk of a multi-quota take: a call of one method of a quota. */
type Request = () => unknown;

/** A walk gives a verdict or the error of a failed take, and the errors of the give-backs. */
type Walked = { readonly failures: readonly { readonly index: number; readonly error: unknown }[] } & (
  | { readonly verdict: QuotasVerdict }
  | { readonly error: unknown }
);

/** This function tells which refusal decides: a capacity refusal, else the latest `resetAt`. The first part wins a tie. */
const decisive = (verdicts: readonly QuotaVerdict[]): number => {
  let best = -1;
  for (let index = 0; index < verdicts.length; index += 1) {
    const verdict = verdicts[index]!;
    if (verdict.allowed) continue;
    const current = best < 0 ? undefined : (verdicts[best] as QuotaRefused);
    if (current === undefined) best = index;
    else if (current.cause === "capacity") continue;
    else if (verdict.cause === "capacity" || verdict.resetAt > current.resetAt) best = index;
  }
  return best;
};

/**
 * This walk takes each part in order, then gives back the counted parts of a refused or failed
 * take. The driver answers each request. A failed give-back does not stop the next give-backs.
 * The walk keeps its error, and the state of its part is the state after the take.
 */
function* walk(parts: readonly QuotaPart[]): Generator<Request, Walked, unknown> {
  const verdicts: QuotaVerdict[] = [];
  const failures: { readonly index: number; readonly error: unknown }[] = [];
  /** This walk gives back the units of a part, and gives the state after the give-back, or after the take when the give-back fails. */
  function* giveBack(index: number): Generator<Request, QuotaState, unknown> {
    const verdict = verdicts[index]!;
    const part = parts[index]!;
    if (!verdict.allowed || part.units === 0) return verdict.state;
    try {
      return (yield () => part.quota.giveBack(part.key, part.units, verdict.state.at)) as QuotaState;
    } catch (error) {
      failures.push({ index, error });
      return verdict.state;
    }
  }
  try {
    for (const part of parts) verdicts.push((yield () => part.quota.take(part.key, part.units)) as QuotaVerdict);
  } catch (error) {
    // a failed take of a part: give back the parts before it, then give its error
    for (let index = 0; index < verdicts.length; index += 1) yield* giveBack(index);
    return { error, failures };
  }
  const index = decisive(verdicts);
  if (index < 0) return { verdict: { allowed: true, states: verdicts.map((verdict) => verdict.state) }, failures };
  const states: QuotaState[] = [];
  for (let at = 0; at < parts.length; at += 1) states.push(yield* giveBack(at));
  return { verdict: { allowed: false, index, refusal: verdicts[index] as QuotaRefused, states }, failures };
}

/** This function gives each error of a give-back to the option, then gives the verdict or throws the error of the take. */
const finish = (walked: Walked, options: TakeQuotasOptions | undefined): QuotasVerdict => {
  for (const failure of walked.failures) options?.onGiveBackError?.(failure.error, failure.index);
  if ("error" in walked) throw walked.error;
  return walked.verdict;
};

const driveSync = (parts: readonly QuotaPart[], options: TakeQuotasOptions | undefined): QuotasVerdict => {
  const steps = walk(parts);
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    let failure: { error: unknown } | undefined;
    try {
      value = next.value();
    } catch (error) {
      failure = { error };
    }
    next = failure === undefined ? steps.next(value) : steps.throw(failure.error);
  }
  return finish(next.value, options);
};

const driveAsync = async (parts: readonly QuotaPart[], options: TakeQuotasOptions | undefined): Promise<QuotasVerdict> => {
  const steps = walk(parts);
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    let failure: { error: unknown } | undefined;
    try {
      value = await next.value();
    } catch (error) {
      failure = { error };
    }
    next = failure === undefined ? steps.next(value) : steps.throw(failure.error);
  }
  return finish(next.value, options);
};

/**
 * This function takes from several quotas, all or none. It takes each part in order. When a part
 * is refused, the next parts still answer, and each part that counted gives back its units. Thus
 * the refusal tells the latest instant at which all parts can have room. When a take fails, the
 * parts before it give back their units, and the error throws.
 *
 * A failed give-back does not change the verdict and does not stop the other give-backs. The units
 * of its part stay counted, and `options.onGiveBackError` gets its error.
 *
 * With quotas that answer at once, it answers at once. Else it gives a promise.
 */
export function takeQuotas(parts: readonly QuotaPart<true>[], options?: TakeQuotasOptions): QuotasVerdict;
export function takeQuotas(parts: readonly QuotaPart[], options?: TakeQuotasOptions): QuotasVerdict | Promise<QuotasVerdict>;
export function takeQuotas(parts: readonly QuotaPart[], options?: TakeQuotasOptions): QuotasVerdict | Promise<QuotasVerdict> {
  return parts.every((part) => part.quota.sync) ? driveSync(parts, options) : driveAsync(parts, options);
}
