import type { Band, KubeProxyMode, Reference, TriggerKind } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Candidate } from "./callers.ts";
import { CALLERS_CELLS, CALLERS_MODES, CANDIDATES, CANNOT_SERVE_HOLD, expectedFailures } from "./callers.ts";

/**
 * The scores of the S6 candidates of health and routing, for the dimension "how callers learn". A
 * score is data: the criterion, the measure of a run, the prediction next to it, and the evidence.
 * The evidence is the CI run and the cell. A criterion that the data cannot support is "not measured",
 * with the reason. No score fills a gap with an estimate.
 *
 * The first incident with cells is a pod that cannot serve (`cannot-serve`, the S2 cells of T07). The
 * other incidents of the design have no cell of the candidates yet, thus each one is "not measured".
 */

/** These are the criteria of the design of S6, in its sequence. */
export type Criterion =
  | "time until callers know"
  | "failed requests"
  | "false removals on a blip"
  | "time to recover"
  | "probe load"
  | "routes down"
  | "complexity";

/** These are the criteria in the sequence of each list of scores. */
export const CRITERIA: readonly Criterion[] = [
  "time until callers know",
  "failed requests",
  "false removals on a blip",
  "time to recover",
  "probe load",
  "routes down",
  "complexity",
];

/** These are the incidents of the design of S6, and the incident of the S2 cells. */
export type Incident =
  | "a pod that cannot serve"
  | "a black-holed shared dependency"
  | "a partitioned pod"
  | "a lost zone"
  | "a slow dependency (gray failure)"
  | "a flapping dependency"
  | "a failed prober";

/** These are the incidents in the sequence of the scorecard: the incident with cells first. */
export const INCIDENTS: readonly Incident[] = [
  "a pod that cannot serve",
  "a black-holed shared dependency",
  "a partitioned pod",
  "a lost zone",
  "a slow dependency (gray failure)",
  "a flapping dependency",
  "a failed prober",
];

/** This record is the evidence of a score: the CI run, the cell, and the verdict of the judge on its counted runs. */
export interface Evidence {
  readonly run: number;
  readonly cell: string;
  readonly decision: string;
  readonly counted: number;
}

/** This window is a prediction of a time: a band after a reference event of the run, the fault or the heal. */
export interface Window {
  readonly from: Reference;
  readonly band: Band;
}

/**
 * A score is one criterion of one candidate in one mode:
 * - `measured`: the copy of the run has the values, next to the prediction. `holds` tells that each
 *   counted value is in the band of the prediction.
 * - `bounded`: the judge checked each counted run against the prediction, but the copy keeps no
 *   value of its own. `holds` is the verdict of the judge.
 * - `not measured`: the data cannot support the criterion, and `why` gives the reason.
 */
export type Score =
  | {
      readonly criterion: Criterion;
      readonly kind: "measured";
      readonly median: Quantity;
      readonly values: readonly Quantity[];
      readonly prediction: Band;
      readonly holds: boolean;
      readonly evidence: Evidence;
    }
  | {
      readonly criterion: Criterion;
      readonly kind: "bounded";
      readonly prediction: Window;
      readonly holds: boolean;
      readonly evidence: Evidence;
      readonly why: string;
    }
  | { readonly criterion: Criterion; readonly kind: "not measured"; readonly why: string };

/** These are the scores of one candidate in one mode, one for each criterion in the sequence of `CRITERIA`. */
export interface CandidateScores {
  readonly candidate: Candidate;
  readonly label: string;
  readonly cell: string;
  readonly scores: readonly Score[];
}

/** These are the scores of each candidate in one mode. `fewest` is the label of the candidate with the fewest failed requests in the median run, or null. */
export interface ModeScores {
  readonly mode: KubeProxyMode;
  readonly candidates: readonly CandidateScores[];
  readonly fewest: string | null;
}

/** These are the scores of one incident: by mode for an incident with cells, or the reason that it has none. */
export type IncidentScores =
  | { readonly incident: Incident; readonly kind: "scored"; readonly trigger: TriggerKind; readonly modes: readonly ModeScores[] }
  | { readonly incident: Incident; readonly kind: "not measured"; readonly why: string };

/** This scorecard is the score of each candidate, for each incident and each mode, on each criterion. */
export interface Scorecard {
  readonly dimension: "how callers learn";
  readonly run: number;
  readonly criteria: readonly Criterion[];
  readonly incidents: readonly IncidentScores[];
}

/** This result is one S2 cell in the copy of a kind run: its verdict and its failed requests in each counted run. */
export interface CallerResult {
  readonly id: string;
  readonly decision: string;
  readonly counted: number;
  readonly median: number | null;
  readonly values: readonly number[];
}

/** This run is the copy of one kind run of the S2 cells: the id of the CI run and the result of each cell. */
export interface CallerRun {
  readonly run: number;
  readonly cells: readonly CallerResult[];
}

/** These are the labels of the candidates, in the sequence of `CANDIDATES`. */
const LABELS = "ABC";

const requests = (value: number): Quantity => ({ value, unit: "{request}" });

/** These texts give what each candidate needs from the service, for the criterion of complexity. */
const SETTINGS: Readonly<Record<Candidate, string>> = {
  "endpoints only": "A needs one opt-in setting: the option keepAlive of the transport gives true, thus each connection stays open.",
  "in band (lame duck)": "B needs no setting: it is the default of the transport on HTTP/1.1.",
  "in band on HTTP/2 (GOAWAY)": "C needs no setting of the service: it is the default of the transport on an edge of HTTP/2. The clients use one session each.",
};

