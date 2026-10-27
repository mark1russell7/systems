import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { NODE_TIMER_EARLY, nodeTimerLateness } from "./timers.ts";

/**
 * This document is one connection as the `http.Server` of Node v24.21.0 holds it, over the Linux
 * TCP socket of the connection. Each fact comes from the source at the tag `v24.21.0`. The comments
 * give the file and the line.
 *
 * The keep-alive timer is the S of the keep-alive race. It arms when the response ends, not when
 * the request starts. It is a socket timeout on the timers of libuv, thus it has the lateness of a
 * Node timer (`timers.ts`). When it fires, the server closes the socket. The kernel sends a FIN, or
 * a reset when the receive queue has data that nothing read.
 */
export const NODE_HTTP_SERVER: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "node-http-server",
  title: "One connection as the http.Server of Node 24.21.0 holds it",
  layer: "server",
  version: "24.21.0",
  conditions: { node: "24.21.0", libuv: "1.52.1", kernel: "Linux 6.6" },
  sources: [
    {
      ref: "node v24.21.0 lib/_http_server.js:537-579 (requestTimeout 300000, headersTimeout min(60000, requestTimeout), keepAliveTimeout 5000, keepAliveTimeoutBuffer 1000, connectionsCheckingInterval 30000), :665-667 (timeout 0, maxRequestsPerSocket 0)",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_server.js:1096-1150 resOnFinish: the keep-alive timer arms when the response finishes, at keepAliveTimeout + keepAliveTimeoutBuffer",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_server.js:1167-1168 and :1299-1305 parserOnIncoming and resetSocketTimeout: the headers of the next request disarm it",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_server.js:963-968 onParserExecute and lib/net.js:738-745 _unrefTimer: each read refreshes the socket timeout",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_server.js:900-909 socketOnTimeout: without a timeout listener, the socket is destroyed; lib/net.js:1097-1131 _destroy closes the handle",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_outgoing.js:514-527: Keep-Alive: timeout=floor(keepAliveTimeout / 1000), with max= when maxRequestsPerSocket is set, and Connection: close on the last allowed response",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_server.js:616-624 and :743-764 checkConnections: the headers and request timeouts are a sweep each connectionsCheckingInterval; src/node_http_parser.cc:310-330, :1223-1284 (a connection counts from the start of its message, and leaves the list when the message is complete)",
      rung: "implemented",
    },
    {
      ref: "linux v6.6 net/ipv4/tcp.c:2771-2797 __tcp_close: unread data in the receive queue makes the close a reset (RFC 2525 2.17), else :2802-2832 a FIN",
      rung: "implemented",
    },
  ],
  states: {
    ABSENT: { initial: true, pseudo: true },
    WAITING: { note: "accepted, and no byte of a request yet: the headers timeout counts from the accept" },
    READING: { note: "a request has started and its headers or its body are not complete" },
    HANDLING: { note: "the request is complete and its response is not finished, for example a held reply" },
    IDLE: { note: "a response finished and the keep-alive timer is armed" },
    CLOSED: { final: true },
  },
  events: {
    accept: { kind: "local" },
    "rx.message-begin": { kind: "rx", note: "the first byte of a request (llhttp on_message_begin)" },
    "rx.request": { kind: "rx", note: "the headers of a request are complete: parserOnIncoming" },
    "rx.message-complete": { kind: "rx", note: "the whole request arrived, its body too" },
    "rx.data": { kind: "rx", note: "bytes arrive on the socket: each read refreshes the socket timeout" },
    "res.finish": { kind: "local", note: "the last byte of a response went to the kernel" },
    "rx.fin": { kind: "peer", note: "the client closed: socketOnEnd ends the socket, because httpAllowHalfOpen is false" },
    "rx.rst": { kind: "peer" },
    "timer.keep-alive": { kind: "timer" },
    "timer.headers": { kind: "timer" },
    "timer.request": { kind: "timer" },
    "timer.socket": { kind: "timer" },
    "socket.error": { kind: "local", note: "the kernel beneath gave up on the socket, or a reset arrived" },
  },
  knobs: {
    keepAliveTimeout: {
      key: "node http.Server keepAliveTimeout",
      scope: "server",
      unit: "ms",
      default: 5000, off: 0,
      note: "0 disables the keep-alive timer and the hint: a reader gives the timer no bound",
    },
    keepAliveTimeoutBuffer: {
      key: "node http.Server keepAliveTimeoutBuffer",
      scope: "server",
      unit: "ms",
      default: 1000,
      note: "added to the timer, not to the hint (lib/_http_server.js:1136-1141)",
    },
    headersTimeout: { key: "node http.Server headersTimeout", scope: "server", unit: "ms", default: 60000 },
    requestTimeout: { key: "node http.Server requestTimeout", scope: "server", unit: "ms", default: 300000 },
    connectionsCheckingInterval: {
      key: "node http.Server connectionsCheckingInterval",
      scope: "server",
      unit: "ms",
      default: 30000,
    },
    timeout: {
      key: "node http.Server timeout",
      scope: "server",
      unit: "ms",
      default: 0, off: 0,
      note: "the socket timeout while a request is open (lib/_http_server.js:1303); 0 is off",
    },
    maxRequestsPerSocket: {
      key: "node http.Server maxRequestsPerSocket",
      scope: "server",
      unit: "count",
      default: 0,
      note: "0 is no limit; at the limit the response says Connection: close, and a request above it gets 503 (lib/_http_server.js:1255-1271)",
    },
    hz: {
      key: "CONFIG_HZ",
      scope: "global",
      unit: "Hz",
      default: null,
      note: "the HZ of the kernel: at 1000, libuv reads the coarse clock, a jiffy a step, and each Node timer gets that step on each bound (timers.ts)",
    },
  },
  timers: {
    keep_alive: {
      duration: { expr: "keepAliveTimeout + keepAliveTimeoutBuffer", unit: "ms" },
      lateness: nodeTimerLateness("keepAliveTimeout + keepAliveTimeoutBuffer"),
      early: NODE_TIMER_EARLY,
      arms: ["res.finish", "rx.data", "enter:IDLE"],
      cancels: ["rx.request"],
      fires: "timer.keep-alive",
      note: "socket.setTimeout(keepAliveTimeout + keepAliveTimeoutBuffer) in resOnFinish; a read refreshes it, and the headers of the next request reset it to the server timeout",
    },
    headers: {
      duration: { knob: "headersTimeout", unit: "ms" },
      lateness: {
        expr: "connectionsCheckingInterval + min(max(connectionsCheckingInterval / 1000, 0.05), 100) + 1",
        unit: "ms",
      },
      arms: ["accept", "rx.message-begin", "enter:WAITING", "enter:READING"],
      cancels: ["rx.request"],
      fires: "timer.headers",
      note: "a sweep each connectionsCheckingInterval finds the expired connections by uv_hrtime, thus the 408 comes in [T, T + interval], late by the interval timer",
    },
    request: {
      duration: { knob: "requestTimeout", unit: "ms" },
      lateness: {
        expr: "connectionsCheckingInterval + min(max(connectionsCheckingInterval / 1000, 0.05), 100) + 1",
        unit: "ms",
      },
      arms: ["accept", "rx.message-begin", "enter:READING"],
      cancels: ["rx.message-complete"],
      fires: "timer.request",
    },
    socket: {
      duration: { knob: "timeout", unit: "ms" },
      lateness: nodeTimerLateness("timeout"),
      early: NODE_TIMER_EARLY,
      arms: ["rx.request", "enter:HANDLING"],
      cancels: ["res.finish"],
      fires: "timer.socket",
      note: "off at its default: a reader gives 0 as no bound",
    },
  },
  realizes: {
    "systems.mechanism.server-idle-close": { timer: "keep_alive" },
  },
  transitions: [
    { id: "ns.accept", from: "ABSENT", to: "WAITING", on: "accept" },
    {
      id: "ns.begin",
      from: ["WAITING", "IDLE"],
      to: "READING",
      on: "rx.message-begin",
      source: "src/node_http_parser.cc:310-330",
    },
    {
      id: "ns.request",
      from: "READING",
      to: "HANDLING",
      on: ["rx.request", "rx.message-complete"],
      source: "lib/_http_server.js:1167-1168, :1299-1305",
    },
    {
      id: "ns.respond",
      from: "HANDLING",
      to: "IDLE",
      on: "res.finish",
      guard: "keepAliveTimeout > 0, and the response is not the last one (Connection: close or maxRequestsPerSocket)",
      timer: "keep_alive",
      source: "lib/_http_server.js:1130-1142",
    },
    {
      id: "ns.last",
      from: "HANDLING",
      to: "CLOSED",
      on: "res.finish",
      guard: "the response is the last one: destroySoon ends the socket after it",
      emits: ["tx.fin"],
      source: "lib/_http_server.js:1124-1129",
    },
    {
      id: "ns.keep-alive",
      from: "IDLE",
      to: "CLOSED",
      on: "timer.keep-alive",
      timer: "keep_alive",
      emits: ["tx.fin"],
      note: "a reset in place of the FIN when the receive queue holds data that nothing read (net/ipv4/tcp.c:2793-2797)",
      source: "lib/_http_server.js:900-909",
    },
    {
      id: "ns.headers-timeout",
      from: ["WAITING", "READING"],
      to: "CLOSED",
      on: "timer.headers",
      timer: "headers",
      emits: ["tx.408", "tx.fin"],
      source: "lib/_http_server.js:743-764, :958-961",
    },
    {
      id: "ns.request-timeout",
      from: "READING",
      to: "CLOSED",
      on: "timer.request",
      timer: "request",
      emits: ["tx.408", "tx.fin"],
      source: "lib/_http_server.js:743-764",
    },
    {
      id: "ns.peer-end",
      from: ["WAITING", "READING", "HANDLING", "IDLE"],
      to: "CLOSED",
      on: "rx.fin",
      emits: ["tx.fin"],
      source: "lib/_http_server.js:932-948",
    },
    { id: "ns.error", from: ["WAITING", "READING", "HANDLING", "IDLE"], to: "CLOSED", on: ["rx.rst", "socket.error"] },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { WAITING: "ESTABLISHED", READING: "ESTABLISHED", HANDLING: "ESTABLISHED", IDLE: "ESTABLISHED" },
    sets: {},
    ends: "socket.error",
    note: "http.Server passes keepAlive to net.Server, and its default is off (lib/_http_server.js:646-651, lib/net.js:2753-2756). Thus an accepted socket has no SO_KEEPALIVE, and a reader gives the keepalive of the kernel no bound.",
  },
} satisfies Machine);
