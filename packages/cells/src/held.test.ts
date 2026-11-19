import type { Cell, Decision, LoadPrediction, Measured, RunLoad, Verdict } from "@mark1russell7/harness";
import { verdictOf } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import { selectedOf } from "./all.ts";
import { ms, s } from "./catalog.ts";
import { FAULT_DETECTION, faulted, faultedLoad, faultedVerdict, heldRead, slowdownSeen } from "./held.ts";
import { LADDER_CELLS, RUNGS, durationOf, plannedOf } from "./ladder.ts";

const verdict = (decision: Decision): Verdict => ({ decision, counted: 11, voided: 0, band: null, outside: [], median: null, medianInterval: null, why: decision });
const named = (entries: ReadonlyArray<readonly [string, Decision]>) => new Map(entries.map(([name, decision]) => [name, verdict(decision)]));

/** This function gives a counted run with a time. */
const run = (index: number, time: number | null, voided: string | null = null): Measured =>
  ({ environment: 0, index, elapsed: time === null ? null : s(time), void: voided, finding: null, outcome: { kind: "none" }, retransmissions: 0 }) as unknown as Measured;

const timed = { name: "timed", noise: s(0.001), prediction: { detects: true, timer: "user_timeout", errno: "ETIMEDOUT", from: "fault", low: s(0.998), high: s(1.002) } } as unknown as Cell;
const silent = { name: "silent", noise: s(0.001), prediction: { detects: false, window: s(10) } } as unknown as Cell;
const measuredOnly = { name: "measured", noise: s(0.001), prediction: { detects: null, window: s(10), why: "a record" } } as unknown as Cell;
const elevenAt = (time: number) => Array.from({ length: 11 }, (_, index) => run(index, time));

describe("the read of the scheduled cells", () => {
  it("passes only if each cell of the selection holds", () => {
    const read = heldRead(["a", "b"], named([["a", "holds"], ["b", "holds"]]));
    expect(read.held).toBe(true);
    expect(read.reason).toBe("each of the 2 cells holds");
  });

  it.each(["fails", "measured", "extend", "inconclusive"] as const)("does not pass a cell that reads %s", (decision) => {
    const read = heldRead(["a", "b"], named([["a", "holds"], ["b", decision]]));
    expect(read.held).toBe(false);
    expect(read.reason).toBe("1 cell of 2 did not hold");
    expect(read.cells.map((cell) => cell.held)).toEqual([true, false]);
  });

  it("does not pass a cell of the selection that has no record", () => {
    const read = heldRead(["a", "b"], named([["a", "holds"]]));
    expect(read.held).toBe(false);
    expect(read.missing).toEqual(["b"]);
    expect(read.reason).toBe("1 cell of the selection had no record");
  });

  it("does not pass a record that the selection does not name", () => {
    const read = heldRead(["a"], named([["a", "holds"], ["z", "holds"]]));
    expect(read.held).toBe(false);
    expect(read.extra).toEqual(["z"]);
  });

  it("does not pass an empty selection", () => {
    expect(heldRead([], new Map()).held).toBe(false);
  });

  it("does not pass a cell that holds on a record with no pin of its programs (SYS-101)", () => {
    const problems = new Map([["b", ["the target: the image redis:7.4 has no digest"]]]);
    const read = heldRead(["a", "b"], named([["a", "holds"], ["b", "holds"]]), problems);
    expect(read.held).toBe(false);
    expect(read.cells.map((cell) => cell.held)).toEqual([true, false]);
    expect(read.cells[1]!.why).toBe("not a record: the target: the image redis:7.4 has no digest");
    expect(read.reason).toBe("1 cell of 2 did not hold, 1 record with no pin of the programs");
  });

  it("passes a record with an empty list of problems", () => {
    expect(heldRead(["a"], named([["a", "holds"]]), new Map([["a", []]])).held).toBe(true);
  });
});

describe("the injected fault", () => {
  it("turns a timed cell red, and the clean runs hold", () => {
    expect(verdictOf(timed.prediction, elevenAt(1), s(0.001)).decision).toBe("holds");
    expect(faultedVerdict(timed, elevenAt(1)).decision).toBe("fails");
  });

  it("reads 1.5 x the top of the band, and it leaves a void run as it is", () => {
    const runs = faulted(timed, [run(0, 1), run(1, null, "the lab failed")]);
    expect(runs[0]!.elapsed!.value).toBeCloseTo(1.003 * 1.5, 9);
    expect(runs[1]!.elapsed).toBeNull();
  });

  it("turns a silent cell red with a detection", () => {
    const clean = elevenAt(0).map((each) => ({ ...each, elapsed: null }));
    expect(verdictOf(silent.prediction, clean, s(0.001)).decision).toBe("holds");
    expect(faulted(silent, clean)[0]!.finding).toBe(FAULT_DETECTION);
    expect(faultedVerdict(silent, clean).decision).toBe("fails");
  });

  it("leaves a cell with no band as it is", () => {
    const clean = elevenAt(1);
    expect(faulted(measuredOnly, clean)).toEqual(clean);
  });
});

