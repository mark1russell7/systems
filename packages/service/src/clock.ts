/** This function stops a timer that `Clock.after` started. A second use does nothing. */
export type Cancel = () => void;

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

/**
 * This clock reads `performance.now()` and uses `setTimeout`. Its timers do not keep a Node
 * process alive, thus a timer that is not stopped cannot stop the exit of the process.
 */
export const realClock: Clock = {
  now: () => performance.now(),
  after(ms, run) {
    const timer = setTimeout(run, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  },
};
