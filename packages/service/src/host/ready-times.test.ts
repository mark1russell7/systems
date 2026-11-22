import { describe, expect, it } from "vitest";
import type { ReadyTime, WindowRule } from "./ready-times.ts";
import { addReadyTime, measuredWindowMs, parseReadyTimes, READY_TIMES_FORMAT, readyTimesText } from "./ready-times.ts";

const rule: WindowRule = { firstMs: 60_000, after: 3, keep: 5, floorMs: 10_000, capMs: 300_000 };
const AT = "2026-01-01T00:00:00.000Z";
const ready = (...values: number[]): ReadyTime[] => values.map((value) => ({ at: AT, ms: value }));
const missed = (value: number): ReadyTime => ({ at: AT, ms: value, missed: true });

describe("measuredWindowMs", () => {
  it("gives the first window before `after` ready times", () => {
    expect(measuredWindowMs([], rule)).toEqual({ ms: 60_000, measured: 0, missed: 0 });
    expect(measuredWindowMs(ready(24_000, 50_000), rule)).toEqual({ ms: 60_000, measured: 2, missed: 0 });
  });

  it("gives the worst time plus the worst minus the best, after `after` ready times", () => {
    // 50 s + (50 s - 24 s) = 76 s
    expect(measuredWindowMs(ready(24_000, 50_000, 30_000), rule)).toEqual({ ms: 76_000, measured: 3, missed: 0 });
  });

  it("uses only the last `keep` ready times", () => {
    // the first time (200 s) is out of the last 5
    expect(measuredWindowMs(ready(200_000, 20_000, 22_000, 24_000, 26_000, 28_000), rule).ms).toBe(36_000);
  });

  it("keeps the window in the floor and the cap", () => {
    expect(measuredWindowMs(ready(1_000, 1_000, 1_000), rule).ms).toBe(10_000);
    expect(measuredWindowMs(ready(100_000, 200_000, 250_000), rule).ms).toBe(300_000);
    expect(measuredWindowMs([], { ...rule, firstMs: 5_000 }).ms).toBe(10_000);
  });

  it("makes the window two times the missed window after a missed start, to the cap", () => {
    expect(measuredWindowMs([missed(60_000)], rule)).toEqual({ ms: 120_000, measured: 0, missed: 1 });
    expect(measuredWindowMs([missed(60_000), missed(120_000)], rule)).toEqual({ ms: 240_000, measured: 0, missed: 2 });
    expect(measuredWindowMs([missed(60_000), missed(120_000), missed(240_000)], rule).ms).toBe(300_000);
    // a measured window that is longer than the growth stays
    expect(measuredWindowMs([...ready(100_000, 100_000, 100_000), missed(50_000)], rule).ms).toBe(100_000);
  });

  it("forgets the missed starts before a ready start", () => {
    expect(measuredWindowMs([missed(60_000), missed(120_000), ...ready(30_000)], rule)).toEqual({ ms: 60_000, measured: 1, missed: 0 });
  });
});

describe("addReadyTime", () => {
  it("keeps the last `keep` ready times and the missed starts after the last ready start", () => {
    const times = addReadyTime(ready(1, 2, 3), { at: AT, ms: 4 }, 2);
    expect(times.map((time) => time.ms)).toEqual([3, 4]);
    const after = addReadyTime([...ready(1), missed(10), missed(20)], missed(40), 2);
    expect(after).toEqual([...ready(1), missed(20), missed(40)]);
    expect(addReadyTime(after, { at: AT, ms: 5 }, 2)).toEqual(ready(1, 5));
  });
});

describe("parseReadyTimes", () => {
  it("reads the text of readyTimesText, and gives no times and no problem for a missing file", () => {
    const times = [...ready(12, 0), missed(30)];
    expect(parseReadyTimes(readyTimesText(times))).toEqual({ times, problem: null });
    expect(parseReadyTimes(null)).toEqual({ times: [], problem: null });
  });

  it("gives no times and a problem for a bad file", () => {
    expect(parseReadyTimes("{")).toEqual({ times: [], problem: "the file is not JSON" });
    expect(parseReadyTimes(JSON.stringify({ format: "other/1", times: [] }))).toEqual({ times: [], problem: `the file is not of the format ${READY_TIMES_FORMAT}` });
    expect(parseReadyTimes("null").problem).toBe(`the file is not of the format ${READY_TIMES_FORMAT}`);
    for (const time of [{ at: AT, ms: -1 }, { at: AT, ms: "1" }, { ms: 1 }, { at: AT, ms: 1, missed: false }, null])
      expect(parseReadyTimes(JSON.stringify({ format: READY_TIMES_FORMAT, times: [time] }))).toEqual({ times: [], problem: "a time of the file has a wrong form" });
  });
});
