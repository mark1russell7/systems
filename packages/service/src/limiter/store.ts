import type { Quantity } from "@mark1russell7/quantity";
import { convertExact, rationals as r } from "@mark1russell7/quantity";
import type { Clock } from "../clock.ts";
import type { Decision, KeyState, LimiterSpec, LimitRule } from "./policy.ts";
import { decide, freeAt, limitRule, limiterProblems, longestRetryAfter } from "./policy.ts";

/** A take request is one take of one key, with the rule and the cap of its limiter in numbers. */
export interface TakeRequest {
  /** This name is the limiter. A store keeps the keys of each limiter apart. */
  readonly limiter: string;
  readonly key: string;
  readonly rule: LimitRule;
  /** This count is the most keys that the store holds for the limiter. */
  readonly maxKeys: number;
}

/**
 * A limiter store keeps the state of each key, and it decides each take in one atomic step, on its
 * own clock. Thus two takes of one key do not read the same state at any time. A store in this
 * process uses `decide`. A store that the replicas share does the same arithmetic in one step of its
 * own, for example one script of Redis that reads `TIME`.
 */
export interface LimiterStore {
  /** This kind tells where the counts are: in the memory of this replica, or in a store that the replicas share. */
  readonly kind: "local" | "shared";
  /**
   * This method decides one take. It removes a key only when its state is equal to the state of a
   * new key. It holds at most `maxKeys` keys for each limiter. A failure of a shared store rejects
   * the take, and the limiter then applies the `onStoreFailure` of its spec.
   */
  take(request: TakeRequest): Decision | Promise<Decision>;
}

/** A memory store is the store of one replica, on the injected monotonic clock. */
export interface MemoryStore extends LimiterStore {
  readonly kind: "local";
  /** This method gives the count of keys that the store holds for a limiter. */
  size(limiter: string): number;
}

/** A table is the keys of one limiter in a memory store. */
interface Table {
  readonly states: Map<string, KeyState>;
  /**
   * This time is at or before the earliest time at which a held key is equal to a new key. An
   * insert lowers it, and a sweep sets it again. A take of a held key only moves the time of that
   * key later, thus the bound stays true.
   */
  next: number;
}

const ms = (value: number): Quantity => ({ value, unit: "ms" });

/**
 * This function makes the store of one replica. It reads time only through the clock. Thus a step
 * of the wall clock does not move a count, and a fake clock gives exact decisions in a test.
 * - The eviction is exact. A key whose bucket is full again, or whose window has no take, is equal
 *   to a new key. The store removes it at its next take, or at a sweep.
 * - The count of keys has a bound. At the cap, a take of a new key sweeps the table, but only when
 *   a held key can be free. Each sweep reads each key one time. When no key is free, the store
 *   refuses the new key with the cause `cap`. Its `retryAfter` is at most the time until the
 *   earliest held key is free, and that time is at most `idleSpan` of the policy.
 */
export const memoryStore = (clock: Clock): MemoryStore => {
  const tables = new Map<string, Table>();
  const sweep = (table: Table, rule: LimitRule, now: number): void => {
    let next = Number.POSITIVE_INFINITY;
    for (const [key, state] of table.states) {
      const free = freeAt(rule, state);
      if (free <= now) table.states.delete(key);
      else next = Math.min(next, free);
    }
    table.next = next;
  };
  return {
    kind: "local",
    take({ limiter, key, rule, maxKeys }) {
      const now = clock.now();
      let table = tables.get(limiter);
      if (table === undefined) {
        table = { states: new Map(), next: Number.POSITIVE_INFINITY };
        tables.set(limiter, table);
      }
      let state = table.states.get(key);
      // a key that is equal to a new key goes: the decision is the same, and it frees its slot
      if (state !== undefined && freeAt(rule, state) <= now) {
        table.states.delete(key);
        state = undefined;
      }
      if (state === undefined && table.states.size >= maxKeys) {
        if (table.next <= now) sweep(table, rule, now);
        if (table.states.size >= maxKeys) return { allowed: false, retryAfter: ms(table.next - now), cause: "cap" };
      }
      const step = decide(rule, state, now);
      if (state === undefined) {
        // a new key is never refused by its policy: a full bucket, or an empty window
        table.states.set(key, step.state);
        table.next = Math.min(table.next, freeAt(rule, step.state));
      } else table.states.set(key, step.state);
      return step.decision;
    },
    size(limiter) {
      return tables.get(limiter)?.states.size ?? 0;
    },
  };
};

/** A keyed limiter is the runtime of one declared limiter: its spec, its rule in numbers, and its store. */
export interface KeyedLimiter {
  readonly name: string;
  /** This spec is the declaration, the same data that `svc.limiter(name, spec)` takes and `describe()` shows. */
  readonly spec: LimiterSpec;
  readonly rule: LimitRule;
  /** This count is the most keys that the store holds for the limiter. */
  readonly maxKeys: number;
  /**
   * This method takes one unit for a key, and gives the decision of the store. When a shared store
   * fails, it gives the decision of `onStoreFailure`, with the failure as text.
   */
  take(key: string): Promise<Decision>;
}

/** This function gives the text of a failure. */
const failureOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * This function makes the runtime of a limiter from its spec and its store. It refuses a spec with a
 * problem, because the limiter has no defaults. It also refuses a store of the wrong kind: a spec
 * with a shared store needs a store that the replicas share.
 * - A failure of a shared store gives the decision of `onStoreFailure`. With `open`, the take is
 *   permitted with `remaining` 0. With `closed`, it is refused with the cause `store`.
 * - The `retryAfter` of the cause `store` is the longest `retryAfter` of the policy.
 * - A failure of a local store rejects the take, because a local store has no `onStoreFailure`.
 */
export const keyedLimiter = (name: string, spec: LimiterSpec, store: LimiterStore): KeyedLimiter => {
  const problems = limiterProblems(name, spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  if (store.kind !== spec.store.kind)
    throw new Error(`limiter ${name} declares a ${spec.store.kind} store, but the store that it got is ${store.kind}`);
  const rule = limitRule(spec.policy);
  const maxKeys = r.toNumber(convertExact(r.fromNumber(spec.evict.maxKeys.value), spec.evict.maxKeys.unit, "count"));
  const onStoreFailure = spec.store.kind === "shared" ? spec.store.onStoreFailure : undefined;
  const closedAfter = longestRetryAfter(spec.policy);
  const take = async (key: string): Promise<Decision> => {
    const request: TakeRequest = { limiter: name, key, rule, maxKeys };
    if (onStoreFailure === undefined) return store.take(request);
    try {
      return await store.take(request);
    } catch (error) {
      const failure = failureOf(error);
      if (onStoreFailure === "open") return { allowed: true, remaining: 0, failure };
      return { allowed: false, retryAfter: { ...closedAfter }, cause: "store", failure };
    }
  };
  return {
    name,
    spec: {
      key: spec.key,
      policy: { ...spec.policy },
      store: { ...spec.store },
      evict: { maxKeys: { ...spec.evict.maxKeys } },
    },
    rule,
    maxKeys,
    take,
  };
};
