import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The source of each fact below is the TypeScript source of the npm package @grpc/grpc-js at 1.14.6,
// as its tarball gives it (under src/). Each line number is a line of that file in the tarball. 1.14.6
// differs from 1.14.5 only in how it stamps the times of channelz and of a deadline (Date.now). Node's
// own facts are from the source of node at the tag v24.21.0.
const AT = "@grpc/grpc-js 1.14.6 src";

/**
 * This document is grpc-js 1.14.6 on Node, for one channel to one server with no TLS, its transport
 * (one HTTP/2 session on one TCP connection) and one unary call on it. It gives the states of the
 * transport, from its connect to its end, and the timers that act on it.
 *
 * At the defaults the keepalive of grpc-js is off: it sends no PING. It sets TCP_NODELAY and no TCP
 * keepalive, and its connect has no timeout. A call has no deadline. Thus nothing in grpc-js ends a
 * call on a silent connection: only the kernel can, or the server.
 *
 * When the transport ends, each call in flight on it ends with UNAVAILABLE. The client does not retry such
 * a call, because the call reached the server (PROCESSED). It retries only a call that did not start, and
 * once a stream that the server refused. The channel then goes IDLE, and the next call connects again. A call
 * that finds the channel in TRANSIENT_FAILURE fails at once, unless it asks to wait for the channel.
 */
