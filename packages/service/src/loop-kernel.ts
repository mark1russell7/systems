// The kernel of the loop core (SYS-138): the lanes, the rounds and the timers of a loop, with each time in
// milliseconds. The entry `/loop` gives it a schedule in amounts of quantity. The heartbeat, the watchdog and the ticker
// operate on it directly. At run time it loads only the clock, the scope and the backoff of this package: no `node:`
// module, no zod and no quantity. Thus the entries `/heartbeat` and `/channel` stay small for a client in a browser.

import type { Transition } from "@mark1russell7/algebra/replay";
import type { Backoff } from "./backoff.ts";
import { backoffDelay, backoffProblems } from "./backoff.ts";
import type { Cancel } from "./clock.ts";
import { realClock } from "./clock.ts";
import type { Loop, LoopEvent, LoopOptions, LoopRecord, LoopState, Round, RoundContext } from "./loop.ts";
import type { Scope } from "./scope.ts";
import { SCOPE_RANK, rootScope } from "./scope.ts";

/** This id is the id of `LOOP_MACHINE`. The kernel names it here, thus it does not load the machine documents. */
export const LOOP_MACHINE_ID = "service.machine.loop";

/** A timing is a schedule with each time in milliseconds on the clock of the loop. A time without a bound is infinity. */
export interface Timing {
  readonly from: "start" | "end";
  readonly period: number;
  readonly jitter: number;
  readonly first: number;
  readonly timeout: number;
  readonly backoff: Backoff | null;
  readonly overlap: "fail" | "skip" | "allow";
  readonly lanes: number;
  /** The budget: at most `rounds` starts in each window of `per` milliseconds. */
  readonly budget: { readonly rounds: number; readonly per: number } | null;
  readonly hold: boolean;
  readonly stable: number | null;
}

/** These are the times of a timing. The window is the `per` of the budget. */
export type TimeField = "period" | "first" | "timeout" | "window" | "stable";

/**
 * This function gives the problems of a timing. `notTime` gives the unit of each field of a schedule that is not a
 * time. The function names that unit, and it does not examine the value.
 */
export const timingProblems = (timing: Timing, notTime: Partial<Record<TimeField, string>> = {}): string[] => {
  const problems: string[] = [];
  const time = (field: TimeField, name: string, ms: number): number | undefined => {
    const unit = notTime[field];
    if (unit === undefined) return ms;
    problems.push(`the ${name} in ${unit} is not a time`);
    return undefined;
  };
  if (timing.from !== "start" && timing.from !== "end") problems.push(`the from ${String(timing.from)} is not start or end`);
  if (timing.overlap !== "fail" && timing.overlap !== "skip" && timing.overlap !== "allow")
    problems.push(`the overlap ${String(timing.overlap)} is not fail, skip or allow`);
  const period = time("period", "period", timing.period);
  if (period !== undefined && !(period >= 0)) problems.push(`the period of ${period} ms is less than zero`);
  if (period === 0 && timing.from === "start") problems.push("a schedule from start needs a period above zero: each next round of a zero period is already late");
  const first = time("first", "first delay", timing.first);
  if (first !== undefined && !(first >= 0)) problems.push(`the first delay of ${first} ms is less than zero`);
  const timeout = time("timeout", "timeout", timing.timeout);
  if (timeout !== undefined && !(timeout > 0)) problems.push(`the timeout of ${timeout} ms is not above zero`);
  if (!(timing.jitter >= 0 && timing.jitter < 1)) problems.push(`the jitter ${timing.jitter} is not a fraction from 0 and below 1`);
  if (!(Number.isInteger(timing.lanes) && timing.lanes >= 1)) problems.push(`the lanes ${timing.lanes} are not a whole number from 1`);
  if (timing.backoff !== null) {
    for (const problem of backoffProblems(timing.backoff)) problems.push(`the backoff: ${problem}`);
    if (timing.from === "start" && timing.overlap === "allow")
      problems.push("a backoff spaces the rounds of a lane, and the overlap allow starts a round at each due time: give one of the two");
  }
  if (timing.budget !== null) {
    const { rounds, per } = timing.budget;
    if (!(Number.isInteger(rounds) && rounds >= 1)) problems.push(`the rounds ${rounds} of the budget are not a whole number from 1`);
    const window = time("window", "window of the budget", per);
    if (window !== undefined && !(window > 0 && Number.isFinite(window))) problems.push("the window of the budget is not a time above zero with a bound");
  }
  if (timing.stable !== null) {
    const stable = time("stable", "stable time", timing.stable);
    if (stable !== undefined && !(stable >= 0)) problems.push(`the stable time of ${stable} ms is less than zero`);
  }
  return problems;
};

