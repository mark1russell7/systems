import { describe, expect, it } from "vitest";
import {
  memcgHighDelay,
  memcgHighSleep,
  memcgSleepBounds,
  memcgThrottle,
  oomBadness,
  oomVictim,
} from "./memcg.ts";

// a high of 100 MiB in pages of 4 KiB, and one MiB in pages
const HIGH = 25600;
const MIB = 256;

describe("the delay and the sleep of memory.high", () => {
  it("gives the table in the comment of the source, for a high of 100 MiB at HZ 1000", () => {
    // mm/memcontrol.c at v7.0, lines 2147-2171: the time to allocate, in ms, at each usage from 100M to 117M
    const table = [0, 6, 25, 57, 102, 159, 230, 313, 409, 518, 639, 774, 921, 1081, 1254, 1439, 1638, 1849];
    table.forEach((ms, step) =>
      expect(memcgHighDelay([{ usage: HIGH + step * MIB, high: HIGH }], 64, 1000)).toBe(ms),
    );
  });

  it("caps the sleep at 2 s from 118M, as the table does", () => {
    for (const mib of [118, 119, 120]) {
      const usage = mib * MIB;
      expect(memcgHighDelay([{ usage, high: HIGH }], 64, 1000)).toBeGreaterThan(2000);
      expect(memcgHighSleep([{ usage, high: HIGH }], 64, 1000)).toBe(2000);
    }
  });

  it("skips a delay of HZ / 100 jiffies or less, thus the 6 ms of 101M give no sleep", () => {
    expect(memcgHighSleep([{ usage: 101 * MIB, high: HIGH }], 64, 1000)).toBe(0);
    expect(memcgHighSleep([{ usage: 102 * MIB, high: HIGH }], 64, 1000)).toBe(25);
    expect(memcgHighSleep([{ usage: HIGH, high: HIGH }], 64, 1000)).toBe(0);
  });

  it("scales the delay with the debt and with HZ", () => {
    expect(memcgHighDelay([{ usage: 110 * MIB, high: HIGH }], 128, 1000)).toBe(1278);
    expect(memcgHighDelay([{ usage: 110 * MIB, high: HIGH }], 32, 1000)).toBe(319);
    expect(memcgHighDelay([{ usage: 110 * MIB, high: HIGH }], 64, 250)).toBe(159);
  });

  it("takes the largest overage of the levels, and adds the delay of swap", () => {
    const over = { usage: 110 * MIB, high: HIGH };
    expect(memcgHighSleep([{ usage: 10, high: 1000 }, over], 64, 1000)).toBe(639);
    expect(memcgHighSleep([over], 64, 1000, [{ usage: 2816, high: 2560 }])).toBe(1278);
  });

  it("takes a high of 0 as a high of 1 page", () => {
    expect(memcgHighDelay([{ usage: 2, high: 0 }], 64, 1000)).toBe(memcgHighDelay([{ usage: 2, high: 1 }], 64, 1000));
  });

  it("finds where the sleep starts and where it reaches its cap", () => {
    expect(memcgSleepBounds(HIGH, 64, 1000)).toEqual({ first: 25936, capped: 30126 });
    expect(memcgSleepBounds(HIGH, 64, 250)).toEqual({ first: 25951, capped: 30126 });
    const { first, capped } = memcgSleepBounds(HIGH, 64, 1000);
    expect(memcgHighSleep([{ usage: first - 1, high: HIGH }], 64, 1000)).toBe(0);
    expect(memcgHighSleep([{ usage: first, high: HIGH }], 64, 1000)).toBeGreaterThan(0);
    expect(memcgHighSleep([{ usage: capped - 1, high: HIGH }], 64, 1000)).toBeLessThan(2000);
    expect(memcgHighSleep([{ usage: capped, high: HIGH }], 64, 1000)).toBe(2000);
  });

  it("refuses a count that is not a whole number at or above 0", () => {
    expect(() => memcgHighSleep([{ usage: 1.5, high: HIGH }], 64, 1000)).toThrow("the usage is not a count: 1.5");
    expect(() => memcgHighSleep([{ usage: 1, high: -1 }], 64, 1000)).toThrow("memory.high is not a count: -1");
    expect(() => memcgHighSleep([{ usage: 1, high: 1 }], 64, 0)).toThrow("HZ is 0");
    expect(() => memcgSleepBounds(HIGH, 0, 1000)).toThrow("a debt of 0 pages gives no sleep");
  });
});

describe("the throttle of a task that grows above memory.high", () => {
  // a high of 64 MiB, and a task that starts at it and charges one batch of 64 pages at a time
  const start = [{ usage: 16384, high: 16384 }];

  it("sums the sleep of each charge, and counts 17 reclaims at each charge that sleeps", () => {
    expect(memcgThrottle(start, 64, 1000)).toEqual({ over: 64, sleeps: 61, jiffies: 68625, late: 2805, high: 1040 });
    expect(memcgThrottle(start, 13, 1000)).toEqual({ over: 13, sleeps: 10, jiffies: 782, late: 45, high: 173 });
  });

  it("does not sleep or reclaim below the high", () => {
    expect(memcgThrottle([{ usage: 0, high: 16384 }], 256, 1000)).toEqual({ over: 0, sleeps: 0, jiffies: 0, late: 0, high: 0 });
  });

  it("sleeps for an ancestor above its high, with no event in the cgroup of the task", () => {
    const levels = [{ usage: 16384, high: 99999999 }, ...start];
    expect(memcgThrottle(levels, 64, 1000)).toEqual({ over: 64, sleeps: 61, jiffies: 68625, late: 2805, high: 0 });
  });

  it("refuses a task with no cgroup", () => {
    expect(() => memcgThrottle([], 1, 1000)).toThrow("the task has no cgroup");
  });
});

describe("the victim of the OOM killer of a cgroup", () => {
  it("adds the resident pages, the swap entries, the pages of the page tables and the adjustment", () => {
    expect(oomBadness({ rss: 16000, swap: 0, pageTables: 131072, adj: 0 }, 16384)).toBe(16032);
    expect(oomBadness({ rss: 100, swap: 20, pageTables: 0, adj: 1000 }, 16384)).toBe(16120);
    expect(oomBadness({ rss: 100, swap: 0, pageTables: 0, adj: -500 }, 16384)).toBe(-7900);
    expect(oomBadness({ rss: 100, swap: 0, pageTables: 0, adj: -1000 }, 16384)).toBeUndefined();
  });

  it("kills the task with the most points, and the last of equal points", () => {
    const big = { rss: 16000, swap: 0, pageTables: 0, adj: 0 };
    const small = { rss: 50, swap: 0, pageTables: 0, adj: 0 };
    expect(oomVictim([big, { ...small, adj: 1000 }], 16384)).toBe(1);
    expect(oomVictim([big, small], 16384)).toBe(0);
    expect(oomVictim([small, small], 16384)).toBe(1);
    expect(oomVictim([{ ...small, adj: -1000 }], 16384)).toBeUndefined();
  });

  it("refuses an adjustment out of its range", () => {
    expect(() => oomBadness({ rss: 1, swap: 0, pageTables: 0, adj: 1001 }, 16384)).toThrow(
      "oom_score_adj is not from -1000 to 1000: 1001",
    );
  });
});
