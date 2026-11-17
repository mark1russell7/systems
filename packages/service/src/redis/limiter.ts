import type { Clock } from "../clock.ts";
import type { Decision, LimitRule } from "../limiter/policy.ts";
import { overCapacity, unitsOf } from "../limiter/policy.ts";
import type { LimiterStore, ReleaseRequest } from "../limiter/store.ts";
import type { RedisClient } from "./client.ts";

/**
 * This script decides one take in one atomic step of Redis. It does the arithmetic of `decide`, and
 * it reads `TIME` of the server, the one clock of all replicas. A test can give the time in its place.
 * - KEYS[1] is the state of the key. KEYS[2] is the index of the limiter, a sorted set of its keys
 *   by the time at which each key is free.
 * - ARGV is the type of the rule, its two numbers, the cap of keys and the key. Then it has the
 *   time or "", and the units of the take. The store refuses a take over the capacity before the script, thus the units
 *   are at most the capacity. The last part is the declared `retryAfter` of an in-flight bound, or "".
 * - The state of a bucket is its full time. The state of a window is the time of each take in it.
 *   The state of an in-flight bound is the start of each held unit.
 * - The state expires at its free time (PX), and the index lets the cap count only busy keys.
 * - The reply is `{1, remaining}`, or `{0, retryAfter, cause}` with the time as text. A permitted take of
 *   an in-flight bound also gives its start as text: `{1, remaining, start}`. Redis gives each Lua
 *   number as a whole number, thus the fraction of a millisecond goes as text.
 */
export const LIMITER_SCRIPT = `
local kind = ARGV[1]
local a = tonumber(ARGV[2])
local b = tonumber(ARGV[3])
local cap = tonumber(ARGV[4])
local member = ARGV[5]
local units = tonumber(ARGV[7])
local declared = tonumber(ARGV[8])
local now
if ARGV[6] == '' then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
else
  now = tonumber(ARGV[6])
end
local TOL = 1e-6
local function num(x) return string.format('%.6f', x) end
local raw = redis.call('GET', KEYS[1])
local full = nil
local stamps = nil
if raw then
  if kind == 'token-bucket' then
    full = tonumber(raw)
  else
    stamps = {}
    for x in string.gmatch(raw, '[^,]+') do stamps[#stamps + 1] = tonumber(x) end
  end
end
local function freeAt()
  if kind == 'token-bucket' then return full end
  if #stamps == 0 then return -math.huge end
  return stamps[#stamps] + b
end
if raw and freeAt() <= now then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], member)
  raw = nil
  full = nil
  stamps = nil
end
if not raw then
  if redis.call('ZCARD', KEYS[2]) >= cap then
    redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', num(now))
    if redis.call('ZCARD', KEYS[2]) >= cap then
      local first = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
      return {0, num(tonumber(first[2]) - now), 'cap'}
    end
  end
end
local remaining
local state
if kind == 'token-bucket' then
  local span = a * b
  local base = now
  if full and full > now then base = full end
  local nxt = base + a * units
  if nxt - now > span + TOL then
    return {0, num(nxt - span - now), 'limit'}
  end
  remaining = math.floor((span - (nxt - now)) / a + TOL)
  if remaining < 0 then remaining = 0 end
  full = nxt
  state = num(full)
else
  local live = {}
  for _, stamp in ipairs(stamps or {}) do
    if stamp + b > now + TOL then live[#live + 1] = stamp end
  end
  if #live + units > a then
    local wait = live[#live + units - a] + b - now
    if kind == 'in-flight' and declared < wait then wait = declared end
    return {0, num(wait), 'limit'}
  end
  for _ = 1, units do live[#live + 1] = now end
  remaining = a - #live
  stamps = live
  local parts = {}
  for i, stamp in ipairs(live) do parts[i] = num(stamp) end
  state = table.concat(parts, ',')
end
local free = freeAt()
local ttl = math.ceil(free - now)
if ttl < 1 then ttl = 1 end
redis.call('SET', KEYS[1], state, 'PX', ttl)
redis.call('ZADD', KEYS[2], num(free), member)
if redis.call('PTTL', KEYS[2]) < ttl then redis.call('PEXPIRE', KEYS[2], ttl) end
if kind == 'in-flight' then return {1, remaining, num(now)} end
return {1, remaining}
`;

/**
 * This script releases the units of one lease of an in-flight bound in one atomic step of Redis. It
 * does the arithmetic of `releaseLease`, on the clock of `LIMITER_SCRIPT`.
 * - KEYS are the keys of `LIMITER_SCRIPT`.
 * - ARGV is the lease of the rule, the key, the time or "", the start of the lease and its units.
 * - A unit whose lease ended is not held, thus the script keeps only the units in their lease.
 * - A key with no held unit is equal to a new key: the script removes its state and its index entry.
 * - The reply is the count of units that the script released.
 */
export const LIMITER_RELEASE_SCRIPT = `
local lease = tonumber(ARGV[1])
local member = ARGV[2]
local start = tonumber(ARGV[4])
local units = tonumber(ARGV[5])
local now
if ARGV[3] == '' then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
else
  now = tonumber(ARGV[3])
end
local TOL = 1e-6
local function num(x) return string.format('%.6f', x) end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local kept = {}
local left = units
for x in string.gmatch(raw, '[^,]+') do
  local stamp = tonumber(x)
  if stamp + lease > now + TOL then
    if left > 0 and math.abs(stamp - start) <= TOL then
      left = left - 1
    else
      kept[#kept + 1] = stamp
    end
  end
end
if #kept == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], member)
  return units - left
end
local parts = {}
for i, stamp in ipairs(kept) do parts[i] = num(stamp) end
local free = kept[#kept] + lease
local ttl = math.ceil(free - now)
if ttl < 1 then ttl = 1 end
redis.call('SET', KEYS[1], table.concat(parts, ','), 'PX', ttl)
redis.call('ZADD', KEYS[2], num(free), member)
return units - left
`;

