import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact of the transport is the Go source of google.golang.org/grpc at the tag v1.84.0
// (github.com/grpc/grpc-go). Each line number is a line of that file at the tag. The facts of Go are from
// the source of Go at go1.27.2, the builder of the server of the harness. etcd v3.6.15 locks grpc-go
// v1.83.2 and builds with go1.26.8: in the files below, v1.83.2 differs from v1.84.0 by one line of a
// stream (http2_server.go:534 of v1.84.0), and go1.26.8 is the same as go1.27.2.
const AT = "grpc-go v1.84.0";
const GO = "go1.27.2 src/net";
const ETCD = "etcd v3.6.15";

/** These are the knob values of a server of grpc-go that differ between the server of the harness and etcd. */
interface Variant {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly conditions: Readonly<Record<string, string>>;
  readonly sources: ReadonlyArray<{ readonly ref: string; readonly rung: "implemented" | "documented" | "observed" }>;
  readonly minTime: number;
  readonly listenerIdle: number;
  readonly setsUserTimeout: 0 | 1;
  readonly note: string;
}

/** These are the facts of the transport of grpc-go, for each server on it. */
const TRANSPORT = [
  { ref: `${AT} internal/transport/defaults.go:31-40 the server keepalive: Time 2 h, Timeout 20 s. MinTime of the policy 5 min. MaxConnectionIdle, Age and AgeGrace infinite`, rung: "implemented" },
  { ref: `${AT} internal/transport/http2_server.go:226-253 the defaults of the parameters, a jitter of 10 % on MaxConnectionAge, and TCP_USER_TIMEOUT = Timeout when Time is not infinite`, rung: "implemented" },
  { ref: `${AT} internal/syscall/syscall_linux.go:71-90 SetTCPUserTimeout acts only on a *net.TCPConn. On any other net.Conn it does nothing`, rung: "implemented" },
  {
    ref: `${AT} internal/transport/http2_server.go:1197-1286 keepalive(): a PING after Time with no read, and Close when no read comes for Timeout after it. MaxConnectionIdle and MaxConnectionAge drain with GOAWAY, and AgeGrace closes`,
    rung: "implemented",
  },
  {
    ref: `${AT} internal/transport/http2_server.go:881-933 handlePing: a PING less than MinTime after the last one is a strike, and with no stream open and PermitWithoutStream false, less than 2 h. The third strike sends GOAWAY ENHANCE_YOUR_CALM too_many_pings and closes the connection`,
    rung: "implemented",
  },
  { ref: `${AT} internal/transport/http2_server.go:279-281, :1064, :1132, :1176 each write of headers, a status or data by the server clears the strikes`, rung: "implemented" },
  { ref: `${AT} internal/transport/http2_server.go:1291-1310 Close closes the net.Conn: a FIN, or a reset when bytes are unread`, rung: "implemented" },
  { ref: `${AT} server.go:192, :1000-1009 a deadline of 120 s for the handshake of each new connection (ConnectionTimeout)`, rung: "implemented" },
  { ref: `${AT} server.go:894-905 the comment of grpc-go: Go sets a TCP keepalive of 15 s on each accepted connection`, rung: "documented" },
  { ref: `${GO}/dial.go:20-27 the defaults of the TCP keepalive of Go: 15 s idle, 15 s between probes, 9 probes`, rung: "implemented" },
  { ref: `${GO}/tcpsock_posix.go:158-164 and tcpsock.go:289-305 each accepted connection gets the KeepAlive of its ListenConfig: on, with the defaults of Go, when the caller gives none`, rung: "implemented" },
  { ref: `${GO}/tcpsock_unix.go:12-31 and tcpsockopt_unix.go:15-53 SetKeepAliveConfig sets SO_KEEPALIVE, TCP_KEEPIDLE, TCP_KEEPINTVL and TCP_KEEPCNT`, rung: "implemented" },
  {
    ref: "linux v6.6 net/ipv4/tcp_timer.c tcp_keepalive_timer: with TCP_USER_TIMEOUT set, the keepalive aborts at its first firing that is U after the last received segment, with a probe out. Thus at K + k·I, k = max(1, ceil((U − K) / I)), and TCP_KEEPCNT is not read",
    rung: "implemented",
  },
] as const;

