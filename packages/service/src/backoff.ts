// @mark1russell7/service/backoff: the delays of an exponential backoff with a jitter, and their
// band for the ordering law, with no other part of the package. The entry imports nothing. Thus a
// client in a browser can use it.

/**
 * A jitter is the random part of each delay. The random number `r` is from 0 up to 1.
 * - `none`: the delay is the backoff.
 * - `subtract`: the delay is `backoff × (1 − fraction × r)`. A fraction of 1 is the full jitter: a delay from 0 to the backoff.
 * - `add`: the delay is `backoff + amount × r`, with the amount in milliseconds.
 */
export type Jitter =
  | { readonly kind: "none" }
  | { readonly kind: "subtract"; readonly fraction: number }
  | { readonly kind: "add"; readonly amount: number };

/** A backoff policy gives the delay before each try. Each time is in milliseconds. */
export interface Backoff {
  /** This time is the backoff of the first try. */
  readonly base: number;
  /** This number multiplies the backoff from one try to the next. The default is 2. */
  readonly factor?: number | undefined;
  /** This time is the most that a backoff can be, before its jitter. The default is no limit. */
  readonly cap?: number | undefined;
  /** This jitter gives the random part of each delay. The default is `none`. */
  readonly jitter?: Jitter | undefined;
}

/** A band is the least and the most delay that a policy gives, in milliseconds. */
export interface DelayBand {
  readonly low: number;
  readonly high: number;
}

const NONE: Jitter = { kind: "none" };

/** This function gives the backoff of a try, before its jitter: `base × factor^(attempt − 1)`, at most the cap. */
const backoffOf = (policy: Backoff, attempt: number): number => {
  const grown = policy.base === 0 ? 0 : policy.base * (policy.factor ?? 2) ** (attempt - 1);
  return Math.min(grown, policy.cap ?? Number.POSITIVE_INFINITY);
};

/** This function gives the band of one backoff after its jitter. */
const jittered = (backoff: number, jitter: Jitter): DelayBand => {
  if (jitter.kind === "subtract") return { low: backoff * (1 - jitter.fraction), high: backoff };
  if (jitter.kind === "add") return { low: backoff, high: backoff + jitter.amount };
  return { low: backoff, high: backoff };
};

const tryNumber = (attempt: number): number => {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`a try is a whole number from 1, not ${attempt}`);
  return attempt;
};

/**
 * This function gives the delay before a try, in milliseconds. The first try is 1. The delay is
 * the backoff of the try with its jitter, and not below zero. The `random` function gives numbers from 0 up to 1.
 */
export const backoffDelay = (policy: Backoff, attempt: number, random: () => number = Math.random): number => {
  const backoff = backoffOf(policy, tryNumber(attempt));
  const jitter = policy.jitter ?? NONE;
  if (jitter.kind === "subtract") return Math.max(0, backoff * (1 - jitter.fraction * random()));
  if (jitter.kind === "add") return Math.max(0, backoff + random() * jitter.amount);
  return Math.max(0, backoff);
};

/**
 * This function gives the band of the delay before a try: the least and the most delay that the
 * jitter can give. Without a try, the band covers each try. The ordering law reads the most delay
 * of a policy from it.
 */
export const backoffBand = (policy: Backoff, attempt?: number): DelayBand => {
  const jitter = policy.jitter ?? NONE;
  if (attempt !== undefined) return jittered(backoffOf(policy, tryNumber(attempt)), jitter);
  // a factor above 1 grows the backoff to the cap, a factor of 1 keeps it, and a factor below 1 shrinks it to zero
  const factor = policy.factor ?? 2;
  const first = backoffOf(policy, 1);
  const most = factor > 1 && policy.base > 0 ? (policy.cap ?? Number.POSITIVE_INFINITY) : first;
  const least = factor < 1 ? 0 : first;
  return { low: jittered(least, jitter).low, high: jittered(most, jitter).high };
};

/** This function gives the problems of a policy: each value that the delays cannot use. */
export const backoffProblems = (policy: Backoff): string[] => {
  const problems: string[] = [];
  const factor = policy.factor ?? 2;
  const cap = policy.cap ?? Number.POSITIVE_INFINITY;
  if (!(Number.isFinite(policy.base) && policy.base >= 0)) problems.push(`the base ${policy.base} is not a time of zero or more`);
  if (!(Number.isFinite(factor) && factor >= 1)) problems.push(`the factor ${factor} is not a number of 1 or more`);
  if (!(cap >= policy.base)) problems.push(`the cap ${cap} is below the base ${policy.base}`);
  const jitter = policy.jitter ?? NONE;
  if (jitter.kind === "subtract" && !(jitter.fraction >= 0 && jitter.fraction <= 1))
    problems.push(`the fraction ${jitter.fraction} of the jitter is not from 0 to 1`);
  if (jitter.kind === "add" && !(Number.isFinite(jitter.amount) && jitter.amount >= 0))
    problems.push(`the amount ${jitter.amount} of the jitter is not a time of zero or more`);
  return problems;
};
