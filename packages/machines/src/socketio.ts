import type { Expr, Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { NODE_TIMER_EARLY, nodeTimerLateness } from "./http/timers.ts";

/**
 * This module holds the machine documents of Socket.IO 4.8.4 on Node, with the WebSocket transport
 * only. The client is socket.io-client 4.8.4 on engine.io-client 6.6.7. The server is socket.io
 * 4.8.4 on engine.io 6.6.11. Both use ws 8.21.3. The Socket.IO cells (SYS-87) operate
 * them from the lockfile of `packages/cells/targets/socketio`. Each fact comes from the published
 * tarball of each version, or from Node v24.21.0. The comments and the sources give the file and
 * the line. Node loads the build `build/esm-debug` of each client package (the condition `node` of
 * its exports), and the server packages are CommonJS (`build`).
 *
 * The protocol is engine.io 4. The server writes a ping each pingInterval, and the client answers
 * with a pong. Each side has its own timer. The server waits pingTimeout for the pong of its ping.
 * The client waits pingInterval + pingTimeout for the next ping. The handshake gives the client
 * both times, thus the client has no setting of its own for its heartbeat.
 */

/** This text is the client package of the engine at its version. */
const EC = "engine.io-client 6.6.7 build/esm-debug";
/** This text is the client package of Socket.IO at its version. */
const SC = "socket.io-client 4.8.4 build/esm-debug";
/** This text is the server package of the engine at its version. */
const ES = "engine.io 6.6.11 build";
/** This text is the ws package at its version. */
const WS = "ws 8.21.3 lib";

/** This function gives the arithmetic of a duration in ms. */
const arithmetic = (duration: Expr): string => {
  if (!("expr" in duration) || duration.unit !== "ms") throw new Error("not arithmetic in ms");
  return duration.expr;
};

/** This text is the late bound of one Node timer, in ms, for a time in ms. */
const late = (ms: string): string => arithmetic(nodeTimerLateness(ms));
/** This text is the early bound of one Node timer, in ms. */
const EARLY = arithmetic(NODE_TIMER_EARLY);

/** This text is the wait of the client for the next ping, in ms: the sum that the handshake gives. */
const PING_WAIT = "ping_interval + ping_timeout";

/**
 * This text is the backoff of try n + 1 of the reconnect, in ms, before its jitter: `fired` is n.
 * The Backoff of socket.io-client has the factor 2.
 */
const BACKOFF = "reconnection_delay * pow(2, fired)";
/** This text is the wait of try n + 1 of the reconnect with no jitter, in ms. */
const RECONNECT_WAIT = `min(${BACKOFF}, reconnection_delay_max)`;

/**
 * This document is the connection of the Manager of socket.io-client 4.8.4 over engine.io-client
 * 6.6.7, with the Node WebSocket transport (the ws package), over its Linux TCP socket.
 *
 * - The client waits pingInterval + pingTimeout for each ping. The handshake arms the timer, and
 *   each ping arms it again. No other packet and no write moves it. At its end the client closes
 *   the connection with the reason "ping timeout".
 * - The close of the client is close() of ws: a close frame. The socket stays open below it until
 *   the peer answers, or for the close timeout of ws (30 s).
 * - Each close starts the reconnect of the Manager, when it is on. The wait of try n + 1 is
 *   min(reconnectionDelay × 2^n, reconnectionDelayMax), with a jitter of ± randomizationFactor of
 *   the backoff before its cap. An open sets n to 0, and so does each close of an open connection.
 * - Each try has a time limit (`timeout` of the Manager).
 * - A call with an acknowledgement has its own time limit, and the connection stays.
 */
export const SOCKETIO_CLIENT: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "socketio-client",
  title: "The connection of the Manager of socket.io-client 4.8.4 (engine.io-client 6.6.7, ws 8.21.3)",
  layer: "driver",
  version: "4.8.4",
  conditions: { "socket.io-client": "4.8.4", "engine.io-client": "6.6.7", ws: "8.21.3", node: "24.21.0", kernel: "Linux 6.6" },
  sources: [
    {
      ref: `${EC}/socket.js:401-414 onHandshake: pingInterval and pingTimeout come from the server (:406-407), and the timer starts (:413); :373-378 each ping writes a pong and starts the timer again (:377); :420-430 _resetPingTimeout: the delay is pingInterval + pingTimeout (:422), and at its end the reason "ping timeout" (:425)`,
      rung: "implemented",
    },
    {
      ref: `${EC}/socket.js:639-669 _onClose: transport.close() (:649); ${EC}/transport.js:55-61 close() of an open transport calls doClose(); ${EC}/transports/websocket.js:81-87 doClose calls close() of its WebSocket`,
      rung: "implemented",
    },
    {
      ref: `${WS}/websocket.js:302-340 close(): a handshake is aborted (:304-307); an open socket writes a close frame, then setCloseTimer (:1309-1314) destroys it after CLOSE_TIMEOUT, 30000 ms (lib/constants.js:10)`,
      rung: "implemented",
    },
    {
      ref: `${SC}/manager.js:23-33 the options: reconnectionAttempts || Infinity (:24), reconnectionDelay || 1000 (:25), reconnectionDelayMax || 5000 (:26), randomizationFactor ?? 0.5 (:27), timeout 20000 (:33)`,
      rung: "implemented",
    },
    {
      ref: `${SC}/manager.js:315-326 onclose: the backoff goes back to 0 (:320), then reconnect() (:324); :332-374 reconnect: backoff.duration() (:343), a timer, then open() (:354), and a failed try starts the next wait (:357-358); :380-385 an open sets the backoff to 0`,
      rung: "implemented",
    },
    {
      ref: `${SC}/contrib/backo2.js:26-34 duration: min × factor^attempts (:27), factor 2 (:16), the jitter adds or subtracts floor(rand × jitter × ms) (:28-32), then min(ms, max) | 0 (:33)`,
      rung: "implemented",
    },
    {
      ref: `${SC}/manager.js:140-156 the time limit of each try: an error "timeout", and close() of the engine`,
      rung: "implemented",
    },
    {
      ref: `${EC}/transports/websocket.node.js: createSocket gives new WebSocket of ws with the URL and the options of the engine. ws sets no keepalive on its socket, and the engine gives it none`,
      rung: "implemented",
    },
  ],
  states: {
    DISCONNECTED: { initial: true, note: "no socket" },
    CONNECTING: { note: "a try, with its time limit" },
    CONNECTED: { note: "the handshake ended: the ping timer runs" },
    RECONNECTING: { note: "the wait before the next try" },
  },
  events: {
    connect: { kind: "app", note: "the Manager opens" },
    open: { kind: "rx", note: "the handshake of the engine: the backoff goes back to 0" },
    "connect-timeout": { kind: "timer" },
    "rx.ping": { kind: "rx", note: "a ping of the server: the client writes a pong" },
    "ping-timeout": { kind: "timer" },
    drop: { kind: "local", note: "the close event of the socket: a FIN, a reset, a give-up of the kernel, or a failed try" },
    "reconnect-due": { kind: "timer" },
    "give-up": { kind: "local", note: "a close without reconnect, or without tries left" },
    "tx.request": { kind: "tx", note: "an event with an acknowledgement" },
    "rx.reply": { kind: "rx", note: "the acknowledgement" },
    "request-timeout": { kind: "timer" },
    close: { kind: "app", note: "close() of the application" },
  },
  knobs: {
    ping_interval: { key: "pingInterval (from the handshake)", scope: "server", unit: "ms", default: 25000 },
    ping_timeout: { key: "pingTimeout (from the handshake)", scope: "server", unit: "ms", default: 20000 },
    reconnection_delay: { key: "reconnectionDelay", scope: "client", unit: "ms", default: 1000 },
    reconnection_delay_max: { key: "reconnectionDelayMax", scope: "client", unit: "ms", default: 5000 },
    reconnection_attempts: { key: "reconnectionAttempts", scope: "client", unit: "count", default: null, note: "Infinity at the default" },
    randomization_factor: {
      key: "randomizationFactor",
      scope: "client",
      unit: "count",
      default: 0.5,
      note: "the random part of each wait, from 0 to 1: the backoff, plus or minus floor(r × factor × backoff)",
    },
    connect_timeout: { key: "timeout", scope: "client", unit: "ms", default: 20000, note: "the time limit of each try" },
    request_timeout: { key: "socket.timeout()", scope: "client", unit: "ms", default: null, note: "no time limit at the default" },
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
      duration: { expr: PING_WAIT, unit: "ms" },
      lateness: nodeTimerLateness(PING_WAIT),
      early: NODE_TIMER_EARLY,
      arms: ["enter:CONNECTED", "rx.ping"],
      cancels: ["drop", "close"],
      fires: "ping-timeout",
      note: "from the last ping that reached the client, or from the handshake. Data of the connection does not move it",
    },
    reconnect: {
      duration: { expr: RECONNECT_WAIT, unit: "ms" },
      lateness: { expr: `randomization_factor * ${BACKOFF} + ${late(RECONNECT_WAIT)}`, unit: "ms" },
      early: { expr: `randomization_factor * ${BACKOFF} + ${EARLY}`, unit: "ms" },
      arms: ["enter:RECONNECTING"],
      cancels: ["close"],
      fires: "reconnect-due",
      backoff: { resets: ["open", "drop"] },
      note: "the jitter adds or subtracts at most randomizationFactor × the backoff before its cap: both bounds",
    },
    connect: {
      duration: { knob: "connect_timeout", unit: "ms" },
      lateness: nodeTimerLateness("connect_timeout"),
      early: NODE_TIMER_EARLY,
      arms: ["enter:CONNECTING"],
      cancels: ["open", "drop", "close"],
      fires: "connect-timeout",
    },
    request: {
      duration: { knob: "request_timeout", unit: "ms" },
      lateness: nodeTimerLateness("request_timeout"),
      early: NODE_TIMER_EARLY,
      arms: ["tx.request"],
      cancels: ["rx.reply", "close"],
      fires: "request-timeout",
      note: "one timer for each call: it fails the call, and the connection stays",
    },
  },
  transitions: [
    { id: "sc.connect", from: "DISCONNECTED", on: "connect", to: "CONNECTING" },
    { id: "sc.open", from: "CONNECTING", on: "open", to: "CONNECTED", source: `${EC}/socket.js:401-414` },
    {
      id: "sc.connect-timeout",
      from: "CONNECTING",
      on: "connect-timeout",
      to: "RECONNECTING",
      timer: "connect",
      source: `${SC}/manager.js:144-149`,
    },
    { id: "sc.ping", from: "CONNECTED", on: "rx.ping", to: "CONNECTED", emits: ["tx.pong"], source: `${EC}/socket.js:373-378` },
    {
      id: "sc.ping-timeout",
      from: "CONNECTED",
      on: "ping-timeout",
      to: "RECONNECTING",
      timer: "ping",
      emits: ["tx.close-frame"],
      note: "close() of ws writes a close frame, and the socket stays open below it",
      source: `${EC}/socket.js:424-426, :649`,
    },
    {
      id: "sc.drop",
      from: ["CONNECTING", "CONNECTED"],
      on: "drop",
      to: "RECONNECTING",
      guard: "the reconnect is on, and tries are left",
      source: `${SC}/manager.js:315-326, :354-359`,
    },
    { id: "sc.give-up", from: ["CONNECTING", "CONNECTED"], on: "give-up", to: "DISCONNECTED", source: `${SC}/manager.js:336-341` },
    { id: "sc.reconnect", from: "RECONNECTING", on: "reconnect-due", to: "CONNECTING", timer: "reconnect", source: `${SC}/manager.js:346-366` },
    { id: "sc.request-timeout", from: "CONNECTED", on: "request-timeout", to: "CONNECTED", timer: "request", errno: "TIMEOUT" },
    { id: "sc.close", from: ["CONNECTING", "CONNECTED", "RECONNECTING"], on: "close", to: "DISCONNECTED" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { CONNECTING: "SYN_SENT", CONNECTED: "ESTABLISHED" },
    sets: {},
    ends: "drop",
    note: "ws turns no keepalive on, thus the keepalive sysctls of the namespace do not reach the socket",
  },
} satisfies Machine);

