import type { Extent, Quantity, Rational } from "@mark1russell7/quantity";
import { convertExact, quantity, rationals as r, valueIn } from "@mark1russell7/quantity";
import { detectionTime } from "./heartbeat.ts";

/**
 * All policies have the same timing shape. A timing is a count of polls (a debounce) or a
 * duration (a window), and each converts to the other. A long window is easier to read as a
 * duration, and that is the only difference between the two.
 */
export type Timing =
  | {
      readonly type: "debounce";
      /** This interval is the time between two polls of the signal. */
      readonly interval: Quantity;
      /** This count is the number of failed polls in sequence before the policy fails. */
      readonly failAfter: number;
      /** This count is the number of passed polls in sequence before the policy recovers. */
      readonly recoverAfter: number;
    }
  | {
      readonly type: "window";
      /** This duration is how long the signal fails before the policy fails, on the monotonic clock. */
      readonly failAfter: Quantity;
      /** This duration is how long the signal passes before the policy recovers. Without it, the first pass recovers the policy. */
      readonly recoverAfter?: Quantity | undefined;
    };

/** A poll has an interval, a jitter as a fraction (±20 % is 0.2) and a timeout. */
export interface Poll {
  readonly interval: Quantity;
  readonly jitter: number;
  readonly timeout: Quantity;
}

/** A span is a range of times, from the earliest to the latest. */
export interface Span {
  readonly min: Quantity;
  readonly max: Quantity;
}

/**
 * This type tells how a failed step answers a poll.
 * - An `"error"` step refuses at once.
 * - A `"timeout"` step (a black hole) answers only when the timeout of the poll ends. Each poll
 *   makes a new call, and each call ends at its timeout. Thus the step is slower by that timeout,
 *   at the two ends of the span.
 * - A `"hang"` step makes a use that does not end. The first poll fails at its timeout. While the
 *   use stays pending, the runtime does not start the check again, and each later poll fails at
 *   once. Thus a debounce of two polls or more fails as fast as on an error.
 */
export type FailsBy = "error" | "timeout" | "hang";

const seconds = (amount: Quantity): Rational =>
  convertExact(r.fromNumber(amount.value), amount.unit, "s");
const out = (value: Rational): Quantity => quantity(r.toNumber(value), "s");
const fraction = (jitter: number): Rational => {
  if (!(jitter >= 0 && jitter < 1))
    throw new RangeError(`jitter is a fraction below 1, not ${jitter}`);
  return r.fromNumber(jitter);
};
const count = (polls: number, what: string): Rational => {
  if (!Number.isInteger(polls) || polls < 1)
    throw new RangeError(`${what} is a whole number of polls, not ${polls}`);
  return r.rational(BigInt(polls));
};

/** N polls with jitter take from N − 1 short intervals to N long intervals. */
const debounced = (polls: Rational, interval: Rational, jitter: Rational): [Rational, Rational] => [
  r.mul(r.sub(polls, r.ONE), r.mul(interval, r.sub(r.ONE, jitter))),
  r.mul(polls, r.mul(interval, r.add(r.ONE, jitter))),
];

/**
 * This function gives the time that a policy takes to fail after its signal becomes bad. A
 * debounce of N polls takes approximately N intervals, with the jitter. A window takes its
 * duration, plus one interval at most for the poll that starts its sequence. A step that fails by
 * a timeout adds the timeout of the poll. At 3 polls of 5 s ± 20 %, the latch fails in 8–18 s on
 * an error, and in 12–22 s on a 4 s timeout. A step that hangs adds the timeout only where its
 * first failure ends the sequence: a window, or a debounce of one poll.
 */
export const failSpan = (timing: Timing, poll: Poll, by: FailsBy = "error"): Span => {
  const jitter = fraction(poll.jitter);
  const first = timing.type === "window" || timing.failAfter === 1;
  const late =
    by === "timeout" || (by === "hang" && first) ? seconds(poll.timeout) : r.ZERO;
  if (timing.type === "debounce") {
    const [min, max] = debounced(
      count(timing.failAfter, "failAfter"),
      seconds(timing.interval),
      jitter,
    );
    return { min: out(r.add(min, late)), max: out(r.add(max, late)) };
  }
  const duration = seconds(timing.failAfter);
  const interval = r.mul(seconds(poll.interval), r.add(r.ONE, jitter));
  return { min: out(r.add(duration, late)), max: out(r.add(r.add(duration, interval), late)) };
};

/** This function gives the time that a policy takes to recover after its signal becomes good. */
export const recoverSpan = (timing: Timing, poll: Poll): Span => {
  const jitter = fraction(poll.jitter);
  if (timing.type === "debounce") {
    const [min, max] = debounced(
      count(timing.recoverAfter, "recoverAfter"),
      seconds(timing.interval),
      jitter,
    );
    return { min: out(min), max: out(max) };
  }
  const duration = timing.recoverAfter === undefined ? r.ZERO : seconds(timing.recoverAfter);
  const interval = r.mul(seconds(poll.interval), r.add(r.ONE, jitter));
  return { min: out(duration), max: out(r.add(duration, interval)) };
};

/** This function gives the window that a debounce approximates: N polls of an interval fail after N intervals. */
export const asWindow = (timing: Timing): Timing =>
  timing.type === "window"
    ? timing
    : {
        type: "window",
        failAfter: out(r.mul(count(timing.failAfter, "failAfter"), seconds(timing.interval))),
        recoverAfter: out(
          r.mul(count(timing.recoverAfter, "recoverAfter"), seconds(timing.interval)),
        ),
      };

/** This function gives the debounce that approximates a window on a poll: the polls that fit, rounded up. */
export const asDebounce = (timing: Timing, poll: Poll): Timing => {
  if (timing.type === "debounce") return timing;
  const interval = seconds(poll.interval);
  const polls = (duration: Rational | undefined): number =>
    duration === undefined ? 1 : Math.max(1, Number(r.ceil(r.div(duration, interval)).n));
  return {
    type: "debounce",
    interval: poll.interval,
    failAfter: polls(seconds(timing.failAfter)),
    recoverAfter: polls(
      timing.recoverAfter === undefined ? undefined : seconds(timing.recoverAfter),
    ),
  };
};

/**
 * This function gives the most time that a heartbeat takes to find a silent peer, as an amount
 * for the ordering law (`detectionTime`). An interval of "infinite" is a heartbeat that is off.
 */
export const heartbeatDetection = (interval: Extent, timeout: Quantity, misses: number): Extent =>
  interval.value === "infinite"
    ? { value: "infinite", unit: "s" }
    : quantity(detectionTime(valueIn(interval as Quantity, "ms"), valueIn(timeout, "ms"), misses) / 1000, "s");
