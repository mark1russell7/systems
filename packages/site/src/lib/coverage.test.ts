import { describe, expect, it } from "vitest";
import type { CoverageRun, Shares } from "./coverage.ts";
import { floorOf, floorsOf, MINIMUM_RUNS, roundDown, sharesOf } from "./coverage.ts";

const shares = (lines: number, functions: number, branches: number): Shares => ({ lines, functions, branches });

/** Five runs of different commits. The first package has the same values in each run, and the second does not. */
const runs = (): CoverageRun[] =>
  [
    [96.19, 53],
    [96.19, 53.4],
    [96.19, 52.8],
    [96.19, 53.1],
    [96.19, 53],
  ].map(([a, b], i) => ({
    id: String(42558826949 + i),
    commit: `c${i}`,
    packages: { algebra: shares(a as number, 94.77, 90.27), harness: shares(b as number, 58.19, 59.13) },
  }));

describe("roundDown", () => {
  it("rounds a percent down to 0.1", () => {
    expect(roundDown(96.19)).toBe(96.1);
    expect(roundDown(82.35)).toBe(82.3);
    expect(roundDown(100)).toBe(100);
    expect(roundDown(57.3)).toBe(57.3);
    expect(roundDown(0.3)).toBe(0.3);
  });
});

describe("floorOf", () => {
  it("gives the worst value, rounded down, when the spread is 0", () => {
    expect(floorOf([96.19, 96.19, 96.19, 96.19, 96.19])).toBe(96.1);
  });

  it("takes the spread from the worst value", () => {
    // The worst is 52.8 and the spread is 53.4 - 52.8 = 0.6, thus the floor is 52.2.
    expect(floorOf([53, 53.4, 52.8, 53.1, 53])).toBe(52.2);
  });

  it("does not go under 0", () => {
    expect(floorOf([1, 9])).toBe(0);
  });

  it("refuses no values", () => {
    expect(() => floorOf([])).toThrow(/one value/);
  });
});

describe("sharesOf", () => {
  it("reads the percent of each measure from the total", () => {
    const summary = { total: { lines: { pct: 53 }, statements: { pct: 52.83 }, functions: { pct: 58.19 }, branches: { pct: 59.13 } } };
    expect(sharesOf(summary)).toEqual(shares(53, 58.19, 59.13));
  });

  it("refuses a summary with no percent", () => {
    expect(() => sharesOf({ total: { lines: { pct: 53 } } })).toThrow(/functions/);
    expect(() => sharesOf(null)).toThrow(/lines/);
  });
});

describe("floorsOf", () => {
  it("gives the floor, the worst value and the spread of each measure of each package", () => {
    const file = floorsOf(runs());
    expect(file.floors).toEqual({ algebra: shares(96.1, 94.7, 90.2), harness: shares(52.2, 58.1, 59.1) });
    expect(file.worst["harness"]).toEqual(shares(52.8, 58.19, 59.13));
    expect(file.spread["harness"]).toEqual(shares(0.6, 0, 0));
    expect(file.runs).toHaveLength(5);
    expect(file.formula).toMatch(/worst - \(best - worst\)/);
  });

  it(`refuses fewer than ${MINIMUM_RUNS} runs`, () => {
    expect(() => floorsOf(runs().slice(1))).toThrow(/5 runs or more, not 4/);
  });

  it("refuses two runs of one commit", () => {
    const twice = runs();
    twice[1] = { ...(twice[1] as CoverageRun), commit: "c0" };
    expect(() => floorsOf(twice)).toThrow(/same commit/);
  });

  it("names a package that is not in each run", () => {
    const some = runs();
    const first = some[0] as CoverageRun;
    some[0] = { ...first, packages: { algebra: first.packages["algebra"] as Shares } };
    expect(() => floorsOf(some)).toThrow(/harness is not in the runs 42558826949/);
  });
});
