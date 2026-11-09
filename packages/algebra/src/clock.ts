// @mark1russell7/algebra/clock: the clock of a runtime, and a fake clock for tests. It imports
// nothing: no `node:` module, no zod and no other package. Thus a client in a browser can use it.
// The service gives this clock again as @mark1russell7/service/clock.

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

/** A fake clock moves only when a test tells it to. */
export interface FakeClock extends Clock {
  /** This method moves the clock forward by `ms`, and it starts each timer that comes due, in sequence. */
  advance(ms: number): Promise<void>;
  /**
   * This method moves the clock forward by `ms` and starts no timer, as a blocked event loop does.
   * The next `advance` then starts each timer that came due during the block, late.
   */
  block(ms: number): void;
  /** This count is the number of timers that are not stopped and not called. */
  readonly pending: number;
}

/** This function lets the promises that are ready continue, before the clock moves again. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 64; turn += 1) await Promise.resolve();
};

/** This function makes a fake clock. Its time starts at `start` milliseconds. */
export const fakeClock = (start = 0): FakeClock => {
  let now = start;
  let sequence = 0;
  const timers: Array<{ at: number; order: number; run: () => void; live: boolean }> = [];
  const due = (end: number) => {
    let best: (typeof timers)[number] | undefined;
    for (const timer of timers)
      if (timer.live && timer.at <= end && (best === undefined || timer.at < best.at || (timer.at === best.at && timer.order < best.order)))
        best = timer;
    return best;
  };
  return {
    now: () => now,
    after(ms, run): Cancel {
      const timer = { at: now + Math.max(0, ms), order: sequence++, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    async advance(ms) {
      // a monotonic clock does not go back
      const end = now + Math.max(0, ms);
      await settle();
      for (;;) {
        const timer = due(end);
        if (timer === undefined) break;
        timer.live = false;
        // a timer that came due during a block runs late, at the time of the clock
        now = Math.max(now, timer.at);
        timer.run();
        await settle();
      }
      now = Math.max(now, end);
      for (let at = timers.length - 1; at >= 0; at -= 1) if (!timers[at]!.live) timers.splice(at, 1);
      await settle();
    },
    block(ms) {
      now += Math.max(0, ms);
    },
    get pending() {
      return timers.filter((timer) => timer.live).length;
    },
  };
};
