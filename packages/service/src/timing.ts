import type { Extent, Quantity, Rational } from "@mark1russell7/quantity";
import { convertExact, isUnbounded, quantity, rationals as r, valueIn } from "@mark1russell7/quantity";
import { detectionTime } from "./heartbeat.ts";
import type { Schedule } from "./loop.ts";

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

/**
 * This function gives the poll of a span, and the way the step fails on it. A schedule of the loop core gives its period,
 * its jitter and its timeout. The model of the span holds for a schedule from `start` with one lane. Its period and its
 * timeout have a bound, and it has no backoff, no budget and no stable time.
 *
 * The overlap `fail` is the model of the poller. With the overlap `allow`, each due round is a new call, thus a step that
 * hangs fails as a step that times out. Its recovery differs: when the step heals, the call in flight answers at once
 * (`healed`). With the overlap `skip`, a round that hangs gives one failure only, thus its span has no bound.
 */
const pollOf = (
  given: Poll | Schedule,
  by: FailsBy,
): { readonly poll: Poll; readonly by: FailsBy; readonly healed: boolean } => {
  if (!("from" in given)) return { poll: given, by, healed: false };
  const problems: string[] = [];
  if (given.from !== "start") problems.push("a schedule from end spaces its polls by the time of each round");
  if (isUnbounded(given.period) || isUnbounded(given.timeout)) problems.push("its period and its timeout need a bound");
  if (given.backoff !== null) problems.push("a backoff changes the delay after each failure");
  if (given.lanes !== 1) problems.push("the span is for one lane");
  if (given.budget !== null) problems.push("a budget can delay a poll");
  if (given.stable !== null) problems.push("a stable time can make a pass a failure");
  if (given.overlap === "skip" && by === "hang") problems.push("with the overlap skip, a round that hangs gives one failure only");
  if (problems.length > 0) throw new RangeError(`the schedule has no span: ${problems.join("; ")}`);
  const poll: Poll = { interval: given.period as Quantity, jitter: given.jitter, timeout: given.timeout as Quantity };
  const healed = given.overlap === "allow" && by === "hang";
  return { poll, by: healed ? "timeout" : by, healed };
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
 *
 * The poll can also be the schedule of the loop of the check, for example `pollSchedule(poll)`. The function throws a
 * `RangeError` for a schedule that the model does not hold.
 */
export const failSpan = (timing: Timing, given: Poll | Schedule, by: FailsBy = "error"): Span => {
  const { poll, by: fails } = pollOf(given, by);
  const jitter = fraction(poll.jitter);
  const first = timing.type === "window" || timing.failAfter === 1;
  const late =
    fails === "timeout" || (fails === "hang" && first) ? seconds(poll.timeout) : r.ZERO;
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

/**
 * This function gives the time that a policy takes to recover after its signal becomes good. The poll can also be the
 * schedule of the loop of the check, as for `failSpan`.
 *
 * On a schedule with the overlap `allow`, a step that hangs recovers one timeout sooner. When the step heals, the call in
 * flight answers at once, thus it is the first pass. A heal after the timeout of that call leaves at most one interval
 * minus the timeout to the next poll. On the poller, the call in flight is past its timeout, thus its answer counts for
 * nothing.
 */
export const recoverSpan = (timing: Timing, given: Poll | Schedule, by: FailsBy = "error"): Span => {
  const { poll, healed } = pollOf(given, by);
  const jitter = fraction(poll.jitter);
  const sooner = healed ? seconds(poll.timeout) : r.ZERO;
  const floor = (value: Rational): Rational => (r.sign(value) < 0 ? r.ZERO : value);
  if (timing.type === "debounce") {
    const [min, max] = debounced(
      count(timing.recoverAfter, "recoverAfter"),
      seconds(timing.interval),
      jitter,
    );
    return { min: out(floor(r.sub(min, sooner))), max: out(floor(r.sub(max, sooner))) };
  }
  const duration = timing.recoverAfter === undefined ? r.ZERO : seconds(timing.recoverAfter);
  const interval = r.mul(seconds(poll.interval), r.add(r.ONE, jitter));
  return { min: out(duration), max: out(floor(r.sub(r.add(duration, interval), sooner))) };
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
