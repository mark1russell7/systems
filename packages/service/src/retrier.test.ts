import { describe, expect, it } from "vitest";
import { backoffDelay, retrier, retry, retryAfterDelay } from "./index.ts";
import { fakeClock, seeded } from "./testing.ts";

/** SYS-46: a retrier over `backoffDelay`, on the injected clock. No test here uses a real timer. */

describe("retrier: the next attempt after its backoff (SYS-46)", () => {
  it("starts the function after the delay of each attempt, to the cap, and counts the attempts", async () => {
    const clock = fakeClock();
    const r = retrier({ base: 1000, factor: 2, cap: 30000, clock });
    const runs: number[] = [];
    const delays: Array<number | null> = [];
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      delays.push(r.schedule(() => runs.push(clock.now())));
      expect(r.attempts).toBe(attempt);
      expect(r.pending).toBe(true);
      await clock.advance(40000);
      expect(r.pending).toBe(false);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    // each run comes at the delay of its attempt after its schedule, not before
    expect(runs).toEqual([1000, 42000, 84000, 128000, 176000, 230000, 270000]);
  });

  it("does not start the function before its delay", async () => {
    const clock = fakeClock();
    const r = retrier({ base: 1000, clock });
    let runs = 0;
    r.schedule(() => (runs += 1));
    await clock.advance(999);
    expect(runs).toBe(0);
    await clock.advance(1);
    expect(runs).toBe(1);
  });

  it("gives the jitter of the policy, with the random numbers of the options", () => {
    const clock = fakeClock();
    const policy = { base: 1000, factor: 2, cap: 30000, jitter: { kind: "subtract", fraction: 1 } } as const;
    const r = retrier({ ...policy, clock, random: seeded(7) });
    const expected = seeded(7);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const delay = r.schedule(() => {})!;
      expect(delay).toBe(Math.round(backoffDelay(policy, attempt, expected)));
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(Math.min(30000, 1000 * 2 ** (attempt - 1)));
    }
  });

  it("sets the attempts to 0 at a reset, and the next delay is the base again", async () => {
    const clock = fakeClock();
    const r = retrier({ base: 1000, factor: 2, cap: 30000, clock });
    r.schedule(() => {});
    r.schedule(() => {});
    r.schedule(() => {});
    expect(r.attempts).toBe(3);
    r.reset();
    expect(r.attempts).toBe(0);
    // a reset does not stop the retry that waits
    expect(r.pending).toBe(true);
    expect(r.schedule(() => {})).toBe(1000);
  });

  it("stops the retry that waits at a cancel, and at a second schedule", async () => {
    const clock = fakeClock();
    const r = retrier({ base: 1000, clock });
    const runs: string[] = [];
    r.schedule(() => runs.push("first"));
    r.schedule(() => runs.push("second"));
    await clock.advance(10000);
    expect(runs).toEqual(["second"]);
    r.schedule(() => runs.push("third"));
    r.cancel();
    expect(r.pending).toBe(false);
    await clock.advance(60000);
    expect(runs).toEqual(["second"]);
    expect(clock.pending).toBe(0);
    // the count stays after a cancel
    expect(r.attempts).toBe(3);
  });

  it("cancels at the abort of its signal, as the signal of the lifecycle in the drain, and then starts nothing", async () => {
    const clock = fakeClock();
    const drain = new AbortController();
    const r = retrier({ base: 1000, clock, signal: drain.signal });
    let runs = 0;
    r.schedule(() => (runs += 1));
    drain.abort();
    expect(r.pending).toBe(false);
    expect(r.schedule(() => (runs += 1))).toBeNull();
    await clock.advance(60000);
    expect(runs).toBe(0);
    expect(clock.pending).toBe(0);
    expect(r.attempts).toBe(1);
  });

  it("starts nothing with a signal that aborted before", () => {
    const clock = fakeClock();
    const r = retrier({ base: 1000, clock, signal: AbortSignal.abort() });
    expect(r.schedule(() => {})).toBeNull();
    expect(r.attempts).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it("refuses a policy with a problem", () => {
    expect(() => retrier({ base: 1000, cap: 500 })).toThrow("the retrier has a bad backoff: the cap 500 is below the base 1000");
    expect(() => retrier({ base: -1 })).toThrow("the base -1 is not a time of zero or more");
  });
});

describe("retry: one async call with a count of tries", () => {
  const failing = (fails: number, error: (n: number) => unknown = (n) => new Error(`fail ${n}`)) => {
    const starts: number[] = [];
    return {
      starts,
      run: async (attempt: number) => {
        starts.push(attempt);
        if (attempt <= fails) throw error(attempt);
        return `ok on ${attempt}`;
      },
    };
  };

  it("gives the value of the first try that succeeds, after the backoff of each failed try", async () => {
    const clock = fakeClock();
    const call = failing(2);
    const at: number[] = [];
    const result = retry(async (n) => (at.push(clock.now()), call.run(n)), { tries: 4, base: 1000, factor: 2, clock });
    await clock.advance(999);
    expect(call.starts).toEqual([1]);
    await clock.advance(1);
    await clock.advance(2000);
    await expect(result).resolves.toBe("ok on 3");
    expect(at).toEqual([0, 1000, 3000]);
  });

  it("throws the last error after the count of tries", async () => {
    const clock = fakeClock();
    const call = failing(9);
    const result = retry(call.run, { tries: 3, base: 10, clock });
    const seen = result.catch((e: unknown) => e);
    await clock.advance(1000);
    expect(((await seen) as Error).message).toBe("fail 3");
    expect(call.starts).toEqual([1, 2, 3]);
  });

  it("does not start again after an error that is not retryable", async () => {
    const clock = fakeClock();
    const call = failing(9, (n) => ({ status: 403, n }));
    await expect(retry(call.run, { tries: 5, base: 10, clock, retryable: (e) => (e as { status: number }).status >= 500 })).rejects.toEqual({ status: 403, n: 1 });
    expect(call.starts).toEqual([1]);
  });

  it("waits the delay of delayOf in place of the backoff, and the backoff when delayOf gives null", async () => {
    const clock = fakeClock();
    const call = failing(2, (n) => ({ after: n === 1 ? 5000 : null }));
    const at: number[] = [];
    const result = retry(async (n) => (at.push(clock.now()), call.run(n)), {
      tries: 3,
      base: 100,
      clock,
      delayOf: (e) => (e as { after: number | null }).after,
    });
    await clock.advance(5000);
    await clock.advance(200);
    await expect(result).resolves.toBe("ok on 3");
    expect(at).toEqual([0, 5000, 5200]);
  });

  it("takes the jitter of the policy from the random of the options", async () => {
    const clock = fakeClock();
    const call = failing(1);
    const at: number[] = [];
    const result = retry(async (n) => (at.push(clock.now()), call.run(n)), { tries: 2, base: 1000, jitter: { kind: "subtract", fraction: 1 }, random: () => 0.25, clock });
    await clock.advance(1000);
    await result;
    expect(at).toEqual([0, backoffDelay({ base: 1000, jitter: { kind: "subtract", fraction: 1 } }, 1, () => 0.25)]);
  });

  it("stops the wait at the abort of the signal, and throws the last error", async () => {
    const clock = fakeClock();
    const control = new AbortController();
    const call = failing(9);
    const result = retry(call.run, { tries: 5, base: 1000, clock, signal: control.signal });
    const seen = result.catch((e: unknown) => e);
    await clock.advance(10);
    control.abort();
    expect(((await seen) as Error).message).toBe("fail 1");
    await clock.advance(10000);
    expect(call.starts).toEqual([1]);
  });

  it("refuses a bad count of tries and a bad backoff", async () => {
    await expect(retry(async () => 1, { tries: 0, base: 10 })).rejects.toThrow(/tries/);
    await expect(retry(async () => 1, { tries: 2.5, base: 10 })).rejects.toThrow(/tries/);
    await expect(retry(async () => 1, { tries: 2, base: -1 })).rejects.toThrow(/bad backoff/);
  });
});

describe("retryAfterDelay: the wait of a Retry-After header", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  it("reads seconds and HTTP dates, and gives null for no valid value", () => {
    expect(retryAfterDelay("5", now)).toBe(5000);
    expect(retryAfterDelay(" 0 ", now)).toBe(0);
    expect(retryAfterDelay("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(retryAfterDelay("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBe(0);
    for (const bad of ["soon", "-3", "1.5", "", null, undefined]) expect(retryAfterDelay(bad, now), String(bad)).toBeNull();
  });
});
