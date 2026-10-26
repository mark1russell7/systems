// @mark1russell7/service/grpc: the gRPC client of a service, over grpc-js 1.14. Its call is one
// unary call until its status, and its outcome comes from the status code. The retries of grpc-js are
// off, thus only the core sends a call again. Its keepalive is the HTTP/2 PING of grpc-js. It declares
// its knobs by the names of the ordering law, and the manifestations that it can meet with their
// detectors. It gives the health runtime a check for each step of its connection, and the lifecycle
// its bounded close. The grpc-js driver is an optional peer dependency: the client loads it only when it
// connects. The parts that each client has come from the core of the clients (`src/client/`).

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
export { STARTING_POLL, readyWait, retryProblems } from "./client/core.ts";
export type { Judge } from "./client/dial.ts";
export type { Detector, Manifestation, Meeting, Situation } from "./client/meets.ts";
export { MANIFESTATIONS, firstDetector, unwatched } from "./client/meets.ts";
export type {
  GrpcCallOptions,
  GrpcClient,
  GrpcClientOptions,
  GrpcClientSpec,
  GrpcIdempotencyLevel,
  GrpcJoin,
  GrpcKnobs,
  GrpcServingStatus,
} from "./grpc/client.ts";
export {
  GRPC_CODES,
  GRPC_OPERATIONS,
  HEALTH_CHECK,
  HTTP2_PREFACE,
  codeName,
  grpcClient,
  grpcDial,
  grpcOperations,
  grpcOptions,
  grpcOutcome,
  grpcTarget,
  healthRequest,
  healthStatus,
  settingsJudge,
  specProblems,
} from "./grpc/client.ts";
export type { GrpcCallHandle, GrpcChannel, GrpcChannelOptions, GrpcConnectOptions, GrpcFactory, GrpcState, GrpcStatus } from "./grpc/connection.ts";
export { GRPC_STATES, adaptGrpc, nodeGrpc } from "./grpc/connection.ts";
export { GRPC_CLIENT_MACHINE } from "./grpc/machine.ts";
export { grpcMeetings } from "./grpc/meets.ts";
export { GRPC_CLIENT_STARTING_KNOBS, GRPC_CLIENT_STARTING_POLL, GRPC_CLIENT_STARTING_WITHOUT_CALLS } from "./grpc/starting.ts";
