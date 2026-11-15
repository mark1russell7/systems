import { describe, expect, it } from "vitest";
import type { Decision, KeyState, LimiterSpec, LimitRule } from "./index.ts";
import { capacityOf, decide, keyedLimiter, memoryStore, overCapacity, unitsOf } from "./index.ts";
import { limitedResponse } from "./http.ts";
import { fakeClock, seeded } from "./testing.ts";

// The units of a take (service 0.7.0): a take of n units is one atomic step of the policy. These
// tests hold the laws of the step for seeded runs of each policy.

const RULES: ReadonlyArray<LimitRule> = [
  { type: "token-bucket", interval: 1000, burst: 3 },
  { type: "token-bucket", interval: 250, burst: 8 },
  { type: "sliding-window", limit: 5, window: 10_000 },
  { type: "sliding-window", limit: 2, window: 60_000 },
];

/** This function gives the span of the policy in ms: the bucket refills in it, and a window is it. */
const spanOf = (rule: LimitRule): number => (rule.type === "token-bucket" ? rule.interval * rule.burst : rule.window);

/** This function gives the most units that the policy lets in during `ms` milliseconds. */
const mostIn = (rule: LimitRule, ms: number): number =>
  rule.type === "token-bucket" ? rule.burst + Math.floor(ms / rule.interval) : rule.limit * (Math.floor(ms / rule.window) + 1);

/** A run is a seeded sequence of takes on one key, with the units and the time of each. */
const run = (rule: LimitRule, seed: number, takes = 400) => {
  const random = seeded(seed);
  const capacity = capacityOf(rule);
  const log: Array<{ at: number; units: number; decision: Decision; before: KeyState | undefined }> = [];
  let state: KeyState | undefined;
  let now = 0;
  for (let take = 0; take < takes; take += 1) {
    // most takes are small, and some are over the capacity
    const units = 1 + Math.floor(random() * (capacity + 2));
    const step = decide(rule, state, now, units);
    log.push({ at: now, units, decision: step.decision, before: state });
    state = step.state;
    now += Math.floor(random() * (spanOf(rule) / 2));
  }
  return log;
};

describe("the units of a take (service 0.7.0)", () => {
  it("gives a take of 1 unit the same step as a take with no units", () => {
    for (const [index, rule] of RULES.entries())
      for (const { at, before } of run(rule, 11 + index)) expect(decide(rule, before, at, 1)).toEqual(decide(rule, before, at));
  });

  it("refuses a take over the capacity with the cause capacity, at each time, and keeps the state", () => {
    for (const [index, rule] of RULES.entries())
      for (const { at, units, decision, before } of run(rule, 21 + index)) {
        if (units <= capacityOf(rule)) {
          expect(decision.allowed === false && decision.cause === "capacity").toBe(false);
          continue;
        }
        expect(decision).toEqual({ allowed: false, cause: "capacity", units, capacity: capacityOf(rule) });
        expect(overCapacity(rule, units)).toEqual(decision);
        // the refusal changes no count: a take of 1 unit then is the same as with no refusal
        expect(decide(rule, decide(rule, before, at, units).state, at, 1)).toEqual(decide(rule, before, at, 1));
      }
  });

  it("never lets in more units than the policy permits in one window", () => {
    for (const [index, rule] of RULES.entries()) {
      const allowed = run(rule, 31 + index, 600).filter((entry) => entry.decision.allowed);
      for (let first = 0; first < allowed.length; first += 1) {
        let units = 0;
        for (let last = first; last < allowed.length; last += 1) {
          units += allowed[last]!.units;
          const ms = allowed[last]!.at - allowed[first]!.at;
          expect(units, `${rule.type}: from ${allowed[first]!.at} to ${allowed[last]!.at}`).toBeLessThanOrEqual(mostIn(rule, ms));
          if (ms > 3 * spanOf(rule)) break;
        }
      }
      // in one window of the sliding window, the bound is the limit
      if (rule.type === "sliding-window")
        for (const entry of allowed) {
          const inWindow = allowed.filter((other) => other.at <= entry.at && other.at > entry.at - rule.window);
          expect(inWindow.reduce((sum, other) => sum + other.units, 0)).toBeLessThanOrEqual(rule.limit);
        }
    }
  });

  it("gives take(k, n) the same step as n takes of 1 unit when the key has room", () => {
    for (const [index, rule] of RULES.entries())
      for (const { at, units, decision, before } of run(rule, 41 + index)) {
        if (units > capacityOf(rule)) continue;
        let state = before;
        let singles: Decision[] = [];
        for (let unit = 0; unit < units; unit += 1) {
          const step = decide(rule, state, at);
          singles = [...singles, step.decision];
          state = step.state;
        }
        const room = singles.every((single) => single.allowed);
        // the take of n is let in when, and only when, each of the n takes of 1 unit is let in
        expect(decision.allowed, `${rule.type} at ${at}, ${units} units`).toBe(room);
        if (room) {
          expect(decide(rule, before, at, units).state).toEqual(state);
          expect(decision).toEqual(singles.at(-1));
        }
      }
  });

  it("gives a refusal the exact wait: the take fits after retryAfter, and not 1 ms before", () => {
    let refusals = 0;
    for (const [index, rule] of RULES.entries())
      for (const { at, units, decision, before } of run(rule, 51 + index)) {
        if (decision.allowed || decision.cause === "capacity") continue;
        refusals += 1;
        const wait = decision.retryAfter.value;
        expect(decision.retryAfter.unit).toBe("ms");
        expect(decide(rule, before, at + wait, units).decision.allowed).toBe(true);
        if (wait > 1) expect(decide(rule, before, at + wait - 1, units).decision.allowed).toBe(false);
      }
    expect(refusals).toBeGreaterThan(50);
  });

  it("accepts only a whole number of 1 or more units", () => {
    expect(unitsOf(undefined)).toBe(1);
    expect(unitsOf(7)).toBe(7);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2" as unknown as number])
      expect(() => unitsOf(bad), String(bad)).toThrow(RangeError);
    expect(() => decide(RULES[0]!, undefined, 0, 0)).toThrow(/whole number of 1 or more/);
  });
});

