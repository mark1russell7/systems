// @mark1russell7/service/mongodb: the MongoDB client of a service, over a MongoClient of the driver 7.
// It declares its knobs by the names of the ordering law, its commands with their idempotency, and
// the manifestations that it can meet with their detectors. It gives the health runtime a check
// for each step of its connection, and the lifecycle its bounded close. mongodb is an optional peer
// dependency: the client loads it only when it connects. The parts that each client has come from
// the core of the clients (`src/client/`), which the Redis and pg entries use too.

export type {
  Attempt,
  CheckOptions,
  Client,
  ClientJoin,
  ClientKnobs,
  ClientOptions,
  ClientSocket,
  ClientSpec,
  ClientStep,
  DialFn,
  Factory,
  SendOptions,
  Sent,
} from "./client/core.ts";
export { STARTING_POLL } from "./client/core.ts";
export type { Detector, Manifestation, Meeting, Situation } from "./client/meets.ts";
export { MANIFESTATIONS, firstDetector, unwatched } from "./client/meets.ts";
export type { MongoClient, MongoClientOptions, MongoClientSpec, MongoJoin, MongoKnobs, MongoSeed, MongoStep } from "./mongodb/client.ts";
export { HELLO, failureOutcome, helloCommandDial, helloJudge, mongoClient, mongoOptions, specProblems } from "./mongodb/client.ts";
export type {
  MongoConnectOptions,
  MongoDb,
  MongoDocument,
  MongoDriverClient,
  MongoDriverOptions,
  MongoEventName,
  MongoEvents,
  MongoFactory,
  MongoServer,
} from "./mongodb/connection.ts";
export { nodeMongo } from "./mongodb/connection.ts";
export { MONGO_CLIENT_MACHINE } from "./mongodb/machine.ts";
export { mongoMeetings } from "./mongodb/meets.ts";
export { MONGO_STARTING_KNOBS, MONGO_STARTING_POLL } from "./mongodb/starting.ts";