export const GRPC_JS: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "grpc-js",
  title: "grpc-js 1.14.6: one channel to a gRPC server, its HTTP/2 transport, its keepalive and a unary call",
  layer: "driver",
  version: "1.14.6",
  conditions: {
    "grpc-js": "1.14.6",
    node: "24.21.0",
    client: "a Client of grpc-js with the channel options of the caller, and unary calls with no deadline and no waitForReady",
    transport: "HTTP/2 over TCP to a host and port, with no TLS (createInsecure), and the load balancer pick_first",
    server: "any gRPC server",
  },
  sources: [
    { ref: `${AT}/transport.ts:70 KEEPALIVE_TIMEOUT_MS is 20000`, rung: "implemented" },
    {
      ref: `${AT}/transport.ts:183-198 grpc.keepalive_time_ms is -1 when the caller gives none, grpc.keepalive_timeout_ms is 20000, and grpc.keepalive_permit_without_calls is false`,
      rung: "implemented",
    },
    { ref: `${AT}/transport.ts:447-453 a PING goes out only with a keepalive time above 0, and with a call in flight or permit_without_calls`, rung: "implemented" },
    {
      ref: `${AT}/transport.ts:455-507 each PING starts a timer of keepalive_timeout_ms, and its end with no ACK ends the transport (handleDisconnect). A failed send of the PING ends it too`,
      rung: "implemented",
    },
    {
      ref: `${AT}/transport.ts:515-534 and :553-561 the keepalive timer starts with the first call in flight, and after each ACK. It is not reset by data. When it ends with no call in flight, the PING goes out at the start of the next call`,
      rung: "implemented",
    },
    { ref: `${AT}/transport.ts:200-242 a close or an error of the session, or a close of its socket, ends the transport. A GOAWAY makes it unusable (reportDisconnectToOwner)`, rung: "implemented" },
    { ref: `${AT}/transport.ts:205-227 a GOAWAY ENHANCE_YOUR_CALM with the data too_many_pings tells the subchannel that the server refused the pings`, rung: "implemented" },
    {
      ref: `${AT}/transport.ts:431-441 handleDisconnect: each call in flight gets onDisconnect, and the session is destroyed in the next turn of the event loop`,
      rung: "implemented",
    },
    { ref: `${AT}/transport.ts:684-687 shutdown closes the session: a GOAWAY, then the end of the socket after the last stream`, rung: "implemented" },
    { ref: `${AT}/transport.ts:792-810 the transport is ready at the first SETTINGS of the server (remoteSettings)`, rung: "implemented" },
    { ref: `${AT}/transport.ts:818-840 the TCP connect is net.connect with no timeout`, rung: "implemented" },
    { ref: `${AT}/transport.ts:862 setNoDelay on each connection: TCP_NODELAY, thus no Nagle. No setKeepAlive anywhere in the package`, rung: "implemented" },
    {
      ref: `${AT}/subchannel-call.ts:360-371 onDisconnect ends the call with UNAVAILABLE 'Connection dropped' in the next turn of the event loop, unless the stream ends first`,
      rung: "implemented",
    },
    {
      ref: `${AT}/subchannel-call.ts:230-329 the end of a stream with no status: REFUSED_STREAM is UNAVAILABLE, CANCEL after a dropped connection is UNAVAILABLE, and an internal error of ECONNRESET or ETIMEDOUT is UNAVAILABLE`,
      rung: "implemented",
    },
    {
      ref: `${AT}/load-balancing-call.ts:257-261 a stream that the server refused has the progress REFUSED, and any other started stream PROCESSED`,
      rung: "implemented",
    },
    {
      ref: `${AT}/retrying-call.ts:631-652 a transparent retry for NOT_STARTED, and one for REFUSED. A PROCESSED call is retried only by a retry policy of the service config, which the defaults do not have`,
      rung: "implemented",
    },
    { ref: `${AT}/load-balancing-call.ts:338-345 a pick in TRANSIENT_FAILURE fails the call at once, unless it asks for waitForReady`, rung: "implemented" },
    { ref: `${AT}/resolving-call.ts:118-180 the deadline of a call is a timer from the start of the call. Its end cancels the call with DEADLINE_EXCEEDED`, rung: "implemented" },
    {
      ref: `${AT}/deadline.ts:39-52 the header grpc-timeout is the time left to the deadline when the call sends its headers, rounded up to whole milliseconds. A server can start a timer of it`,
      rung: "implemented",
    },
    { ref: `${AT}/subchannel-call.ts:269-279 a RST_STREAM CANCEL of the server ends the call with CANCELLED 'Call cancelled'`, rung: "implemented" },
    { ref: "run 39272272260 (T01.array.206): a deadline of 4 s against a server of grpc-go ended 4 of 11 calls with CANCELLED, each in the band of the deadline. In each of the 4, the handler at the server ended 1.1 ms before the end of the call. In 7 runs with DEADLINE_EXCEEDED it ended later, or at most 1.5 ms before", rung: "observed" },
    { ref: `${AT}/subchannel.ts:275-291 the end of the transport takes the subchannel from READY to IDLE. After too_many_pings the keepalive time doubles`, rung: "implemented" },
    { ref: `${AT}/subchannel.ts:298-304 a failed connect takes the subchannel to TRANSIENT_FAILURE`, rung: "implemented" },
    { ref: `${AT}/backoff-timeout.ts:23-26 the reconnect waits 1000 ms first, each next wait 1.6 times longer, up to 120000 ms, with a jitter of 0.2`, rung: "implemented" },
    { ref: `${AT}/backoff-timeout.ts:124, :169-181, :197-201 the first wait after a reset is the initial delay, with no jitter. Each next wait is the last wait, jitter included, times 1.6 and capped, then ± 20 %: the jitter compounds`, rung: "implemented" },
    { ref: `${AT}/internal-channel.ts:74-77 and :324-325 a channel with no call for grpc.client_idle_timeout_ms goes IDLE: 30 min at the defaults, 1 s at least`, rung: "implemented" },
    { ref: "node v24.21.0 lib/net.js:589 (a socket has no timeout until setTimeout), :828-843 (setNoDelay)", rung: "implemented" },
    { ref: "node v24.21.0 lib/internal/http2/core.js: no PING of its own, and no timeout of the session at the defaults", rung: "implemented" },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the first call: the channel is IDLE" },
    connecting: { note: "The TCP connect, with TCP_NODELAY, no keepalive and no timeout (transport.ts:818-862). The call waits in the queue of the channel" },
    opening: { note: "The HTTP/2 preface and the SETTINGS of the client, until the first SETTINGS of the server (transport.ts:792-810)" },
    idle: { note: "A ready transport with no call in flight. At the defaults no timer runs on it" },
    waiting: { note: "A unary call in flight: the call waits for its status, with no timer at the defaults" },
    ended: { final: true, note: "The transport ended. Each call in flight ended with UNAVAILABLE, and the channel is IDLE until the next call" },
  },
  events: {
    "app.call": { kind: "app", note: "The application starts a unary call, for example grpc.health.v1.Health/Check" },
    "socket.connect": { kind: "local", note: "The TCP connect ends, and the session sends its preface and its SETTINGS" },
    "rx.settings": { kind: "rx", note: "The first SETTINGS of the server: the transport is ready, and the queued call goes out" },
    "rx.reply": { kind: "rx", note: "The status of the call, in the trailers of its stream" },
    "rx.ping-ack": { kind: "rx", note: "The ACK of a PING of the keepalive" },
    "rx.goaway": { kind: "rx", note: "A GOAWAY of the server. The transport takes no new call" },
    "peer.fin": { kind: "peer", note: "The server or a middlebox ends the connection: an end of the socket" },
    "peer.rst": { kind: "peer", note: "A reset of the connection: the socket fails with ECONNRESET" },
    "socket.error": { kind: "local", note: "The socket fails with its own error: a reset, or a give-up of the kernel (ETIMEDOUT, EHOSTUNREACH)" },
    "timer.keepalive": { kind: "timer", note: "The keepalive timer ends: the transport sends a PING" },
    "timer.ping-timeout": { kind: "timer", note: "No ACK came for the PING in keepalive_timeout_ms" },
    "timer.deadline": { kind: "timer", note: "The deadline of the call ends: DEADLINE_EXCEEDED" },
    "timer.idle": { kind: "timer", note: "The channel had no call for client_idle_timeout_ms" },
    "timer.reconnect": { kind: "timer", note: "The backoff of the subchannel ends: the next connect can start" },
    "tx.ping": { kind: "tx", note: "A PING frame of the keepalive" },
    "tx.goaway": { kind: "tx", note: "The GOAWAY of a session that the client closes (shutdown)" },
    "tx.fin": { kind: "tx", note: "The end of the socket of grpc-js, when the session is destroyed: its FIN" },
  },
  knobs: {
    keepalive_time: {
      key: "grpc.keepalive_time_ms",
      scope: "client",
      unit: "ms",
      default: 0,
      off: 0,
      note: "transport.ts:183-187, :447-453: -1 when the caller gives none, and the keepalive sends no PING unless the value is above 0. 0 here is that state: off",
    },
    keepalive_timeout: { key: "grpc.keepalive_timeout_ms", scope: "client", unit: "ms", default: 20000, note: "transport.ts:70, :188-192: the wait for the ACK of each PING" },
    keepalive_permit_without_calls: {
      key: "grpc.keepalive_permit_without_calls",
      scope: "client",
      unit: null,
      default: 0,
      note: "transport.ts:193-198: 1 sends the PINGs with no call in flight too",
    },
    deadline: { key: "the deadline of a call", scope: "client", unit: "ms", default: 0, off: 0, note: "client.ts:72: no deadline unless the caller gives one" },
    initial_reconnect_backoff: { key: "grpc.initial_reconnect_backoff_ms", scope: "client", unit: "ms", default: 1000, note: "backoff-timeout.ts:23" },
    max_reconnect_backoff: { key: "grpc.max_reconnect_backoff_ms", scope: "client", unit: "ms", default: 120000, note: "backoff-timeout.ts:25" },
    client_idle_timeout: { key: "grpc.client_idle_timeout_ms", scope: "client", unit: "ms", default: 1800000, note: "internal-channel.ts:77: 30 min" },
    slack: {
      key: "the lateness of the event loop of Node for one step",
      scope: "process",
      unit: "s",
      default: 0.01,
      note: "An assumption of this document, not a value of grpc-js: a timer or a callback of Node that comes late",
    },
    hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null, note: "The build option of the kernel" },
  },
  timers: {
    keepalive: {
      duration: { knob: "keepalive_time", unit: "ms" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:waiting", "rx.ping-ack"],
      fires: "timer.keepalive",
      note: "transport.ts:515-534, :553-561: from the first call in flight and from each ACK, not from data. Off at the defaults",
    },
    ping_timeout: {
      duration: { knob: "keepalive_timeout", unit: "ms" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["tx.ping"],
      cancels: ["rx.ping-ack", "socket.error", "peer.rst", "peer.fin"],
      fires: "timer.ping-timeout",
      note: "transport.ts:472-477: the end of the wait for the ACK ends the transport. Only a PING arms it, thus it does not run at the defaults",
    },
    deadline: {
      duration: { knob: "deadline", unit: "ms" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["app.call", "enter:waiting"],
      cancels: ["rx.reply", "socket.error", "peer.rst", "peer.fin"],
      fires: "timer.deadline",
      note: "resolving-call.ts:118-180: the deadline of the call, DEADLINE_EXCEEDED. No bound at the defaults. A server of grpc-go starts a timer of the same time from the header grpc-timeout, and its RST_STREAM CANCEL can reach the call first: then the call ends with CANCELLED",
    },
    idle_timeout: {
      duration: { knob: "client_idle_timeout", unit: "ms" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:idle"],
      cancels: ["app.call"],
      fires: "timer.idle",
      note: "internal-channel.ts:324-325, :655: the channel goes IDLE and closes its transport",
    },
    reconnect: {
      duration: { expr: "min(initial_reconnect_backoff * pow(1.6, fired), max_reconnect_backoff)", unit: "ms" },
      // the shortest wait n is min(I·(1.6·0.8)^n, 0.8·M) and the longest min(I·(1.6·1.2)^n, 1.2·M): each wait
      // multiplies the last one, jitter included, and the first one has no jitter (backoff-timeout.ts:169-181)
      early: { expr: "min(initial_reconnect_backoff * pow(1.6, fired), max_reconnect_backoff) - min(initial_reconnect_backoff * pow(1.28, fired), 0.8 * max_reconnect_backoff)", unit: "ms" },
      lateness: {
        expr: "min(initial_reconnect_backoff * pow(1.92, fired), 1.2 * max_reconnect_backoff) - min(initial_reconnect_backoff * pow(1.6, fired), max_reconnect_backoff) + 1000 * slack",
        unit: "ms",
      },
      arms: ["enter:connecting"],
      cancels: ["rx.settings"],
      fires: "timer.reconnect",
      backoff: { resets: ["rx.settings"] },
      note: "backoff-timeout.ts:23-26, :169-181, subchannel.ts:349-372: the backoff starts with each connect. A connect that fails before it ends waits for it. A ready transport stops it and starts it again from 1 s, with no jitter. In kind run 39390098968, the calls of a client failed for 984 ms to 1021 ms after a refused connect",
    },
  },
  realizes: {
    "systems.mechanism.heartbeat-interval": { timer: "keepalive" },
    "systems.mechanism.heartbeat-detection-time": {
      duration: { expr: "keepalive_time + keepalive_timeout", unit: "ms" },
      lateness: { expr: "2000 * slack", unit: "ms" },
      note: "With the keepalive on: the PING after keepalive_time, and the end of the transport keepalive_timeout after it. Off at the defaults",
    },
  },
  transitions: [
    { id: "gj.call", from: "[none]", to: "connecting", on: "app.call", note: "The first call takes the channel from IDLE to CONNECTING. The call waits in its queue", source: "internal-channel.ts, subchannel.ts:252-262" },
    { id: "gj.connected", from: "connecting", to: "opening", on: "socket.connect", note: "TCP_NODELAY, then the preface of HTTP/2", source: "transport.ts:842-870" },
    { id: "gj.ready", from: "opening", to: "waiting", on: "rx.settings", note: "The transport is ready, and the queued call goes out", source: "transport.ts:792-810, subchannel.ts:264-275" },
    {
      id: "gj.connect-failed",
      from: ["connecting", "opening"],
      to: "ended",
      on: ["socket.error", "peer.rst", "peer.fin"],
      errno: "UNAVAILABLE",
      note: "The subchannel goes to TRANSIENT_FAILURE, and the queued call fails at once with UNAVAILABLE and the error of the connect (ECONNREFUSED for a reset of the SYN)",
      source: "subchannel.ts:298-304, load-balancing-call.ts:338-345",
    },
    { id: "gj.call-idle", from: "idle", to: "waiting", on: "app.call", source: "transport.ts:563-666" },
    { id: "gj.replied", from: "waiting", to: "idle", on: "rx.reply", source: "subchannel-call.ts:166-180" },
    { id: "gj.deadline", from: "waiting", to: "idle", on: "timer.deadline", timer: "deadline", errno: "DEADLINE_EXCEEDED", note: "The call ends, and the transport stays", source: "client.ts:72" },
    { id: "gj.ping", from: "waiting", to: "waiting", on: "timer.keepalive", timer: "keepalive", emits: ["tx.ping"], source: "transport.ts:455-507" },
    { id: "gj.ping-ack", from: "waiting", to: "waiting", on: "rx.ping-ack", source: "transport.ts:488-491" },
    {
      id: "gj.ping-timeout",
      from: ["idle", "waiting"],
      to: "ended",
      on: "timer.ping-timeout",
      timer: "ping_timeout",
      errno: "CLOSED",
      emits: ["tx.fin"],
      note: "The transport ends by itself and destroys its session. A call in flight ends with UNAVAILABLE 'Connection dropped'",
      source: "transport.ts:472-476, :431-441, subchannel-call.ts:360-371",
    },
    {
      id: "gj.reset",
      from: ["idle", "waiting"],
      to: "ended",
      on: ["socket.error", "peer.rst"],
      errno: "ECONNRESET",
      note: "The error of the socket, with its own code: ECONNRESET for a reset, ETIMEDOUT or EHOSTUNREACH for a give-up of the kernel. A call in flight ends with UNAVAILABLE",
      source: "transport.ts:230-242, :431-441, subchannel-call.ts:289-313",
    },
    {
      id: "gj.closed",
      from: ["idle", "waiting"],
      to: "ended",
      on: "peer.fin",
      errno: "EOF",
      emits: ["tx.fin"],
      note: "The end of the socket ends the session, and grpc-js destroys its side. A call in flight ends with UNAVAILABLE",
      source: "transport.ts:200-203, :237-242, :431-441",
    },
    {
      id: "gj.goaway",
      from: ["idle", "waiting"],
      to: "ended",
      on: "rx.goaway",
      errno: "GOAWAY",
      note: "The transport takes no new call, and the subchannel goes IDLE. A stream above the last stream id of the GOAWAY is refused and retried once. The server then ends the connection",
      source: "transport.ts:205-227, subchannel.ts:275-291",
    },
    { id: "gj.idle-timeout", from: "idle", to: "ended", on: "timer.idle", timer: "idle_timeout", emits: ["tx.goaway", "tx.fin"], source: "internal-channel.ts:655, transport.ts:684-687" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { connecting: "SYN_SENT", opening: "ESTABLISHED", idle: "ESTABLISHED", waiting: "ESTABLISHED" },
    sets: {},
    ends: "socket.error",
    note: "The socket of the transport: a Linux TCP socket with TCP_NODELAY and no keepalive. Thus the kernel ends a send with no ACK only at the give-up of its retransmissions, and an idle socket to a peer that is gone stays open",
  },
});
