import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact below is the JavaScript source of the npm package amqplib at 2.2.0, as the
// tag v2.2.0 of github.com/amqp-node/amqplib gives it (under lib/). Each line number is a line of that
// file at the tag. Node's own facts are from the source of node at the tag v24.21.0.
const AT = "amqplib 2.2.0 lib";

/**
 * This document is amqplib 2.2.0 on Node, for one connection to a broker of AMQP 0-9-1 and one channel
 * on it. It gives the states of the connection, from its connect to its end, and the timers that act on
 * it.
 *
 * At the defaults, amqplib takes the heartbeat that the broker proposes: 60 s for RabbitMQ 4.3. Each 30 s
 * it sends a heartbeat frame when it sent nothing since the check before. Its own heartbeat counts as a
 * send, thus an idle connection sends one each 60 s. Each 60 s it checks that the broker sent
 * something, and after two checks with nothing it ends the connection: 'Heartbeat timeout'. That end
 * comes 2 to 3 heartbeats after the last data.
 *
 * amqplib sets TCP_NODELAY only when the caller asks for it, thus Nagle is on at the defaults. It sets no
 * keepalive and no connect timeout. An RPC of a channel has no timer. The package does not connect again
 * by itself. Its recovery is a wrapper that this document does not hold.
 */
export const AMQPLIB: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "amqplib",
  title: "amqplib 2.2.0: one connection to an AMQP 0-9-1 broker, its heartbeat and an RPC of its channel",
  layer: "driver",
  version: "2.2.0",
  conditions: {
    amqplib: "2.2.0",
    node: "24.21.0",
    client: "amqplib.connect with a URL of amqp: and the socket options of the caller, and one channel of the promise API",
    transport: "TCP to a host and port, with no TLS",
    broker: "a broker that proposes a heartbeat in connection.tune: 60 s for RabbitMQ 4.3",
  },
  sources: [
    { ref: `${AT}/connect.js:62 the heartbeat of the URL query: null when the URL has none`, rung: "implemented" },
    { ref: `${AT}/connect.js:90-94 the socket options: noDelay and keepAlive are false and timeout is undefined unless the caller gives them, and keepAliveDelay is 0`, rung: "implemented" },
    { ref: `${AT}/connect.js:150-153 at the connect, setNoDelay(noDelay), thus false at the defaults, and setKeepAlive only when keepAlive is true`, rung: "implemented" },
    { ref: `${AT}/connect.js:155-160 and :179-185 a timeout of the caller bounds the connect and the handshake ('connect ETIMEDOUT'), and the open turns it off`, rung: "implemented" },
    { ref: `${AT}/connection.js:150-176 connection.tune: with no heartbeat of the caller, the heartbeat of the broker; with 0, no heartbeat; else the smaller of the two`, rung: "implemented" },
    { ref: `${AT}/connection.js:189-198 open-ok starts the heartbeat with the tuned value, and 0 starts none (:367-368)`, rung: "implemented" },
    { ref: `${AT}/connection.js:203-216 an end or an error of the socket in the handshake fails the connect ('Socket closed abruptly during opening handshake'). After the open, an error of the socket is an error of the connection, and an end of the socket is 'Unexpected close'`, rung: "implemented" },
    { ref: `${AT}/connection.js:296-303 onSocketError emits error one time, then the connection goes to closed`, rung: "implemented" },
    { ref: `${AT}/connection.js:341-354 toClosed stops the heartbeat, ends the socket (stream.end: a FIN, not a reset) and emits close`, rung: "implemented" },
    { ref: `${AT}/connection.js:367-381 the heartbeat: on timeout, error 'Heartbeat timeout' and then closed; on beat, a heartbeat frame`, rung: "implemented" },
    { ref: `${AT}/heartbeat.js:56-77 each interval / 2 the send check sends a heartbeat when nothing went out since the check before. Each interval the receive check counts a miss when nothing came in, and two misses in a row are a timeout`, rung: "implemented" },
    { ref: `${AT}/heartbeat.js:19-25 the comment of amqplib: the timeout comes between two and three intervals after the activity stops`, rung: "documented" },
    { ref: `${AT}/connection.js:452-471 checkSend and checkRecv read and clear a flag. Each send sets the send flag, a heartbeat too: an idle connection sends one heartbeat each interval`, rung: "implemented" },
    { ref: `${AT}/connection.js:540-551 each read of bytes from the socket sets the receive flag: a heartbeat frame of the broker counts as activity (:585)`, rung: "implemented" },
    { ref: `${AT}/connection.js:587-600 a connection.close of the broker: close-ok, then closed with 'Connection closed: <code>'. Only a fatal code is an error too, and 320 CONNECTION_FORCED is not (:645-653)`, rung: "implemented" },
    { ref: `${AT}/channel.js:97-123 an RPC of a channel has no timer: it waits for its reply, or for the end of the channel`, rung: "implemented" },
    { ref: `${AT}/channel.js:155-159 the end of the channel fails the RPC in flight: 'Channel ended, no reply will be forthcoming'`, rung: "implemented" },
    { ref: "node v24.21.0 lib/net.js:589 (a socket has no timeout until setTimeout), :828-843 (setNoDelay)", rung: "implemented" },
    { ref: "node v24.21.0 lib/events.js:489-506 an error event with no listener throws", rung: "implemented" },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before amqplib.connect" },
    connecting: { note: "The TCP connect, with no TCP_NODELAY and no keepalive at the defaults (connect.js:150-153)" },
    opening: { note: "The handshake of AMQP: the protocol header, start, tune and open, until open-ok (connection.js:85-223)" },
    idle: { note: "An open connection with no RPC in flight. The two heartbeat checks run" },
    waiting: { note: "An RPC of the channel in flight: the channel waits for its reply, with no timer. The two heartbeat checks run" },
    ended: { final: true, note: "The connection closed. amqplib does not connect again, and each RPC fails at once" },
  },
  events: {
    "app.connect": { kind: "app", note: "The application calls amqplib.connect" },
    "socket.connect": { kind: "local", note: "The TCP connect ends, and amqplib sends the protocol header" },
    "local.opened": { kind: "local", note: "open-ok: the end of the handshake, and the start of the heartbeat" },
    "app.rpc": { kind: "app", note: "An RPC of the channel goes out, for example a passive queue.declare" },
    "rx.reply": { kind: "rx", note: "The method that answers the RPC" },
    "rx.frame": { kind: "rx", note: "Bytes from the broker: a frame of a channel or a heartbeat frame. The receive check counts them as activity" },
    "rx.connection-close": { kind: "rx", note: "A connection.close of the broker, with its reply code and its text" },
    "peer.fin": { kind: "peer", note: "The broker or a middlebox ends the connection: an end of the socket" },
    "peer.rst": { kind: "peer", note: "A reset of the connection: the socket fails with ECONNRESET" },
    "socket.error": { kind: "local", note: "The socket fails with its own error: a reset, or a give-up of the kernel (ETIMEDOUT)" },
    "timer.connect": { kind: "timer", note: "The timeout of the socket fires before open-ok: 'connect ETIMEDOUT'" },
    "timer.beat": { kind: "timer", note: "The send check finds that nothing went out since the check before" },
    "timer.heartbeat": { kind: "timer", note: "The receive check finds nothing for the second time in a row" },
    "tx.heartbeat": { kind: "tx", note: "A heartbeat frame: 8 bytes (connection.js:469-471)" },
    "tx.fin": { kind: "tx", note: "The end of the socket of amqplib (stream.end): its FIN" },
  },
  knobs: {
    heartbeat: {
      key: "amqplib heartbeat, the tuned value",
      scope: "client",
      unit: "s",
      default: 60,
      off: 0,
      note: "connection.js:158-168: with no heartbeat in the URL, amqplib takes the value of the broker, 60 s for RabbitMQ 4.3 (rabbit Makefile:29). With a value of the caller, the smaller of the two. 0 is no heartbeat (2.0.0)",
    },
    timeout: {
      key: "amqplib socketOptions.timeout",
      scope: "client",
      unit: "ms",
      default: 0,
      off: 0,
      note: "connect.js:91, :179-185: undefined at the defaults, thus no timer for the connect and the handshake",
    },
    noDelay: { key: "amqplib socketOptions.noDelay", scope: "client", unit: null, default: 0, note: "connect.js:90, :152: false at the defaults, thus Nagle is on" },
    keepAlive: { key: "amqplib socketOptions.keepAlive", scope: "client", unit: null, default: 0, note: "connect.js:92, :153: false at the defaults, thus the socket has no keepalive" },
    keepAliveDelay: { key: "amqplib socketOptions.keepAliveDelay", scope: "client", unit: "ms", default: 0, note: "connect.js:94: the delay that setKeepAlive gets when keepAlive is true" },
    slack: {
      key: "the lateness of the event loop of Node for one step",
      scope: "process",
      unit: "s",
      default: 0.01,
      note: "An assumption of this document, not a value of amqplib: a timer or a callback of Node that comes late. In seconds, as the heartbeat",
    },
    hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null, note: "The build option of the kernel" },
  },
  timers: {
    connect_timeout: {
      duration: { knob: "timeout", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:connecting", "enter:opening"],
      cancels: ["local.opened", "socket.error", "peer.rst", "peer.fin"],
      fires: "timer.connect",
      note: "connect.js:179-185: one timeout of the socket for the connect and the handshake, which the open turns off. No bound at the defaults",
    },
    beat: {
      duration: { expr: "heartbeat / 2", unit: "s" },
      lateness: { expr: "heartbeat / 2 + slack", unit: "s" },
      arms: ["local.opened", "timer.beat"],
      fires: "timer.beat",
      note: "heartbeat.js:60: the send check each interval / 2. A send since the check before skips it, and the heartbeat counts as a send: thus an idle connection sends one each interval. The next frame of the client comes from interval / 2 to one interval after its last send",
    },
    heartbeat: {
      duration: { expr: "2 * heartbeat", unit: "s" },
      lateness: { expr: "heartbeat + slack", unit: "s" },
      arms: ["local.opened", "enter:idle", "enter:waiting", "rx.frame"],
      cancels: ["socket.error", "peer.rst", "peer.fin", "rx.connection-close"],
      fires: "timer.heartbeat",
      note: "heartbeat.js:64-71: the receive check each interval, and a timeout at the second miss in a row. The timer runs at a phase from the open, thus the timeout comes 2 to 3 intervals after the last bytes of the broker. It runs in each state of an open connection: the entry to a state names it here, but only bytes of the broker start it again",
    },
  },
  realizes: {
    "systems.mechanism.connect-bound": { timer: "connect_timeout" },
    "systems.mechanism.heartbeat-detection-time": { timer: "heartbeat" },
    "systems.mechanism.heartbeat-interval": { timer: "beat" },
    "systems.mechanism.idle-refresh-interval": {
      duration: { expr: "heartbeat / 2", unit: "s" },
      lateness: { expr: "heartbeat / 2 + slack", unit: "s" },
      note: "The heartbeat frames of the client on an idle connection: one each interval. The broker sends its own each interval / 2",
    },
  },
  transitions: [
    { id: "aq.connect", from: "[none]", to: "connecting", on: "app.connect", timer: "connect_timeout", source: "connect.js:166-172" },
    { id: "aq.connected", from: "connecting", to: "opening", on: "socket.connect", note: "amqplib sends the protocol header at once", source: "connect.js:150-172, connection.js:221-223" },
    { id: "aq.opened", from: "opening", to: "idle", on: "local.opened", note: "The heartbeat starts with the tuned value", source: "connection.js:189-198" },
    {
      id: "aq.connect-timed-out",
      from: ["connecting", "opening"],
      to: "ended",
      on: "timer.connect",
      timer: "connect_timeout",
      errno: "connect ETIMEDOUT",
      source: "connect.js:179-185",
    },
    {
      id: "aq.connect-failed",
      from: ["connecting", "opening"],
      to: "ended",
      on: ["socket.error", "peer.rst", "peer.fin", "rx.connection-close"],
      note: "The connect fails with the error of the socket, 'Socket closed abruptly during opening handshake', or 'Handshake terminated by server'",
      source: "connect.js:187-189, connection.js:150-157, :203-209",
    },
    { id: "aq.rpc", from: "idle", to: "waiting", on: "app.rpc", note: "The RPC has no timer", source: "channel.js:97-123" },
    { id: "aq.replied", from: "waiting", to: "idle", on: "rx.reply", source: "channel.js:100-103" },
    { id: "aq.beat-idle", from: "idle", to: "idle", on: "timer.beat", timer: "beat", emits: ["tx.heartbeat"], source: "connection.js:378-380, :469-471" },
    { id: "aq.beat-waiting", from: "waiting", to: "waiting", on: "timer.beat", timer: "beat", emits: ["tx.heartbeat"], source: "connection.js:378-380, :469-471" },
    {
      id: "aq.heartbeat-timeout",
      from: ["idle", "waiting"],
      to: "ended",
      on: "timer.heartbeat",
      timer: "heartbeat",
      errno: "Heartbeat timeout",
      emits: ["tx.fin"],
      note: "The connection emits error, ends its socket with a FIN and emits close. An RPC in flight fails with 'Channel ended, no reply will be forthcoming'",
      source: "connection.js:370-376, :341-354, channel.js:155-159",
    },
    {
      id: "aq.reset",
      from: ["idle", "waiting"],
      to: "ended",
      on: ["socket.error", "peer.rst"],
      errno: "ECONNRESET",
      note: "The error of the socket, with its own code: ECONNRESET for a reset, ETIMEDOUT for a give-up of the kernel. The connection emits it, then its close",
      source: "connection.js:213-214, :296-303",
    },
    {
      id: "aq.closed",
      from: ["idle", "waiting"],
      to: "ended",
      on: "peer.fin",
      errno: "Unexpected close",
      emits: ["tx.fin"],
      note: "The end of the socket is an error of the connection, and amqplib ends its side too",
      source: "connection.js:215, :296-303, :341-354",
    },
    {
      id: "aq.closed-by-broker",
      from: ["idle", "waiting"],
      to: "ended",
      on: "rx.connection-close",
      errno: "Connection closed",
      emits: ["tx.fin"],
      note: "close-ok, then the end. The close has the reply code of the broker. For 320 (CONNECTION_FORCED) amqplib emits no error, only its close",
      source: "connection.js:587-600, :645-653",
    },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { connecting: "SYN_SENT", opening: "ESTABLISHED", idle: "ESTABLISHED", waiting: "ESTABLISHED" },
    sets: {},
    ends: "socket.error",
    note: "The socket of the connection: a Linux TCP socket with Nagle on and no keepalive at the defaults. Thus the kernel ends a send with no ACK only at the give-up of its retransmissions",
  },
});
