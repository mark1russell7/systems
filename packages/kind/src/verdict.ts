import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { seconds, secondsOf } from "./bands.ts";
import type { KindCell, KindRun, Prediction, Reference, ResetReuse } from "./cell.ts";
import { PORT, SERVER } from "./names.ts";
import type { Line, Request } from "./observe.ts";
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
import { RELATIVE, medianInterval, middle } from "./stats.ts";

/**
 * This time is δ for kind: each time of a run lands in its band ± δ. Its parts are the interval of
 * the poll of the rules (50 ms) and the delay of the watcher. The watcher receives each change after
 * the API server writes it.
 */
export const KIND_NOISE: Quantity = { value: 100, unit: "ms" };
/**
 * This time is how much earlier than the end of its window the last failed request can start. A
 * request goes to the closed pod by the choice of the rules, thus the last ones before the end can
 * go to another pod. At 50 requests a second and two pods, 12 requests in sequence miss the closed
 * pod with a chance of 1 in 4096.
 */
export const LAST_SLACK: Quantity = { value: 250, unit: "ms" };

/** These are δ and the slack in milliseconds, the unit of the stamps. */
const NOISE = valueIn(KIND_NOISE, "ms");
const SLACK = valueIn(LAST_SLACK, "ms");

/** A propagated change is when the rules of a node first had it: after the poll `after`, and by the poll `by`. */
export interface Propagated<A = Quantity> {
  readonly after: A | null;
  readonly by: A;
}

/**
 * The facts of a run are what each table reads: its failures by outcome and node, and the times of
 * its target. A count stays a number, and so does a stamp: `first`, `last` and `deletion` are
 * readings of CLOCK_MONOTONIC in milliseconds. Each other time is an amount after a reference. The
 * parameter `A` is the form of an amount: a quantity in the format `/2`, seconds in the format `/1`.
 */
export interface RunFacts<A = Quantity> {
  readonly failures: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly byNode: Readonly<Record<string, number>>;
  readonly first: number | null;
  readonly last: number | null;
  readonly deletion: number | null;
  readonly intakeAfterDeletion: A | null;
  readonly sliceAfter: A | null;
  /** This record is the propagation of the target to the rules of each node, by node. */
  readonly propagation: Readonly<Record<string, Propagated<A> | null>>;
  /** This time is when the EndpointSlice had no ready endpoint, after the fault (`removal`). */
  readonly sliceEmpty?: A | undefined;
  /** These times are when the rules of each node had no backend, after the fault (`removal`). */
  readonly rules?: Readonly<Record<string, A | null>> | undefined;
  /** This time is when the target left the EndpointSlice, after the fault (`leaves`). */
  readonly left?: A | undefined;
  /** These times are the SIGTERM of each replica, after the fault (`restarts`). */
  readonly signals?: ReadonlyArray<A | null> | undefined;
  /**
   * These are the replicas of a window for each deleted replica (`each`). Each one is a replica of the
   * run with a deletion after its start, with the stamps of its intake and of its deletion.
   */
  readonly deletions?: readonly Deleted[] | undefined;
}

/** A deleted replica is a replica of a run that got a deletion. It gives its pod, and the stamps of its intake (or null) and of its deletion. */
export interface Deleted {
  readonly pod: string;
  readonly intake: number | null;
  readonly deletion: number;
}

/**
 * A run check is the judgement of one run: if it agrees with the prediction, why, its main value,
 * and its facts. The main value is a time, or a count of requests or of replicas (`unitOf`).
 */
export interface RunCheck<A = Quantity> {
  readonly ok: boolean;
  readonly why: string;
  readonly value: A | null;
  readonly facts: RunFacts<A>;
  /**
   * This text tells why a run that agrees with the law is past its calibrated band. A request failed
   * after the window, but before the rules of its node dropped the target. Such a run makes its cell
   * `extend`, and the cell does not hold (D-EXTEND).
   */
  readonly tail?: string | undefined;
}

/** A kind decision is the result of a kind cell. */
export type KindDecision = "holds" | "fails" | "extend" | "measured" | "calibration" | "void";

/** A kind verdict is the judgement of a cell on its counted runs. */
export interface KindVerdict<A = Quantity> {
  readonly decision: KindDecision;
  readonly counted: number;
  readonly voided: number;
  readonly failed: number;
  /** This amount is the median of the main value of the counted runs, or null. */
  readonly median: A | null;
  readonly why: string;
  readonly checks: ReadonlyArray<RunCheck<A>>;
}

