import { describe, expect, it } from "vitest";
import type { Backoff } from "./backoff.ts";
import { backoffBand, backoffDelay, backoffProblems } from "./backoff.ts";
import { seeded } from "./testing.ts";

/** The same random numbers twice: one sequence for the formula, one for the function. */
const twice = (seed: number): [() => number, () => number] => [seeded(seed), seeded(seed)];

describe("backoffDelay: the delays of the three backoffs that it replaces, number for number", () => {
  it("gives the retry strategy of the Redis client of service 0.3: doubling to the cap, plus a jitter up to the base", () => {
    const [mine, theirs] = twice(1);
    for (const [base, cap] of [
      [50, 400],
      [100, 5000],
      [0.3, 7.7],
    ] as const) {
      const policy: Backoff = { base, factor: 2, cap, jitter: { kind: "add", amount: base } };
      for (let times = 1; times <= 30; times += 1) {
        const delay = Math.min(base * 2 ** (times - 1), cap);
        expect(Math.round(backoffDelay(policy, times, mine))).toBe(Math.round(delay + theirs() * base));
      }
    }
  });

  it("gives reconnectDelay of the WebSocket client of the client package: a backoff with a jitter below it", () => {
    const [mine, theirs] = twice(2);
    for (const [initialDelay, backoffMultiplier, maxDelay, jitter] of [
      [1000, 1.5, 30_000, 1],
      [250, 2, 10_000, 0.5],
      [100, 1.5, 1000, 0],
    ] as const) {
      const policy: Backoff = { base: initialDelay, factor: backoffMultiplier, cap: maxDelay, jitter: { kind: "subtract", fraction: jitter } };
      for (let attempt = 1; attempt <= 30; attempt += 1) {
        const backoff = Math.min(initialDelay * Math.pow(backoffMultiplier, attempt - 1), maxDelay);
        expect(Math.round(backoffDelay(policy, attempt, mine))).toBe(Math.round(backoff * (1 - jitter * theirs())));
      }
    }
  });

  it("gives the delay of the retry middleware of the client package, whose attempts start at 0", () => {
    const [mine, theirs] = twice(3);
    for (const [retryDelay, multiplier, maxDelay, jitter] of [
      [1000, 2, 30_000, 1],
      [500, 3, Number.POSITIVE_INFINITY, 0.1],
      [200, 0, 1000, 1],
    ] as const) {
      const policy: Backoff = { base: retryDelay, factor: multiplier, cap: maxDelay, jitter: { kind: "subtract", fraction: jitter } };
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const capped = Math.min(maxDelay, retryDelay * Math.pow(multiplier, attempt));
        expect(backoffDelay(policy, attempt + 1, mine)).toBe(Math.max(0, capped * (1 - jitter * theirs())));
      }
    }
  });

  it("has the defaults: a factor of 2, no cap and no jitter", () => {
    expect([1, 2, 3, 40].map((attempt) => backoffDelay({ base: 10 }, attempt))).toEqual([10, 20, 40, 10 * 2 ** 39]);
    expect(backoffDelay({ base: 0 }, 5000)).toBe(0);
  });

  it("refuses a try that is not a whole number from 1", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect(() => backoffDelay({ base: 10 }, attempt)).toThrow(RangeError);
      expect(() => backoffBand({ base: 10 }, attempt)).toThrow(RangeError);
    }
  });
});

describe("backoffBand: the least and the most delay, for the ordering law", () => {
  it("gives the band of the Redis client: from the base to the cap plus the base", () => {
    const redis: Backoff = { base: 50, factor: 2, cap: 400, jitter: { kind: "add", amount: 50 } };
    expect(backoffBand(redis)).toEqual({ low: 50, high: 450 });
    expect(backoffBand(redis, 3)).toEqual({ low: 200, high: 250 });
    expect(backoffBand({ base: 1000, factor: 1.5, cap: 30_000, jitter: { kind: "subtract", fraction: 1 } })).toEqual({ low: 0, high: 30_000 });
    expect(backoffBand({ base: 1000, factor: 1.5 })).toEqual({ low: 1000, high: Number.POSITIVE_INFINITY });
    expect(backoffBand({ base: 1000, factor: 1, cap: 5000 })).toEqual({ low: 1000, high: 1000 });
    expect(backoffBand({ base: 1000, factor: 0.5 })).toEqual({ low: 0, high: 1000 });
  });

  it("holds each delay, and the band of each try is in the band of the policy (a property, 2000 seeded cases)", () => {
    const random = seeded(41);
    const kinds = ["none", "subtract", "add"] as const;
    for (let run = 0; run < 2000; run += 1) {
      const base = Math.floor(random() * 2000);
      const factor = 1 + Math.floor(random() * 4) * 0.5;
      const cap = random() < 0.2 ? undefined : base + Math.floor(random() * 60_000);
      const kind = kinds[Math.floor(random() * 3)]!;
      const jitter =
        kind === "none" ? { kind } : kind === "subtract" ? { kind, fraction: random() } : { kind, amount: Math.floor(random() * 1000) };
      const policy: Backoff = { base, factor, cap, jitter };
      expect(backoffProblems(policy)).toEqual([]);
      const attempt = 1 + Math.floor(random() * 40);
      const delay = backoffDelay(policy, attempt, random);
      const one = backoffBand(policy, attempt);
      const all = backoffBand(policy);
      const label = JSON.stringify({ policy, attempt, delay });
      expect(delay, label).toBeGreaterThanOrEqual(one.low);
      expect(delay, label).toBeLessThanOrEqual(one.high);
      expect(one.low, label).toBeGreaterThanOrEqual(all.low);
      expect(one.high, label).toBeLessThanOrEqual(all.high);
    }
  });
});

describe("backoffProblems", () => {
  it("names each value that the delays cannot use", () => {
    expect(backoffProblems({ base: 50, cap: 400, jitter: { kind: "add", amount: 50 } })).toEqual([]);
    expect(
      backoffProblems({ base: -1, factor: 0.5, cap: -2, jitter: { kind: "subtract", fraction: 1.5 } }),
    ).toEqual([
      "the base -1 is not a time of zero or more",
      "the factor 0.5 is not a number of 1 or more",
      "the cap -2 is below the base -1",
      "the fraction 1.5 of the jitter is not from 0 to 1",
    ]);
    expect(backoffProblems({ base: 10, jitter: { kind: "add", amount: Number.NaN } })).toEqual([
      "the amount NaN of the jitter is not a time of zero or more",
    ]);
  });
});
