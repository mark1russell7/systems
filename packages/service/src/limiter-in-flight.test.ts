import { describe, expect, it } from "vitest";
import type { Decision, KeyState, Lease, LimiterSpec, LimiterStore, LimitRule } from "./index.ts";
import {
  capacityOf,
  decide,
  idleSpan,
  keyedLimiter,
  limiterProblems,
  limitRule,
  longestRetryAfter,
  memoryStore,
  releaseLease,
} from "./index.ts";
import { fakeClock, seeded } from "./testing.ts";

// The in-flight bound (service 0.10.0): a key holds at most `limit` units at one time. A permitted
// take holds its units until its release, or until its lease ends. These tests hold the laws of
// the take and of the release for each store in this process.

const s = (value: number) => ({ value, unit: "s" });
const count = (value: number) => ({ value, unit: "count" });

/** This spec is a bound of 2 calls in flight for each tenant: each call holds its unit for at most 30 s. */
const BOUND: LimiterSpec = {
  key: "tenant",
  policy: { type: "in-flight", limit: count(2), lease: s(30), retryAfter: s(1) },
  store: { kind: "local" },
  evict: { maxKeys: count(100) },
};

type InFlightRule = Extract<LimitRule, { type: "in-flight" }>;
const RULE: InFlightRule = { type: "in-flight", limit: 2, lease: 30_000, retryAfter: 1000 };

/** This function gives the lease of a decision, and fails the test when the decision has none. */
const leaseOf = (decision: Decision): Lease => {
  if (!decision.allowed || decision.lease === undefined) throw new Error(`the decision has no lease: ${JSON.stringify(decision)}`);
  return decision.lease;
};

describe("an in-flight bound is declared as data, with no defaults", () => {
  it("gives the rule, the capacity, the idle span and the longest Retry-After of the bound", () => {
    expect(limiterProblems("calls", BOUND)).toEqual([]);
    expect(limitRule(BOUND.policy)).toEqual(RULE);
    expect(capacityOf(RULE)).toBe(2);
    expect(idleSpan(BOUND.policy)).toEqual({ value: 30_000, unit: "ms" });
    expect(longestRetryAfter(BOUND.policy)).toEqual({ value: 1000, unit: "ms" });
  });

  it("refuses an absent part, a part in the wrong unit, and a retryAfter longer than the lease", () => {
    const problems = (policy: Record<string, unknown>): string => limiterProblems("calls", { ...BOUND, policy: { ...BOUND.policy, ...policy } as LimiterSpec["policy"] }).join("; ");
    expect(problems({ lease: undefined })).toMatch(/does not declare the lease of each take \(policy\.lease\)/);
    expect(problems({ retryAfter: undefined })).toMatch(/does not declare the retryAfter of a refusal \(policy\.retryAfter\)/);
    expect(problems({ limit: undefined })).toMatch(/does not declare the most units in flight of a key \(policy\.limit\)/);
    expect(problems({ limit: count(1.5) })).toMatch(/limit is not a whole count above zero/);
    expect(problems({ lease: count(30) })).toMatch(/lease is not a time/);
    expect(problems({ retryAfter: s(0) })).toMatch(/retryAfter is not a finite time above zero/);
    expect(problems({ retryAfter: s(31) })).toMatch(/retryAfter is longer than its lease/);
    expect(problems({ retryAfter: s(30) })).toBe("");
  });
});

