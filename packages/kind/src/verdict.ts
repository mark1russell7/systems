import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { seconds, secondsOf } from "./bands.ts";
import type { Cycle, KindCell, KindRun, Prediction, Reference, ResetReuse, WindowPrediction } from "./cell.ts";
import { PORT, SERVER } from "./names.ts";
import type { Line, PropagationSource, Request, Sessions } from "./observe.ts";
import {
  HBONE_PORT,
  backendsAt,
  TCP_STATE,
  byNode,
  deletionOf,
  dropOf,
  emptyOf,
  failuresOf,
  intakeOf,
  outcomesOf,
  podsOf,
  requestsOf,
  restartOf,
  sessionsAt,
  signalsOf,
  sliceDropOf,
  sliceEmptyOf,
  sliceReadyAt,
  sliceReadyOf,
  socketsOf,
  tunnelsOf,
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
  /** These are the first LDS updates of the sidecar of each server pod after the fault, by pod (`updatesOf`). */
  readonly updates?: Readonly<Record<string, Propagated<A> | null>> | undefined;
  /** These are the first LDS updates of the sidecar of each server pod after the heal, by pod. */
  readonly healUpdates?: Readonly<Record<string, Propagated<A> | null>> | undefined;
  /** These are the first close of the socket of each client after the reference (`ends`), by client, or null for none. */
  readonly closes?: Readonly<Record<string, A | null>> | undefined;
  /**
   * These are the times of each cycle of a removal with flaps, in the sequence of the cycles. `empty` is
   * when the EndpointSlice had no ready endpoint, after the fault of the cycle. `ready` is when it had a
   * ready endpoint again, after the heal of the cycle. A time that the run does not have is null.
   */
  readonly cycles?: ReadonlyArray<{ readonly empty: A | null; readonly ready: A | null }> | undefined;
  /**
   * These are the sessions of the clients at the fault (`sessionsAt`): those on the target, of all,
   * and those on the target by client. A run of a workload with kept connections and a target has them.
   */
  readonly sessions?: Sessions | undefined;
  /**
   * This is the stall of the target (`app-stall`): its start after the fault, and how long its loop
   * stayed blocked. The app writes a line at each end of the stall. A run with no such line gives null.
   */
  readonly stall?: { readonly start: A | null; readonly held: A | null } | undefined;
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
 * - `s` for a time: the removal, the departure or the restart of a band, the end of a stall, or a close.
 * - `{request}` for the failed requests: no failure, a window, a fleet that stays, and a measurement.
 * - `{replica}` for the replicas that received SIGTERM, when no replica must restart.
 * - `{socket}` for the sockets of the clients that ended, when no socket must end.
 */
export const unitOf = (prediction: { readonly kind: Prediction["kind"]; readonly band?: unknown }): string => {
  switch (prediction.kind) {
    case "removal":
    case "leaves":
    case "stalls":
      return "s";
    case "restarts":
      return prediction.band === null ? "{replica}" : "s";
    case "ends":
      return prediction.band === null ? "{socket}" : "s";
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
export const referenceOf = (run: Pick<KindRun, "start" | "acts" | "target" | "lines">, from: Reference, pod: string | undefined = run.target?.pod): number | null => {
  const lines = run.lines as readonly Line[];
  if (from === "fault") return run.acts.fault;
  if (from === "resume") return run.acts.resume;
  if (from === "heal") return run.acts.heal;
  if (from === "restart") return restartOf(lines, run.start);
  if (pod === undefined) return null;
  if (from === "deletion") return deletionOf(lines, [pod], run.start);
  return intakeOf(lines, pod, run.start);
};

/**
 * This function gives the cycles of a run: each fault and its heal (`KindRun.acts.cycles`). A run
 * without cycles gives its one fault and heal, or none when it does not have both stamps.
 */
export const cyclesOf = (run: Pick<KindRun, "acts">): readonly Cycle[] => {
  if (run.acts.cycles !== undefined) return run.acts.cycles;
  const { fault, heal } = run.acts;
  return fault === null || heal === null ? [] : [{ fault, heal }];
};

/**
 * This function gives the source of the propagation of a cell. In a sidecar mesh, the client sidecar
 * picks the backend of each call from its endpoints (EDS), thus the source is `eds`. Each other cell
 * goes through the rules of kube-proxy (`rules`).
 */
export const propagationSource = (cell: Pick<KindCell, "mesh">): PropagationSource => (cell.mesh?.mode === "sidecar" ? "eds" : "rules");

/**
 * This function gives the propagation of each node for the target of a run, or for the replica of
 * the address `ip`. It is the time from its deletion (or its crash) to the first poll of the rules
 * of the node without it. The change came between the poll before (`after`) and that poll (`by`).
 * The source `eds` gives the poll of the client sidecar of each node.
 */
export const propagationOf = (
  run: KindRun,
  from: number | null,
  ip: string | undefined = run.target?.ip,
  source: PropagationSource = "rules",
): Record<string, Propagated | null> => {
  const out: Record<string, Propagated | null> = {};
  if (ip === undefined || from === null) return out;
  const nodes = [...new Set((run.lines as readonly Line[]).filter((line) => line.ev === source).map((line) => String(line["node"])))].sort();
  for (const node of nodes) {
    const drop = dropOf(run.lines as readonly Line[], node, `${ip}:${PORT}`, from, source);
    out[node] = drop === null ? null : { after: drop.prev === null ? null : seconds(sec(Math.max(0, drop.prev - from))), by: seconds(sec(drop.t - from)) };
  }
  return out;
};

/**
 * This function gives the first LDS update of the sidecar of each server pod after the stamp `from`.
 * The update came between the poll before (`after`) and the poll that saw it (`by`), after `from`.
 * A poller gives a line at each change of its counters. Thus a line after `from` with a poll before
 * it is an update, when its count `mod` is above the count before `from`. The first line of a poller
 * has no poll before it (`prev` is null), and it is no update.
 */
export const updatesOf = (run: Pick<KindRun, "lines">, from: number | null): Record<string, Propagated | null> => {
  const out: Record<string, Propagated | null> = {};
  if (from === null) return out;
  const lines = (run.lines as readonly Line[]).filter((line) => line.ev === "lds");
  for (const pod of [...new Set(lines.map((line) => String(line["pod"])))].sort()) {
    const own = lines.filter((line) => String(line["pod"]) === pod);
    const before = own.filter((line) => line.t <= from).at(-1);
    const base = before === undefined ? null : Number(before["mod"]);
    const update = own.find((line) => line.t > from && typeof line["prev"] === "number" && (base === null || Number(line["mod"]) > base));
    const prev = update === undefined ? null : (update["prev"] as number);
    out[pod] = update === undefined ? null : { after: seconds(sec(Math.max(0, prev! - from))), by: seconds(sec(update.t - from)) };
  }
  return out;
};

/** This function tells if the judge reads the LDS updates of a cell: the trigger is a policy of Istio. */
const listens = (cell: Pick<KindCell, "trigger">): boolean => cell.trigger.kind === "authorization-policy";

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
 * two references. It also gives its ends with δ, and the deletion of its replica (`origin`). Then it
 * gives the propagation of that deletion to each node, and when the rules of a node dropped its replica.
 */
interface Span {
  readonly pod: string | undefined;
  readonly start: number;
  readonly end: number | null;
  readonly lo: number;
  readonly hi: number;
  readonly origin: number | null;
  readonly propagation: RunFacts["propagation"];
  readonly dropped: (node: string) => number | null;
}

/** This function gives the window of the failed requests of a prediction: a window, the window of `ends`, `leaves`, `removal` or `stays`, or null. */
const windowOf = (prediction: Prediction): WindowPrediction | null =>
  prediction.kind === "window"
    ? prediction
    : prediction.kind === "ends" || prediction.kind === "leaves" || prediction.kind === "removal"
      ? (prediction.window ?? null)
      : prediction.kind === "stays" && prediction.failures?.kind === "window"
        ? prediction.failures
        : null;

/**
 * This function gives how long a run observes after the end reference of its last window, or null
 * when its prediction sets no such time. The judge closes a window `end.band.hi` + δ after its end
 * reference. A request that starts by then ends at most the timeout of the workload later: the
 * client cancels it then. A prediction with no window, or a window with no end, sets none.
 */
export const observationAfter = (cell: Pick<KindCell, "prediction" | "workload">): Quantity | null => {
  const window = windowOf(cell.prediction);
  if (window === null || window.end === null) return null;
  return seconds(sec(valueIn(window.end.band.hi, "ms") + valueIn(cell.workload.timeout, "ms") + NOISE));
};

/**
 * This function gives the earliest end of the observation of a run, as a stamp, or null when its
 * prediction sets none (`observationAfter`). It is that time after the latest end reference of a
 * window: of the target, or with `each`, of each replica that got a deletion. A run that ends before
 * it can miss its own failures. In a rolling update of gRPC, a call waits in the queue of its channel
 * for a stalled connect. It fails only at its timeout (kind run 40128267098). A reference that is not
 * in the lines yet does not count.
 *
 * The band of `ends` also sets an end: its reference, the end of the band and δ.
 */
export const observationEnd = (cell: KindCell, run: Pick<KindRun, "start" | "acts" | "target" | "replicas" | "lines">): number | null => {
  const ends: number[] = [];
  const prediction = cell.prediction;
  if (prediction.kind === "ends" && prediction.band !== null) {
    const at = referenceOf(run, prediction.from);
    if (at !== null) ends.push(at + valueIn(prediction.band.hi, "ms") + NOISE);
  }
  const after = observationAfter(cell);
  const window = windowOf(prediction);
  if (after !== null && window !== null && window.end !== null) {
    const from = window.end.from;
    const pods: ReadonlyArray<string | undefined> = window.each === true ? run.replicas.map((replica) => replica.pod) : [run.target?.pod];
    const references = pods.flatMap((pod) => {
      const at = referenceOf(run, from, pod);
      return at === null ? [] : [at];
    });
    if (references.length > 0) ends.push(Math.max(...references) + valueIn(after, "ms"));
  }
  return ends.length === 0 ? null : Math.max(...ends);
};

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
    propagation: propagationOf(run, from, undefined, propagationSource(cell)),
    ...(eachOf(cell.prediction) ? { deletions: deletionsOf(run) } : {}),
    ...(listens(cell) ? { updates: updatesOf(run, run.acts.fault), healUpdates: updatesOf(run, run.acts.heal) } : {}),
    ...(cell.workload.connections !== undefined && run.target !== null && run.acts.fault !== null
      ? { sessions: sessionsAt(lines, run.acts.fault, run.target.pod, cell.workload.connections) }
      : {}),
    ...(cell.trigger.kind === "app-stall" ? { stall: stallFactOf(run) } : {}),
  };
};

/**
 * This function gives the stall of the target in a run: the start of its line `stall` after the
 * fault, and the time that the app gives in its end line (`held`). A time that the run does not have is null.
 */
const stallFactOf = (run: KindRun): { readonly start: Quantity | null; readonly held: Quantity | null } => {
  const fault = run.acts.fault;
  const pod = run.target?.pod;
  const mine = (run.lines as readonly Line[]).filter((line) => line.ev === "stall" && (pod === undefined || line["p"] === pod) && line.t >= run.start);
  const start = mine.find((line) => line["phase"] === "start");
  const end = mine.find((line) => line["phase"] === "end");
  const held = end === undefined ? undefined : Number(end["held"]);
  return {
    start: start === undefined || fault === null ? null : seconds(sec(start.t - fault)),
    held: held === undefined || !Number.isFinite(held) ? null : seconds(sec(held)),
  };
};

type Done = (ok: boolean, why: string, value: number | null, more?: Partial<RunFacts>) => RunCheck;

/**
 * This function judges a removal with flaps. In each cycle, the Service has no ready endpoint, and the
 * rules of each node have no backend, in the band after its fault. Each time comes before the fault of
 * the next cycle. At the fault of each cycle after the first, the Service has a ready endpoint and the
 * rules of each node a backend. After the last heal, the Service has a ready endpoint again. The main
 * value is the empty Service of the first cycle.
 */
const removalOfCycles = (cell: KindCell, run: KindRun, prediction: Extract<Prediction, { kind: "removal" }>, done: Done): RunCheck => {
  const lines = run.lines as readonly Line[];
  const cycles = cyclesOf(run);
  if (cycles.length === 0) return done(false, "the run has no cycle of a fault and its heal", null);
  const band = secondsOf(prediction.band);
  const nodes = [...new Set(lines.filter((line) => line.ev === "rules").map((line) => String(line["node"])))].sort();
  const problems: string[] = [];
  const times: Array<{ readonly empty: Quantity | null; readonly ready: Quantity | null }> = [];
  let rules: Record<string, Quantity | null> = {};
  cycles.forEach((cycle, k) => {
    const n = k + 1;
    const next = cycles[k + 1]?.fault ?? run.end;
    // the slice and the rules give a line only at a change, thus the first cycle starts at rest
    if (k > 0) {
      if (sliceReadyAt(lines, SERVER, cycle.fault) !== true) problems.push(`the Service had no ready endpoint at the fault of the cycle ${n}`);
      const backends = backendsAt(lines, cycle.fault);
      for (const node of nodes) if ((backends.get(node) ?? []).length === 0) problems.push(`the rules of ${node} had no backend at the fault of the cycle ${n}`);
    }
    const empty = sliceEmptyOf(lines, SERVER, cycle.fault);
    const value = empty === null || empty > next ? null : sec(empty - cycle.fault);
    if (value === null) problems.push(`the Service kept a ready endpoint in the cycle ${n}`);
    else if (!inBand(value, band)) problems.push(`the EndpointSlice had no ready endpoint at ${value} s in the cycle ${n}`);
    const own: Record<string, Quantity | null> = {};
    for (const node of nodes) {
      const drop = emptyOf(lines, node, cycle.fault);
      const at = drop === null || drop.t > next ? null : sec(drop.t - cycle.fault);
      own[node] = at === null ? null : seconds(at);
      if (at === null) problems.push(`the rules of ${node} kept a backend in the cycle ${n}`);
      else if (!inBand(at, { lo: band.lo, hi: band.hi + 0.05 })) problems.push(`the rules of ${node} had no backend at ${at} s in the cycle ${n}`);
    }
    if (k === 0) rules = own;
    const ready = sliceReadyOf(lines, SERVER, cycle.heal);
    const back = ready === null || ready > next ? null : sec(ready - cycle.heal);
    if (k === cycles.length - 1 && back === null) problems.push("the Service had no ready endpoint after the last heal");
    times.push({ empty: value === null ? null : seconds(value), ready: back === null ? null : seconds(back) });
  });
  const first = times[0]!.empty === null ? null : valueIn(times[0]!.empty, "s");
  const inner = prediction.window === undefined ? null : checkRun({ ...cell, prediction: prediction.window }, run);
  if (inner !== null && !inner.ok) problems.push(inner.why);
  const empties = times.map((each) => (each.empty === null ? "none" : `${valueIn(each.empty, "s")} s`)).join(", ");
  const agrees = `the Service was empty in each of ${cycles.length} cycles, at ${empties} after its fault${inner === null ? "" : `; ${inner.why}`}`;
  const more: Partial<RunFacts> = { ...(inner === null ? {} : inner.facts), ...(first === null ? {} : { sliceEmpty: seconds(first) }), rules, cycles: times };
  const checked = done(problems.length === 0, problems.length === 0 ? agrees : problems.join("; "), first, more);
  return inner?.tail === undefined ? checked : { ...checked, tail: inner.tail };
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
      // with flaps, the window of each cycle: its own fault and heal
      const flaps = prediction.flaps === true;
      const cyclic = (from: Reference): from is "fault" | "heal" => from === "fault" || from === "heal";
      if (flaps && (each || !cyclic(prediction.start.from) || (prediction.end !== null && !cyclic(prediction.end.from))))
        return done(false, "a window with flaps has no each, and its references are the fault and the heal", null);
      const cycles = flaps ? cyclesOf(run) : [];
      if (flaps && cycles.length === 0) return done(false, "the run has no cycle of a fault and its heal", null);
      const sources: ReadonlyArray<{ readonly pod: string | undefined; readonly cycle: Cycle | undefined }> = flaps
        ? cycles.map((cycle) => ({ pod: run.target?.pod, cycle }))
        : pods.map((pod) => ({ pod, cycle: undefined }));
      const windows: Span[] = [];
      for (const { pod, cycle } of sources) {
        const at = (from: Reference): number | null => (cycle !== undefined && cyclic(from) ? cycle[from] : referenceOf(run, from, pod));
        const start = at(prediction.start.from);
        const end = prediction.end === null ? null : at(prediction.end.from);
        if (start === null || (prediction.end !== null && end === null))
          return done(false, `the run has no ${start === null ? prediction.start.from : prediction.end!.from} reference${each ? ` for ${pod}` : ""}`, null);
        const origin = each ? referenceOf(run, "deletion", pod) : (facts.deletion ?? (cell.trigger.kind === "crash" ? run.acts.fault : null));
        const ip = run.replicas.find((replica) => replica.pod === pod)?.ip;
        const propagation = each ? propagationOf(run, origin, ip, propagationSource(cell)) : facts.propagation;
        windows.push({
          pod,
          start,
          end,
          lo: start + opens.lo * 1000 - NOISE,
          hi: end === null ? Number.POSITIVE_INFINITY : end + closes!.hi * 1000 + NOISE,
          origin,
          propagation,
          dropped: droppedAfter(origin, propagation),
        });
      }
      // a node that dropped the replica of a window after the propagation of the prediction, or kept it
      // past that bound to the end of the run: the run agrees with the law, but the band is short (D-EXTEND)
      const bound = prediction.propagation === undefined ? null : secondsOf(prediction.propagation).hi * 1000 + NOISE;
      const lateOf = (origin: number, propagated: { readonly by: Quantity } | null) => {
        const by = propagated === null ? null : valueIn(propagated.by, "ms");
        return { by, late: bound !== null && (by === null ? run.end - origin > bound : by > bound) };
      };
      // for a policy, the propagation is the LDS update of each server sidecar after the fault and after the heal
      const listened = listens(cell);
      const updates = (facts.updates ?? {}) as Readonly<Record<string, Propagated | null>>;
      const healUpdates = (facts.healUpdates ?? {}) as Readonly<Record<string, Propagated | null>>;
      const slow =
        bound === null
          ? []
          : listened
            ? ([[run.acts.fault, updates, "the policy"], [run.acts.heal, healUpdates, "the delete of the policy"]] as const).flatMap(([origin, by, what]) =>
                origin === null
                  ? []
                  : Object.entries(by).flatMap(([pod, propagated]) => {
                      const late = lateOf(origin, propagated);
                      return late.late ? [{ pod: what, node: pod, by: late.by }] : [];
                    }),
              )
            : windows.flatMap(({ pod, origin, propagation }) =>
                origin === null
                  ? []
                  : Object.entries(propagation).flatMap(([node, propagated]) => {
                      const late = lateOf(origin, propagated);
                      return late.late ? [{ pod, node, by: late.by }] : [];
                    }),
              );
      // the last LDS update after the heal: a call to its replica can fail until the next call to it after the update
      const lastHeal =
        !listened || run.acts.heal === null
          ? null
          : Object.values(healUpdates).reduce<number | null>((max, propagated) => (propagated === null ? max : Math.max(max ?? 0, valueIn(propagated.by, "ms"))), null);
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
      // a denial after the window, before the last LDS update after the heal and the next call to its replica
      const healTail = (request: Request): boolean =>
        lastHeal !== null && request.t > windows[0]!.hi && request.t <= run.acts.heal! + lastHeal + SLACK + NOISE;
      const tail = late.filter((request) => tailOf(request) !== undefined || healTail(request));
      const outside = late.filter((request) => !reused.includes(request) && !tail.includes(request));
      // a window that names its outcomes allows no other failure in it
      const allowed = prediction.outcomes;
      const wrong = allowed === undefined ? [] : relevant.filter((request) => !late.includes(request) && !allowed.includes(request.o));
      const bounds = (window: Span): string => `[${sec(window.lo - window.start)}, ${sec(window.hi - window.start)}] s`;
      const problems: string[] = [];
      if (outside.length > 0)
        problems.push(
          each
            ? `${outside.length} failed requests outside the window of each deleted replica: ${windows.map((window) => `${window.pod} ${bounds(window)}`).join(", ")} after its ${prediction.start.from}`
            : flaps
              ? `${outside.length} failed requests outside the window of each cycle: ${windows.map((window, k) => `${k + 1} ${bounds(window)}`).join(", ")} after its ${prediction.start.from}`
              : `${outside.length} failed requests outside ${bounds(windows[0]!)} after ${prediction.start.from}`,
        );
      if (others.length > 0) problems.push(`${others.length} failed requests on nodes whose kube-proxy did not pause`);
      if (wrong.length > 0) problems.push(`${wrong.length} failed requests in the window ended ${JSON.stringify(outcomesOf(wrong))}, not ${allowed!.join(", ")}`);
      if (prediction.certain && relevant.length === 0) problems.push("no request failed in a window that the law opens");
      // the window that ends last: the last failed request comes near its end
      const final = windows.reduce((a, b) => ((b.end ?? Number.NEGATIVE_INFINITY) > (a.end ?? Number.NEGATIVE_INFINITY) ? b : a));
      // with flaps, each cycle has a failed request, and its last one comes near the end of its window
      if (flaps && prediction.certain && relevant.length > 0) {
        windows.forEach((window, k) => {
          const own = relevant.filter((request) => request.t >= window.lo && request.t <= window.hi);
          if (own.length === 0) problems.push(`no request failed in the window of the cycle ${k + 1}`);
          else if (window.end !== null) {
            const earliest = window.end + closes!.lo * 1000 - NOISE - SLACK;
            if (own.at(-1)!.t < earliest) problems.push(`the last failed request of the cycle ${k + 1} started ${sec(earliest - own.at(-1)!.t)} s before its window can end`);
          }
        });
      }
      if (!flaps && prediction.certain && final.end !== null && relevant.length > 0) {
        const last = relevant.at(-1)!.t;
        const earliest = final.end + closes!.lo * 1000 - NOISE - SLACK;
        if (last < earliest) problems.push(`the last failed request started ${sec(earliest - last)} s before the window can end`);
      }
      const inside = relevant.filter((request) => !late.includes(request));
      const span = inside.length === 0 ? 0 : sec(inside.at(-1)!.t - inside[0]!.t);
      const where = each ? `the windows of ${windows.length} deleted replicas` : flaps ? `the windows of ${windows.length} cycles` : "the window";
      const agrees =
        reused.length === 0
          ? `${relevant.length} failed requests, all in ${where} (span ${span} s)`
          : `${inside.length} failed requests in ${where} (span ${span} s), and ${reused.length} on a port that a reset closed`;
      const checked = done(problems.length === 0, problems.length === 0 ? agrees : problems.join("; "), relevant.length);
      if (problems.length > 0) return checked;
      const notes: string[] = [];
      if (tail.length > 0) {
        const last = tail.at(-1)!;
        const after = tailOf(last);
        notes.push(
          after === undefined
            ? `${tail.length} failed requests after the window, the last ${sec(last.t - windows[0]!.hi + NOISE)} s after it, before the last LDS update after the heal and the next call to its replica`
            : each
              ? `${tail.length} failed requests after a window, the last ${sec(last.t - after.hi + NOISE)} s after the window of ${after.pod} on ${last.n}, before the rules of ${last.n} dropped ${after.pod}`
              : `${tail.length} failed requests after the window, the last ${sec(last.t - after.hi + NOISE)} s after it on ${last.n}, before the rules of ${last.n} dropped the target`,
        );
      }
      if (slow.length > 0) {
        // a node that kept its replica to the end of the run is the latest
        const latest = slow.find((late) => late.by === null) ?? slow.reduce((a, b) => (b.by! > a.by! ? b : a));
        const bandHi = secondsOf(prediction.propagation!).hi;
        if (listened) {
          const update = latest.by === null ? `had no LDS update after ${latest.pod}` : `had its LDS update ${sec(latest.by)} s after ${latest.pod}`;
          notes.push(`${slow.length} LDS updates after the propagation of ${bandHi} s at the most, the latest: the sidecar of ${latest.node} ${update}`);
        } else {
          const what = each ? latest.pod : "the target";
          const drop = latest.by === null ? `kept ${what} to the end of the run` : `dropped ${what} ${sec(latest.by)} s after its deletion`;
          notes.push(`${slow.length} drops after the propagation of ${bandHi} s at the most, the latest: the rules of ${latest.node} ${drop}`);
        }
      }
      return notes.length === 0 ? checked : { ...checked, tail: notes.join("; ") };
    }
    case "removal": {
      const fault = run.acts.fault;
      if (fault === null) return done(false, "the run has no fault stamp", null);
      if (prediction.flaps === true) return removalOfCycles(cell, run, prediction, done);
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
      // with a window, the failed requests of the run must also agree with it, as with `leaves`
      const inner = prediction.window === undefined ? null : checkRun({ ...cell, prediction: prediction.window }, run);
      if (inner !== null && !inner.ok) problems.push(inner.why);
      const agrees = inner === null ? `the Service was empty at ${value} s` : `the Service was empty at ${value} s; ${inner.why}`;
      const checked = done(problems.length === 0, problems.length === 0 ? agrees : problems.join("; "), value, { ...(inner === null ? {} : inner.facts), sliceEmpty: seconds(value), rules });
      return inner?.tail === undefined ? checked : { ...checked, tail: inner.tail };
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
      const propagation = propagationOf(run, fault, undefined, propagationSource(cell));
      // the kube-proxy of a lost zone is frozen with its node, thus only the rules of the other nodes count
      const lost = cell.trigger.kind === "zone-loss" ? run.paused : null;
      for (const [node, drop] of Object.entries(propagation)) {
        if (node === lost) continue;
        const by = drop === null ? null : valueIn(drop.by, "s");
        if (by === null) problems.push(`the rules of ${node} kept ${run.target.pod}`);
        else if (!inBand(by, { lo: band.lo, hi: band.hi + 0.05 })) problems.push(`the rules of ${node} dropped it at ${by} s`);
      }
      // with a window, the failed requests of the run must also agree with it, as with `ends`
      const inner = prediction.window === undefined ? null : checkRun({ ...cell, prediction: prediction.window }, run);
      if (inner !== null && !inner.ok) problems.push(inner.why);
      const left = inner === null ? `${run.target.pod} left at ${value} s` : `${run.target.pod} left at ${value} s; ${inner.why}`;
      const checked = done(problems.length === 0, problems.length === 0 ? left : problems.join("; "), value, { ...(inner === null ? {} : inner.facts), left: seconds(value), propagation });
      return inner?.tail === undefined ? checked : { ...checked, tail: inner.tail };
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
      // the failed requests of a slow dependency: a window, or none
      const inner = prediction.failures === undefined ? null : checkRun({ ...cell, prediction: prediction.failures }, run);
      if (inner !== null && !inner.ok) problems.push(inner.why);
      const agrees = `the replicas stayed ready, ${failures.length} requests failed by their dependency${inner === null ? "" : `; ${inner.why}`}`;
      const checked = done(problems.length === 0, problems.length === 0 ? agrees : problems.join("; "), failures.length, inner === null ? {} : inner.facts);
      return inner?.tail === undefined ? checked : { ...checked, tail: inner.tail };
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
    case "ends":
      return checkEnds(cell, run, prediction, done);
    case "measured":
      return done(true, "measured", facts.failures);
  }
};

