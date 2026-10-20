import type { Machine, TransitionDef } from "@mark1russell7/algebra";
import type { KeyState, LimitPolicy, LimitRule } from "./policy.ts";
import { decide, freeAt } from "./policy.ts";

const t = (id: string, from: string | readonly string[], on: string | readonly string[], to: string, extra: Partial<TransitionDef> = {}): TransitionDef => ({
  id,
  from,
  on,
  to,
  ...extra,
});
const count = (key: string) => ({ key, scope: "limiter", unit: "count", default: null }) as const;

/**
 * A limiter state is the state of one key of a keyed limiter, as its machine document names it:
 * - `new`: the store holds no state for the key, or a state that is equal to the state of a new key.
 * - `open`: the key holds a count, and its next take is permitted.
 * - `limited`: the next take of the key is refused with the cause `limit`, until a unit is back.
 */
export type LimiterState = "new" | "open" | "limited";

/** These are the states of a key that a store can hold. A store fails in each of them. */
const HELD = ["new", "open", "limited"] as const;

/** These are the parts of each document of a limiter that do not change with its policy. */
const COMMON = {
  format: "mark1russell7.machine/1",
  layer: "self",
  version: "0.1.0",
  sources: [
    { ref: "packages/service/src/limiter (the runtime implements this document: decide, memoryStore, keyedLimiter)", rung: "implemented" },
    { ref: "RFC 6585 §4: 429 Too Many Requests, which can carry Retry-After", rung: "normative" },
    { ref: "RFC 9110 §10.2.3: Retry-After, as delay-seconds or an HTTP-date", rung: "normative" },
  ],
  conditions: {
    "store.local": "the counts are in the memory of one replica: a limit L over N replicas is L / N on each replica, and that sum holds only on average",
    "store.shared": "the counts are in a store that the replicas share: one atomic step on the clock of the store decides each take",
  },
  states: {
    new: { initial: true, note: "the store holds no state for the key, or a state equal to a new key. The store can remove the key" },
    open: { note: "the key holds a count, and its next take is permitted" },
    limited: { note: "the next take is refused with the cause limit, until a unit is back" },
  },
} as const;

/** These are the events of each document of a limiter. */
const EVENTS = {
  take: { kind: "app", note: "one call of take(key): one request of the key. A permitted take uses one unit" },
  "unit.back": { kind: "timer", note: "the next take of a limited key is permitted again" },
  idle: { kind: "timer", note: "the key is equal to a new key. The store can remove it, and no decision changes" },
  "store.fail": { kind: "local", note: "a shared store fails the take. The state of the key does not change" },
} as const;

/** These are the knobs of each document of a limiter that do not change with its policy. */
const KNOBS = {
  max_keys: count("limiters.<name>.evict.maxKeys"),
  on_store_failure: { key: "limiters.<name>.store.onStoreFailure", scope: "limiter", unit: null, default: null },
} as const;

/**
 * These are the transitions of each document of a limiter that do not change with its policy. They
 * are the refusal of a limited key, a new key at the cap of keys, and a failure of a shared store.
 */
const COMMON_TRANSITIONS: readonly TransitionDef[] = [
  t("refuse", "limited", "take", "limited", {
    emits: ["429 limit"],
    note: "Retry-After is the time until the next take is permitted, in whole seconds, rounded up. The count of the key does not change",
  }),
  t("cap", "new", "take", "new", {
    guard: "the store holds max_keys keys for the limiter, and no held key is equal to a new key",
    emits: ["429 cap"],
    note: "Retry-After is the time until the earliest held key is free: at most the idle span. A held key keeps its count",
  }),
  ...HELD.map((state) =>
    t(`store-failed-${state}`, state, "store.fail", state, {
      guard: "the store is shared",
      emits: ["allow, or 429 store"],
      note: "on_store_failure open lets the take in, with remaining 0. closed refuses it with the cause store, and its Retry-After is the longest of the policy",
    }),
  ),
];

/**
 * A token bucket of one key (GCRA), as a `mark1russell7.machine/1` document. The bucket holds
 * `burst` tokens, and it gets one token back in each interval, `1 / rate`. The store keeps one time
 * for the key: when its bucket is full again.
 * - A take is permitted when, with the take, the bucket is full again in at most `burst` intervals.
 * - A refused take waits until one token is back: at most one interval. That interval is the
 *   longest `Retry-After` of the policy (`retry_after@limiter` of the law).
 * - After `burst / rate` with no take, the bucket is full, and the key is equal to a new key. That
 *   span is the idle span, and the longest wait of a new key at the cap of keys
 *   (`retry_after_at_cap@limiter`).
 */
