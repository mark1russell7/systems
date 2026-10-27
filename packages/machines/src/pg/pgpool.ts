import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The source of each fact below is the C source of Pgpool-II at the tag V4_7_3 (commit
// 07d24655e42dfdbfe2e7549df6166e057b99b622, the tarball of GitHub with SHA-256 e48ff26f...e2acd2).
// Each line number is a line of that file at the tag. A fact of the kernel is an assumption of this
// document, and its note says so.
export const PP = "V4_7_3";

/**
 * This document is Pgpool-II 4.7.3 with one backend, for one session of a client. It gives the states
 * of the session in its child process, from the accept of the client to its close. It also gives the
 * timers that act on it.
 *
 * A child process serves one client at a time. Between two queries it waits in one select() on the
 * client and on the backend. Thus the close of either side ends the session at once. At the defaults
 * no timer bounds an idle session: client_idle_limit is 0.
 *
 * While a query is in flight, the child waits on the backend only. It does not read the client, and
 * no timer of Pgpool-II ends the query. Each 30 s of that wait, it writes a dummy ParameterStatus to
 * the client, and a failed write ends the session.
 *
 * An error of a session reaches the client as an ErrorResponse, with the SQLSTATE of Pgpool-II or
 * XX000. The FIN of the backend ends the session with a FATAL error. A failed read of the backend,
 * for example a reset, and a failed connect to the backend ask the main process for a failover
 * (failover_on_backend_error).
 */
export const PGPOOL_SESSION: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "pgpool-session",
  title: "Pgpool-II 4.7.3 with one backend: one session of a client in its child process",
  layer: "proxy",
  version: "4.7.3",
  conditions: {
    pgpool: "4.7.3",
    backend_clustering_mode: "streaming_replication, the default, with one backend",
    client: "a PostgreSQL client over TCP, with no TLS",
    backend: "one PostgreSQL server",
  },
  sources: [
    {
      ref: `${PP} src/config/pool_config_variables.c:570-607, :1661-1761, :2003-2121, :2388-2396 the defaults: connection_cache on, failover_on_backend_error on, failover_on_backend_shutdown off, health_check_period 0, health_check_timeout 20 s, connect_timeout 10000 ms, num_init_children 32, child_life_time 300 s, client_idle_limit 0, connection_life_time 0, authentication_timeout 60 s, max_pool 4, backend_clustering_mode streaming_replication`,
      rung: "implemented",
    },
    { ref: `${PP} src/protocol/pool_connection_pool.c:849 and src/protocol/child.c:1789, :1981 each socket to the backend and to the client gets TCP_NODELAY. Only the watchdog sets SO_KEEPALIVE (src/watchdog/watchdog.c:961, :1089)`, rung: "implemented" },
    { ref: `${PP} src/protocol/child.c:163-516 do_child: wait for a client, check that a backend is up, connect or reuse the backend, then the loop of pool_process_query until the session ends`, rung: "implemented" },
    { ref: `${PP} src/protocol/child.c:617-632, :800, :1281-1310 authentication_timeout: an alarm over the read of the startup packet. Its expiry exits the child`, rung: "implemented" },
    { ref: `${PP} src/protocol/child.c:2016-2170 get_backend_connection: the startup packet, then a connection of the pool of the child for the same user, database and startup packet, else a new connect. With enable_pool_hba off, the backend does the authentication`, rung: "implemented" },
    { ref: `${PP} src/protocol/child.c:344-353, :1670-1691 child_life_time counts the 1 s timeouts of a child that waits for a client: it never ends a session`, rung: "implemented" },
    { ref: `${PP} src/protocol/pool_connection_pool.c:590-669 the connect to the backend is non-blocking, and one select() bounds it by connect_timeout. At 0 it has no bound`, rung: "implemented" },
    { ref: `${PP} src/protocol/pool_connection_pool.c:953-1012 a failed connect to the backend: with failover_on_backend_error, a request of failover, then FATAL 'failed to create a backend connection'`, rung: "implemented" },
    { ref: `${PP} src/protocol/pool_process_query.c:4867-5002 between two queries: one select() on the client and on each backend. With client_idle_limit, its timeout is 1 s, and more than client_idle_limit timeouts end the session with 57000`, rung: "implemented" },
    { ref: `${PP} src/protocol/pool_process_query.c:5004-5146 a backend that is readable between two queries: its error or its end is read at once`, rung: "implemented" },
    { ref: `${PP} src/protocol/pool_process_query.c:539-627 and src/context/pool_query_context.c:658-693, :877-911 each query waits for its backend in steps of 30 s. After each step with no data, a dummy ParameterStatus goes to the client, and a failed flush ends the session`, rung: "implemented" },
    { ref: `${PP} src/utils/pool_stream.c:1303-1387 pool_check_fd: one select() with the timeout of the step, or none`, rung: "implemented" },
    { ref: `${PP} src/utils/pool_stream.c:225-248 a failed read of the backend: with failover_on_backend_error, a request of failover, then the child exits`, rung: "implemented" },
    { ref: `${PP} src/utils/pool_stream.c:263-276 a read of 0 bytes from the backend, its FIN: FATAL 'unable to read data from DB node', and no failover`, rung: "implemented" },
    { ref: `${PP} src/utils/error/elog.c:1888-2007 an error of the session goes to the client as an ErrorResponse: its severity, the SQLSTATE of Pgpool-II or XX000, and the message`, rung: "implemented" },
    {
      ref: `${PP} src/main/pgpool_main.c:3551-3566 and src/protocol/pool_process_query.c:456-466 SIGHUP: the parent reads the configuration again and sends SIGHUP to each child. A child in a session reads it again in the loop of its query and keeps the session: a reload has no transition here`,
      rung: "implemented",
    },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the child accepts the connection" },
    login: { note: "The read of the startup packet. The alarm of authentication_timeout runs" },
    connecting: { note: "The connect to the backend and its authentication, when the pool of the child has no connection for the user and the database. The select() of the connect is bounded by connect_timeout" },
    idle: { note: "Between two queries: one select() on the client and on the backend, thus a close of either side is read at once" },
    waiting: { note: "A query in flight: the child waits on the backend only, in steps of 30 s. It does not read the client" },
    ended: { final: true, note: "The child closed the client, after an ErrorResponse for an error, or the client went" },
  },
  events: {
    "local.accept": { kind: "local", note: "The child accepts the TCP connection" },
    "local.reload": { kind: "local", note: "SIGHUP, as pgpool reload sends it: the child reads its configuration again. No transition takes it" },
    "rx.startup": { kind: "rx", note: "The startup packet of the client" },
    "local.cached": { kind: "local", note: "The pool of the child has a connection for the user and the database: no connect" },
    "local.connected": { kind: "local", note: "The connect to the backend succeeds" },
    "rx.query": { kind: "rx", note: "The first packet of a query of the client" },
    "rx.ready-for-query": { kind: "rx", note: "The backend sends ReadyForQuery: the end of the query" },
    "backend.eof": { kind: "peer", note: "A read of the backend gets 0 bytes: its FIN" },
    "backend.error": { kind: "peer", note: "A read or a select() of the backend fails: a reset, or an error of the socket" },
    "frontend.eof": { kind: "peer", note: "The client closes its connection, or a write to it fails" },
    "timer.auth": { kind: "timer", note: "The alarm of authentication_timeout" },
    "timer.connect": { kind: "timer", note: "The select() of the connect to the backend times out" },
    "timer.idle": { kind: "timer", note: "More than client_idle_limit timeouts of 1 s of the select() between two queries" },
    "timer.probe": { kind: "timer", note: "A step of 30 s of the wait for the backend ends with no data" },
    "tx.error": { kind: "tx", note: "An ErrorResponse: its severity, the SQLSTATE of Pgpool-II or XX000, and the message" },
    "tx.probe": { kind: "tx", note: "A dummy ParameterStatus to the client: pgpool_dummy_param = pgpool_dummy_value" },
    "tx.failover": { kind: "local", note: "A request of failover for the backend to the main process" },
  },
  knobs: {
    authentication_timeout: { key: "pgpool authentication_timeout", scope: "proxy", unit: "s", default: 60, off: 0, note: "src/config/pool_config_variables.c:2102-2110" },
    connect_timeout: { key: "pgpool connect_timeout", scope: "proxy", unit: "ms", default: 10000, off: 0, note: "src/config/pool_config_variables.c:1745-1761. It bounds the connect to the backend" },
    client_idle_limit: { key: "pgpool client_idle_limit", scope: "proxy", unit: "s", default: 0, off: 0, note: "src/config/pool_config_variables.c:2069-2077" },
    tick: {
      key: "the timeout of the select() between two queries when client_idle_limit is set",
      scope: "process",
      unit: "s",
      default: 1,
      note: "src/protocol/pool_process_query.c:4938-4947: a constant of the source, not a setting",
    },
    probe: {
      key: "the step of the wait for the backend of a query",
      scope: "process",
      unit: "s",
      default: 30,
      note: "src/protocol/pool_process_query.c:561: a constant of the source, not a setting",
    },
    slack: {
      key: "the lateness of the loop of the child for one step",
      scope: "process",
      unit: "ms",
      default: 10,
      note: "An assumption of this document, not a value of Pgpool-II: the child does each step in one process with no other work",
    },
  },
  timers: {
    authentication_timeout: {
      duration: { knob: "authentication_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:login"],
      cancels: ["rx.startup"],
      fires: "timer.auth",
      note: "src/protocol/child.c:617-632, :1281-1310: alarm() in whole seconds",
    },
    connect_timeout: {
      duration: { knob: "connect_timeout", unit: "ms" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:connecting"],
      cancels: ["local.connected", "backend.error"],
      fires: "timer.connect",
      note: "src/protocol/pool_connection_pool.c:645-669",
    },
    client_idle_limit: {
      duration: { expr: "client_idle_limit + tick", unit: "s" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:idle"],
      cancels: ["rx.query"],
      fires: "timer.idle",
      note: "src/protocol/pool_process_query.c:4962-4976: each timeout of 1 s counts, and the count must exceed client_idle_limit, thus the session ends one tick after the limit. Each packet starts the count again. No bound at the defaults",
    },
    probe: {
      duration: { knob: "probe", unit: "s" },
      lateness: { knob: "slack", unit: "ms" },
      arms: ["enter:waiting"],
      cancels: ["rx.ready-for-query"],
      fires: "timer.probe",
      backoff: { resets: ["enter:waiting"] },
      note: "src/protocol/pool_process_query.c:558-595: each wait is 30 s, the same each time. It does not end the query: it checks the client",
    },
  },
  transitions: [
    { id: "pps.accept", from: "[none]", to: "login", on: "local.accept", timer: "authentication_timeout", source: "src/protocol/child.c:342-398" },
    { id: "pps.reuse", from: "login", to: "idle", on: "local.cached", guard: "the pool of the child has a connection for the user, the database and the same startup packet (connection_cache)", timer: "client_idle_limit", source: "src/protocol/child.c:2112-2166" },
    { id: "pps.connect", from: "login", to: "connecting", on: "rx.startup", guard: "no connection in the pool of the child", timer: "connect_timeout", source: "src/protocol/child.c:2153-2160, src/protocol/pool_connection_pool.c:907-955" },
    { id: "pps.connected", from: "connecting", to: "idle", on: "local.connected", timer: "client_idle_limit", source: "src/protocol/pool_connection_pool.c:1013-1019" },
    {
      id: "pps.connect-failed",
      from: "connecting",
      to: "ended",
      on: ["timer.connect", "backend.error"],
      errno: "XX000",
      emits: ["tx.failover", "tx.error"],
      note: "FATAL 'failed to create a backend connection', 'executing failover on backend'",
      source: "src/protocol/pool_connection_pool.c:953-969",
    },
    {
      id: "pps.auth-timed-out",
      from: "login",
      to: "ended",
      on: "timer.auth",
      timer: "authentication_timeout",
      note: "The child exits",
      source: "src/protocol/child.c:1281-1287",
    },
    { id: "pps.query", from: "idle", to: "waiting", on: "rx.query", timer: "probe", source: "src/context/pool_query_context.c:658-693, :877-911" },
    { id: "pps.reply", from: "waiting", to: "idle", on: "rx.ready-for-query", timer: "client_idle_limit", source: "src/protocol/pool_process_query.c:558-626" },
    { id: "pps.probe", from: "waiting", to: "waiting", on: "timer.probe", timer: "probe", emits: ["tx.probe"], note: "The dummy ParameterStatus, each 30 s of the wait", source: "src/protocol/pool_process_query.c:570-595" },
    {
      id: "pps.idle-timed-out",
      from: "idle",
      to: "ended",
      on: "timer.idle",
      timer: "client_idle_limit",
      errno: "57000",
      emits: ["tx.error"],
      note: "'child connection forced to terminate due to client_idle_limit:%d is reached'",
      source: "src/protocol/pool_process_query.c:4965-4976",
    },
    {
      id: "pps.backend-eof",
      from: ["idle", "waiting"],
      to: "ended",
      on: "backend.eof",
      errno: "XX000",
      emits: ["tx.error"],
      note: "FATAL 'unable to read data from DB node', 'EOF encountered with backend', with no request of failover",
      source: "src/utils/pool_stream.c:263-276, src/protocol/pool_process_query.c:5021-5146",
    },
    {
      id: "pps.backend-error",
      from: ["idle", "waiting"],
      to: "ended",
      on: "backend.error",
      emits: ["tx.failover"],
      note: "The child exits before it reports the error, thus the client gets the close only",
      source: "src/utils/pool_stream.c:225-248",
    },
    {
      id: "pps.gone",
      from: ["login", "idle", "waiting"],
      to: "ended",
      on: "frontend.eof",
      note: "Between two queries the child reads the close at once. In a wait it finds it only at the write of a probe or of the reply",
      source: "src/protocol/pool_process_query.c:570-595, :4895-4933",
    },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { login: "ESTABLISHED", connecting: "ESTABLISHED", idle: "ESTABLISHED", waiting: "ESTABLISHED" },
    sets: {},
    ends: "frontend.eof",
    note: "The socket of the client. It has TCP_NODELAY and no SO_KEEPALIVE. In a wait the child does not read it: the kernel takes its FIN, and Pgpool-II finds it at the next write",
  },
});
