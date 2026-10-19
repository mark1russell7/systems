import type { Quantity } from "@mark1russell7/quantity";
import { convertExact, convertible, rationals as r } from "@mark1russell7/quantity";

/**
 * A token bucket gives each key a bucket of `burst` tokens. The bucket refills at `rate`, and each
 * take uses one token. Thus a key can make `burst` takes at once after an idle time, and then
 * `rate` takes in each unit of time.
 */
export interface TokenBucket {
  readonly type: "token-bucket";
  /** This rate is how fast the bucket refills: a count for each unit of time, for example `{ value: 10, unit: "count/s" }`. */
  readonly rate: Quantity;
  /** This count is the size of the bucket: the most takes in a sequence after an idle time. */
  readonly burst: Quantity;
}

/**
 * A sliding window gives each key at most `limit` takes in each `window`. Each take counts for one
 * window from its time, thus the window moves with the clock and has no fixed edges.
 */
export interface SlidingWindow {
  readonly type: "sliding-window";
  /** This count is the most takes of one key in one window. */
  readonly limit: Quantity;
  /** This time is the length of the window. */
  readonly window: Quantity;
}

/** A limit policy is the rule that a keyed limiter applies to each key, as data. It has no defaults. */
export type LimitPolicy = TokenBucket | SlidingWindow;

/**
 * A store spec tells where the counts of the keys are:
 * - `local`: in the memory of each replica. A limit L over N replicas is then L / N on each
 *   replica. That sum holds only on average, when the balancer spreads the takes of each key evenly.
 * - `shared`: in a store that the replicas share, the dependency of that name. The store decides
 *   each take in one atomic step, on its own clock. Thus the limit holds across the replicas.
 */
export type LimiterStoreSpec = { readonly kind: "local" } | { readonly kind: "shared"; readonly dependency: string };

/**
 * The eviction of a limiter bounds its keys. A store removes a key only when its state is equal to
 * the state of a new key. That is a bucket that is full again, or a window with no take in it.
 * Thus an eviction changes no decision.
 */
export interface LimiterEviction {
  /**
   * This count is the most keys that the store holds. At the cap, the store refuses a take of a new
   * key until a held key is idle for its span (`idleSpan`). A held key keeps its count.
   */
  readonly maxKeys: Quantity;
}

/** A limiter spec is the declaration of one keyed limiter. Each part is necessary, because the limiter has no defaults. */
export interface LimiterSpec {
  /** This text tells what the key of each take is, for example `tenant` or `principal`. The caller gives each key. */
  readonly key: string;
  readonly policy: LimitPolicy;
  readonly store: LimiterStoreSpec;
  readonly evict: LimiterEviction;
}

/** A limiter is a keyed limiter in the description of a service: its name and its spec. */
export interface Limiter extends LimiterSpec {
  readonly name: string;
}

/** A refusal cause tells why a take is refused: the key used its limit, or the store holds its cap of keys. */
export type RefusalCause = "limit" | "cap";

/** A permitted take used one unit of its key. `remaining` is the count of takes that the key can make at this time. */
export interface Allowed {
  readonly allowed: true;
  readonly remaining: number;
}

/**
 * A refused take used nothing. `retryAfter` is the time until the limiter lets the same take in, when
 * no other take comes first. It is always above zero.
 */
export interface Refused {
  readonly allowed: false;
  readonly retryAfter: Quantity;
  readonly cause: RefusalCause;
}

/** A decision is the answer of a limiter to one take. */
export type Decision = Allowed | Refused;

/**
 * A limit rule is a policy in numbers, which a store applies: each time in milliseconds, and each
 * count as a number. A store in another process, for example a script of Redis, gets these numbers.
 */
export type LimitRule =
  | {
      readonly type: "token-bucket";
      /** This time is the refill of one token, in milliseconds. */
      readonly interval: number;
      readonly burst: number;
    }
  | {
      readonly type: "sliding-window";
      readonly limit: number;
      /** This time is the length of the window, in milliseconds. */
      readonly window: number;
    };

/**
 * A key state is what a store keeps for one key:
 * - A token bucket keeps the time at which its bucket is full again (`full`, in milliseconds).
 * - A sliding window keeps the time of each permitted take in the window, the oldest first.
 */
export type KeyState =
  | { readonly type: "token-bucket"; readonly full: number }
  | { readonly type: "sliding-window"; readonly stamps: readonly number[] };

/** A step is the decision of one take, and the state of its key after the take. A refusal keeps the count of the key. */
export interface TakeStep {
  readonly decision: Decision;
  readonly state: KeyState;
}

