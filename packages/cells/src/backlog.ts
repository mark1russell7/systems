import type { BacklogTerm, Dataplane, KindCell, Workload } from "@mark1russell7/kind";
import { backlogEnd, drainBand, requestBand, stallRemovalBand } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Candidate, Connections, Expected } from "./callers.ts";
import { CANNOT_SERVE, STALL_HOLD } from "./callers.ts";
import { CHART_READINESS, PROPAGATION, T07_WORKLOAD, WORKERS, kubeDefaults, ms, s, say } from "./kind.ts";

/**
 * The cells of SYS-40: the backlog of a stalled target after its resume, from the sessions on the
 * target. The Cilium run of the stall (#246) had failed requests of C after the band end of 10 s, in
 * each of 3 runs. These cells test the term of that overshoot. The band of the stall in `callers.ts`
 * stays as committed, and its records are judged with it.
 *
 * The term: with n sessions on the target, the window of the stall closes up to n × d after the band
 * end. The failed requests grow by up to n × r. The value d is the drain time of one session after
 * the resume (`BACKLOG_DRAIN`). The value r is the requests of one session that fail in it (`BACKLOG_REQUESTS`).
 *
 * The term is for C, the candidate that keeps its sessions through the stall. The session check of D
 * closes each session on the target at its first stream timeout, long before the resume. Thus D has
 * no session on the target at the resume, and the term does not apply to it.
 *
 * The scenario is the stall cell of C with one change: the lab places the sessions (`onTarget` of the
 * workload). Each client has `BACKLOG_CONNECTIONS` sessions. Each session gets a request each 20 ms,
 * as the one session of C does. Thus a session on the target has the backlog of a session of C in the stall. Before
 * each run, n of the 6 sessions go to the target, and the others to the other replica. Each run
 * records the sessions on the target at the fault (`sessions` of its facts).
 */

/** These are the counts of the sessions on the target, one cell for each. */
export const BACKLOG_SESSIONS: readonly number[] = [1, 2, 3, 6];

/** This count is the sessions of each client. Three clients have 6, thus the cell with 6 sessions on the target has each session there. */
export const BACKLOG_CONNECTIONS = 2;

/**
 * This workload is the workload of C with two sessions for each client. A client sends a request each
 * 10 ms, thus each session gets a request each 20 ms, as in the workload of C.
 */
export const BACKLOG_WORKLOAD: Workload = { every: ms(10), timeout: T07_WORKLOAD.timeout, connections: BACKLOG_CONNECTIONS };

/** This band is d, the drain time of one session on the target after the resume. */
export const BACKLOG_DRAIN = { lo: ms(40), hi: ms(70) } as const;

/** This band is r, the requests of one session on the target that fail in its drain time. */
export const BACKLOG_REQUESTS = { lo: 0, hi: 3 } as const;

/** These are the modes of the cells: Cilium, the mode of the run that found the term. */
export const BACKLOG_MODES: readonly Dataplane[] = ["cilium"];

/** This is the candidate of the cells: C, the in-band signal on HTTP/2. */
const CANDIDATE: Candidate = "in band on HTTP/2 (GOAWAY)";

const requests = (value: number): Quantity => ({ value: Math.round(value), unit: "{request}" });
const sessions = (value: number): Quantity => ({ value, unit: "{connection}" });
/** This function gives a time in seconds to the microsecond, thus the sums of the bands print clean. */
const time = (value: number): Quantity => s(Math.round(value * 1e6) / 1e6);

/** This is the prediction of a cell of the backlog. It has the expected failures, the window from the fault, the band end without the term, and the reason. */
export interface BacklogPrediction {
  readonly expected: Expected;
  readonly start: { readonly lo: Quantity; readonly hi: Quantity };
  readonly end: { readonly lo: Quantity; readonly hi: Quantity };
  /** This time is the band end of the stall without the term, from the fault: one timeout before the resume. */
  readonly bandEnd: Quantity;
  /** This band is the term: the time after the band end at which the window closes, n × d. */
  readonly overshoot: { readonly lo: Quantity; readonly hi: Quantity };
  readonly why: string;
}

