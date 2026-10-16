import type { Expr, Machine } from "@mark1russell7/algebra";
import { NODE_TIMER_EARLY, nodeTimerLateness } from "./http/timers.ts";

/**
 * This module holds the machine documents of the WebSocket transport of `@procedures/client`
 * 0.2.3, the release on npm. Each fact comes from the files of that release, or from Node v24.21.0
 * and its undici 7.29.1. The comments and the sources give the file and the line.
 *
 * The client repository has a document of the connection on its main branch at commit 1f50f47:
 * `WEBSOCKET_CONNECTION_MACHINE` in `packages/client/src/machines.ts`. That document holds misses,
 * jitter and a timer of the handshake, which 0.2.3 does not have. Thus this document takes the
 * states and the events of that document, and the timers come from the code of 0.2.3.
 */

/** This text is the wait of try n + 1 of the reconnect, in ms: `fired` is n. It reads the arithmetic of `scheduleReconnect`. */
const RECONNECT_WAIT = "min(reconnect_initial_delay * pow(reconnect_backoff_multiplier, fired), reconnect_max_delay)";

/**
 * This document is the connection of the WebSocket client of `@procedures/client` 0.2.3
 * (`WebSocketTransport`), over the WebSocket of Node 24.21.0 and its Linux TCP socket.
 *
 * - The heartbeat is a `setInterval` of the interval. A tick sends a ping only when no pong is
 *   awaited. Then a `setTimeout` of the timeout drops the connection, unless a pong comes first.
 *   Thus the drop comes one timeout after the ping that got no answer, with one miss.
 * - A drop writes a close frame and leaves the socket. The close frame destroys nothing, thus the
 *   socket stays ESTABLISHED below until its peer or its kernel ends it.
 * - Each end of a socket starts the reconnect. The wait of try n is
 *   min(initialDelay × multiplier^(n − 1), maxDelay), with no jitter. An open sets n to 0.
 */
