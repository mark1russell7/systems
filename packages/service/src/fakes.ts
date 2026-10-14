// The fakes of the runtime for tests: a fake clock gives exact, repeatable timing, a seeded random
// gives the same jitter on each run, and a fake process takes signals and keeps the exit codes.

import type { Cancel, Clock } from "./clock.ts";
import type { ExitSignal, ProcessPort } from "./process.ts";

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

/** A fake process receives signals from a test, and keeps each exit code in place of an exit. */
export interface FakeProcess extends ProcessPort {
  /** This method sends a signal to each handler of it. */
  signal(name: ExitSignal): void;
  /** These are the exit codes, in sequence. A correct runtime exits one time. */
  readonly exits: readonly number[];
  /** This count is the number of handlers that are registered. */
  readonly handlers: number;
}

/** This function makes a fake process. */
export const fakeProcess = (): FakeProcess => {
  const handlers = new Map<ExitSignal, Set<() => void>>();
  const exits: number[] = [];
  return {
    on(signal, handler) {
      const set = handlers.get(signal) ?? new Set();
      set.add(handler);
      handlers.set(signal, set);
      return () => {
        set.delete(handler);
      };
    },
    exit(code) {
      exits.push(code);
    },
    signal(name) {
      for (const handler of [...(handlers.get(name) ?? [])]) handler();
    },
    get exits() {
      return [...exits];
    },
    get handlers() {
      let count = 0;
      for (const set of handlers.values()) count += set.size;
      return count;
    },
  };
};

/** This function gives a seeded random number generator (mulberry32), with numbers in [0, 1). */
export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