/**
 * This function gives the prediction of C in a stall with n sessions on the target. The band of the
 * stall gives the window from the fault to one timeout before the resume. The term adds n × d to
 * its end. The failed requests are those of the n sessions in that window, and n × r more.
 */
export const backlogOf = (mode: Dataplane, onTarget: number): BacklogPrediction => {
  const all = (WORKERS + 1) * BACKLOG_CONNECTIONS;
  if (!Number.isInteger(onTarget) || onTarget < 1 || onTarget > all) throw new RangeError(`${onTarget} sessions on the target is not 1 to ${all}`);
  const turn = valueIn(BACKLOG_WORKLOAD.every, "s") * BACKLOG_CONNECTIONS;
  const timeout = valueIn(BACKLOG_WORKLOAD.timeout, "s");
  const hold = valueIn(STALL_HOLD, "s");
  const removal = stallRemovalBand(CHART_READINESS, PROPAGATION[mode]);
  const drain = { lo: valueIn(BACKLOG_DRAIN.lo, "s"), hi: valueIn(BACKLOG_DRAIN.hi, "s") };
  const bandEnd = hold - timeout;
  // a count rounded to six places, thus 10 s / 20 ms gives 500
  const of = (span: number): number => Math.round((span / turn) * 1e6) / 1e6;
  const on: Connections = { lo: sessions(onTarget), hi: sessions(onTarget), of: sessions(all) };
  const expected: Expected = {
    lo: requests(onTarget * (Math.floor(of(bandEnd - turn)) + BACKLOG_REQUESTS.lo)),
    hi: requests(onTarget * (Math.ceil(of(bandEnd)) + 1 + BACKLOG_REQUESTS.hi)),
    connections: on,
  };
  const overshoot = { lo: time(onTarget * drain.lo), hi: time(onTarget * drain.hi) };
  return {
    expected,
    start: { lo: s(0), hi: time(turn) },
    end: { lo: time(bandEnd - turn), hi: time(bandEnd + onTarget * drain.hi) },
    bandEnd: time(bandEnd),
    overshoot,
    why: `The event loop of the target is blocked for the hold (${say(STALL_HOLD)}). The readiness probe removes it from the rules ${say(removal.lo)}–${say(removal.hi)} after the fault, but each established session stays on it. The lab places ${onTarget} of the ${all} sessions on the target before the fault. Each stream on them fails at its timeout (${say(BACKLOG_WORKLOAD.timeout)}), thus the band of the stall ends ${say(time(bandEnd))} after the fault. After the resume, the target drains the backlog of each of its sessions, thus a stream that started up to ${say(BACKLOG_DRAIN.lo)}–${say(BACKLOG_DRAIN.hi)} after the band end for each session also fails. The window closes ${say(overshoot.lo)}–${say(overshoot.hi)} after the band end, and approximately ${expected.lo.value}–${expected.hi.value} requests fail`,
  };
};

/** This function gives the words of a count of sessions: "1 session" or "6 sessions". */
const sessionWords = (count: number): string => `${count} session${count === 1 ? "" : "s"}`;

/** This function gives the cell of C in a stall with n sessions on the target, in a mode. */
export const backlogCellOf = (mode: Dataplane, onTarget: number): KindCell => {
  const predicted = backlogOf(mode, onTarget);
  return {
    id: `S2.T07.${mode}.goaway.backlog.n${onTarget}`,
    name: `T07 ${mode}, callers learn that a pod is stalled, with ${sessionWords(onTarget)} on the target: ${CANDIDATE}`,
    template: "T07",
    substitutes: null,
    mode,
    workers: WORKERS,
    trigger: { kind: "app-stall", hold: STALL_HOLD },
    pod: { ...kubeDefaults(2), readiness: CHART_READINESS },
    declaration: { ...CANNOT_SERVE, protocol: "h2c" },
    workload: { ...BACKLOG_WORKLOAD, onTarget },
    prediction: {
      kind: "window",
      nodes: "all",
      start: { from: "fault", band: predicted.start },
      end: { from: "fault", band: predicted.end },
      certain: true,
      outcomes: ["timeout"],
      why: predicted.why,
    },
    calibrates: false,
    runs: 5,
  };
};

