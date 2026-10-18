import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact below is the Elixir source of Supavisor at the tag v2.9.13 of
// github.com/supabase/supavisor. Each line number is a line of that file at the tag. A fact of the
// kernel or of the BEAM is an assumption of this document, and its note says so.
export const SV = "v2.9.13";

/**
 * This document is Supavisor 2.9.13 in transaction mode, for one client connection. It gives the
 * states of the client handler (a gen_statem) from the accept to the close, and the timers that act
 * on it.
 *
 * Between two transactions the client holds no server connection. A message of the client checks one
 * out of the pool of the tenant, and ReadyForQuery of the server checks it in. Thus a fault of the
 * server reaches an idle client only through the pool. Its next query meets the pool, or the pool
 * shuts down and closes it, as after 57P03 at a login of the pool.
 *
 * At the defaults the handler writes a heartbeat to an idle client each 60 s: a ParameterStatus of
 * application_name. A failed write ends the client. client_idle_timeout does not end a session in
 * 2.9.13: its timer fires an event that no clause handles. Each client socket has SO_KEEPALIVE.
 *
 * Each client socket also has the send timeout of ranch: a write to the client that waits 30 s fails,
 * and the BEAM closes the socket. This document gives it no timer. A write waits when the client takes no
 * data: a broken path, or a client that reads nothing. On a broken path, the FIN of the close waits
 * behind the data that the kernel did not send.
 */
