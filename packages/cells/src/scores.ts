import type { Band, KubeProxyMode, Reference, TriggerKind } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { CallerFault, Candidate } from "./callers.ts";
import { CALLERS_CELLS, CALLERS_MODES, CALLER_FAULTS, CANDIDATES, CANNOT_SERVE_HOLD, PARTITION_HOLD, STALL_HOLD, callerFaultOf, expectedFailures } from "./callers.ts";

/**
 * The scores of the S6 candidates of health and routing, for the dimension "how callers learn". A
 * score is data: the criterion, the measure of a run, the prediction next to it, and the evidence.
 * The evidence is the CI run and the cell. A criterion that the data cannot support is "not measured",
 * with the reason. No score fills a gap with an estimate.
 *
 * Three incidents have cells: a pod that cannot serve (`cannot-serve`, the S2 cells of T07), a
 * partitioned pod (a black hole between the clients and the target), and a stalled pod (`app-stall`).
 * Each one has its own kind run.
 * The other incidents of the design have no cell of the candidates yet, thus each one is "not measured".
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
  | "a stalled pod (gray failure)"
  | "a lost zone"
  | "a slow dependency (gray failure)"
  | "a flapping dependency"
  | "a failed prober";

/** These are the incidents in the sequence of the scorecard: the incidents with cells first. */
export const INCIDENTS: readonly Incident[] = [
  "a pod that cannot serve",
  "a partitioned pod",
  "a stalled pod (gray failure)",
  "a black-holed shared dependency",
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
 *   counted value is in the band of the prediction. A time has `from`: its values and its band come after that event.
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
      readonly from?: Reference;
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

/** These are the scores of one incident: by mode for an incident with cells and its kind run, or the reason that it has none. */
export type IncidentScores =
  | { readonly incident: Incident; readonly kind: "scored"; readonly trigger: TriggerKind; readonly run: number; readonly modes: readonly ModeScores[] }
  | { readonly incident: Incident; readonly kind: "not measured"; readonly why: string };

/** This scorecard is the score of each candidate, for each incident and each mode, on each criterion. */
export interface Scorecard {
  readonly dimension: "how callers learn";
  /** This is the kind run of the first copy: the run of a pod that cannot serve. */
  readonly run: number;
  /** These are the ids of the CI run of each copy, with each id one time, in the order of the copies. */
  readonly runs: readonly number[];
  readonly criteria: readonly Criterion[];
  readonly incidents: readonly IncidentScores[];
}

/**
 * This result is one S2 cell in the copy of a kind run: its verdict and its failed requests in each
 * counted run. A newer copy also has `lasts`: the time from the fault to the start of the last failed
 * request of each counted run, in seconds. A run with no failed request gives null.
 */
export interface CallerResult {
  readonly id: string;
  readonly decision: string;
  readonly counted: number;
  readonly median: number | null;
  readonly values: readonly number[];
  readonly lasts?: readonly (number | null)[];
}

/** This run is the copy of one kind run of the S2 cells: the id of the CI run and the result of each cell. */
export interface CallerRun {
  readonly run: number;
  readonly cells: readonly CallerResult[];
}

/** These are the labels of the candidates, in the sequence of `CANDIDATES`. */
const LABELS = "ABCD";

const requests = (value: number): Quantity => ({ value, unit: "{request}" });

/** These texts give what each candidate needs from the service, for the criterion of complexity. */
const SETTINGS: Readonly<Record<Candidate, string>> = {
  "endpoints only": "A needs one opt-in setting: the option keepAlive of the transport gives true, thus each connection stays open.",
  "in band (lame duck)": "B needs no setting: it is the default of the transport on HTTP/1.1.",
  "in band on HTTP/2 (GOAWAY)": "C needs no setting of the service: it is the default of the transport on an edge of HTTP/2. The clients use one session each.",
  "in band on HTTP/2 with a session check":
    "D is C, and each client needs one opt-in setting: the session check of the HTTP/2 client, with two knobs (keepalive_time and keepalive_timeout).",
};

/** These texts give the reason for each criterion that the S2 cells of an incident cannot support. */
const NOT_MEASURED: Readonly<Record<CallerFault, Partial<Record<Criterion, string>>>> = {
  "cannot serve": {
    "false removals on a blip": "T07 has no blip: the replica cannot serve for the whole hold of 30 s. No cell gives a short fault to the candidates yet.",
    "time to recover": "The cell counts the failed requests. It does not measure when the replica comes back into the endpoints after the heal.",
    "probe load": "Each candidate has the same readiness probe of the kubelet (2 s, 3 times) and the same poll of the service. The cell counts no probe.",
    "routes down": "T07 has one route, and the flag fails it only on the target. The cell does not count the routes.",
  },
  partition: {
    "false removals on a blip": `The partition holds for ${valueIn(PARTITION_HOLD, "s")} s, and no candidate removes the replica: its readiness stays. No cell gives a short fault yet.`,
    "time to recover": "The cell counts the failed requests. It does not measure when the clients use the replica again after the heal.",
    "probe load": "Each candidate has the same readiness probe of the kubelet (2 s, 3 times) and the same poll of the service. The cell counts no probe.",
    "routes down": "The partition stops each route of the target for the clients. The cell does not count the routes.",
  },
  stall: {
    "false removals on a blip": `The stall holds for ${valueIn(STALL_HOLD, "s")} s, and the readiness probe removes the replica in it: a true removal. No cell gives a short stall yet.`,
    "time to recover": "The cell counts the failed requests. It does not measure when the replica comes back into the endpoints after the stall.",
    "probe load": "Each candidate has the same readiness probe of the kubelet (2 s, 3 times) and the same poll of the service. The cell counts no probe.",
    "routes down": "The stall stops each route of the target, because its event loop is blocked. The cell does not count the routes.",
  },
};

/** These are the incidents of the design that the S2 cells measure, and the trigger of their cells. */
const INCIDENT_OF: Readonly<Record<CallerFault, { readonly incident: Incident; readonly trigger: TriggerKind }>> = {
  "cannot serve": { incident: "a pod that cannot serve", trigger: "cannot-serve" },
  partition: { incident: "a partitioned pod", trigger: "blackhole" },
  stall: { incident: "a stalled pod (gray failure)", trigger: "app-stall" },
};

/** This text is the reason for each incident of the design that has no cell of the candidates yet. */
const NO_CELL = "No cell measures the candidates A, B, C and D in this incident yet.";

/**
 * These texts are the reasons of an incident with no cell, when the reason is more than `NO_CELL`. A
 * slow shared dependency slows each replica at once, thus no routing candidate can go around it.
 */
const NO_CELL_OF: Readonly<Partial<Record<Incident, string>>> = {
  "a slow dependency (gray failure)":
    "No cell measures the candidates in this incident yet. The S2 cells have no shared dependency, and a slow dependency slows each replica at once. Thus no routing candidate can go around it. The stalled pod is the gray failure of one replica.",
};

/** This text is the reason for an incident with cells, when no copy has a result of them. */
const NO_RUN = "No copy of a kind run has a result of the cells of this incident yet.";

/** This function gives the window of the last failure of a candidate from its cell: the reference event and the band after it. */
const windowOf = (id: string): Window => {
  const cell = CALLERS_CELLS.find((each) => each.id === id);
  if (cell === undefined) throw new Error(`${id}: no S2 cell of the catalog`);
  const p = cell.prediction;
  if (p.kind !== "window" || p.end === null) throw new Error(`${id}: an S2 cell has a window that ends`);
  return { from: p.end.from, band: p.end.band };
};

/** This function gives the median of sorted values: the middle value, or the mean of the two middle values. */
const middle = (sorted: readonly number[]): number => {
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};

/** This function gives the score of one criterion of a candidate whose cell has a result in the copy. */
const scoreOf = (criterion: Criterion, candidate: Candidate, mode: KubeProxyMode, fault: CallerFault, result: CallerResult, run: number): Score => {
  const evidence: Evidence = { run, cell: result.id, decision: result.decision, counted: result.counted };
  if (criterion === "failed requests") {
    const expected = expectedFailures(candidate, mode, fault);
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
    const prediction = windowOf(result.id);
    // a time from the fault: the copy gives the start of the last failed request of each run with one
    const lasts = (result.lasts ?? []).flatMap((each) => (each === null ? [] : [each])).sort((a, b) => a - b);
    if (prediction.from === "fault" && lasts.length > 0) {
      const [lo, hi] = [valueIn(prediction.band.lo, "s"), valueIn(prediction.band.hi, "s")];
      const seconds = (value: number): Quantity => ({ value, unit: "s" });
      return {
        criterion,
        kind: "measured",
        median: seconds(middle(lasts)),
        values: lasts.map(seconds),
        prediction: prediction.band,
        from: "fault",
        holds: lasts.every((value) => value >= lo && value <= hi),
        evidence,
      };
    }
    const late =
      candidate === "endpoints only" && fault === "cannot serve"
        ? ` A does not learn while the replica cannot serve: its failures end only after the heal, which comes ${valueIn(CANNOT_SERVE_HOLD, "s")} s after the fault.`
        : "";
    const keeps = result.lasts === undefined ? "The copy keeps the count, not the time of the last failure." : "No counted run had a failed request, thus no run gives the time of the last failure.";
    return {
      criterion,
      kind: "bounded",
      prediction,
      holds: result.decision === "holds",
      evidence,
      why: `The judge found each failed request in the window of the prediction. ${keeps}${late}`,
    };
  }
  if (criterion === "complexity") return { criterion, kind: "not measured", why: `A run does not measure complexity. ${SETTINGS[candidate]}` };
  const why = NOT_MEASURED[fault][criterion];
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
 * This function gives the scores of each candidate in each mode for an incident, from the copies of
 * its kind runs. Each cell gets its result from the first copy that has one, and that run is its
 * evidence. Thus a later run can add a candidate, and the scores of the earlier cells stay.
 */
const modesOf = (fault: CallerFault, copies: readonly [CallerRun, ...CallerRun[]]): readonly ModeScores[] =>
  CALLERS_MODES.map((mode): ModeScores => {
    const candidates = CANDIDATES.map((candidate, at): CandidateScores => {
      const cell = CALLERS_CELLS.find((each) => each.mode === mode && callerFaultOf(each) === fault && each.name.endsWith(`: ${candidate}`));
      if (cell === undefined) throw new Error(`${mode}, ${candidate}: no S2 cell of the catalog for ${fault}`);
      const copy = copies.find((each) => each.cells.some((result) => result.id === cell.id)) ?? copies[0];
      const result = copy.cells.find((each) => each.id === cell.id);
      const scores = CRITERIA.map((criterion): Score =>
        result === undefined ? { criterion, kind: "not measured", why: `The copy of the run ${copy.run} has no result of this cell.` } : scoreOf(criterion, candidate, mode, fault, result, copy.run),
      );
      return { candidate, label: LABELS[at] ?? "", cell: cell.id, scores };
    });
    return { mode, candidates, fewest: fewestOf(candidates) };
  });

/**
 * This function gives the scorecard of the S2 cells, from the copies of the kind runs. The run of an
 * incident is the run of its first copy with a result of its cells. Each cell gets its result from
 * the first copy that has one (`modesOf`). Each candidate of each mode
 * gets a score on each criterion. A cell with no result in the copy gets "not measured" on each
 * criterion. An incident with no copy, and each incident with no cell, gets "not measured".
 */
export const scoreCallers = (...copies: readonly CallerRun[]): Scorecard => {
  const first = copies[0];
  if (first === undefined) throw new Error("the scorecard needs the copy of a kind run");
  const scored = new Map(
    CALLER_FAULTS.map((fault) => {
      const ids = new Set(CALLERS_CELLS.filter((cell) => callerFaultOf(cell) === fault).map((cell) => cell.id));
      const [copy, ...later] = copies.filter((each) => each.cells.some((result) => ids.has(result.id)));
      const { incident, trigger } = INCIDENT_OF[fault];
      const scores: IncidentScores = copy === undefined ? { incident, kind: "not measured", why: NO_RUN } : { incident, kind: "scored", trigger, run: copy.run, modes: modesOf(fault, [copy, ...later]) };
      return [incident, scores] as const;
    }),
  );
  const incidents = INCIDENTS.map((incident): IncidentScores => scored.get(incident) ?? { incident, kind: "not measured", why: NO_CELL_OF[incident] ?? NO_CELL });
  return { dimension: "how callers learn", run: first.run, runs: [...new Set(copies.map((copy) => copy.run))], criteria: CRITERIA, incidents };
};
