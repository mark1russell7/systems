// @mark1russell7/service/loop: one loop core (SYS-138). A schedule is data, and the poller, the worker loop and a
// stream are three settings of it. Each lane of a loop is an instance of `LOOP_MACHINE`, and each round has a scope of
// the kind `round`. The entry imports no node: module and no zod. Thus a client in a browser can use it.

import type { Transition } from "@mark1russell7/algebra/replay";
import type { Extent, Quantity } from "@mark1russell7/quantity";
import { convertible, valueIn } from "@mark1russell7/quantity";
import type { Backoff } from "./backoff.ts";
import { backoffDelay, backoffProblems } from "./backoff.ts";
import type { Cancel, Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import { countOf } from "./knobs.ts";
import { LOOP_MACHINE } from "./machines.ts";
import type { Scope } from "./scope.ts";
import { SCOPE_RANK, rootScope } from "./scope.ts";
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

/** A late loop skips its rounds one period at a time, up to this count of periods. Past it, one step skips whole periods. */
const STEPS = 64;

/** This function gives a time in milliseconds: infinity for a time without a bound, and undefined for an amount that is not a time. */
const millisecondsOf = (extent: Extent): number | undefined => {
  if (!convertible(extent.unit, "s")) return undefined;
  return extent.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(extent, "ms");
};

/** This function gives the problems of a schedule. A loop with a schedule that has problems throws when it is made. */
export const scheduleProblems = (schedule: Schedule): string[] => {
  const problems: string[] = [];
  const time = (name: string, extent: Extent): number | undefined => {
    const ms = millisecondsOf(extent);
    if (ms === undefined) problems.push(`the ${name} in ${extent.unit} is not a time`);
    return ms;
  };
  if (schedule.from !== "start" && schedule.from !== "end") problems.push(`the from ${String(schedule.from)} is not start or end`);
  if (schedule.overlap !== "fail" && schedule.overlap !== "skip" && schedule.overlap !== "allow")
    problems.push(`the overlap ${String(schedule.overlap)} is not fail, skip or allow`);
  const period = time("period", schedule.period);
  if (period !== undefined && !(period >= 0)) problems.push(`the period of ${period} ms is less than zero`);
  if (period === 0 && schedule.from === "start") problems.push("a schedule from start needs a period above zero: each next round of a zero period is already late");
  const first = time("first delay", schedule.first);
  if (first !== undefined && !(first >= 0)) problems.push(`the first delay of ${first} ms is less than zero`);
  const timeout = time("timeout", schedule.timeout);
  if (timeout !== undefined && !(timeout > 0)) problems.push(`the timeout of ${timeout} ms is not above zero`);
  if (!(schedule.jitter >= 0 && schedule.jitter < 1)) problems.push(`the jitter ${schedule.jitter} is not a fraction from 0 and below 1`);
  if (!(Number.isInteger(schedule.lanes) && schedule.lanes >= 1)) problems.push(`the lanes ${schedule.lanes} are not a whole number from 1`);
  if (schedule.backoff !== null) {
    for (const problem of backoffProblems(schedule.backoff)) problems.push(`the backoff: ${problem}`);
    if (schedule.from === "start" && schedule.overlap === "allow")
      problems.push("a backoff spaces the rounds of a lane, and the overlap allow starts a round at each due time: give one of the two");
  }
  if (schedule.budget !== null) {
    const { rounds, per } = schedule.budget;
    if (!(Number.isInteger(rounds) && rounds >= 1)) problems.push(`the rounds ${rounds} of the budget are not a whole number from 1`);
    const window = time("window of the budget", per);
    if (window !== undefined && !(window > 0 && Number.isFinite(window))) problems.push("the window of the budget is not a time above zero with a bound");
  }
  if (schedule.stable !== null) {
    const stable = time("stable time", schedule.stable);
    if (stable !== undefined && !(stable >= 0)) problems.push(`the stable time of ${stable} ms is less than zero`);
  }
  return problems;
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

/** A round in flight, from its start until its scope closes. */
interface Flight {
  readonly round: number;
  readonly planned: number;
  readonly start: number;
  readonly scope: Scope;
  /** `true` after the timeout of the round. */
  late: boolean;
  /** `true` after the round settles. */
  done: boolean;
  /** `true` after the round used `reset()`. */
  proved: boolean;
}

/** The next timer of a lane. A lane has at most one. */
interface Next {
  readonly kind: "first" | "period" | "now" | "backoff" | "window";
  cancel: Cancel | undefined;
}

interface Lane {
  readonly index: number;
  readonly instance: string;
  readonly flights: Set<Flight>;
  started: boolean;
  next: Next | null;
  failures: number;
  /** From end: a wake came while the round was in flight. */
  woken: boolean;
}

const isTimeout = (reason: unknown): boolean =>
  typeof reason === "object" && reason !== null && (reason as { readonly name?: unknown }).name === "TimeoutError";

/** This function gives the error of a round that passed with no proof that its lane works. */
const unproved = (duration: number, stable: number): Error => {
  const error = new Error(`The round ended after ${duration} ms with no proof: no reset() and less than the stable time of ${stable} ms.`);
  error.name = "UnprovedRoundError";
  return error;
};

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
  const name = options.name;
  const problems = scheduleProblems(schedule);
  if (problems.length > 0) throw new Error(`the schedule of the loop "${name}" has problems: ${problems.join("; ")}`);
  if (options.scope !== undefined && SCOPE_RANK[options.scope.kind] >= SCOPE_RANK.round)
    throw new Error(`the loop "${name}" needs a process, service or phase scope for its rounds, not a ${options.scope.kind}`);
  if (options.scope !== undefined && options.clock !== undefined && options.clock !== options.scope.clock)
    throw new Error(`the loop "${name}" operates on the clock of its scope: give a clock or a scope, not two clocks`);
  const owned = options.scope === undefined;
  const parent = options.scope ?? rootScope({ name, kind: "service", clock: options.clock ?? realClock });
  const clock = parent.clock;
  const random = options.random ?? Math.random;
  const machine = LOOP_MACHINE.id;
  const period = millisecondsOf(schedule.period)!;
  const first = millisecondsOf(schedule.first)!;
  const timeout = millisecondsOf(schedule.timeout)!;
  const stable = schedule.stable === null ? null : millisecondsOf(schedule.stable)!;
  const backoff = schedule.backoff;
  const budget = schedule.budget === null ? null : { rounds: schedule.budget.rounds, per: millisecondsOf(schedule.budget.per)! };

  let started = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let count = 0;
  /** The starts in the window of the budget: at most `budget.rounds`, the oldest first. */
  const starts: number[] = [];
  /** Each round until its scope closes. */
  const pending = new Set<Flight>();
  let waiters: Array<() => void> = [];
  const lanes: Lane[] = Array.from({ length: schedule.lanes }, (_, index) => ({
    index,
    instance: `${name}#${index}`,
    flights: new Set<Flight>(),
    started: false,
    next: null,
    failures: 0,
    woken: false,
  }));

  // The reports leave in order, after the change of state that they report. A change operates no code of the caller.
  const out: Array<() => void> = [];
  let holding = 0;
  let flushing = false;
  const flush = (): void => {
    if (holding > 0 || flushing) return;
    flushing = true;
    try {
      for (let next = out.shift(); next !== undefined; next = out.shift()) {
        try {
          next();
        } catch (error) {
          // an error of a reader is the reader's: the host gets it, and the state of the loop stays whole
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    } finally {
      flushing = false;
    }
  };
  const report = (record: LoopRecord): void => {
    const write = options.record;
    if (write !== undefined && !stopped) out.push(() => write(record));
  };

  const stateOf = (lane: Lane): LoopState => {
    if (stopped) return "stopped";
    if (!lane.started) return "idle";
    if (lane.flights.size > 0) {
      for (const flight of lane.flights) if (flight.late) return "hung";
      return "calling";
    }
    if (lane.next?.kind === "window") return "deferred";
    if (lane.next?.kind === "backoff") return "backoff";
    return "waiting";
  };

  const act = (lane: Lane, on: LoopEvent, change: () => void): void => {
    const from = stateOf(lane);
    holding += 1;
    try {
      change();
    } finally {
      holding -= 1;
    }
    const to = stateOf(lane);
    const tell = options.onTransition;
    if (tell !== undefined && !stopped) {
      const transition: Transition = { machine, instance: lane.instance, from, on, to, at: clock.now() };
      out.push(() => tell(transition));
    }
    flush();
  };

  const jittered = (): number => (schedule.jitter === 0 ? period : period * (1 + schedule.jitter * (2 * random() - 1)));

  const cancel = (lane: Lane): void => {
    lane.next?.cancel?.();
    lane.next = null;
  };

  const arm = (lane: Lane, kind: Next["kind"], delay: number, planned: number): void => {
    cancel(lane);
    if (!Number.isFinite(delay)) return;
    const next: Next = { kind, cancel: undefined };
    lane.next = next;
    const timer = clock.after(Math.max(0, delay), () => {
      if (lane.next !== next || stopped) return;
      due(lane, kind === "backoff" ? "retry" : kind === "window" ? "window" : "tick", planned, true);
    });
    if (!schedule.hold) timer.unref?.();
    next.cancel = timer;
  };

  const armBackoff = (lane: Lane, now: number): void => {
    const delay = backoffDelay(backoff!, lane.failures, random);
    arm(lane, "backoff", delay, now + delay);
  };

  /** From start: the next planned start after `planned` and after `now`. The planned starts that passed are one skip record. */
  const planNext = (lane: Lane, planned: number, now: number, skipped: { readonly first: number; readonly count: number } | null): void => {
    let next = planned + jittered();
    let firstSkipped = skipped?.first ?? next;
    let skips = skipped?.count ?? 0;
    while (next <= now) {
      if (skips === 0) firstSkipped = next;
      const gap = now - next;
      if (gap > period * STEPS) {
        const whole = Math.floor(gap / period);
        next += whole * period;
        skips += whole;
      } else {
        next += jittered();
        skips += 1;
      }
    }
    if (skips > 0) report({ kind: "skip", loop: name, lane: lane.index, planned: firstSkipped, at: now, count: skips });
    arm(lane, "period", next - now, next);
  };

  /** From end: the timer of a lane after its round, at the settle. */
  const rest = (lane: Lane, outcome: "pass" | "more" | "fail", now: number): void => {
    const woken = lane.woken;
    lane.woken = false;
    if (outcome === "more") arm(lane, "now", 0, now);
    else if (outcome === "fail" && backoff !== null) armBackoff(lane, now);
    else if (woken) arm(lane, "now", 0, now);
    else {
      const delay = jittered();
      arm(lane, "period", delay, now + delay);
    }
  };

  /** A round is due on a lane, from its timer (`fired`) or from a wake. */
  const due = (lane: Lane, on: "tick" | "retry" | "window" | "wake", planned: number, fired: boolean): void =>
    act(lane, on, () => {
      // a timer that fired is done. A wake keeps the timer of a busy lane
      if (fired) lane.next = null;
      const now = clock.now();
      if (lane.flights.size > 0) overlapping(lane, planned, now);
      else {
        cancel(lane);
        begin(lane, planned, now);
      }
    });

  /** From start: a round is due, and its lane has a round in flight. */
  const overlapping = (lane: Lane, planned: number, now: number): void => {
    if (schedule.overlap === "allow") return begin(lane, planned, now);
    if (schedule.overlap === "skip") {
      if (lane.next === null) planNext(lane, planned, now, { first: planned, count: 1 });
      else report({ kind: "skip", loop: name, lane: lane.index, planned, at: now, count: 1 });
      return;
    }
    count += 1;
    lane.failures += 1;
    report({ kind: "end", loop: name, lane: lane.index, round: count, planned, start: now, end: now, outcome: "fail", timedOut: false, blocked: true, error: undefined });
    if (backoff !== null) armBackoff(lane, now);
    else if (lane.next === null) planNext(lane, planned, now, null);
  };

  /** A round is due on a lane: it starts, or it waits for the window of the budget. */
  const begin = (lane: Lane, planned: number, now: number): void => {
    if (budget !== null) {
      if (starts.length >= budget.rounds && now < starts[0]! + budget.per) {
        const until = starts[0]! + budget.per;
        report({ kind: "defer", loop: name, lane: lane.index, planned, at: now, until });
        arm(lane, "window", until - now, planned);
        return;
      }
      starts.push(now);
      if (starts.length > budget.rounds) starts.shift();
    }
    if (schedule.from === "start") planNext(lane, planned, now, null);
    else cancel(lane);
    launch(lane, planned, now);
  };

  const launch = (lane: Lane, planned: number, now: number): void => {
    count += 1;
    const number = count;
    const scope = parent.entry("round", `${lane.instance}.${number}`, {
      timeout: Number.isFinite(timeout) ? timeout : undefined,
      trace: undefined,
      identity: undefined,
    });
    const flight: Flight = { round: number, planned, start: now, scope, late: false, done: false, proved: false };
    lane.flights.add(flight);
    pending.add(flight);
    report({ kind: "start", loop: name, lane: lane.index, round: number, planned, start: now });
    scope.signal.addEventListener("abort", () => expire(lane, flight), { once: true });
    const context: RoundContext = {
      scope,
      signal: scope.signal,
      lane: lane.index,
      round: number,
      planned,
      failures: lane.failures,
      reset: () => {
        if (flight.done || flight.late || stopped) return;
        flight.proved = true;
        lane.failures = 0;
      },
    };
    // the round starts after the change of state: thus a round that stops or wakes the loop sees a whole state
    void Promise.resolve()
      .then(() => round(context))
      .then(
        (value): "pass" | "more" => (value === "more" ? "more" : "pass"),
        (error: unknown) => ({ error }),
      )
      .then((result) => finish(lane, flight, result));
  };

  /** This function gives true if a round has its proof at `now`: with a stable time, a `reset()` or the stable time in flight. */
  const proven = (flight: Flight, now: number): boolean => stable !== null && (flight.proved || now - flight.start >= stable);

  /** The deadline of a round: the round is a failure, and its lane stays `hung` until the round settles. */
  const expire = (lane: Lane, flight: Flight): void => {
    const reason: unknown = flight.scope.signal.reason;
    if (stopped || flight.done || parent.signal.aborted || !isTimeout(reason)) return;
    act(lane, "timeout", () => {
      const now = clock.now();
      flight.late = true;
      lane.failures = (proven(flight, now) ? 0 : lane.failures) + 1;
      report({ kind: "end", loop: name, lane: lane.index, round: flight.round, planned: flight.planned, start: flight.start, end: now, outcome: "fail", timedOut: true, blocked: false, error: reason });
      if (schedule.from === "start" && backoff !== null) armBackoff(lane, now);
    });
  };

  const finish = async (lane: Lane, flight: Flight, result: "pass" | "more" | { readonly error: unknown }): Promise<void> => {
    flight.done = true;
    let closeError: unknown;
    let closeFailed = false;
    try {
      await flight.scope.close();
    } catch (error) {
      closeFailed = true;
      closeError = error;
    }
    try {
      if (stopped) lane.flights.delete(flight);
      else if (flight.late) {
        act(lane, "late-answer", () => {
          lane.flights.delete(flight);
          if (schedule.from === "end") rest(lane, "fail", clock.now());
        });
      } else {
        const now = clock.now();
        const thrown = typeof result === "object";
        let outcome: "pass" | "more" | "fail" = thrown || closeFailed ? "fail" : result;
        let error: unknown = thrown ? result.error : closeError;
        const proof = proven(flight, now);
        if (stable !== null && !proof && outcome !== "fail") {
          outcome = "fail";
          error = unproved(now - flight.start, stable);
        }
        act(lane, outcome === "pass" ? "answer" : outcome, () => {
          lane.flights.delete(flight);
          const before = proof ? 0 : lane.failures;
          lane.failures = outcome === "fail" ? before + 1 : 0;
          report({ kind: "end", loop: name, lane: lane.index, round: flight.round, planned: flight.planned, start: flight.start, end: now, outcome, timedOut: false, blocked: false, error });
          if (schedule.from === "end") rest(lane, outcome, now);
          else if (outcome === "more") arm(lane, "now", 0, now);
          else if (outcome === "fail" && backoff !== null) armBackoff(lane, now);
        });
      }
    } finally {
      pending.delete(flight);
      if (pending.size === 0) {
        const done = waiters;
        waiters = [];
        for (const resolve of done) resolve();
      }
    }
  };

  const onParentAbort = (): void => {
    void stop().catch(() => undefined);
  };

  const stop = (): Promise<void> => {
    if (stopping !== undefined) return stopping;
    const froms = lanes.map(stateOf);
    stopped = true;
    for (const lane of lanes) cancel(lane);
    if (!owned) parent.signal.removeEventListener("abort", onParentAbort);
    const flights = [...pending];
    stopping = (async () => {
      const errors: unknown[] = [];
      const closes = owned ? [parent.close()] : flights.map((flight) => flight.scope.close());
      for (const result of await Promise.allSettled(closes)) if (result.status === "rejected") errors.push(result.reason);
      if (errors.length > 0) throw new AggregateError(errors, `The loop "${name}" closed its rounds with ${errors.length} errors.`);
    })();
    const tell = options.onTransition;
    if (tell !== undefined) {
      const at = clock.now();
      lanes.forEach((lane, index) => {
        const transition: Transition = { machine, instance: lane.instance, from: froms[index]!, on: "stop", to: "stopped", at };
        out.push(() => tell(transition));
      });
    }
    flush();
    return stopping;
  };

  if (!owned) {
    if (parent.signal.aborted) void stop().catch(() => undefined);
    else parent.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    name,
    schedule,
    states: () => lanes.map(stateOf),
    start: () => {
      if (started || stopped) return;
      started = true;
      for (const lane of lanes)
        act(lane, "start", () => {
          lane.started = true;
          arm(lane, "first", first, clock.now() + first);
        });
    },
    wake: () => {
      if (!started || stopped) return false;
      let changed = false;
      for (const lane of lanes) {
        const kind = lane.next?.kind;
        if (kind === "backoff" || kind === "window") continue;
        changed = true;
        if (schedule.from === "end" && lane.flights.size > 0)
          act(lane, "wake", () => {
            lane.woken = true;
          });
        else due(lane, "wake", clock.now(), false);
      }
      return changed;
    },
    inFlight: () => pending.size,
    settle: () => (pending.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
    stop,
  };
};