/** This function gives the document of a server of grpc-go for one variant. */
const serverOf = (variant: Variant): Machine =>
  machineSchema.parse({
    format: "mark1russell7.machine/1",
    id: variant.id,
    title: variant.title,
    layer: "server",
    version: variant.version,
    conditions: variant.conditions,
    sources: [...TRANSPORT, ...variant.sources],
    states: {
      "[none]": { initial: true, pseudo: true, note: "Before the accept of the connection" },
      handshake: { note: "The accepted connection, until the preface and the SETTINGS of the client, with the deadline of ConnectionTimeout" },
      idle: { note: "A ready transport with no stream open. The keepalive of the server runs" },
      active: { note: "One or more streams open, for example a call that the handler holds" },
      draining: { note: "After a GOAWAY of the server: no new stream, and the open streams end" },
      ended: { final: true, note: "The connection closed" },
    },
    events: {
      "local.accept": { kind: "local", note: "The listener accepts the connection, with the TCP keepalive of Go, and TCP_USER_TIMEOUT where it applies" },
      "rx.settings": { kind: "rx", note: "The preface and the first SETTINGS of the client" },
      "rx.frame": { kind: "rx", note: "Any frame of the client. The server keeps the time of its last read" },
      "rx.headers": { kind: "rx", note: "The headers of a new stream: a call" },
      "rx.ping": { kind: "rx", note: "A PING of the client. The server answers it, and checks it against its policy" },
      "rx.ping-strike-3": { kind: "rx", note: "The third PING that breaks the policy, with no write of the server since the first one" },
      "rx.ping-ack": { kind: "rx", note: "The ACK of a PING of the server" },
      "local.stream-end": { kind: "local", note: "The last open stream ends: its status goes out" },
      "app.stop": { kind: "app", note: "GracefulStop: a GOAWAY on each connection" },
      "peer.fin": { kind: "peer", note: "The client ends the connection: an end of file for the reader of the server" },
      "peer.rst": { kind: "peer", note: "A reset of the connection" },
      "socket.error": { kind: "local", note: "The socket fails with its own error: a reset, or a give-up of the kernel (ETIMEDOUT)" },
      "timer.connection-timeout": { kind: "timer", note: "No preface came before the deadline of the handshake" },
      "timer.keepalive": { kind: "timer", note: "No read for Time: the server sends a PING" },
      "timer.ping-timeout": { kind: "timer", note: "No read for Timeout after the PING" },
      "timer.max-idle": { kind: "timer", note: "No stream open for MaxConnectionIdle" },
      "timer.max-age": { kind: "timer", note: "The connection is MaxConnectionAge old" },
      "timer.grace": { kind: "timer", note: "AgeGrace after the GOAWAY of the age" },
      "tx.ping": { kind: "tx", note: "A PING of the keepalive of the server" },
      "tx.goaway": { kind: "tx", note: "A GOAWAY of the server" },
      "tx.fin": { kind: "tx", note: "The close of the net.Conn: a FIN" },
    },
    knobs: {
      keepalive_time: { key: "keepalive.ServerParameters.Time", scope: "server", unit: "s", default: 7200, note: "defaults.go:38: 2 h. 0 is the default" },
      keepalive_timeout: { key: "keepalive.ServerParameters.Timeout", scope: "server", unit: "s", default: 20, note: "defaults.go:39: the wait after the PING, and TCP_USER_TIMEOUT where it applies" },
      min_time: { key: "keepalive.EnforcementPolicy.MinTime", scope: "server", unit: "s", default: variant.minTime, note: "the shortest interval between two PINGs of a client with a stream open" },
      permit_without_stream: { key: "keepalive.EnforcementPolicy.PermitWithoutStream", scope: "server", unit: null, default: 0, note: "false: with no stream open, the shortest interval is 2 h" },
      no_stream_ping_interval: { key: "defaultPingTimeout", scope: "server", unit: "s", default: 7200, note: "http2_server.go:883: a constant of grpc-go" },
      max_ping_strikes: { key: "maxPingStrikes", scope: "server", unit: "count", default: 2, note: "http2_server.go:882: the GOAWAY comes at the strike after it" },
      max_connection_idle: { key: "keepalive.ServerParameters.MaxConnectionIdle", scope: "server", unit: "s", default: 0, off: 0, note: "defaults.go:35: infinite, and 0 is the default" },
      max_connection_age: { key: "keepalive.ServerParameters.MaxConnectionAge", scope: "server", unit: "s", default: 0, off: 0, note: "defaults.go:36: infinite. When set, a jitter of ±10 %" },
      max_connection_age_grace: { key: "keepalive.ServerParameters.MaxConnectionAgeGrace", scope: "server", unit: "s", default: 0, off: 0, note: "defaults.go:37: infinite" },
      connection_timeout: { key: "grpc.ConnectionTimeout", scope: "server", unit: "s", default: 120, note: "server.go:192" },
      listener_keepidle: { key: "the TCP keepalive idle of an accepted connection", scope: "server", unit: "s", default: variant.listenerIdle, note: variant.note },
      listener_keepintvl: { key: "the TCP keepalive interval of an accepted connection", scope: "server", unit: "s", default: 15, note: "dial.go:24: the default of Go" },
      listener_keepcnt: { key: "the TCP keepalive count of an accepted connection", scope: "server", unit: "count", default: 9, note: "dial.go:27: the default of Go" },
      sets_user_timeout: {
        key: "TCP_USER_TIMEOUT reaches the socket",
        scope: "server",
        unit: "count",
        default: variant.setsUserTimeout,
        note: "1 when grpc-go gets the *net.TCPConn of the listener, else 0. A wrapper of the conn, as cmux, makes it 0 (syscall_linux.go:71-77). A count, thus the sets of the socket can read it",
      },
      slack: { key: "the lateness of the scheduler of Go for one step", scope: "process", unit: "s", default: 0.01, note: "An assumption of this document, not a value of grpc-go" },
      hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null, note: "The build option of the kernel" },
    },
    timers: {
      connection_timeout: {
        duration: { knob: "connection_timeout", unit: "s" },
        lateness: { knob: "slack", unit: "s" },
        arms: ["local.accept"],
        cancels: ["rx.settings"],
        fires: "timer.connection-timeout",
        note: "server.go:1005-1009: a deadline of the conn for the handshake",
      },
      keepalive: {
        duration: { knob: "keepalive_time", unit: "s" },
        lateness: { knob: "slack", unit: "s" },
        arms: ["rx.settings", "rx.frame", "rx.ping-ack"],
        fires: "timer.keepalive",
        note: "http2_server.go:1252-1262: from the last read. The timer fires at Time and finds the last read, thus it sets itself again to Time after that read",
      },
      ping_timeout: {
        duration: { knob: "keepalive_timeout", unit: "s" },
        lateness: { knob: "slack", unit: "s" },
        arms: ["tx.ping"],
        cancels: ["rx.frame", "rx.ping-ack"],
        fires: "timer.ping-timeout",
        note: "http2_server.go:1263-1281: any read since the PING cancels the close",
      },
      max_idle: {
        duration: { knob: "max_connection_idle", unit: "s" },
        lateness: { knob: "slack", unit: "s" },
        arms: ["enter:idle"],
        cancels: ["rx.headers"],
        fires: "timer.max-idle",
        note: "http2_server.go:1222-1238: off at the defaults",
      },
      max_age: {
        duration: { knob: "max_connection_age", unit: "s" },
        early: { expr: "0.1 * max_connection_age", unit: "s" },
        lateness: { expr: "0.1 * max_connection_age + slack", unit: "s" },
        arms: ["local.accept"],
        fires: "timer.max-age",
        note: "http2_server.go:231-232, :1239-1241: with a jitter of ±10 %. Off at the defaults",
      },
      grace: {
        duration: { knob: "max_connection_age_grace", unit: "s" },
        lateness: { knob: "slack", unit: "s" },
        arms: ["timer.max-age"],
        fires: "timer.grace",
        note: "http2_server.go:1240-1251: the close after the GOAWAY of the age",
      },
    },
    realizes: {
      "systems.mechanism.heartbeat-interval": { timer: "keepalive" },
      "systems.mechanism.heartbeat-detection-time": {
        duration: { expr: "keepalive_time + keepalive_timeout", unit: "s" },
        lateness: { expr: "2 * slack", unit: "s" },
        note: "The PING after Time with no read, and the close Timeout after it",
      },
      "systems.mechanism.idle-refresh-interval": {
        duration: { knob: "listener_keepidle", unit: "s" },
        note: "The first probe of the TCP keepalive of the accepted connection: no other segment goes out on an idle connection for 2 h",
      },
    },
    transitions: [
      { id: "gs.accept", from: "[none]", to: "handshake", on: "local.accept", timer: "connection_timeout", source: "server.go:1000-1009" },
      { id: "gs.ready", from: "handshake", to: "idle", on: "rx.settings", source: "http2_server.go:205-300" },
      { id: "gs.handshake-timeout", from: "handshake", to: "ended", on: "timer.connection-timeout", timer: "connection_timeout", emits: ["tx.fin"], source: "server.go:1005-1013" },
      { id: "gs.stream", from: "idle", to: "active", on: "rx.headers", source: "http2_server.go" },
      { id: "gs.stream-end", from: "active", to: "idle", on: "local.stream-end", source: "http2_server.go" },
      { id: "gs.ping-idle", from: "idle", to: "idle", on: "timer.keepalive", timer: "keepalive", emits: ["tx.ping"], source: "http2_server.go:1267-1274" },
      { id: "gs.ping-active", from: "active", to: "active", on: "timer.keepalive", timer: "keepalive", emits: ["tx.ping"], source: "http2_server.go:1267-1274" },
      {
        id: "gs.ping-timeout",
        from: ["idle", "active"],
        to: "ended",
        on: "timer.ping-timeout",
        timer: "ping_timeout",
        errno: "keepalive ping not acked within timeout",
        emits: ["tx.fin"],
        source: "http2_server.go:1263-1266, :1291-1310",
      },
      {
        id: "gs.too-many-pings",
        from: ["idle", "active"],
        to: "ended",
        on: "rx.ping-strike-3",
        errno: "too_many_pings",
        emits: ["tx.goaway", "tx.fin"],
        note: "GOAWAY ENHANCE_YOUR_CALM with the data too_many_pings, then the close of the connection",
        source: "http2_server.go:929-932",
      },
      { id: "gs.max-idle", from: "idle", to: "draining", on: "timer.max-idle", timer: "max_idle", emits: ["tx.goaway"], source: "http2_server.go:1232-1236" },
      { id: "gs.max-age", from: ["idle", "active"], to: "draining", on: "timer.max-age", timer: "max_age", emits: ["tx.goaway"], source: "http2_server.go:1239-1241" },
      { id: "gs.stop", from: ["idle", "active"], to: "draining", on: "app.stop", emits: ["tx.goaway"], source: "server.go:1683" },
      { id: "gs.drained", from: "draining", to: "ended", on: ["timer.grace", "local.stream-end"], emits: ["tx.fin"], source: "http2_server.go:1242-1251" },
      {
        id: "gs.reset",
        from: ["handshake", "idle", "active", "draining"],
        to: "ended",
        on: ["socket.error", "peer.rst"],
        errno: "ECONNRESET",
        note: "The error of the socket, with its own code: ETIMEDOUT for an abort of the keepalive or a give-up of the kernel",
        source: "http2_server.go",
      },
      { id: "gs.closed", from: ["handshake", "idle", "active", "draining"], to: "ended", on: "peer.fin", errno: "EOF", emits: ["tx.fin"], source: "http2_server.go" },
    ],
    over: {
      machine: "systems.machine.linux-tcp",
      states: { handshake: "ESTABLISHED", idle: "ESTABLISHED", active: "ESTABLISHED", draining: "ESTABLISHED" },
      sets: {
        keepidle: { expr: "ceil(listener_keepidle)", unit: "s" },
        keepintvl: { expr: "ceil(listener_keepintvl)", unit: "s" },
        // with TCP_USER_TIMEOUT, the keepalive aborts at K + k·I: a keepalive of count k (tcp_timer.c)
        keepcnt: {
          expr: "sets_user_timeout * max(1, ceil((keepalive_timeout - ceil(listener_keepidle)) / ceil(listener_keepintvl))) + (1 - sets_user_timeout) * listener_keepcnt",
          unit: "count",
        },
        tcp_user_timeout: { expr: "1000 * sets_user_timeout * keepalive_timeout", unit: "ms" },
      },
      ends: "socket.error",
      note: "The accepted socket: a Linux TCP socket with the keepalive of Go. Where TCP_USER_TIMEOUT reaches it, the keepalive aborts at its first firing that is U after the last received segment, with a probe out: a keepalive of count k, k = max(1, ceil((U − K) / I)). U also ends a send with no ACK, U after its first retransmission",
    },
  });

