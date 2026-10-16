import { RELATIVE, medianInterval } from "@mark1russell7/harness";
import type { Band, KindCell, KindRun, Reference } from "./cell.ts";
import type { Line } from "./lab.ts";
import { PORT, SERVER } from "./manifests.ts";
import type { Request } from "./observe.ts";
import {
  byNode,
  deletionOf,
  dropOf,
  emptyOf,
  failuresOf,
  intakeOf,
  outcomesOf,
  podsOf,
  signalsOf,
  sliceDropOf,
  sliceEmptyOf,
} from "./observe.ts";

/**
 * This time is δ for kind, in milliseconds: each time of a run lands in its band ± δ. Its parts are
 * the interval of the poll of the rules (50 ms) and the delay of the watcher. The watcher receives
 * each change after the API server writes it.
 */
export const KIND_NOISE = 100;
/**
 * This time is how much earlier than the end of its window the last failed request can start, in
 * milliseconds. A request goes to the closed pod by the choice of the rules, thus the last ones
 * before the end can go to another pod. At 50 requests a second and two pods, 12 requests in sequence
 * miss the closed pod with a chance of 1 in 4096.
 */
export const LAST_SLACK = 250;

/** A run check is the judgement of one run: if it agrees with the prediction, why, its main value in seconds, and its facts. */
export interface RunCheck {
  readonly ok: boolean;
  readonly why: string;
  readonly value: number | null;
  readonly facts: Readonly<Record<string, unknown>>;
}

/** A kind decision is the result of a kind cell. */
export type KindDecision = "holds" | "fails" | "extend" | "measured" | "calibration" | "void";

/** A kind verdict is the judgement of a cell on its counted runs. */
export interface KindVerdict {
  readonly decision: KindDecision;
  readonly counted: number;
  readonly voided: number;
  readonly failed: number;
  /** This value is the median of the main value of the counted runs, in seconds, or null. */
  readonly median: number | null;
  readonly why: string;
  readonly checks: readonly RunCheck[];
}

const sec = (ms: number): number => Math.round(ms) / 1000;
const inBand = (value: number, band: Band): boolean => value >= band.lo - KIND_NOISE / 1000 && value <= band.hi + KIND_NOISE / 1000;
const middle = (sorted: readonly number[]): number => {
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};

/** This function gives a reference event of a run, in milliseconds, or null when the run does not have it. */
export const referenceOf = (run: KindRun, from: Reference): number | null => {
  const lines = run.lines as readonly Line[];
  if (from === "fault") return run.acts.fault;
  if (from === "resume") return run.acts.resume;
  if (run.target === null) return null;
  const deletion = deletionOf(lines, [run.target.pod], run.start);
  if (from === "deletion") return deletion;
  return intakeOf(lines, run.target.pod, run.start);
};

/**
 * This function gives the propagation of each node for the target of a run. It is the time from
 * its deletion (or its crash) to the first poll of the rules of the node without it. The change
 * came between the poll before (`after`) and that poll (`by`).
 */
export const propagationOf = (run: KindRun, from: number | null): Record<string, { after: number | null; by: number } | null> => {
  const out: Record<string, { after: number | null; by: number } | null> = {};
  if (run.target === null || from === null) return out;
  const nodes = [...new Set((run.lines as readonly Line[]).filter((line) => line.ev === "rules").map((line) => String(line["node"])))].sort();
  for (const node of nodes) {
    const drop = dropOf(run.lines as readonly Line[], node, `${run.target.ip}:${PORT}`, from);
    out[node] = drop === null ? null : { after: drop.prev === null ? null : sec(Math.max(0, drop.prev - from)), by: sec(drop.t - from) };
  }
  return out;
};

/** This function gives the facts of a run that each table reads: its failures by outcome and node, and the times of its target. */
export const factsOf = (cell: KindCell, run: KindRun): Record<string, unknown> => {
  const lines = run.lines as readonly Line[];
  const failures = failuresOf(lines).filter((request) => request.t >= run.start && request.t <= run.end);
  const deletion = referenceOf(run, "deletion");
  const intake = referenceOf(run, "intake");
  const crash = cell.trigger.kind === "crash" ? run.acts.fault : null;
  const from = deletion ?? crash;
  return {
    failures: failures.length,
    outcomes: outcomesOf(failures),
    byNode: Object.fromEntries([...byNode(failures)].map(([node, list]) => [node, list.length])),
    first: failures.length === 0 ? null : failures[0]!.t,
    last: failures.length === 0 ? null : failures.at(-1)!.t,
    deletion,
    intakeAfterDeletion: deletion === null || intake === null ? null : sec(intake - deletion),
    sliceAfter: run.target === null || from === null ? null : (() => {
      const at = sliceDropOf(lines, SERVER, run.target!.ip, from);
      return at === null ? null : sec(at - from);
    })(),
    propagation: propagationOf(run, from),
  };
};

