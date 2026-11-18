import { describe, expect, it } from "vitest";
import type { Decision, LimiterSpec } from "../index.ts";
import { keyedLimiter } from "../index.ts";
import type { RedisSender, Sent } from "../redis.ts";
import { LIMITER_RELEASE_SCRIPT, LIMITER_SCRIPT, redisLimiterStore } from "../redis.ts";
import { fakeClock } from "../testing.ts";

const count = (value: number) => ({ value, unit: "count" });
const SHARED: LimiterSpec = {
  key: "tenant",
  policy: { type: "token-bucket", rate: { value: 10, unit: "count/s" }, burst: count(3) },
  store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" },
  evict: { maxKeys: count(50) },
};

/** a sender that keeps each command and answers with the next reply of a list */
const scripted = (...replies: Array<Sent<unknown>>) => {
  const sent: Array<{ command: string; args: ReadonlyArray<string | number> }> = [];
  const sender: RedisSender = {
    send: async <T>(command: string, args: ReadonlyArray<string | number> = []) => {
      sent.push({ command, args });
      return replies.shift() as Sent<T>;
    },
  };
  return { sender, sent };
};

const ok = (value: unknown): Sent<unknown> => ({ outcome: "ok", value, attempts: 1 });

describe("the Redis store of a keyed limiter (SYS-28)", () => {
  it("sends one EVAL with the state and the index of the limiter in one hash slot, and the time of TIME", async () => {
    const { sender, sent } = scripted(ok([1, 2]));
    const limiter = keyedLimiter("writes", SHARED, redisLimiterStore(sender, { prefix: "limit:" }));
    expect(await limiter.take("acme")).toEqual({ allowed: true, remaining: 2 });
    expect(sent).toEqual([
      {
        command: "EVAL",
        args: [LIMITER_SCRIPT, 2, "limit:{writes}:key:acme", "limit:{writes}:keys", "token-bucket", "100", "3", "50", "acme", "", "1", ""],
      },
    ]);
    // the script reads TIME when the store has no clock
    expect(LIMITER_SCRIPT).toContain("redis.call('TIME')");
  });

  it("gives the time of its clock in place of TIME, for a test", async () => {
    const clock = fakeClock(1234);
    const { sender, sent } = scripted(ok([0, "100.000000", "limit"]));
    const store = redisLimiterStore(sender, { prefix: "t:", clock });
    expect(await store.take({ limiter: "w", key: "k", rule: { type: "sliding-window", limit: 2, window: 60_000 }, maxKeys: 9 })).toEqual({
      allowed: false,
      retryAfter: { value: 100, unit: "ms" },
      cause: "limit",
    });
    expect(sent[0]!.args.slice(4)).toEqual(["sliding-window", "2", "60000", "9", "k", "1234", "1", ""]);
  });

  it("sends the units of a take, and refuses a take over the capacity with no EVAL", async () => {
    const { sender, sent } = scripted(ok([1, 0]));
    const limiter = keyedLimiter("writes", SHARED, redisLimiterStore(sender, { prefix: "limit:" }));
    expect(await limiter.take("acme", 3)).toEqual({ allowed: true, remaining: 0 });
    // the last part is the declared retryAfter of an in-flight bound, thus the units are the part before it
    expect(sent[0]!.args.at(-2)).toBe("3");
    // the burst is 3: a take of 4 never fits, at each time
    expect(await limiter.take("acme", 4)).toEqual({ allowed: false, cause: "capacity", units: 4, capacity: 3 });
    const store = redisLimiterStore(sender, { prefix: "" });
    expect(await store.take({ limiter: "w", key: "k", rule: { type: "sliding-window", limit: 2, window: 60_000 }, maxKeys: 9, units: 5 })).toEqual({
      allowed: false,
      cause: "capacity",
      units: 5,
      capacity: 2,
    });
    expect(sent).toHaveLength(1);
    await expect(limiter.take("acme", 0)).rejects.toThrow(/whole number of 1 or more/);
  });

  it("reads a refusal at the cap", async () => {
    const { sender } = scripted(ok([0, "2500.000000", "cap"]));
    expect(await keyedLimiter("writes", SHARED, redisLimiterStore(sender, { prefix: "" })).take("new")).toEqual({
      allowed: false,
      retryAfter: { value: 2500, unit: "ms" },
      cause: "cap",
    });
  });

  it("rejects the take of the store on an error, on an outcome that is not certain, and on a reply of another shape", async () => {
    const { sender } = scripted(
      { outcome: "error", error: "NOSCRIPT", reply: true, attempts: 1 },
      { outcome: "indeterminate", error: "the command timed out", attempts: 1 },
      ok("OK"),
      ok([0, "0", "limit"]),
    );
    const store = redisLimiterStore(sender, { prefix: "" });
    const request = { limiter: "writes", key: "a", rule: { type: "token-bucket", interval: 100, burst: 3 }, maxKeys: 50 } as const;
    await expect(store.take(request)).rejects.toThrow("the limiter store writes failed (error): NOSCRIPT");
    await expect(store.take(request)).rejects.toThrow("failed (indeterminate): the command timed out");
    await expect(store.take(request)).rejects.toThrow(/gave a reply that is not a decision: "OK"/);
    // a refusal is always above zero
    await expect(store.take(request)).rejects.toThrow(/not a decision/);
  });

  it("follows onStoreFailure through the limiter: closed refuses with the cause store, and open lets the take in", async () => {
    const down = (): Sent<unknown> => ({ outcome: "indeterminate", error: "the command timed out", attempts: 1 });
    const closed = keyedLimiter("writes", SHARED, redisLimiterStore(scripted(down()).sender, { prefix: "" }));
    // the longest retryAfter of the policy: one token each 100 ms
    expect(await closed.take("a")).toEqual({
      allowed: false,
      retryAfter: { value: 100, unit: "ms" },
      cause: "store",
      failure: "the limiter store writes failed (indeterminate): the command timed out",
    });
    const open = keyedLimiter("writes", { ...SHARED, store: { kind: "shared", dependency: "cache", onStoreFailure: "open" } }, redisLimiterStore(scripted(ok("OK")).sender, { prefix: "" }));
    expect(await open.take("a")).toEqual({ allowed: true, remaining: 0, failure: 'the limiter store writes gave a reply that is not a decision: "OK"' });
  });

  const BOUND: LimiterSpec = {
    ...SHARED,
    policy: { type: "in-flight", limit: count(2), lease: { value: 30, unit: "s" }, retryAfter: { value: 1, unit: "s" } },
  };

  it("sends the declared retryAfter of an in-flight bound, and reads the start of each lease from the reply", async () => {
    const clock = fakeClock(500);
    const { sender, sent } = scripted(ok([1, 1, "500.000000"]), ok([0, "1000.000000", "limit"]));
    const limiter = keyedLimiter("calls", BOUND, redisLimiterStore(sender, { prefix: "l:", clock }));
    expect(await limiter.take("acme")).toEqual({ allowed: true, remaining: 1, lease: { start: 500, units: 1 } });
    expect(await limiter.take("acme", 2)).toEqual({ allowed: false, retryAfter: { value: 1000, unit: "ms" }, cause: "limit" });
    expect(sent.map((each) => each.args.slice(4))).toEqual([
      ["in-flight", "2", "30000", "50", "acme", "500", "1", "1000"],
      ["in-flight", "2", "30000", "50", "acme", "500", "2", "1000"],
    ]);
  });

  it("refuses a permitted reply of an in-flight bound with no start, and a reply of a rate policy with a start", async () => {
    const store = redisLimiterStore(scripted(ok([1, 1]), ok([1, 1, "x"]), ok([1, 1, "500.000000"])).sender, { prefix: "" });
    const bound = { limiter: "calls", key: "a", rule: { type: "in-flight", limit: 2, lease: 30_000, retryAfter: 1000 }, maxKeys: 50 } as const;
    await expect(store.take(bound)).rejects.toThrow(/is not a decision: \[1,1\]/);
    await expect(store.take(bound)).rejects.toThrow(/is not a decision: \[1,1,"x"\]/);
    const bucket = { limiter: "writes", key: "a", rule: { type: "token-bucket", interval: 100, burst: 3 }, maxKeys: 50 } as const;
    await expect(store.take(bucket)).rejects.toThrow(/is not a decision/);
  });

  it("releases a lease in one EVAL of the release script, and sends no command for a refusal or a rate policy", async () => {
    const clock = fakeClock(500);
    const { sender, sent } = scripted(ok([1, 0, "500.000000"]), ok(2));
    const limiter = keyedLimiter("calls", BOUND, redisLimiterStore(sender, { prefix: "l:", clock }));
    const taken = await limiter.take("acme", 2);
    await clock.advance(250);
    await limiter.release("acme", taken);
    expect(sent[1]).toEqual({
      command: "EVAL",
      args: [LIMITER_RELEASE_SCRIPT, 2, "l:{calls}:key:acme", "l:{calls}:keys", "30000", "acme", "750", "500", "2"],
    });
    // the release removes the state and the index entry of a key with no held unit
    expect(LIMITER_RELEASE_SCRIPT).toContain("redis.call('DEL', KEYS[1])");
    await limiter.release("acme", { allowed: false, retryAfter: { value: 1, unit: "ms" }, cause: "limit" });
    const store = redisLimiterStore(sender, { prefix: "l:", clock });
    await store.release({ limiter: "writes", key: "acme", rule: { type: "token-bucket", interval: 100, burst: 3 }, lease: { start: 0, units: 1 } });
    expect(sent).toHaveLength(2);
  });

  it("rejects a release on an error, on an outcome that is not certain, and on a reply that is not a count of the units", async () => {
    const down: Sent<unknown> = { outcome: "error", error: "NOSCRIPT", reply: true, attempts: 1 };
    const unknown: Sent<unknown> = { outcome: "indeterminate", error: "the command timed out", attempts: 1 };
    for (const [reply, message] of [
      [down, /failed to release \(error\)/],
      [unknown, /failed to release \(indeterminate\)/],
      [ok(3), /is not a count of released units/],
      [ok(-1), /is not a count of released units/],
      [ok("x"), /is not a count of released units/],
    ] as const) {
      const limiter = keyedLimiter("calls", BOUND, redisLimiterStore(scripted(ok([1, 0, "0.000000"]), reply).sender, { prefix: "" }));
      const taken: Decision = await limiter.take("a", 2);
      await expect(limiter.release("a", taken)).rejects.toThrow(message);
    }
  });

  it("is a shared store, and refuses a prefix with a brace", () => {
    const { sender } = scripted();
    expect(redisLimiterStore(sender, { prefix: "x:" }).kind).toBe("shared");
    expect(() => keyedLimiter("writes", { ...SHARED, store: { kind: "local" } }, redisLimiterStore(sender, { prefix: "x:" }))).toThrow(
      /declares a local store, but the store that it got is shared/,
    );
    expect(() => redisLimiterStore(sender, { prefix: "a{b}:" })).toThrow(/has a brace/);
  });
});