describe("the step of an in-flight bound, and its release", () => {
  it("lets a take in at once after the release of a held unit", () => {
    const first = decide(RULE, undefined, 0);
    expect(first.decision).toEqual({ allowed: true, remaining: 1, lease: { start: 0, units: 1 } });
    const second = decide(RULE, first.state, 100);
    expect(second.decision).toEqual({ allowed: true, remaining: 0, lease: { start: 100, units: 1 } });
    // the bound is full: the wait is the declared retryAfter, because the oldest lease ends later
    expect(decide(RULE, second.state, 200).decision).toEqual({ allowed: false, retryAfter: { value: 1000, unit: "ms" }, cause: "limit" });
    const after = releaseLease(RULE, second.state, 200, leaseOf(first.decision));
    expect(after).toEqual({ type: "in-flight", starts: [100] });
    expect(decide(RULE, after, 200).decision).toEqual({ allowed: true, remaining: 0, lease: { start: 200, units: 1 } });
  });

  it("waits less than retryAfter when the oldest lease ends first", () => {
    const held = decide(RULE, decide(RULE, undefined, 0).state, 0).state;
    expect(decide(RULE, held, 29_600).decision).toEqual({ allowed: false, retryAfter: { value: 400, unit: "ms" }, cause: "limit" });
    expect(decide(RULE, held, 30_000).decision.allowed).toBe(true);
  });

  it("changes nothing at a late release, and removes only the units of the lease at a shared start", () => {
    const one = decide(RULE, undefined, 0);
    // the lease ended at 30 s: the unit left the count then, and the release removes nothing
    expect(releaseLease(RULE, one.state, 30_000, leaseOf(one.decision))).toEqual({ type: "in-flight", starts: [] });
    const wide: InFlightRule = { ...RULE, limit: 5 };
    const a = decide(wide, undefined, 50, 2);
    const b = decide(wide, a.state, 50, 1);
    expect(b.state).toEqual({ type: "in-flight", starts: [50, 50, 50] });
    expect(releaseLease(wide, b.state, 60, leaseOf(b.decision))).toEqual({ type: "in-flight", starts: [50, 50] });
    expect(releaseLease(wide, b.state, 60, leaseOf(a.decision))).toEqual({ type: "in-flight", starts: [50] });
  });

  it("keeps the state of a rate policy at a release", () => {
    const window: LimitRule = { type: "sliding-window", limit: 2, window: 1000 };
    const state: KeyState = { type: "sliding-window", stamps: [0] };
    expect(releaseLease(window, state, 10, { start: 0, units: 1 })).toBe(state);
  });

  it("never holds more than the limit, and holds each unit that is not released while its lease lasts (seeded runs)", () => {
    for (const [seed, rule] of [
      [1, RULE],
      [2, { type: "in-flight", limit: 5, lease: 10_000, retryAfter: 500 }],
      [3, { type: "in-flight", limit: 1, lease: 2000, retryAfter: 2000 }],
    ] as const) {
      const random = seeded(seed);
      // the model: each lease that the run holds, with its units and its start
      let open: Lease[] = [];
      let state: KeyState | undefined;
      let now = 0;
      let refusals = 0;
      for (let step = 0; step < 2000; step += 1) {
        now += Math.floor(random() * (rule.lease / 8));
        open = open.filter((lease) => lease.start + rule.lease > now);
        const held = open.reduce((sum, lease) => sum + lease.units, 0);
        if (open.length > 0 && random() < 0.4) {
          const index = Math.floor(random() * open.length);
          state = releaseLease(rule, state, now, open[index]!);
          open = open.filter((_, at) => at !== index);
          continue;
        }
        const units = 1 + Math.floor(random() * rule.limit);
        const next = decide(rule, state, now, units);
        expect(next.decision.allowed, `seed ${seed}, step ${step}: ${held} held, ${units} units`).toBe(held + units <= rule.limit);
        if (next.decision.allowed) {
          expect(next.decision.remaining).toBe(rule.limit - held - units);
          open = [...open, leaseOf(next.decision)];
        } else if (next.decision.cause === "limit") {
          refusals += 1;
          expect(next.decision.retryAfter.value).toBeGreaterThan(0);
          expect(next.decision.retryAfter.value).toBeLessThanOrEqual(rule.retryAfter);
        }
        state = next.state;
      }
      expect(refusals, `seed ${seed}`).toBeGreaterThan(20);
    }
  });
});

