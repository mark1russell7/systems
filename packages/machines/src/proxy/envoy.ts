import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The source of each fact below is github.com/envoyproxy/envoy at the tag v1.39.4 (commit 72315c132d46),
// with its HTTP/2 codec on nghttp2 1.66.0. Each line number is a line of that file at the tag. The short
// names: cm.cc is source/common/http/conn_manager_impl.cc, router.cc is source/common/router/router.cc,
// hutil.cc is source/common/http/utility.cc, h2.cc is source/common/http/http2/codec_impl.cc.
const AT = "envoy v1.39.4";

/**
 * This document is Envoy 1.39.4 as an HTTP/2 proxy of gRPC, for one connection of a client. Its static
 * configuration is the one of the harness. It has one listener with the HTTP connection manager, one
 * route with no timeout of its own, and one cluster of h2c. Each other field is at its default.
 *
 * Envoy answers a failure of its upstream itself. Before the headers of the response, it sends a local
 * reply: a gRPC response of trailers only, with a status from the HTTP code (503 and 504 give UNAVAILABLE).
 * After the headers, it resets the stream with INTERNAL_ERROR. It retries no call at the defaults. The
 * route ends each call 15 s after the end of its request. Envoy sets no keepalive of HTTP/2 or of TCP. At
 * SIGTERM it closes each connection with no GOAWAY.
 */
