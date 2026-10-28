import { describe, expect, expectTypeOf, it } from "vitest";
import type { Decision, KeyedLimiter, LimiterSpec, LimiterStore, LocalLimiter } from "./index.ts";
import { decide, keyedLimiter, memoryStore } from "./index.ts";
import { fakeClock } from "./testing.ts";

/** SYS-46: a take that gives its decision at once, on the memory store of one replica. */

const s = (value: number) => ({ value, unit: "s" });
const count = (value: number) => ({ value, unit: "count" });

/** 3 writes in each sliding minute, in memory, with room for 100 keys */
const WINDOW: LimiterSpec = {
  key: "tenant",
  policy: { type: "sliding-window", limit: count(3), window: s(60) },
  store: { kind: "local" },
  evict: { maxKeys: count(100) },
};

const SHARED: LimiterSpec = { ...WINDOW, store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" } };

describe("tryTakeSync: the decision of a memory store at once (SYS-46)", () => {
  it("gives the same decisions as take(), with no promise, and retryAfter as a quantity", async () => {
    const clock = fakeClock();
    const sync = keyedLimiter("writes", WINDOW, memoryStore(clock));
    const async = keyedLimiter("writes", WINDOW, memoryStore(clock));
    const decisions: Decision[] = [];
    for (let take = 0; take < 4; take += 1) {
      const decision = sync.tryTakeSync("acme");
      expect(decision).not.toBeInstanceOf(Promise);
      expect(decision).toEqual(await async.take("acme"));
      decisions.push(decision);
      await clock.advance(1000);
    }
    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false]);
    expect(decisions[3]).toEqual({ allowed: false, retryAfter: { value: 57000, unit: "ms" }, cause: "limit" });
    // the take() and the tryTakeSync() of one limiter share the counts of the key
    await clock.advance(60000);
    expect(sync.tryTakeSync("acme").allowed).toBe(true);
    expect(await sync.take("acme")).toEqual({ allowed: true, remaining: 1 });
  });

  it("is on the type of a limiter on a memory store, and optional on KeyedLimiter", () => {
    const local = keyedLimiter("writes", WINDOW, memoryStore(fakeClock()));
    expectTypeOf(local).toEqualTypeOf<LocalLimiter>();
    expectTypeOf(local.tryTakeSync).returns.toEqualTypeOf<Decision>();
    expectTypeOf<KeyedLimiter["tryTakeSync"]>().toEqualTypeOf<((key: string) => Decision) | undefined>();
  });

  it("throws a clear error for a shared store, before the store takes", () => {
    let takes = 0;
    const shared: LimiterStore = {
      kind: "shared",
      take: async () => {
        takes += 1;
        return { allowed: true, remaining: 0 };
      },
    };
    const limiter = keyedLimiter("writes", SHARED, shared);
    expect(() => limiter.tryTakeSync!("acme")).toThrow(
      "limiter writes has a shared store, which decides in a promise: tryTakeSync needs a memory store, thus use take()",
    );
    expect(takes).toBe(0);
  });

  it("throws a clear error for a local store whose take gives a promise, and leaves no rejection unhandled", () => {
    const clock = fakeClock();
    const slow: LimiterStore = { kind: "local", take: async () => Promise.reject(new Error("the store failed")) };
    const limiter = keyedLimiter("writes", WINDOW, slow);
    expect(() => limiter.tryTakeSync!("acme")).toThrow(
      "limiter writes has a store whose take gives a promise: tryTakeSync needs a memory store, thus use take()",
    );
    // a local store of its own that decides at once also works
    const own: LimiterStore = { kind: "local", take: ({ rule }) => decide(rule, undefined, clock.now()).decision };
    expect(keyedLimiter("writes", WINDOW, own).tryTakeSync!("acme")).toEqual({ allowed: true, remaining: 2 });
  });
});
