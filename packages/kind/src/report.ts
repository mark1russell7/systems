import { quantileOf } from "@mark1russell7/harness";
import type { KindCell, KindRun, Prediction } from "./cell.ts";
import type { KindVerdict } from "./verdict.ts";
import { factsOf, propagationOf, referenceOf } from "./verdict.ts";

/** A judged cell is a cell, its runs and its verdict: the part of a result that a report reads. */
export interface Judged {
  readonly cell: KindCell;
  readonly runs: readonly KindRun[];
  readonly verdict: KindVerdict;
}

/** A spread is the count, the extremes, the median and the 99th percentile of a set of times, in seconds. */
export interface TimeSpread {
  readonly count: number;
  readonly min: number;
  readonly median: number;
  readonly p99: number;
  readonly max: number;
}

/** This function gives the spread of a set of times, or null for none. The percentile is by nearest rank. */
export const timeSpread = (values: readonly number[]): TimeSpread | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
  return { count: sorted.length, min: sorted[0]!, median: Math.round(median * 1000) / 1000, p99: quantileOf(sorted, 0.99), max: sorted.at(-1)! };
};

/** This function gives the prediction of a cell in a short form for a table. */
export const predictionText = (prediction: Prediction): string => {
  switch (prediction.kind) {
    case "none":
      return prediction.outcomes === undefined ? "no failure" : `no ${prediction.outcomes.join(", ")}`;
    case "window":
      return `failures only from the ${prediction.start.from}${prediction.end === null ? "" : ` to the ${prediction.end.from} + [${prediction.end.band.lo}, ${prediction.end.band.hi}] s`}${prediction.nodes === "paused" ? ", on the paused node" : ""}${prediction.certain ? ", at least one" : ""}`;
    case "removal":
      return `Service empty in [${prediction.band.lo}, ${prediction.band.hi}] s`;
    case "leaves":
      return `the replica leaves in [${prediction.band.lo}, ${prediction.band.hi}] s`;
    case "restarts":
      return prediction.band === null ? "no restart" : `each replica SIGTERM in [${prediction.band.lo}, ${prediction.band.hi}] s`;
    case "stays":
      return "stays ready, no refusal";
    case "stalls":
      return "the rollout waits for Redis";
    case "measured":
      return "measured";
  }
};

/** This function gives the main measurement of a cell in a short form: its median and what it counts. */
export const medianText = (judged: Judged): string => {
  const { cell, verdict } = judged;
  if (verdict.median === null) return "";
  if (["none", "window", "stays", "measured"].includes(cell.prediction.kind)) {
    const counted = judged.runs.filter((run) => !run.warmup && run.void === null);
    const failures = counted.map((run) => Number(factsOf(cell, run)["failures"])).sort((a, b) => a - b);
    return `${failures.length === 0 ? 0 : failures[Math.floor(failures.length / 2)]} failed requests`;
  }
  return `${verdict.median} s`;
};

/** This function gives the table of the cells in Markdown. Each row has the cell, its plan cell, its mode, its trigger, the prediction, the verdict, its runs and its median. */
export const cellsTable = (judged: readonly Judged[]): string =>
  [
    "| Cell | Plan id | Mode | Trigger | Prediction | Verdict | Runs | Median |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...judged.map((each) => {
      const { cell, verdict } = each;
      const runs = verdict.voided === 0 ? `${verdict.counted}` : `${verdict.counted} (+${verdict.voided} void)`;
      return `| ${cell.name} | ${cell.id} | ${cell.mode} | ${cell.trigger.kind} | ${predictionText(cell.prediction)} | ${verdict.decision} | ${runs} | ${medianText(each)} |`;
    }),
  ].join("\n");

/**
 * This function gives the propagation of each calibration, by node. It is the time from the
 * deletion to the poll of the rules of each node without the pod. It also gives the time to the
 * EndpointSlice and to the stop of the intake.
 */
export const calibrationOf = (judged: Judged): {
  readonly nodes: Readonly<Record<string, TimeSpread | null>>;
  readonly all: TimeSpread | null;
  readonly slice: TimeSpread | null;
  readonly intake: TimeSpread | null;
} => {
  const byNode: Record<string, number[]> = {};
  const slice: number[] = [];
  const intake: number[] = [];
  for (const run of judged.runs.filter((each) => !each.warmup && each.void === null)) {
    const deletion = referenceOf(run, "deletion");
    for (const [node, drop] of Object.entries(propagationOf(run, deletion))) if (drop !== null) (byNode[node] ??= []).push(drop.by);
    const facts = factsOf(judged.cell, run);
    if (typeof facts["sliceAfter"] === "number") slice.push(facts["sliceAfter"]);
    if (typeof facts["intakeAfterDeletion"] === "number") intake.push(facts["intakeAfterDeletion"]);
  }
  const nodes = Object.fromEntries(Object.entries(byNode).map(([node, values]) => [node, timeSpread(values)]));
  return { nodes, all: timeSpread(Object.values(byNode).flat()), slice: timeSpread(slice), intake: timeSpread(intake) };
};