/**
 * This function gives the unit of the main value of a cell, from its prediction:
 * - `s` for a time: the removal, the departure or the restart of a band, and the end of a stall.
 * - `{request}` for the failed requests: no failure, a window, a fleet that stays, and a measurement.
 * - `{replica}` for the replicas that received SIGTERM, when no replica must restart.
 */
export const unitOf = (prediction: { readonly kind: Prediction["kind"]; readonly band?: unknown }): string => {
  switch (prediction.kind) {
    case "removal":
    case "leaves":
    case "stalls":
      return "s";
    case "restarts":
      return prediction.band === null ? "{replica}" : "s";
    default:
      return "{request}";
  }
};

const sec = (ms: number): number => Math.round(ms) / 1000;
const inBand = (value: number, band: { readonly lo: number; readonly hi: number }): boolean =>
  value >= band.lo - NOISE / 1000 && value <= band.hi + NOISE / 1000;
const time = (value: number | null): Quantity | null => (value === null ? null : seconds(value));

/**
 * This function tells if a failed request is the reuse of a port that a reset closed. The same
 * client had a reset on the same port, up to `life` before the request. The request ends with
 * `outcome`.
 */
export const reusesReset = (request: Request, requests: readonly Request[], reuse: ResetReuse): boolean => {
  if (request.o !== reuse.outcome || request.lp === undefined || request.lp === null) return false;
  const life = valueIn(reuse.life, "ms") + NOISE;
  return requests.some(
    (earlier) =>
      earlier.o === "reset" &&
      earlier.p === request.p &&
      earlier.lp === request.lp &&
      earlier.t + earlier.d <= request.t &&
      request.t - (earlier.t + earlier.d) <= life,
  );
};

/**
 * This function gives a reference event of a run, as a stamp, or null when the run does not have it.
 * The references `deletion` and `intake` are those of the target, or of the replica `pod`.
 */
export const referenceOf = (run: KindRun, from: Reference, pod: string | undefined = run.target?.pod): number | null => {
  const lines = run.lines as readonly Line[];
  if (from === "fault") return run.acts.fault;
  if (from === "resume") return run.acts.resume;
  if (pod === undefined) return null;
  if (from === "deletion") return deletionOf(lines, [pod], run.start);
  return intakeOf(lines, pod, run.start);
};

/**
 * This function gives the propagation of each node for the target of a run, or for the replica of
 * the address `ip`. It is the time from its deletion (or its crash) to the first poll of the rules
 * of the node without it. The change came between the poll before (`after`) and that poll (`by`).
 */
export const propagationOf = (run: KindRun, from: number | null, ip: string | undefined = run.target?.ip): Record<string, Propagated | null> => {
  const out: Record<string, Propagated | null> = {};
  if (ip === undefined || from === null) return out;
  const nodes = [...new Set((run.lines as readonly Line[]).filter((line) => line.ev === "rules").map((line) => String(line["node"])))].sort();
  for (const node of nodes) {
    const drop = dropOf(run.lines as readonly Line[], node, `${ip}:${PORT}`, from);
    out[node] = drop === null ? null : { after: drop.prev === null ? null : seconds(sec(Math.max(0, drop.prev - from))), by: seconds(sec(drop.t - from)) };
  }
  return out;
};

/**
 * This function gives each replica of a run that got a deletion after the start of the run, in the
 * sequence of the deletions. A rolling update deletes each old replica in turn.
 */
export const deletionsOf = (run: KindRun): Deleted[] =>
  run.replicas
    .flatMap((replica) => {
      const deletion = referenceOf(run, "deletion", replica.pod);
      return deletion === null ? [] : [{ pod: replica.pod, intake: referenceOf(run, "intake", replica.pod), deletion }];
    })
    .sort((a, b) => a.deletion - b.deletion);

/** This function tells if a prediction is a window for each deleted replica. */
const eachOf = (prediction: Prediction): boolean => prediction.kind === "window" && prediction.each === true;

/**
 * A span is one window of a run, as stamps. It gives the replica of its references (or none), and its
 * two references. It also gives its ends with δ, and when the rules of a node dropped its replica.
 */
interface Span {
  readonly pod: string | undefined;
  readonly start: number;
  readonly end: number | null;
  readonly lo: number;
  readonly hi: number;
  readonly dropped: (node: string) => number | null;
}