/**
 * This document is a server of grpc-go v1.84.0 on its own listener: grpc.NewServer on net.Listen, at the
 * defaults, as in the server of the harness. Its keepalive is on (a PING after 2 h with no read). Thus the
 * transport gives each accepted connection a TCP_USER_TIMEOUT of 20 s. With the TCP keepalive of Go
 * (15 s, 15 s, 9), an idle connection to a client that is gone ends 30 s after the last data. A client
 * that pings more often than 5 min with a stream open, or than 2 h with none, gets GOAWAY
 * too_many_pings at its third strike.
 */
export const GRPC_GO_SERVER: Machine = serverOf({
  id: "grpc-go-server",
  title: "A server of grpc-go v1.84.0: one HTTP/2 connection, its keepalive, its policy for the PINGs of a client and its TCP socket",
  version: "1.84.0",
  conditions: {
    "grpc-go": "v1.84.0",
    go: "1.27.2",
    server: "grpc.NewServer with the server options of the caller, on net.Listen",
    transport: "HTTP/2 over TCP, with no TLS",
  },
  sources: [],
  minTime: 300,
  listenerIdle: 15,
  setsUserTimeout: 1,
  note: "dial.go:20: the default of Go, on net.Listen. A ListenConfig with its own KeepAlive changes it",
});