describe("a keyed limiter releases the leases of an in-flight bound", () => {
  it("refuses a store with no release, because each unit then stays held until its lease ends", () => {
    const store: LimiterStore = { kind: "local", take: () => ({ allowed: true, remaining: 0 }) };
    expect(() => keyedLimiter("calls", BOUND, store)).toThrow(/declares an in-flight bound, but its store has no release/);
  });

  it("releases each lease one time, and removes the key at the release of its last held unit", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const limiter = keyedLimiter("calls", BOUND, store);
    const first = await limiter.take("a");
    const second = limiter.tryTakeSync("a");
    const refused = await limiter.take("a");
    expect(refused).toEqual({ allowed: false, retryAfter: { value: 1000, unit: "ms" }, cause: "limit" });
    // a refusal holds no unit, thus its release changes nothing
    await limiter.release("a", refused);
    await limiter.release("a", first);
    // a second release of one decision releases nothing: the unit of the second take stays held
    await limiter.release("a", first);
    expect((await limiter.take("a")).allowed).toBe(true);
    expect((await limiter.take("a")).allowed).toBe(false);
    await limiter.release("a", second);
    expect(store.size("calls")).toBe(1);
    // a decision that this limiter did not give releases nothing
    await limiter.release("a", { allowed: true, remaining: 0, lease: { start: 0, units: 1 } });
    expect(store.size("calls")).toBe(1);
  });

  it("rejects the release of a lease with another key, and keeps its units held", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const limiter = keyedLimiter("calls", BOUND, store);
    const taken = await limiter.take("a");
    await limiter.take("b");
    await expect(limiter.release("b", taken)).rejects.toThrow(/lease of the key a with the key b/);
    await limiter.release("a", taken);
    expect(store.size("calls")).toBe(1);
  });

  it("frees a slot of the cap of keys at a release", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const limiter = keyedLimiter("calls", { ...BOUND, evict: { maxKeys: count(1) } }, store);
    const taken = await limiter.take("a");
    expect(await limiter.take("b")).toMatchObject({ allowed: false, cause: "cap" });
    await limiter.release("a", taken);
    expect(store.size("calls")).toBe(0);
    expect((await limiter.take("b")).allowed).toBe(true);
  });

  it("changes nothing at a release after the end of the lease", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const limiter = keyedLimiter("calls", BOUND, store);
    const late = await limiter.take("a");
    await clock.advance(20_000);
    const kept = await limiter.take("a");
    await clock.advance(15_000);
    // the first lease ended at 30 s, thus its release removes no unit of the second take
    await limiter.release("a", late);
    expect(store.size("calls")).toBe(1);
    expect(await limiter.take("a", 2)).toMatchObject({ allowed: false, cause: "limit" });
    await limiter.release("a", kept);
    expect(await limiter.take("a", 2)).toEqual({ allowed: true, remaining: 0, lease: { start: 35_000, units: 2 } });
  });

  it("gives no lease for a rate policy, thus a release changes nothing", async () => {
    const clock = fakeClock();
    const window: LimiterSpec = { ...BOUND, policy: { type: "sliding-window", limit: count(1), window: s(60) } };
    const limiter = keyedLimiter("writes", window, memoryStore(clock));
    const taken = await limiter.take("a");
    expect(taken).toEqual({ allowed: true, remaining: 0 });
    await limiter.release("a", taken);
    expect((await limiter.take("a")).allowed).toBe(false);
  });

  it("keeps the units held until the end of their lease when the release of a shared store fails", async () => {
    const clock = fakeClock();
    const memory = memoryStore(clock);
    let failing = false;
    const store: LimiterStore = {
      kind: "shared",
      take: (request) => memory.take(request),
      release: (request) => {
        if (failing) throw new Error("the store is down");
        memory.release(request);
      },
    };
    const shared: LimiterSpec = {
      ...BOUND,
      policy: { type: "in-flight", limit: count(1), lease: s(30), retryAfter: s(1) },
      store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" },
    };
    const limiter = keyedLimiter("calls", shared, store);
    const taken = await limiter.take("a");
    failing = true;
    await expect(limiter.release("a", taken)).rejects.toThrow(/the store is down/);
    expect((await limiter.take("a")).allowed).toBe(false);
    await clock.advance(30_000);
    expect((await limiter.take("a")).allowed).toBe(true);
  });
});
