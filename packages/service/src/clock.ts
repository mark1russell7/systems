// @mark1russell7/service/clock: the clock of the runtime, with no other part of the package. It
// imports no `node:` module and no zod. Thus a client in a browser can use it.

/**
 * This function stops a timer that `Clock.after` started. A second use does nothing. A clock of
 * the platform also gives `unref`: after it, the timer does not keep a Node process alive.
 */
export type Cancel = (() => void) & { readonly unref?: (() => void) | undefined };

/**
 * A clock gives the monotonic time in milliseconds, and it starts a function after a delay. The
 * runtime reads time only through a clock. Thus a test can give a fake clock, and the timing of
 * the runtime is then exact and repeatable.
 */
export interface Clock {
  /** This method gives the monotonic time, in milliseconds. A step of the wall clock does not move it. */
  now(): number;
  /** This method starts `run` after `ms` milliseconds, and gives the function that stops it. */
  after(ms: number, run: () => void): Cancel;
}

/** These options make a clock of the platform. */
export interface PlatformClockOptions {
  /** True makes each timer not keep a Node process alive. The default is false, as with `setTimeout`. */
  readonly unref?: boolean | undefined;
}

/** This function gives the monotonic time: `performance.now()`, or `Date.now()` on a platform without `performance`. */
const monotonic = (): number => {
  const performance = (globalThis as { performance?: { now(): number } }).performance;
  return performance === undefined ? Date.now() : performance.now();
};

/** This delay is the longest that `setTimeout` takes, in milliseconds. A longer delay starts the function after 1 ms. */
const LONGEST_DELAY = 0x7fffffff;

/**
 * This function makes a clock of the platform: `performance.now()` and `setTimeout`. Each cancel
 * that it gives also has `unref`. A delay longer than `setTimeout` takes waits in steps.
 */
export const platformClock = (options: PlatformClockOptions = {}): Clock => ({
  now: monotonic,
  after(ms, run) {
    let unrefed = options.unref === true;
    const arm = (left: number): ReturnType<typeof setTimeout> => {
      const step =
        left > LONGEST_DELAY ? setTimeout(() => (timer = arm(left - LONGEST_DELAY)), LONGEST_DELAY) : setTimeout(run, Math.max(0, left));
      if (unrefed) (step as { unref?: () => void }).unref?.();
      return step;
    };
    let timer = arm(ms);
    const unref = (): void => {
      unrefed = true;
      (timer as { unref?: () => void }).unref?.();
    };
    return Object.assign(() => clearTimeout(timer), { unref });
  },
});

/**
 * This clock reads `performance.now()` and uses `setTimeout`. Its timers do not keep a Node
 * process alive, thus a timer that is not stopped cannot stop the exit of the process.
 */
export const realClock: Clock = /* @__PURE__ */ platformClock({ unref: true });
