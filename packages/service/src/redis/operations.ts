import type { Operation } from "../operation.ts";

/**
 * These are the Redis commands whose idempotency the client declares when the declaration does not
 * say. A second issue of an idempotent command has the same effect. Thus the client can send it
 * again after a failure that left its result unknown. The client does not send again a command
 * that is not in this table: a declaration that uses it says its idempotency itself.
 */
const SAME_EFFECT = [
  // reads
  "PING",
  "ECHO",
  "GET",
  "MGET",
  "STRLEN",
  "GETRANGE",
  "EXISTS",
  "TYPE",
  "TTL",
  "PTTL",
  "EXPIRETIME",
  "HGET",
  "HMGET",
  "HGETALL",
  "HKEYS",
  "HVALS",
  "HLEN",
  "HEXISTS",
  "SMEMBERS",
  "SISMEMBER",
  "SMISMEMBER",
  "SCARD",
  "ZRANGE",
  "ZRANGEBYSCORE",
  "ZSCORE",
  "ZMSCORE",
  "ZRANK",
  "ZCARD",
  "ZCOUNT",
  "LRANGE",
  "LINDEX",
  "LLEN",
  "XRANGE",
  "XREVRANGE",
  "XLEN",
  "SCAN",
  "SSCAN",
  "HSCAN",
  "ZSCAN",
  "DBSIZE",
  "INFO",
  "CLIENT ID",
  // writes that put a state, not a change of a state: a second issue puts the same state
  "SET",
  "MSET",
  "SETEX",
  "PSETEX",
  "DEL",
  "UNLINK",
  "EXPIRE",
  "PEXPIRE",
  "EXPIREAT",
  "PEXPIREAT",
  "PERSIST",
  "HSET",
  "HDEL",
  "SADD",
  "SREM",
  "ZADD",
  "ZREM",
];

/**
 * These commands change a state relative to the state before them. A second issue changes it again:
 * an INCR that the client sends again after a timeout counts two times.
 */
const CHANGE = [
  "INCR",
  "INCRBY",
  "INCRBYFLOAT",
  "DECR",
  "DECRBY",
  "HINCRBY",
  "HINCRBYFLOAT",
  "ZINCRBY",
  "APPEND",
  "LPUSH",
  "RPUSH",
  "LPOP",
  "RPOP",
  "BLPOP",
  "BRPOP",
  "LMOVE",
  "BLMOVE",
  "SPOP",
  "XADD",
  "XACK",
  "PUBLISH",
  "EVAL",
  "EVALSHA",
  "FCALL",
  "MULTI",
  "EXEC",
  "GETDEL",
  "GETSET",
  "SETNX",
];

/** These are the operations of the client: the idempotency of each command that the table names. */
export const REDIS_OPERATIONS: Readonly<Record<string, Operation>> = Object.fromEntries([
  ...SAME_EFFECT.map((command) => [command, { idempotent: true }] as const),
  ...CHANGE.map((command) => [command, { idempotent: false }] as const),
]);

/** This function gives the name of a command as the table writes it: upper case, and CLIENT ID with its subcommand. */
export const commandName = (command: string, args: readonly unknown[]): string => {
  const name = command.toUpperCase();
  if ((name === "CLIENT" || name === "CONFIG" || name === "DEBUG") && typeof args[0] === "string")
    return `${name} ${args[0].toUpperCase()}`;
  return name;
};
