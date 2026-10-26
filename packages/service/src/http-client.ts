// @mark1russell7/service/http-client: the HTTP client of a service, over an http.Agent of Node with
// keep-alive. The entry `./http` is the server edge of a service, thus this entry has another name.
// Its call is one request until the end of the body of its response. It declares its knobs by the
// names of the ordering law, and the manifestations that it can meet with their detectors. It gives
// the health runtime a check for each step of its connection, and the lifecycle its bounded close.
// node:http is a built-in, thus the entry has no peer dependency. The client loads node:http only
// when it connects. The parts that each client has come from the core of the clients (`src/client/`).

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
export type { CheckRequest, HttpCall, HttpClient, HttpClientKnobs, HttpClientOptions, HttpClientSpec } from "./http-client/client.ts";
export {
  HTTP_OPERATIONS,
  OPTIONS_STAR,
  agentOptions,
  httpClient,
  httpDial,
  optionsRequest,
  specProblems,
  statusJudge,
} from "./http-client/client.ts";
export type {
  AgentEvents,
  AgentExchange,
  AgentFactory,
  AgentRequest,
  HttpAgent,
  HttpAgentOptions,
  HttpResponse,
  HttpSocket,
} from "./http-client/connection.ts";
export { nodeAgent } from "./http-client/connection.ts";
export { HTTP_CLIENT_MACHINE } from "./http-client/machine.ts";
export { httpClientMeetings } from "./http-client/meets.ts";
export { HTTP_CLIENT_STARTING_KNOBS, HTTP_CLIENT_STARTING_POLL } from "./http-client/starting.ts";
// The session check of an HTTP/2 client: a stream timeout or a PING with no ACK closes the session.
// It reads a session by its shape, thus the entry does not load node:http2.
export type { H2Session, SessionCheck, SessionCheckKnobs, SessionCheckOptions, SessionClose } from "./http-client/session.ts";
export { SESSION_CHECK_CLOSE, sessionCheck, sessionCheckDetection, sessionCheckProblems } from "./http-client/session.ts";
