// @mark1russell7/service/redis: the Redis client of a service, over ioredis 6. It declares its
// knobs by the names of the ordering law, its operations with their idempotency, and the
// manifestations that it can meet with their detectors. It gives the health runtime a check for
// each step of its connection, and the lifecycle its bounded close. `redisLimiterStore` keeps the
// counts of a keyed limiter in Redis, for the replicas of a service. ioredis is an optional peer
// dependency: the client loads it only when it connects.

export type {
  CheckOptions,
  ClientStep,
  DialFn,
  Join,
  RedisClient,
  RedisClientOptions,
  RedisClientSpec,
  RedisKnobs,
  Sent,
} from "./redis/client.ts";
export { redisClient, retryBackoff, specProblems, tcpDial } from "./redis/client.ts";
// the detection time of the watchdog moved to the root of the package: this entry keeps it for the users of 0.3
export { heartbeatDetection } from "./timing.ts";
export type { ConnectionFactory, RedisConnection, RedisConnectionOptions, RedisSocket } from "./redis/connection.ts";
export { ioredis } from "./redis/connection.ts";
export type { Detector, Meeting, Situation } from "./redis/meets.ts";
export { firstDetector, meetings, unwatched } from "./redis/meets.ts";
export type { RedisLimiterOptions, RedisSender } from "./redis/limiter.ts";
export { LIMITER_SCRIPT, redisLimiterStore } from "./redis/limiter.ts";
export { REDIS_CLIENT_MACHINE } from "./redis/machine.ts";
export { REDIS_OPERATIONS, commandName } from "./redis/operations.ts";
