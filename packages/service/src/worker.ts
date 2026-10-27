import type { Extent, Quantity } from "@mark1russell7/quantity";
import { backoffDelay } from "./backoff.ts";
import type { Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import type { ServiceDescription } from "./description.ts";
import { boundedMillisecondsOf, countOf, millisecondsOf } from "./knobs.ts";
import type { Lifecycle, TransportImpl } from "./lifecycle.ts";
import type { UnitRequest } from "./units.ts";
import { boundProblems, flights, retryOf, runUnit, settleWithin, sleeper } from "./units.ts";

/**
 * These are the knobs of a worker loop, by the names of the ordering law where the law has them.
 * The loop has no defaults, thus each knob is necessary. A bound that nobody gives is "infinite".
 */
export interface WorkerKnobs {
  /**
   * This time is the sleep of a lane, from the end of one iteration to the start of the next. A
   * time without a bound starts the next iteration only at `wake()`.
   */
  readonly worker_sleep: Extent;
  /**
   * This time is the most that one iteration can take. At it, the loop aborts the signal of the
   * iteration, and a throw after it is a failure. The law reads it as `unit_processing_time@consumer` (O20).
   */
  readonly unit_processing_time: Extent;
  /** This time is the delay after the first failure in sequence. The delay is two times longer after each failure, with a jitter up to this time. */
  readonly retry_base: Quantity;
  /** This time is the most that one delay can be, before its jitter. */
  readonly retry_cap: Quantity;
  /** This time bounds the close: the end of the iterations after their abort, and then the teardown. */
  readonly close_bound: Quantity;
  /** This count (the unit `count`) is the number of lanes. Each lane does its iterations one at a time. */
  readonly concurrency: Quantity;
  /** The other knobs go to the declaration, for example `lease_duration@broker`. The loop does not read them. */
  readonly [knob: string]: Extent;
}

/** An iteration context is what the loop gives each iteration. */
export interface IterationContext<S> {
  /** This signal aborts at the cooperative abort of the drain, at the bound of the iteration, and at the close. */
  readonly signal: AbortSignal;
  /** This signal aborts when the intake stops. A long iteration can end at it in its own way. */
  readonly intake: AbortSignal;
  /** This value is the state that the setup gave, or undefined without a setup. */
  readonly state: S;
  /** This number is the lane of the iteration, from 0. */
  readonly lane: number;
  /** This count is the number of failures in sequence of the lane before this iteration. */
  readonly failures: number;
  /** This lifecycle is the lifecycle that the loop got at its start. */
  readonly life: Lifecycle;
}

/** These options make a worker loop. Each function can give a promise. */
export interface WorkerLoopOptions<S> {
  /** This function makes the state of the loop at its start, for example a connection. Its signal is the signal of the service. */
  readonly setup?: ((signal: AbortSignal) => S | PromiseLike<S>) | undefined;
  /**
   * This function does one iteration. When it gives `"more"`, the next iteration of its lane starts
   * after a zero sleep on the clock. A throw is a failure, and the lane then waits its backoff.
   */
  readonly iteration: (context: IterationContext<S>) => unknown;
  /** This function releases the state at the close. It occurs each time that the setup started, with undefined after a failed setup. */
  readonly teardown?: ((state: S | undefined) => void | PromiseLike<void>) | undefined;
  /** This clock is the clock of the lifecycle. The sleeps, the backoffs and the bounds use it. The default is `realClock`. */
  readonly clock?: Clock | undefined;
  /** This function gives the random numbers of the jitter, from 0 up to 1. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
  /**
   * This route puts each iteration through `life.request`: the service then admits it, counts it,
   * drains it and can cut it. The unit of a route function is the number of the lane.
   */
  readonly request?: UnitRequest<number> | undefined;
  /** This function receives each failure, with the count of failures in sequence of its lane. A refusal of the service is a failure too. */
  readonly onError?: ((error: unknown, failures: number) => void) | undefined;
}

/** A worker loop is a transport of the lifecycle whose work is a loop of iterations (S6 A10). */
export interface WorkerLoop extends TransportImpl {
  /** These knobs go to the declaration of the worker: `svc.worker(name, loop.knobs, loop)`. */
  readonly knobs: WorkerKnobs;
  /**
   * This method ends the sleep of each lane at once, for example when new work is ready. It does
   * not end a backoff. It gives false after the intake stops.
   */
  wake(): boolean;
  /** This method gives the problems of a declaration: each phase that the loop needs and that it does not give. `lint()` compares the bounds with the caps. */
  problems(description: ServiceDescription): string[];
}

const OWNER = "workerLoop";

/**
 * This function makes a worker loop as a transport (S6 A10). It has a setup, an iteration and a
 * teardown, and each lane does its iterations one at a time.
 * - The start does the setup. A failed setup gets its teardown, and the start throws.
 * - The first iteration of each lane comes after the startup ends. Each sleep and each backoff is on the clock.
 * - `stopIntake` starts no new iteration, and it ends each sleep and each backoff.
 * - `drain` waits for each iteration in flight until the deadline, and gives it the cooperative
 *   abort. A throw after that abort is not a failure.
 * - `close` aborts each iteration, waits for its end, and does the teardown, all in `close_bound`.
 */
export const workerLoop = <S = undefined>(knobs: WorkerKnobs, options: WorkerLoopOptions<S>): WorkerLoop => {
  const sleep = millisecondsOf(knobs, "worker_sleep", OWNER);
  const bound = millisecondsOf(knobs, "unit_processing_time", OWNER);
  const backoff = retryOf(knobs, OWNER);
  const closeBound = boundedMillisecondsOf(knobs, "close_bound", OWNER);
  const lanes = countOf(knobs, "concurrency", OWNER);
  if (!Number.isFinite(lanes)) throw new Error(`${OWNER} needs a concurrency with a bound: each lane is a loop`);
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  const running = flights(clock);
  const rests = sleeper(clock);
  const intake = new AbortController();
  // the work of each iteration until it ends, also after a cut: the teardown waits for it
  const pending = new Set<Promise<unknown>>();
  let started = false;
  let setup: Promise<S | undefined> | null = null;
  let state: S | undefined;
  let tornDown: Promise<void> | null = null;
  let closing: Promise<void> | null = null;

  const report = (error: unknown, failures: number): void => {
    try {
      options.onError?.(error, failures);
    } catch {
      // an error of the hook does not stop the loop
    }
  };
  /** This function does the teardown one time, after the setup ends, and only when the setup started. */
  const teardown = (): Promise<void> => {
    if (tornDown !== null) return tornDown;
    const release = options.teardown;
    const made = setup;
    tornDown =
      made === null || release === undefined
        ? Promise.resolve()
        : made.then(
            (given) => release(given),
            () => release(undefined),
          );
    return tornDown;
  };
  const keep = (work: Promise<unknown>): Promise<unknown> => {
    pending.add(work);
    const forget = (): void => {
      pending.delete(work);
    };
    work.then(forget, forget);
    return work;
  };

  /** This function is one lane: an iteration, then its sleep or its backoff, until the intake stops. */
  const lane = async (index: number, life: Lifecycle): Promise<void> => {
    let failures = 0;
    let since = rests.wakes;
    // the first iteration comes after a zero sleep on the clock: a wake starts it at once
    await rests.sleep(0, since);
    for (;;) {
      if (intake.signal.aborted) return;
      since = rests.wakes;
      const abort = new AbortController();
      const remove = running.add(abort);
      const count = failures;
      const end = await runUnit({
        clock,
        bound,
        abort,
        life,
        request: options.request,
        unit: index,
        work: (signal) =>
          keep(
            (async () =>
              options.iteration({ signal, intake: intake.signal, state: state as S, lane: index, failures: count, life }))(),
          ),
      });
      remove();
      // the shutdown cut the iteration: that is not a failure, and the lane ends (A10)
      if (end.kind === "cut") return;
      if (end.kind === "done") {
        failures = 0;
        await rests.sleep(end.value === "more" ? 0 : sleep, end.value === "more" ? rests.wakes : since);
        continue;
      }
      failures += 1;
      report(end.kind === "failed" ? end.error : new Error(`the service refused the iteration: ${end.cause}`), failures);
      await rests.backoff(backoffDelay(backoff, failures, random));
    }
  };

  return {
    knobs: { ...knobs },
    async start(signal, life) {
      if (closing !== null) throw new Error(`${OWNER}: a closed loop does not start again`);
      if (started) throw new Error(`${OWNER}: the loop started already`);
      started = true;
      const make = options.setup;
      // without a setup function, the setup is empty, and the teardown still occurs at the close
      setup = make === undefined ? Promise.resolve(undefined) : new Promise<S>((resolve) => resolve(make(signal)));
      try {
        await setup.then((given) => {
          state = given;
        });
      } catch (error) {
        // the lifecycle does not close a part that did not start, thus the teardown occurs here (A10)
        await settleWithin(clock, closeBound, teardown());
        throw error;
      }
      // the first iterations wait for the end of the startup, because a request before it gets a refusal
      void life.started.then(() => {
        if (intake.signal.aborted || life.state !== "running") return;
        // a lane catches each failure of its work: a rejection here is a defect, and it does not end the process (A5)
        for (let index = 0; index < lanes; index += 1) lane(index, life).catch((error: unknown) => report(error, 0));
      });
    },
    stopIntake() {
      if (intake.signal.aborted) return;
      intake.abort(new Error(`${OWNER} stopped its intake`));
      rests.stop();
    },
    drain(deadline, signal) {
      return running.drain(deadline, signal);
    },
    inFlight: () => running.size,
    wake() {
      if (intake.signal.aborted) return false;
      rests.wake();
      return true;
    },
    close() {
      if (closing !== null) return closing;
      if (!intake.signal.aborted) intake.abort(new Error(`${OWNER} closed`));
      rests.stop();
      running.abort(new Error(`${OWNER} closed`));
      running.clear();
      closing = (async () => {
        const began = clock.now();
        const ended = await settleWithin(clock, closeBound, Promise.allSettled([...pending]));
        // the teardown occurs also after an iteration that did not end, because the setup started (A10)
        const down = await settleWithin(clock, Math.max(0, closeBound - (clock.now() - began)), teardown());
        if (ended.kind === "bound")
          throw new Error(`${OWNER}: an iteration did not end in the close_bound of ${closeBound} ms after its abort`);
        if (down.kind === "failed") throw down.error;
        if (down.kind === "bound") throw new Error(`${OWNER}: the teardown did not end in the close_bound of ${closeBound} ms`);
      })();
      return closing;
    },
    problems(description) {
      return boundProblems(OWNER, description);
    },
  };
};
