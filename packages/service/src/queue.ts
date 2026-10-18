import type { Extent, Quantity } from "@mark1russell7/quantity";
import { backoffDelay } from "./backoff.ts";
import type { Clock } from "./clock.ts";
import { realClock } from "./clock.ts";
import type { ServiceDescription } from "./description.ts";
import { boundedMillisecondsOf, countOf, millisecondsOf } from "./knobs.ts";
import type { Lifecycle, TransportImpl } from "./lifecycle.ts";
import type { UnitEnd, UnitRequest } from "./units.ts";
import { boundProblems, flights, retryOf, runUnit, settleWithin, sleeper } from "./units.ts";

/**
 * These are the knobs of a queue drain, by the names of the ordering law where the law has them.
 * The drain has no defaults, thus each knob is necessary. A bound that nobody gives is "infinite".
 */
export interface QueueKnobs {
  /** This time is the wait after a take that gives no job, before the next take. A time without a bound waits for `wake()`. */
  readonly queue_poll_interval: Extent;
  /**
   * This time is the most that one job can take. At it, the drain aborts the signal of the job, and
   * a throw after it is a failure. The law reads it as `unit_processing_time@consumer` (O20).
   */
  readonly unit_processing_time: Extent;
  /** This time is the delay after the first failed take in sequence, or after a refusal of the service. The delay is two times longer after each one. */
  readonly retry_base: Quantity;
  /** This time is the most that one delay can be, before its jitter. */
  readonly retry_cap: Quantity;
  /** This time bounds the close: the end of the jobs after their abort, and then the close of the source. */
  readonly close_bound: Quantity;
  /** This count (the unit `count`) is the most jobs in flight at one time. A count without a bound takes each job that comes. */
  readonly concurrency: Extent;
  /** The other knobs go to the declaration, for example `lease_duration@broker`. The drain does not read them. */
  readonly [knob: string]: Extent;
}

/**
 * A job source gives the jobs of a queue drain:
 * - A function takes the next job, or gives null when no job is ready. Its signal aborts when the intake stops.
 * - An async iterable gives the jobs in sequence. The drain asks for the next job only when it has a free slot.
 *   At the stop of the intake, the drain ends the iterator through `return()`.
 */
export type JobSource<J> = ((signal: AbortSignal) => J | null | undefined | PromiseLike<J | null | undefined>) | AsyncIterable<J>;

/**
 * A job action is what the drain does with a job that failed:
 * - `requeue`: the job goes back on the queue.
 * - `reject`: the job leaves the queue without a success, for example to the dead-letter route of the queue.
 * - `ack`: the job leaves the queue, as a poison message does.
 */
export type JobAction = "requeue" | "reject" | "ack";

/** A job failure is a job whose handler failed, with the count of its deliveries, 1 at the first. */
export interface JobFailure<J> {
  readonly job: J;
  readonly error: unknown;
  readonly delivery: number;
}

/** A redelivery policy gives the action for a job that failed. The queue declares it, and it has no default (S6 A11). */
export type RedeliveryPolicy<J> = (failure: JobFailure<J>) => JobAction;

/**
 * A requeue cause tells why a job goes back on the queue:
 * - `failed`: the redelivery policy sent it back after a failure.
 * - `unstarted`: the drain took the job and did not start it, because its intake stopped or the service refused it.
 * - `cut`: the shutdown cut the job, and its route declares that it can go again.
 */
export type RequeueCause = "failed" | "unstarted" | "cut";

/** A job settle is how the drain tells the queue the end of each job. Each function can give a promise. */
export interface JobSettle<J> {
  /** This function removes the job from the queue: a success, or the action `ack`. */
  ack(job: J): void | PromiseLike<void>;
  /** This function puts the job back on the queue, or hands it back to the queue at the stop. */
  requeue(job: J, cause: RequeueCause): void | PromiseLike<void>;
  /** This function removes the job from the queue without a success: the action `reject`, or a cut job that cannot go again. */
  reject(job: J, error: unknown): void | PromiseLike<void>;
  /**
   * This function gives the count of deliveries of a job from the queue, 1 at the first. Without it,
   * the drain counts the deliveries of each job that it puts back, by the value of the job.
   */
  readonly delivery?: ((job: J) => number) | undefined;
}

