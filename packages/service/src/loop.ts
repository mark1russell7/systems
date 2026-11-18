// @mark1russell7/service/loop: one loop core (SYS-138). A schedule is data, and the poller, the worker loop and a
// stream are three settings of it. Each lane of a loop is an instance of `LOOP_MACHINE`, and each round has a scope of
// the kind `round`. The entry imports no node: module and no zod. Thus a client in a browser can use it.

import type { Transition } from "@mark1russell7/algebra/replay";
import type { Extent, Quantity } from "@mark1russell7/quantity";
import { convertible, valueIn } from "@mark1russell7/quantity";
import type { Backoff } from "./backoff.ts";
import type { Clock } from "./clock.ts";
import { countOf } from "./knobs.ts";
import type { TimeField, Timing } from "./loop-kernel.ts";
import { runLoop, timingProblems } from "./loop-kernel.ts";
import { LOOP_MACHINE } from "./machines.ts";
import type { Scope } from "./scope.ts";
import type { Poll } from "./timing.ts";
import { retryOf } from "./units.ts";
import type { WorkerKnobs } from "./worker.ts";

export { LOOP_MACHINE };

/** A budget bounds the starts of the rounds of a loop: at most `rounds` starts in each window of `per`, over all lanes. */
export interface Budget {
  /** This whole number from 1 is the most rounds that start in one window. */
  readonly rounds: number;
  /** This time is the length of the window. It has a bound and it is above zero. */
  readonly per: Quantity;
}

/**
 * A schedule tells when the rounds of a loop start. Each field is necessary. The poller, the worker loop and a stream
 * are three settings of it: `pollSchedule`, `workerSchedule` and `streamSchedule`.
 */
export interface Schedule {
  /** `start` plans each round one period after the planned start of the last round. `end` plans it one period after the end. */
  readonly from: "start" | "end";
  /** This time is the period between two rounds of a lane. A time without a bound starts a round only at `wake()`. */
  readonly period: Extent;
  /** This fraction below 1 is the jitter of each period: each period is `period × (1 ± jitter)`. */
  readonly jitter: number;
  /** This time is the delay of the first round of each lane after the start. A time without a bound waits for `wake()`. */
  readonly first: Extent;
  /** This time bounds one round. At it, the scope of the round aborts, and the round is a failure. */
  readonly timeout: Extent;
  /** This policy gives the delay after each failure in sequence. `null` keeps the period after a failure. */
  readonly backoff: Backoff | null;
  /**
   * This setting acts on a round that is due while its lane has a round in flight. The due round fails at once
   * (`fail`), does not occur (`skip`), or starts beside the other round (`allow`). Only a schedule from `start` reads
   * it: a lane from `end` has one round at a time.
   */
  readonly overlap: "fail" | "skip" | "allow";
  /** This whole number from 1 is the count of lanes. Each lane is one instance of the machine. */
  readonly lanes: number;
  /** This budget bounds the starts of all lanes together. `null` is no bound. */
  readonly budget: Budget | null;
  /** `true`: the timers of the schedule keep a Node process alive. `false`: only the deadline of a round in flight keeps it alive. */
  readonly hold: boolean;
  /**
   * This time is the proof that a lane works. `null`: each pass is the proof, and it sets the count of failures in
   * sequence to zero. A time: a round proves its lane when it uses `reset()` of its context, or when it stays in flight
   * for this time. A round with a proof sets the count to zero before its outcome counts. A round with no proof is a
   * failure, also when it passes. Thus a stream that opens and then drops at once backs off up to its cap.
   */
  readonly stable: Extent | null;
}

/** These are the states of a lane, as in `LOOP_MACHINE`. */
export type LoopState = "idle" | "waiting" | "calling" | "hung" | "backoff" | "deferred" | "stopped";

/** These are the events of a lane, as in `LOOP_MACHINE`. */
export type LoopEvent = "start" | "tick" | "retry" | "window" | "wake" | "answer" | "more" | "fail" | "timeout" | "late-answer" | "stop";

/** This record tells that a round started. Each time is on the clock of the loop, in milliseconds. */
export interface RoundStart {
  readonly kind: "start";
  readonly loop: string;
  readonly lane: number;
  /** This number is the round, from 1. Each round of a loop has its own number, over all lanes. */
  readonly round: number;
  /** This time is the planned start. The lateness of the round is its start minus this time. */
  readonly planned: number;
  readonly start: number;
}