/**
 * This tolerance is one nanosecond, in milliseconds. A comparison of times permits it, because a
 * rate of 3 for each second gives an interval that floating point cannot hold exactly.
 */
const TOLERANCE = 1e-6;

const isCount = (amount: Quantity | undefined): boolean => amount !== undefined && convertible(amount.unit, "count");
const isTime = (amount: Quantity | undefined): boolean => amount !== undefined && convertible(amount.unit, "s");
const isRate = (amount: Quantity | undefined): boolean => amount !== undefined && convertible(amount.unit, "count/s");
/** This function tells if a unit converts, also for a unit that the quantity package does not know. */
const safely = (test: (amount: Quantity | undefined) => boolean, amount: Quantity | undefined): boolean => {
  try {
    return test(amount);
  } catch {
    return false;
  }
};
const finiteAbove = (amount: Quantity): boolean => typeof amount.value === "number" && Number.isFinite(amount.value) && amount.value > 0;
const wholeCount = (amount: Quantity): boolean => finiteAbove(amount) && Number.isInteger(r.toNumber(convertExact(r.fromNumber(amount.value), amount.unit, "count")));

/** A loose policy is a policy from any source, with each part optional, for the check of its parts. */
interface LoosePolicy {
  readonly type?: string;
  readonly rate?: Quantity;
  readonly burst?: Quantity;
  readonly limit?: Quantity;
  readonly window?: Quantity;
}

/**
 * This function gives the problems of a limiter spec. `describe()` and `keyedLimiter` refuse a spec
 * with a problem. A part that is absent is a problem, because the limiter has no defaults.
 */
export const limiterProblems = (name: string, spec: Partial<LimiterSpec> | undefined): string[] => {
  const owner = `limiter ${name}`;
  if (spec === undefined || (spec as unknown) === null) return [`${owner} has no spec: a limiter has no defaults`];
  const problems: string[] = [];
  const missing = (part: string): void => {
    problems.push(`${owner} does not declare ${part}: a limiter has no defaults`);
  };
  if (typeof spec.key !== "string") missing("what its key is (key)");
  else if (spec.key.trim().length === 0) problems.push(`${owner} names no key`);
  const policy = spec.policy as LoosePolicy | undefined;
  if (policy === undefined) missing("its policy (policy)");
  else if (policy.type === "token-bucket") {
    if (policy.rate === undefined) missing("the rate of its bucket (policy.rate)");
    else if (!safely(isRate, policy.rate)) problems.push(`${owner}'s rate is not a count for each unit of time, for example count/s`);
    else if (!finiteAbove(policy.rate)) problems.push(`${owner}'s rate is not a finite rate above zero`);
    if (policy.burst === undefined) missing("the size of its bucket (policy.burst)");
    else if (!safely(isCount, policy.burst)) problems.push(`${owner}'s burst is not a count`);
    else if (!wholeCount(policy.burst)) problems.push(`${owner}'s burst is not a whole count above zero`);
  } else if (policy.type === "sliding-window") {
    if (policy.limit === undefined) missing("the limit of its window (policy.limit)");
    else if (!safely(isCount, policy.limit)) problems.push(`${owner}'s limit is not a count`);
    else if (!wholeCount(policy.limit)) problems.push(`${owner}'s limit is not a whole count above zero`);
    if (policy.window === undefined) missing("the length of its window (policy.window)");
    else if (!safely(isTime, policy.window)) problems.push(`${owner}'s window is not a time`);
    else if (!finiteAbove(policy.window)) problems.push(`${owner}'s window is not a finite time above zero`);
  } else problems.push(`${owner}'s policy ${String(policy.type)} is not "token-bucket" or "sliding-window"`);
  const store = spec.store as { kind?: string; dependency?: unknown } | undefined;
  if (store === undefined) missing(`its store, { kind: "local" } or { kind: "shared", dependency } (store)`);
  else if (store.kind === "shared") {
    if (typeof store.dependency !== "string" || store.dependency.trim().length === 0)
      problems.push(`${owner}'s shared store names no dependency`);
  } else if (store.kind !== "local") problems.push(`${owner}'s store ${String(store.kind)} is not "local" or "shared"`);
  const evict = spec.evict as Partial<LimiterEviction> | undefined;
  if (evict === undefined || evict.maxKeys === undefined) missing("the most keys that it holds (evict.maxKeys)");
  else if (!safely(isCount, evict.maxKeys)) problems.push(`${owner}'s maxKeys is not a count`);
  else if (!wholeCount(evict.maxKeys)) problems.push(`${owner}'s maxKeys is not a whole count above zero: the count of keys has a bound`);
  return problems;
};

