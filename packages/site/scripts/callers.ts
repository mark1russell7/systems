// The candidates of the S2 cells for the copy of the site: the window and the expected failed
// requests of each candidate, from the catalog. kind.ts writes them beside the runs. The table of the
// page shows each candidate of the catalog, thus a candidate with no run yet shows its prediction.

import type { KindCell } from "../../kind/src/index.ts";
import type { Quantity } from "../../quantity/src/index.ts";
import { valueIn } from "../../quantity/src/index.ts";
import type { Candidate, CallerFault } from "../../cells/src/callers.ts";
import { CALLERS_CELLS, CANDIDATES, callerFaultOf, dependencyOf, expectedFailures, flappingOf, lostZoneOf } from "../../cells/src/callers.ts";
import { BACKLOG_CELLS, backlogBandOf, backlogOf } from "../../cells/src/backlog.ts";

const s = (value: Quantity): number => valueIn(value, "s");

/** These are the labels of the candidates, in the sequence of `CANDIDATES`: A, B, C and D. */
const LABELS = "ABCDEFGH";

/** This function gives the candidate of an S2 cell, by the end of its name. */
export const candidateName = (cell: KindCell): Candidate => {
  const name = CANDIDATES.find((each) => cell.name.endsWith(`: ${each}`));
  if (name === undefined) throw new Error(`${cell.name}: no candidate of S2`);
  return name;
};

/**
 * This function gives the candidate of an S2 cell for the side-by-side table: its window and its
 * expected count of failed requests. A shared dependency also has the empty Service and the time
 * until the callers know. A flapping dependency has them for each fault, and `each`: the expected
 * failed requests of one fault. A lost zone has `returns`: the band of the time from the heal until
 * the target is ready again. A slow dependency predicts no window for a candidate with no failure,
 * thus its `start` and `end` are null.
 */
export const candidateOf = (cell: KindCell) => {
  const kinds: readonly string[] = ["cannot-serve", "app-stall", "blackhole", "zone-loss", "latency"];
  if (!kinds.includes(cell.trigger.kind)) return null;
  // a false failure predicts the departure of the target, and a shared dependency the empty Service, each with the window of its failed requests
  const p =
    cell.prediction.kind === "leaves" || cell.prediction.kind === "removal" ? cell.prediction.window : cell.prediction.kind === "stays" ? cell.prediction.failures : cell.prediction;
  // a slow dependency: each replica stays, and a candidate with no failure has no window
  const none = cell.prediction.kind === "stays" && p?.kind === "none";
  if (!none && (p === undefined || p.kind !== "window" || p.end === null)) throw new Error(`${cell.name}: an S2 cell has a window that ends`);
  const window = p?.kind === "window" && p.end !== null ? { start: p.start, end: p.end } : null;
  const leaves = cell.prediction.kind === "leaves" ? { leaves: { from: "fault", low: s(cell.prediction.band.lo), high: s(cell.prediction.band.hi) } } : {};
  const name = candidateName(cell);
  const flapping = callerFaultOf(cell) === "flapping dependency" ? flappingOf(cell.mode, name) : null;
  const knows = cell.prediction.kind === "removal" ? (flapping ?? dependencyOf(cell.mode, name)).knows : null;
  const each = flapping === null ? {} : { each: { low: flapping.each.lo.value, high: flapping.each.hi.value } };
  const removal =
    cell.prediction.kind === "removal" && knows !== null
      ? { removal: { from: "fault", low: s(cell.prediction.band.lo), high: s(cell.prediction.band.hi) }, knows: { from: "fault", low: s(knows.lo), high: s(knows.hi) } }
      : {};
  // a cell of the backlog (SYS-40) places its sessions, thus its band has the term of the sessions on the target
  const backlog = backlogPredictionOf(cell);
  const expected = backlog === null ? expectedFailures(name, cell.mode, callerFaultOf(cell)) : backlog.expected;
  // a lost zone: the time from the heal until the target is ready again in its EndpointSlice
  const zone = callerFaultOf(cell) === "lost zone" ? lostZoneOf(cell.mode, name).returns : null;
  const returns = zone === null ? {} : { returns: { from: "heal", low: s(zone.lo), high: s(zone.hi) } };
  return {
    name,
    label: LABELS[CANDIDATES.indexOf(name)] ?? "",
    start: window === null ? null : { from: window.start.from, low: s(window.start.band.lo), high: s(window.start.band.hi) },
    end: window === null ? null : { from: window.end.from, low: s(window.end.band.lo), high: s(window.end.band.hi) },
    expected: { low: expected.lo.value, high: expected.hi.value },
    connections: { low: expected.connections.lo.value, high: expected.connections.hi.value, of: expected.connections.of.value },
    ...leaves,
    ...removal,
    ...each,
    ...returns,
  };
};

/** This function gives the prediction of each S2 cell of an incident in the catalog, by mode, then by candidate. A cell with no run has one too. */
export const callerPredictions = (fault: CallerFault = "cannot serve") =>
  CALLERS_CELLS.filter((cell) => callerFaultOf(cell) === fault).map((cell) => {
    const candidate = candidateOf(cell);
    if (candidate === null) throw new Error(`${cell.name}: an S2 cell has the trigger cannot-serve, a black hole, a stall, a zone loss or a latency`);
    return { id: cell.id, mode: cell.mode, candidate };
  });

/**
 * This function gives the prediction of a cell of the backlog, or null for a cell with no placement.
 * A window with the term (`backlog`) is a cell of the backlog band (SYS-42). The others are of the first band (SYS-40).
 */
export const backlogPredictionOf = (cell: KindCell) => {
  const onTarget = cell.workload.onTarget;
  if (onTarget === undefined) return null;
  return cell.prediction.kind === "window" && cell.prediction.backlog !== undefined ? backlogBandOf(cell.mode, onTarget) : backlogOf(cell.mode, onTarget);
};

/**
 * This function gives the prediction of each cell of the backlog (SYS-40, or SYS-42 for the cells of
 * the backlog band), in seconds. It has the candidate, the sessions on the target, the band end of
 * the stall without the term, and the term (`overshoot`).
 */
export const backlogPredictions = (cells: readonly KindCell[] = BACKLOG_CELLS) =>
  cells.map((cell) => {
    const candidate = candidateOf(cell);
    const onTarget = cell.workload.onTarget;
    const band = backlogPredictionOf(cell);
    if (candidate === null || onTarget === undefined || band === null) throw new Error(`${cell.name}: a cell of the backlog has a stall and a placement`);
    return { id: cell.id, mode: cell.mode, onTarget, bandEnd: s(band.bandEnd), overshoot: { low: s(band.overshoot.lo), high: s(band.overshoot.hi) }, candidate };
  });
