// @mark1russell7/service/slices: long synchronous work in short slices. The work is a generator, and
// each `yield` ends one step. `runSlices` does the steps until a slice of time ends, and then it gives
// the event loop a turn. Thus the timers, the sockets and the probes of a server get their turns
// during a long calculation. The entry imports only ./clock.ts: no `node:` module and no zod. Thus a
// client in a browser can use it.

import { realClock, type Clock } from "./clock.ts";

/** The steps of a work. Each `yield` ends one step, and the return value is the result of the work. */
export type Steps<T> = Iterator<unknown, T, undefined>;

/** The default time of one slice, in milliseconds. */
export const SLICE_MS = 8;

/** These options are for `runSlices`. */
export interface SliceOptions {
  /** The time of one slice, in milliseconds, 0 or more. A slice does one step or more. The default is `SLICE_MS`. */
  readonly sliceMs?: number | undefined;
  /** The clock that measures a slice. The default is the real clock. */
  readonly clock?: Clock | undefined;
  /** This function gives the event loop one turn between two slices. The default is `setImmediate`, or `setTimeout` with no `setImmediate`. */
  readonly turn?: (() => Promise<void>) | undefined;
  /** This signal stops the work between two slices. The function then closes the steps and rejects with the reason of the signal. */
  readonly signal?: AbortSignal | undefined;
}

/** The counts of one work that `runSlices` did. */
export interface SliceReport<T> {
  /** The result of the work. */
  readonly value: T;
  /** The count of the steps that the work did. */
  readonly steps: number;
  /** The count of the slices. One slice comes before each turn of the event loop, and one after the last turn. */
  readonly slices: number;
  /** The longest slice, in milliseconds on the clock. */
  readonly longestMs: number;
}

/** This function gives one turn of the event loop. */
function defaultTurn(): Promise<void> {
  const immediate = (globalThis as { setImmediate?: (run: () => void) => unknown }).setImmediate;
  return new Promise<void>((resolve) => {
    if (immediate === undefined) setTimeout(resolve, 0);
    else immediate(resolve);
  });
}

/**
 * This function does the steps of a work in slices of `sliceMs`, with one turn of the event loop between
 * two slices. A step is synchronous, thus a long step makes a long slice. Keep each step short.
 *
 * @param steps - The steps of the work, as a generator gives them.
 * @param options - The time of a slice, the clock, the turn and the signal.
 * @returns The result of the work, with the counts of its steps and slices.
 * @throws RangeError - The `sliceMs` is not a finite number of 0 or more.
 */
export async function runSlices<T>(steps: Steps<T>, options: SliceOptions = {}): Promise<SliceReport<T>> {
  const sliceMs = options.sliceMs ?? SLICE_MS;
  if (!Number.isFinite(sliceMs) || sliceMs < 0) throw new RangeError(`The slice time is ${String(sliceMs)}, and it must be a finite number of 0 or more.`);
  const clock = options.clock ?? realClock;
  const turn = options.turn ?? defaultTurn;
  const signal = options.signal;
  let count = 0;
  let slices = 0;
  let longestMs = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const begun = clock.now();
      slices += 1;
      for (;;) {
        const next = steps.next();
        if (next.done === true) {
          longestMs = Math.max(longestMs, clock.now() - begun);
          return { value: next.value, steps: count, slices, longestMs };
        }
        count += 1;
        if (clock.now() - begun >= sliceMs) break;
      }
      longestMs = Math.max(longestMs, clock.now() - begun);
      await turn();
    }
  } catch (error) {
    steps.return?.(undefined as T);
    throw error;
  }
}