export const ENVOY_HTTP2: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "envoy-http2",
  title: "Envoy 1.39.4 as an HTTP/2 proxy of gRPC: one connection of a client, its streams to one cluster, the local replies and the close",
  layer: "proxy",
  version: "1.39.4",
  conditions: {
    envoy: "v1.39.4",
    codec: "nghttp2 1.66.0",
    configuration: "one listener with the HTTP connection manager and the router, one route with no timeout, retry or max_stream_duration, and one STATIC cluster with http2_protocol_options",
  },
  sources: [
    { ref: `${AT} source/common/runtime/runtime_features.cc:274-276 the codec of HTTP/2 is nghttp2: http2_use_oghttp2 is false`, rung: "implemented" },
    { ref: `${AT} hutil.cc:746-777, :805-808 a local reply to a gRPC request is a response of trailers only: :status 200, grpc-status and grpc-message`, rung: "implemented" },
    { ref: `${AT} source/common/grpc/status.cc:6-26 the status of an HTTP code: 429, 502, 503 and 504 give UNAVAILABLE, and an unknown code gives UNKNOWN`, rung: "implemented" },
    { ref: `${AT} source/common/http/filter_manager.cc:1120-1127, cm.cc:301-313 and h2.cc:193-199 after the headers of the response, a local reply resets the stream with INTERNAL_ERROR`, rung: "implemented" },
    { ref: `${AT} api/envoy/config/route/v3/route_components.proto:1373-1384 and source/common/router/config_impl.h:976 the timeout of a route: 15 s when it is not given`, rung: "implemented" },
    {
      ref: `${AT} router.cc:180-266, :1309-1331, :1530-1572 the timer of the route starts at the end of the request, and its end gives the local reply 504 "upstream request timeout". The flag grpc_timeout_returns_deadline_exceeded is false (runtime_features.cc:242-244)`,
      rung: "implemented",
    },
    { ref: `${AT} route_components.proto:1114-1118 and cm.cc:1731-1772 Envoy reads grpc-timeout only with grpc_timeout_header_max. At the defaults it forwards the header and does not act on it`, rung: "implemented" },
    {
      ref: `${AT} source/common/http/codec_client.cc:124-144 and router.cc:1574-1581, :1681-1712 a reset of the upstream connection resets each stream on it with ConnectionTermination. With no retry policy, the router sends the local reply 503 "upstream connect error or disconnect/reset before headers. reset reason: connection termination"`,
      rung: "implemented",
    },
    { ref: `${AT} source/common/router/retry_state_impl.cc:28-47 a route with no retry_on, and a request with no x-envoy-retry-on, get no retry state`, rung: "implemented" },
    { ref: `${AT} source/common/upstream/upstream_impl.cc:1206-1207 the connect timeout of a cluster: 5 s. Its end gives the local reply 503 with the reset reason connection timeout`, rung: "implemented" },
    { ref: `${AT} source/extensions/filters/network/http_connection_manager/config.h:372-377 and config.cc:404-425, :488-492 the defaults of the HTTP connection manager: stream_idle_timeout 5 min, request_timeout off, drain_timeout 5 s, delayed_close_timeout 1 s, idle_timeout 1 h`, rung: "implemented" },
    { ref: `${AT} cm.cc:968-974, :1052-1069 the idle timer of a stream: each frame of the stream arms it again. Its end gives the local reply 504 "stream timeout" for a request that is complete`, rung: "implemented" },
    {
      ref: `${AT} cm.cc:207-212, :1699-1705, :819-824 and h2.cc:1176-1193 the idle timer of a connection runs only with no stream open. Its end sends GOAWAY NO_ERROR as a notice, then after drain_timeout the final GOAWAY and the close`,
      rung: "implemented",
    },
    { ref: `${AT} api/envoy/config/core/v3/protocol.proto:538-569 and h2.cc:1013-1029 no PING of HTTP/2 from Envoy when connection_keepalive is not given`, rung: "implemented" },
    { ref: `${AT} source/common/listener_manager/listener_impl.cc:405-416 and upstream_impl.cc:223-228 no SO_KEEPALIVE on a socket when tcp_keepalive is not given. No TCP_USER_TIMEOUT anywhere`, rung: "implemented" },
    {
      ref: `${AT} source/server/server.cc:1005-1014, :1097-1127 and source/common/listener_manager/active_tcp_listener.cc:54-63 SIGTERM shuts down the server: each worker closes each connection with NoFlush. No GOAWAY and no timer of the drain`,
      rung: "implemented",
    },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the accept of the connection of the client" },
    idle: { note: "The connection of the client, with no stream open. The idle timer of the connection runs" },
    active: { note: "A stream of the client is open: its request goes to the cluster" },
    draining: { note: "After the GOAWAY notice of an idle connection, until its final GOAWAY" },
    ended: { final: true, note: "The connection of the client closed" },
  },
  events: {
    "local.accept": { kind: "local", note: "The listener accepts the connection of the client" },
    "rx.headers": { kind: "rx", note: "The headers of a new stream of the client: a call" },
    "rx.request-end": { kind: "rx", note: "The end of the request of the stream (END_STREAM): a unary call sends it at once" },
    "rx.frame": { kind: "rx", note: "Any frame of the stream, in either direction" },
    "upstream.connect-timeout": { kind: "local", note: "The connect to the cluster does not complete in connect_timeout" },
    "upstream.headers": { kind: "local", note: "The headers of the response of the upstream go to the client" },
    "upstream.end": { kind: "local", note: "The response of the upstream ends with its status: the stream closes" },
    "upstream.reset": { kind: "local", note: "The upstream connection ends with a reset or an end of file while the stream waits: ConnectionTermination" },
    "timer.route": { kind: "timer", note: "The timeout of the route ends after the end of the request" },
    "timer.stream-idle": { kind: "timer", note: "No frame of the stream for stream_idle_timeout" },
    "timer.idle": { kind: "timer", note: "No stream open for idle_timeout" },
    "timer.drain": { kind: "timer", note: "drain_timeout after the GOAWAY notice" },
    "app.stop": { kind: "app", note: "SIGTERM or SIGINT to the process of Envoy" },
    "peer.fin": { kind: "peer", note: "The client ends the connection" },
    "peer.rst": { kind: "peer", note: "A reset of the connection of the client" },
    "tx.local-reply": { kind: "tx", note: "A response of trailers only with the gRPC status of the HTTP code, before the headers of a response" },
    "tx.rst-stream": { kind: "tx", note: "RST_STREAM INTERNAL_ERROR of a stream whose response headers went out" },
    "tx.goaway": { kind: "tx", note: "A GOAWAY NO_ERROR to the client" },
    "tx.fin": { kind: "tx", note: "The close of the connection of the client: a FIN" },
  },
  knobs: {
    route_timeout: { key: "RouteAction.timeout", scope: "server", unit: "s", default: 15, off: 0, note: "config_impl.h:976: 15 s. 0 turns it off" },
    stream_idle_timeout: { key: "HttpConnectionManager.stream_idle_timeout", scope: "server", unit: "s", default: 300, off: 0, note: "config.h:372-373: 5 min" },
    idle_timeout: { key: "HttpConnectionManager.common_http_protocol_options.idle_timeout", scope: "server", unit: "s", default: 3600, off: 0, note: "config.cc:488-492: 1 h" },
    drain_timeout: { key: "HttpConnectionManager.drain_timeout", scope: "server", unit: "s", default: 5, note: "config.cc:411: 5000 ms" },
    connect_timeout: { key: "Cluster.connect_timeout", scope: "server", unit: "s", default: 5, note: "upstream_impl.cc:1206-1207: 5 s" },
    slack: { key: "the lateness of the event loop of a worker of Envoy for one step", scope: "process", unit: "s", default: 0.01, note: "An assumption of this document, not a value of Envoy" },
    hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null, note: "The build option of the kernel" },
  },
  timers: {
    route: {
      duration: { knob: "route_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["rx.request-end"],
      cancels: ["upstream.end", "upstream.reset", "peer.rst", "peer.fin"],
      fires: "timer.route",
      note: "router.cc:1309-1331: from the end of the request. A stream that does not end its request never starts it",
    },
    stream_idle: {
      duration: { knob: "stream_idle_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["rx.headers", "rx.frame"],
      cancels: ["upstream.end", "upstream.reset", "peer.rst", "peer.fin"],
      fires: "timer.stream-idle",
      note: "cm.cc:968-974: each frame of the stream arms it again",
    },
    idle: {
      duration: { knob: "idle_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:idle"],
      cancels: ["rx.headers"],
      fires: "timer.idle",
      note: "cm.cc:207-212, :398-400: only with no stream open. A PING does not arm it again",
    },
    drain: {
      duration: { knob: "drain_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["timer.idle"],
      fires: "timer.drain",
      note: "cm.cc:1699-1705: from the GOAWAY notice",
    },
  },
  transitions: [
    { id: "env.accept", from: "[none]", to: "idle", on: "local.accept", timer: "idle", source: "source/common/listener_manager/active_tcp_listener.cc" },
    { id: "env.stream", from: "idle", to: "active", on: "rx.headers", timer: "stream_idle", source: "cm.cc:968-974" },
    { id: "env.request-end", from: "active", to: "active", on: "rx.request-end", timer: "route", source: "router.cc:1309-1331" },
    { id: "env.replied", from: "active", to: "idle", on: "upstream.end", note: "The status of the upstream passes to the client unchanged", source: "router.cc" },
    {
      id: "env.upstream-reset",
      from: "active",
      to: "idle",
      on: "upstream.reset",
      guard: "no headers of the response went to the client",
      errno: "UNAVAILABLE",
      emits: ["tx.local-reply"],
      note: "503 upstream connect error or disconnect/reset before headers. reset reason: connection termination, as trailers only with grpc-status 14. No retry",
      source: "codec_client.cc:124-144, router.cc:1574-1581, :1681-1712",
    },
    {
      id: "env.upstream-reset-streaming",
      from: "active",
      to: "idle",
      on: "upstream.reset",
      guard: "the headers of the response went to the client",
      errno: "INTERNAL",
      emits: ["tx.rst-stream"],
      source: "filter_manager.cc:1120-1127, cm.cc:301-313",
    },
    {
      id: "env.route-timeout",
      from: "active",
      to: "idle",
      on: "timer.route",
      timer: "route",
      errno: "UNAVAILABLE",
      emits: ["tx.local-reply"],
      note: "504 upstream request timeout. The upstream stream is reset",
      source: "router.cc:1530-1572",
    },
    {
      id: "env.stream-idle",
      from: "active",
      to: "idle",
      on: "timer.stream-idle",
      timer: "stream_idle",
      errno: "UNAVAILABLE",
      emits: ["tx.local-reply"],
      note: "504 stream timeout for a request that is complete. A request that is still open gets 408, thus UNKNOWN",
      source: "cm.cc:1052-1069, hutil.cc:1535-1540",
    },
    {
      id: "env.connect-timeout",
      from: "active",
      to: "idle",
      on: "upstream.connect-timeout",
      errno: "UNAVAILABLE",
      emits: ["tx.local-reply"],
      note: "503 with the reset reason connection timeout",
      source: "upstream_impl.cc:1206-1207, router.cc:1681-1712",
    },
    { id: "env.idle", from: "idle", to: "draining", on: "timer.idle", timer: "idle", emits: ["tx.goaway"], note: "The GOAWAY notice: last-stream-id 2^31 − 1", source: "cm.cc:1699-1705, h2.cc:1176-1193" },
    { id: "env.drained", from: "draining", to: "ended", on: "timer.drain", timer: "drain", emits: ["tx.goaway", "tx.fin"], source: "cm.cc:819-824" },
    {
      id: "env.stop",
      from: ["idle", "active", "draining"],
      to: "ended",
      on: "app.stop",
      emits: ["tx.fin"],
      note: "No GOAWAY: the close of a connection with NoFlush. A call in flight ends with the close",
      source: "server.cc:1005-1014, active_tcp_listener.cc:54-63",
    },
    { id: "env.client-end", from: ["idle", "active", "draining"], to: "ended", on: ["peer.fin", "peer.rst"], source: "source/common/network/connection_impl.cc:804-819" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { idle: "ESTABLISHED", active: "ESTABLISHED", draining: "ESTABLISHED" },
    sets: {},
    ends: "peer.rst",
    note: "The socket toward the client: a Linux TCP socket with TCP_NODELAY and no keepalive. The socket toward the cluster is the same",
  },
});