export const PROCEDURES_WS_CLIENT: Machine = {
  format: "mark1russell7.machine/1",
  id: "procedures-ws-client",
  title: "The connection of the WebSocket client of @procedures/client 0.2.3",
  layer: "driver",
  version: "0.2.3",
  conditions: { "@procedures/client": "0.2.3", node: "24.21.0", undici: "7.29.1", kernel: "Linux 6.6" },
  sources: [
    {
      ref: "@procedures/client 0.2.3 dist/adapters/websocket/client/transport.js:99-124 (initialDelay 1000, maxDelay 30000, backoffMultiplier 1.5, connectionTimeout 10000, requestTimeout 30000, heartbeat interval 30000 and timeout 5000)",
      rung: "implemented",
    },
    {
      ref: "@procedures/client 0.2.3 dist/adapters/websocket/client/transport.js:271-290 startHeartbeat: a setInterval of the interval; a tick sends a ping only when no pong is awaited, then a setTimeout of the timeout drops the connection",
      rung: "implemented",
    },
    {
      ref: "@procedures/client 0.2.3 dist/adapters/websocket/client/transport.js:308-314 handleMessage: a pong clears the timeout",
      rung: "implemented",
    },
    {
      ref: "@procedures/client 0.2.3 dist/adapters/websocket/client/transport.js:202-215 dropConnection: the handlers go, ws.close(), and handleClose at once",
      rung: "implemented",
    },
    {
      ref: "@procedures/client 0.2.3 dist/adapters/websocket/client/transport.js:174-188 and :232-247: the close event of a socket ends it; handleClose fails each call and reconnects while tries are left",
      rung: "implemented",
    },
    {
      ref: "@procedures/client 0.2.3 dist/adapters/websocket/client/transport.js:150 and :250-268 scheduleReconnect: min(initialDelay × backoffMultiplier^(attempts − 1), maxDelay), no jitter; an open sets the attempts to 0",
      rung: "implemented",
    },
    {
      ref: "@procedures/client 0.2.3 dist/adapters/websocket/client/transport.js:460-469 send: the request timeout fails the call with TIMEOUT, and the connection stays",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 deps/undici/src/lib/web/websocket/connection.js:227-296 closeWebSocketConnection: close() on an open socket writes a close frame and destroys nothing; :306-323 failWebsocketConnection: a failed handshake fires close",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 deps/undici/src/lib/core/connect.js:120-129 setKeepAlive(true, 60000) and setNoDelay(true); deps/uv/src/unix/tcp.c:591-593 uv_tcp_keepalive: 1 s and 10 probes",
      rung: "implemented",
    },
    {
      ref: "client main 1f50f47 packages/client/src/machines.ts WEBSOCKET_CONNECTION_MACHINE: the states and the events of this document",
      rung: "documented",
    },
  ],
  states: {
    DISCONNECTED: { initial: true, note: "no socket" },
    CONNECTING: { note: "the handshake: 0.2.3 has no time limit on it" },
    CONNECTED: { note: "the calls; no pong is awaited" },
    AWAITING_PONG: { note: "a ping went out and its timeout runs: a tick of the interval sends nothing" },
    RECONNECTING: { note: "the wait before the next try" },
    DISCONNECTING: { note: "close() of the application ends the socket and the calls" },
  },
  events: {
    connect: { kind: "app", note: "the transport starts" },
    open: { kind: "rx", note: "the handshake ends: the attempts go back to 0" },
    "ping-due": { kind: "timer", note: "a tick of the interval" },
    pong: { kind: "rx" },
    "pong-timeout": { kind: "timer" },
    drop: { kind: "local", note: "the close event of the socket: a FIN, a reset, a give-up of the kernel, or a failed handshake" },
    "reconnect-due": { kind: "timer" },
    "give-up": { kind: "local", note: "an end without reconnect, or without tries left" },
    "tx.request": { kind: "tx", note: "the transport writes a call" },
    "rx.reply": { kind: "rx", note: "the first frame of the reply to a call" },
    "request-timeout": { kind: "timer" },
    close: { kind: "app", note: "close() of the application" },
    closed: { kind: "local" },
  },
  knobs: {
    heartbeat_interval: { key: "heartbeat.interval", scope: "client", unit: "ms", default: 30000 },
    heartbeat_timeout: { key: "heartbeat.timeout", scope: "client", unit: "ms", default: 5000 },
    reconnect_initial_delay: { key: "reconnect.initialDelay", scope: "client", unit: "ms", default: 1000 },
    reconnect_backoff_multiplier: { key: "reconnect.backoffMultiplier", scope: "client", unit: "count", default: 1.5 },
    reconnect_max_delay: { key: "reconnect.maxDelay", scope: "client", unit: "ms", default: 30000 },
    reconnect_max_attempts: { key: "reconnect.maxAttempts", scope: "client", unit: "count", default: null, note: "Infinity at the default" },
    request_timeout: { key: "requestTimeout", scope: "client", unit: "ms", default: 30000 },
    connection_timeout: {
      key: "connectionTimeout",
      scope: "client",
      unit: "ms",
      default: 10000,
      note: "only the wait of a call for a connection: 0.2.3 has no time limit on the handshake",
    },
    hz: {
      key: "CONFIG_HZ",
      scope: "global",
      unit: "Hz",
      default: null,
      note: "the HZ of the kernel, for the step of the coarse loop clock of libuv (http/timers.ts)",
    },
  },
  timers: {
    ping: {
      duration: { knob: "heartbeat_interval", unit: "ms" },
      lateness: nodeTimerLateness("heartbeat_interval"),
      early: NODE_TIMER_EARLY,
      arms: ["enter:CONNECTED"],
      cancels: ["drop", "close"],
      fires: "ping-due",
      backoff: { resets: ["open"] },
      note: "setInterval: it starts again at each tick from the loop clock of that tick (lib/internal/timers.js:676-692), thus a late tick moves each later tick",
    },
    pong: {
      duration: { knob: "heartbeat_timeout", unit: "ms" },
      lateness: nodeTimerLateness("heartbeat_timeout"),
      early: NODE_TIMER_EARLY,
      arms: ["enter:AWAITING_PONG"],
      cancels: ["pong", "drop", "close"],
      fires: "pong-timeout",
      note: "setTimeout right after the write of the ping: the drop comes one timeout after the ping that got no answer",
    },
    reconnect: {
      duration: { expr: RECONNECT_WAIT, unit: "ms" },
      lateness: nodeTimerLateness(RECONNECT_WAIT),
      early: NODE_TIMER_EARLY,
      arms: ["enter:RECONNECTING"],
      cancels: ["close"],
      fires: "reconnect-due",
      backoff: { resets: ["open"] },
    },
    request: {
      duration: { knob: "request_timeout", unit: "ms" },
      lateness: nodeTimerLateness("request_timeout"),
      early: NODE_TIMER_EARLY,
      arms: ["tx.request"],
      cancels: ["rx.reply", "drop", "close"],
      fires: "request-timeout",
      note: "one timer for each call: it fails the call, and the connection stays",
    },
  },
  transitions: [
    { id: "pw.connect", from: "DISCONNECTED", on: "connect", to: "CONNECTING" },
    { id: "pw.open", from: "CONNECTING", on: "open", to: "CONNECTED", source: "transport.js:146-160" },
    {
      id: "pw.ping",
      from: "CONNECTED",
      on: "ping-due",
      to: "AWAITING_PONG",
      timer: "ping",
      emits: ["tx.ping"],
      source: "transport.js:273-284",
    },
    {
      id: "pw.skip",
      from: "AWAITING_PONG",
      on: "ping-due",
      to: "AWAITING_PONG",
      timer: "ping",
      note: "one ping at a time: the tick sends nothing",
      source: "transport.js:275-276",
    },
    { id: "pw.pong", from: "AWAITING_PONG", on: "pong", to: "CONNECTED", source: "transport.js:309-314" },
    {
      id: "pw.pong-timeout",
      from: "AWAITING_PONG",
      on: "pong-timeout",
      to: "RECONNECTING",
      timer: "pong",
      emits: ["tx.close-frame"],
      note: "dropConnection: a close frame, and the socket stays open below",
      source: "transport.js:283-287, :202-215",
    },
    {
      id: "pw.drop",
      from: ["CONNECTING", "CONNECTED", "AWAITING_PONG"],
      on: "drop",
      to: "RECONNECTING",
      guard: "the reconnect is on, and tries are left",
      source: "transport.js:174-180, :232-247",
    },
    {
      id: "pw.give-up",
      from: ["CONNECTING", "CONNECTED", "AWAITING_PONG"],
      on: "give-up",
      to: "DISCONNECTED",
      source: "transport.js:236-237",
    },
    {
      id: "pw.reconnect",
      from: "RECONNECTING",
      on: "reconnect-due",
      to: "CONNECTING",
      timer: "reconnect",
      source: "transport.js:262-266",
    },
    {
      id: "pw.request-timeout",
      from: "CONNECTED",
      on: "request-timeout",
      to: "CONNECTED",
      timer: "request",
      errno: "TIMEOUT",
      source: "transport.js:460-469",
    },
    {
      id: "pw.request-timeout-pinged",
      from: "AWAITING_PONG",
      on: "request-timeout",
      to: "AWAITING_PONG",
      timer: "request",
      errno: "TIMEOUT",
      source: "transport.js:460-469",
    },
    {
      id: "pw.close",
      from: ["DISCONNECTED", "CONNECTING", "CONNECTED", "AWAITING_PONG", "RECONNECTING"],
      on: "close",
      to: "DISCONNECTING",
    },
    { id: "pw.closed", from: "DISCONNECTING", on: "closed", to: "DISCONNECTED" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { CONNECTING: "SYN_SENT", CONNECTED: "ESTABLISHED", AWAITING_PONG: "ESTABLISHED" },
    sets: {
      keepidle: { const: 60, unit: "s" },
      keepintvl: { const: 1, unit: "s" },
      keepcnt: { const: 10, unit: "count" },
    },
    ends: "drop",
    note: "The connector of undici turns keepalive on with a delay of 60 s, and libuv adds 1 s and 10 probes. Thus the keepalive sysctls of the namespace do not reach the socket.",
  },
};

/**
 * This document is one connection as the WebSocket server of `@procedures/client` 0.2.3 holds it
 * (`WebSocketServerTransport` on the `ws` package), over its Linux TCP socket. The server of 0.2.3
 * has no heartbeat: it answers each ping of a client, and it pings nothing. Its `http.Server` sets
 * no SO_KEEPALIVE when `keepAlive` is off, the default of Node. Thus only its kernel finds a silent
 * client, and only with a reply in flight.
 */
export const PROCEDURES_WS_SERVER: Machine = {
  format: "mark1russell7.machine/1",
  id: "procedures-ws-server",
  title: "One connection as the WebSocket server of @procedures/client 0.2.3 holds it",
  layer: "server",
  version: "0.2.3",
  conditions: { "@procedures/client": "0.2.3", ws: "8.22.0", node: "24.21.0", kernel: "Linux 6.6" },
  sources: [
    {
      ref: "@procedures/client 0.2.3 dist/adapters/websocket/server/transport.js:148-150 and :197-250 handleConnection: no timer on a connection; :287-293 a ping of a client gets a pong",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_server.js:646-651 and lib/net.js:2753-2756: keepAlive of http.Server is off at the default, thus an accepted socket has no SO_KEEPALIVE",
      rung: "implemented",
    },
  ],
  states: {
    ABSENT: { initial: true, pseudo: true },
    OPEN: { note: "the upgrade ended: the server serves the calls of the client" },
    CLOSED: { final: true },
  },
  events: {
    accept: { kind: "local" },
    "rx.ping": { kind: "rx", note: "a ping of the heartbeat of the client" },
    "rx.request": { kind: "rx" },
    "tx.reply": { kind: "tx" },
    close: { kind: "peer", note: "the close event of the socket of ws" },
    "socket.error": { kind: "local", note: "the kernel beneath gave up on the socket, or a reset arrived" },
  },
  knobs: {
    tcp_keepalive: {
      key: "keepAlive of http.Server (server-ws --tcp-keepalive)",
      scope: "server",
      unit: null,
      default: 0,
      note: "off: a reader gives the keepalive of the kernel no bound",
    },
  },
  timers: {},
  transitions: [
    { id: "ps.accept", from: "ABSENT", on: "accept", to: "OPEN" },
    { id: "ps.ping", from: "OPEN", on: "rx.ping", to: "OPEN", emits: ["tx.pong"], source: "transport.js:287-293" },
    { id: "ps.close", from: "OPEN", on: ["close", "socket.error"], to: "CLOSED", source: "transport.js:227-247" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { OPEN: "ESTABLISHED" },
    sets: {},
    ends: "socket.error",
  },
};

/** This function gives the arithmetic of a duration in ms. */
const arithmetic = (duration: Expr): string => {
  if (!("expr" in duration) || duration.unit !== "ms") throw new Error("not arithmetic in ms");
  return duration.expr;
};
/** This function gives how late a beat of the server can come after `beats` beats of a setInterval: the lateness of each beat adds. */
const beatsLate = (beats: string, interval: string): Expr => ({ expr: `${beats} * (${arithmetic(nodeTimerLateness(interval))})`, unit: "ms" });
const beatsEarly = (beats: string): Expr => ({ expr: `${beats} * (${arithmetic(NODE_TIMER_EARLY)})`, unit: "ms" });

/**
 * This document is the heartbeat of the WebSocket server on the main branch of the client
 * repository, at commit 1f50f47 (roadmap R3). No release on npm has it at this time.
 *
 * Each beat of a `setInterval` pings each connection. The server stops a connection after
 * `misses` beats without a pong (`terminate()`). Thus the drop comes `misses` beats after the first
 * ping that got no answer, and the lateness of each beat adds.
 */
export const PROCEDURES_WS_SERVER_MAIN: Machine = {
  format: "mark1russell7.machine/1",
  id: "procedures-ws-server-heartbeat",
  title: "The heartbeat of the WebSocket server of @procedures/client at main 1f50f47",
  layer: "server",
  version: "main 1f50f47",
  conditions: { "@procedures/client": "main 1f50f47", node: "24.21.0" },
  sources: [
    {
      ref: "client main 1f50f47 packages/client/src/adapters/websocket/server/transport.ts:105-111 (the heartbeat options), :118-134 beat(): terminate after misses, or count a miss and ping; :174-178 setInterval of the interval; :277 a pong sets the misses to 0",
      rung: "implemented",
    },
    {
      ref: "client main 1f50f47 packages/client/src/timers.ts webSocketServer: heartbeatIntervalMs 15000, heartbeatMisses 2",
      rung: "implemented",
    },
  ],
  states: {
    ABSENT: { initial: true, pseudo: true },
    OPEN: { note: "each beat pings the connection" },
    MISSING: { note: "a ping got no answer: each beat counts a miss" },
    CLOSED: { final: true },
  },
  events: {
    accept: { kind: "local" },
    "beat.unanswered": { kind: "timer", note: "a beat after a ping that got no pong" },
    "rx.pong": { kind: "rx" },
    "misses-reached": { kind: "timer" },
    "socket.error": { kind: "local" },
  },
  knobs: {
    heartbeat_interval: { key: "heartbeat.interval", scope: "server", unit: "ms", default: 15000 },
    heartbeat_misses: { key: "heartbeat.misses", scope: "server", unit: "count", default: 2 },
    hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null },
  },
  timers: {
    heartbeat: {
      duration: { expr: "heartbeat_misses * heartbeat_interval", unit: "ms" },
      lateness: beatsLate("heartbeat_misses", "heartbeat_interval"),
      early: beatsEarly("heartbeat_misses"),
      arms: ["enter:MISSING"],
      cancels: ["rx.pong"],
      fires: "misses-reached",
      note: "from the first ping that got no answer: misses beats of the interval, then terminate()",
    },
  },
  transitions: [
    { id: "ph.accept", from: "ABSENT", on: "accept", to: "OPEN" },
    { id: "ph.miss", from: "OPEN", on: "beat.unanswered", to: "MISSING" },
    { id: "ph.pong", from: "MISSING", on: "rx.pong", to: "OPEN" },
    { id: "ph.terminate", from: "MISSING", on: "misses-reached", to: "CLOSED", timer: "heartbeat", emits: ["tx.fin"] },
    { id: "ph.error", from: ["OPEN", "MISSING"], on: "socket.error", to: "CLOSED" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { OPEN: "ESTABLISHED", MISSING: "ESTABLISHED" },
    sets: {},
    ends: "socket.error",
  },
};

/** These are the settings of the client that a cell gives, in milliseconds. Null turns the heartbeat or the reconnect off. */
export interface WsClientSettings {
  readonly heartbeat: { readonly interval: number; readonly timeout: number } | null;
  readonly reconnect: { readonly initialDelay: number; readonly multiplier: number; readonly maxDelay: number; readonly attempts: number } | null;
  readonly requestTimeout: number;
  readonly connectionTimeout: number;
}
