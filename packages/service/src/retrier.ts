import type { Backoff } from "./backoff.ts";
import { backoffDelay, backoffProblems } from "./backoff.ts";
import type { Cancel, Clock } from "./clock.ts";
import { realClock } from "./clock.ts";

/** These options make a retrier: a backoff policy, the clock of its timers, and the signal that cancels it. */
export interface RetrierOptions extends Backoff {
  /** This clock starts each retry. The default is the real clock. A test gives a fake clock. */
  readonly clock?: Clock | undefined;
  /** This function gives a number in [0, 1) for the jitter of each delay. The default is `Math.random`. */
  readonly random?: (() => number) | undefined;
  /**
   * This signal cancels the retrier when it aborts, for example the `signal` of the lifecycle, which
   * aborts in the drain. After the abort, `schedule` starts nothing.
   */
  readonly signal?: AbortSignal | undefined;
}

/** A retrier starts a function again after the backoff of each try, on its clock. */
export interface Retrier {
  /** This count is the number of tries since the last reset. */
  readonly attempts: number;
  /** This flag tells if a retry waits for its timer. */
  readonly pending: boolean;
  /**
   * This method counts one more try, and starts `run` after the backoff delay of that try. It gives
   * the delay in milliseconds. A retry that waits stops, thus one retry at most waits. After the
   * abort of the signal, it starts nothing and gives null. The function catches its own errors.
   */
  schedule(run: () => void): number | null;
  /** This method sets the count of tries to 0, for example after a start that succeeded. A retry that waits stays. */
  reset(): void;
  /** This method stops the retry that waits. The count of tries stays. */
  cancel(): void;
}

/** This function makes a retrier with no check of its policy. A client of the package uses it with its own knobs. */
export const retrierOn = (clock: Clock, backoff: Backoff, random: () => number, signal?: AbortSignal): Retrier => {
  let tries = 0;
  let timer: Cancel | null = null;
  const cancel = (): void => {
    timer?.();
    timer = null;
  };
  signal?.addEventListener("abort", cancel, { once: true });
  return {
    get attempts() {
      return tries;
    },
    get pending() {
      return timer !== null;
    },
    schedule(run) {
      if (signal?.aborted === true) return null;
      tries += 1;
      const delay = Math.round(backoffDelay(backoff, tries, random));
      timer?.();
      timer = clock.after(delay, () => {
        timer = null;
        run();
      });
      return delay;
    },
    cancel,
    reset() {
      tries = 0;
    },
  };
};

/**
 * This function makes a retrier over `backoffDelay`. The first try waits `base`, and each try after
 * it waits `factor` times more, to the `cap`, with the jitter of the policy. It refuses a policy
 * with a problem of `backoffProblems`.
 */
export const retrier = (options: RetrierOptions): Retrier => {
  const { clock = realClock, random = Math.random, signal, ...backoff } = options;
  const problems = backoffProblems(backoff);
  if (problems.length > 0) throw new Error(`the retrier has a bad backoff: ${problems.join("; ")}`);
  return retrierOn(clock, backoff, random, signal);
};