/** A job context is what the drain gives the handler of each job. */
export interface JobContext {
  /** This signal aborts at the cooperative abort of the drain, at the bound of the job, and at the close. */
  readonly signal: AbortSignal;
  /** This signal aborts when the intake stops. */
  readonly intake: AbortSignal;
  /** This count is the delivery of the job, 1 at the first. */
  readonly delivery: number;
  /** This lifecycle is the lifecycle that the drain got at its start. */
  readonly life: Lifecycle;
}

/** These options make a queue drain. Each function can give a promise. */
export interface QueueDrainOptions<J> {
  readonly source: JobSource<J>;
  /** This function does one job. A throw is a failure, and the redelivery policy then gives its action. */
  readonly handle: (job: J, context: JobContext) => unknown;
  readonly settle: JobSettle<J>;
  /** This policy gives the action for each failed job. `redeliverOnce` gives the policy of S6 A11. */
  readonly redelivery: RedeliveryPolicy<J>;
  /** This function closes the source at the close, after the jobs end: for example, it closes a channel. */
  readonly close?: (() => void | PromiseLike<void>) | undefined;
  /** This clock is the clock of the lifecycle. The polls, the backoffs and the bounds use it. The default is `realClock`. */
  readonly clock?: Clock | undefined;
  /** This function gives the random numbers of the jitter, from 0 up to 1. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
  /**
   * This route puts each job through `life.request`: the service then admits it, counts it, drains
   * it and can cut it. The idempotency of the route tells if a cut job goes back on the queue.
   */
  readonly request?: UnitRequest<J> | undefined;
  /** This function receives each failure: of a take, of a job, of a settle and of a policy. The job is undefined for a take. */
  readonly onError?: ((error: unknown, job: J | undefined) => void) | undefined;
}

/** A queue drain is a transport of the lifecycle whose work is the jobs of a queue (S6 A11). */
export interface QueueDrain extends TransportImpl {
  /** These knobs go to the declaration of the consumer: `svc.consumer(name, drain.knobs, drain)`. */
  readonly knobs: QueueKnobs;
  /** This method ends the wait of a poll at once, for example when a job comes. It gives false after the intake stops. */
  wake(): boolean;
  /** This method gives the problems of the knobs in a declaration: the close bound and the bound of a job against the caps. */
  problems(description: ServiceDescription): string[];
}

/**
 * This function gives the redelivery policy of S6 A11. A poison message gets `ack`. Each other job
 * goes back on the queue after its first failure, one time. After a later failure, `then` gives the
 * action: the declared policy of the queue.
 */
export const redeliverOnce =
  <J>(then: JobAction | RedeliveryPolicy<J>, poison?: (error: unknown, job: J) => boolean): RedeliveryPolicy<J> =>
  (failure) => {
    if (poison?.(failure.error, failure.job) === true) return "ack";
    if (failure.delivery <= 1) return "requeue";
    return typeof then === "function" ? then(failure) : then;
  };

const OWNER = "queueDrain";
const ACTIONS: readonly string[] = ["requeue", "reject", "ack"];
const STOPPED: unique symbol = Symbol("the intake stopped");

type Taken<J> = { readonly kind: "job"; readonly job: J } | { readonly kind: "none" } | { readonly kind: "end" } | { readonly kind: "error"; readonly error: unknown };

