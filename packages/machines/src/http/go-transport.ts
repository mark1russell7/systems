import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { goTimerLateness } from "./timers.ts";

/**
 * This document is one connection of the `http.Transport` of Go 1.27.2 at its defaults, over its
 * Linux TCP socket. Each fact comes from the source at the tag `go1.27.2`. The comments give the
 * file and the line.
 *
 * The idle timeout is the C of the keep-alive race. The transport ignores the `Keep-Alive` hint of
 * the server. It finds a connection that the server closed when its read loop reads the end of
 * file. A reused connection can fail before any byte of the reply. Then the transport sends a
 * request that it can replay again, on a new connection, by itself.
 */
export const GO_TRANSPORT: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "go-nethttp-transport",
  title: "One connection of the http.Transport of Go 1.27.2",
  layer: "driver",
  version: "go1.27.2",
  conditions: { go: "1.27.2", os: "linux", protocol: "HTTP/1.1 without TLS" },
  sources: [
    {
      ref: "go1.27.2 src/net/http/transport.go:47-62 DefaultTransport: Dialer Timeout 30 s and KeepAlive 30 s, MaxIdleConns 100, IdleConnTimeout 90 s, DefaultMaxIdleConnsPerHost 2",
      rung: "implemented",
    },
    {
      ref: "go1.27.2 src/net/http/transport.go:1129-1236 tryPutIdleConn: the connection goes back to the pool after its reply, with an idle timer of IdleConnTimeout and idleAt = now",
      rung: "implemented",
    },
    {
      ref: "go1.27.2 src/net/http/transport.go:1241-1303 queueForIdleConn: the most recent idle connection, unless it is broken or idle for IdleConnTimeout or more by the wall clock",
      rung: "implemented",
    },
    {
      ref: "go1.27.2 src/net/http/transport.go:2454-2512 readLoop and :2653-2672 readLoopPeekFailLocked: an end of file on an idle connection closes it (errServerClosedIdle); a read error while a reply is due is transportReadFromServerError",
      rung: "implemented",
    },
    {
      ref: "go1.27.2 src/net/http/transport.go:694-769 roundTrip and :844-889 shouldRetryRequest: a new connection for a reused connection that failed before the reply, when the request can be replayed",
      rung: "implemented",
    },
    {
      ref: "go1.27.2 src/net/http/request.go:1561-1573 isReplayable: GET, HEAD, OPTIONS, TRACE without a body, or a request with an Idempotency-Key",
      rung: "implemented",
    },
    {
      ref: "go1.27.2 src/net/tcpsock.go:289-307 newTCPConn: TCP_NODELAY on, and keepalive from Dialer.KeepAlive; src/net/tcpsock_unix.go:12-27; src/net/tcpsockopt_unix.go:15-53 (idle and interval 15 s and count 9 when 0, rounded up to whole seconds); src/net/dial.go:18-27",
      rung: "implemented",
    },
  ],
  states: {
    ABSENT: { initial: true, pseudo: true },
    DIALING: {},
    ACTIVE: { note: "a request owns the connection" },
    IDLE: { note: "in the pool of idle connections" },
    CLOSED: { final: true },
  },
  events: {
    "req.dispatch": { kind: "app", note: "a request asks the transport for a connection (getConn)" },
    "conn.established": { kind: "local" },
    "resp.done": { kind: "local", note: "the reply was read to its end: the read loop puts the connection back" },
    "rx.fin": { kind: "peer", note: "the read loop reads io.EOF" },
    "read.error": { kind: "local", note: "a read fails: ECONNRESET, ETIMEDOUT, EHOSTUNREACH" },
    "rx.rst": { kind: "peer" },
    "rx.icmp-hard": { kind: "rx", note: "an ICMP error while the dial waits" },
    "timer.idle-conn": { kind: "timer" },
    "timer.dial": { kind: "timer" },
    "timer.client": { kind: "timer" },
    "timer.response-header": { kind: "timer" },
    "tx.request": { kind: "tx", note: "the write loop wrote the request" },
    "rx.headers": { kind: "rx" },
  },
  knobs: {
    IdleConnTimeout: { key: "go http.Transport IdleConnTimeout", scope: "client", unit: "s", default: 90 },
    MaxIdleConnsPerHost: {
      key: "go http.Transport MaxIdleConnsPerHost",
      scope: "client",
      unit: "count",
      default: 2,
      note: "0 gives DefaultMaxIdleConnsPerHost, 2 (transport.go:1121)",
    },
    MaxIdleConns: { key: "go http.Transport MaxIdleConns", scope: "client", unit: "count", default: 100 },
    DialTimeout: { key: "go net.Dialer Timeout", scope: "client", unit: "s", default: 30 },
    KeepAlive: {
      key: "go net.Dialer KeepAlive",
      scope: "client",
      unit: "s",
      default: 30,
      note: "the TCP_KEEPIDLE of the socket; 0 gives 15 s, and a negative value turns keepalive off",
    },
    KeepAliveInterval: {
      key: "go net.KeepAliveConfig Interval",
      scope: "client",
      unit: "s",
      default: 15,
      note: "0 gives 15 s (dial.go:24)",
    },
    KeepAliveCount: {
      key: "go net.KeepAliveConfig Count",
      scope: "client",
      unit: "count",
      default: 9,
      note: "0 gives 9 (dial.go:27)",
    },
    Timeout: {
      key: "go http.Client Timeout",
      scope: "client",
      unit: "s",
      default: 0,
      note: "0 is no deadline: a reader gives it no bound",
    },
    ResponseHeaderTimeout: {
      key: "go http.Transport ResponseHeaderTimeout",
      scope: "client",
      unit: "s",
      default: 0,
      note: "0 is no deadline",
    },
  },
  timers: {
    idle_conn: {
      duration: { knob: "IdleConnTimeout", unit: "s" },
      lateness: goTimerLateness("IdleConnTimeout"),
      arms: ["resp.done", "enter:IDLE"],
      cancels: ["req.dispatch"],
      fires: "timer.idle-conn",
      note: "time.AfterFunc(IdleConnTimeout, closeConnIfStillIdle) closes the connection late by a Go timer. The reuse is exact: queueForIdleConn compares idleAt with the wall clock",
    },
    dial: {
      duration: { knob: "DialTimeout", unit: "s" },
      lateness: goTimerLateness("DialTimeout"),
      arms: ["enter:DIALING"],
      cancels: ["conn.established"],
      fires: "timer.dial",
    },
    client: {
      duration: { knob: "Timeout", unit: "s" },
      lateness: goTimerLateness("Timeout"),
      arms: ["req.dispatch", "enter:ACTIVE"],
      cancels: ["resp.done"],
      fires: "timer.client",
    },
    response_header: {
      duration: { knob: "ResponseHeaderTimeout", unit: "s" },
      lateness: goTimerLateness("ResponseHeaderTimeout"),
      arms: ["tx.request", "enter:ACTIVE"],
      cancels: ["rx.headers"],
      fires: "timer.response-header",
    },
  },
  realizes: {
    "systems.mechanism.pool-idle-expiry": { timer: "idle_conn" },
    "systems.mechanism.connect-bound": { timer: "dial" },
    "systems.mechanism.request-timeout": { timer: "client" },
  },
  transitions: [
    {
      id: "gt.dial",
      from: "ABSENT",
      to: "DIALING",
      on: "req.dispatch",
      guard: "no idle connection that is younger than IdleConnTimeout and not broken",
      source: "transport.go:1613-1616",
    },
    { id: "gt.connected", from: "DIALING", to: "ACTIVE", on: "conn.established" },
    { id: "gt.dial-timeout", from: "DIALING", to: "CLOSED", on: "timer.dial", timer: "dial", errno: "TIMEOUT" },
    { id: "gt.dial-refused", from: "DIALING", to: "CLOSED", on: "rx.rst", errno: "ECONNREFUSED" },
    { id: "gt.dial-unreachable", from: "DIALING", to: "CLOSED", on: "rx.icmp-hard", errno: "EHOSTUNREACH" },
    {
      id: "gt.idle",
      from: "ACTIVE",
      to: "IDLE",
      on: "resp.done",
      guard: "neither side asked for a close, and fewer than MaxIdleConnsPerHost connections are idle",
      timer: "idle_conn",
      source: "transport.go:1129-1236, :2547-2556, :2616-2627",
    },
    {
      id: "gt.reuse",
      from: "IDLE",
      to: "ACTIVE",
      on: "req.dispatch",
      guard: "idle for less than IdleConnTimeout by the wall clock, and not broken",
      source: "transport.go:1258-1303",
    },
    {
      id: "gt.expire",
      from: "IDLE",
      to: "CLOSED",
      on: "timer.idle-conn",
      timer: "idle_conn",
      emits: ["tx.fin"],
      source: "transport.go:2342-2352",
    },
    {
      id: "gt.server-closed-idle",
      from: "IDLE",
      to: "CLOSED",
      on: ["rx.fin", "read.error"],
      emits: ["tx.fin"],
      source: "transport.go:2493-2500, :2653-2672",
    },
    {
      id: "gt.retry",
      from: "ACTIVE",
      to: "CLOSED",
      on: ["rx.fin", "read.error"],
      guard: "the connection was reused, no byte of the reply came, and the request can be replayed",
      emits: ["req.retry"],
      note: "the request goes again on a new connection, and the caller sees only the second outcome",
      source: "transport.go:740-768, :844-889",
    },
    {
      id: "gt.fail",
      from: "ACTIVE",
      to: "CLOSED",
      on: ["rx.fin", "read.error"],
      guard: "otherwise: a new connection, or a request that it cannot replay",
      errno: "EOF",
      note: "the caller gets the read error: io.EOF, or the errno of the socket",
      source: "transport.go:745-760",
    },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { DIALING: "SYN_SENT", ACTIVE: "ESTABLISHED", IDLE: "ESTABLISHED" },
    sets: {
      keepidle: { expr: "ceil(KeepAlive)", unit: "s" },
      keepintvl: { expr: "ceil(KeepAliveInterval)", unit: "s" },
      keepcnt: { knob: "KeepAliveCount", unit: "count" },
    },
    ends: "read.error",
    note: "Go sets SO_KEEPALIVE with its own idle, interval and count on each dialed socket, rounded up to whole seconds. Thus the keepalive sysctls of the namespace do not reach it. A negative KeepAlive turns it off: a reader gives keepidle no bound.",
  },
} satisfies Machine);
