import type { Machine } from "@mark1russell7/algebra";
import { NODE_TIMER_EARLY, nodeTimerLateness, undiciFastEarly, undiciFastLateness } from "./timers.ts";

/**
 * This document is the socket of an HTTP/1.1 `Client` of undici 8.12.2, over its Linux TCP socket.
 * Each fact comes from the published package at 8.12.2, with the file and the line.
 *
 * The keep-alive timeout comes from the hint of the server less a threshold, capped by a maximum.
 * The headers and body timeouts use the fast timers of undici, which count in ticks of 499 ms. The
 * client sends no request again by itself. A request that it did not write yet goes on the next
 * connection.
 */
export const UNDICI_CLIENT: Machine = {
  format: "mark1russell7.machine/1",
  id: "undici-client-h1",
  title: "The socket of an HTTP/1.1 Client of undici 8.12.2",
  layer: "driver",
  version: "8.12.2",
  conditions: { undici: "8.12.2", node: "24.21.0", pipelining: "1" },
  sources: [
    {
      ref: "undici 8.12.2 lib/dispatcher/client.js:309-319 (keepAliveTimeout 4000, keepAliveMaxTimeout 600000, keepAliveTimeoutThreshold 2000, bodyTimeout and headersTimeout 300000)",
      rung: "implemented",
    },
    {
      ref: "undici 8.12.2 lib/dispatcher/client-h1.js:705-721 onHeadersComplete: the timeout is min(hint - threshold, maximum), no reuse when it is 0 or less, and keepAliveTimeout without a hint; lib/core/util.js:390-398 (the hint in ms)",
      rung: "implemented",
    },
    {
      ref: "undici 8.12.2 lib/dispatcher/client-h1.js:213-223 and :262-288: a native Node timer for keep-alive, the fast timers for the headers and the body",
      rung: "implemented",
    },
    {
      ref: "undici 8.12.2 lib/dispatcher/client-h1.js:832-846 and :1111-1163: after a reply, one setImmediate, then the keep-alive timer; after the write of a request, the headers timer",
      rung: "implemented",
    },
    {
      ref: "undici 8.12.2 lib/dispatcher/client-h1.js:1087-1106 and :1125-1141: before a request on a used idle socket, the client yields to the check phase, thus a FIN or a reset already received closes the socket first",
      rung: "implemented",
    },
    {
      ref: "undici 8.12.2 lib/dispatcher/client-h1.js:855-876 onParserTimeout, :990-1007 onHttpSocketError, :1013-1025 onHttpSocketEnd (other side closed) and :1027-1072 onHttpSocketClose (the request at the head fails, the others wait for the next connection)",
      rung: "implemented",
    },
    {
      ref: "undici 8.12.2 lib/util/timers.js:30-207 the fast timers: a tick each 499 ms, a clock that adds 499 at each tick",
      rung: "implemented",
    },
    {
      ref: "undici 8.12.2 lib/core/connect.js:68-75 and :141-149 (connect timeout 10000, setKeepAlive(true, 60000), setNoDelay)",
      rung: "implemented",
    },
  ],
  states: {
    ABSENT: { initial: true, pseudo: true },
    CONNECTING: {},
    BUSY: { note: "a request is written and its reply is not complete" },
    IDLE: { note: "a reply is complete and the keep-alive timer is armed" },
    CLOSED: { final: true },
  },
  events: {
    "req.dispatch": { kind: "app" },
    "socket.connect": { kind: "local" },
    "tx.request": { kind: "tx", note: "the client wrote the request and resumes" },
    "rx.headers": { kind: "rx" },
    "rx.body": { kind: "rx", note: "a chunk of the body: it refreshes the body timer" },
    "resp.complete": { kind: "local", note: "onMessageComplete" },
    "rx.fin": { kind: "peer" },
    "rx.rst": { kind: "peer" },
    "timer.keep-alive": { kind: "timer" },
    "timer.headers": { kind: "timer" },
    "timer.body": { kind: "timer" },
    "timer.connect": { kind: "timer" },
    "socket.error": { kind: "local" },
  },
  knobs: {
    keepAliveTimeout: { key: "undici Client keepAliveTimeout", scope: "client", unit: "ms", default: 4000 },
    keepAliveMaxTimeout: { key: "undici Client keepAliveMaxTimeout", scope: "client", unit: "ms", default: 600000 },
    keepAliveTimeoutThreshold: {
      key: "undici Client keepAliveTimeoutThreshold",
      scope: "client",
      unit: "ms",
      default: 2000,
    },
    headersTimeout: { key: "undici Client headersTimeout", scope: "client", unit: "ms", default: 300000 },
    bodyTimeout: { key: "undici Client bodyTimeout", scope: "client", unit: "ms", default: 300000 },
    connectTimeout: { key: "undici Client connect.timeout", scope: "client", unit: "ms", default: 10000 },
    keepAliveInitialDelay: {
      key: "undici Client connect.keepAliveInitialDelay",
      scope: "client",
      unit: "ms",
      default: 60000,
    },
    hint: {
      key: "Keep-Alive timeout= of the server",
      scope: "connection",
      unit: "s",
      default: null,
      note: "without a hint, the timeout is keepAliveTimeout",
    },
  },
  timers: {
    keep_alive: {
      duration: { expr: "min(hint * 1000 - keepAliveTimeoutThreshold, keepAliveMaxTimeout)", unit: "ms" },
      lateness: nodeTimerLateness("min(hint * 1000 - keepAliveTimeoutThreshold, keepAliveMaxTimeout)"),
      early: NODE_TIMER_EARLY,
      arms: ["resp.complete", "enter:IDLE"],
      cancels: ["req.dispatch"],
      fires: "timer.keep-alive",
      note: "setTimeout(onParserTimeout, delay) with unref: a native Node timer",
    },
    headers: {
      duration: { knob: "headersTimeout", unit: "ms" },
      lateness: undiciFastLateness("headersTimeout"),
      early: undiciFastEarly("headersTimeout"),
      arms: ["tx.request", "enter:BUSY"],
      cancels: ["rx.headers"],
      fires: "timer.headers",
    },
    body: {
      duration: { knob: "bodyTimeout", unit: "ms" },
      lateness: undiciFastLateness("bodyTimeout"),
      early: undiciFastEarly("bodyTimeout"),
      arms: ["rx.headers", "rx.body"],
      cancels: ["resp.complete"],
      fires: "timer.body",
    },
    connect: {
      duration: { knob: "connectTimeout", unit: "ms" },
      arms: ["enter:CONNECTING"],
      cancels: ["socket.connect"],
      fires: "timer.connect",
    },
  },
  realizes: {
    "systems.mechanism.pool-idle-expiry": { timer: "keep_alive" },
    "systems.mechanism.request-timeout": { timer: "headers" },
    "systems.mechanism.connect-bound": { timer: "connect" },
  },
  transitions: [
    { id: "un.connect", from: "ABSENT", to: "CONNECTING", on: "req.dispatch" },
    { id: "un.connected", from: "CONNECTING", to: "BUSY", on: "socket.connect" },
    {
      id: "un.idle",
      from: "BUSY",
      to: "IDLE",
      on: "resp.complete",
      guard: "the reply keeps the connection, and min(hint - threshold, maximum) > 0",
      timer: "keep_alive",
      source: "client-h1.js:705-717, :842-846",
    },
    {
      id: "un.no-reuse",
      from: "BUSY",
      to: "CLOSED",
      on: "resp.complete",
      guard: "hint * 1000 - keepAliveTimeoutThreshold is 0 or less, or the reply closes the connection",
      emits: ["tx.fin"],
      source: "client-h1.js:709-711, :832-841",
    },
    {
      id: "un.reuse",
      from: "IDLE",
      to: "BUSY",
      on: "req.dispatch",
      guard: "the socket is still open after the yield to the check phase",
      source: "client-h1.js:1087-1106, :1125-1141",
    },
    {
      id: "un.expire",
      from: "IDLE",
      to: "CLOSED",
      on: "timer.keep-alive",
      timer: "keep_alive",
      emits: ["tx.fin"],
      source: "client-h1.js:872-875",
    },
    {
      id: "un.peer-closed",
      from: "IDLE",
      to: "CLOSED",
      on: ["rx.fin", "rx.rst", "socket.error"],
      note: "no request fails: the next request opens a new connection",
      source: "client-h1.js:1013-1025, :1065",
    },
    {
      id: "un.other-side-closed",
      from: "BUSY",
      to: "CLOSED",
      on: "rx.fin",
      errno: "UND_ERR_SOCKET",
      note: "SocketError: other side closed. The request at the head fails",
      source: "client-h1.js:1013-1025, :1057-1063",
    },
    {
      id: "un.reset",
      from: "BUSY",
      to: "CLOSED",
      on: ["rx.rst", "socket.error"],
      errno: "ECONNRESET",
      note: "the error of the socket, with its own code",
      source: "client-h1.js:990-1007, :1057-1063",
    },
    {
      id: "un.headers-timeout",
      from: "BUSY",
      to: "CLOSED",
      on: "timer.headers",
      timer: "headers",
      errno: "UND_ERR_HEADERS_TIMEOUT",
      source: "client-h1.js:863-867",
    },
    {
      id: "un.body-timeout",
      from: "BUSY",
      to: "CLOSED",
      on: "timer.body",
      timer: "body",
      errno: "UND_ERR_BODY_TIMEOUT",
      source: "client-h1.js:868-871",
    },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { CONNECTING: "SYN_SENT", BUSY: "ESTABLISHED", IDLE: "ESTABLISHED" },
    sets: {
      keepidle: { expr: "floor(keepAliveInitialDelay / 1000)", unit: "s" },
      keepintvl: { const: 1, unit: "s" },
      keepcnt: { const: 10, unit: "count" },
    },
    ends: "socket.error",
    note: "The connector turns keepalive on with a delay of 60 s, and Node and libuv add 1 s and 10 probes (src/tcp_wrap.cc:215-216). Thus the keepalive sysctls of the namespace do not reach it.",
  },
};

/** These are the options of the client that a cell can give, in milliseconds. */
export interface UndiciSettings {
  readonly keepAliveTimeout?: number;
  readonly keepAliveMaxTimeout?: number;
  readonly keepAliveTimeoutThreshold?: number;
  readonly headersTimeout?: number;
  readonly bodyTimeout?: number;
  readonly connectTimeout?: number;
  readonly keepAliveInitialDelay?: number;
}