/** This function gives the facts of a run that each table reads: its failures by outcome and node, and the times of its target. */
export const factsOf = (cell: KindCell, run: KindRun): RunFacts => {
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
    intakeAfterDeletion: deletion === null || intake === null ? null : seconds(sec(intake - deletion)),
    sliceAfter: run.target === null || from === null ? null : time((() => {
      const at = sliceDropOf(lines, SERVER, run.target!.ip, from);
      return at === null ? null : sec(at - from);
    })()),
    propagation: propagationOf(run, from),
    ...(eachOf(cell.prediction) ? { deletions: deletionsOf(run) } : {}),
  };
};

/** This function judges one run against the prediction of its cell. */
export const checkRun = (cell: KindCell, run: KindRun): RunCheck => {
  const lines = run.lines as readonly Line[];
  const facts = factsOf(cell, run);
  const failures = failuresOf(lines).filter((request) => request.t >= run.start && request.t <= run.end);
  const prediction = cell.prediction;
  const unit = unitOf(prediction);
  const done = (ok: boolean, why: string, value: number | null, more: Partial<RunFacts> = {}): RunCheck => ({
    ok,
    why,
    value: value === null ? null : { value, unit },
    facts: { ...facts, ...more },
  });
  switch (prediction.kind) {
    case "none": {
      const excluded = prediction.outcomes;
      const counted = excluded === undefined ? failures : failures.filter((request) => excluded.includes(request.o));
      const what = excluded === undefined ? "requests failed" : `requests ended ${excluded.join(", ")}`;
      return done(counted.length === 0, counted.length === 0 ? `no ${excluded === undefined ? "request failed" : `request ended ${excluded.join(", ")}`}` : `${counted.length} ${what}: ${JSON.stringify(facts.outcomes)}`, counted.length);
    }
    case "window": {
      const each = prediction.each === true;
      const opens = secondsOf(prediction.start.band);
      const closes = prediction.end === null ? null : secondsOf(prediction.end.band);
      // a request after a window that started before the rules of its node dropped the replica of that
      // window agrees with the law: only the calibrated band is short (D-EXTEND). A request after the drop is still late
      const droppedAfter = (origin: number | null, propagation: RunFacts["propagation"]) => (node: string): number | null => {
        const propagated = propagation[node];
        return origin === null || propagated === undefined || propagated === null ? null : origin + valueIn(propagated.by, "ms");
      };
      // the window of the target, or with `each` the window of each replica that got a deletion
      const pods: ReadonlyArray<string | undefined> = each ? (facts.deletions ?? []).map((deleted) => deleted.pod) : [run.target?.pod];
      if (pods.length === 0) return done(false, "no replica of the run got a deletion", null);
      const windows: Span[] = [];
      for (const pod of pods) {
        const start = referenceOf(run, prediction.start.from, pod);
        const end = prediction.end === null ? null : referenceOf(run, prediction.end.from, pod);
        if (start === null || (prediction.end !== null && end === null))
          return done(false, `the run has no ${start === null ? prediction.start.from : prediction.end!.from} reference${each ? ` for ${pod}` : ""}`, null);
        const origin = each ? referenceOf(run, "deletion", pod) : (facts.deletion ?? (cell.trigger.kind === "crash" ? run.acts.fault : null));
        const ip = run.replicas.find((replica) => replica.pod === pod)?.ip;
        windows.push({
          pod,
          start,
          end,
          lo: start + opens.lo * 1000 - NOISE,
          hi: end === null ? Number.POSITIVE_INFINITY : end + closes!.hi * 1000 + NOISE,
          dropped: droppedAfter(origin, each ? propagationOf(run, origin, ip) : facts.propagation),
        });
      }
      const relevant: Request[] = prediction.nodes === "paused" ? failures.filter((request) => request.n === run.paused) : failures;
      const others = prediction.nodes === "paused" ? failures.filter((request) => request.n !== run.paused) : [];
      const reuse = prediction.afterReset;
      const late = relevant.filter((request) => windows.every((window) => request.t < window.lo || request.t > window.hi));
      // a request outside the window that reuses the port of a reset is the CLOSE entry of that reset
      const reused = reuse === undefined ? [] : late.filter((request) => reusesReset(request, failures, reuse));
      const tailOf = (request: Request): Span | undefined =>
        reused.includes(request)
          ? undefined
          : windows.find((window) => {
              const drop = request.t > window.hi ? window.dropped(request.n) : null;
              return drop !== null && request.t <= drop + NOISE;
            });
      const tail = late.filter((request) => tailOf(request) !== undefined);
      const outside = late.filter((request) => !reused.includes(request) && !tail.includes(request));
      const bounds = (window: Span): string => `[${sec(window.lo - window.start)}, ${sec(window.hi - window.start)}] s`;
      const problems: string[] = [];
      if (outside.length > 0)
        problems.push(
          each
            ? `${outside.length} failed requests outside the window of each deleted replica: ${windows.map((window) => `${window.pod} ${bounds(window)}`).join(", ")} after its ${prediction.start.from}`
            : `${outside.length} failed requests outside ${bounds(windows[0]!)} after ${prediction.start.from}`,
        );
      if (others.length > 0) problems.push(`${others.length} failed requests on nodes whose kube-proxy did not pause`);
      if (prediction.certain && relevant.length === 0) problems.push("no request failed in a window that the law opens");
      // the window that ends last: the last failed request comes near its end
      const final = windows.reduce((a, b) => ((b.end ?? Number.NEGATIVE_INFINITY) > (a.end ?? Number.NEGATIVE_INFINITY) ? b : a));
      if (prediction.certain && final.end !== null && relevant.length > 0) {
        const last = relevant.at(-1)!.t;
        const earliest = final.end + closes!.lo * 1000 - NOISE - SLACK;
        if (last < earliest) problems.push(`the last failed request started ${sec(earliest - last)} s before the window can end`);
      }
      const inside = relevant.filter((request) => !late.includes(request));
      const span = inside.length === 0 ? 0 : sec(inside.at(-1)!.t - inside[0]!.t);
      const where = each ? `the windows of ${windows.length} deleted replicas` : "the window";
      const agrees =
        reused.length === 0
          ? `${relevant.length} failed requests, all in ${where} (span ${span} s)`
          : `${inside.length} failed requests in ${where} (span ${span} s), and ${reused.length} on a port that a reset closed`;
      const checked = done(problems.length === 0, problems.length === 0 ? agrees : problems.join("; "), relevant.length);
      if (problems.length > 0 || tail.length === 0) return checked;
      const last = tail.at(-1)!;
      const after = tailOf(last)!;
      return {
        ...checked,
        tail: each
          ? `${tail.length} failed requests after a window, the last ${sec(last.t - after.hi + NOISE)} s after the window of ${after.pod} on ${last.n}, before the rules of ${last.n} dropped ${after.pod}`
          : `${tail.length} failed requests after the window, the last ${sec(last.t - after.hi + NOISE)} s after it on ${last.n}, before the rules of ${last.n} dropped the target`,
      };
    }
    case "removal": {
      const fault = run.acts.fault;
      if (fault === null) return done(false, "the run has no fault stamp", null);
      const empty = sliceEmptyOf(lines, SERVER, fault);
      if (empty === null) return done(false, "the Service kept a ready endpoint", null);
      const value = sec(empty - fault);
      const band = secondsOf(prediction.band);
      const problems: string[] = [];
      if (!inBand(value, band)) problems.push(`the EndpointSlice had no ready endpoint at ${value} s`);
      const nodes = [...new Set(lines.filter((line) => line.ev === "rules").map((line) => String(line["node"])))].sort();
      const rules: Record<string, Quantity | null> = {};
      for (const node of nodes) {
        const drop = emptyOf(lines, node, fault);
        rules[node] = drop === null ? null : seconds(sec(drop.t - fault));
        if (drop === null) problems.push(`the rules of ${node} kept a backend`);
        else if (!inBand(sec(drop.t - fault), { lo: band.lo, hi: band.hi + 0.05 }))
          problems.push(`the rules of ${node} had no backend at ${sec(drop.t - fault)} s`);
      }
      return done(problems.length === 0, problems.length === 0 ? `the Service was empty at ${value} s` : problems.join("; "), value, { sliceEmpty: seconds(value), rules });
    }
    case "leaves": {
      const fault = run.acts.fault;
      if (fault === null || run.target === null) return done(false, "the run has no fault stamp or no target", null);
      const at = sliceDropOf(lines, SERVER, run.target.ip, fault);
      if (at === null) return done(false, `${run.target.pod} stayed ready in the EndpointSlice`, null);
      const value = sec(at - fault);
      const band = secondsOf(prediction.band);
      const problems: string[] = [];
      if (!inBand(value, band)) problems.push(`${run.target.pod} left the EndpointSlice at ${value} s`);
      const propagation = propagationOf(run, fault);
      for (const [node, drop] of Object.entries(propagation)) {
        const by = drop === null ? null : valueIn(drop.by, "s");
        if (by === null) problems.push(`the rules of ${node} kept ${run.target.pod}`);
        else if (!inBand(by, { lo: band.lo, hi: band.hi + 0.05 })) problems.push(`the rules of ${node} dropped it at ${by} s`);
      }
      return done(problems.length === 0, problems.length === 0 ? `${run.target.pod} left at ${value} s` : problems.join("; "), value, { left: seconds(value), propagation });
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
      const band = secondsOf(prediction.band);
      const times = pods.map((pod) => {
        const at = signals.get(pod);
        return at === undefined ? null : sec(at - fault);
      });
      const missing = times.filter((each) => each === null).length;
      const off = times.filter((each): each is number => each !== null && !inBand(each, band));
      const known = times.filter((each): each is number => each !== null).sort((a, b) => a - b);
      const ok = missing === 0 && off.length === 0;
      return done(ok, ok ? `each replica received SIGTERM, at ${known.join(", ")} s` : `${missing} replicas without SIGTERM, ${off.length} outside the band (${known.join(", ")} s)`, known.length === 0 ? null : middle(known), { signals: times.map(time) });
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
      // only the replicas of the service: the pod of Redis is not a part of the rollout
      const servers = podsOf(lines).filter((pod) => pod.labels["app"] === SERVER);
      const pods = servers.filter((pod) => pod.t >= fault && pod.t <= heal);
      const deleted = pods.filter((pod) => old.has(pod.name) && pod.del);
      const newReady = pods.filter((pod) => !old.has(pod.name) && pod.ready);
      const after = servers.filter((pod) => pod.t > heal);
      const firstReady = after.find((pod) => !old.has(pod.name) && pod.ready);
      const finished = firstReady !== undefined && after.some((pod) => old.has(pod.name) && pod.type === "DELETED");
      const problems: string[] = [];
      if (deleted.length > 0) problems.push(`${new Set(deleted.map((pod) => pod.name)).size} old pods were deleted while Redis was down`);
      if (newReady.length > 0) problems.push("a new pod became ready while Redis was down");
      if (!finished) problems.push("the rollout did not continue after Redis came back");
      if (problems.length === 0)
        return done(true, `the rollout waited for Redis, and its first new pod was ready ${sec(firstReady!.t - heal)} s after Redis came back`, sec(firstReady!.t - heal));
      return done(false, problems.join("; "), null);
    }
    case "measured":
      return done(true, "measured", facts.failures);
  }
};