interface Active<J> {
  readonly job: J;
  settled: boolean;
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";

/**
 * This function makes a queue drain as a transport (S6 A11). One taker takes the jobs from the
 * source while a slot is free, and each job operates in its slot.
 * - A success gets `ack`. A failure gets the action of the redelivery policy.
 * - `stopIntake` takes no new job, and a job that the drain took and did not start goes back (`requeue`, `unstarted`).
 * - `drain` waits for each job in flight until the deadline, and gives it the cooperative abort.
 * - `close` aborts each job, waits for its end, and closes the source, all in `close_bound`. A job
 *   that does not end in the bound gets `reject`.
 */
export const queueDrain = <J>(knobs: QueueKnobs, options: QueueDrainOptions<J>): QueueDrain => {
  const poll = millisecondsOf(knobs, "queue_poll_interval", OWNER);
  const bound = millisecondsOf(knobs, "unit_processing_time", OWNER);
  const backoff = retryOf(knobs, OWNER);
  const closeBound = boundedMillisecondsOf(knobs, "close_bound", OWNER);
  const concurrency = countOf(knobs, "concurrency", OWNER);
  const { settle } = options;
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  const running = flights(clock);
  const rests = sleeper(clock);
  const intake = new AbortController();
  const stopped = new Promise<typeof STOPPED>((resolve) =>
    intake.signal.addEventListener("abort", () => resolve(STOPPED), { once: true }),
  );
  // each job until its settle ends, and each job that goes back: the close waits for them
  const pending = new Set<Promise<unknown>>();
  const active = new Set<Active<J>>();
  // the deliveries of each job that went back, when the queue does not count them
  const deliveries = new Map<J, number>();
  let refusals = 0;
  let pausedUntil = Number.NEGATIVE_INFINITY;
  let cancelSource: () => void = () => {};
  let started = false;
  let closing: Promise<void> | null = null;

  const report = (error: unknown, job: J | undefined): void => {
    try {
      options.onError?.(error, job);
    } catch {
      // an error of the hook does not stop the drain
    }
  };
  const keep = (work: Promise<unknown>): void => {
    pending.add(work);
    const forget = (): void => {
      pending.delete(work);
    };
    work.then(forget, forget);
  };
  const remember = (job: J, delivery: number): void => {
    if (settle.delivery === undefined) deliveries.set(job, delivery);
  };
  const forget = (job: J): void => {
    deliveries.delete(job);
  };
  /** This function tells the queue the end of a job, one time. A throw of the queue is a failure. */
  const once = async (unit: Active<J>, tell: () => void | PromiseLike<void>): Promise<void> => {
    if (unit.settled) return;
    unit.settled = true;
    try {
      await tell();
    } catch (error) {
      report(error, unit.job);
    }
  };
  const handBack = (job: J): void =>
    keep(
      (async () => {
        try {
          await settle.requeue(job, "unstarted");
        } catch (error) {
          report(error, job);
        }
      })(),
    );

  /** This function gives the action of the policy for a failed job. A policy that throws, or that gives no action, rejects the job. */
  const actionOf = (job: J, error: unknown, delivery: number): JobAction => {
    try {
      const action = options.redelivery({ job, error, delivery });
      if (ACTIONS.includes(action)) return action;
      report(new Error(`the redelivery policy gave ${String(action)}, not requeue, reject or ack`), job);
    } catch (thrown) {
      report(thrown, job);
    }
    return "reject";
  };

  const settleEnd = (unit: Active<J>, end: UnitEnd, delivery: number): Promise<void> => {
    const { job } = unit;
    if (end.kind === "done") {
      forget(job);
      return once(unit, () => settle.ack(job));
    }
    if (end.kind === "refused") {
      report(new Error(`the service refused the job: ${end.cause}`), job);
      return once(unit, () => settle.requeue(job, "unstarted"));
    }
    if (end.kind === "cut") {
      // a cut is not a failure. Only a route that can go again puts the job back (S6 A12)
      if (end.retryable) {
        remember(job, delivery);
        return once(unit, () => settle.requeue(job, "cut"));
      }
      forget(job);
      const cut = new Error(end.cause);
      return once(unit, () => settle.reject(job, cut));
    }
    const { error } = end;
    report(error, job);
    const action = actionOf(job, error, delivery);
    if (action === "requeue") {
      remember(job, delivery);
      return once(unit, () => settle.requeue(job, "failed"));
    }
    forget(job);
    return once(unit, () => (action === "ack" ? settle.ack(job) : settle.reject(job, error)));
  };

  /** This function starts one job in a slot. The slot stays in flight until the queue has the end of the job. */
  const runJob = (job: J, life: Lifecycle): void => {
    const unit: Active<J> = { job, settled: false };
    active.add(unit);
    const abort = new AbortController();
    const remove = running.add(abort);
    const delivery = settle.delivery?.(job) ?? (deliveries.get(job) ?? 0) + 1;
    keep(
      (async () => {
        const end = await runUnit({
          clock,
          bound,
          abort,
          life,
          request: options.request,
          unit: job,
          work: (signal) => options.handle(job, { signal, intake: intake.signal, delivery, life }),
        });
        // a refusal of the service stops the takes for a backoff, thus a controller that is not ready does not get each job
        if (end.kind === "refused") {
          refusals += 1;
          pausedUntil = clock.now() + backoffDelay(backoff, refusals, random);
        } else refusals = 0;
        await settleEnd(unit, end, delivery);
      })().finally(() => {
        active.delete(unit);
        remove();
      }),
    );
  };

  /** This function gives the take of the source. */
  const takeOf = (): (() => Promise<Taken<J>>) => {
    const source = options.source;
    if (isAsyncIterable(source)) {
      const iterator = (source as AsyncIterable<J>)[Symbol.asyncIterator]();
      cancelSource = () => {
        try {
          void Promise.resolve(iterator.return?.()).catch(() => {});
        } catch {
          // an iterator whose return() throws has ended
        }
      };
      return async () => {
        const step = await iterator.next();
        return step.done === true ? { kind: "end" } : { kind: "job", job: step.value };
      };
    }
    const pull = source as (signal: AbortSignal) => J | null | undefined | PromiseLike<J | null | undefined>;
    return () =>
      new Promise<J | null | undefined>((resolve) => resolve(pull(intake.signal))).then(
        (job): Taken<J> => (job === null || job === undefined ? { kind: "none" } : { kind: "job", job }),
      );
  };

  /** This function is the taker: it takes a job while a slot is free, until the intake stops or the source ends. */
  const taker = async (life: Lifecycle): Promise<void> => {
    const take = takeOf();
    let failures = 0;
    for (;;) {
      if (intake.signal.aborted) return;
      if (running.size >= concurrency) {
        await running.less();
        continue;
      }
      const pause = pausedUntil - clock.now();
      if (pause > 0) {
        await rests.backoff(pause);
        continue;
      }
      const since = rests.wakes;
      const taking = take().catch((error: unknown): Taken<J> => ({ kind: "error", error }));
      const first = await Promise.race([taking, stopped]);
      if (first === STOPPED || intake.signal.aborted) {
        // a take that ends after the stop gives a job that the drain does not start: it goes back
        if (first === STOPPED)
          void taking.then((late) => {
            if (late.kind === "job") handBack(late.job);
          });
        else if (first.kind === "job") handBack(first.job);
        return;
      }
      if (first.kind === "error") {
        failures += 1;
        report(first.error, undefined);
        await rests.backoff(backoffDelay(backoff, failures, random));
        continue;
      }
      failures = 0;
      if (first.kind === "end") return;
      if (first.kind === "none") {
        await rests.sleep(poll, since);
        continue;
      }
      runJob(first.job, life);
    }
  };

  const stopTaking = (cause: string): void => {
    if (intake.signal.aborted) return;
    intake.abort(new Error(cause));
    rests.stop();
    running.release();
    cancelSource();
  };

  return {
    knobs: { ...knobs },
    start(_signal, life) {
      if (closing !== null) throw new Error(`${OWNER}: a closed drain does not start again`);
      if (started) throw new Error(`${OWNER}: the drain started already`);
      started = true;
      // the first take waits for the end of the startup, because a request before it gets a refusal
      void life.started.then(() => {
        if (intake.signal.aborted || life.state !== "running") return;
        // the taker catches each failure of the source: a rejection here is a defect, and it does not end the process (A5)
        taker(life).catch((error: unknown) => report(error, undefined));
      });
    },
    stopIntake() {
      stopTaking(`${OWNER} stopped its intake`);
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
      stopTaking(`${OWNER} closed`);
      running.abort(new Error(`${OWNER} closed`));
      running.clear();
      closing = (async () => {
        const began = clock.now();
        const ended = await settleWithin(clock, closeBound, Promise.allSettled([...pending]));
        if (ended.kind === "bound")
          for (const unit of [...active])
            void once(unit, () => settle.reject(unit.job, new Error(`${OWNER} closed with the job in flight`)));
        const shut = options.close;
        const down = await settleWithin(
          clock,
          Math.max(0, closeBound - (clock.now() - began)),
          shut === undefined ? Promise.resolve() : (async () => shut())(),
        );
        if (ended.kind === "bound") throw new Error(`${OWNER}: a job did not end in the close_bound of ${closeBound} ms after its abort`);
        if (down.kind === "failed") throw down.error;
        if (down.kind === "bound") throw new Error(`${OWNER}: the close of the source did not end in the close_bound of ${closeBound} ms`);
      })();
      return closing;
    },
    problems(description) {
      return boundProblems(OWNER, closeBound, bound, description);
    },
  };
};