describe("a keyed limiter takes the units of a take in one step", () => {
  const SPEC: LimiterSpec = {
    key: "tenant",
    policy: { type: "token-bucket", rate: { value: 1, unit: "count/s" }, burst: { value: 3, unit: "count" } },
    store: { kind: "local" },
    evict: { maxKeys: { value: 2, unit: "count" } },
  };

  it("takes the units from the memory store, and refuses a take over the burst before the store", async () => {
    const clock = fakeClock();
    const limiter = keyedLimiter("writes", SPEC, memoryStore(clock));
    expect(await limiter.take("a", 2)).toEqual({ allowed: true, remaining: 1 });
    expect(limiter.tryTakeSync("a", 2)).toEqual({ allowed: false, retryAfter: { value: 1000, unit: "ms" }, cause: "limit" });
    expect(limiter.tryTakeSync("a")).toEqual({ allowed: true, remaining: 0 });
    expect(await limiter.take("b", 4)).toEqual({ allowed: false, cause: "capacity", units: 4, capacity: 3 });
    await expect(limiter.take("b", 0)).rejects.toThrow(RangeError);
  });

  it("adds no key for a take that it refuses for the capacity", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const limiter = keyedLimiter("writes", SPEC, store);
    // a store of its own, with no limiter before it: the store refuses the take too
    const rule: LimitRule = { type: "token-bucket", interval: 1000, burst: 3 };
    expect(store.take({ limiter: "writes", key: "x", rule, maxKeys: 2, units: 9 })).toEqual({ allowed: false, cause: "capacity", units: 9, capacity: 3 });
    // the cap of 2 keys is not used by the refused take
    expect((await limiter.take("a")).allowed).toBe(true);
    expect((await limiter.take("b")).allowed).toBe(true);
    expect(await limiter.take("c")).toMatchObject({ allowed: false, cause: "cap" });
  });

  it("gives a capacity refusal the status 413, with no Retry-After", () => {
    const response = limitedResponse({ allowed: false, cause: "capacity", units: 5, capacity: 3 });
    expect(response.status).toBe(413);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(JSON.parse(String(response.body))).toMatchObject({ retryable: false, units: 5, capacity: 3 });
    const wait = limitedResponse({ allowed: false, cause: "limit", retryAfter: { value: 1500, unit: "ms" } });
    expect(wait.status).toBe(429);
    expect(wait.headers["retry-after"]).toBe("2");
  });
});