/** This function judges a cell on its runs: each counted run must agree, and a median in a band must be equivalent to it. */
export const judgeKind = (cell: KindCell, runs: readonly KindRun[]): KindVerdict => {
  const counted = runs.filter((run) => !run.warmup && run.void === null);
  const voided = runs.filter((run) => !run.warmup && run.void !== null).length;
  const checks = counted.map((run) => checkRun(cell, run));
  // the main values of one cell share the unit of its prediction
  const values = checks.flatMap((check) => (check.value === null ? [] : [check.value.value])).sort((a, b) => a - b);
  const median: Quantity | null = values.length === 0 ? null : { value: middle(values), unit: unitOf(cell.prediction) };
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
  // a run past its calibrated band agrees with the law, but the band is short: the cell needs a longer one
  const tails = checks.filter((check) => check.tail !== undefined);
  if (tails.length > 0)
    return { decision: "extend", counted: counted.length, voided, failed, median, why: `${tails.length} of ${counted.length} runs are past the calibrated band, the first: ${tails[0]!.tail}`, checks };
  if (band !== null && values.length > 0) {
    const ends = secondsOf(band);
    const [from, to] = medianInterval(values);
    const wide = { lo: ends.lo * (1 - RELATIVE), hi: ends.hi * (1 + RELATIVE) };
    if (to < wide.lo || from > wide.hi)
      return { decision: "fails", counted: counted.length, voided, failed, median, why: `the median interval [${from}, ${to}] s is outside the band`, checks };
    if (from < wide.lo || to > wide.hi)
      return { decision: "extend", counted: counted.length, voided, failed, median, why: `the median interval [${from}, ${to}] s crosses the edge of the band`, checks };
  }
  return { decision: "holds", counted: counted.length, voided, failed, median, why: `${counted.length} of ${counted.length} runs agree`, checks };
};