/** This record tells that a round ended: at its end, at its timeout, or at once because its lane was busy. */
export interface RoundEnd {
  readonly kind: "end";
  readonly loop: string;
  readonly lane: number;
  readonly round: number;
  readonly planned: number;
  readonly start: number;
  readonly end: number;
  readonly outcome: "pass" | "more" | "fail";
  /** `true`: the round was past its timeout. Its lane is `hung` until the round settles. */
  readonly timedOut: boolean;
  /** `true`: the round did not start, because the overlap is `fail` and its lane had a round in flight. */
  readonly blocked: boolean;
  /**
   * This value is the throw of the round, the error of the close of its scope, or the reason of its timeout. For a
   * pass with no proof, it is an `UnprovedRoundError`.
   */
  readonly error: unknown;
}

/** This record tells that rounds did not occur: the overlap is `skip`, or the loop was late by one period or more. */
export interface RoundSkip {
  readonly kind: "skip";
  readonly loop: string;
  readonly lane: number;
  /** This time is the planned start of the first round that did not occur. */
  readonly planned: number;
  readonly at: number;
  readonly count: number;
}

/** This record tells that a due round waits for the window of the budget. */
export interface RoundDefer {
  readonly kind: "defer";
  readonly loop: string;
  readonly lane: number;
  readonly planned: number;
  readonly at: number;
  /** This time is the end of the wait: then the lane examines the budget again. */
  readonly until: number;
}

/** A loop gives these records in the order of their events. */
export type LoopRecord = RoundStart | RoundEnd | RoundSkip | RoundDefer;

/** A round gets this context. */
export interface RoundContext {
  /** This scope of the kind `round` has the deadline of the timeout. It closes when the round settles, and at the stop. */
  readonly scope: Scope;
  /** This signal is the signal of the scope. */
  readonly signal: AbortSignal;
  readonly lane: number;
  readonly round: number;
  readonly planned: number;
  /** This count is the number of failures in sequence of the lane before this round. */
  readonly failures: number;
  /**
   * This function is the proof that the lane works: it sets the count of failures in sequence of the lane to zero. Use
   * it at a proof, for example the first useful message of a stream. Do not use it when a connection opens. Else a
   * server that refuses each connection after the handshake gets a new connection with no backoff.
   */
  reset(): void;
}

/** A round gives `"more"` for the next round at once, or nothing for a pass. A throw or a rejection is a failure. */
export type Round = (context: RoundContext) => void | "more" | PromiseLike<void | "more">;

/** These options tell where a loop operates and where its reports go. */
export interface LoopOptions {
  /** This name is in each record and in the instance of each transition: `<name>#<lane>`. */
  readonly name: string;
  /**
   * This scope is the parent of the scope of each round: a `process`, `service` or `phase` scope. An abort of it
   * stops the loop. Without it, the loop makes a root scope of the kind `service` and closes it at the stop.
   */
  readonly scope?: Scope | undefined;
  /** This clock is only for a loop without a scope. A loop with a scope operates on the clock of the scope. */
  readonly clock?: Clock | undefined;
  /** This function gives a number from 0 up to 1, for the jitter and the backoff. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
  /** This function gets each record. An error of it goes to the host as an error that nothing catches, and the loop goes on. */
  readonly record?: ((record: LoopRecord) => void) | undefined;
  /** This function gets each transition of each lane, for `replay` of `@mark1russell7/algebra/replay`. */
  readonly onTransition?: ((transition: Transition) => void) | undefined;
}

/** A loop starts its rounds on the schedule. */
export interface Loop {
  readonly name: string;
  readonly schedule: Schedule;
  /** This method gives the state of each lane. */
  states(): LoopState[];
  /** This method starts each lane. A second start, or a start after the stop, does nothing. */
  start(): void;
  /**
   * This method makes a round due at once on each lane that waits for its period. It does not end a backoff or the wait of
   * a budget. A lane from `end` with a round in flight starts its next round at once after that round. It gives true
   * when it changed a lane, and false before the start and after the stop.
   */
  wake(): boolean;
  /** This method gives the count of rounds whose scope did not close yet. */
  inFlight(): number;
  /** This promise resolves when no round is in flight. */
  settle(): Promise<void>;
  /**
   * This method stops the loop: no round starts after it, and no timer of the schedule stays. It aborts and closes the
   * scope of each round in flight. Its promise rejects with an `AggregateError` of the errors of those closes. A second
   * stop gives the same promise. After the stop, the loop gives no record and no transition.
   */
  stop(): Promise<void>;
}

const ZERO: Quantity = { value: 0, unit: "s" };
const UNBOUNDED: Extent = { value: "infinite", unit: "s" };
const STABLE: Quantity = { value: 30, unit: "s" };

/** This function gives a time in milliseconds: infinity for a time without a bound, and undefined for an amount that is not a time. */
const millisecondsOf = (extent: Extent): number | undefined => {
  if (!convertible(extent.unit, "s")) return undefined;
  return extent.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(extent, "ms");
};

