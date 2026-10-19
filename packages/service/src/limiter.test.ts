import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock, Decision, KeyState, LimiterSpec, LimiterStore, LimitRule, Scenario, ServiceBuilder, TakeRequest } from "./index.ts";
import {
  LIMITER_RULES,
  SERVICE_RULES,
  decide,
  freeAt,
  idleSpan,
  keyedLimiter,
  limitRule,
  lint,
  longestRetryAfter,
  memoryStore,
  platformClock,
  retryAfterSeconds,
  service,
} from "./index.ts";
import { limitedResponse } from "./http.ts";
import { fakeClock, seeded } from "./testing.ts";

const s = (value: number) => ({ value, unit: "s" });
const count = (value: number) => ({ value, unit: "count" });

/** a token bucket of 3 that refills one token each second, in memory, with room for 100 keys */
const BUCKET: LimiterSpec = {
  key: "tenant",
  policy: { type: "token-bucket", rate: { value: 1, unit: "count/s" }, burst: count(3) },
  store: { kind: "local" },
  evict: { maxKeys: count(100) },
};

/** Graph's write limit: 3 writes in each sliding minute, here with room for 100 keys */
const WINDOW: LimiterSpec = {
  key: "tenant",
  policy: { type: "sliding-window", limit: count(3), window: s(60) },
  store: { kind: "local" },
  evict: { maxKeys: count(100) },
};

/** a service with each part that describe() needs */
const declared = (name = "svc"): ServiceBuilder =>
  service(name)
    .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(45) })
    .startup(s(60))
    .phase("drain", s(10))
    .cooperativeWindow(s(2))
    .onRepeatSignal("ignore");

const allowed = (remaining: number): Decision => ({ allowed: true, remaining });
const refused = (ms: number, cause: "limit" | "cap" | "store" = "limit"): Decision => ({ allowed: false, retryAfter: { value: ms, unit: "ms" }, cause });