/** These options make a store of a limiter in Redis. */
export interface RedisLimiterOptions {
  /** This text starts the name of each key of the store in Redis, for example `limit:`. It has no braces. */
  readonly prefix: string;
  /**
   * This clock replaces `TIME` of the server, for a test that compares the store with `decide`. Without
   * it, the script reads `TIME`, thus each replica gets the one clock of the store.
   */
  readonly clock?: Clock | undefined;
}

/** A Redis client part is the part of a Redis client that the store uses: `send`. */
export type RedisSender = Pick<RedisClient, "send">;

/**
 * This function makes a store that the replicas share, in Redis 7. Each take is one `EVAL` of
 * `LIMITER_SCRIPT`, with all of its units. The client does not send it again, because a second take
 * counts two times.
 * - The names of the keys have the limiter in braces, a hash tag. Thus the state and the index of a
 *   limiter are in one slot of a Redis Cluster.
 * - Each state expires at the time that the key is free, thus the eviction is exact, as in the memory
 *   store. The index of the limiter bounds the count of busy keys to `maxKeys`.
 * - A reply of an error, an outcome that is not certain, or a reply of another shape rejects the
 *   take of the store. `keyedLimiter` then applies the `onStoreFailure` of the spec.
 * - `TIME` is the wall clock of the Redis host, not a monotonic clock. Thus a step of that clock
 *   moves the counts of each key. The replicas still share one clock.
 * - Each release is one `EVAL` of `LIMITER_RELEASE_SCRIPT`. The client does not send it again either,
 *   because a second release removes the units of another take at the same start.
 */
export const redisLimiterStore = (client: RedisSender, options: RedisLimiterOptions): RedisLimiterStore => {
  if (/[{}]/.test(options.prefix)) throw new Error(`the prefix ${options.prefix} of a limiter store has a brace: the store puts the hash tag in it`);
  return {
    kind: "shared",
    async take({ limiter, key, rule, maxKeys, units }): Promise<Decision> {
      const n = unitsOf(units);
      // a take over the capacity is refused at each time, thus it does not go to Redis
      const over = overCapacity(rule, n);
      if (over !== undefined) return over;
      const base = `${options.prefix}{${limiter}}`;
      const numbers = numbersOf(rule);
      const now = options.clock === undefined ? "" : String(options.clock.now());
      const sent = await client.send<unknown[]>("EVAL", [
        LIMITER_SCRIPT,
        2,
        `${base}:key:${key}`,
        `${base}:keys`,
        rule.type,
        String(numbers[0]),
        String(numbers[1]),
        String(maxKeys),
        key,
        now,
        String(n),
        rule.type === "in-flight" ? String(rule.retryAfter) : "",
      ]);
      if (sent.outcome !== "ok") throw new Error(`the limiter store ${limiter} failed (${sent.outcome}): ${sent.error}`);
      return replyOf(limiter, rule, n, sent.value);
    },
    async release({ limiter, key, rule, lease }): Promise<void> {
      // a rate policy holds no unit, thus its release does not go to Redis
      if (rule.type !== "in-flight") return;
      const base = `${options.prefix}{${limiter}}`;
      const now = options.clock === undefined ? "" : String(options.clock.now());
      const sent = await client.send<unknown>("EVAL", [
        LIMITER_RELEASE_SCRIPT,
        2,
        `${base}:key:${key}`,
        `${base}:keys`,
        String(rule.lease),
        key,
        now,
        String(lease.start),
        String(lease.units),
      ]);
      if (sent.outcome !== "ok") throw new Error(`the limiter store ${limiter} failed to release (${sent.outcome}): ${sent.error}`);
      const released = Number(sent.value);
      if (!Number.isSafeInteger(released) || released < 0 || released > lease.units)
        throw new Error(`the limiter store ${limiter} gave a reply that is not a count of released units: ${JSON.stringify(sent.value)}`);
    },
  };
};

/** A Redis limiter store is a shared store with a release, thus it keeps each policy, the in-flight bound too. */
export interface RedisLimiterStore extends LimiterStore {
  readonly kind: "shared";
  release(request: ReleaseRequest): Promise<void>;
}

/** This function gives the two numbers of a rule that `LIMITER_SCRIPT` takes after its type. */
const numbersOf = (rule: LimitRule): readonly [number, number] =>
  rule.type === "token-bucket" ? [rule.interval, rule.burst] : rule.type === "in-flight" ? [rule.limit, rule.lease] : [rule.limit, rule.window];

/** This function gives the decision of a reply of `LIMITER_SCRIPT` to a take of `units` units. A reply of another shape throws. */
const replyOf = (limiter: string, rule: LimitRule, units: number, reply: unknown): Decision => {
  const leased = rule.type === "in-flight";
  if (Array.isArray(reply) && Number(reply[0]) === 1 && reply.length === (leased ? 3 : 2)) {
    const remaining = Number(reply[1]);
    if (!leased) return { allowed: true, remaining };
    const start = Number(reply[2]);
    if (Number.isFinite(start)) return { allowed: true, remaining, lease: { start, units } };
  }
  if (Array.isArray(reply) && Number(reply[0]) === 0 && reply.length === 3 && (reply[2] === "limit" || reply[2] === "cap")) {
    const retryAfter = Number(reply[1]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return { allowed: false, retryAfter: { value: retryAfter, unit: "ms" }, cause: reply[2] };
  }
  throw new Error(`the limiter store ${limiter} gave a reply that is not a decision: ${JSON.stringify(reply)}`);
};
