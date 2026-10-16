import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact below is the built code of ioredis 6.0.0 as npm has it, under built/.
// Each line number is a line of that file in the package.
const AT = "ioredis 6.0.0 built";

/**
 * This document is the Sentinel path of ioredis 6.0.0. It tells how ioredis finds the primary of a
 * group through the Sentinels, loses it, and connects to the new one. The standalone states of
 * `ioredis-status` stay, and a connect asks a Sentinel first. The driver has no timer that watches
 * the group: it moves only when its own connection closes. The failover detector, which
 * subscribes to `+switch-master`, is off by default.
 */
export const IOREDIS_SENTINEL: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "ioredis-sentinel",
  title: "ioredis 6.0.0 in Sentinel mode: the primary of a group, found through its Sentinels",
  layer: "driver",
  version: "6.0.0",
  conditions: { ioredis: "6.0.0", mode: "sentinel", node: "24.21.0" },
  sources: [
    { ref: `${AT}/connectors/SentinelConnector/index.js:46-121 connect (each Sentinel in turn, then sentinelRetryStrategy)`, rung: "implemented" },
    { ref: `${AT}/connectors/SentinelConnector/index.js:145-151 resolveMaster (get-master-addr-by-name, then SENTINEL sentinels)`, rung: "implemented" },
    { ref: `${AT}/connectors/SentinelConnector/index.js:175-212 connectToSentinel and resolve (one connection for each question, no retry)`, rung: "implemented" },
    { ref: `${AT}/connectors/SentinelConnector/index.js:27-39 check (the role of the ready check)`, rung: "implemented" },
    { ref: `${AT}/connectors/SentinelConnector/FailoverDetector.js:6-43 (+switch-master, only with failoverDetector)`, rung: "implemented" },
    { ref: `${AT}/redis/RedisOptions.js:9-57 (the defaults)`, rung: "implemented" },
    { ref: `${AT}/redis/event_handler.js:294-355 closeHandler (retryStrategy, then maxRetriesPerRequest flushes the queue)`, rung: "implemented" },
    { ref: `${AT}/redis/event_handler.js:364-449 readyHandler (retryAttempts back to 0, the resend, the offline queue)`, rung: "implemented" },
    { ref: `${AT}/Redis.js:123-240 _connect (connectTimeout, keepAlive) and :379-405 sendCommand (the offline queue)`, rung: "implemented" },
    { ref: `${AT}/Redis.js:599-605 handleReconnection (reconnectOnError: null, thus a READONLY error goes to the caller)`, rung: "implemented" },
  ],
  states: {
    "[empty]": { initial: true, pseudo: true },
    resolving: { note: "a connect: one Sentinel after another, get-master-addr-by-name (SentinelConnector/index.js:50-119)" },
    connecting: { note: "the TCP connect to the primary that the Sentinel named" },
    connect: { note: "the handshake: HELLO 3, CLIENT SETINFO, then the INFO of the ready check, whose role must be master" },
    ready: { note: "writes go to the primary" },
    close: { note: "the connection closed: closeHandler (event_handler.js:294-350)" },
    reconnecting: { note: "the wait of retryStrategy before the next connect" },
    end: { final: true },
  },
  events: {
    "app.connect": { kind: "app" },
    "sentinel.answer": { kind: "local", note: "a Sentinel named a primary" },
    "sentinel.none": { kind: "local", note: "no Sentinel answered: sentinelRetryStrategy (SentinelConnector/index.js:51-73)" },
    "stream.connect": { kind: "local" },
    "stream.close": { kind: "local", note: "a FIN, a reset, a refused connect, a CLIENT KILL, or the connect timeout" },
    "handshake.ready": { kind: "local", note: "the ready check says role:master (event_handler.js:194-210)" },
    "handshake.role": { kind: "local", note: "the ready check says another role: disconnect and connect again (SentinelConnector/index.js:27-39)" },
    "timer.retry": { kind: "timer" },
    "timer.sentinel-retry": { kind: "timer" },
    "timer.connect-timeout": { kind: "timer" },
    "local.flush": { kind: "local", note: "MaxRetriesPerRequestError for each queued command (event_handler.js:337-349)" },
    "rx.switch-master": { kind: "rx", note: "a message on +switch-master: only with failoverDetector (FailoverDetector.js:28-32)" },
  },
  knobs: {
    connectTimeout: { key: "ioredis connectTimeout", scope: "client", unit: "ms", default: 10000, note: "RedisOptions.js:9" },
    disconnectTimeout: { key: "ioredis disconnectTimeout", scope: "client", unit: "ms", default: 2000, note: "RedisOptions.js:10" },
    keepAlive: { key: "ioredis keepAlive", scope: "client", unit: "ms", default: 30000, note: "RedisOptions.js:17: setKeepAlive on the socket of the primary" },
    maxRetriesPerRequest: {
      key: "ioredis maxRetriesPerRequest",
      scope: "client",
      unit: "count",
      default: 20,
      note: "RedisOptions.js:57: the queue goes at each close whose count since ready is a multiple of maxRetriesPerRequest + 1",
    },
    sentinel_retry_step: { key: "ioredis sentinelRetryStrategy", scope: "client", unit: "ms", default: 10, note: "RedisOptions.js:26-28: min(times × 10, 1000) ms" },
    sentinel_retry_cap: { key: "ioredis sentinelRetryStrategy", scope: "client", unit: "ms", default: 1000 },
    sentinelReconnect: { key: "ioredis sentinelReconnectStrategy", scope: "client", unit: "ms", default: 60000, note: "RedisOptions.js:29-35: the detector's own links only" },
    failoverDetector: { key: "ioredis failoverDetector", scope: "client", unit: null, default: 0, note: "RedisOptions.js:40: off" },
    commandTimeout: { key: "ioredis commandTimeout", scope: "client", unit: "ms", default: null, note: "unset: a command waits without a limit (Redis.js:368)" },
    attempt_round_trips: {
      key: "the round trips of one connect that fails",
      scope: "path",
      unit: "count",
      default: 5,
      note: "a connect to the Sentinel, HELLO with CLIENT SETINFO, get-master-addr-by-name, SENTINEL sentinels, then the connect to the primary",
    },
    success_round_trips: {
      key: "the round trips of a connect that succeeds, to its first accepted write",
      scope: "path",
      unit: "count",
      default: 9,
      note: "the five of a failed connect, then HELLO, the INFO of the ready check, and the write itself",
    },
    rtt: { key: "the round trip of the network of the group", scope: "path", unit: "ms", default: null },
    slack: {
      key: "the lateness of the event loop of Node for one step",
      scope: "process",
      unit: "ms",
      default: 10,
      note: "an assumption of this document, not a value of ioredis: a timer or a callback of Node that comes late",
    },
  },
  timers: {
    retry_delay: {
      // min(2 ** (times - 1) × 50, 5000) + floor(random × 200), times = ++retryAttempts (RedisOptions.js:11-16, event_handler.js:326)
      duration: { model: "ioredis.retry-base", knobs: ["fired"], unit: "s" },
      lateness: { expr: "199 + slack", unit: "ms" },
      arms: ["stream.close"],
      fires: "timer.retry",
      backoff: { resets: ["handshake.ready"] },
      note: "fired counts the closes since the last ready, from 0: the readyHandler sets retryAttempts to 0 (event_handler.js:367)",
    },
    attempt: {
      // one connect that fails: each question to a Sentinel is a new connection (SentinelConnector/index.js:197-212)
      duration: { expr: "attempt_round_trips * rtt", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["timer.retry"],
      fires: "stream.close",
    },
    success: {
      duration: { expr: "success_round_trips * rtt", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["timer.retry"],
      fires: "handshake.ready",
    },
    connect_timeout: {
      duration: { knob: "connectTimeout", unit: "ms" },
      arms: ["enter:connecting"],
      cancels: ["stream.connect"],
      fires: "timer.connect-timeout",
      note: "a connect into a black hole: the socket goes, then stream.close (Redis.js:179-201)",
    },
    sentinel_retry: {
      duration: { expr: "min(sentinel_retry_step * (fired + 1), sentinel_retry_cap)", unit: "ms" },
      arms: ["sentinel.none"],
      fires: "timer.sentinel-retry",
      backoff: { resets: ["sentinel.answer"] },
      note: "only when no Sentinel answers",
    },
  },
  transitions: [
    { id: "connect", from: ["[empty]", "end"], to: "resolving", on: "app.connect" },
    { id: "resolved", from: "resolving", to: "connecting", on: "sentinel.answer", note: "the first Sentinel of the list that answers; it moves to the head (SentinelIterator.js)" },
    { id: "no-sentinel", from: "resolving", to: "resolving", on: "timer.sentinel-retry", timer: "sentinel_retry" },
    { id: "socket-up", from: "connecting", to: "connect", on: "stream.connect" },
    { id: "attempt-failed", from: ["connecting", "connect"], to: "close", on: ["stream.close", "timer.connect-timeout"] },
    { id: "ready", from: "connect", to: "ready", on: "handshake.ready" },
    { id: "wrong-role", from: "connect", to: "close", on: "handshake.role" },
    { id: "lost", from: "ready", to: "close", on: "stream.close", note: "the commands in flight wait for the resend (event_handler.js:309-316)" },
    { id: "detected", from: "ready", to: "close", on: "rx.switch-master", note: "only with failoverDetector" },
    { id: "retry", from: "close", to: "reconnecting", on: "local.flush", note: "a close whose count is a multiple of maxRetriesPerRequest + 1 fails the queue first" },
    { id: "wait", from: "close", to: "reconnecting", on: "stream.close" },
    { id: "reconnect", from: "reconnecting", to: "resolving", on: "timer.retry", timer: "retry_delay" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { connecting: "SYN_SENT", connect: "ESTABLISHED", ready: "ESTABLISHED" },
    sets: { keepidle: { expr: "floor(keepAlive / 1000)", unit: "s" } },
    ends: "stream.close",
    note: "the socket of the primary is a Linux TCP socket with keepalive at keepAlive. A write in flight to a black hole waits for the retransmissions of the kernel",
  },
});
