// @mark1russell7/service/websocket: the WebSocket client of a service, over ws 8. Its calls are a
// request until its reply, and a ping frame until its pong. Its heartbeat sends a ping frame each
// interval, and `terminate()` destroys the socket at the last miss. It declares its knobs by the names
// of the ordering law, and the manifestations that it can meet with their detectors. It gives the
// health runtime a check for each step of its connection, and the lifecycle its bounded close. ws is
// an optional peer dependency: the client loads it only when it connects. The parts that each client
// has come from the core of the clients (`src/client/`).

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
  RetrySchedule,
  SendOptions,
  Sent,
} from "./client/core.ts";
export { STARTING_POLL, readyWait, retryBackoff, retryProblems, retrySchedule } from "./client/core.ts";
export type { Judge } from "./client/dial.ts";
export { statusLineJudge } from "./client/dial.ts";
export type { Detector, Manifestation, Meeting, Situation } from "./client/meets.ts";
export { MANIFESTATIONS, firstDetector, unwatched } from "./client/meets.ts";
export type {
  WsClient,
  WsClientOptions,
  WsClientSpec,
  WsJoin,
  WsKnobs,
  WsMessageListener,
  WsReplies,
  WsReply,
  WsRequest,
  WsResponse,
} from "./websocket/client.ts";
export { WS_OPERATIONS, specProblems, upgradeJudge, upgradeRequest, wsClient, wsDial, wsOptions, wsUrl } from "./websocket/client.ts";
export type { WsConnectOptions, WsConnection, WsDriverOptions, WsFactory, WsListeners } from "./websocket/connection.ts";
export { adaptWs, nodeWs } from "./websocket/connection.ts";
export { WS_CLIENT_MACHINE } from "./websocket/machine.ts";
export { wsMeetings } from "./websocket/meets.ts";
export { WS_CLIENT_STARTING_KNOBS, WS_CLIENT_STARTING_MISSES, WS_CLIENT_STARTING_POLL } from "./websocket/starting.ts";