describe("a limiter is declared as data, with no defaults (SYS-28)", () => {
  it("shows each limiter in describe(), with its key, its policy, its store and its bound", () => {
    const svc = declared().dependency("cache", { system: null, knobs: {}, operations: {} });
    svc.limiter("writes", WINDOW).limiter("calls", { ...BUCKET, store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" } });
    expect(svc.describe().limiters).toEqual([
      { name: "writes", ...WINDOW },
      { name: "calls", ...BUCKET, store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" } },
    ]);
  });

  it("refuses a shared store without onStoreFailure, and names the part: a failure of the store has no default", () => {
    const svc = (store: unknown) =>
      declared()
        .dependency("cache", { system: null, knobs: {}, operations: {} })
        .limiter("writes", { ...BUCKET, store } as LimiterSpec);
    expect(() => svc({ kind: "shared", dependency: "cache" }).describe()).toThrow(
      /limiter writes does not declare what a failure of its shared store does, "open" or "closed" \(store\.onStoreFailure\): a limiter has no defaults/,
    );
    expect(() => svc({ kind: "shared", dependency: "cache", onStoreFailure: "retry" }).describe()).toThrow(/onStoreFailure retry is not "open" or "closed"/);
    for (const onStoreFailure of ["open", "closed"]) expect(() => svc({ kind: "shared", dependency: "cache", onStoreFailure }).describe()).not.toThrow();
    // a local store does not fail: it needs no policy, and the limiter ignores one
    expect(() => svc({ kind: "local" }).describe()).not.toThrow();
    expect(() => svc({ kind: "local", onStoreFailure: "open" }).describe()).not.toThrow();
  });

  it("gives no limiters field to a service without a limiter, as in 0.5.2", () => {
    expect(declared().describe()).not.toHaveProperty("limiters");
  });

  it("refuses each absent part, and names it: the rate, the burst, the limit, the window, the store and the bound", () => {
    const refuses = (spec: unknown, part: RegExp): void => {
      expect(() => declared().limiter("writes", spec as LimiterSpec).describe()).toThrow(part);
    };
    const { rate: _rate, ...noRate } = BUCKET.policy as { rate: unknown; burst: unknown; type: string };
    const { burst: _burst, ...noBurst } = BUCKET.policy as { rate: unknown; burst: unknown; type: string };
    const { limit: _limit, ...noLimit } = WINDOW.policy as { limit: unknown; window: unknown; type: string };
    const { window: _window, ...noWindow } = WINDOW.policy as { limit: unknown; window: unknown; type: string };
    refuses({ ...BUCKET, policy: noRate }, /does not declare the rate of its bucket \(policy\.rate\): a limiter has no defaults/);
    refuses({ ...BUCKET, policy: noBurst }, /does not declare the size of its bucket \(policy\.burst\)/);
    refuses({ ...WINDOW, policy: noLimit }, /does not declare the limit of its window \(policy\.limit\)/);
    refuses({ ...WINDOW, policy: noWindow }, /does not declare the length of its window \(policy\.window\)/);
    const { store: _store, ...noStore } = BUCKET;
    refuses(noStore, /does not declare its store/);
    const { evict: _evict, ...noEvict } = BUCKET;
    refuses(noEvict, /does not declare the most keys that it holds \(evict\.maxKeys\)/);
    const { key: _key, ...noKey } = BUCKET;
    refuses(noKey, /does not declare what its key is/);
    const { policy: _policy, ...noPolicy } = BUCKET;
    refuses(noPolicy, /does not declare its policy/);
  });

  it("refuses parts in the wrong unit, a key count without a bound, and a shared store that is not a dependency", () => {
    const refuses = (spec: unknown, part: RegExp): void => {
      expect(() => declared().limiter("writes", spec as LimiterSpec).describe()).toThrow(part);
    };
    refuses({ ...BUCKET, policy: { ...BUCKET.policy, rate: s(1) } }, /rate is not a count for each unit of time/);
    refuses({ ...BUCKET, policy: { ...BUCKET.policy, burst: count(2.5) } }, /burst is not a whole count above zero/);
    refuses({ ...WINDOW, policy: { ...WINDOW.policy, window: count(60) } }, /window is not a time/);
    refuses({ ...WINDOW, policy: { ...WINDOW.policy, window: s(0) } }, /window is not a finite time above zero/);
    refuses({ ...BUCKET, evict: { maxKeys: { value: "infinite", unit: "count" } } }, /maxKeys is not a whole count above zero: the count of keys has a bound/);
    refuses({ ...BUCKET, policy: { type: "leaky" } }, /policy leaky is not "token-bucket" or "sliding-window"/);
    refuses({ ...BUCKET, store: { kind: "shared", dependency: "cache", onStoreFailure: "open" } }, /keeps its counts in cache, which is not a dependency/);
    refuses({ ...BUCKET, store: { kind: "disk" } }, /store disk is not "local" or "shared"/);
  });

  it("refuses a second limiter of one name, and a limiter after the start", async () => {
    expect(() => declared().limiter("writes", WINDOW).limiter("writes", BUCKET)).toThrow(/already has a limiter named writes/);
    const svc = declared();
    await svc.start({ clock: fakeClock() });
    expect(() => svc.limiter("late", WINDOW)).toThrow(/has started/);
    svc.health?.stop();
  });

  it("makes its runtime from the same spec, and refuses a spec with a problem or a store of the wrong kind", () => {
    const limiter = keyedLimiter("writes", WINDOW, memoryStore(fakeClock()));
    expect(limiter.spec).toEqual(WINDOW);
    expect(limiter.rule).toEqual({ type: "sliding-window", limit: 3, window: 60_000 });
    expect(limiter.maxKeys).toBe(100);
    expect(() => keyedLimiter("writes", { ...WINDOW, key: " " }, memoryStore(fakeClock()))).toThrow(/names no key/);
    expect(() => keyedLimiter("writes", { ...WINDOW, store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" } }, memoryStore(fakeClock()))).toThrow(
      /declares a shared store, but the store that it got is local/,
    );
  });
});

describe("the decision is typed, and exact on the clock", () => {
  it("gives a token bucket its burst at once, then one take for each interval", async () => {
    const clock = fakeClock();
    const limiter = keyedLimiter("calls", BUCKET, memoryStore(clock));
    expect(await limiter.take("a")).toEqual(allowed(2));
    expect(await limiter.take("a")).toEqual(allowed(1));
    expect(await limiter.take("a")).toEqual(allowed(0));
    expect(await limiter.take("a")).toEqual(refused(1000));
    await clock.advance(999);
    expect(await limiter.take("a")).toEqual(refused(1));
    await clock.advance(1);
    expect(await limiter.take("a")).toEqual(allowed(0));
    // another key has its own bucket
    expect(await limiter.take("b")).toEqual(allowed(2));
    // after burst / rate idle, the bucket is full again
    await clock.advance(3000);
    expect(await limiter.take("a")).toEqual(allowed(2));
  });

  it("gives a sliding window its limit in each window, from the time of each take, as Graph does", async () => {
    const clock = fakeClock();
    const limiter = keyedLimiter("writes", WINDOW, memoryStore(clock));
    expect(await limiter.take("t")).toEqual(allowed(2));
    await clock.advance(10_000);
    expect(await limiter.take("t")).toEqual(allowed(1));
    await clock.advance(10_000);
    expect(await limiter.take("t")).toEqual(allowed(0));
    await clock.advance(10_000);
    // the oldest take, at 0 s, leaves the window at 60 s: 30 s from now
    expect(await limiter.take("t")).toEqual(refused(30_000));
    await clock.advance(30_000);
    expect(await limiter.take("t")).toEqual(allowed(0));
    expect(await limiter.take("t")).toEqual(refused(10_000));
  });

  it("converts each rate exactly: 10 for each minute is one token each 6000 ms", () => {
    expect(limitRule({ type: "token-bucket", rate: { value: 10, unit: "count/min" }, burst: count(5) })).toEqual({ type: "token-bucket", interval: 6000, burst: 5 });
    expect(limitRule({ type: "token-bucket", rate: { value: 10, unit: "Hz" }, burst: count(1) })).toEqual({ type: "token-bucket", interval: 100, burst: 1 });
    expect(limitRule({ type: "sliding-window", limit: count(100), window: { value: 1, unit: "min" } })).toEqual({ type: "sliding-window", limit: 100, window: 60_000 });
  });

  it("keeps a rate that floating point cannot hold exact: 3 each second gives 3 takes, then a refusal", async () => {
    const clock = fakeClock();
    const limiter = keyedLimiter("calls", { ...BUCKET, policy: { type: "token-bucket", rate: { value: 3, unit: "count/s" }, burst: count(3) } }, memoryStore(clock));
    const decisions = [];
    for (let take = 0; take < 4; take += 1) decisions.push((await limiter.take("a")).allowed);
    expect(decisions).toEqual([true, true, true, false]);
    for (let second = 0; second < 30; second += 1) {
      await clock.advance(1000);
      const burst = [];
      for (let take = 0; take < 4; take += 1) burst.push((await limiter.take("a")).allowed);
      expect(burst, `second ${second}`).toEqual([true, true, true, false]);
    }
  });

  it("gives the longest retryAfter of each policy, and the span after which a key is new again", () => {
    expect(longestRetryAfter(BUCKET.policy)).toEqual({ value: 1000, unit: "ms" });
    expect(idleSpan(BUCKET.policy)).toEqual({ value: 3000, unit: "ms" });
    expect(longestRetryAfter(WINDOW.policy)).toEqual({ value: 60_000, unit: "ms" });
    expect(idleSpan(WINDOW.policy)).toEqual({ value: 60_000, unit: "ms" });
  });
});

describe("the limiter reads the injected monotonic clock, never the wall clock", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves no count when a test steps the wall clock by hours, on the fake clock", async () => {
    const clock = fakeClock();
    const limiter = keyedLimiter("calls", BUCKET, memoryStore(clock));
    for (let take = 0; take < 3; take += 1) await limiter.take("a");
    const wall = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(wall + 6 * 3600 * 1000);
    expect(await limiter.take("a")).toEqual(refused(1000));
    vi.spyOn(Date, "now").mockReturnValue(wall - 6 * 3600 * 1000);
    expect(await limiter.take("a")).toEqual(refused(1000));
    await clock.advance(1000);
    expect(await limiter.take("a")).toEqual(allowed(0));
  });

  it("moves no count when the wall clock steps, on the clock of the platform", async () => {
    const limiter = keyedLimiter("writes", WINDOW, memoryStore(platformClock()));
    for (let take = 0; take < 3; take += 1) await limiter.take("t");
    const wall = Date.now();
    // a step of the wall clock forward by two windows: a store on wall time would allow the take
    vi.spyOn(Date, "now").mockReturnValue(wall + 2 * 60_000);
    const decision = await limiter.take("t");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfter.value).toBeGreaterThan(59_000);
  });
});

describe("the HTTP edge rounds Retry-After up to whole seconds", () => {
  it("rounds each retryAfter up, and never gives 0 for a refusal", () => {
    expect(retryAfterSeconds({ value: 1, unit: "ms" })).toBe(1);
    expect(retryAfterSeconds({ value: 1000, unit: "ms" })).toBe(1);
    expect(retryAfterSeconds({ value: 1001, unit: "ms" })).toBe(2);
    expect(retryAfterSeconds({ value: 30, unit: "s" })).toBe(30);
    // an error of floating point below one nanosecond does not add a second
    expect(retryAfterSeconds({ value: 2000.0000000001, unit: "ms" })).toBe(2);
    expect(retryAfterSeconds({ value: 2000.01, unit: "ms" })).toBe(3);
  });

  it("gives a refusal 429 with Retry-After, and the cause in the body", async () => {
    const clock = fakeClock();
    const limiter = keyedLimiter("calls", { ...BUCKET, policy: { type: "token-bucket", rate: { value: 10, unit: "count/s" }, burst: count(1) } }, memoryStore(clock));
    await limiter.take("a");
    const decision = await limiter.take("a");
    expect(decision).toEqual(refused(100));
    if (decision.allowed) return;
    const response = limitedResponse(decision);
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("1");
    expect(JSON.parse(String(response.body))).toEqual({ end: "refused", delivered: 0, retryable: true, cause: "the limiter refused the take: limit", retryAfter: 1 });
  });
});

/** a store with no eviction and no cap: the reference of the exact eviction */
const reference = (clock: { now(): number }): LimiterStore => {
  const states = new Map<string, KeyState>();
  return {
    kind: "local",
    take({ key, rule }) {
      const step = decide(rule, states.get(key), clock.now());
      states.set(key, step.state);
      return step.decision;
    },
  };
};

describe("the eviction is exact, and the count of keys has a bound", () => {
  it("removes a bucket that is full again and a window with no take, and each decision stays the same", async () => {
    for (const spec of [BUCKET, WINDOW]) {
      const clock = fakeClock();
      const store = memoryStore(clock);
      const exact = keyedLimiter("l", spec, store);
      const kept = keyedLimiter("l", spec, reference(clock));
      const random = seeded(28);
      for (let take = 0; take < 4000; take += 1) {
        const key = `k${Math.floor(random() * 40)}`;
        expect(await exact.take(key), `take ${take} of ${key}`).toEqual(await kept.take(key));
        await clock.advance(Math.floor(random() * (spec === BUCKET ? 400 : 4000)));
      }
      // the bound held, and the store removed keys as they became new again
      expect(store.size("l")).toBeLessThanOrEqual(40);
    }
  });

  it("refuses at the cap only while each held key is busy, and never says to wait longer than the true time", async () => {
    for (const spec of [BUCKET, WINDOW]) {
      const clock = fakeClock();
      const store = memoryStore(clock);
      const capped = keyedLimiter("l", { ...spec, evict: { maxKeys: count(8) } }, store);
      const rule = limitRule(spec.policy);
      // the reference keeps each key that the capped store admitted, and never removes one
      const states = new Map<string, KeyState>();
      const random = seeded(7);
      let caps = 0;
      for (let take = 0; take < 4000; take += 1) {
        const key = `k${Math.floor(random() * 24)}`;
        const now = clock.now();
        const decision = await capped.take(key);
        const busy = [...states.values()].map((state) => freeAt(rule, state)).filter((free) => free > now);
        if (!decision.allowed && decision.cause === "cap") {
          caps += 1;
          // the key is new, and each of the 8 held keys is busy
          expect(states.has(key) && freeAt(rule, states.get(key)!) > now).toBe(false);
          expect(busy).toHaveLength(8);
          expect(decision.retryAfter.value).toBeGreaterThan(0);
          expect(decision.retryAfter.value).toBeLessThanOrEqual(Math.min(...busy) - now);
        } else {
          const step = decide(rule, states.get(key), now);
          expect(decision, `take ${take} of ${key}`).toEqual(step.decision);
          states.set(key, step.state);
        }
        expect(store.size("l")).toBeLessThanOrEqual(8);
        await clock.advance(Math.floor(random() * (spec === BUCKET ? 300 : 3000)));
      }
      // the test met the cap many times
      expect(caps).toBeGreaterThan(100);
    }
  });

  it("frees a key after burst / rate idle, and a window after one window idle", async () => {
    for (const [spec, span] of [
      [BUCKET, 3000],
      [WINDOW, 60_000],
    ] as const) {
      const clock = fakeClock();
      const store = memoryStore(clock);
      const limiter = keyedLimiter("l", { ...spec, evict: { maxKeys: count(1) } }, store);
      // three takes: an empty bucket, or a full window
      for (let take = 0; take < 3; take += 1) await limiter.take("a");
      await clock.advance(span - 1);
      expect(await limiter.take("b")).toEqual(refused(1, "cap"));
      await clock.advance(1);
      expect((await limiter.take("b")).allowed).toBe(true);
      expect(store.size("l")).toBe(1);
    }
  });

  it("refuses a new key at the cap until the earliest held key is free, and a held key keeps its count", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const limiter = keyedLimiter("calls", { ...BUCKET, evict: { maxKeys: count(2) } }, store);
    await limiter.take("a"); // a is free at 1000
    await clock.advance(500);
    await limiter.take("b");
    await limiter.take("b"); // b is free at 2500
    expect(store.size("calls")).toBe(2);
    // the cost of a refused key at the cap: a refusal until the earliest held key is free, at most burst / rate
    expect(await limiter.take("c")).toEqual(refused(500, "cap"));
    // the held keys still decide as before
    expect(await limiter.take("b")).toEqual(allowed(0));
    expect(await limiter.take("b")).toEqual(refused(1000));
    await clock.advance(500);
    expect(await limiter.take("c")).toEqual(allowed(2));
    expect(store.size("calls")).toBe(2);
    // a was removed exactly: its next take is the take of a new key, and the cap now refuses it
    expect((await limiter.take("a")).allowed).toBe(false);
  });

  it("keeps each limiter apart in one store", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const one = keyedLimiter("one", { ...BUCKET, evict: { maxKeys: count(1) } }, store);
    const two = keyedLimiter("two", { ...BUCKET, evict: { maxKeys: count(1) } }, store);
    expect((await one.take("a")).allowed).toBe(true);
    expect((await two.take("b")).allowed).toBe(true);
    expect([store.size("one"), store.size("two")]).toEqual([1, 1]);
  });

  it("gives freeAt from the state: the full time of a bucket, and one window after the last take", () => {
    const bucket = limitRule(BUCKET.policy);
    const window: LimitRule = limitRule(WINDOW.policy);
    expect(freeAt(bucket, { type: "token-bucket", full: 4200 })).toBe(4200);
    expect(freeAt(window, { type: "sliding-window", stamps: [100, 900] })).toBe(60_900);
    expect(freeAt(window, { type: "sliding-window", stamps: [] })).toBe(Number.NEGATIVE_INFINITY);
  });
});