/**
 * This document is one connection as the Server of socket.io 4.8.4 on engine.io 6.6.11 holds it.
 * The transport is WebSocket (ws 8.21.3), over its Linux TCP socket.
 *
 * - pingInterval after the handshake, or after the last pong, the server writes a ping. Then it
 *   waits pingTimeout for the pong, and at its end it closes the connection: close() of ws, a close
 *   frame. Thus the drop comes pingTimeout after the first ping without an answer.
 * - In that wait, the first packet that is not a pong starts the wait again, once for each ping.
 * - The http.Server of Node sets no SO_KEEPALIVE when keepAlive is off, its default.
 */
export const SOCKETIO_SERVER: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "socketio-server",
  title: "One connection as the Server of socket.io 4.8.4 (engine.io 6.6.11, ws 8.21.3) holds it",
  layer: "server",
  version: "4.8.4",
  conditions: { "socket.io": "4.8.4", "engine.io": "6.6.11", ws: "8.21.3", node: "24.21.0", kernel: "Linux 6.6" },
  sources: [
    {
      ref: `${ES}/server.js:48-49 the defaults: pingTimeout 20000 and pingInterval 25000`,
      rung: "implemented",
    },
    {
      ref: `${ES}/socket.js:88-95 the handshake schedules the first ping (protocol 4); :166-173 schedulePing: after pingInterval, sendPacket("ping"), then resetPingTimeout; :179-188 resetPingTimeout: onClose("ping timeout") after pingTimeout`,
      rung: "implemented",
    },
    {
      ref: `${ES}/socket.js:130-140 a pong clears the wait (:136-137) and starts the interval again (:138); :111-118 in the wait, the first packet that is not a pong starts the wait again, once`,
      rung: "implemented",
    },
    {
      ref: `${ES}/socket.js:336-352 onClose clears the timers and calls clearTransport (:315-327), which calls close() of the transport (:327); ${ES}/transports/websocket.js:90-94 doClose calls close() of its WebSocket: a close frame (${WS}/websocket.js:302-340)`,
      rung: "implemented",
    },
    {
      ref: `${ES}/socket.js:386-409 sendPacket emits packetCreate (:402) before the write of the packet: the line of each ping`,
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_server.js:646-651 and lib/net.js:2753-2756: keepAlive of http.Server is off at the default, thus an accepted socket has no SO_KEEPALIVE",
      rung: "implemented",
    },
  ],
  states: {
    ABSENT: { initial: true, pseudo: true },
    OPEN: { note: "the interval to the next ping runs" },
    AWAITING_PONG: { note: "a ping went out: its wait runs" },
    CLOSED: { final: true },
  },
  events: {
    accept: { kind: "local", note: "the handshake of the engine" },
    "ping-due": { kind: "timer" },
    "rx.pong": { kind: "rx" },
    "rx.packet": { kind: "rx", note: "a packet that is not a pong" },
    "pong-timeout": { kind: "timer" },
    close: { kind: "peer", note: "the close event of the socket of ws" },
    "socket.error": { kind: "local", note: "the kernel beneath gave up on the socket, or a reset arrived" },
  },
  knobs: {
    ping_interval: { key: "pingInterval", scope: "server", unit: "ms", default: 25000 },
    ping_timeout: { key: "pingTimeout", scope: "server", unit: "ms", default: 20000 },
    hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null },
  },
  timers: {
    ping: {
      duration: { knob: "ping_interval", unit: "ms" },
      lateness: nodeTimerLateness("ping_interval"),
      early: NODE_TIMER_EARLY,
      arms: ["enter:OPEN"],
      cancels: ["close"],
      fires: "ping-due",
      backoff: { resets: ["rx.pong"] },
      note: "a timer that starts again at each pong: each firing writes a ping, and the pong timer gives up on it",
    },
    pong: {
      duration: { knob: "ping_timeout", unit: "ms" },
      lateness: nodeTimerLateness("ping_timeout"),
      early: NODE_TIMER_EARLY,
      arms: ["enter:AWAITING_PONG"],
      cancels: ["rx.pong", "close"],
      fires: "pong-timeout",
      note: "from the write of the ping. The first packet that is not a pong in the wait starts it again, once (rx.packet)",
    },
  },
  transitions: [
    { id: "ss.accept", from: "ABSENT", on: "accept", to: "OPEN" },
    { id: "ss.ping", from: "OPEN", on: "ping-due", to: "AWAITING_PONG", timer: "ping", emits: ["tx.ping"], source: `${ES}/socket.js:166-173` },
    { id: "ss.pong", from: "AWAITING_PONG", on: "rx.pong", to: "OPEN", source: `${ES}/socket.js:130-140` },
    {
      id: "ss.refresh",
      from: "AWAITING_PONG",
      on: "rx.packet",
      to: "AWAITING_PONG",
      note: "the wait starts again once for each ping: a later packet does not move it",
      source: `${ES}/socket.js:111-118`,
    },
    {
      id: "ss.pong-timeout",
      from: "AWAITING_PONG",
      on: "pong-timeout",
      to: "CLOSED",
      timer: "pong",
      emits: ["tx.close-frame"],
      source: `${ES}/socket.js:179-188, :336-352`,
    },
    { id: "ss.close", from: ["OPEN", "AWAITING_PONG"], on: ["close", "socket.error"], to: "CLOSED" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { OPEN: "ESTABLISHED", AWAITING_PONG: "ESTABLISHED" },
    sets: {},
    ends: "socket.error",
  },
} satisfies Machine);