/**
 * This function judges a run against a prediction `ends`. Each client with an answer before the
 * reference is a client of the run. Its socket is the port of that answer (`lp`).
 * - With a band, the first close of a socket of each client after the reference must be in the band
 *   ± δ. It must be the close of that socket. The main value is the middle of these times.
 * - With no band, no socket of a client can close after the reference. The first request of each client
 *   after the heal must be `ok` on that socket. The main value is the count of the closes.
 *
 * With a window, the failed requests of the run must also agree with that window (`checkRun`). A
 * prediction of the tunnels (`of: "tunnel"`) has its own judge (`checkTunnels`).
 */
const checkEnds = (
  cell: KindCell,
  run: KindRun,
  prediction: Extract<Prediction, { readonly kind: "ends" }>,
  done: (ok: boolean, why: string, value: number | null, more?: Partial<RunFacts>) => RunCheck,
): RunCheck => {
  const from = referenceOf(run, prediction.from);
  if (from === null) return done(false, `the run has no ${prediction.from} reference`, null);
  if (prediction.of === "tunnel") return checkTunnels(run, prediction, from, done);
  const lines = run.lines as readonly Line[];
  const calls = requestsOf(lines)
    .filter((request) => request.t >= run.start && request.t <= run.end)
    .sort((a, b) => a.t - b.t);
  // each client of the run, with its last answer before the reference
  const last = new Map<string, Request>();
  for (const request of calls) if (request.t < from && request.o === "ok") last.set(request.p, request);
  if (last.size === 0) return done(false, `no client had an answer before the ${prediction.from}`, null);
  const clients = [...last.keys()].sort();
  const shut = socketsOf(lines).filter((line) => line.what === "close" && line.t >= from && line.t <= run.end);
  const closes: Record<string, Quantity | null> = {};
  const times: number[] = [];
  const problems: string[] = [];
  for (const client of clients) {
    const close = shut.find((line) => line.p === client);
    closes[client] = close === undefined ? null : seconds(sec(close.t - from));
    if (close !== undefined) times.push(sec(close.t - from));
  }
  let agrees: string;
  let value: number | null;
  if (prediction.band !== null) {
    const band = secondsOf(prediction.band);
    for (const client of clients) {
      const close = shut.find((line) => line.p === client);
      const port = last.get(client)!.lp ?? null;
      if (close === undefined) problems.push(`the socket of ${client} did not end`);
      else if (port !== null && close.lp !== null && close.lp !== port) problems.push(`the first socket of ${client} to end had the port ${close.lp}, not the port ${port} of its last answer`);
      else if (!inBand(sec(close.t - from), band)) problems.push(`the socket of ${client} ended at ${sec(close.t - from)} s`);
    }
    const sorted = [...times].sort((a, b) => a - b);
    value = sorted.length === 0 ? null : middle(sorted);
    agrees = `the socket of each of ${clients.length} clients ended, at ${sorted.join(", ")} s`;
  } else {
    for (const client of clients) {
      const close = shut.find((line) => line.p === client);
      if (close !== undefined) problems.push(`the socket of ${client} ended ${sec(close.t - from)} s after the ${prediction.from}`);
    }
    // the first call after the heal goes on the socket of the last answer before the reference
    const resumed = run.acts.heal ?? from;
    for (const client of clients) {
      const port = last.get(client)!.lp ?? null;
      const next = calls.find((request) => request.p === client && request.t >= resumed);
      if (next === undefined) problems.push(`${client} sent no call after the heal`);
      else if (next.o !== "ok") problems.push(`the first call of ${client} after the heal ended ${next.o}`);
      else if ((next.lp ?? null) !== port) problems.push(`the first call of ${client} after the heal went on the port ${next.lp ?? "none"}, not ${port ?? "none"}`);
    }
    value = times.length;
    agrees = `no socket of ${clients.length} clients ended, and the first call of each one after the heal went on its socket`;
  }
  const inner = prediction.window === undefined ? null : checkRun({ ...cell, prediction: prediction.window }, run);
  if (inner !== null && !inner.ok) problems.push(inner.why);
  const why = problems.length > 0 ? problems.join("; ") : inner === null ? agrees : `${agrees}; ${inner.why}`;
  const checked = done(problems.length === 0, why, value, { ...(inner === null ? {} : inner.facts), closes });
  return inner?.tail === undefined ? checked : { ...checked, tail: inner.tail };
};