/** This function judges one run against the prediction of its cell. */
export const checkRun = (cell: KindCell, run: KindRun): RunCheck => {
  const lines = run.lines as readonly Line[];
  const facts = factsOf(cell, run);
  const failures = failuresOf(lines).filter((request) => request.t >= run.start && request.t <= run.end);
  const prediction = cell.prediction;
  const done = (ok: boolean, why: string, value: number | null): RunCheck => ({ ok, why, value, facts });
  switch (prediction.kind) {
    case "none":
      return done(failures.length === 0, failures.length === 0 ? "no request failed" : `${failures.length} requests failed: ${JSON.stringify(facts["outcomes"])}`, failures.length);
    case "window": {
      const start = referenceOf(run, prediction.start.from);
      const end = prediction.end === null ? null : referenceOf(run, prediction.end.from);
      if (start === null || (prediction.end !== null && end === null))
        return done(false, `the run has no ${start === null ? prediction.start.from : prediction.end!.from} reference`, null);
      const lo = start + prediction.start.band.lo * 1000 - KIND_NOISE;
      const hi = end === null ? Number.POSITIVE_INFINITY : end + prediction.end!.band.hi * 1000 + KIND_NOISE;
      const relevant: Request[] = prediction.nodes === "paused" ? failures.filter((request) => request.n === run.paused) : failures;
      const others = prediction.nodes === "paused" ? failures.filter((request) => request.n !== run.paused) : [];
      const outside = relevant.filter((request) => request.t < lo || request.t > hi);
      const problems: string[] = [];
      if (outside.length > 0) problems.push(`${outside.length} failed requests outside [${sec(lo - start)}, ${sec(hi - start)}] s after ${prediction.start.from}`);
      if (others.length > 0) problems.push(`${others.length} failed requests on nodes whose kube-proxy did not pause`);
      if (prediction.certain && relevant.length === 0) problems.push("no request failed in a window that the law opens");
      if (prediction.certain && end !== null && relevant.length > 0) {
        const last = relevant.at(-1)!.t;
        const earliest = end + prediction.end!.band.lo * 1000 - KIND_NOISE - LAST_SLACK;
        if (last < earliest) problems.push(`the last failed request started ${sec(earliest - last)} s before the window can end`);
      }
      const span = relevant.length === 0 ? 0 : sec(relevant.at(-1)!.t - relevant[0]!.t);
      return done(problems.length === 0, problems.length === 0 ? `${relevant.length} failed requests, all in the window (span ${span} s)` : problems.join("; "), relevant.length);
    }
    case "removal": {
      const fault = run.acts.fault;
      if (fault === null) return done(false, "the run has no fault stamp", null);
      const empty = sliceEmptyOf(lines, SERVER, fault);
      if (empty === null) return done(false, "the Service kept a ready endpoint", null);
      const value = sec(empty - fault);
      const problems: string[] = [];
      if (!inBand(value, prediction.band)) problems.push(`the EndpointSlice had no ready endpoint at ${value} s`);
      const nodes = [...new Set(lines.filter((line) => line.ev === "rules").map((line) => String(line["node"])))].sort();
      const rules: Record<string, number | null> = {};
      for (const node of nodes) {
        const drop = emptyOf(lines, node, fault);
        rules[node] = drop === null ? null : sec(drop.t - fault);
        if (drop === null) problems.push(`the rules of ${node} kept a backend`);
        else if (!inBand(sec(drop.t - fault), { lo: prediction.band.lo, hi: prediction.band.hi + 0.05 }))
          problems.push(`the rules of ${node} had no backend at ${sec(drop.t - fault)} s`);
      }
      return { ok: problems.length === 0, why: problems.length === 0 ? `the Service was empty at ${value} s` : problems.join("; "), value, facts: { ...facts, sliceEmpty: value, rules } };
    }
    case "leaves": {
      const fault = run.acts.fault;
      if (fault === null || run.target === null) return done(false, "the run has no fault stamp or no target", null);
      const at = sliceDropOf(lines, SERVER, run.target.ip, fault);
      if (at === null) return done(false, `${run.target.pod} stayed ready in the EndpointSlice`, null);
      const value = sec(at - fault);
      const problems: string[] = [];
      if (!inBand(value, prediction.band)) problems.push(`${run.target.pod} left the EndpointSlice at ${value} s`);
      const propagation = propagationOf(run, fault);
      for (const [node, drop] of Object.entries(propagation)) {
        if (drop === null) problems.push(`the rules of ${node} kept ${run.target.pod}`);
        else if (!inBand(drop.by, { lo: prediction.band.lo, hi: prediction.band.hi + 0.05 })) problems.push(`the rules of ${node} dropped it at ${drop.by} s`);
      }
      return { ok: problems.length === 0, why: problems.length === 0 ? `${run.target.pod} left at ${value} s` : problems.join("; "), value, facts: { ...facts, left: value, propagation } };
    }
    case "restarts": {
      const fault = run.acts.fault;
      if (fault === null) return done(false, "the run has no fault stamp", null);
      const until = run.acts.heal ?? run.end;
      const pods = run.replicas.map((replica) => replica.pod);
      const signals = signalsOf(lines, pods, fault);
      const inside = [...signals].filter(([, at]) => at <= until);
      if (prediction.band === null)
        return done(inside.length === 0, inside.length === 0 ? "no replica received SIGTERM" : `${inside.length} replicas received SIGTERM`, inside.length);
      const times = pods.map((pod) => {
        const at = signals.get(pod);
        return at === undefined ? null : sec(at - fault);
      });
      const missing = times.filter((time) => time === null).length;
      const off = times.filter((time): time is number => time !== null && !inBand(time, prediction.band!));
      const known = times.filter((time): time is number => time !== null).sort((a, b) => a - b);
      const ok = missing === 0 && off.length === 0;
      return { ok, why: ok ? `each replica received SIGTERM, at ${known.join(", ")} s` : `${missing} replicas without SIGTERM, ${off.length} outside the band (${known.join(", ")} s)`, value: known.length === 0 ? null : middle(known), facts: { ...facts, signals: times } };
    }
    case "stays": {
      const fault = run.acts.fault;
      if (fault === null) return done(false, "the run has no fault stamp", null);
      const until = run.end;
      const dropped = run.replicas.filter((replica) => {
        const at = sliceDropOf(lines, SERVER, replica.ip, fault);
        return at !== null && at <= until;
      });
      const refused = failures.filter((request) => request.o === "refused" && request.t >= fault);
      const problems: string[] = [];
      if (dropped.length > 0) problems.push(`${dropped.length} replicas left the EndpointSlice`);
      if (refused.length > 0) problems.push(`${refused.length} requests were refused`);
      return done(problems.length === 0, problems.length === 0 ? `the replicas stayed ready, ${failures.length} requests failed by their dependency` : problems.join("; "), failures.length);
    }
    case "stalls": {
      const fault = run.acts.fault;
      const heal = run.acts.heal;
      if (fault === null || heal === null) return done(false, "the run has no fault or heal stamp", null);
      const old = new Set(run.replicas.map((replica) => replica.pod));
      const pods = podsOf(lines).filter((pod) => pod.t >= fault && pod.t <= heal);
      const deleted = pods.filter((pod) => old.has(pod.name) && pod.del);
      const newReady = pods.filter((pod) => !old.has(pod.name) && pod.ready);
      const after = podsOf(lines).filter((pod) => pod.t > heal);
      const finished = after.some((pod) => !old.has(pod.name) && pod.ready) && after.some((pod) => old.has(pod.name) && pod.type === "DELETED");
      const problems: string[] = [];
      if (deleted.length > 0) problems.push(`${new Set(deleted.map((pod) => pod.name)).size} old pods were deleted while Redis was down`);
      if (newReady.length > 0) problems.push("a new pod became ready while Redis was down");
      if (!finished) problems.push("the rollout did not continue after Redis came back");
      return done(problems.length === 0, problems.length === 0 ? "the rollout waited for Redis, and continued after it" : problems.join("; "), null);
    }
    case "measured":
      return done(true, "measured", facts["failures"] as number);
  }
};

