import type { Clock } from "../clock.ts";
import type { Decision } from "../limiter/policy.ts";
import type { LimiterStore } from "../limiter/store.ts";
import type { RedisClient } from "./client.ts";

/**
 * This script decides one take in one atomic step of Redis. It does the arithmetic of `decide`, and
 * it reads `TIME` of the server, the one clock of all replicas. A test can give the time in its place.
 * - KEYS[1] is the state of the key. KEYS[2] is the index of the limiter, a sorted set of its keys
 *   by the time at which each key is free.
 * - ARGV is the type of the rule, its two numbers, the cap of keys, the key, and the time or "".
 * - The state of a bucket is its full time. The state of a window is the time of each take in it.
 * - The state expires at its free time (PX), and the index lets the cap count only busy keys.
 * - The reply is `{1, remaining}`, or `{0, retryAfter, cause}` with the time as text. Redis gives
 *   each Lua number as a whole number, thus the fraction of a millisecond goes as text.
 */
export const LIMITER_SCRIPT = `
local kind = ARGV[1]
local a = tonumber(ARGV[2])
local b = tonumber(ARGV[3])
local cap = tonumber(ARGV[4])
local member = ARGV[5]
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
  local nxt = base + a
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
  if #live >= a then
    return {0, num(live[1] + b - now), 'limit'}
  end
  live[#live + 1] = now
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
return {1, remaining}
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
 * `LIMITER_SCRIPT`. The client does not send it again, because a second take counts two times.
 * - The names of the keys have the limiter in braces, a hash tag. Thus the state and the index of a
 *   limiter are in one slot of a Redis Cluster.
 * - Each state expires at the time that the key is free, thus the eviction is exact, as in the memory
 *   store. The index of the limiter bounds the count of busy keys to `maxKeys`.
 * - A reply of an error, an outcome that is not certain, or a reply of another shape rejects the
 *   take of the store. `keyedLimiter` then applies the `onStoreFailure` of the spec.
 * - `TIME` is the wall clock of the Redis host, not a monotonic clock. Thus a step of that clock
 *   moves the counts of each key. The replicas still share one clock.
 */
export const redisLimiterStore = (client: RedisSender, options: RedisLimiterOptions): LimiterStore => {
  if (/[{}]/.test(options.prefix)) throw new Error(`the prefix ${options.prefix} of a limiter store has a brace: the store puts the hash tag in it`);
  return {
    kind: "shared",
    async take({ limiter, key, rule, maxKeys }): Promise<Decision> {
      const base = `${options.prefix}{${limiter}}`;
      const numbers = rule.type === "token-bucket" ? [rule.interval, rule.burst] : [rule.limit, rule.window];
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
      ]);
      if (sent.outcome !== "ok") throw new Error(`the limiter store ${limiter} failed (${sent.outcome}): ${sent.error}`);
      return replyOf(limiter, sent.value);
    },
  };
};

/** This function gives the decision of a reply of `LIMITER_SCRIPT`. A reply of another shape throws. */
const replyOf = (limiter: string, reply: unknown): Decision => {
  if (Array.isArray(reply) && Number(reply[0]) === 1 && reply.length === 2) return { allowed: true, remaining: Number(reply[1]) };
  if (Array.isArray(reply) && Number(reply[0]) === 0 && reply.length === 3 && (reply[2] === "limit" || reply[2] === "cap")) {
    const retryAfter = Number(reply[1]);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return { allowed: false, retryAfter: { value: retryAfter, unit: "ms" }, cause: reply[2] };
  }
  throw new Error(`the limiter store ${limiter} gave a reply that is not a decision: ${JSON.stringify(reply)}`);
};
