// @mark1russell7/service/pg: the PostgreSQL client of a service, over a pool of node-postgres 8.
// It declares its knobs by the names of the ordering law, its queries with their idempotency, and
// the manifestations that it can meet with their detectors. It gives the health runtime a check
// for each step of its connection, and the lifecycle its bounded close. pg is an optional peer
// dependency: the client loads it only when it connects.

export type { Attempt, CheckOptions, ClientStep, DialFn, SendOptions, Sent } from "./client/core.ts";
export type { Detector, Meeting, Situation } from "./client/meets.ts";
export { firstDetector, unwatched } from "./client/meets.ts";
export type { PgClient, PgClientOptions, PgClientSpec, PgJoin, PgKnobs, PgStep } from "./pg/client.ts";
export { pgClient, poolOptions, specProblems, sslRequestDial } from "./pg/client.ts";
export type { PgPool, PgPoolClient, PgPoolOptions, PgResult, PgSocket, PoolFactory } from "./pg/connection.ts";
export { nodePostgres } from "./pg/connection.ts";
export { PG_CLIENT_MACHINE } from "./pg/machine.ts";
export { pgMeetings } from "./pg/meets.ts";
export { PG_STARTING_KNOBS, PG_STARTING_POLL } from "./pg/starting.ts";
