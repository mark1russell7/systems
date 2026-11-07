import type { Cell, Measured, Verdict } from "@mark1russell7/harness";
import { noiseOf, verdictOf } from "@mark1russell7/harness";
import { quantity, valueIn } from "@mark1russell7/quantity";

/**
 * This module reads the decisions of the scheduled cells (SYS-99). The workflow Cells does not fail
 * on a failing cell, because a cell that fails is a finding of a manual run. A schedule claims that
 * its cells hold, thus a step reads each decision again from the raw records.
 *
 * Only `holds` passes. A cell that reads `measured`, `extend`, `inconclusive` or `fails` is red, and
 * a cell of the selection that has no record is red too. A "no read" is not a pass.
 *
 * A record that does not pin the programs of its runs is not a record (SYS-101), thus its cell is red
 * too. Examples are an image with no digest, a checkout with changes, and the record of a debug run.
 */

/** This factor is the size of the injected fault: each counted run reads this factor times the top of its band. */
export const FAULT_FACTOR = 1.5;

/** This reason is the finding of the injected fault on a cell that predicts no detection. */
export const FAULT_DETECTION = "the injected fault: a detection in the window of a silent cell";

/** The read of one cell is its decision, and if that decision passes. */
export interface HeldCell {
  readonly name: string;
  readonly decision: string;
  readonly held: boolean;
  readonly why: string;
}

/** The read of a selection holds the read of each cell. It also names the cells with no record and the records outside the selection. */
export interface HeldRead {
  readonly held: boolean;
  readonly cells: readonly HeldCell[];
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly reason: string;
}

/** This function counts a noun in words. */
const counted = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`;

/**
 * This function reads the verdicts of a selection. `expected` holds the names that the selection
 * gives, and `verdicts` holds the verdict of each record. `problems` holds the problems of the pins
 * of each record (`recordProblems`). It passes only if each expected cell has a record, each record
 * is expected, each record pins its programs, and each decision is `holds`.
 */
export const heldRead = (
  expected: readonly string[],
  verdicts: ReadonlyMap<string, Verdict>,
  problems: ReadonlyMap<string, readonly string[]> = new Map(),
): HeldRead => {
  const names = new Set(expected);
  const missing = expected.filter((name) => !verdicts.has(name));
  const extra = [...verdicts.keys()].filter((name) => !names.has(name));
  const cells = expected.flatMap((name): HeldCell[] => {
    const verdict = verdicts.get(name);
    if (verdict === undefined) return [];
    const unpinned = problems.get(name) ?? [];
    if (unpinned.length > 0) return [{ name, decision: verdict.decision, held: false, why: `not a record: ${unpinned.join("; ")}` }];
    return [{ name, decision: verdict.decision, held: verdict.decision === "holds", why: verdict.why }];
  });
  const unpinned = cells.filter((cell) => (problems.get(cell.name) ?? []).length > 0);
  const red = cells.filter((cell) => !cell.held);
  const held = expected.length > 0 && missing.length === 0 && extra.length === 0 && red.length === 0;
  const parts = [
    ...(expected.length === 0 ? ["the selection names no cell"] : []),
    ...(red.length === 0 ? [] : [`${counted(red.length, "cell")} of ${cells.length} did not hold`]),
    ...(unpinned.length === 0 ? [] : [`${counted(unpinned.length, "record")} with no pin of the programs`]),
    ...(missing.length === 0 ? [] : [`${counted(missing.length, "cell")} of the selection had no record`]),
    ...(extra.length === 0 ? [] : [`${counted(extra.length, "record")} outside the selection`]),
  ];
  return { held, cells, missing, extra, reason: held ? `each of the ${cells.length} cells holds` : parts.join(", ") };
};

/** This function gives the time band of a prediction, or undefined for a cell that predicts no time. */
const timedOf = (cell: Cell): { readonly high: number } | undefined => {
  const { prediction } = cell;
  if (prediction.detects === null) return undefined;
  const timed = prediction.detects ? prediction : (prediction.recovers ?? prediction.replies);
  return timed === undefined ? undefined : { high: valueIn(timed.high, "s") };
};

/**
 * This function injects the fault in the measures of a cell. Each counted run of a timed cell reads
 * `FAULT_FACTOR` times the top of its band. Each counted run of a silent cell gets a detection. A
 * cell with no band stays as it is: its decision is not `holds` in any case.
 */
export const faulted = (cell: Cell, runs: readonly Measured[]): Measured[] => {
  if (cell.prediction.detects === null) return [...runs];
  const timed = timedOf(cell);
  if (timed === undefined) return runs.map((run) => (run.void === null ? { ...run, finding: FAULT_DETECTION } : run));
  const top = timed.high + valueIn(noiseOf(cell), "s");
  return runs.map((run) => (run.void === null ? { ...run, elapsed: quantity(top * FAULT_FACTOR, "s") } : run));
};

/** This function gives the verdict of a cell under the injected fault. */
export const faultedVerdict = (cell: Cell, runs: readonly Measured[]): Verdict => verdictOf(cell.prediction, faulted(cell, runs), noiseOf(cell));

/**
 * This function gives the power of a timed cell: the top of its band over its slowest counted run.
 * A slowdown of the runs by more than this factor turns the cell red. It gives null for a cell with
 * no time.
 */
export const slowdownSeen = (cell: Cell, runs: readonly Measured[]): number | null => {
  const timed = timedOf(cell);
  const times = runs.flatMap((run) => (run.void === null && run.elapsed !== null ? [valueIn(run.elapsed, "s")] : []));
  if (timed === undefined || times.length === 0) return null;
  return (timed.high + valueIn(noiseOf(cell), "s")) / Math.max(...times);
};