/** These are the cells of the backlog: one for each count of the sessions on the target, in each mode. */
export const BACKLOG_CELLS: readonly KindCell[] = BACKLOG_MODES.flatMap((mode) => BACKLOG_SESSIONS.map((onTarget) => backlogCellOf(mode, onTarget)));

/**
 * The backlog band of SYS-42 is the second band of the stall of C. The bands above stay as
 * committed. The cells of SYS-40 found two biases of the first band.
 *
 * - The drain of a session after the resume is 10 ms to 45 ms (a fit gave approximately 26 ms), not
 *   40 ms to 70 ms. The overshoot is linear in n.
 * - The failed requests come from the measured period of the clients, not from `every`. The timer of
 *   a client of 10 ms fired each 10.10 ms to 10.26 ms. Thus the band counts from the mean period
 *   of the run, not from its median. The mean period is `period` of the facts (SYS-41).
 *
 * The term is in the window of the cell (`backlog`), thus the judge applies it to each run. The value
 * n is the sessions on the target at the fault (`sessions` of the facts), not the placement.
 */
export const BACKLOG_TERM: BacklogTerm = { drain: { lo: ms(10), hi: ms(45) }, requests: { lo: 0, hi: 3 }, most: (WORKERS + 1) * BACKLOG_CONNECTIONS };

/** This is the prediction of a cell of the backlog band. It is the prediction of the first band with the term of SYS-42. */
export interface BacklogBandPrediction {
  /** These are the failed requests at the setting of the period. The judge counts each run at its measured mean period instead. */
  readonly expected: Expected;
  readonly start: { readonly lo: Quantity; readonly hi: Quantity };
  /** This band is the end of the window without the term. The judge adds n × d to each end. */
  readonly bare: { readonly lo: Quantity; readonly hi: Quantity };
  /** This band is the end of the window with the term, for n of the placement. */
  readonly end: { readonly lo: Quantity; readonly hi: Quantity };
  readonly bandEnd: Quantity;
  /** This band is the term after the band end: n × d. */
  readonly overshoot: { readonly lo: Quantity; readonly hi: Quantity };
  readonly why: string;
}

/**
 * This function gives the prediction of C in a stall with n sessions on the target, with the backlog
 * band of SYS-42. The window opens at the fault, and it closes one timeout before the resume, plus
 * n × d. Each of the n sessions fails its requests up to the band end, and r more. With the term of
 * SYS-43 (`BACKLOG_DRAIN_TERM`), each session also fails its requests in the drain of the n sessions.
 */
export const backlogBandOf = (mode: Dataplane, onTarget: number, term: BacklogTerm = BACKLOG_TERM): BacklogBandPrediction => {
  const all = term.most;
  if (!Number.isInteger(onTarget) || onTarget < 1 || onTarget > all) throw new RangeError(`${onTarget} sessions on the target is not 1 to ${all}`);
  const turn = valueIn(BACKLOG_WORKLOAD.every, "s") * BACKLOG_CONNECTIONS;
  const hold = valueIn(STALL_HOLD, "s");
  const bandEnd = hold - valueIn(BACKLOG_WORKLOAD.timeout, "s");
  const removal = stallRemovalBand(CHART_READINESS, PROPAGATION[mode]);
  const bare = { lo: time(bandEnd - turn), hi: time(bandEnd) };
  const end = backlogEnd(bare, term, onTarget);
  const overshoot = backlogEnd({ lo: s(0), hi: s(0) }, term, onTarget);
  const count = requestBand(term, bare.hi, BACKLOG_WORKLOAD.every, BACKLOG_CONNECTIONS, onTarget);
  const expected: Expected = { lo: requests(count.lo), hi: requests(count.hi), connections: { lo: sessions(onTarget), hi: sessions(onTarget), of: sessions(all) } };
  return {
    expected,
    start: { lo: s(0), hi: time(turn) },
    bare,
    end,
    bandEnd: time(bandEnd),
    overshoot,
    why: `The event loop of the target is blocked for the hold (${say(STALL_HOLD)}). The readiness probe removes it from the rules ${say(removal.lo)}–${say(removal.hi)} after the fault, but each established session stays on it. The lab places ${onTarget} of the ${all} sessions on the target before the fault. Each stream on them fails at its timeout (${say(BACKLOG_WORKLOAD.timeout)}), thus the band of the stall ends ${say(time(bandEnd))} after the fault. After the resume, the target drains the backlog of each of its sessions, ${say(term.drain.lo)}–${say(term.drain.hi)} for each one. Thus the window closes ${say(overshoot.lo)}–${say(overshoot.hi)} after the band end. Each session on the target fails its requests up to the band end at the measured mean period of its client, and ${term.requests.lo}–${term.requests.hi} more in its drain${term.drains === true ? `. It also fails a request each turn until the window closes: 0–${drainBand(term, BACKLOG_WORKLOAD.every, BACKLOG_CONNECTIONS, onTarget).hi} more for each session at the setting, with n × ${say(term.drain.hi)} over a turn of ${say(time(turn))}` : ""}: approximately ${expected.lo.value}–${expected.hi.value} at the setting of ${say(BACKLOG_WORKLOAD.every)}`,
  };
};

