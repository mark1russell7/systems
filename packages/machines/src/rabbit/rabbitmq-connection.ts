import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact below is the Erlang source of RabbitMQ at the tag v4.3.6 of
// github.com/rabbitmq/rabbitmq-server, and of ranch at 2.3.0, the version that RabbitMQ locks
// (rabbitmq-components.mk:59). Each line number is a line of that file at its tag. A fact of the
// kernel or of the BEAM is an assumption of this document, and its note says so.
export const RMQ = "v4.3.6";

/**
 * This document is RabbitMQ 4.3.6, for one connection of AMQP 0-9-1 on the broker. It gives the reader of
 * the connection, from the accept to the close, and the timers that act on it.
 *
 * At the defaults the broker proposes a heartbeat of 60 s, and it uses the value of the tune-ok of the
 * client. Each 30 s it sends a heartbeat frame when it sent nothing: its own heartbeat does not count,
 * thus an idle connection gets one each 30 s. Each 60 s it checks that the client sent something. After
 * two checks with nothing, it ends the connection, 2 to 3 heartbeats after the last data.
 *
 * Each socket of a listener has linger 0, thus each close of the broker is a reset, not a FIN. The
 * listener of ranch gives each socket a send timeout of 30 s. After it, the BEAM closes the socket, with
 * a reset too. A resource alarm blocks a connection that publishes: the reader stops to read
 * its socket, and the receive check pauses.
 */
