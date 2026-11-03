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

/** These options make one call with retries: the most tries, the errors to retry, and the policy of a retrier. */
export interface RetryOptions extends RetrierOptions {
  /** This number is the most tries of the call, the first try included. It is 1 or more. */
  readonly tries: number;
  /** This function tells if a try starts again after this error. The default retries each error. */
  readonly retryable?: ((error: unknown) => boolean) | undefined;
  /**
   * This function gives the delay in milliseconds before the next try, in place of the backoff. An example
   * is the `Retry-After` header of an HTTP 429. Null or undefined keeps the backoff delay.
   */
  readonly delayOf?: ((error: unknown, attempt: number) => number | null | undefined) | undefined;
}

/**
 * This function gives the wait of a `Retry-After` header (RFC 9110) in milliseconds: a count of seconds,
 * or an HTTP date after `now`. It gives null for a header with no valid value. A date before `now` gives 0.
 */
export const retryAfterDelay = (header: string | null | undefined, now: number): number | null => {
  const text = header?.trim() ?? "";
  if (text === "") return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // An HTTP date has the name of its day and month. Without a letter, Date.parse reads "-3" as a year.
  const at = /[A-Za-z]/.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isNaN(at) ? null : Math.max(0, at - now);
};

/**
 * This function starts `run`, and starts it again after an error, to the count of `tries`. The delay
 * before try n + 1 is `delayOf(error, n)`, else the `backoffDelay` of try n, on the clock. The call gives
 * the value of the first try that succeeds. After the last try, an error that is not retryable, or the
 * abort of the signal, it throws the last error. It refuses a policy with a problem of `backoffProblems`.
 */
export const retry = async <T>(run: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> => {
  const { tries, retryable = () => true, delayOf, clock = realClock, random = Math.random, signal, ...backoff } = options;
  if (!Number.isInteger(tries) || tries < 1) throw new Error(`retry needs a whole number of tries of 1 or more, not ${tries}`);
  const problems = backoffProblems(backoff);
  if (problems.length > 0) throw new Error(`the retry has a bad backoff: ${problems.join("; ")}`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt >= tries || signal?.aborted === true || !retryable(error)) throw error;
      const own = delayOf?.(error, attempt);
      const delay = Math.max(0, Math.round(own ?? backoffDelay(backoff, attempt, random)));
      await new Promise<void>((resume, stop) => {
        const abort = (): void => {
          cancel();
          stop(error);
        };
        const cancel = clock.after(delay, () => {
          signal?.removeEventListener("abort", abort);
          resume();
        });
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
};
