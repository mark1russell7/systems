// @mark1russell7/service/redis: the Redis client of a service, over ioredis 6. It declares its
// knobs by the names of the ordering law, its operations with their idempotency, and the
// manifestations that it can meet with their detectors. It gives the health runtime a check for
// each step of its connection, and the lifecycle its bounded close. ioredis is an optional peer
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
export { heartbeatDetection, redisClient, specProblems, tcpDial } from "./redis/client.ts";
export type { ConnectionFactory, RedisConnection, RedisConnectionOptions, RedisSocket } from "./redis/connection.ts";
export { ioredis } from "./redis/connection.ts";
export type { Detector, Meeting, Situation } from "./redis/meets.ts";
export { firstDetector, meetings, unwatched } from "./redis/meets.ts";
export { REDIS_CLIENT_MACHINE } from "./redis/machine.ts";
export { REDIS_OPERATIONS, commandName } from "./redis/operations.ts";
