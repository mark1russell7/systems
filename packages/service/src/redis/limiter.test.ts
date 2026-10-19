import { describe, expect, it } from "vitest";
import type { LimiterSpec } from "../index.ts";
import { keyedLimiter } from "../index.ts";
import type { RedisSender, Sent } from "../redis.ts";
import { LIMITER_SCRIPT, redisLimiterStore } from "../redis.ts";
import { fakeClock } from "../testing.ts";

const count = (value: number) => ({ value, unit: "count" });
const SHARED: LimiterSpec = {
  key: "tenant",
  policy: { type: "token-bucket", rate: { value: 10, unit: "count/s" }, burst: count(3) },
  store: { kind: "shared", dependency: "cache" },
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
        args: [LIMITER_SCRIPT, 2, "limit:{writes}:key:acme", "limit:{writes}:keys", "token-bucket", "100", "3", "50", "acme", ""],
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
    expect(sent[0]!.args.slice(4)).toEqual(["sliding-window", "2", "60000", "9", "k", "1234"]);
  });

  it("reads a refusal at the cap", async () => {
    const { sender } = scripted(ok([0, "2500.000000", "cap"]));
    expect(await keyedLimiter("writes", SHARED, redisLimiterStore(sender, { prefix: "" })).take("new")).toEqual({
      allowed: false,
      retryAfter: { value: 2500, unit: "ms" },
      cause: "cap",
    });
  });

  it("rejects the take on an error, on an outcome that is not certain, and on a reply of another shape", async () => {
    const { sender } = scripted(
      { outcome: "error", error: "NOSCRIPT", reply: true, attempts: 1 },
      { outcome: "indeterminate", error: "the command timed out", attempts: 1 },
      ok("OK"),
      ok([0, "0", "limit"]),
    );
    const limiter = keyedLimiter("writes", SHARED, redisLimiterStore(sender, { prefix: "" }));
    await expect(limiter.take("a")).rejects.toThrow("the limiter store writes failed (error): NOSCRIPT");
    await expect(limiter.take("a")).rejects.toThrow("failed (indeterminate): the command timed out");
    await expect(limiter.take("a")).rejects.toThrow(/gave a reply that is not a decision: "OK"/);
    // a refusal is always above zero
    await expect(limiter.take("a")).rejects.toThrow(/not a decision/);
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