/** These texts give the reason for each criterion that the S2 cells cannot support. */
const NOT_MEASURED: Readonly<Partial<Record<Criterion, string>>> = {
  "false removals on a blip": "T07 has no blip: the replica cannot serve for the whole hold of 30 s. No cell gives a short fault to the candidates yet.",
  "time to recover": "The cell counts the failed requests. It does not measure when the replica comes back into the endpoints after the heal.",
  "probe load": "Each candidate has the same readiness probe of the kubelet (2 s, 3 times) and the same poll of the service. The cell counts no probe.",
  "routes down": "T07 has one route, and the flag fails it only on the target. The cell does not count the routes.",
};

/** This text is the reason for each incident of the design that has no cell of the candidates yet. */
const NO_CELL = "No cell measures the candidates A, B and C in this incident yet.";

/** This function gives the window of the last failure of a candidate from its cell: the reference event and the band after it. */
const windowOf = (id: string): Window => {
  const cell = CALLERS_CELLS.find((each) => each.id === id);
  if (cell === undefined) throw new Error(`${id}: no S2 cell of the catalog`);
  const p = cell.prediction;
  if (p.kind !== "window" || p.end === null) throw new Error(`${id}: an S2 cell has a window that ends`);
  return { from: p.end.from, band: p.end.band };
};

/** This function gives the score of one criterion of a candidate whose cell has a result in the copy. */
const scoreOf = (criterion: Criterion, candidate: Candidate, mode: KubeProxyMode, result: CallerResult, run: number): Score => {
  const evidence: Evidence = { run, cell: result.id, decision: result.decision, counted: result.counted };
  if (criterion === "failed requests") {
    const expected = expectedFailures(candidate, mode);
    const lo = valueIn(expected.lo, "{request}");
    const hi = valueIn(expected.hi, "{request}");
    if (result.median === null) return { criterion, kind: "not measured", why: "The copy has no median of the failed requests of this cell." };
    return {
      criterion,
      kind: "measured",
      median: requests(result.median),
      values: result.values.map(requests),
      prediction: { lo: expected.lo, hi: expected.hi },
      holds: result.values.every((value) => value >= lo && value <= hi),
      evidence,
    };
  }
  if (criterion === "time until callers know") {
    const late =
      candidate === "endpoints only"
        ? ` A does not learn while the replica cannot serve: its failures end only after the heal, which comes ${valueIn(CANNOT_SERVE_HOLD, "s")} s after the fault.`
        : "";
    return {
      criterion,
      kind: "bounded",
      prediction: windowOf(result.id),
      holds: result.decision === "holds",
      evidence,
      why: `The judge found each failed request in the window of the prediction. The copy keeps the count, not the time of the last failure.${late}`,
    };
  }
  if (criterion === "complexity") return { criterion, kind: "not measured", why: `A run does not measure complexity. ${SETTINGS[candidate]}` };
  const why = NOT_MEASURED[criterion];
  if (why === undefined) throw new Error(`${criterion}: no reason for a criterion that the cells do not measure`);
  return { criterion, kind: "not measured", why };
};

/** This function gives the label of the candidate with the fewest failed requests in the median run of a mode. With no median, it gives null. */
const fewestOf = (candidates: readonly CandidateScores[]): string | null => {
  const medians = candidates.flatMap((each) => {
    const score = each.scores.find((one) => one.criterion === "failed requests");
    return score?.kind === "measured" ? [{ label: each.label, median: valueIn(score.median, "{request}") }] : [];
  });
  if (medians.length === 0) return null;
  return medians.reduce((best, each) => (each.median < best.median ? each : best)).label;
};

/**
 * This function gives the scorecard of a kind run of the S2 cells. Each candidate of each mode of the
 * catalog gets a score on each criterion. A cell with no result in the copy gets "not measured" on
 * each criterion. The other incidents of the design get "not measured", because no cell measures them.
 */
export const scoreCallers = (copy: CallerRun): Scorecard => {
  const modes = CALLERS_MODES.map((mode): ModeScores => {
    const candidates = CANDIDATES.map((candidate, at): CandidateScores => {
      const cell = CALLERS_CELLS.find((each) => each.mode === mode && each.name.endsWith(`: ${candidate}`));
      if (cell === undefined) throw new Error(`${mode}, ${candidate}: no S2 cell of the catalog`);
      const result = copy.cells.find((each) => each.id === cell.id);
      const scores = CRITERIA.map((criterion): Score =>
        result === undefined ? { criterion, kind: "not measured", why: `The copy of the run ${copy.run} has no result of this cell.` } : scoreOf(criterion, candidate, mode, result, copy.run),
      );
      return { candidate, label: LABELS[at] ?? "", cell: cell.id, scores };
    });
    return { mode, candidates, fewest: fewestOf(candidates) };
  });
  const incidents = INCIDENTS.map((incident): IncidentScores =>
    incident === "a pod that cannot serve" ? { incident, kind: "scored", trigger: "cannot-serve", modes } : { incident, kind: "not measured", why: NO_CELL },
  );
  return { dimension: "how callers learn", run: copy.run, criteria: CRITERIA, incidents };
};