/** This function gives the timing of a schedule: each time in milliseconds, from `time`. */
const timingOf = (schedule: Schedule, time: (field: TimeField, extent: Extent) => number): Timing => ({
  from: schedule.from,
  period: time("period", schedule.period),
  jitter: schedule.jitter,
  first: time("first", schedule.first),
  timeout: time("timeout", schedule.timeout),
  backoff: schedule.backoff,
  overlap: schedule.overlap,
  lanes: schedule.lanes,
  budget: schedule.budget === null ? null : { rounds: schedule.budget.rounds, per: time("window", schedule.budget.per) },
  hold: schedule.hold,
  stable: schedule.stable === null ? null : time("stable", schedule.stable),
});

/** This function gives the problems of a schedule. A loop with a schedule that has problems throws when it is made. */
export const scheduleProblems = (schedule: Schedule): string[] => {
  const notTime: Partial<Record<TimeField, string>> = {};
  const timing = timingOf(schedule, (field, extent) => {
    const ms = millisecondsOf(extent);
    if (ms !== undefined) return ms;
    notTime[field] = extent.unit;
    return Number.NaN;
  });
  return timingProblems(timing, notTime);
};

/**
 * This function gives the schedule of the health poller: from start, the jitter of the poll, no backoff and one lane.
 * A poll that is due while the last poll is in flight fails at once. The first poll is at the start by default.
 */
export const pollSchedule = (poll: Poll, options: { readonly first?: Extent; readonly hold?: boolean } = {}): Schedule => ({
  from: "start",
  period: poll.interval,
  jitter: poll.jitter,
  first: options.first ?? ZERO,
  timeout: poll.timeout,
  backoff: null,
  overlap: "fail",
  lanes: 1,
  budget: null,
  hold: options.hold ?? true,
  stable: null,
});

/**
 * This function gives the schedule of a worker loop: from end, with the sleep of the knobs as the period. The bound of
 * an iteration is the timeout. The backoff doubles from `retry_base` to `retry_cap`. Each unit of `concurrency` is one lane.
 */
export const workerSchedule = (knobs: WorkerKnobs, options: { readonly hold?: boolean } = {}): Schedule => {
  const lanes = countOf(knobs, "concurrency", "workerSchedule");
  if (!Number.isFinite(lanes)) throw new Error("workerSchedule needs a concurrency with a bound: each lane is a loop");
  return {
    from: "end",
    period: knobs.worker_sleep,
    jitter: 0,
    first: ZERO,
    timeout: knobs.unit_processing_time,
    backoff: retryOf(knobs, "workerSchedule"),
    overlap: "skip",
    lanes,
    budget: null,
    hold: options.hold ?? true,
    stable: null,
  };
};

/**
 * This function gives the schedule of a stream, for example a push feed: one round is one long connection. When a
 * connection ends, the next connection opens after the backoff. A connection proves the stream when it stays up for
 * the stable time (30 s by default), or when the round uses `reset()` at its first useful message. A connection with
 * no proof is a failure, thus a feed that drops after each open backs off up to the cap. A budget bounds the opens.
 */
export const streamSchedule = (
  backoff: Backoff,
  options: { readonly stable?: Extent; readonly budget?: Budget | null; readonly hold?: boolean } = {},
): Schedule => ({
  from: "end",
  period: ZERO,
  jitter: 0,
  first: ZERO,
  timeout: UNBOUNDED,
  backoff,
  overlap: "skip",
  lanes: 1,
  budget: options.budget ?? null,
  hold: options.hold ?? true,
  stable: options.stable ?? STABLE,
});

/**
 * This function makes a loop. It throws for a schedule with problems and for a scope of the rank of a round or higher.
 * It also throws for a clock that is not the clock of the scope. The loop starts at `start()`.
 *
 * - Each lane has at most one timer: the first delay, the period, a round at once, the backoff or the window of the budget.
 * - From `start`, the period timer starts with the round, from the planned start. A round past the timeout keeps its lane
 *   `hung`, and the period and the backoff go on.
 * - From `end`, a lane has no timer while its round is in flight. Its next timer starts when the round settles.
 * - Each round gets its scope of the kind `round`. The scope closes when the round settles, and the end record of the
 *   round comes after the close. An error of the close is a failure of the round.
 */
export const loop = (schedule: Schedule, round: Round, options: LoopOptions): Loop => {
  const problems = scheduleProblems(schedule);
  if (problems.length > 0) throw new Error(`the schedule of the loop "${options.name}" has problems: ${problems.join("; ")}`);
  return { ...runLoop(timingOf(schedule, (_, extent) => millisecondsOf(extent)!), round, options), schedule };
};