/** This function judges a cell on its runs: each counted run must agree, and a median in a band must be equivalent to it. */
export const judgeKind = (cell: KindCell, runs: readonly KindRun[]): KindVerdict => {
  const counted = runs.filter((run) => !run.warmup && run.void === null);
  const voided = runs.filter((run) => !run.warmup && run.void !== null).length;
  const checks = counted.map((run) => checkRun(cell, run));
  const values = checks.map((check) => check.value).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const median = values.length === 0 ? null : middle(values);
  const failed = checks.filter((check) => !check.ok).length;
  if (counted.length === 0) return { decision: "void", counted: 0, voided, failed: 0, median: null, why: "no counted run", checks };
  if (cell.calibrates) return { decision: "calibration", counted: counted.length, voided, failed, median, why: "a calibration of the propagation", checks };
  if (cell.prediction.kind === "measured") return { decision: "measured", counted: counted.length, voided, failed: 0, median, why: cell.prediction.why, checks };
  const prediction = cell.prediction;
  const band = prediction.kind === "removal" || prediction.kind === "leaves" || prediction.kind === "restarts" ? prediction.band : null;
  if (failed > 0) {
    const first = checks.find((check) => !check.ok)!;
    return { decision: "fails", counted: counted.length, voided, failed, median, why: `${failed} of ${counted.length} runs disagree, the first: ${first.why}`, checks };
  }
  if (band !== null && values.length > 0) {
    const [from, to] = medianInterval(values);
    const wide = { lo: band.lo * (1 - RELATIVE), hi: band.hi * (1 + RELATIVE) };
    if (to < wide.lo || from > wide.hi)
      return { decision: "fails", counted: counted.length, voided, failed, median, why: `the median interval [${from}, ${to}] s is outside the band`, checks };
    if (from < wide.lo || to > wide.hi)
      return { decision: "extend", counted: counted.length, voided, failed, median, why: `the median interval [${from}, ${to}] s crosses the edge of the band`, checks };
  }
  return { decision: "holds", counted: counted.length, voided, failed, median, why: `${counted.length} of ${counted.length} runs agree`, checks };
};