export const TOKEN_BUCKET_MACHINE: Machine = {
  ...COMMON,
  id: "service.machine.limiter.token-bucket",
  title: "A token bucket of one key of the keyed limiter",
  events: EVENTS,
  knobs: {
    rate: { key: "limiters.<name>.policy.rate", scope: "limiter", unit: "count/s", default: null },
    burst: count("limiters.<name>.policy.burst"),
    ...KNOBS,
  },
  timers: {
    token: {
      duration: { expr: "1 / rate", unit: "s" },
      early: { expr: "1 / rate", unit: "s" },
      arms: ["enter:limited"],
      cancels: ["idle"],
      fires: "unit.back",
      note: "one token comes back at most one interval after the take that used the last token. The Retry-After of each refusal is the time to this firing",
    },
    full: {
      duration: { expr: "burst / rate", unit: "s" },
      early: { expr: "(burst - 1) / rate", unit: "s" },
      arms: ["take"],
      fires: "idle",
      note: "the bucket is full again from one to burst intervals after a permitted take. A refused take does not move it",
    },
  },
  transitions: [
    t("first", "new", "take", "open", { guard: "burst > 1", emits: ["allow"] }),
    t("first-last", "new", "take", "limited", { guard: "burst = 1", emits: ["allow"] }),
    t("take", "open", "take", "open", { guard: "a token remains after the take", emits: ["allow"] }),
    t("take-last", "open", "take", "limited", { guard: "the take uses the last token", emits: ["allow"] }),
    ...COMMON_TRANSITIONS,
    t("token-back", "limited", "unit.back", "open", { timer: "token", guard: "burst > 1" }),
    t("full", "open", "idle", "new", { timer: "full" }),
    t("full-at-once", "limited", "idle", "new", {
      timer: "full",
      guard: "burst = 1: the one token is back when the bucket is full",
    }),
  ],
};

/**
 * A sliding window of one key, as a `mark1russell7.machine/1` document. The store keeps the time of
 * each permitted take of the key in the window, and each take counts for one window from its time.
 * - A take is permitted when fewer than `limit` takes are in the window.
 * - A refused take waits until the oldest take leaves the window: at most one window. That window is
 *   the longest `Retry-After` of the policy (`retry_after@limiter` of the law).
 * - One window after the last take, no take is in the window, and the key is equal to a new key.
 *   That window is the idle span, and the longest wait of a new key at the cap of keys
 *   (`retry_after_at_cap@limiter`).
 */
export const SLIDING_WINDOW_MACHINE: Machine = {
  ...COMMON,
  id: "service.machine.limiter.sliding-window",
  title: "A sliding window of one key of the keyed limiter",
  events: EVENTS,
  knobs: {
    limit: count("limiters.<name>.policy.limit"),
    window: { key: "limiters.<name>.policy.window", scope: "limiter", unit: "s", default: null },
    ...KNOBS,
  },
  timers: {
    oldest: {
      duration: { knob: "window", unit: "s" },
      early: { knob: "window", unit: "s" },
      arms: ["enter:limited"],
      cancels: ["idle"],
      fires: "unit.back",
      note: "the oldest take leaves the window at most one window after the take that filled it. The Retry-After of each refusal is the time to this firing",
    },
    last: {
      duration: { knob: "window", unit: "s" },
      arms: ["take"],
      fires: "idle",
      note: "the last permitted take leaves the window one window after its time. A refused take does not move it",
    },
  },
  transitions: [
    t("first", "new", "take", "open", { guard: "limit > 1", emits: ["allow"] }),
    t("first-last", "new", "take", "limited", { guard: "limit = 1", emits: ["allow"] }),
    t("take", "open", "take", "open", { guard: "fewer than limit - 1 takes are in the window before the take", emits: ["allow"] }),
    t("take-last", "open", "take", "limited", { guard: "the take is the limit-th take in the window", emits: ["allow"] }),
    ...COMMON_TRANSITIONS,
    t("oldest-leaves", "limited", "unit.back", "open", { timer: "oldest", guard: "a later take stays in the window" }),
    t("last-leaves", "open", "idle", "new", { timer: "last" }),
    t("all-leave", "limited", "idle", "new", {
      timer: "last",
      guard: "each take of the window has one time: limit = 1, or each take came at once",
    }),
  ],
};

/** This function gives the machine document of the policy of a limiter. */
export const limiterMachine = (policy: LimitPolicy): Machine =>
  policy.type === "token-bucket" ? TOKEN_BUCKET_MACHINE : SLIDING_WINDOW_MACHINE;

/**
 * This function gives the state of a key of a store as its machine document names it, at the time
 * `now` in milliseconds. `state` is what the store keeps for the key, or `undefined` when it keeps
 * nothing. A key equal to a new key is `new`, and a key whose next take `decide` refuses is `limited`.
 */
export const limiterStateOf = (rule: LimitRule, state: KeyState | undefined, now: number): LimiterState => {
  if (state === undefined || freeAt(rule, state) <= now) return "new";
  return decide(rule, state, now).decision.allowed ? "open" : "limited";
};
