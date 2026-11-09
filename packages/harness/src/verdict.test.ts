import { describe, expect, it } from "vitest";
import type { Cell, Prediction } from "./cell.ts";
import { environmentProblems } from "./cell.ts";
import { countFinding } from "./driver.ts";
import type { Measured } from "./observe.ts";
import { hzOf } from "./lab.ts";
import { environmentCounts, spread } from "./run.ts";
import { NOISE, commitVoid, delayVoids, medianInterval, noiseOf, verdictOf } from "./verdict.ts";

describe("the commit of a fault (SYS-99)", () => {
  const sec = (value: number) => ({ value, unit: "s" as const });
  const band = (at: number) => ({ at: sec(at), low: sec(0.996), high: sec(180.004) });
  const words = (ms: number) => `the commit of the fault took ${ms} ms, longer than the noise of the pipeline: its start is not known`;

  it("keeps each run with a commit in the noise", () => {
    expect(commitVoid(sec(0.004), [])).toBeNull();
    expect(commitVoid(sec(0.001), [band(0.997)])).toBeNull();
  });

  it("keeps a run with a long commit when each time stays on its side of each edge", () => {
    // the restore of RD.100 on 2026-11-08: 16.4 s in a band of 180 s, with a commit of 8.4 ms
    expect(commitVoid(sec(0.0084), [band(16.391799)])).toBeNull();
    // a time above the band stays above it
    expect(commitVoid(sec(0.0084), [band(200)])).toBeNull();
    // a time below the band stays below it
    expect(commitVoid(sec(0.0084), [band(0.5)])).toBeNull();
  });

  it("voids a run when a start in the commit can move a time across an edge", () => {
    expect(commitVoid(sec(0.0084), [band(1)])).toBe(words(8.4));
    expect(commitVoid(sec(0.0084), [band(180.01)])).toBe(words(8.4));
    // one time of several is enough
    expect(commitVoid(sec(0.0084), [band(16), band(1)])).toBe(words(8.4));
  });

  it("voids a run with a long commit and no time", () => {
    expect(commitVoid(sec(0.0133), [])).toBe(words(13.3));
  });
});

describe("the environment of a cell (0.9.0)", () => {
  const ms = (value: number) => ({ value, unit: "ms" });

  it("gives a cell its own δ_abs, or NOISE when it gives none", () => {
    expect(noiseOf({})).toEqual(NOISE);
    expect(noiseOf({ noise: ms(1) })).toEqual(ms(1));
  });

  it("voids a run for a late timer in time when the run knows its HZ, and in jiffies when not", () => {
    // one jiffy late never voids a run
    expect(delayVoids(1, 1000, NOISE)).toBe(false);
    // a run with no HZ keeps the rule of two jiffies
    expect(delayVoids(2, undefined, NOISE)).toBe(true);
    // at HZ 250 two jiffies are 8 ms, more than δ_abs: the rule does not change
    expect(delayVoids(2, 250, NOISE)).toBe(true);
    // at HZ 1000 two jiffies are 2 ms, inside a δ_abs of 4 ms: such a run counts
    expect(delayVoids(2, 1000, NOISE)).toBe(false);
    expect(delayVoids(4, 1000, NOISE)).toBe(true);
    // the runner's own δ_abs of 1 ms keeps two jiffies as the rule
    expect(delayVoids(2, 1000, ms(1))).toBe(true);
  });

  it("measures HZ from jiffies against the time of the kernel, to the nearest rate of Linux", () => {
    expect(hzOf({ now: 0, jiffies: 0 }, { now: 1e9, jiffies: 1000 })).toBe("1000");
    expect(hzOf({ now: 0, jiffies: 0 }, { now: 1.02e9, jiffies: 255 })).toBe("250");
    expect(hzOf({ now: 0, jiffies: 0 }, { now: 1e9, jiffies: 500 })).toBeNull();
    expect(hzOf({ now: 5, jiffies: 0 }, { now: 5, jiffies: 9 })).toBeNull();
  });
});

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

  it("judges a measurement-only cell by its exact counts, and it stays a measurement without them", () => {
    const counts = [{ what: "the arrivals at the target", match: { ev: "arrive", where: { hop: 1 } }, count: 36 }];
    const counted: Prediction = { detects: null, window: s(30), why: "the tries multiply", from: "request-sent", counts };
    const held = verdictOf(counted, runs([1.2, 1.3]));
    expect(held).toMatchObject({ decision: "holds", counted: 2, band: null, outside: [] });
    expect(held.why).toMatch(/^2 of 2 runs gave the exact counts \(the arrivals at the target 36\)/);
    const [first, second] = runs([1.2, 1.3]);
    const finding = countFinding(counts, Array.from({ length: 35 }, (_, n) => ({ ev: "arrive", t: n, hop: 1 })));
    expect(finding).toBe("the arrivals at the target: 35 lines, and the law gives 36");
    const failed = verdictOf(counted, [first!, { ...second!, finding }]);
    expect(failed).toMatchObject({ decision: "fails", outside: [{ run: "env 1 run 1", why: finding }] });
    expect(failed.why).toMatch(/^1 of 2 runs gave/);
    expect(verdictOf({ detects: null, window: s(30), why: "measured", from: "request-sent" }, runs([1.2])).decision).toBe("measured");
  });

  it("counts only the lines that match, and a count above the law is a finding too", () => {
    const counts = [{ what: "the arrivals at hop 0", match: { ev: "arrive", where: { hop: 0 } }, count: 1 }];
    const line = (ev: string, hop: number) => ({ ev, t: 0, hop });
    expect(countFinding(counts, [line("arrive", 0), line("arrive", 1), line("gave-up", 0)])).toBeNull();
    expect(countFinding(counts, [line("arrive", 0), line("arrive", 0)])).toBe("the arrivals at hop 0: 2 lines, and the law gives 1");
  });

  it("spreads a cell's runs over its environments as evenly as they go", () => {
    expect(spread(11, 2)).toEqual([6, 5]);
    expect(spread(11, 3)).toEqual([4, 4, 3]);
    expect(spread(1, 2)).toEqual([1]);
  });

  // only the fields these two functions read: the rest of a cell does not change them
  const cellWith = (fields: Partial<Cell>): Cell => ({ name: "C1", environments: 2, ...fields }) as Cell;
  const pair = { synchronous: true, writers: 1, interval: { value: 10, unit: "ms" }, cuts: "standby" } as const;

  it("gives a pair cell one environment for each run, because its run promotes the standby", () => {
    expect(environmentCounts(cellWith({ pair }), 11)).toEqual(Array.from({ length: 11 }, () => 1));
    expect(environmentCounts(cellWith({ pair, concurrency: 4 }), 3)).toEqual([1, 1, 1]);
    expect(environmentCounts(cellWith({}), 11)).toEqual([6, 5]);
    expect(environmentCounts(cellWith({ concurrency: 4 }), 11)).toEqual([3, 3, 3, 2]);
  });

  it("refuses sysctls of the host in environments at the same time, because a lab reads the value of another as its value before", () => {
    const host = [{ name: "net.netfilter.nf_conntrack_max", value: "64" }];
    expect(environmentProblems(cellWith({ hostSysctls: host, concurrency: 2 }))).toEqual([
      "C1: a cell with sysctls of the host operates one environment at a time, not 2",
    ]);
    expect(environmentProblems(cellWith({ hostSysctls: host }))).toEqual([]);
    expect(environmentProblems(cellWith({ hostSysctls: host, concurrency: 1 }))).toEqual([]);
    expect(environmentProblems(cellWith({ concurrency: 8 }))).toEqual([]);
  });
});
