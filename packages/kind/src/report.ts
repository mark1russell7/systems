import type { Quantity } from "@mark1russell7/quantity";
import { format, valueIn } from "@mark1russell7/quantity";
import { seconds, secondsOf, showBand } from "./bands.ts";
import type { Band, KindCell, KindRun, Prediction } from "./cell.ts";
import { quantileOf } from "./stats.ts";
import type { KindVerdict } from "./verdict.ts";
import { factsOf, propagationOf, propagationSource, referenceOf, updatesOf } from "./verdict.ts";

/** A judged cell is a cell, its runs and its verdict: the part of a result that a report reads. */
export interface Judged {
  readonly cell: KindCell;
  readonly runs: readonly KindRun[];
  readonly verdict: KindVerdict;
}

/** A spread is the count, the extremes, the median and the 99th percentile of a set of times. */
export interface TimeSpread {
  readonly count: number;
  readonly min: Quantity;
  readonly median: Quantity;
  readonly p99: Quantity;
  readonly max: Quantity;
}

/** This function gives the spread of a set of times, or null for none. The percentile is by nearest rank. */
export const timeSpread = (times: readonly Quantity[]): TimeSpread | null => {
  if (times.length === 0) return null;
  const sorted = times.map((each) => valueIn(each, "s")).sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
  return {
    count: sorted.length,
    min: seconds(sorted[0]!),
    median: seconds(Math.round(median * 1000) / 1000),
    p99: seconds(quantileOf(sorted, 0.99)),
    max: seconds(sorted.at(-1)!),
  };
};

/** This function gives a reference with its band, and only the reference when the band is [0, 0] s. */
const atBand = (from: string, band: Band): string => {
  const { lo, hi } = secondsOf(band);
  return lo === 0 && hi === 0 ? `the ${from}` : `the ${from} + ${showBand(band)}`;
};

/** This function gives the prediction of a cell in a short form for a table. A prediction `ends` gives its window after its band. */
export const predictionText = (prediction: Prediction): string => {
  switch (prediction.kind) {
    case "none":
      return prediction.outcomes === undefined ? "no failure" : `no ${prediction.outcomes.join(", ")}`;
    case "window":
      // a window with `each` is a window for each replica that got a deletion, from the references of that replica.
      // A window can open before its reference: a stale SYN_SENT entry fails the paused node up to its life before the intake
      return `failures only from ${atBand(prediction.start.from, prediction.start.band)}${prediction.end === null ? "" : ` to ${atBand(prediction.end.from, prediction.end.band)}`}${prediction.each === true ? ", of each deleted replica" : ""}${prediction.nodes === "paused" ? ", on the paused node" : ""}${prediction.certain ? ", at least one" : ""}${prediction.outcomes === undefined ? "" : `, each one ${prediction.outcomes.join(" or ")}`}${prediction.afterReset === undefined ? "" : `, or a ${prediction.afterReset.outcome} up to ${format(prediction.afterReset.life)} after a reset on its port`}${prediction.propagation === undefined ? "" : `, the rules drop the replica in ${showBand(prediction.propagation)}`}`;
    case "removal":
      return `Service empty in ${showBand(prediction.band)}`;
    case "leaves":
      return `the replica leaves in ${showBand(prediction.band)}${prediction.window === undefined ? "" : `; ${predictionText(prediction.window)}`}`;
    case "restarts":
      return prediction.band === null ? "no restart" : `each replica SIGTERM in ${showBand(prediction.band)}`;
    case "stays":
      return "stays ready, no refusal";
    case "stalls":
      return "the rollout waits for Redis";
    case "ends": {
      const closes =
        prediction.band === null
          ? "no socket of a client ends, and each one calls again on its socket"
          : prediction.of === "tunnel"
            ? `the side of the client ends the tunnel of each client in ${atBand(prediction.from, prediction.band)}${prediction.answer === undefined ? "" : `, or the peer answers in ${atBand(prediction.from, prediction.answer)}`}, and each one calls again`
            : `the socket of each client ends in ${atBand(prediction.from, prediction.band)}`;
      return prediction.window === undefined ? closes : `${closes}; ${predictionText(prediction.window)}`;
    }
    case "measured":
      return "measured";
  }
};

/**
 * This function gives the main measurement of a cell in a short form: its median and what it
 * counts. For failed requests, it is the middle count of the counted runs.
 */
export const medianText = (judged: Judged): string => {
  const { cell, verdict } = judged;
  if (verdict.median === null) return "";
  if (verdict.median.unit === "{request}") {
    const counted = judged.runs.filter((run) => !run.warmup && run.void === null);
    const failures = counted.map((run) => factsOf(cell, run).failures).sort((a, b) => a - b);
    return `${failures.length === 0 ? 0 : failures[Math.floor(failures.length / 2)]} failed requests`;
  }
  return format(verdict.median, { digits: 4 });
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
 *
 * For a policy of Istio, the propagation is the LDS update of each server sidecar after the apply,
 * by node (`updatesOf`). Then `heal` is the update after the delete of the policy. `slice` and
 * `intake` are null.
 */
export const calibrationOf = (judged: Judged): {
  readonly nodes: Readonly<Record<string, TimeSpread | null>>;
  readonly all: TimeSpread | null;
  readonly slice: TimeSpread | null;
  readonly intake: TimeSpread | null;
  readonly heal?: TimeSpread | null | undefined;
} => {
  const byNode: Record<string, Quantity[]> = {};
  const slice: Quantity[] = [];
  const intake: Quantity[] = [];
  const counted = judged.runs.filter((each) => !each.warmup && each.void === null);
  if (judged.cell.trigger.kind === "authorization-policy") {
    const heal: Quantity[] = [];
    for (const run of counted) {
      const nodeOf = (pod: string): string => run.replicas.find((replica) => replica.pod === pod)?.node ?? pod;
      for (const [pod, update] of Object.entries(updatesOf(run, run.acts.fault))) if (update !== null) (byNode[nodeOf(pod)] ??= []).push(update.by);
      for (const update of Object.values(updatesOf(run, run.acts.heal))) if (update !== null) heal.push(update.by);
    }
    const nodes = Object.fromEntries(Object.entries(byNode).map(([node, values]) => [node, timeSpread(values)]));
    return { nodes, all: timeSpread(Object.values(byNode).flat()), slice: null, intake: null, heal: timeSpread(heal) };
  }
  for (const run of counted) {
    const deletion = referenceOf(run, "deletion");
    for (const [node, drop] of Object.entries(propagationOf(run, deletion, undefined, propagationSource(judged.cell)))) if (drop !== null) (byNode[node] ??= []).push(drop.by);
    const facts = factsOf(judged.cell, run);
    if (facts.sliceAfter !== null) slice.push(facts.sliceAfter);
    if (facts.intakeAfterDeletion !== null) intake.push(facts.intakeAfterDeletion);
  }
  const nodes = Object.fromEntries(Object.entries(byNode).map(([node, values]) => [node, timeSpread(values)]));
  return { nodes, all: timeSpread(Object.values(byNode).flat()), slice: timeSpread(slice), intake: timeSpread(intake) };
};