/**
 * This document is the server of etcd v3.6.15, on grpc-go v1.83.2, at the defaults: one client URL with no
 * TLS. The keepalive of the server is 2 h and 20 s, and a client can ping each 5 s with a stream open.
 * The server serves gRPC and HTTP on one port through cmux. Thus the transport gets a wrapper of the conn,
 * and it sets no TCP_USER_TIMEOUT. The listener sets the keepalive idle to 30 s. The interval and the
 * count of Go stay. Thus an idle connection to a gone client ends 165 s after the last data: 30 + 9 × 15.
 */
export const ETCD_SERVER: Machine = serverOf({
  id: "etcd-server",
  title: "The server of etcd v3.6.15 on grpc-go v1.83.2: one gRPC connection of a client, its keepalive, its policy for PINGs and its TCP socket",
  version: "3.6.15",
  conditions: {
    etcd: "v3.6.15",
    "grpc-go": "v1.83.2",
    go: "1.26.8",
    server: "etcd with one member at its defaults, one client URL of http: and no TLS",
    transport: "HTTP/2 over TCP through cmux, with no TLS",
  },
  sources: [
    { ref: `${ETCD} server/embed/config.go:69-71 --grpc-keepalive-min-time 5 s, --grpc-keepalive-interval 2 h, --grpc-keepalive-timeout 20 s`, rung: "implemented" },
    { ref: `${ETCD} server/embed/etcd.go:780-793 the policy (MinTime, PermitWithoutStream false) and the parameters (Time, Timeout) of the gRPC server`, rung: "implemented" },
    { ref: `${ETCD} server/embed/etcd.go:707-712 and client/pkg/transport/listener.go:48-116 a client URL with no socket options gets net.Listen in a keepalive listener`, rung: "implemented" },
    { ref: `${ETCD} client/pkg/transport/keepalive_listener.go:52-71 each accepted connection: SetKeepAlive(true) and SetKeepAlivePeriod(30 s), which sets the idle only (${GO}/tcpsock.go:249-257)`, rung: "implemented" },
    { ref: `${ETCD} server/embed/serve.go:141, :214-216 the gRPC server serves the HTTP/2 connections of cmux, a MuxConn (github.com/soheilhy/cmux v0.1.5 cmux.go:274-277), not a *net.TCPConn`, rung: "implemented" },
    { ref: `${ETCD} server/etcdserver/api/v3rpc/grpc.go:86-88 the server registers the health service of gRPC`, rung: "implemented" },
  ],
  minTime: 5,
  listenerIdle: 30,
  setsUserTimeout: 0,
  note: "keepalive_listener.go:68: SetKeepAlivePeriod(30 s) on each accepted connection",
});
