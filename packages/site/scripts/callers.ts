// The candidates of the S2 cells for the copy of the site: the window and the expected failed
// requests of each candidate, from the catalog. kind.ts writes them beside the runs. The table of the
// page shows each candidate of the catalog, thus a candidate with no run yet shows its prediction.

import type { KindCell } from "../../kind/src/index.ts";
import type { Quantity } from "../../quantity/src/index.ts";
import { valueIn } from "../../quantity/src/index.ts";
import type { Candidate } from "../../cells/src/callers.ts";
import { CALLERS_CELLS, CANDIDATES, expectedFailures } from "../../cells/src/callers.ts";

const s = (value: Quantity): number => valueIn(value, "s");

/** These are the labels of the candidates, in the sequence of `CANDIDATES`: A, B and C. */
const LABELS = "ABCDEFGH";

/** This function gives the candidate of an S2 cell, by the end of its name. */
export const candidateName = (cell: KindCell): Candidate => {
  const name = CANDIDATES.find((each) => cell.name.endsWith(`: ${each}`));
  if (name === undefined) throw new Error(`${cell.name}: no candidate of S2`);
  return name;
};

/** This function gives the candidate of an S2 cell for the side-by-side table: its window and its expected count of failed requests. */
export const candidateOf = (cell: KindCell) => {
  if (cell.trigger.kind !== "cannot-serve") return null;
  const p = cell.prediction;
  if (p.kind !== "window" || p.end === null) throw new Error(`${cell.name}: an S2 cell has a window that ends`);
  const name = candidateName(cell);
  const expected = expectedFailures(name, cell.mode);
  return {
    name,
    label: LABELS[CANDIDATES.indexOf(name)] ?? "",
    start: { from: p.start.from, low: s(p.start.band.lo), high: s(p.start.band.hi) },
    end: { from: p.end.from, low: s(p.end.band.lo), high: s(p.end.band.hi) },
    expected: { low: expected.lo.value, high: expected.hi.value },
    connections: { low: expected.connections.lo.value, high: expected.connections.hi.value, of: expected.connections.of.value },
  };
};

/** This function gives the prediction of each S2 cell of the catalog, a cell with no run too: by mode, then by candidate. */
export const callerPredictions = () =>
  CALLERS_CELLS.map((cell) => {
    const candidate = candidateOf(cell);
    if (candidate === null) throw new Error(`${cell.name}: an S2 cell has the trigger cannot-serve`);
    return { id: cell.id, mode: cell.mode, candidate };
  });
