import { fakeClock, fakeWallClock } from "@mark1russell7/algebra/clock";
import type { Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { KeyedQuota, QuotaChange, QuotaRecord, QuotaSpec, QuotaStore, QuotaVerdict } from "./index.ts";
import { keyedQuota, memoryQuotaStore, quotaProblems, quotaRule, quotaStep, takeQuotas } from "./index.ts";
import { seeded } from "./testing.ts";

// The quota of a key (SYS-115): a limit in each window of a calendar or of a rolling span. The
// cases of the calendar come from the zones of real providers, and each change of their clocks in 2026.

const at = (iso: string): number => Date.parse(iso);
const count = (value: number): Quantity => ({ value, unit: "count" });

const rolling = (limit: number, span: number, buckets = 60, reserve = 0): QuotaSpec => ({
  limit: count(limit),
  reserve: count(reserve),
  window: { kind: "rolling", span: { value: span, unit: "ms" }, buckets: count(buckets) },
});

const calendar = (unit: "day" | "month", zone: string, hour: number, limit = 5): QuotaSpec => ({
  limit: count(limit),
  reserve: count(0),
  window: { kind: "calendar", unit, zone, start: { value: hour, unit: "h" } },
});

/** This function gives a quota on a memory store and a fake wall clock at `iso`. */
const quotaAt = (spec: QuotaSpec, iso: string) => {
  const clock = fakeWallClock(at(iso));
  const store = memoryQuotaStore();
  const quota = keyedQuota("example", spec, store, clock);
  /** This function gives the stored record of a key, and changes nothing. */
  const record = (key = "k"): unknown => store.change("example", key, (stored) => ({ record: stored as QuotaRecord, result: stored }));
  return { clock, store, quota, record, set: (next: string) => clock.set(at(next)) };
};

/** This function gives the reset of a wait refusal, and fails the test for any other verdict. */
const resetOf = (verdict: QuotaVerdict): number => {
  if (verdict.allowed || verdict.cause === "capacity") throw new Error(`the verdict is not a wait refusal: ${JSON.stringify(verdict)}`);
  return verdict.resetAt;
};

describe("a calendar window", () => {
  it("counts a month in the zone of the provider, and starts again at its midnight", () => {
    // 10,000 messages for each month, with the reset at 00:00 Central Time on the first day
    const { quota, set } = quotaAt(calendar("month", "America/Chicago", 0, 10_000), "2026-11-14T15:00:00Z");
    expect(quota.take("k", 9_999)).toEqual({
      allowed: true,
      state: { at: at("2026-11-14T15:00:00Z"), used: 9_999, left: 1, resetAt: at("2026-12-01T06:00:00Z") },
    });
    expect(quota.take("k")).toMatchObject({ allowed: true, state: { used: 10_000, left: 0 } });
    const refused = quota.take("k");
    expect(refused).toMatchObject({ allowed: false, cause: "limit", resetAt: at("2026-12-01T06:00:00Z") });
    expect(refused).toMatchObject({ retryAfter: { value: at("2026-12-01T06:00:00Z") - at("2026-11-14T15:00:00Z"), unit: "ms" } });
    // 23:59 on November 30 in Chicago is in November
    set("2026-12-01T05:59:59Z");
    expect(quota.take("k").allowed).toBe(false);
    set("2026-12-01T06:00:00Z");
    expect(quota.take("k")).toEqual({
      allowed: true,
      state: { at: at("2026-12-01T06:00:00Z"), used: 1, left: 9_999, resetAt: at("2027-01-01T06:00:00Z") },
    });
  });

  it("gives a day of 25 hours when the clocks go back", () => {
    // in 2026, Chicago leaves daylight time at 02:00 on November 1
    const { quota, record } = quotaAt(calendar("day", "America/Chicago", 0), "2026-11-01T12:00:00Z");
    expect(quota.take("k")).toMatchObject({ state: { resetAt: at("2026-11-02T06:00:00Z") } });
    expect(record()).toEqual({ spent: [[at("2026-11-01T05:00:00Z"), 1]] });
  });

  it("starts a day at the end of the gap when the clock skips its hour", () => {
    // in 2026, Santiago goes from 00:00 on September 6 to 01:00, at 04:00 UTC
    const santiago = quotaAt(calendar("day", "America/Santiago", 0), "2026-09-06T03:30:00Z");
    // 23:30 on September 5: the reset is in the future, thus a loop that waits for it does not spin
    expect(santiago.quota.take("k")).toMatchObject({ state: { resetAt: at("2026-09-06T04:00:00Z") } });
    santiago.set("2026-09-06T04:00:00Z");
    expect(santiago.quota.state("k")).toEqual({ at: at("2026-09-06T04:00:00Z"), used: 0, left: 5 });
    expect(santiago.quota.take("k")).toMatchObject({ state: { resetAt: at("2026-09-07T03:00:00Z") } });
    // in 2026, Chicago goes from 02:00 on March 8 to 03:00, at 08:00 UTC
    const chicago = quotaAt(calendar("day", "America/Chicago", 2), "2026-03-08T07:30:00Z");
    // 01:30 on March 8 is in the day that started at 02:00 on March 7
    expect(chicago.quota.take("k")).toMatchObject({ state: { resetAt: at("2026-03-08T08:00:00Z") } });
    expect(chicago.record()).toEqual({ spent: [[at("2026-03-07T08:00:00Z"), 1]] });
    // the day of March 8 has 23 hours
    chicago.set("2026-03-08T08:00:00Z");
    expect(chicago.quota.take("k")).toEqual({
      allowed: true,
      state: { at: at("2026-03-08T08:00:00Z"), used: 1, left: 4, resetAt: at("2026-03-09T07:00:00Z") },
    });
  });

  it("starts a day at the first of the two times that show its hour", () => {
    // in 2026, Berlin goes back from 03:00 to 02:00 on October 25, at 01:00 UTC
    const berlin = quotaAt(calendar("day", "Europe/Berlin", 1), "2026-10-24T23:30:00Z");
    // 01:30 summer time on October 25: the day started at 01:00, and it has 25 hours
    expect(berlin.quota.take("k")).toMatchObject({ state: { resetAt: at("2026-10-26T00:00:00Z") } });
    expect(berlin.record()).toEqual({ spent: [[at("2026-10-24T23:00:00Z"), 1]] });
    // 02:30 winter time is in the same day
    berlin.set("2026-10-25T01:30:00Z");
    expect(berlin.quota.take("k")).toMatchObject({ state: { used: 2, resetAt: at("2026-10-26T00:00:00Z") } });
    // the clock shows 02:00 two times on October 25: the day of the hour 2 starts at the first
    const twice = quotaAt(calendar("day", "Europe/Berlin", 2), "2026-10-25T01:30:00Z");
    expect(twice.quota.take("k")).toMatchObject({ state: { resetAt: at("2026-10-26T01:00:00Z") } });
    expect(twice.record()).toEqual({ spent: [[at("2026-10-25T00:00:00Z"), 1]] });
  });

  it("keeps the count of a later window after a step back of the clock", () => {
    const { quota, set } = quotaAt(calendar("day", "UTC", 0, 3), "2026-11-15T00:30:00Z");
    expect(quota.take("k", 3).allowed).toBe(true);
    // the clock goes back into November 14: the 3 units of November 15 still count
    set("2026-11-14T23:30:00Z");
    expect(quota.state("k")).toMatchObject({ used: 3, left: 0 });
    expect(resetOf(quota.take("k"))).toBe(at("2026-11-16T00:00:00Z"));
    // the clock comes back: 3 units on November 15, not 6
    set("2026-11-15T00:40:00Z");
    expect(quota.take("k").allowed).toBe(false);
    expect(quota.state("k")).toMatchObject({ used: 3, left: 0 });
  });

  it("starts a day at its time of day, also in a zone with a half-hour offset", () => {
    // 05:30 on November 14 in Kolkata is in the day that started at 06:00 on November 13
    const { quota, set } = quotaAt(calendar("day", "Asia/Kolkata", 6), "2026-11-14T00:00:00Z");
    expect(quota.take("k")).toMatchObject({ state: { resetAt: at("2026-11-14T00:30:00Z") } });
    set("2026-11-14T00:30:00Z");
    expect(quota.state("k")).toEqual({ at: at("2026-11-14T00:30:00Z"), used: 0, left: 5 });
  });

  it("takes a start with minutes, as a time of day", () => {
    const spec: QuotaSpec = { ...calendar("day", "UTC", 0), window: { kind: "calendar", unit: "day", zone: "UTC", start: { value: 90, unit: "min" } } };
    const { quota } = quotaAt(spec, "2026-11-14T01:00:00Z");
    expect(quota.take("k")).toMatchObject({ state: { resetAt: at("2026-11-14T01:30:00Z") } });
  });
});

describe("a rolling window", () => {
  it("frees a unit only when all of its bucket is out of the window", () => {
    const { quota, clock, set } = quotaAt(rolling(3, 10_000, 10), "1970-01-01T00:00:00Z");
    quota.take("k");
    clock.set(2_500);
    quota.take("k");
    clock.set(5_000);
    expect(quota.take("k")).toEqual({ allowed: true, state: { at: 5_000, used: 3, left: 0, resetAt: 11_000 } });
    clock.set(6_000);
    expect(resetOf(quota.take("k"))).toBe(11_000);
    // a window of the provider that started at 0 ends at 10,000: the gate is the stricter of the two
    set("1970-01-01T00:00:10.999Z");
    expect(quota.take("k").allowed).toBe(false);
    set("1970-01-01T00:00:11Z");
    expect(quota.take("k")).toMatchObject({ allowed: true, state: { used: 3, left: 0 } });
  });

  it("frees the oldest buckets that a large take needs", () => {
    const { quota, clock } = quotaAt(rolling(10, 10_000, 10), "1970-01-01T00:00:00Z");
    quota.take("k", 4);
    clock.set(3_000);
    quota.take("k", 4);
    // a take of 6 needs 4 more units: the units of the bucket that starts at 0
    expect(resetOf(quota.take("k", 6))).toBe(11_000);
    expect(resetOf(quota.take("k", 10))).toBe(14_000);
  });

  it("refuses at the limit of the provider with a refusal that the window ends first", () => {
    // 2 units in each 60 s, at 12:00:00.500: the bucket of 1 s that starts at 12:00:00 counts until 12:01:01
    const { quota } = quotaAt(rolling(2, 60_000), "2026-11-14T12:00:00.500Z");
    quota.take("k");
    quota.take("k");
    expect(resetOf(quota.take("k"))).toBe(at("2026-11-14T12:01:01Z"));
  });

  it("holds the count of a seeded walk at or above the count of each true window, and lets no window over the limit", () => {
    const span = 10_000;
    for (const [limit, buckets, seed] of [
      [5, 10, 1],
      [3, 1, 2],
      [12, 60, 3],
      [7, 7, 4],
    ] as const) {
      const random = seeded(115 + seed);
      const rule = quotaRule("walk", rolling(limit, span, buckets));
      let stored: unknown;
      let t = 0;
      const taken: Array<{ at: number; units: number }> = [];
      for (let event = 0; event < 600; event += 1) {
        t += Math.floor(random() * 1_500);
        const units = 1 + Math.floor(random() * 3);
        const step = quotaStep(rule, stored, t, { type: "take", units });
        stored = step.record;
        if (step.verdict.allowed) taken.push({ at: t, units });
        // the true count of the window that ends at t
        const inWindow = taken.filter((take) => take.at > t - span).reduce((sum, take) => sum + take.units, 0);
        expect(inWindow).toBeLessThanOrEqual(limit);
        expect(step.state.used).toBeGreaterThanOrEqual(inWindow);
        if (!step.verdict.allowed && step.verdict.cause === "limit") {
          // at its reset, the same take has room
          expect(quotaStep(rule, stored, step.verdict.resetAt, { type: "take", units }).verdict.allowed).toBe(true);
          expect(quotaStep(rule, stored, step.verdict.resetAt - 1, { type: "take", units }).verdict.allowed).toBe(false);
        }
      }
      expect(taken.length).toBeGreaterThan(20);
    }
  });
});

describe("the quota of a key", () => {
  it("keeps the reserve unused, and refuses a take over the capacity at each time", () => {
    const { quota } = quotaAt(rolling(10, 60_000, 60, 2), "2026-11-14T12:00:00Z");
    expect(quota.take("k", 9)).toEqual({ allowed: false, cause: "capacity", units: 9, capacity: 8, state: { at: at("2026-11-14T12:00:00Z"), used: 0, left: 8 } });
    expect(quota.take("k", 8)).toMatchObject({ allowed: true, state: { used: 8, left: 0 } });
    expect(quota.take("k")).toMatchObject({ allowed: false, cause: "limit" });
  });

  it("gives 0 units left while the provider refuses the key, and a take of 0 units passes", () => {
    const { quota, set } = quotaAt(rolling(10, 60_000), "2026-11-14T12:00:00Z");
    const until = at("2026-11-14T12:00:30Z");
    const now = at("2026-11-14T12:00:00Z");
    expect(quota.note("k", { resetAt: until })).toEqual({ at: now, used: 0, left: 0, blockedUntil: until });
    expect(quota.take("k", 0)).toEqual({ allowed: true, state: { at: now, used: 0, left: 0, blockedUntil: until } });
    expect(quota.take("k")).toMatchObject({ allowed: false, cause: "provider", resetAt: until });
    set("2026-11-14T12:00:30Z");
    expect(quota.state("k")).toEqual({ at: until, used: 0, left: 10 });
  });

  it("gives the later of the refusal of the provider and the room of the window", () => {
    const { quota, set } = quotaAt(rolling(100, 3_600_000), "2026-11-14T12:59:00Z");
    // the provider tells that it has no unit left until 13:00
    expect(quota.note("k", { remaining: 0, resetAt: at("2026-11-14T13:00:00Z") })).toMatchObject({ used: 100, left: 0, blockedUntil: at("2026-11-14T13:00:00Z") });
    // the 100 units of the reading are in the bucket of 12:59, which counts until 14:00
    expect(quota.take("k")).toMatchObject({ cause: "provider", resetAt: at("2026-11-14T14:00:00Z") });
    set("2026-11-14T13:00:00Z");
    expect(quota.take("k")).toMatchObject({ cause: "limit", resetAt: at("2026-11-14T14:00:00Z") });
    set("2026-11-14T14:00:00Z");
    expect(quota.take("k").allowed).toBe(true);
  });

  it("makes the count larger after a reading, not smaller", () => {
    const { quota, clock } = quotaAt(rolling(10, 60_000), "2026-11-14T12:00:00Z");
    const now = clock.now();
    quota.take("k", 2);
    expect(quota.note("k", { remaining: 5 })).toMatchObject({ used: 5, left: 5 });
    expect(quota.note("k", { remaining: 9 })).toMatchObject({ used: 5, left: 5 });
    // a reset with units left does not block
    expect(quota.note("k", { remaining: 4, resetAt: now + 1000 })).toEqual({ at: now, used: 6, left: 4, resetAt: at("2026-11-14T12:01:01Z") });
    // a reset with no count blocks until the reset
    quota.note("k", { resetAt: now + 30_000 });
    expect(resetOf(quota.take("k"))).toBe(now + 30_000);
    clock.set(now + 30_000);
    expect(quota.take("k")).toMatchObject({ allowed: true, state: { used: 7 } });
  });

  it("shares the count of a key between the quotas of one store, and keeps the other keys apart", () => {
    const store = memoryQuotaStore();
    const clock = fakeWallClock(0);
    const one = keyedQuota("example", rolling(2, 60_000), store, clock);
    const two = keyedQuota("example", rolling(2, 60_000), store, clock);
    one.take("k");
    two.take("k");
    expect(one.take("k").allowed).toBe(false);
    expect(one.take("other")).toMatchObject({ allowed: true, state: { used: 1 } });
    // another quota of the same key counts apart
    expect(keyedQuota("other", rolling(2, 60_000), store, clock).take("k")).toMatchObject({ state: { used: 1 } });
    expect(store.size("example")).toBe(2);
  });

  it("removes a key whose record is equal to the record of a new key", () => {
    const { quota, store, clock } = quotaAt(rolling(2, 10_000, 10), "1970-01-01T00:00:00Z");
    quota.take("k");
    quota.note("k", { remaining: 1 });
    expect(store.size("example")).toBe(1);
    // the bucket of 0 and the reading of 0 stop counting at 11,000
    clock.set(11_000);
    expect(quota.state("k")).toEqual({ at: 11_000, used: 0, left: 2 });
    expect(store.size("example")).toBe(0);
  });

  it("reads a record that is not valid as an empty record, and removes only the items that are not valid", () => {
    const { quota, store } = quotaAt(rolling(2, 60_000), "1970-01-01T00:00:00Z");
    store.change("example", "k", () => ({ record: { spent: "no" } as unknown as QuotaRecord, result: undefined }));
    expect(quota.state("k")).toEqual({ at: 0, used: 0, left: 2 });
    expect(quota.take("k")).toMatchObject({ state: { used: 1 } });
    const items = [[0, 2], [1000, -5], ["x", 1], [2000], [3000, Number.NaN], [9e15, 1], [0, 0]];
    const other = quotaAt(rolling(3, 60_000), "1970-01-01T00:00:00Z");
    other.store.change("example", "k", () => ({ record: { spent: items, blockedUntil: "x", readAt: Number.NaN } as unknown as QuotaRecord, result: undefined }));
    expect(other.quota.state("k")).toEqual({ at: 0, used: 2, left: 1, resetAt: 61_000 });
    expect(other.quota.take("k")).toMatchObject({ state: { used: 3, left: 0 } });
    expect(other.quota.take("k").allowed).toBe(false);
  });

  it("refuses a spec with a problem, and names each problem", () => {
    const bad: Array<[Partial<QuotaSpec> | undefined, string]> = [
      [undefined, "has no spec"],
      [{ ...rolling(10, 1000), limit: count(0) }, "limit is not a finite count above zero"],
      [{ ...rolling(10, 1000), limit: { value: 10, unit: "ms" } }, "limit is not a count"],
      [{ limit: count(10), window: rolling(10, 1000).window }, "does not declare its reserve"],
      [rolling(10, 1000, 60, 10), "reserve is not less than its limit"],
      [{ ...rolling(10, 1000), reserve: count(-1) }, "reserve is not a finite count of 0 or more"],
      [rolling(10, 0), "span is not a finite time above zero"],
      [rolling(10, 1000, 0), "buckets is not a whole count from 1 to 1000"],
      [rolling(10, 1000, 1.5), "buckets is not a whole count from 1 to 1000"],
      [rolling(10, 1000, 1001), "buckets is not a whole count from 1 to 1000"],
      [calendar("day", "Mars/Olympus", 0), "zone is not an IANA time zone"],
      [calendar("day", "UTC", 24), "start is not a whole count of milliseconds from 0 to less than 24 h"],
      [calendar("day", "UTC", -1), "start is not a whole count of milliseconds from 0 to less than 24 h"],
      [{ ...calendar("day", "UTC", 0), window: { kind: "calendar", unit: "week", zone: "UTC", start: { value: 0, unit: "h" } } as never }, "unit is not day or month"],
      [{ ...calendar("day", "UTC", 0), window: { kind: "fixed" } as never }, "window is not rolling or calendar"],
      [{ limit: count(1), reserve: count(0) }, "does not declare its window"],
    ];
    for (const [spec, problem] of bad) {
      expect(quotaProblems("example", spec).join("; "), problem).toContain(problem);
      expect(() => keyedQuota("example", spec as QuotaSpec, memoryQuotaStore(), fakeWallClock(0)), problem).toThrow(problem);
    }
    expect(quotaProblems("example", rolling(10, 1000))).toEqual([]);
    expect(quotaProblems("example", calendar("month", "America/Chicago", 0))).toEqual([]);
  });

  it("refuses units that are not a finite count of 0 or more, and an instant that is not a date", () => {
    const { quota } = quotaAt(rolling(10, 1000), "2026-11-14T12:00:00Z");
    for (const units of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => quota.take("k", units)).toThrow(RangeError);
      expect(() => quota.giveBack("k", units, 0)).toThrow(RangeError);
    }
    expect(() => quota.giveBack("k", 1, Number.NaN)).toThrow(RangeError);
    const rule = quotaRule("example", rolling(10, 1000));
    for (const instant of [Number.NaN, 1e20]) expect(() => quotaStep(rule, undefined, instant, { type: "read" })).toThrow(RangeError);
    expect(quota.state("k")).toMatchObject({ used: 0 });
  });

  it("needs a wall clock, and a store that answers as it says", () => {
    const store = memoryQuotaStore();
    // @ts-expect-error a monotonic clock does not give the instant
    expect(() => keyedQuota("example", rolling(2, 1000), store, fakeClock(0))).toThrow("needs a wall clock");
    const lying: QuotaStore<true> = {
      sync: true,
      change: <T>(quota: string, key: string, step: (stored: unknown) => QuotaChange<T>): T => Promise.resolve(store.change(quota, key, step)) as unknown as T,
    };
    expect(() => keyedQuota("example", rolling(2, 1000), lying, fakeWallClock(0)).take("k")).toThrow("its change gave a promise");
  });

  it("permits units with a fraction up to the limit, though their sum in floating point is over it", () => {
    const { quota } = quotaAt({ ...rolling(1, 60_000), limit: count(0.3) }, "2026-11-14T12:00:00Z");
    expect(quota.take("k", 0.1).allowed).toBe(true);
    // 0.1 + 0.2 is 0.30000000000000004 in floating point
    expect(quota.take("k", 0.2)).toMatchObject({ allowed: true, state: { left: 0 } });
    expect(quota.take("k", 0.001)).toMatchObject({ allowed: false, cause: "limit" });
  });

  it("is a pure step: the same input gives the same output, and the stored record does not change", () => {
    const rule = quotaRule("example", calendar("day", "America/Chicago", 2));
    const stored: QuotaRecord = { spent: [[at("2026-03-07T08:00:00Z"), 1]], readAt: at("2026-03-07T09:00:00Z") };
    const copy = JSON.parse(JSON.stringify(stored)) as unknown;
    const instant = at("2026-03-08T07:30:00Z");
    const one = quotaStep(rule, stored, instant, { type: "take", units: 2 });
    expect(quotaStep(rule, stored, instant, { type: "take", units: 2 })).toEqual(one);
    expect(stored).toEqual(copy);
    expect(one.record).toEqual({ spent: [[at("2026-03-07T08:00:00Z"), 3]], readAt: at("2026-03-07T09:00:00Z") });
  });
});