/** A late loop skips its rounds one period at a time, up to this count of periods. Past it, one step skips whole periods. */
const STEPS = 64;

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
 * This function makes a loop on a timing. It throws for a timing with problems and for a scope of the rank of a round or
 * higher. It also throws for a clock that is not the clock of the scope. The loop starts at `start()`.
 *
 * - Each lane has at most one timer: the first delay, the period, a round at once, the backoff or the window of the budget.
 * - From `start`, the period timer starts with the round, from the planned start. A round past the timeout keeps its lane
 *   `hung`, and the period and the backoff go on.
 * - From `end`, a lane has no timer while its round is in flight. Its next timer starts when the round settles.
 * - Each round gets its scope of the kind `round`. The scope closes when the round settles, and the end record of the
 *   round comes after the close. An error of the close is a failure of the round.
 */
export const runLoop = (timing: Timing, round: Round, options: LoopOptions): Omit<Loop, "schedule"> => {
  const name = options.name;
  const problems = timingProblems(timing);
  if (problems.length > 0) throw new Error(`the schedule of the loop "${name}" has problems: ${problems.join("; ")}`);
  if (options.scope !== undefined && SCOPE_RANK[options.scope.kind] >= SCOPE_RANK.round)
    throw new Error(`the loop "${name}" needs a process, service or phase scope for its rounds, not a ${options.scope.kind}`);
  if (options.scope !== undefined && options.clock !== undefined && options.clock !== options.scope.clock)
    throw new Error(`the loop "${name}" operates on the clock of its scope: give a clock or a scope, not two clocks`);
  const owned = options.scope === undefined;
  const parent = options.scope ?? rootScope({ name, kind: "service", clock: options.clock ?? realClock });
  const clock = parent.clock;
  const random = options.random ?? Math.random;
  const { period, first, timeout, stable, backoff, budget } = timing;

  let started = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let count = 0;
  /** The starts in the window of the budget: at most `budget.rounds`, the oldest first. */
  const starts: number[] = [];
  /** Each round until its scope closes. */
  const pending = new Set<Flight>();
  let waiters: Array<() => void> = [];
  const lanes: Lane[] = Array.from({ length: timing.lanes }, (_, index) => ({
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
      const transition: Transition = { machine: LOOP_MACHINE_ID, instance: lane.instance, from, on, to, at: clock.now() };
      out.push(() => tell(transition));
    }
    flush();
  };

  const jittered = (): number => (timing.jitter === 0 ? period : period * (1 + timing.jitter * (2 * random() - 1)));

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
    if (!timing.hold) timer.unref?.();
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

  /**
   * From end: the timer of a lane after its round, at the settle. It gives true for a wake during the round. Then the
   * next round starts at once after the settle, with no timer, as a wake of a waiting lane does. A "more" gets a timer
   * of zero, thus the event loop can do other work between the rounds.
   */
  const rest = (lane: Lane, outcome: "pass" | "more" | "fail", now: number): boolean => {
    const woken = lane.woken;
    lane.woken = false;
    if (outcome === "more") arm(lane, "now", 0, now);
    else if (outcome === "fail" && backoff !== null) armBackoff(lane, now);
    else if (woken) return true;
    else {
      const delay = jittered();
      arm(lane, "period", delay, now + delay);
    }
    return false;
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
    if (timing.overlap === "allow") return begin(lane, planned, now);
    if (timing.overlap === "skip") {
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
    if (timing.from === "start") planNext(lane, planned, now, null);
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
      if (timing.from === "start" && backoff !== null) armBackoff(lane, now);
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
    // from end: a wake came during the round, and the next round starts after the settle
    let wakeNow = false;
    try {
      if (stopped) lane.flights.delete(flight);
      else if (flight.late) {
        act(lane, "late-answer", () => {
          lane.flights.delete(flight);
          if (timing.from === "end") wakeNow = rest(lane, "fail", clock.now());
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
          if (timing.from === "end") wakeNow = rest(lane, outcome, now);
          else if (outcome === "more") arm(lane, "now", 0, now);
          else if (outcome === "fail" && backoff !== null) armBackoff(lane, now);
        });
      }
      // a reader of the settle can stop the loop: then no round starts
      if (wakeNow && !stopped) due(lane, "wake", clock.now(), false);
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
        const transition: Transition = { machine: LOOP_MACHINE_ID, instance: lane.instance, from: froms[index]!, on: "stop", to: "stopped", at };
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
        if (timing.from === "end" && lane.flights.size > 0)
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
