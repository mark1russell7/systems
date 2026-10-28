// @mark1russell7/service/http: the edge of a service in Node, on node:http, node:http2 and node:net only.
// A server of node:http, or a server of node:http2 without TLS (h2c), becomes a transport of the
// lifecycle: its count of work in flight, the stop of its intake, its drain and its close. On HTTP/2,
// a close of a connection is a GOAWAY on its session. A short list of mounts shares its port among request handlers and
// upgrade handlers. The probes answer on a port of their own, or on the port of the application, and
// the option `kinds` names the probes that answer there (`PROBE_KINDS` by default).
// `handle` binds a request to `life.request`, and the stream of the request becomes a status, a
// Retry-After, a Connection: close and a body, unary or a stream. A take that a keyed limiter refuses
// becomes 429 with Retry-After in whole seconds (`limitedResponse`). It is not a framework: it has no
// routing language, no body parser and no middleware.

export type {
  EdgeServer,
  HttpKnobs,
  HttpTransport,
  HttpTransportKnobs,
  HttpTransportOptions,
  MountContext,
  MountOptions,
  MountStage,
  RequestHandler,
  UpgradeHandler,
  UpgradeMatch,
  UpgradeSocket,
} from "./http/transport.ts";
export { httpTransport, pathOf } from "./http/transport.ts";
export type { ProbeKind } from "./health.ts";
export type { HealthSource, ProbeHandlerOptions, ProbePaths, ProbeResponse, ProbeServer, ProbeServerOptions } from "./http/probes.ts";
export { PROBE_KINDS, probeHandler, probeResponse, probeServer } from "./http/probes.ts";
export type {
  HandleOptions,
  HandledRoute,
  HandledWork,
  OutcomeOptions,
  OutcomeResponse,
  ResponsePart,
  StreamFormat,
} from "./http/outcome.ts";
export { endRecord, handle, limitedResponse, ndjson, outcomeResponse, sse, writeOutcome } from "./http/outcome.ts";
