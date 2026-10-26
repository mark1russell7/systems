// @mark1russell7/service/rabbitmq: the RabbitMQ client of a service, over amqplib 2. Its call is a
// confirmed publish, or an RPC with a reply such as `basic.get`. It declares its knobs by the names
// of the ordering law, and the manifestations that it can meet with their detectors. It gives the
// health runtime a check for each step of its connection, the lifecycle its bounded close, and a
// queue drain its source and its settle. amqplib is an optional peer dependency: the client loads
// it only when it connects. The parts that each client has come from the core of the clients (`src/client/`).

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
  ReadyWait,
  RetryKnobs,
  SendOptions,
  Sent,
} from "./client/core.ts";
export { STARTING_POLL, readyWait, retryBackoff, retryProblems } from "./client/core.ts";
export type { Detector, Manifestation, Meeting, Situation } from "./client/meets.ts";
export { MANIFESTATIONS, firstDetector, unwatched } from "./client/meets.ts";
export type {
  RabbitClient,
  RabbitClientOptions,
  RabbitClientSpec,
  RabbitDelivery,
  RabbitJobs,
  RabbitJoin,
  RabbitKnobs,
  RabbitPublish,
  RabbitSeed,
} from "./rabbitmq/client.ts";
export { AMQP_HEADER, amqpDial, deliveryCount, failureOutcome, rabbitClient, rabbitOptions, specProblems, startJudge } from "./rabbitmq/client.ts";
export type {
  RabbitChannel,
  RabbitChannelEvent,
  RabbitConnectOptions,
  RabbitConnection,
  RabbitConnectionEvent,
  RabbitFactory,
  RabbitMessage,
  RabbitPublishOptions,
  RabbitSocketOptions,
} from "./rabbitmq/connection.ts";
export { nodeAmqp } from "./rabbitmq/connection.ts";
export { RABBIT_CLIENT_MACHINE } from "./rabbitmq/machine.ts";
export { rabbitMeetings } from "./rabbitmq/meets.ts";
export { RABBIT_STARTING_KNOBS, RABBIT_STARTING_POLL } from "./rabbitmq/starting.ts";
