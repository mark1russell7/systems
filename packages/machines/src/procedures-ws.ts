import type { Expr, Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";
import { NODE_TIMER_EARLY, nodeTimerLateness } from "./http/timers.ts";

/**
 * This module holds the machine documents of the WebSocket transport of `@procedures/client` at
 * commit 2408cea of the client repository: 0.22.0 and two PATCHes after it. The WS and WST cells
 * run the subject that the client repository builds from that commit (CLI-33). Each fact comes
 * from the source of that commit, from `@mark1russell7/service` 0.5.8, from ws 8.22.0, or from Node
 * v24.21.0 and its undici 7.29.1. The comments and the sources give the file and the line.
 *
 * The client repository has a document of the connection: `WEBSOCKET_CONNECTION_MACHINE` in
 * `packages/client/src/machines.ts`. This document takes its states and its events, and the code
 * of the transports gives the timers.
 */

/** This text is the folder of the WebSocket transports at the commit of the subject. */
const AT = "client 2408cea packages/client/src/adapters/websocket";
/** This text is the client transport at that commit. */
const CT = `${AT}/client/transport.ts`;
/** This text is the server transport at that commit. */
const ST = `${AT}/server/transport.ts`;
/** This text is the source of the version of the service that the lock of the client gives (pnpm-lock.yaml:443-454). */
const SERVICE = "@mark1russell7/service 0.5.8 (systems 571e9e5) packages/service/src";

/** This function gives the arithmetic of a duration in ms. */
const arithmetic = (duration: Expr): string => {
  if (!("expr" in duration) || duration.unit !== "ms") throw new Error("not arithmetic in ms");
  return duration.expr;
};

/** This text is the backoff of try n + 1 of the reconnect, in ms: `fired` is n. It reads the arithmetic of `backoffDelay`. */
const RECONNECT_WAIT = "min(reconnect_initial_delay * pow(reconnect_backoff_multiplier, fired), reconnect_max_delay)";

/** This text is the late bound of one Node timer, in ms, for a time in ms. */
const late = (ms: string): string => arithmetic(nodeTimerLateness(ms));
/** This text is the early bound of one Node timer, in ms. */
const EARLY = arithmetic(NODE_TIMER_EARLY);

/**
 * This document is the connection of the WebSocket client of `@procedures/client` 0.22.0 at
 * commit 2408cea (`WebSocketTransport`), over its socket class and its Linux TCP socket. The
 * root entry uses the global `WebSocket` of Node, and `@procedures/client/node` uses the `ws` package.
 *
 * - The heartbeat is `heartbeat()` of `@mark1russell7/service` 0.5.8. A tick each interval sends a
 *   ping only when no pong is awaited. The timeout of the ping starts before its send. A
 *   ping without a pong at its timeout is a miss, and `misses` misses in sequence drop the
 *   connection. With a timeout below the interval, each tick after a miss sends the next ping.
 *   Thus the drop comes (misses − 1) intervals and one timeout after the first ping without an answer.
 * - A drop ends the socket with `terminate()` when its class has it: the `ws` package. The global
 *   `WebSocket` of Node has only `close()`, which writes a close frame and destroys nothing.
 * - Each end of a socket starts the reconnect. The wait of try n is the backoff
 *   min(initialDelay × multiplier^(n − 1), maxDelay), less a random part: jitter × backoff × r.
 * - The handshake has a time limit (`connectionTimeout`), and a failed handshake drops at once.
 * - The heartbeat refreshes an idle flow. Each tick writes a ping, whatever data the connection
 *   carries, and the pong comes back. Thus the ping timer realizes the idle refresh of O03.
 */
export const PROCEDURES_WS_CLIENT: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "procedures-ws-client",
  title: "The connection of the WebSocket client of @procedures/client 0.22.0 (client 2408cea)",
  layer: "driver",
  version: "0.22.0",
  conditions: { "@procedures/client": "0.22.0 (client 2408cea)", "@mark1russell7/service": "0.5.8", node: "24.21.0", undici: "7.29.1", ws: "8.22.0", kernel: "Linux 6.6" },
  sources: [
    {
      ref: `${CT}:260-290 (the options: each time a duration, its default from TIMER_DEFAULTS.webSocketClient; the misses of the heartbeat at least 1 (:278); the jitter of the reconnect from 0 to 1 (:269); the class of the sockets (:289), used at :324)`,
      rung: "implemented",
    },
    {
      ref: `${CT}:486-511 startHeartbeat: heartbeat() of @mark1russell7/service with the interval, the timeout and the misses; a tick sends a ping only when CONNECTED (:498); the open starts it (:357-360)`,
      rung: "implemented",
    },
    {
      ref: `${SERVICE}/heartbeat.ts:129-135 (each tick starts the next one first), :96-127 (the timeout starts before the send of the ping, :110-114 and :117; a send that throws is a miss, :118-121), :81-94 (misses in sequence)`,
      rung: "implemented",
    },
    {
      ref: `${CT}:401-422 dropConnection: the handlers go (:128-134), terminate() when the class has it (:414-416), else close(), and handleClose at once (:421)`,
      rung: "implemented",
    },
    {
      ref: `${CT}:172-195 and :460-484: reconnectDelay is backoffDelay of @mark1russell7/service (${SERVICE}/backoff.ts:58-64), with a subtracted jitter; an open sets the attempts to 0 (:345)`,
      rung: "implemented",
    },
    {
      ref: `${CT}:330-339 and :389-392: the time limit of the handshake, and a failed handshake drops at once`,
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 deps/undici/src/lib/web/websocket/connection.js:227-296 closeWebSocketConnection: close() on an open socket writes a close frame and destroys nothing",
      rung: "implemented",
    },
    {
      ref: "ws 8.22.0 lib/websocket.js:500-517 terminate(): the socket is destroyed at once (:513-516), and a handshake is aborted (:507-511)",
      rung: "implemented",
    },
    {
      ref: `node v24.21.0 deps/undici/src/lib/core/connect.js:120-129 setKeepAlive(true, 60000); deps/uv/src/unix/tcp.c:591-593 uv_tcp_keepalive: 1 s and 10 probes. The ws package sets no keepalive on its socket (ws 8.22.0 lib/websocket.js:260-261), and the transport gives the class only the URL (${CT}:325, ${AT}/client/node.ts:30-34).`,
      rung: "implemented",
    },
    {
      ref: "client 2408cea packages/client/src/machines.ts:76-141 WEBSOCKET_CONNECTION_MACHINE: the states and the events of this document",
      rung: "documented",
    },
  ],
  states: {
    DISCONNECTED: { initial: true, note: "no socket" },
    CONNECTING: { note: "the handshake, with its time limit" },
    CONNECTED: { note: "the calls; no pong is awaited" },
    AWAITING_PONG: { note: "a ping went out and its timeout runs: a tick of the interval sends nothing" },
    RECONNECTING: { note: "the wait before the next try" },
    DISCONNECTING: { note: "close() of the application ends the socket and the calls" },
  },
  events: {
    connect: { kind: "app", note: "the transport starts" },
    open: { kind: "rx", note: "the handshake ends: the attempts go back to 0" },
    "handshake-timeout": { kind: "timer" },
    "ping-due": { kind: "timer", note: "a tick of the interval" },
    pong: { kind: "rx" },
    "pong-timeout": { kind: "timer", note: "the last miss of `misses` in sequence" },
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
    heartbeat_interval: { key: "heartbeat.interval", scope: "client", unit: "ms", default: 20000 },
    heartbeat_timeout: { key: "heartbeat.timeout", scope: "client", unit: "ms", default: 5000 },
    heartbeat_misses: { key: "heartbeat.misses", scope: "client", unit: "count", default: 1 },
    reconnect_initial_delay: { key: "reconnect.initialDelay", scope: "client", unit: "ms", default: 1000 },
    reconnect_backoff_multiplier: { key: "reconnect.backoffMultiplier", scope: "client", unit: "count", default: 1.5 },
    reconnect_max_delay: { key: "reconnect.maxDelay", scope: "client", unit: "ms", default: 30000 },
    reconnect_max_attempts: { key: "reconnect.maxAttempts", scope: "client", unit: "count", default: null, note: "Infinity at the default" },
    reconnect_jitter: {
      key: "reconnect.jitter",
      scope: "client",
      unit: "count",
      default: 1,
      note: "the random part of each wait, from 0 to 1: a wait is the backoff less jitter × backoff × r",
    },
    request_timeout: { key: "requestTimeout", scope: "client", unit: "ms", default: 30000 },
    connection_timeout: { key: "connectionTimeout", scope: "client", unit: "ms", default: 10000, note: "the time limit of the handshake, and the wait of a call for a connection" },
    socket_keepidle: {
      key: "the keepalive of the socket class",
      scope: "client",
      unit: "s",
      default: 60,
      note: "undici sets 60 s on the socket of the global WebSocket. The ws package sets none: a reader gives no bound",
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
      note: "each tick starts the next one first, from the loop clock of that tick: a late tick moves each later tick. The data of the connection does not move a tick (service src/heartbeat.ts:129-135), thus an idle flow gets a ping and a pong each interval",
    },
    pong: {
      duration: { expr: "(heartbeat_misses - 1) * heartbeat_interval + heartbeat_timeout", unit: "ms" },
      lateness: { expr: `(heartbeat_misses - 1) * (${late("heartbeat_interval")}) + ${late("heartbeat_timeout")}`, unit: "ms" },
      early: { expr: `heartbeat_misses * (${EARLY})`, unit: "ms" },
      arms: ["enter:AWAITING_PONG"],
      cancels: ["pong", "drop", "close"],
      fires: "pong-timeout",
      note: "from the first ping without an answer: (misses − 1) ticks, then the timeout of the last ping. The timeout starts before the send of its ping",
    },
    reconnect: {
      duration: { expr: RECONNECT_WAIT, unit: "ms" },
      lateness: nodeTimerLateness(RECONNECT_WAIT),
      early: { expr: `reconnect_jitter * ${RECONNECT_WAIT} + ${EARLY}`, unit: "ms" },
      arms: ["enter:RECONNECTING"],
      cancels: ["close"],
      fires: "reconnect-due",
      backoff: { resets: ["open"] },
      note: "the jitter subtracts a random part of the backoff: its early bound",
    },
    handshake: {
      duration: { knob: "connection_timeout", unit: "ms" },
      lateness: nodeTimerLateness("connection_timeout"),
      early: NODE_TIMER_EARLY,
      arms: ["enter:CONNECTING"],
      cancels: ["open", "drop", "close"],
      fires: "handshake-timeout",
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
  realizes: {
    // each ping and its pong refresh the flow at a middlebox: O03 reads the interval at its latest
    "systems.mechanism.idle-refresh-interval": { timer: "ping" },
  },
  transitions: [
    { id: "pw.connect",from: "DISCONNECTED", on: "connect", to: "CONNECTING" },
    { id: "pw.open", from: "CONNECTING", on: "open", to: "CONNECTED", source: `${CT}:342-361` },
    {
      id: "pw.handshake-timeout",
      from: "CONNECTING",
      on: "handshake-timeout",
      to: "RECONNECTING",
      timer: "handshake",
      source: `${CT}:330-339`,
    },
    {
      id: "pw.ping",
      from: "CONNECTED",
      on: "ping-due",
      to: "AWAITING_PONG",
      timer: "ping",
      emits: ["tx.ping"],
      source: `${CT}:491-511`,
    },
    {
      id: "pw.skip",
      from: "AWAITING_PONG",
      on: "ping-due",
      to: "AWAITING_PONG",
      timer: "ping",
      note: "one ping at a time: the tick sends nothing",
      source: `${SERVICE}/heartbeat.ts:129-134`,
    },
    { id: "pw.pong", from: "AWAITING_PONG", on: "pong", to: "CONNECTED", source: `${CT}:566-570` },
    {
      id: "pw.pong-timeout",
      from: "AWAITING_PONG",
      on: "pong-timeout",
      to: "RECONNECTING",
      timer: "pong",
      emits: ["tx.close-frame"],
      note: "dropConnection: terminate() destroys the socket of ws at once; close() of the global WebSocket writes a close frame, and its socket stays open below",
      source: `${CT}:401-422, :506-509`,
    },
    {
      id: "pw.drop",
      from: ["CONNECTING", "CONNECTED", "AWAITING_PONG"],
      on: "drop",
      to: "RECONNECTING",
      guard: "the reconnect is on, and tries are left",
      source: `${CT}:375-379, :436-458`,
    },
    {
      id: "pw.give-up",
      from: ["CONNECTING", "CONNECTED", "AWAITING_PONG"],
      on: "give-up",
      to: "DISCONNECTED",
      source: `${CT}:444-445`,
    },
    {
      id: "pw.reconnect",
      from: "RECONNECTING",
      on: "reconnect-due",
      to: "CONNECTING",
      timer: "reconnect",
      source: `${CT}:463-484`,
    },
    {
      id: "pw.request-timeout",
      from: "CONNECTED",
      on: "request-timeout",
      to: "CONNECTED",
      timer: "request",
      errno: "TIMEOUT",
      source: `${CT}:724-733`,
    },
    {
      id: "pw.request-timeout-pinged",
      from: "AWAITING_PONG",
      on: "request-timeout",
      to: "AWAITING_PONG",
      timer: "request",
      errno: "TIMEOUT",
      source: `${CT}:724-733`,
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
      keepidle: { knob: "socket_keepidle", unit: "s" },
      keepintvl: { const: 1, unit: "s" },
      keepcnt: { const: 10, unit: "count" },
    },
    ends: "drop",
    note: "The connector of undici turns keepalive on with a delay of 60 s, and libuv adds 1 s and 10 probes. The ws package turns no keepalive on. Thus the keepalive sysctls of the namespace do not reach the socket.",
  },
} satisfies Machine);

/**
 * This document is one connection as the WebSocket server of `@procedures/client` 0.22.0 at
 * commit 2408cea holds it (`WebSocketServerTransport` of `@procedures/client/node`, on the `ws`
 * package), over its Linux TCP socket.
 *
 * The heartbeat of the server (roadmap R3) is a `setInterval`. Each beat pings each connection,
 * and the server ends a connection after `misses` beats without a pong (`terminate()`). Thus the
 * drop comes `misses` beats after the first ping without an answer, and the lateness of each beat
 * adds. Its `http.Server` sets no SO_KEEPALIVE when `keepAlive` is off, the default of Node.
 */
export const PROCEDURES_WS_SERVER: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "procedures-ws-server",
  title: "One connection as the WebSocket server of @procedures/client 0.22.0 (client 2408cea) holds it",
  layer: "server",
  version: "0.22.0",
  conditions: { "@procedures/client": "0.22.0 (client 2408cea)", ws: "8.22.0", node: "24.21.0", kernel: "Linux 6.6" },
  sources: [
    {
      ref: `${ST}:146-152 (the heartbeat: interval and misses, or false), :155-175 beat(): terminate after misses (:163-167), or count a miss and ping (:168-173); :232-236 setInterval of the interval; :429 a pong sets the misses to 0`,
      rung: "implemented",
    },
    {
      ref: "client 2408cea packages/client/src/timers.ts:86-88 webSocketServer: heartbeatIntervalMs 15000, heartbeatMisses 2",
      rung: "implemented",
    },
    {
      ref: `${ST}:523-527: a ping of a client gets a pong`,
      rung: "implemented",
    },
    {
      ref: `node v24.21.0 lib/_http_server.js:646-651 and lib/net.js:2753-2756: keepAlive of http.Server is off at the default, thus an accepted socket has no SO_KEEPALIVE. The transport takes the upgrades of the server of its host (${ST}:187-230) and sets no option of a socket`,
      rung: "implemented",
    },
    {
      ref: "ws 8.22.0 lib/websocket-server.js:372, :431 an upgrade gives its socket to setSocket(); lib/websocket.js:267 and :1398-1404 an end of file of that socket ends it at once: a FIN back",
      rung: "implemented",
    },
  ],
  states: {
    ABSENT: { initial: true, pseudo: true },
    OPEN: { note: "each beat pings the connection" },
    MISSING: { note: "a ping got no pong: each beat counts a miss" },
    CLOSED: { final: true },
  },
  events: {
    accept: { kind: "local" },
    "beat.unanswered": { kind: "timer", note: "a beat after a ping that got no pong" },
    "rx.pong": { kind: "rx" },
    "rx.ping": { kind: "rx", note: "a ping of the heartbeat of the client" },
    "misses-reached": { kind: "timer" },
    close: { kind: "peer", note: "the close event of the socket of ws" },
    "rx.fin": { kind: "peer", note: "the end event of the socket of ws: the peer sent a FIN" },
    "socket.error": { kind: "local", note: "the kernel beneath gave up on the socket, or a reset arrived" },
  },
  knobs: {
    heartbeat_interval: { key: "heartbeat.interval", scope: "server", unit: "ms", default: 15000, note: "no bound when the heartbeat is off" },
    heartbeat_misses: { key: "heartbeat.misses", scope: "server", unit: "count", default: 2 },
    tcp_keepalive: {
      key: "keepAlive of http.Server (server-ws --tcp-keepalive)",
      scope: "server",
      unit: null,
      default: 0,
      note: "off: a reader gives the keepalive of the kernel no bound",
    },
    hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null },
  },
  timers: {
    heartbeat: {
      duration: { expr: "heartbeat_misses * heartbeat_interval", unit: "ms" },
      lateness: { expr: `heartbeat_misses * (${late("heartbeat_interval")})`, unit: "ms" },
      early: { expr: `heartbeat_misses * (${EARLY})`, unit: "ms" },
      arms: ["enter:MISSING"],
      cancels: ["rx.pong"],
      fires: "misses-reached",
      note: "from the first ping without an answer: misses beats of the interval, then terminate()",
    },
  },
  transitions: [
    { id: "ps.accept", from: "ABSENT", on: "accept", to: "OPEN" },
    { id: "ps.miss", from: "OPEN", on: "beat.unanswered", to: "MISSING" },
    { id: "ps.pong", from: "MISSING", on: "rx.pong", to: "OPEN" },
    { id: "ps.ping", from: ["OPEN", "MISSING"], on: "rx.ping", to: "OPEN", emits: ["tx.pong"], source: `${ST}:523-527` },
    { id: "ps.terminate", from: "MISSING", on: "misses-reached", to: "CLOSED", timer: "heartbeat", emits: ["tx.fin"], source: `${ST}:163-167` },
    {
      id: "ps.peer-end",
      from: ["OPEN", "MISSING"],
      on: "rx.fin",
      to: "CLOSED",
      emits: ["tx.fin"],
      note: "socketOnEnd: ws ends its side of the socket at once",
      source: "ws 8.22.0 lib/websocket.js:1398-1404",
    },
    { id: "ps.close", from: ["OPEN", "MISSING"], on: ["close", "socket.error"], to: "CLOSED" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { OPEN: "ESTABLISHED", MISSING: "ESTABLISHED" },
    sets: {},
    ends: "socket.error",
  },
} satisfies Machine);