describe("a give-back", () => {
  it("removes the units of a take from the bucket of the take", () => {
    const { quota, clock } = quotaAt(rolling(5, 10_000, 10), "1970-01-01T00:00:00Z");
    quota.take("k", 2);
    clock.set(1_500);
    const taken = quota.take("k", 3);
    expect(taken).toMatchObject({ allowed: true, state: { at: 1_500, used: 5, left: 0 } });
    clock.set(2_200);
    expect(quota.giveBack("k", 3, 1_500)).toEqual({ at: 2_200, used: 2, left: 3, resetAt: 11_000 });
    // more units than the bucket holds remove the bucket, and no other bucket
    expect(quota.giveBack("k", 9, 0)).toEqual({ at: 2_200, used: 0, left: 5 });
    // a bucket with no units, and 0 units, change nothing
    expect(quota.giveBack("k", 1, 5_000)).toEqual({ at: 2_200, used: 0, left: 5 });
    expect(quota.giveBack("k", 0, 2_200)).toEqual({ at: 2_200, used: 0, left: 5 });
  });

  it("changes nothing when the bucket of the take is out of the window", () => {
    const { quota, clock } = quotaAt(rolling(5, 10_000, 10), "1970-01-01T00:00:00Z");
    quota.take("k", 2);
    clock.set(10_000);
    quota.take("k", 1);
    clock.set(11_000);
    expect(quota.giveBack("k", 2, 0)).toEqual({ at: 11_000, used: 1, left: 4, resetAt: 21_000 });
  });

  it("changes nothing when a reading of the provider came at or after the take", () => {
    const { quota, clock } = quotaAt(rolling(10, 60_000), "1970-01-01T00:00:00Z");
    quota.take("k", 3);
    // a reading at the instant of the take holds the count of the provider
    quota.note("k", { remaining: 8 });
    expect(quota.giveBack("k", 3, 0)).toMatchObject({ used: 3 });
    clock.set(500);
    quota.take("k", 2);
    // a reading before the take does not hold it
    expect(quota.giveBack("k", 2, 500)).toMatchObject({ used: 3 });
    clock.set(700);
    quota.note("k", { remaining: 7 });
    quota.take("k", 1);
    clock.set(900);
    quota.note("k", { remaining: 6 });
    expect(quota.giveBack("k", 1, 700)).toMatchObject({ used: 4 });
    // a reading with no count does not move the instant of the last reading
    clock.set(1_000);
    quota.take("k", 1);
    quota.note("k", { resetAt: 1_000_000 });
    expect(quota.giveBack("k", 1, 1_000)).toMatchObject({ used: 4 });
  });

  it("gives back into a calendar window, in its own window", () => {
    const { quota, set } = quotaAt(calendar("day", "UTC", 0, 3), "2026-11-14T23:00:00Z");
    quota.take("k", 2);
    set("2026-11-15T01:00:00Z");
    quota.take("k", 3);
    expect(quota.giveBack("k", 2, at("2026-11-14T23:00:00Z"))).toMatchObject({ used: 3 });
    expect(quota.giveBack("k", 1, at("2026-11-15T01:00:00Z"))).toMatchObject({ used: 2, left: 1 });
  });
});

