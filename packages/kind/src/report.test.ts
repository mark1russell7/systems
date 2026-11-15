import { describe, expect, it } from "vitest";
import { bandOf, seconds } from "./bands.ts";
import type { KindCell, Prediction } from "./cell.ts";
import { cellOf } from "./cells.fixture.ts";
import type { Judged } from "./report.ts";
import { cellsTable, predictionText, timeSpread } from "./report.ts";
import type { KindVerdict } from "./verdict.ts";

describe("the spread of a set of times", () => {
  it("gives null for no time", () => {
    expect(timeSpread([])).toBeNull();
  });

  it("gives the count, the extremes, the median to the ms and the 99th percentile by nearest rank, in seconds", () => {
    // The sorted times are 0.5, 1.2344, 1.5 and 2 s. The median is the mean of the two middle times.
    const spread = timeSpread([{ value: 1500, unit: "ms" }, seconds(0.5), seconds(2), seconds(1.2344)]);
    expect(spread).toEqual({ count: 4, min: seconds(0.5), median: seconds(1.367), p99: seconds(2), max: seconds(2) });
  });
});

describe("the short text of a prediction", () => {
  const texts: ReadonlyArray<readonly [Prediction, string]> = [
    [{ kind: "restarts", band: null, why: "a test" }, "no restart"],
    [{ kind: "restarts", band: bandOf(30, 31), why: "a test" }, "each replica SIGTERM in [30, 31] s"],
    [{ kind: "stalls", why: "a test" }, "the rollout waits for Redis"],
    [{ kind: "measured", why: "a test" }, "measured"],
    [
      {
        kind: "reconnects",
        flip: bandOf(1, 3),
        probe: seconds(1),
        disconnect: bandOf(0, 0.1),
        backoff: { initial: seconds(0.1), max: seconds(60), mandatoryStop: seconds(30), jitter: 0.2, attempt: seconds(30) },
        setup: bandOf(0, 1),
        outcomes: ["timeout", "refused"],
        why: "a test",
      },
      "another owner in [1, 3] s, each producer back at the first try of its backoff after it, failures only before it, each one timeout or refused",
    ],
  ];
  it.each(texts)("gives the text of a %j", (prediction, text) => {
    expect(predictionText(prediction)).toBe(text);
  });
});

describe("the table of the cells", () => {
  const verdict = (counted: number, voided: number): KindVerdict => ({
    decision: "holds",
    counted,
    voided,
    failed: 0,
    median: { value: 0, unit: "{request}" },
    why: "a test",
    checks: [],
  });
  const base = cellOf("pod-deletion");
  const flapping: KindCell = { ...base, trigger: { ...base.trigger, flaps: [{ rest: seconds(10), hold: seconds(5) }] } };

  it("gives a header and one row for each cell, with the void runs and the count of the faults of a flap", () => {
    const judged: Judged[] = [
      { cell: base, runs: [], verdict: verdict(11, 0) },
      { cell: flapping, runs: [], verdict: verdict(10, 1) },
    ];
    expect(cellsTable(judged).split("\n")).toEqual([
      "| Cell | Plan id | Mode | Trigger | Prediction | Verdict | Runs | Median |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| a test cell, pod-deletion | T07.defaults.1 | iptables | pod-deletion | no failure | holds | 11 | 0 failed requests |",
      "| a test cell, pod-deletion | T07.defaults.1 | iptables | pod-deletion (2 faults) | no failure | holds | 10 (+1 void) | 0 failed requests |",
    ]);
  });

  it("gives no median for a verdict with no median", () => {
    const judged: Judged[] = [{ cell: base, runs: [], verdict: { ...verdict(0, 0), median: null } }];
    expect(cellsTable(judged).split("\n")[2]).toBe("| a test cell, pod-deletion | T07.defaults.1 | iptables | pod-deletion | no failure | holds | 0 |  |");
  });
});
