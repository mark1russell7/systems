// @mark1russell7/service/limiter: a keyed rate limiter. A limiter is data before it runs: a key, a
// policy (a token bucket or a sliding window), a store and a bound on its keys, with no defaults.
// Its store decides each take in one atomic step, on the clock of the store. The store of a replica
// reads the injected monotonic clock, never the wall clock. This entry loads only the quantity
// package: no `node:` module and no zod. Thus a client in a browser can use it.

export type {
  Allowed,
  Decision,
  KeyState,
  LimitPolicy,
  LimitRule,
  Limiter,
  LimiterEviction,
  LimiterSpec,
  LimiterStoreSpec,
  RefusalCause,
  Refused,
  SlidingWindow,
  StoreFailure,
  TakeStep,
  TokenBucket,
} from "./limiter/policy.ts";
export { decide, freeAt, idleSpan, limitRule, limiterProblems, longestRetryAfter, retryAfterSeconds } from "./limiter/policy.ts";
export type { KeyedLimiter, LimiterStore, MemoryStore, TakeRequest } from "./limiter/store.ts";
export { keyedLimiter, memoryStore } from "./limiter/store.ts";
// the machine of a key is a document: only its type comes from the algebra, thus the entry loads no more
export type { LimiterState } from "./limiter/machine.ts";
export { SLIDING_WINDOW_MACHINE, TOKEN_BUCKET_MACHINE, limiterMachine, limiterStateOf } from "./limiter/machine.ts";
