import { commitProblems, DIRTY, imagePinProblems } from "@mark1russell7/harness";
import type { KindCell, KindRun, Prediction } from "./cell.ts";
import type { Line } from "./observe.ts";
import type { KindCellRecord } from "./record.ts";

/**
 * This module holds the parts of the read of a schedule of kind cells (SYS-99). The read judges
 * each raw record again, and only `holds` passes.
 *
 * A record that does not pin the programs of its runs is not a record (SYS-101). A kind record pins
 * them with the commit of the checkout that operated, with no changes to tracked files, and with
 * each image of each cluster by its digest or by a build with its build record.
 *
 * The flip test of the read needs an injected fault that turns each cell red. A kind cell measures
 * the requests of its clients and the states of its cluster after the fault, thus the fault is an
 * outage that the cell does not predict. From the fault of each counted run, each request fails, and
 * the cluster shows no other line.
 */

/** This reason is the outcome of each request of the injected fault, when the prediction excludes no outcome by name. */
export const KIND_FAULT_OUTCOME = "timeout";

/** These are the parts of a kind record that tell if it pins the programs of its runs. */
export type KindPinnable = Pick<KindCellRecord, "code" | "manifests">;

/**
 * This function gives each problem that stops a kind record from pinning the programs of its runs.
 * An empty list means that the record pins each program. A record from before SYS-99 has no commit
 * and no build records, thus it is not a record of a schedule.
 */
export const kindRecordProblems = (record: KindPinnable): string[] => [
  ...new Set([
    ...commitProblems(record.code?.commit),
    ...(record.code?.dirty === true ? [DIRTY] : []),
    ...record.manifests.flatMap((manifest) => [
      ...imagePinProblems("the node image", manifest.cluster.nodeImage, undefined),
      ...Object.entries(manifest.images).flatMap(([name, image]) => imagePinProblems(`the image ${name}`, image, manifest.builds?.[name])),
    ]),
  ]),
];

/**
 * This function gives the outcome of the failed requests of the fault. A prediction of no failure
 * can exclude only some outcomes by name: then the fault takes the first of them, thus the
 * prediction counts each failure.
 */
const outcomeOf = (prediction: Prediction): string => {
  const none = prediction.kind === "none" ? prediction : prediction.kind === "stays" && prediction.failures?.kind === "none" ? prediction.failures : undefined;
  return none?.outcomes?.[0] ?? KIND_FAULT_OUTCOME;
};

/** This function gives one run under the fault: from the fault, each request fails, and each other line is gone. */
const faultedRun = (outcome: string, run: KindRun): KindRun => {
  const from = run.acts.fault ?? run.start;
  const lines = (run.lines as readonly Line[]).flatMap((line): Line[] => {
    if (line.t < from) return [line];
    if (line.ev !== "req") return [];
    return [line["o"] === "ok" ? { ...line, o: outcome } : line];
  });
  return { ...run, lines };
};

/**
 * This function injects the fault in the runs of a cell. Each counted run gets the outage from its
 * fault, or from its start when it has no fault. A warm-up and a void run stay as they are.
 */
export const faultedKind = (cell: KindCell, runs: readonly KindRun[]): KindRun[] => {
  const outcome = outcomeOf(cell.prediction);
  return runs.map((run) => (run.warmup || run.void !== null ? run : faultedRun(outcome, run)));
};