describe("a take of several quotas, all or none", () => {
  const two = () => {
    const store = memoryQuotaStore();
    const clock = fakeWallClock(at("2026-11-14T12:00:00Z"));
    const minute = keyedQuota("minute", rolling(10, 60_000), store, clock);
    const day = keyedQuota("day", calendar("day", "UTC", 0, 20), store, clock);
    return { store, clock, minute, day };
  };

  it("counts each part when each part has room", () => {
    const { minute, day } = two();
    const verdict = takeQuotas([
      { quota: minute, key: "k", units: 2 },
      { quota: day, key: "k", units: 2 },
    ]);
    expect(verdict).toMatchObject({ allowed: true, states: [{ used: 2 }, { used: 2 }] });
    expect(takeQuotas([])).toEqual({ allowed: true, states: [] });
  });

  it("counts 20 of 50 tries every 24 s under 10 in each minute and 20 in each day", () => {
    const { minute, day, clock } = two();
    let sent = 0;
    for (let round = 0; round < 50; round += 1) {
      const verdict = takeQuotas([
        { quota: minute, key: "k", units: 1 },
        { quota: day, key: "k", units: 1 },
      ]);
      if (verdict.allowed) sent += 1;
      clock.set(clock.now() + 24_000);
    }
    expect(sent).toBe(20);
    expect(day.state("k")).toMatchObject({ used: 20, left: 0, resetAt: at("2026-11-15T00:00:00Z") });
    // the refused tries gave back their units of the minute
    expect(minute.state("k").used).toBeLessThanOrEqual(3);
  });

  it("gives back each counted part of a refused take, and gives the refusal with the latest reset", () => {
    const { minute, day } = two();
    day.take("k", 19);
    minute.take("k", 9);
    const third = keyedQuota("third", rolling(5, 1_000), memoryQuotaStore(), fakeWallClock(at("2026-11-14T12:00:00Z")));
    const verdict = takeQuotas([
      { quota: third, key: "k", units: 2 },
      { quota: minute, key: "k", units: 2 },
      { quota: day, key: "k", units: 2 },
    ]);
    expect(verdict).toMatchObject({ allowed: false, index: 2, refusal: { cause: "limit", resetAt: at("2026-11-15T00:00:00Z") } });
    if (verdict.allowed) throw new Error("the take is permitted");
    expect(verdict.states.map((state) => state.used)).toEqual([0, 9, 19]);
    expect(third.state("k").used).toBe(0);
  });

  it("gives the refusal of the first part when two refusals have the same reset", () => {
    const store = memoryQuotaStore();
    const clock = fakeWallClock(0);
    const one = keyedQuota("one", rolling(1, 10_000, 10), store, clock);
    const other = keyedQuota("other", rolling(1, 10_000, 10), store, clock);
    one.take("k");
    other.take("k");
    const verdict = takeQuotas([
      { quota: one, key: "k", units: 1 },
      { quota: other, key: "k", units: 1 },
    ]);
    expect(verdict).toMatchObject({ allowed: false, index: 0, refusal: { cause: "limit", resetAt: 11_000 } });
  });

  it("gives a capacity refusal first, because no wait lets it in", () => {
    const { minute, day } = two();
    day.take("k", 20);
    const verdict = takeQuotas([
      { quota: day, key: "k", units: 1 },
      { quota: minute, key: "k", units: 11 },
    ]);
    expect(verdict).toMatchObject({ allowed: false, index: 1, refusal: { cause: "capacity", units: 11, capacity: 10 } });
  });

  it("gives back the parts before a failed take, and gives its error", () => {
    const { minute } = two();
    const failing: QuotaStore<true> = {
      sync: true,
      change: () => {
        throw new Error("the database is locked");
      },
    };
    const broken = keyedQuota("broken", rolling(10, 60_000), failing, fakeWallClock(0));
    expect(() =>
      takeQuotas([
        { quota: minute, key: "k", units: 3 },
        { quota: broken, key: "k", units: 1 },
      ]),
    ).toThrow("the database is locked");
    expect(minute.state("k").used).toBe(0);
    // units that are not valid fail the take of their part
    expect(() => takeQuotas([{ quota: minute, key: "k", units: 3 }, { quota: minute, key: "k", units: -1 }])).toThrow(RangeError);
    expect(minute.state("k").used).toBe(0);
  });

  it("gives a promise with a store that answers with a promise, and the same verdicts", async () => {
    const memory = memoryQuotaStore();
    const shared: QuotaStore<false> = {
      sync: false,
      change: async <T>(quota: string, key: string, step: (stored: unknown) => QuotaChange<T>): Promise<T> => {
        await Promise.resolve();
        return memory.change(quota, key, step);
      },
    };
    const clock = fakeWallClock(at("2026-11-14T12:00:00Z"));
    const remote: KeyedQuota<false> = keyedQuota("remote", rolling(3, 60_000), shared, clock);
    const local = keyedQuota("local", rolling(10, 60_000), memoryQuotaStore(), clock);
    expect(remote.sync).toBe(false);
    await expect(remote.take("k", 2)).resolves.toMatchObject({ allowed: true, state: { used: 2 } });
    // a RangeError rejects the promise
    await expect(remote.take("k", -1)).rejects.toThrow(RangeError);
    const answer = takeQuotas([
      { quota: local, key: "k", units: 2 },
      { quota: remote, key: "k", units: 2 },
    ]);
    expect(answer).toBeInstanceOf(Promise);
    await expect(answer).resolves.toMatchObject({ allowed: false, index: 1, states: [{ used: 0 }, { used: 2 }] });
    expect(local.state("k").used).toBe(0);
    await expect(remote.giveBack("k", 2, clock.now())).resolves.toMatchObject({ used: 0 });
  });
});
