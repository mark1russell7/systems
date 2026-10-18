import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";
import { SV } from "./supavisor-client.ts";

/**
 * This document is Supavisor 2.9.13 in transaction mode, for one server connection of the pool of a
 * tenant. It is one DbHandler, a gen_statem, from its start by the pool to its end.
 *
 * The connect to the server has a timeout of 5 s, and the authentication 15 s. A failed connect ends the
 * DbHandler with FATAL 08006 'Failed to connect to database'. A client that waits for this connection gets
 * that error at once. The pool then starts a new DbHandler, which waits the rest of 2.5 s from the last
 * failure before it connects.
 *
 * The DbHandler reads its socket in each state. Thus a close or a reset of the server ends it at once, idle
 * or with a client. A client that holds the connection then gets the close. The server socket has
 * TCP_NODELAY and no keepalive, and no timer of Supavisor bounds a query.
 */
export const SUPAVISOR_SERVER: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "supavisor-server",
  title: "Supavisor 2.9.13 in transaction mode: one server connection of the pool of a tenant",
  layer: "proxy",
  version: "2.9.13",
  conditions: {
    supavisor: "2.9.13",
    mode: "transaction, the mode of the user of the tenant",
    server: "one PostgreSQL server over TCP, with no TLS, at the address of the tenant",
  },
  sources: [
    { ref: `${SV} lib/supavisor/tenant_supervisor.ex:72-80 the pool of a tenant: poolboy, worker DbHandler, size min_size, max_overflow pool_size, lifo, an overflow worker stops after 5 min idle`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/db_handler.ex:66, :205-224, :1111-1119 a new DbHandler waits the rest of 2.5 s from the last failed connect of its pool (connect_cooldown)`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/db_handler.ex:226-289 the connect: gen_tcp with nodelay and no keepalive, and a timeout of 5_000 ms (1_000 ms in proxy mode). Then the startup message, and a state timeout of 15_000 ms on the authentication`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/db_handler.ex:1072-1085, :292-321 a failed connect: the circuit breaker and the backoff of the pool record it, FATAL 08006 'Failed to connect to database', and the DbHandler goes to terminating_with_error, then stops`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/db_handler.ex:480-516 a checkout in :idle or :busy links the client and gives it the socket. In another state the call waits (postpone), and in terminating_with_error it gets the error`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/db_handler.ex:551-574 a close of the server socket: in the authentication a failed connect, else the DbHandler stops with db_termination`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/db_handler.ex:575-585 the exit of the client that holds the connection: Terminate to the server, close, stop`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/circuit_breaker.ex:28-35 100 failed connects of a tenant in 150 s block its new connections for 30 s`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/db_handler.ex:69-76, :362-372, :297-301 an ErrorResponse at the authentication: 57P03 (the server shuts down) shuts the pool down gracefully, 3D000, 42501 and 22023 shut it down, and 28P01 and 28000 keep it`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/manager.ex:107-118, lib/supavisor/client_handler.ex:545-556 the graceful shutdown of a pool: each client outside a transaction gets FATAL 57P01 'terminating connection due to administrator command' and its close. A client in a transaction gets it after the transaction`, rung: "implemented" },
    {
      ref: `${SV} run 39164922565 of mark1russell7/systems: the server stopped, and the next connect of the pool got 57P03 in 6 of 11 runs. Each idle client then got FATAL 57P01 and its close, 8 to 10 ms after the server closed its connections. In 5 runs the connect came after the server, and the pool stayed`,
      rung: "observed",
    },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "The pool starts a DbHandler" },
    cooldown: { note: "The pool had a failed connect in the last 2.5 s: the DbHandler waits for the rest" },
    connecting: { note: "The TCP connect, with its timeout of 5 s" },
    authentication: { note: "The startup message and the authentication, with a state timeout of 15 s" },
    idle: { note: "In the pool, ready for a client. The DbHandler reads the socket" },
    busy: { note: "Checked out by a client for a transaction: the DbHandler sends each message of the server to the client" },
    ended: { final: true, note: "The DbHandler stopped, and the pool starts a new one" },
  },
  events: {
    "local.start": { kind: "local", note: "The pool starts the DbHandler" },
    "socket.connect": { kind: "local", note: "The TCP connect ends" },
    "rx.ready-for-query": { kind: "rx", note: "ReadyForQuery of the server: the end of the authentication or of a transaction" },
    "local.checkout": { kind: "local", note: "A client checks the connection out of the pool" },
    "client.gone": { kind: "peer", note: "The client that holds the connection ends" },
    "peer.fin": { kind: "peer", note: "The server closes the connection" },
    "peer.rst": { kind: "peer", note: "A reset of the connection of the server" },
    "socket.error": { kind: "local", note: "The socket of the server fails with its own error" },
    "rx.shutting-down": { kind: "rx", note: "An ErrorResponse 57P03 at the authentication: the server shuts down" },
    "timer.cooldown": { kind: "timer", note: "The rest of 2.5 s from the last failed connect of the pool" },
    "timer.connect": { kind: "timer", note: "The timeout of gen_tcp.connect" },
    "timer.auth": { kind: "timer", note: "The state timeout of the authentication" },
    "tx.terminate": { kind: "tx", note: "The Terminate message, then the close of the socket" },
    "tx.error": { kind: "tx", note: "FATAL 08006 'Failed to connect to database' to the client that waits for the connection" },
    "tx.pool-shutdown": { kind: "local", note: "The graceful shutdown of the pool: FATAL 57P01 and the close of each client outside a transaction" },
  },
  knobs: {
    cooldown: { key: "the cooldown of the pool after a failed connect", scope: "process", unit: "ms", default: 2500, note: "lib/supavisor/db_handler.ex:66: a constant of the source" },
    connect: { key: "the timeout of the TCP connect to the server", scope: "process", unit: "ms", default: 5000, note: "lib/supavisor/db_handler.ex:240: a constant of the source, 1_000 ms in proxy mode" },
    auth: { key: "the state timeout of the authentication to the server", scope: "process", unit: "ms", default: 15000, note: "lib/supavisor/db_handler.ex:67: a constant of the source" },
    keepalive_idle: {
      key: "the keepalive idle time of the server socket of Supavisor",
      scope: "proxy",
      unit: "s",
      default: 0,
      off: 0,
      note: "lib/supavisor/db_handler.ex:229-236: Supavisor sets no SO_KEEPALIVE on a server socket, thus no bound",
    },
    slack: {
      key: "the lateness of the scheduler of the BEAM for one timer of a gen_statem",
      scope: "process",
      unit: "ms",
      default: 10,
      note: "An assumption of this document, not a value of Supavisor",
    },
  },
  timers: {
    cooldown: {
      duration: { knob: "cooldown", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:cooldown"],
      fires: "timer.cooldown",
      note: "lib/supavisor/db_handler.ex:205-224, :1111-1119: the rest of 2.5 s from the last failure, thus at most 2.5 s",
    },
    connect_timeout: {
      duration: { knob: "connect", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:connecting"],
      cancels: ["socket.connect", "socket.error", "peer.rst"],
      fires: "timer.connect",
      note: "lib/supavisor/db_handler.ex:240-248: the timeout of gen_tcp.connect. Its end closes the socket in SYN_SENT",
    },
    authentication_timeout: {
      duration: { knob: "auth", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:authentication"],
      cancels: ["rx.ready-for-query", "peer.fin", "peer.rst", "socket.error"],
      fires: "timer.auth",
      note: "lib/supavisor/db_handler.ex:272, :329-331",
    },
  },
  transitions: [
    { id: "ssv.start", from: "[none]", to: "connecting", on: "local.start", guard: "no failed connect of the pool in the last 2.5 s", timer: "connect_timeout", source: "lib/supavisor/db_handler.ex:205-228" },
    { id: "ssv.start-late", from: "[none]", to: "cooldown", on: "local.start", guard: "a failed connect of the pool in the last 2.5 s", timer: "cooldown", source: "lib/supavisor/db_handler.ex:205-211" },
    { id: "ssv.cooldown-over", from: "cooldown", to: "connecting", on: "timer.cooldown", timer: "connect_timeout", source: "lib/supavisor/db_handler.ex:222-224" },
    { id: "ssv.connected", from: "connecting", to: "authentication", on: "socket.connect", timer: "authentication_timeout", source: "lib/supavisor/db_handler.ex:248-273" },
    {
      id: "ssv.connect-failed",
      from: ["connecting", "authentication"],
      to: "ended",
      on: ["timer.connect", "socket.error", "peer.rst", "peer.fin", "timer.auth"],
      errno: "08006",
      emits: ["tx.error"],
      note: "FATAL 'Failed to connect to database: <reason>' to a client that waits for the connection, then the DbHandler stops",
      source: "lib/supavisor/db_handler.ex:282-289, :329-331, :551-555, :1072-1085, :292-321",
    },
    { id: "ssv.authenticated", from: "authentication", to: "idle", on: "rx.ready-for-query", source: "lib/supavisor/db_handler.ex:380-390" },
    {
      id: "ssv.server-shutting-down",
      from: "authentication",
      to: "ended",
      on: "rx.shutting-down",
      emits: ["tx.pool-shutdown"],
      note: "57P03 at the login: Supavisor shuts the whole pool down gracefully, thus a server that shuts down can end each idle client of the tenant",
      source: "lib/supavisor/db_handler.ex:69-76, :362-372, :297-301",
    },
    { id: "ssv.checkout", from: "idle", to: "busy", on: "local.checkout", source: "lib/supavisor/db_handler.ex:500-512" },
    { id: "ssv.release", from: "busy", to: "idle", on: "rx.ready-for-query", source: "lib/supavisor/db_handler.ex:415-425" },
    {
      id: "ssv.closed",
      from: ["idle", "busy"],
      to: "ended",
      on: ["peer.fin", "peer.rst", "socket.error"],
      note: "db_termination: a client that holds the connection gets the close, with no ErrorResponse",
      source: "lib/supavisor/db_handler.ex:557-574",
    },
    { id: "ssv.client-gone", from: "busy", to: "ended", on: "client.gone", emits: ["tx.terminate"], source: "lib/supavisor/db_handler.ex:575-585" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { connecting: "SYN_SENT", authentication: "ESTABLISHED", idle: "ESTABLISHED", busy: "ESTABLISHED" },
    sets: { keepidle: { knob: "keepalive_idle", unit: "s" } },
    ends: "socket.error",
    note: "The server socket, with TCP_NODELAY and no SO_KEEPALIVE. The DbHandler reads it in each state, thus the end of the socket reaches it at once",
  },
});
