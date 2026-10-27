import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The source of each fact below is the source of MongoDB at the tag r9.0.4. Each line number is a
// line of that file at that tag.
const AT = "mongodb r9.0.4 src/mongo";

/**
 * This document is the hold of mongod 9.0.4 on one client connection, over its socket. `mongod`
 * turns keepalive on for each TCP session. It lowers two keepalive options of the socket to a
 * maximum: the idle time to 300 s and the interval to 1 s. It does not change the probe count.
 * Thus the namespace sysctls give the idle time and the interval only when they are lower, and
 * they always give the count.
 *
 * `mongod` writes no warning about keepalive. A failure to read or to set an option goes to the
 * log at debug level 3 in a release build.
 *
 * An awaitable hello of an exhaust stream waits for a change of the topology or `maxAwaitTimeMS`.
 * Then `mongod` sends the reply, and it starts the next hello of the stream at once.
 */
export const MONGOD_SESSION: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "mongod-session",
  title: "A client connection as mongod 9.0.4 holds it, over its Linux socket",
  layer: "server",
  version: "9.0.4",
  conditions: { mongodb: "9.0.4", os: "linux", image: "mongo:9.0.4 (Ubuntu 26.04)" },
  sources: [
    { ref: `${AT}/transport/asio/asio_session_impl.cpp:156-165 each TCP session: TCP_NODELAY, SO_KEEPALIVE, setSocketKeepAliveParams, failures at debug 3 in a release build`, rung: "implemented" },
    { ref: `${AT}/util/net/socket_utils.h:15-16 kMaxKeepIdleSecs 300 and kMaxKeepIntvlSecs 1, :19-22 the defaults of setSocketKeepAliveParams`, rung: "implemented" },
    { ref: `${AT}/util/net/socket_utils.cpp:165-196 applyMax: read the option, and set the maximum only when the value is higher, :199-220 TCP_KEEPIDLE and TCP_KEEPINTVL, never TCP_KEEPCNT`, rung: "implemented" },
    { ref: `${AT}/util/net/socket_utils.cpp:176-181 and :190-194 the log of a failed read or set, at the severity of the caller`, rung: "implemented" },
    { ref: `${AT}/util/net/sock.cpp:135-142 the older socket path: SO_KEEPALIVE, then the same maximums, failures as errors`, rung: "implemented" },
    { ref: `${AT}/db/repl/replication_info.cpp:131-143 an awaitable hello waits until now + maxAwaitTimeMS on the precise clock, or a change of the topology`, rung: "implemented" },
  ],
  states: {
    ABSENT: { initial: true, pseudo: true },
    CONNECTED: { note: "a session of the transport layer, with its socket" },
    GONE: { final: true },
  },
  events: {
    accept: { kind: "local" },
    "peer.fin": { kind: "peer", note: "a read gives 0 bytes: the client closed" },
    "peer.rst": { kind: "peer" },
    "socket.error": { kind: "local", note: "a read fails with the error of the socket: the kernel gave up, by keepalive or by its retransmissions" },
    "rx.hello": { kind: "rx", note: "an awaitable hello with exhaustAllowed: the start of a stream" },
    "tx.hello-reply": { kind: "tx", note: "a reply of the stream, after which mongod runs the next hello" },
  },
  knobs: {
    tcp_keepalive_time: { key: "net.ipv4.tcp_keepalive_time", scope: "netns", unit: "s", default: 7200, note: "the value of a new socket, which mongod lowers to max_keep_idle" },
    tcp_keepalive_intvl: { key: "net.ipv4.tcp_keepalive_intvl", scope: "netns", unit: "s", default: 75, note: "the value of a new socket, which mongod lowers to max_keep_intvl" },
    tcp_keepalive_probes: { key: "net.ipv4.tcp_keepalive_probes", scope: "netns", unit: "count", default: 9, note: "mongod does not change it" },
    max_keep_idle: { key: "kMaxKeepIdleSecs", scope: "build", unit: "s", default: 300, note: "socket_utils.h:15" },
    max_keep_intvl: { key: "kMaxKeepIntvlSecs", scope: "build", unit: "s", default: 1, note: "socket_utils.h:16" },
    hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null, note: "the kernel's build option: the timer wheel rounds the keepalive of mongod" },
    maxAwaitTimeMS: { key: "hello maxAwaitTimeMS", scope: "command", unit: "ms", default: null, note: "the field of an awaitable hello: the driver sends its heartbeatFrequencyMS (mongodb monitor.ts:338-371)" },
    wait_slack: {
      key: "the lateness of a wait of a command of mongod",
      scope: "process",
      unit: "ms",
      default: 20,
      note: "an assumption of this document, not a value of mongod. In CI, the first reply of a stream after a fault came 1 ms to 10.6 ms after maxAwaitTimeMS (T01.defaults.42, T03.defaults.3)",
    },
  },
  timers: {
    hello_await: {
      duration: { knob: "maxAwaitTimeMS", unit: "ms" },
      lateness: { knob: "wait_slack", unit: "ms" },
      arms: ["rx.hello", "tx.hello-reply"],
      fires: "tx.hello-reply",
      note: "replication_info.cpp:131-143: with no change of the topology, each reply of the stream comes maxAwaitTimeMS after the last reply, or after the request",
    },
  },
  realizes: {
    "systems.mechanism.idle-refresh-interval": {
      duration: { expr: "min(tcp_keepalive_time, max_keep_idle)", unit: "s" },
      lateness: { model: "linux.wheel", knobs: ["max_keep_idle", "hz"], unit: "s" },
      early: { model: "linux.jiffy", knobs: ["hz"], unit: "s" },
      note: "the first probe of an idle connection. The lateness is the wheel's at 300 s: at a lower idle time it is the same or longer than the true one",
    },
    "systems.mechanism.keepalive-detection-window": { timer: "keepalive" },
  },
  transitions: [
    { id: "ms.accept", from: "ABSENT", to: "CONNECTED", on: "accept", source: "asio_session_impl.cpp:149-165" },
    { id: "ms.gone", from: "CONNECTED", to: "GONE", on: ["peer.fin", "peer.rst", "socket.error"] },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { CONNECTED: "ESTABLISHED" },
    sets: {
      keepidle: { expr: "min(tcp_keepalive_time, max_keep_idle)", unit: "s" },
      keepintvl: { expr: "min(tcp_keepalive_intvl, max_keep_intvl)", unit: "s" },
      keepcnt: { knob: "tcp_keepalive_probes", unit: "count" },
    },
    ends: "socket.error",
    note: "at the Linux defaults the window is 300 s + 9 × 1 s = 309 s, not 300 s + 9 × 75 s: the interval has a maximum too",
  },
});
