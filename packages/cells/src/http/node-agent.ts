import type { Machine } from "@mark1russell7/algebra";
import { NODE_TIMER_EARLY, nodeTimerLateness } from "./timers.ts";

/**
 * This document is one socket of the `http.Agent` of Node v24.21.0, as its global agent sets it.
 * Its keep-alive is on, its free socket timeout is 5 s, and it is LIFO. It is over the Linux TCP socket. Each fact
 * comes from the source at the tag `v24.21.0`, with the file and the line.
 *
 * A free socket keeps its connection until the smaller of the timeout of the agent and the hint of
 * the server less a buffer. An agent without a timeout keeps it with no limit, and then the hint
 * changes nothing.
 *
 * The free socket timer arms on the event loop of the program, when the program has read the
 * whole response. The time from the last segment that the kernel received to that arm is the time
 * of the program. No source bounds it, and this document does not hold it. The race adds it from a
 * calibration (`HANDLING` in `race.ts`).
 */
export const NODE_HTTP_AGENT: Machine = {
  format: "mark1russell7.machine/1",
  id: "node-http-agent",
  title: "One socket of the http.Agent of Node 24.21.0",
  layer: "driver",
  version: "24.21.0",
  conditions: { node: "24.21.0", libuv: "1.52.1", agent: "http.globalAgent, or an Agent with its options" },
  sources: [
    {
      ref: "node v24.21.0 lib/internal/http.js:263-265 getGlobalAgent: keepAlive true, scheduling lifo, timeout 5000",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_agent.js:172-185 (keepAliveMsecs 1000, maxFreeSockets 256, scheduling lifo, agentKeepAliveTimeoutBuffer 1000)",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_agent.js:201-265 the free event, and :633-667 keepSocketAlive: setKeepAlive(true, keepAliveMsecs), and the free socket timeout is min(timeout, hint * 1000 - agentKeepAliveTimeoutBuffer), or no reuse when that is 0 or less",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_client.js:964 and :1017-1051 responseOnEnd at the end of the response, :986-1015 responseKeepAlive and :1074-1080 emitFreeNT: the socket emits free on the next tick, on the event loop",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_agent.js:662-664: keepSocketAlive sets the timeout only when it changes. Else the timeout of the socket from its connect (:452-456, lib/net.js:257-258) counts from its last read or write (lib/net.js:738-745, lib/internal/stream_base_commons.js:164-170)",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_agent.js:101-139 freeSocketOnReadGuard: a read on a free socket, an end of file too, destroys it",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_agent.js:385-416 addRequest: a free socket by LIFO, after the destroyed ones at the head; :541-550 onTimeout destroys a free socket; :669-675 reuseSocket sets req.reusedSocket",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/_http_client.js:712-797: an end or a close before the response is socket hang up (ECONNRESET), and a socket error goes to the request. The agent sends no request again",
      rung: "implemented",
    },
    {
      ref: "node v24.21.0 lib/net.js:846-888 setKeepAlive (the delay in whole seconds) and src/tcp_wrap.cc:204-219 (interval 1 s and count 10 when none is given)",
      rung: "implemented",
    },
  ],
  states: {
    ABSENT: { initial: true, pseudo: true },
    CONNECTING: {},
    BUSY: { note: "a request owns the socket" },
    FREE: { note: "in the freeSockets list of the agent" },
    CLOSED: { final: true },
  },
  events: {
    "req.dispatch": { kind: "app", note: "agent.addRequest" },
    "socket.connect": { kind: "local" },
    "resp.end": {
      kind: "local",
      note: "the program read the whole response: the socket emits free on the next tick. It comes after the last segment by the handling time of the program",
    },
    "rx.fin": { kind: "peer" },
    "rx.rst": { kind: "peer" },
    "rx.data": { kind: "peer", note: "bytes that nothing asked for" },
    "timer.free-socket": { kind: "timer" },
    "socket.error": { kind: "local", note: "the kernel beneath gave up, or an ICMP error ended the socket" },
  },
  knobs: {
    keepAlive: {
      key: "node http.Agent keepAlive",
      scope: "client",
      unit: null,
      default: 1,
      note: "1 for the global agent; new Agent() without options has 0",
    },
    timeout: {
      key: "node http.Agent timeout",
      scope: "client",
      unit: "ms",
      default: 5000,
      note: "5000 for the global agent; 0 is no free socket timer, and then the hint does not apply: a reader gives timeout and hint no bound",
    },
    keepAliveMsecs: { key: "node http.Agent keepAliveMsecs", scope: "client", unit: "ms", default: 1000 },
    agentKeepAliveTimeoutBuffer: {
      key: "node http.Agent agentKeepAliveTimeoutBuffer",
      scope: "client",
      unit: "ms",
      default: 1000,
    },
    maxFreeSockets: { key: "node http.Agent maxFreeSockets", scope: "client", unit: "count", default: 256 },
    hint: {
      key: "Keep-Alive timeout= of the server",
      scope: "connection",
      unit: "s",
      default: null,
      note: "the hint that the response gives; a response without one: a reader gives it no bound",
    },
    hz: {
      key: "CONFIG_HZ",
      scope: "global",
      unit: "Hz",
      default: null,
      note: "the HZ of the kernel, for the step of the coarse loop clock of libuv (timers.ts)",
    },
  },
  timers: {
    free_socket: {
      duration: { expr: "min(timeout, hint * 1000 - agentKeepAliveTimeoutBuffer)", unit: "ms" },
      lateness: nodeTimerLateness("min(timeout, hint * 1000 - agentKeepAliveTimeoutBuffer)"),
      early: NODE_TIMER_EARLY,
      arms: ["resp.end", "enter:FREE"],
      cancels: ["req.dispatch"],
      fires: "timer.free-socket",
      note: "socket.setTimeout(agentTimeout) in keepSocketAlive: the Node timer of the socket. It arms in the free handler, or at the last read of the reply when its duration stays the same. Both come in the handling time of the program after the last segment (race.ts)",
    },
  },
  realizes: {
    "systems.mechanism.pool-idle-expiry": { timer: "free_socket" },
  },
  transitions: [
    { id: "na.connect", from: "ABSENT", to: "CONNECTING", on: "req.dispatch", guard: "no free socket" },
    { id: "na.connected", from: "CONNECTING", to: "BUSY", on: "socket.connect" },
    {
      id: "na.free",
      from: "BUSY",
      to: "FREE",
      on: "resp.end",
      guard: "keepAlive, the response keeps the connection, and hint * 1000 - agentKeepAliveTimeoutBuffer > 0",
      timer: "free_socket",
      source: "lib/_http_agent.js:237-264, :633-667",
    },
    {
      id: "na.no-reuse",
      from: "BUSY",
      to: "CLOSED",
      on: "resp.end",
      guard: "hint * 1000 - agentKeepAliveTimeoutBuffer is 0 or less, or the response closes the connection",
      emits: ["tx.fin"],
      source: "lib/_http_agent.js:238-254, :649-654",
    },
    {
      id: "na.reuse",
      from: "FREE",
      to: "BUSY",
      on: "req.dispatch",
      guard: "the socket is not destroyed",
      source: "lib/_http_agent.js:385-416",
    },
    {
      id: "na.expire",
      from: "FREE",
      to: "CLOSED",
      on: "timer.free-socket",
      timer: "free_socket",
      emits: ["tx.fin"],
      source: "lib/_http_agent.js:541-550",
    },
    {
      id: "na.peer-closed",
      from: "FREE",
      to: "CLOSED",
      on: ["rx.fin", "rx.rst", "rx.data", "socket.error"],
      source: "lib/_http_agent.js:94-112",
    },
    {
      id: "na.hang-up",
      from: "BUSY",
      to: "CLOSED",
      on: "rx.fin",
      errno: "ECONNRESET",
      note: "socket hang up, an error with the code ECONNRESET",
      source: "lib/_http_client.js:781-797",
    },
    {
      id: "na.reset",
      from: "BUSY",
      to: "CLOSED",
      on: ["rx.rst", "socket.error"],
      errno: "ECONNRESET",
      note: "the errno of the socket: ECONNRESET for a reset, ETIMEDOUT or the soft ICMP errno for a give-up",
      source: "lib/_http_client.js:757-779",
    },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { CONNECTING: "SYN_SENT", BUSY: "ESTABLISHED", FREE: "ESTABLISHED" },
    sets: {
      keepidle: { expr: "floor(keepAliveMsecs / 1000)", unit: "s" },
      keepintvl: { const: 1, unit: "s" },
      keepcnt: { const: 10, unit: "count" },
    },
    ends: "socket.error",
    note: "The agent turns keepalive on at the connect (lib/_http_agent.js:474-478, lib/net.js:1991-1994) and again on each free socket. Node passes the delay in whole seconds and libuv sets 1 s and 10 probes. Thus the keepalive sysctls of the namespace do not reach it.",
  },
};

/** These are the options of the agent that a cell can give, in milliseconds. */
export interface AgentSettings {
  readonly timeout?: number;
  readonly keepAliveMsecs?: number;
  readonly agentKeepAliveTimeoutBuffer?: number;
}
