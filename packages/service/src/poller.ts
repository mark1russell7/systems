import { valueIn } from "@mark1russell7/quantity";
import type { Cancel, Clock } from "./clock.ts";
import type { Outcome, Result } from "./latch.ts";
import type { Poll } from "./timing.ts";

/**
 * A check function measures one step of a connection. It ends with nothing or `"ok"` for a pass,
 * or with `"error"` or `"indeterminate"`. A throw is an error with a flag. The runtime aborts the
 * signal at the timeout of the poll.
 */
export type CheckFn = (signal: AbortSignal) => Outcome | void | Promise<Outcome | void>;

/** A poller starts one check on its own loop, and gives each result to `record`. */
export interface Poller {
  /** This result is the latest one, or null before the first poll. */
  readonly last: Result | null;
  /** This method polls one time at once, outside the loop, and gives the result. */
  pollNow(): Promise<Result>;
  /** This method starts the loop. The first poll of the loop comes after `delay` milliseconds. */
  start(delay: number): void;
  /** This method gives the next delay of the loop: the interval, with the jitter. */
  jittered(): number;
  stop(): void;
}

export interface PollerOptions {
  readonly name: string;
  readonly poll: Poll;
  readonly run: CheckFn;
  readonly clock: Clock;
  readonly random: () => number;
  /** This function tells if the force-fail list names the check at this time. */
  readonly forced: () => boolean;
  readonly record: (result: Result) => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * This function makes a poller. The loop is on a fixed delay from the start of each poll. Thus the
 * next poll starts one interval after the current poll starts, with the jitter (±20 % is 0.2).
 * The timing algebra of the declaration uses this model.
 *
 * Each poll makes a new measurement. While a use of the check is pending, the poller does not
 * start the check again. Such a poll fails at once with the same cause, and the sequence of
 * failures continues.
 */
export const poller = (options: PollerOptions): Poller => {
  const { clock, poll, run } = options;
  const interval = valueIn(poll.interval, "ms");
  const timeout = valueIn(poll.timeout, "ms");
  let last: Result | null = null;
  let next: Cancel | null = null;
  let stopped = false;
  // the call that has not ended, and when it started
  let pending: { readonly since: number } | null = null;
  // the polls in flight: stop() ends each one, and its timer
  const active = new Set<() => void>();

  const result = (
    outcome: Outcome,
    started: number,
    fields: Partial<Pick<Result, "cause" | "timedOut" | "thrown" | "forced">> = {},
  ): Result => ({
    outcome,
    at: clock.now(),
    took: clock.now() - started,
    cause: fields.cause ?? null,
    timedOut: fields.timedOut ?? false,
    thrown: fields.thrown ?? false,
    forced: fields.forced ?? false,
  });

  const once = (): Promise<Result> => {
    const started = clock.now();
    if (options.forced())
      return Promise.resolve(result("error", started, { cause: "the force-fail list names it", forced: true }));
    if (pending !== null) {
      const cause = `its call of ${Math.round(started - pending.since)} ms ago is still pending`;
      return Promise.resolve(result("error", started, { cause }));
    }
    const controller = new AbortController();
    return new Promise<Result>((resolve) => {
      let done = false;
      const finish = (value: Result): void => {
        if (done) return;
        done = true;
        active.delete(abandon);
        cancel();
        resolve(value);
      };
      const abandon = (): void => {
        controller.abort();
        finish(result("error", started, { cause: "the runtime stopped" }));
      };
      active.add(abandon);
      const cancel = clock.after(timeout, () => {
        controller.abort();
        finish(result("error", started, { cause: `no answer in ${timeout} ms`, timedOut: true }));
      });
      const call = { since: started };
      pending = call;
      const settled = (): void => {
        if (pending === call) pending = null;
      };
      let answer: Promise<Outcome | void>;
      try {
        answer = Promise.resolve(run(controller.signal));
      } catch (error) {
        answer = Promise.reject(error);
      }
      answer.then(
        (value) => {
          settled();
          const outcome = value ?? "ok";
          finish(result(outcome, started, outcome === "ok" ? {} : { cause: `the check gave ${outcome}` }));
        },
        (error: unknown) => {
          settled();
          finish(result("error", started, { cause: message(error), thrown: true }));
        },
      );
    });
  };

  const handle = (value: Result): Result => {
    last = value;
    if (!stopped) options.record(value);
    return value;
  };

  const jittered = (): number => interval * (1 + poll.jitter * (2 * options.random() - 1));

  const tick = (): void => {
    next = null;
    if (stopped) return;
    next = clock.after(jittered(), tick);
    void once().then(handle);
  };

  return {
    get last() {
      return last;
    },
    pollNow: () => once().then(handle),
    start(delay) {
      if (stopped || next !== null) return;
      next = clock.after(Math.max(0, delay), tick);
    },
    jittered,
    stop() {
      stopped = true;
      next?.();
      next = null;
      for (const abandon of [...active]) abandon();
    },
  };
};
