import { describe, expect, it } from "vitest";
import { QUIET_GATE, baselineOf, neededIdle } from "./quiet.ts";

const GATE = { flat: 0.6, margin: 0.05, floor: 0.35, settle: 120_000, samples: 3 };
const clean = (...idle: number[]) => idle.map((share) => ({ idle: share, foreign: [] }));

describe("QUIET_GATE", () => {
  it("has the terms of the calibration", () => {
    expect(QUIET_GATE.margin).toBeGreaterThan(0);
    expect(QUIET_GATE.floor).toBeGreaterThan(0);
    expect(QUIET_GATE.floor).toBeLessThan(QUIET_GATE.flat);
  });
});

describe("neededIdle", () => {
  it("asks only for the floor before a baseline", () => {
    expect(neededIdle(GATE, null)).toBe(0.35);
  });

  it("keeps the flat share for a cell at rest over it", () => {
    expect(neededIdle(GATE, 0.72)).toBe(0.6);
  });

  it("follows the baseline of a heavy cell", () => {
    expect(neededIdle(GATE, 0.48)).toBeCloseTo(0.43);
  });

  it("does not go under the floor", () => {
    expect(neededIdle(GATE, 0.3)).toBe(0.35);
  });

  it("refuses a load of 1 core of 4 on a heavy cell", () => {
    expect(0.48 - 0.25).toBeLessThan(neededIdle(GATE, 0.48));
  });
});

describe("baselineOf", () => {
  it("is the median of the samples", () => {
    expect(baselineOf(null, clean(0.46, 0.5, 0.48))).toBe(0.48);
  });

  it("keeps the highest median, because a load only lowers it", () => {
    expect(baselineOf(0.48, clean(0.2, 0.22, 0.21))).toBe(0.48);
    expect(baselineOf(0.3, clean(0.46, 0.5, 0.48))).toBe(0.48);
  });

  it("does not read a sample with a foreign container", () => {
    expect(baselineOf(null, [{ idle: 0.9, foreign: ["other"] }])).toBeNull();
    expect(baselineOf(0.48, [{ idle: 0.9, foreign: ["other"] }])).toBe(0.48);
  });
});