/** This function gives the cell of C in a stall with n sessions on the target, in a mode, with the backlog band of SYS-42. */
export const backlogBandCellOf = (mode: Dataplane, onTarget: number): KindCell => {
  const predicted = backlogBandOf(mode, onTarget);
  const first = backlogCellOf(mode, onTarget);
  return {
    ...first,
    id: `S2.T07.${mode}.goaway.backlog-band.n${onTarget}`,
    name: `T07 ${mode}, callers learn that a pod is stalled, with ${sessionWords(onTarget)} on the target, by the backlog band: ${CANDIDATE}`,
    prediction: {
      kind: "window",
      nodes: "all",
      start: { from: "fault", band: predicted.start },
      end: { from: "fault", band: predicted.bare },
      certain: true,
      outcomes: ["timeout"],
      backlog: BACKLOG_TERM,
      why: predicted.why,
    },
  };
};

/** These are the cells of the backlog band (SYS-42): the cells of SYS-40 with the second band. Their ids and names are new, thus the records of SYS-40 keep the first band. */
export const BACKLOG_BAND_CELLS: readonly KindCell[] = BACKLOG_MODES.flatMap((mode) => BACKLOG_SESSIONS.map((onTarget) => backlogBandCellOf(mode, onTarget)));

/**
 * The drain band of SYS-43 is the third band of the stall of C. The bands above stay as committed.
 * The cells of SYS-42 found one bias of the second band: the count was high, in each run with 6
 * sessions. The window band held in 19 of 20 runs.
 *
 * The second band did not have this term: a session fails a request each turn until the window
 * closes. The window closes up to n × d.hi after the band end. Thus each session fails 0 to
 * ceil(n × d.hi / turn) more requests in the drain, and the total grows as n² × d / turn. The turn
 * is c × p: the kept connections of a client times the mean period of the run. The values d and r
 * are the values of SYS-42. They are not fitted again.
 */
export const BACKLOG_DRAIN_TERM: BacklogTerm = { ...BACKLOG_TERM, drains: true };

/** This function gives the cell of C in a stall with n sessions on the target, in a mode, with the drain band of SYS-43. */
export const backlogDrainCellOf = (mode: Dataplane, onTarget: number): KindCell => {
  const second = backlogBandCellOf(mode, onTarget);
  return {
    ...second,
    id: `S2.T07.${mode}.goaway.backlog-drain.n${onTarget}`,
    name: `T07 ${mode}, callers learn that a pod is stalled, with ${sessionWords(onTarget)} on the target, by the drain band: ${CANDIDATE}`,
    prediction: second.prediction.kind === "window" ? { ...second.prediction, backlog: BACKLOG_DRAIN_TERM, why: backlogBandOf(mode, onTarget, BACKLOG_DRAIN_TERM).why } : second.prediction,
  };
};

/** These are the cells of the drain band (SYS-43): the cells of SYS-42 with the third band. Their ids and names are new, thus the records of SYS-40 and SYS-42 keep their bands. */
export const BACKLOG_DRAIN_CELLS: readonly KindCell[] = BACKLOG_MODES.flatMap((mode) => BACKLOG_SESSIONS.map((onTarget) => backlogDrainCellOf(mode, onTarget)));