/** a store that the replicas share: it decides on its own clock, after a round trip */
const sharedStore = (clock: Clock): LimiterStore & { readonly requests: TakeRequest[] } => {
  const inner = memoryStore(clock);
  const requests: TakeRequest[] = [];
  return {
    kind: "shared",
    requests,
    async take(request) {
      requests.push(request);
      await Promise.resolve();
      return inner.take(request);
    },
  };
};

describe("the store is an interface: a shared store, or one store for each replica", () => {
  const SHARED: LimiterSpec = { ...WINDOW, store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" } };
  const failing: LimiterStore = { kind: "shared", take: () => Promise.reject(new Error("the store is down")) };
  const throwing: LimiterStore = {
    kind: "shared",
    take: () => {
      throw new Error("no connection");
    },
  };

  it("holds the limit across two replicas on one shared store, on the clock of the store", async () => {
    const storeClock = fakeClock(5_000_000);
    const store = sharedStore(storeClock);
    const replicas = [keyedLimiter("writes", SHARED, store), keyedLimiter("writes", SHARED, store)];
    const decisions = [];
    for (let take = 0; take < 6; take += 1) decisions.push((await replicas[take % 2]!.take("t")).allowed);
    expect(decisions).toEqual([true, true, true, false, false, false]);
    expect(store.requests[0]).toEqual({ limiter: "writes", key: "t", rule: { type: "sliding-window", limit: 3, window: 60_000 }, maxKeys: 100 });
  });

  it("lets each take in when the shared store fails and the spec declares open", async () => {
    const open: LimiterSpec = { ...SHARED, store: { kind: "shared", dependency: "cache", onStoreFailure: "open" } };
    expect(await keyedLimiter("writes", open, failing).take("t")).toEqual({ allowed: true, remaining: 0, failure: "the store is down" });
    expect(await keyedLimiter("writes", open, throwing).take("t")).toEqual({ allowed: true, remaining: 0, failure: "no connection" });
  });

  it("refuses each take with the cause store and the longest retryAfter of the policy when the spec declares closed", async () => {
    expect(await keyedLimiter("writes", SHARED, failing).take("t")).toEqual({ ...refused(60_000, "store"), failure: "the store is down" });
    const bucket: LimiterSpec = { ...BUCKET, store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" } };
    expect(await keyedLimiter("calls", bucket, throwing).take("t")).toEqual({ ...refused(1000, "store"), failure: "no connection" });
    // the HTTP edge gives the cause, and not the text of the failure
    const decision = await keyedLimiter("writes", SHARED, failing).take("t");
    if (decision.allowed) throw new Error("the take is refused");
    const response = limitedResponse(decision);
    expect([response.status, response.headers["retry-after"]]).toEqual([429, "60"]);
    expect(String(response.body)).not.toContain("the store is down");
  });

  it("decides as the store does while the shared store answers, and a failing local store rejects the take", async () => {
    let down = false;
    const inner = memoryStore(fakeClock());
    const flaky: LimiterStore = { kind: "shared", take: (request) => (down ? Promise.reject(new Error("down")) : inner.take(request)) };
    const limiter = keyedLimiter("writes", SHARED, flaky);
    expect(await limiter.take("t")).toEqual(allowed(2));
    down = true;
    expect(await limiter.take("t")).toEqual({ ...refused(60_000, "store"), failure: "down" });
    down = false;
    // the refusal of the failure took no unit of the key
    expect(await limiter.take("t")).toEqual(allowed(1));
    const local: LimiterStore = { kind: "local", take: () => Promise.reject(new Error("a local store failed")) };
    await expect(keyedLimiter("writes", WINDOW, local).take("t")).rejects.toThrow("a local store failed");
  });

  it("holds limit / N on each replica without a shared store only on average", async () => {
    // a limit of 4 in each window over 2 replicas: each replica holds 2
    const half: LimiterSpec = { ...WINDOW, policy: { type: "sliding-window", limit: count(2), window: s(60) } };
    const clock = fakeClock();
    const replicas = [keyedLimiter("writes", half, memoryStore(clock)), keyedLimiter("writes", half, memoryStore(clock))];
    // an even balancer gives the whole limit of 4
    const even = [];
    for (let take = 0; take < 6; take += 1) even.push((await replicas[take % 2]!.take("even")).allowed);
    expect(even.filter(Boolean)).toHaveLength(4);
    // a balancer that sends each take of a key to one replica gives only half the limit
    const pinned = [];
    for (let take = 0; take < 6; take += 1) pinned.push((await replicas[0]!.take("pinned")).allowed);
    expect(pinned.filter(Boolean)).toHaveLength(2);
  });
});

describe("lint() applies O29 and O30 to each limiter", () => {
  const scenario = (callers: Scenario["limiters"]): Scenario => ({ platform: {}, probes: { readiness: s(30), liveness: s(30) }, limiters: callers });

  it("has the two rules in SERVICE_RULES, each with its statement", () => {
    expect(LIMITER_RULES.map((rule) => rule.id)).toEqual(["O29", "O30"]);
    for (const rule of LIMITER_RULES) expect(SERVICE_RULES).toContain(rule.id);
  });

  it("binds the longest Retry-After of the policy in whole seconds, and the values of the callers", () => {
    const svc = declared()
      .limiter("writes", WINDOW)
      .limiter("calls", { ...BUCKET, policy: { type: "token-bucket", rate: { value: 10, unit: "count/min" }, burst: count(5) } })
      .describe();
    const findings = lint(
      svc,
      scenario({
        writes: { "client_retry_window@caller": s(30), retry_delay: s(1) },
        calls: { client_retry_window: s(120), retry_delay: s(6) },
      }),
      LIMITER_RULES,
    );
    expect(
      findings.map(({ rule, scope, verdict, evaluated }) => ({ rule, scope, verdict, lhs: evaluated[0]?.lhs, rhs: evaluated[0]?.rhs, atCap: evaluated[1]?.lhs })),
    ).toEqual([
      // the window of 60 s is longer than the retry window of 30 s, and a new key at the cap also waits up to 60 s
      { rule: "O29", scope: "writes", verdict: "violated", lhs: 60, rhs: 30, atCap: 60 },
      // one token each 6 s: the longest Retry-After is 6 s, and 30 s at the cap (5 tokens)
      { rule: "O29", scope: "calls", verdict: "holds", lhs: 6, rhs: 120, atCap: 30 },
      // a caller that sends again after 1 s meets the window of 60 s again
      { rule: "O30", scope: "writes", verdict: "violated", lhs: 1, rhs: 60, atCap: undefined },
      { rule: "O30", scope: "calls", verdict: "holds", lhs: 6, rhs: 6, atCap: undefined },
    ]);
  });

  it("gives depends when the scenario does not give the callers, and no finding for a service without a limiter", () => {
    const findings = lint(declared().limiter("writes", WINDOW).describe(), scenario(undefined), LIMITER_RULES);
    expect(findings.map(({ verdict, unbound }) => ({ verdict, unbound }))).toEqual([
      { verdict: "depends", unbound: ["client_retry_window@caller"] },
      { verdict: "depends", unbound: ["retry_delay@caller"] },
    ]);
    expect(lint(declared().describe(), scenario(undefined), LIMITER_RULES)).toEqual([]);
  });

  it("fails O29 at the cap of keys alone: a new key can wait the idle span", () => {
    const findings = lint(declared().limiter("calls", BUCKET).describe(), scenario({ calls: { client_retry_window: s(2) } }), LIMITER_RULES);
    // the bucket of 3 at 1 each second: a refusal of the policy waits 1 s, but a new key at the cap waits up to 3 s
    expect(findings[0]).toMatchObject({
      rule: "O29",
      verdict: "violated",
      evaluated: [
        { lhs: 1, rhs: 2, holds: true },
        { lhs: 3, rhs: 2, holds: false },
      ],
    });
  });
});