export const SUPAVISOR_CLIENT: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "supavisor-client",
  title: "Supavisor 2.9.13 in transaction mode: one client connection, its checkout of a server and its heartbeat",
  layer: "proxy",
  version: "2.9.13",
  conditions: {
    supavisor: "2.9.13",
    mode: "transaction, the mode of the user of the tenant",
    client: "a PostgreSQL client over TCP, with no TLS, as the user <db_user>.<tenant>",
    tenant: "one tenant with one user and one server, client_heartbeat_interval 60 s and client_idle_timeout 0 at the defaults",
  },
  sources: [
    { ref: `${SV} lib/supavisor/tenants/tenant.ex:28-32 the defaults of a tenant: default_pool_size 15, default_max_clients 1000, client_idle_timeout 0, client_heartbeat_interval 60 s`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/tenants/user.ex:16-19 a user: mode_type transaction or session, pool_size, pool_checkout_timeout 60_000 ms, max_clients`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/application.ex:71-83 each listener is ranch_tcp with keepalive true: each client socket has SO_KEEPALIVE`, rung: "implemented" },
    {
      ref: `ranch 2.2.0, the version of mix.lock at ${SV}: src/ranch_tcp.erl:108-109 a listener sets send_timeout 30000 and send_timeout_close true, and each accepted socket has the options of its listener. Thus a write to the client that waits 30 s fails, and the BEAM closes the socket. The server connection ignores the result of each write of a reply to the client (lib/supavisor/db_handler.ex:890-905)`,
      rung: "implemented",
    },
    { ref: `${SV} lib/supavisor/client_handler.ex:21-23, :123, :198 a state_timeout of 5_000 ms in :handshake, and 2_500 ms for a TLS handshake`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:315, :600, :627 an event timeout of 15_000 ms on each wait of the authentication`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:901-911 handle_actions arms the event timeout of client_idle_timeout, then the event timeout of the heartbeat. A gen_statem has one event timeout: the second action replaces the first`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:430-433, :734-744 the timer of client_idle_timeout fires :idle_timeout, but the clause matches :idle_terminate. The catch-all clause logs 'Undefined msg' and keeps the state`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:435-445, :1006 the heartbeat writes the ParameterStatus application_name each client_heartbeat_interval, and a failed write ends the client`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:705-716, :836-870, :966-971 a message in :idle checks out a server: poolboy with pool_checkout_timeout, then DbHandler.checkout with its call timeout of 15 s (lib/supavisor/db_handler.ex:101-110). A server connection that connects postpones the call (db_handler.ex:500-516)`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/errors/checkout_timeout_error.ex and lib/supavisor/error.ex:83-84 a checkout timeout reaches the client as FATAL XX000 'unable to check out connection from the pool after <ms>ms in Transaction mode'`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:523-537, :872-876 ReadyForQuery of the server: the client checks the server in and goes to :idle, and handle_actions arms the heartbeat`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:697-703 a Sync of the client in :busy goes to the server, and handle_actions arms the heartbeat in :busy too`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:90, :485-497 and lib/supavisor/errors/db_handler_exited_error.ex:15-25 the handler traps exits. The exit of its server connection ends the client: after a fatal error of the server that the client got, or with no ErrorResponse for the close of the server (db_termination)`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:556-566, :1016-1022 a close or an error of the client socket ends the client`, rung: "implemented" },
    { ref: `${SV} lib/supavisor/client_handler.ex:545-556 and lib/supavisor/protocol/server.ex:183-190 the graceful shutdown of the pool: a client outside a transaction gets FATAL 57P01 'terminating connection due to administrator command' and its close, and a client in a transaction waits for its end (postpone)`, rung: "implemented" },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before ranch accepts the connection" },
    handshake: { note: "The startup packet, with a state timeout of 5 s" },
    auth: { note: "The authentication of the client by the password of its user, with a timeout of 15 s on each wait" },
    idle: { note: "Between two transactions: no server connection. The heartbeat runs" },
    checkout: { note: "A message of the client waits for a server connection of the pool. The handler does nothing else in this wait" },
    busy: { note: "A transaction: the client holds a server connection, and the server connection sends the replies to the client" },
    ended: { final: true, note: "The handler closed the client, with an ErrorResponse when it has one" },
  },
  events: {
    "local.accept": { kind: "local", note: "ranch accepts the TCP connection" },
    "rx.startup": { kind: "rx", note: "The startup packet of the client" },
    "local.authenticated": { kind: "local", note: "The password of the client matches, and the pool of the tenant serves" },
    "rx.query": { kind: "rx", note: "A message of the client between two transactions" },
    "local.checked-out": { kind: "local", note: "The pool gives a server connection, and it takes the client" },
    "server.ready": { kind: "local", note: "The server connection reads ReadyForQuery: the end of the transaction" },
    "server.exit": { kind: "peer", note: "The server connection of the client ends: the server closed it, reset it, or sent a fatal error" },
    "client.gone": { kind: "peer", note: "The client closes its connection, or a read or a write of its socket fails" },
    "pool.shutdown": { kind: "local", note: "The pool of the tenant shuts down gracefully, for example after 57P03 at a login of the pool" },
    "timer.handshake": { kind: "timer", note: "The state timeout of the handshake" },
    "timer.auth": { kind: "timer", note: "The timeout of a wait of the authentication" },
    "timer.heartbeat": { kind: "timer", note: "client_heartbeat_interval with no event of the handler" },
    "timer.checkout": { kind: "timer", note: "The pool gives no server connection in pool_checkout_timeout, or the server connection does not take the client in 15 s" },
    "tx.heartbeat": { kind: "tx", note: "The ParameterStatus application_name to the client" },
    "tx.error": { kind: "tx", note: "An ErrorResponse: FATAL with the SQLSTATE of the error, XX000 for an error of Supavisor" },
  },
  knobs: {
    client_heartbeat_interval: { key: "supavisor client_heartbeat_interval of the tenant", scope: "proxy", unit: "s", default: 60, off: 0, note: "lib/supavisor/tenants/tenant.ex:32" },
    client_idle_timeout: {
      key: "supavisor client_idle_timeout of the tenant",
      scope: "proxy",
      unit: "s",
      default: 0,
      off: 0,
      note: "lib/supavisor/tenants/tenant.ex:31. It ends no session in 2.9.13, thus this document gives it no timer. Its event timeout is armed only when the heartbeat is off, and it fires :idle_timeout, which goes to the catch-all clause (lib/supavisor/client_handler.ex:430-433, :734-744, :901-911)",
    },
    pool_checkout_timeout: { key: "supavisor pool_checkout_timeout of the user", scope: "proxy", unit: "ms", default: 60000, note: "lib/supavisor/tenants/user.ex:18" },
    handshake: { key: "the state timeout of the handshake", scope: "process", unit: "ms", default: 5000, note: "lib/supavisor/client_handler.ex:23: a constant of the source" },
    auth: { key: "the timeout of a wait of the authentication", scope: "process", unit: "ms", default: 15000, note: "lib/supavisor/client_handler.ex:315: a constant of the source" },
    checkout_call: { key: "the call timeout of DbHandler.checkout", scope: "process", unit: "ms", default: 15000, note: "lib/supavisor/db_handler.ex:106: a constant of the source" },
    slack: {
      key: "the lateness of the scheduler of the BEAM for one timer of a gen_statem",
      scope: "process",
      unit: "ms",
      default: 10,
      note: "An assumption of this document, not a value of Supavisor",
    },
  },
  timers: {
    handshake_timeout: {
      duration: { knob: "handshake", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:handshake"],
      cancels: ["rx.startup"],
      fires: "timer.handshake",
      note: "lib/supavisor/client_handler.ex:123, :198: a state timeout",
    },
    auth_timeout: {
      duration: { knob: "auth", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:auth"],
      cancels: ["local.authenticated"],
      fires: "timer.auth",
      note: "lib/supavisor/client_handler.ex:315, :600, :627",
    },
    heartbeat: {
      duration: { knob: "client_heartbeat_interval", unit: "s" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:idle"],
      cancels: ["rx.query"],
      fires: "timer.heartbeat",
      backoff: { resets: ["enter:idle"] },
      note: "lib/supavisor/client_handler.ex:435-445, :901-911: an event timeout, thus any event of the handler cancels it. Each heartbeat arms the next, the same each time. A Sync in a transaction arms it too",
    },
    checkout_timeout: {
      duration: { knob: "checkout_call", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:checkout"],
      cancels: ["local.checked-out"],
      fires: "timer.checkout",
      note: "lib/supavisor/client_handler.ex:848-851, lib/supavisor/db_handler.ex:101-110: poolboy gives a worker of the pool at once while the pool has one, and the call to that worker waits up to 15 s while it connects. With each worker checked out, poolboy waits up to pool_checkout_timeout",
    },
  },
  transitions: [
    { id: "scl.accept", from: "[none]", to: "handshake", on: "local.accept", timer: "handshake_timeout", source: "lib/supavisor/client_handler.ex:89-125" },
    { id: "scl.startup", from: "handshake", to: "auth", on: "rx.startup", timer: "auth_timeout", source: "lib/supavisor/client_handler.ex:211-315" },
    { id: "scl.handshake-timed-out", from: "handshake", to: "ended", on: "timer.handshake", source: "lib/supavisor/client_handler.ex:198-200" },
    { id: "scl.auth-timed-out", from: "auth", to: "ended", on: "timer.auth", errno: "XX000", emits: ["tx.error"], source: "lib/supavisor/client_handler.ex:627-635" },
    { id: "scl.authenticated", from: "auth", to: "idle", on: "local.authenticated", timer: "heartbeat", source: "lib/supavisor/client_handler.ex:340-410" },
    { id: "scl.heartbeat", from: ["idle", "busy"], to: "idle", on: "timer.heartbeat", guard: "the write of the heartbeat succeeds", timer: "heartbeat", emits: ["tx.heartbeat"], source: "lib/supavisor/client_handler.ex:435-440" },
    { id: "scl.query", from: "idle", to: "checkout", on: "rx.query", timer: "checkout_timeout", source: "lib/supavisor/client_handler.ex:705-716" },
    { id: "scl.checked-out", from: "checkout", to: "busy", on: "local.checked-out", source: "lib/supavisor/client_handler.ex:708-711, :851-856" },
    {
      id: "scl.checkout-timed-out",
      from: "checkout",
      to: "ended",
      on: "timer.checkout",
      errno: "XX000",
      emits: ["tx.error"],
      note: "FATAL 'unable to check out connection from the pool after <ms>ms in Transaction mode'",
      source: "lib/supavisor/client_handler.ex:712-714, :966-971, lib/supavisor/errors/checkout_timeout_error.ex",
    },
    { id: "scl.ready", from: "busy", to: "idle", on: "server.ready", timer: "heartbeat", source: "lib/supavisor/client_handler.ex:523-537" },
    {
      id: "scl.server-gone",
      from: "busy",
      to: "ended",
      on: "server.exit",
      note: "A fatal error of the server reaches the client first. A close or a reset of the server has no ErrorResponse: the client gets the close only",
      source: "lib/supavisor/client_handler.ex:485-497, lib/supavisor/errors/db_handler_exited_error.ex:15-25",
    },
    { id: "scl.gone", from: ["handshake", "auth", "idle", "checkout", "busy"], to: "ended", on: "client.gone", source: "lib/supavisor/client_handler.ex:556-566, :1016-1022" },
    {
      id: "scl.pool-shutdown",
      from: "idle",
      to: "ended",
      on: "pool.shutdown",
      errno: "57P01",
      emits: ["tx.error"],
      note: "FATAL 57P01 'terminating connection due to administrator command', then the close. A client in a transaction gets it at the end of the transaction",
      source: "lib/supavisor/client_handler.ex:545-556, lib/supavisor/protocol/server.ex:183-190",
    },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { handshake: "ESTABLISHED", auth: "ESTABLISHED", idle: "ESTABLISHED", checkout: "ESTABLISHED", busy: "ESTABLISHED" },
    sets: {},
    ends: "client.gone",
    note: "The socket of the client. ranch sets SO_KEEPALIVE and no other keepalive option, thus the three keepalive sysctls of the namespace apply. It also sets a send timeout of 30 s that closes the socket. That close has no timer here: the kernel sends the FIN only after the data before it, an assumption of this document",
  },
});