/** This function gives the load of one run on a schedule: each arrival has a reply after `latency` ms, and each send is `lag` ms late. */
const loadOf = (planned: number, latency = 1.5, lag = 0.3): RunLoad => ({
  planned,
  unsent: 0,
  unfinished: 0,
  failed: 0,
  latency: Array.from({ length: planned }, () => latency),
  service: Array.from({ length: planned }, () => latency),
  lag: Array.from({ length: planned }, () => lag),
  censored: [],
});
const loaded = (load: RunLoad): Measured[] => elevenAt(0).map((each) => ({ ...each, elapsed: null, load }));
const openLoop = (load: LoadPrediction): Cell => ({ name: "open loop", noise: s(0.001), prediction: { detects: null, window: s(10), why: "a schedule", load } }) as unknown as Cell;

describe("the injected fault on a load (SYS-93)", () => {
  const rung = LADDER_CELLS[0]!;

  it("turns each rung of the ladder red with failed arrivals over its limit, and the clean runs hold", () => {
    RUNGS.forEach((each, at) => {
      const cell = LADDER_CELLS[at]!;
      const clean = loaded(loadOf(plannedOf(each, durationOf(each))));
      expect(verdictOf(cell.prediction, clean, s(0.001)).decision, cell.name).toBe("holds");
      expect(faultedVerdict(cell, clean).decision, cell.name).toBe("fails");
    });
  });

  it("fails 1.5 x the share of the limit in each run, and leaves the latency, the lag and a void run as they are", () => {
    const runs = faulted(rung, [...loaded(loadOf(58)).slice(0, 1), run(1, null, "the lab failed")]);
    expect(runs[0]!.load).toMatchObject({ planned: 58, failed: Math.ceil(58 * 0.01 * 1.5), latency: loadOf(58).latency, lag: loadOf(58).lag });
    expect(runs[1]!.load).toBeUndefined();
  });

  it("counts the arrivals that failed before toward the fault", () => {
    const load = { ...loadOf(100), unsent: 1, unfinished: 1, failed: 0 };
    // 1.95 failed arrivals round up to 2, and the run has 2 lost arrivals: nothing more fails
    expect(faultedLoad({ lag: ms(50), bands: [], failures: 0.013 }, load).failed).toBe(0);
    // 4.5 round up to 5: 3 more
    expect(faultedLoad({ lag: ms(50), bands: [], failures: 0.03 }, load).failed).toBe(3);
    expect(faultedLoad({ lag: ms(50), bands: [], failures: 0 }, loadOf(100)).failed).toBe(1);
  });

  it("reads 1.5 x the highest top of the bands on each latency and each censored age", () => {
    const prediction: LoadPrediction = { lag: ms(50), bands: [{ quantile: 0.5, high: ms(4) }, { quantile: 0.99, high: ms(10) }] };
    const load = faultedLoad(prediction, { ...loadOf(500), censored: [2] });
    expect(new Set(load.latency)).toEqual(new Set([15]));
    expect(load.censored).toEqual([15]);
    expect(load.lag).toEqual(loadOf(500).lag);
    expect(verdictOf(openLoop(prediction).prediction, loaded(loadOf(500)), s(0.001)).decision).toBe("holds");
    expect(faultedVerdict(openLoop(prediction), loaded(loadOf(500))).decision).toBe("fails");
  });

  it("puts the fault on the schedule of a cell with no band and no limit of failures", () => {
    const prediction: LoadPrediction = { lag: ms(50), bands: [] };
    expect(new Set(faultedLoad(prediction, loadOf(10)).lag)).toEqual(new Set([75]));
    expect(verdictOf(openLoop(prediction).prediction, loaded(loadOf(10)), s(0.001)).decision).toBe("holds");
    expect(faultedVerdict(openLoop(prediction), loaded(loadOf(10))).decision).toBe("fails");
  });
});

describe("the power of a cell", () => {
  it("is the top of its band over its slowest counted run", () => {
    expect(slowdownSeen(timed, [run(0, 1), run(1, 1.002), run(2, 9, "void")])).toBeCloseTo(1.003 / 1.002, 9);
  });

  it("is null for a cell with no time", () => {
    expect(slowdownSeen(silent, elevenAt(1))).toBeNull();
    expect(slowdownSeen(timed, [run(0, null)])).toBeNull();
  });

  it("names the factor at which the verdict turns red", () => {
    const power = slowdownSeen(timed, elevenAt(1))!;
    expect(verdictOf(timed.prediction, elevenAt(1 * (power + 0.001)), s(0.001)).decision).toBe("fails");
  });
});

describe("the selection of a shard", () => {
  const cells = ["WS a", "T01 b", "WS c", "WS d", "WST e"].map((name) => ({ name }) as unknown as Cell);

  it("takes each n-th match from the i-th", () => {
    expect(selectedOf(cells, /^WS/, 0, 2).map((cell) => cell.name)).toEqual(["WS a", "WS d"]);
    expect(selectedOf(cells, /^WS/, 1, 2).map((cell) => cell.name)).toEqual(["WS c", "WST e"]);
  });
});
