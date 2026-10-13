import { describe, expect, it } from "vitest";
import type { Prediction } from "./cell.ts";
import type { Measured } from "./observe.ts";
import { spread } from "./run.ts";
import { medianInterval, verdictOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const KEEPALIVE: Prediction = {
  detects: true,
  timer: "keepalive",
  errno: "ETIMEDOUT",
  from: "last-received",
  low: s(10.996),
  high: s(11.304),
};
const runs = (values: number[]): Measured[] =>
  values.map((value, index) => ({
    environment: index % 2,
    index,
    outcome: { kind: "error", errno: "ETIMEDOUT" },
    elapsed: s(value),
    socket: s(value),
    noticed: null,
    steps: [],
    probes: 3,
    retransmissions: 0,
    acks: 0,
    void: null,
    finding: null,
  }));

describe("a cell's verdict", () => {
  it("takes the median's interval from the order statistics: eleven runs give [x(2), x(10)]", () => {
    const eleven = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    expect(medianInterval(eleven)).toEqual([2, 10]);
    // below six runs no 95 % interval exists, so it is the whole range
    expect(medianInterval([3, 4, 5])).toEqual([3, 5]);
  });

  it("holds when every run lands in the band and the median's interval lies inside it", () => {
    const verdict = verdictOf(KEEPALIVE, runs([11.06, 11.05, 11.07, 11.1, 11.02, 11.06]));
    expect(verdict).toMatchObject({ decision: "holds", counted: 6, outside: [] });
    expect(verdict.band).toEqual({ low: s(10.992), high: s(11.308) });
    expect(verdict.median).toEqual(s(11.06));
  });

  it("fails on one run outside the band, give or take the pipeline's noise, as a finding", () => {
    const verdict = verdictOf(KEEPALIVE, runs([11.06, 11.05, 11.32, 11.1, 11.02, 11.06]));
    expect(verdict.decision).toBe("fails");
    expect(verdict.outside).toEqual([
      { run: "env 0 run 2", why: "11.32 s is outside [10.992, 11.308] s" },
    ]);
    // inside δ_abs of the bound is noise, not a finding
    expect(verdictOf(KEEPALIVE, runs([11.307, 11.05, 11.06])).decision).toBe("holds");
  });

  it("extends a median that straddles the widened band, and calls it inconclusive at 44 runs", () => {
    // a timer so short that the pipeline's 4 ms is more than 5 % of it: only there can every run
    // be contained while the median's interval reaches past the widened band
    const short: Prediction = { ...KEEPALIVE, low: s(0.05), high: s(0.06) };
    const split = (n: number) => Array.from({ length: n }, (_, at) => (at % 2 ? 0.05 : 0.0465));
    expect(verdictOf(short, runs(split(11)))).toMatchObject({
      decision: "extend",
      medianInterval: { low: s(0.0465), high: s(0.05) },
    });
    expect(verdictOf(short, runs(split(44))).decision).toBe("inconclusive");
    // and a median wholly below the widened band fails, though every run was contained
    expect(verdictOf(short, runs([0.0465, 0.0465, 0.0465])).decision).toBe("fails");
  });

  it("holds a silent prediction only when no run detected anything, and counts void runs apart", () => {
    const silent: Prediction = { detects: false, window: s(20) };
    const quiet: Measured[] = runs([0, 0, 0]).map((run) => ({
      ...run,
      outcome: { kind: "silent" },
      elapsed: null,
    }));
    expect(verdictOf(silent, quiet)).toMatchObject({ decision: "holds", counted: 3 });
    const noticed = [
      ...quiet,
      { ...quiet[0]!, finding: "detected after 9 s, where nothing should" },
    ];
    expect(verdictOf(silent, noticed).decision).toBe("fails");
    const voided = quiet.map((run) => ({ ...run, void: "the probe never had its reply" }));
    expect(verdictOf(silent, voided)).toMatchObject({ decision: "inconclusive", voided: 3 });
  });

  it("judges a stall's recovery by its interval, as a detection's", () => {
    const stall: Prediction = {
      detects: false,
      window: s(20),
      recovers: {
        firing: 3,
        low: s(1.617),
        high: s(1.705),
        heal: { low: s(0.856), high: s(1.616) },
      },
    };
    const back = (values: number[]) =>
      runs(values).map((run) => ({ ...run, outcome: { kind: "answered" } as const }));
    const held = verdictOf(stall, back([1.66, 1.664, 1.665, 1.668, 1.664, 1.67, 1.663]));
    expect(held).toMatchObject({ decision: "holds", band: { low: s(1.613), high: s(1.709) } });
    // a reply back after the firing the stall should have ended before: the next, 1.6 s later
    expect(verdictOf(stall, back([1.664, 1.665, 3.329])).decision).toBe("fails");
  });

  it("spreads a cell's runs over its environments as evenly as they go", () => {
    expect(spread(11, 2)).toEqual([6, 5]);
    expect(spread(11, 3)).toEqual([4, 4, 3]);
    expect(spread(1, 2)).toEqual([1]);
  });
});