export const RABBITMQ_CONNECTION: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "rabbitmq-connection",
  title: "RabbitMQ 4.3.6: one connection of AMQP 0-9-1 on the broker, its heartbeat, its send timeout and its close",
  layer: "proxy",
  version: "4.3.6",
  conditions: {
    rabbitmq: "4.3.6",
    ranch: "2.3.0",
    listener: "the AMQP listener of the broker with the default tcp_listen_options, and no TLS",
    connection: "a connection of AMQP 0-9-1 that a client opens, with the heartbeat of its tune-ok",
  },
  sources: [
    { ref: `${RMQ} deps/rabbit/Makefile:29 the default heartbeat of the broker: 60 s`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit/Makefile:57 handshake_timeout 10000 ms`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit/Makefile:60-64 tcp_listen_options: backlog 128, nodelay true, linger {true, 0}, exit_on_close false`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit/src/tcp_listener_sup.erl:40-53 the listener is a ranch listener, with tcp_listen_options as its socket options`, rung: "implemented" },
    { ref: `${RMQ} rabbitmq-components.mk:59 ranch 2.3.0. ranch 2.3.0 src/ranch_tcp.erl:106-109: a listener sets send_timeout 30000 and send_timeout_close true unless its options give them, and tcp_listen_options gives neither`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit/src/rabbit_reader.erl:1292-1323 tune-ok: the heartbeat of the client is the timeout of the two heartbeaters`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit_common/src/rabbit_heartbeat.erl:73-78 the sender: each timeout / 2, a heartbeat frame when send_oct did not change`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit_common/src/rabbit_heartbeat.erl:150-158 after the handler of the sender, it reads send_oct again: its own heartbeat does not count as a send, thus an idle connection gets one each timeout / 2`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit_common/src/rabbit_heartbeat.erl:80-85 the receiver: each timeout, a miss when recv_oct did not change, and the end at the second miss in a row. The comment: the end comes between 2 and 3 intervals after the last data`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit/src/rabbit_reader.erl:650-655 heartbeat_timeout ends the reader, and :405-407 logs 'missed heartbeats from client, timeout: <T>s'`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit/src/rabbit_reader.erl:302-304, :644-649 a timer of handshake_timeout from the start of the reader. It ends a connection that is not open at that time`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit/src/rabbit_reader.erl:368-372 at the end of the reader, rabbit_net:fast_close and not gen_tcp:close, which waits for the output. deps/rabbit_common/src/rabbit_net.erl:182-184 fast_close is port_close`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit/src/rabbit_reader.erl:541-542 an end of the socket stops the reader: 'client unexpectedly closed TCP connection' (:410-446)`, rung: "implemented" },
    { ref: `${RMQ} deps/rabbit/src/rabbit_reader.erl:480-481, :1803-1830 a resource alarm blocks a connection that publishes: the reader does not read its socket, and the receive check pauses until the unblock`, rung: "implemented" },
    {
      ref: "Linux: a close of a socket with SO_LINGER on and a linger time of 0 sends a reset and drops the send queue (tcp_close, net/ipv4/tcp.c). An assumption of this document about the kernel",
      rung: "documented",
    },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before ranch accepts the connection" },
    handshake: { note: "The protocol header, start-ok, tune-ok and open, until open-ok. The handshake timer runs" },
    running: { note: "An open connection: the reader reads each frame, and the two heartbeaters run" },
    blocked: { note: "A resource alarm blocked the connection: the reader does not read its socket, and the receive check pauses" },
    ended: { final: true, note: "The reader ended, and the broker closed the socket with linger 0: a reset" },
  },
  events: {
    "local.accept": { kind: "local", note: "ranch accepts the TCP connection" },
    "rx.opened": { kind: "rx", note: "connection.open of the client, then open-ok: the end of the handshake" },
    "rx.frame": { kind: "rx", note: "Bytes from the client: a frame of a channel or a heartbeat frame. recv_oct counts them" },
    "local.alarm": { kind: "local", note: "A resource alarm of memory or of disk, on a connection that publishes" },
    "local.alarm-cleared": { kind: "local", note: "The alarm clears" },
    "local.send-blocked": { kind: "local", note: "A write of the broker waits: the send buffer of the socket is full" },
    "local.send-drained": { kind: "local", note: "The write ends" },
    "peer.fin": { kind: "peer", note: "The client ends the connection: an end of the socket" },
    "peer.rst": { kind: "peer", note: "A reset of the connection" },
    "socket.error": { kind: "local", note: "The socket fails: a reset, or a give-up of the kernel" },
    "timer.handshake": { kind: "timer", note: "handshake_timeout before open-ok" },
    "timer.beat": { kind: "timer", note: "The sender finds that send_oct did not change for timeout / 2" },
    "timer.heartbeat": { kind: "timer", note: "The receiver finds that recv_oct did not change, for the second time in a row" },
    "timer.send": { kind: "timer", note: "A write waits send_timeout: the BEAM closes the socket" },
    "tx.heartbeat": { kind: "tx", note: "A heartbeat frame" },
    "tx.rst": { kind: "tx", note: "The close of the broker with linger 0: a reset to the client" },
  },
  knobs: {
    heartbeat: {
      key: "rabbitmq heartbeat, the tuned value",
      scope: "server",
      unit: "s",
      default: 60,
      off: 0,
      note: "Makefile:29 proposes 60 s, and the reader uses the value of the tune-ok of the client (rabbit_reader.erl:1292-1323). 0 is no heartbeat",
    },
    handshake_timeout: { key: "rabbitmq handshake_timeout", scope: "server", unit: "ms", default: 10000, note: "Makefile:57" },
    send_timeout: {
      key: "the send_timeout of a socket of the listener",
      scope: "server",
      unit: "ms",
      default: 30000,
      note: "ranch 2.3.0 src/ranch_tcp.erl:108-109: 30000, with send_timeout_close true. tcp_listen_options of RabbitMQ does not set it",
    },
    slack: {
      key: "the lateness of the scheduler of the BEAM for one step",
      scope: "process",
      unit: "s",
      default: 0.01,
      note: "An assumption of this document, not a value of RabbitMQ: a timer of the BEAM that comes late. In seconds, as the heartbeat",
    },
  },
  timers: {
    handshake: {
      duration: { knob: "handshake_timeout", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["local.accept"],
      cancels: ["rx.opened", "peer.fin", "peer.rst", "socket.error"],
      fires: "timer.handshake",
      note: "rabbit_reader.erl:302-304, :644-649: from the start of the reader. A running connection ignores it",
    },
    beat: {
      duration: { expr: "heartbeat / 2", unit: "s" },
      lateness: { expr: "heartbeat / 2 + slack", unit: "s" },
      arms: ["rx.opened", "timer.beat"],
      fires: "timer.beat",
      note: "rabbit_heartbeat.erl:73-78, :150-158: the check each timeout / 2. Its own heartbeat does not count, thus an idle connection gets a frame each timeout / 2. After a frame of a channel, the next frame comes from timeout / 2 to one timeout later",
    },
    heartbeat: {
      duration: { expr: "2 * heartbeat", unit: "s" },
      lateness: { expr: "heartbeat + slack", unit: "s" },
      arms: ["rx.opened", "enter:running", "rx.frame", "local.alarm-cleared"],
      cancels: ["local.alarm", "peer.fin", "peer.rst", "socket.error"],
      fires: "timer.heartbeat",
      note: "rabbit_heartbeat.erl:80-85: the check each timeout, and the end at the second miss in a row: 2 to 3 timeouts after the last data. A block pauses it, and the unblock starts it again (rabbit_reader.erl:1803-1830). The entry to running names it here, but only bytes of the client start it again",
    },
    send: {
      duration: { knob: "send_timeout", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["local.send-blocked"],
      cancels: ["local.send-drained"],
      fires: "timer.send",
      note: "ranch 2.3.0: send_timeout_close. A write that waits 30 s fails, and the BEAM closes the socket: with linger 0, a reset",
    },
  },
  realizes: {
    "systems.mechanism.heartbeat-detection-time": { timer: "heartbeat" },
    "systems.mechanism.heartbeat-interval": { timer: "beat" },
    "systems.mechanism.idle-refresh-interval": {
      duration: { expr: "heartbeat / 2", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      note: "The heartbeat frames of the broker on an idle connection: one each timeout / 2",
    },
  },
  transitions: [
    { id: "rq.accept", from: "[none]", to: "handshake", on: "local.accept", timer: "handshake", source: "rabbit_reader.erl:290-304" },
    { id: "rq.opened", from: "handshake", to: "running", on: "rx.opened", note: "The two heartbeaters start with the value of the tune-ok", source: "rabbit_reader.erl:1292-1328" },
    {
      id: "rq.handshake-timed-out",
      from: "handshake",
      to: "ended",
      on: "timer.handshake",
      timer: "handshake",
      errno: "handshake_timeout",
      emits: ["tx.rst"],
      source: "rabbit_reader.erl:644-649, :368-372",
    },
    { id: "rq.beat-running", from: "running", to: "running", on: "timer.beat", timer: "beat", emits: ["tx.heartbeat"], source: "rabbit_reader.erl:1305-1318" },
    { id: "rq.beat-blocked", from: "blocked", to: "blocked", on: "timer.beat", timer: "beat", emits: ["tx.heartbeat"], source: "rabbit_reader.erl:1305-1318" },
    {
      id: "rq.heartbeat-timeout",
      from: "running",
      to: "ended",
      on: "timer.heartbeat",
      timer: "heartbeat",
      errno: "missed heartbeats from client",
      emits: ["tx.rst"],
      source: "rabbit_reader.erl:650-655, :405-407, :368-372",
    },
    { id: "rq.block", from: "running", to: "blocked", on: "local.alarm", note: "The reader sends connection.blocked when the client can take it", source: "rabbit_reader.erl:1803-1815" },
    { id: "rq.unblock", from: "blocked", to: "running", on: "local.alarm-cleared", source: "rabbit_reader.erl:1817-1825" },
    {
      id: "rq.client-closed",
      from: ["running", "blocked"],
      to: "ended",
      on: "peer.fin",
      errno: "client unexpectedly closed TCP connection",
      emits: ["tx.rst"],
      note: "The end of the reader closes the socket with linger 0: a reset to the client, which closed already",
      source: "rabbit_reader.erl:541-542, :410-446, :368-372",
    },
    { id: "rq.reset", from: ["running", "blocked"], to: "ended", on: ["peer.rst", "socket.error"], errno: "ECONNRESET", source: "rabbit_reader.erl:547-548" },
    {
      id: "rq.send-timed-out",
      from: ["running", "blocked"],
      to: "ended",
      on: "timer.send",
      timer: "send",
      errno: "timeout",
      emits: ["tx.rst"],
      note: "The BEAM closes the socket at the send timeout, with linger 0: a reset, short enough to pass an MTU black hole",
      source: "ranch 2.3.0 src/ranch_tcp.erl:108-109",
    },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { handshake: "ESTABLISHED", running: "ESTABLISHED", blocked: "ESTABLISHED" },
    sets: {},
    ends: "socket.error",
    note: "The socket of the connection on the broker: TCP_NODELAY on, no keepalive, and SO_LINGER on with 0, thus each close of the broker is a reset",
  },
});