/**
 * This function judges a run against a prediction `ends` of the tunnels (`of: "tunnel"`). Each client
 * with an answer before the reference is a client of the run. Its tunnel is the HBONE connection of
 * its ztunnel. The tunnel goes from the address of its pod to the HBONE port of the replica of its
 * last answer before the heal. The address of the pod is the local address of a socket of the client
 * in the run (`la`).
 * - The first change of the tunnel out of ESTABLISHED after the reference must be in the band ± δ.
 *   It must be to FIN_WAIT1: the side of the client closes the tunnel, and the peer does not close first.
 * - With `answer`, a change to CLOSE_WAIT in that band ± δ also agrees. The peer closed first, but as
 *   an answer to the close of the client.
 * - The first request of each client after the heal must succeed. The main value is the middle of the ends.
 */
const checkTunnels = (
  run: KindRun,
  prediction: Extract<Prediction, { readonly kind: "ends" }>,
  from: number,
  done: (ok: boolean, why: string, value: number | null, more?: Partial<RunFacts>) => RunCheck,
): RunCheck => {
  if (prediction.band === null) return done(false, "a prediction of the tunnels needs a band", null);
  const heal = run.acts.heal;
  if (heal === null) return done(false, "the run has no heal", null);
  const lines = run.lines as readonly Line[];
  const calls = requestsOf(lines)
    .filter((request) => request.t >= run.start && request.t <= run.end)
    .sort((a, b) => a.t - b.t);
  const clients = [...new Set(calls.filter((request) => request.t < from && request.o === "ok").map((request) => request.p))].sort();
  if (clients.length === 0) return done(false, `no client had an answer before the ${prediction.from}`, null);
  const band = secondsOf(prediction.band);
  const reply = prediction.answer === undefined ? null : secondsOf(prediction.answer);
  const tunnels = tunnelsOf(lines).filter((line) => line.t >= from && line.t <= run.end);
  const sockets = socketsOf(lines);
  const closes: Record<string, Quantity | null> = {};
  const times: number[] = [];
  const problems: string[] = [];
  for (const client of clients) {
    closes[client] = null;
    const answer = calls.filter((request) => request.p === client && request.t < heal && request.o === "ok").at(-1);
    const replica = run.replicas.find((each) => answer !== undefined && each.pod === answer.b);
    const address = sockets.find((line) => line.p === client && typeof line.la === "string" && line.la !== "")?.la;
    if (replica === undefined) {
      problems.push(`no replica of the run answered ${client} before the heal`);
      continue;
    }
    if (address === undefined || address === null) {
      problems.push(`no socket of ${client} gave the address of its pod`);
      continue;
    }
    const end = tunnels.find((line) => line.src.startsWith(`${address}:`) && line.dst === `${replica.ip}:${HBONE_PORT}` && line.old === TCP_STATE.established);
    if (end === undefined) {
      problems.push(`the tunnel of ${client} to ${replica.pod} did not end`);
      continue;
    }
    const at = sec(end.t - from);
    closes[client] = seconds(at);
    times.push(at);
    if (end.new === TCP_STATE.closeWait && reply !== null) {
      if (!inBand(at, reply)) problems.push(`the peer closed the tunnel of ${client} at ${at} s, outside the band of its answer`);
    } else if (end.new !== TCP_STATE.finWait1) problems.push(`the tunnel of ${client} went from ESTABLISHED to the state ${end.new}, not FIN_WAIT1: the peer closed first`);
    else if (!inBand(at, band)) problems.push(`the tunnel of ${client} ended at ${at} s`);
    const next = calls.find((request) => request.p === client && request.t >= heal);
    if (next === undefined) problems.push(`${client} sent no call after the heal`);
    else if (next.o !== "ok") problems.push(`the first call of ${client} after the heal ended ${next.o}`);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const why =
    problems.length > 0
      ? problems.join("; ")
      : `the side of the client ended the tunnel of each of ${clients.length} clients, at ${sorted.join(", ")} s, and the first call of each one after the heal succeeded`;
  return done(problems.length === 0, why, sorted.length === 0 ? null : middle(sorted), { closes });
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
  const band = prediction.kind === "removal" || prediction.kind === "leaves" || prediction.kind === "restarts" || prediction.kind === "ends" ? prediction.band : null;
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
