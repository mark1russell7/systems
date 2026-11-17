// @mark1russell7/service/limiter: a keyed rate limiter, and the quota of a key. A limiter is data
// before it starts: a key, a policy (a token bucket, a sliding window or an in-flight bound), a store and a bound on its
// keys, with no defaults. Its store decides each take in one atomic step, on the clock of the store.
// The store of a replica reads the injected monotonic clock, not the wall clock. A quota is data
// too: a limit, a reserve and a window of a calendar or of a rolling span. It reads a wall clock,
// because a calendar window needs civil time. This entry loads only the quantity package and the
// clock of the algebra: no `node:` module and no zod. Thus a client in a browser can use it.

export type {
  Allowed,
  CapacityRefused,
  Decision,
  InFlightBound,
  KeyState,
  Lease,
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
  WaitCause,
  WaitRefused,
} from "./limiter/policy.ts";
export {
  capacityOf,
  decide,
  freeAt,
  idleSpan,
  limitRule,
  limiterProblems,
  longestRetryAfter,
  overCapacity,
  releaseLease,
  retryAfterSeconds,
  unitsOf,
} from "./limiter/policy.ts";
export type { KeyedLimiter, LimiterStore, LocalLimiter, MemoryStore, ReleaseRequest, TakeRequest } from "./limiter/store.ts";
export { keyedLimiter, memoryStore } from "./limiter/store.ts";
// the machine of a key is a document: only its type comes from the algebra, thus the entry loads no more
export type { LimiterState } from "./limiter/machine.ts";
export { IN_FLIGHT_MACHINE, SLIDING_WINDOW_MACHINE, TOKEN_BUCKET_MACHINE, limiterMachine, limiterStateOf } from "./limiter/machine.ts";
export type {
  CalendarWindow,
  KeyedQuota,
  MemoryQuotaStore,
  QuotaAllowed,
  QuotaAnswer,
  QuotaCapacityRefused,
  QuotaChange,
  QuotaEvent,
  QuotaPart,
  QuotaReading,
  QuotaRecord,
  QuotaRefused,
  QuotaRule,
  QuotaSpec,
  QuotaState,
  QuotaStep,
  QuotaStore,
  QuotaTakeStep,
  QuotaVerdict,
  QuotaWaitRefused,
  QuotaWindow,
  QuotasVerdict,
  RollingWindow,
  TakeQuotasOptions,
} from "./limiter/quota.ts";
export { keyedQuota, memoryQuotaStore, quotaProblems, quotaRule, quotaStep, takeQuotas } from "./limiter/quota.ts";