/** This function gives an amount in milliseconds, exactly where the units permit, as one number. */
const milliseconds = (amount: Quantity): number => r.toNumber(convertExact(r.fromNumber(amount.value), amount.unit, "ms"));
/** This function gives a count as one number. */
const countOf = (amount: Quantity): number => r.toNumber(convertExact(r.fromNumber(amount.value), amount.unit, "count"));

/**
 * This function gives the rule of a policy in numbers. The interval of a bucket is exact as a
 * rational, and it becomes one number only at the end. Thus 10 for each minute gives 6000 ms.
 */
export const limitRule = (policy: LimitPolicy): LimitRule => {
  if (policy.type === "token-bucket") {
    const perMs = convertExact(r.fromNumber(policy.rate.value), policy.rate.unit, "count/ms");
    return { type: "token-bucket", interval: r.toNumber(r.div(r.ONE, perMs)), burst: countOf(policy.burst) };
  }
  return { type: "sliding-window", limit: countOf(policy.limit), window: milliseconds(policy.window) };
};

/** This function gives a time in milliseconds as a quantity. */
const ms = (value: number): Quantity => ({ value, unit: "ms" });

/**
 * This function gives the span after which an idle key is equal to a new key. That span is
 * `burst / rate` for a token bucket, and one window for a sliding window. A store can remove the key
 * after it, and no decision changes. It is also the longest `retryAfter` of a new key that the store
 * refuses at its cap.
 */
export const idleSpan = (policy: LimitPolicy): Quantity => {
  const rule = limitRule(policy);
  return ms(rule.type === "token-bucket" ? rule.interval * rule.burst : rule.window);
};

/**
 * This function gives the longest `retryAfter` of a refusal by the policy: one interval of the
 * bucket (`1 / rate`), or one window. A refusal at the cap of keys can be longer, up to `idleSpan`.
 */
export const longestRetryAfter = (policy: LimitPolicy): Quantity => {
  const rule = limitRule(policy);
  return ms(rule.type === "token-bucket" ? rule.interval : rule.window);
};

/**
 * This function gives a `retryAfter` in whole seconds, rounded up, as the header `Retry-After`
 * (RFC 9110) has it. A time over a whole second by less than one nanosecond rounds down to it,
 * because that part is an error of floating point.
 */
export const retryAfterSeconds = (retryAfter: Quantity): number => {
  const seconds = r.toNumber(convertExact(r.fromNumber(retryAfter.value), retryAfter.unit, "s"));
  return Math.max(0, Math.ceil(seconds - TOLERANCE / 1000));
};

/** This function gives the time at which a key state is equal to the state of a new key, in milliseconds. */
export const freeAt = (rule: LimitRule, state: KeyState): number => {
  if (state.type === "token-bucket") return state.full;
  const last = state.stamps[state.stamps.length - 1];
  return last === undefined ? Number.NEGATIVE_INFINITY : last + (rule.type === "sliding-window" ? rule.window : 0);
};

/**
 * This function decides one take of a key at the time `now`, in milliseconds, from the state of the
 * key (`undefined` for a new key). It is the one decision of each store in this process. A store in
 * another process does the same arithmetic in its own atomic step.
 * - A token bucket (GCRA): the store lets the take in when, with the take, the bucket is full
 *   again in at most `burst` intervals. A refusal waits until one token is back.
 * - A sliding window: the store lets the take in when fewer than `limit` takes are in the window.
 *   A refusal waits until the oldest take leaves the window.
 */
export const decide = (rule: LimitRule, state: KeyState | undefined, now: number): TakeStep => {
  if (rule.type === "token-bucket") {
    const span = rule.interval * rule.burst;
    const full = state?.type === "token-bucket" ? Math.max(state.full, now) : now;
    const next = full + rule.interval;
    if (next - now > span + TOLERANCE)
      return { decision: { allowed: false, retryAfter: ms(next - span - now), cause: "limit" }, state: { type: "token-bucket", full } };
    const remaining = Math.max(0, Math.floor((span - (next - now)) / rule.interval + TOLERANCE));
    return { decision: { allowed: true, remaining }, state: { type: "token-bucket", full: next } };
  }
  const held = state?.type === "sliding-window" ? state.stamps : [];
  // a take counts for one window from its time: it leaves the window at stamp + window
  const live = held.filter((stamp) => stamp + rule.window > now + TOLERANCE);
  if (live.length >= rule.limit)
    return { decision: { allowed: false, retryAfter: ms(live[0]! + rule.window - now), cause: "limit" }, state: { type: "sliding-window", stamps: live } };
  return { decision: { allowed: true, remaining: rule.limit - live.length - 1 }, state: { type: "sliding-window", stamps: [...live, now] } };
};
