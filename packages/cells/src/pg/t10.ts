import type { KnobValues, Machine } from "@mark1russell7/algebra";
import { detection, timerOf, transitionOn } from "@mark1russell7/algebra";
import type { Cell, Prediction, ProxyHop } from "@mark1russell7/harness";
import { HIKARICP_PGJDBC, PGBOUNCER_CLIENT, PGBOUNCER_SERVER, PGPOOL_SESSION } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { RTT_MS, RUNS, count, given, predict, s, seconds, sysctlsOf } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import type { Span } from "../mongo/model.ts";
import { linuxValues, span } from "../mongo/model.ts";
import type { HikariSpec } from "./hikari.ts";
import { hikariCell, hikariFirstOn, hikariPrediction, hikariValues } from "./hikari.ts";
import { SLOW_QUERY, STATEMENT_DEADLINE } from "./server.ts";
import type { PgSpec } from "./t01.ts";
import { APP_STALL, PG_RTT_MS, pgCell, pgPrediction } from "./t01.ts";

/**
 * The PostgreSQL catalog of T10 for HikariCP 7.1.0 over pgjdbc 42.7.13: the pool, PgBouncer 1.26.1
 * in transaction pooling, and one server of PostgreSQL 17.11. The client connects to PgBouncer, and
 * PgBouncer to the server. A fault at the server is between PgBouncer and the server.
 *
 * Each band is a band of the client, from the document of HikariCP, as in the catalog of T01. The
 * two documents of PgBouncer decide that no timer of PgBouncer ends the query of the client first.
 * At the defaults, its shortest timer on a query is query_wait_timeout, 120 s. PgBouncer does not
 * answer a query by itself. Thus behind a silent loss of the server, the client waits for its own timer.
 */

/**
 * This function gives the configuration of PgBouncer for a cell: one database and its server, in
 * transaction pooling. The settings of the cell come last, by the names of pgbouncer.ini and in the
 * units of the documents. Each other setting has its default.
 */
const pgbouncerIni = (settings: Readonly<Record<string, number>>): string =>
  [
    "[databases]",
    "postgres = host={{next.host}} port={{next.port}} dbname=postgres",
    "[pgbouncer]",
    "listen_addr = 0.0.0.0",
    "listen_port = 6432",
    "auth_type = trust",
    "auth_file = /etc/pgbouncer/userlist.txt",
    "pool_mode = transaction",
    // pgjdbc sends extra_float_digits at its startup, and PgBouncer refuses a parameter that it does not know
    "ignore_startup_parameters = extra_float_digits",
    ...Object.entries(settings).map(([name, value]) => `${name} = ${value}`),
    "",
  ].join("\n");

/**
 * This function gives the hop of PgBouncer 1.26.1 in transaction pooling, from the image that the
 * harness ships. It has the settings of a cell, and the sysctls of its namespace when a cell gives them.
 */
export const pgbouncerHop = (settings: Readonly<Record<string, number>> = {}, sysctls?: Readonly<Record<string, string>>): ProxyHop => {
  const unknown = Object.keys(settings).filter((name) => PGBOUNCER_CLIENT.knobs[name]?.unit == null && PGBOUNCER_SERVER.knobs[name]?.unit == null);
  if (unknown.length > 0) throw new Error(`no document of PgBouncer has a knob with a unit for ${unknown.join(", ")}`);
  return {
    name: "pgbouncer",
    kind: "proxy",
    image: { kind: "shipped", name: "pgbouncer" },
    port: 6432,
    files: { "/etc/pgbouncer/pgbouncer.ini": pgbouncerIni(settings), "/etc/pgbouncer/userlist.txt": '"postgres" ""\n' },
    ready: "process up: PgBouncer 1.26.1",
    ...(sysctls === undefined ? {} : { sysctls }),
    settings: {
      pool_mode: "transaction",
      ignore_startup_parameters: "extra_float_digits",
      version: "1.26.1",
      ...Object.fromEntries(Object.entries(settings).map(([name, value]) => [name, String(value)])),
    },
  };
};

/** This hop is PgBouncer 1.26.1 in transaction pooling at its defaults. */
export const PGBOUNCER_HOP: ProxyHop = pgbouncerHop();

/**
 * This function gives the values of the knobs of a document of PgBouncer. They are its defaults
 * with the settings of a cell, and a timer that is off has no bound.
 */
const pgbouncerValues = (doc: Machine, settings: Readonly<Record<string, number>> = {}): KnobValues => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(doc.knobs)) {
    const value = settings[name] ?? knob.default;
    if (knob.unit === null || value === null) continue;
    out[name] = { value: knob.off !== undefined && value === knob.off ? "infinite" : value, unit: knob.unit };
  }
  return given(out);
};

/**
 * This function gives the earliest time at which a timer of PgBouncer can end a query of its client,
 * in seconds. The settings of a cell change the defaults. The client waits in the queue or is
 * linked to a server, and the server is linked or in its check. A timer that is off has no bound.
 */
export const pgbouncerEarliest = (settings: Readonly<Record<string, number>> = {}): number => {
  const places: ReadonlyArray<readonly [Machine, string]> = [
    [PGBOUNCER_CLIENT, "waiting"],
    [PGBOUNCER_CLIENT, "linked"],
    [PGBOUNCER_SERVER, "tested"],
    [PGBOUNCER_SERVER, "active"],
  ];
  let earliest = Number.POSITIVE_INFINITY;
  for (const [doc, state] of places) {
    const values = pgbouncerValues(doc, settings);
    const own = detection(doc, { state, inFlight: true }, { name: "blackhole", passes: [] }, values);
    for (const detector of own.detectors) {
      const bounds = timerOf(doc, detector.timer, values);
      if ("unknown" in bounds.duration || bounds.duration.value === "infinite") continue;
      earliest = Math.min(earliest, seconds(bounds.duration, detector.timer) - seconds(bounds.early, "early"));
    }
  }
  return earliest;
};

/** A pooler end is the first timer of PgBouncer that ends a client. It has its name, the SQLSTATE of its FATAL, and its band from the event that arms it. */
export interface PoolerEnd {
  readonly timer: string;
  readonly errno: string;
  readonly band: Span;
}

/**
 * This function gives the first timer of PgBouncer that ends its client, with the settings of a
 * cell. It is null when no timer bounds the client. The client is linked to a server for a query in
 * flight, or idle between two transactions. Each timer of a client is a check of the janitor, thus
 * it is up to one pass late.
 */
export const pgbouncerFirst = (state: "linked" | "idle", settings: Readonly<Record<string, number>> = {}): PoolerEnd | null => {
  const values = pgbouncerValues(PGBOUNCER_CLIENT, settings);
  const own = detection(PGBOUNCER_CLIENT, { state, inFlight: state === "linked" }, { name: "blackhole", passes: [] }, values);
  const ends = own.detectors
    .flatMap((detector): PoolerEnd[] => {
      const bounds = timerOf(PGBOUNCER_CLIENT, detector.timer, values);
      if ("unknown" in bounds.duration || bounds.duration.value === "infinite") return [];
      const errno = transitionOn(PGBOUNCER_CLIENT, state, detector.fires)?.errno;
      if (errno === undefined) throw new Error(`pgbouncer-client has no transition from ${state} on ${detector.fires}`);
      const duration = seconds(bounds.duration, detector.timer);
      return [{ timer: detector.timer, errno, band: span(duration - seconds(bounds.early, "early"), duration + seconds(bounds.lateness, "lateness")) }];
    })
    .sort((a, b) => a.band.lo - b.band.lo);
  const [first, next] = ends;
  if (first === undefined) return null;
  if (next !== undefined && next.band.lo <= first.band.hi) throw new Error(`${first.timer} and ${next.timer} of PgBouncer can both end the query first`);
  return first;
};

/** This time is the most that PgBouncer adds to a reply: one more round trip, and one step of its loop of events. */
export const PGBOUNCER_LATENCY: number = PG_RTT_MS / 1000 + seconds(pgbouncerValues(PGBOUNCER_CLIENT)("slack"), "the slack of PgBouncer");

/**
 * This function gives the configuration of Pgpool-II for a cell: one backend, in streaming
 * replication at the defaults. The check of streaming replication finds the primary with the user
 * postgres. The settings of the cell come last. Each other setting has its default.
 */
const pgpoolConf = (settings: Readonly<Record<string, number>>): string =>
  [
    "listen_addresses = '*'",
    "port = 9999",
    "unix_socket_directories = '/tmp'",
    "pcp_socket_dir = '/tmp'",
    "pid_file_name = '/tmp/pgpool.pid'",
    "logdir = '/tmp'",
    "backend_hostname0 = '{{next.host}}'",
    "backend_port0 = {{next.port}}",
    "backend_weight0 = 1",
    "backend_flag0 = 'ALLOW_TO_FAILOVER'",
    "sr_check_user = 'postgres'",
    ...Object.entries(settings).map(([name, value]) => `${name} = ${value}`),
    "",
  ].join("\n");

/** This function gives the hop of Pgpool-II 4.7.3 with one backend, from the image that the harness ships, with the settings of a cell. */
export const pgpoolHop = (settings: Readonly<Record<string, number>> = {}): ProxyHop => {
  const unknown = Object.keys(settings).filter((name) => PGPOOL_SESSION.knobs[name]?.unit == null || PGPOOL_SESSION.knobs[name]?.scope !== "proxy");
  if (unknown.length > 0) throw new Error(`the document of Pgpool-II has no setting with a unit for ${unknown.join(", ")}`);
  return {
    name: "pgpool",
    kind: "proxy",
    image: { kind: "shipped", name: "pgpool" },
    port: 9999,
    files: { "/etc/pgpool/pgpool.conf": pgpoolConf(settings) },
    ready: "pgpool-II successfully started",
    settings: { backend_clustering_mode: "streaming_replication", backends: "1", version: "4.7.3", ...Object.fromEntries(Object.entries(settings).map(([name, value]) => [name, String(value)])) },
  };
};

/** This hop is Pgpool-II 4.7.3 with one backend at its defaults. */
export const PGPOOL_HOP: ProxyHop = pgpoolHop();

/** This time is the most that Pgpool-II adds to a reply: one more round trip, and one step of its child. */
export const PGPOOL_LATENCY: number = PG_RTT_MS / 1000 + seconds(pgbouncerValues(PGPOOL_SESSION)("slack"), "the slack of Pgpool-II");

/**
 * This function checks that no timer of Pgpool-II ends a session before the band of its client
 * ends. A query in flight waits with no bound, and the probe of each 30 s does not end it. Between
 * two queries only client_idle_limit acts, and it is off at the defaults.
 */
const pgpoolAllows = (plan: string, state: "idle" | "waiting", ends: number): void => {
  const values = pgbouncerValues(PGPOOL_SESSION);
  const own = detection(PGPOOL_SESSION, { state, inFlight: state === "waiting" }, { name: "blackhole", passes: [] }, values);
  for (const detector of own.detectors) {
    const bounds = timerOf(PGPOOL_SESSION, detector.timer, values);
    if ("unknown" in bounds.duration || bounds.duration.value === "infinite") continue;
    const at = seconds(bounds.duration, detector.timer);
    if (!(at > ends)) throw new Error(`${plan}: ${detector.timer} of Pgpool-II can end the session at ${at} s, before the band ends at ${ends} s`);
  }
};

/** A spec of T10 is a spec of HikariCP with the settings of PgBouncer that differ from its defaults, by the names of the documents. */
export interface T10Spec extends HikariSpec {
  /** This name is the pooler of the cell: PgBouncer, or Pgpool-II. */
  readonly via?: "pgpool";
  readonly pgbouncer?: Readonly<Record<string, number>>;
  /** These are the knobs of Linux TCP in the namespace of PgBouncer that differ from Linux 6.6. */
  readonly poolerLinux?: Readonly<Record<string, Extent>>;
  /** This flag makes the server socket of PgBouncer the observer, in place of the socket of the client. */
  readonly observesPooler?: true;
  /** This flag gives each run an environment of its own, with a dry warm-up: the fault changes the pooler for the runs after it. */
  readonly fresh?: true;
}

/** This function puts a spec behind PgBouncer: the hop with the settings of the spec, and the latency that PgBouncer adds to a reply. */
const behind = (spec: Omit<T10Spec, "pooler" | "poolerLatency">): T10Spec => ({
  ...spec,
  pooler: pgbouncerHop(spec.pgbouncer, spec.poolerLinux === undefined ? undefined : sysctlsOf(linuxValues(spec.poolerLinux))),
  poolerLatency: PGBOUNCER_LATENCY,
});

/** This function puts a spec behind Pgpool-II: its hop at the defaults, and the latency that it adds to a reply. */
const throughPgpool = (spec: Omit<T10Spec, "pooler" | "poolerLatency" | "via">): T10Spec => ({ ...spec, via: "pgpool", pooler: PGPOOL_HOP, poolerLatency: PGPOOL_LATENCY });

/** This query sleeps for a time, as a server that holds the query in flight: its kernel acknowledges the query. */
const sleep = (seconds: number): string => `SELECT pg_sleep(${seconds})`;

/** This value is the read timeout of pgjdbc that the borders of a held query bind: 10 s. */
const HELD_TIMEOUT = 10;

/** These are the read timeouts of pgjdbc that the borders of the give-up of PgBouncer bind, in seconds. At tcp_retries2 = 4, the kernel gives up 6.2 s to 13.344 s after the first retransmission. */
const POOLER_GIVEUP = { inside: 5, outside: 15 } as const;

/** This value is the query_timeout of PgBouncer that its borders bind, in seconds, against a hold of APP_STALL. */
const POOLER_TIMEOUT = { inside: APP_STALL + 1, outside: APP_STALL - 1 } as const;

/** These are the cells of T10 over hikaricp-pgjdbc, pgbouncer-1.26-transaction and postgresql that this catalog starts. */
export const T10_HIKARI_SPECS: readonly T10Spec[] = [
  {
    plan: "T10.defaults.1",
    name: "blackhole behind PgBouncer, idle: the keepalive checks the connection through the pooler, and its read timeout closes it",
    fault: "blackhole",
    mode: "idle",
    pooler: PGBOUNCER_HOP,
  },
  {
    plan: "T10.defaults.12",
    name: `app-stall behind PgBouncer: the server holds the query in flight ${APP_STALL} s, and nothing ends it`,
    fault: "app-stall",
    mode: "inflight",
    inflight: `SELECT pg_sleep(${APP_STALL})`,
    pooler: PGBOUNCER_HOP,
    poolerLatency: PGBOUNCER_LATENCY,
  },
  {
    plan: "T10.defaults.45",
    name: "blackhole behind PgBouncer, idle, keepaliveTime 0: HikariCP of the earlier epoch has no keepalive, and nothing reads the idle connection",
    fault: "blackhole",
    mode: "idle",
    options: { keepaliveTime: 0 },
    pooler: PGBOUNCER_HOP,
  },
  // ---- K-proxy-timeouts: the time of the query at the server against the request timeout of the proxy, query_timeout of PgBouncer
  ...([
    ["T10.border-off.7", POOLER_TIMEOUT.inside, "inside: the reply comes first"],
    ["T10.border-off.8", POOLER_TIMEOUT.outside, "outside: PgBouncer ends the query and closes the client"],
  ] as const).map(([plan, at, side]) =>
    behind({
      plan,
      name: `app-stall behind PgBouncer, the server holds the query ${APP_STALL} s, query_timeout ${at} s: ${side}`,
      fault: "app-stall",
      mode: "inflight",
      inflight: sleep(APP_STALL),
      pgbouncer: { query_timeout: at },
    }),
  ),
  // ---- K-client-timeouts: a query in flight to a dead host, the timer of the client against the give-up of the kernel.
  // Behind PgBouncer the kernel that gives up is the kernel of PgBouncer, on its server socket, which the cell observes.
  // The pool keeps one connection (minimumIdle 1). At its fixed size of 10, the pool still adds connections when the
  // fault comes, and each one sends a query through the one server of PgBouncer. In run 39136466890 such a query
  // took that server into the black hole, and PgBouncer opened a new server for the query of the cell
  ...([
    ["T10.border-off.43", POOLER_GIVEUP.inside, "inside: the read timeout comes first, and PgBouncer closes its server socket"],
    ["T10.border-off.44", POOLER_GIVEUP.outside, "outside: the kernel of PgBouncer gives up on its server socket first"],
  ] as const).map(([plan, at, side]) =>
    behind({
      plan,
      name: `blackhole of the server behind PgBouncer, a query in flight, tcp_retries2 = 4 at PgBouncer, minimumIdle 1, socketTimeout ${at} s: ${side}`,
      fault: "blackhole",
      mode: "inflight",
      options: { socketTimeout: at, minimumIdle: 1 },
      poolerLinux: { tcp_retries2: count(4) },
      observesPooler: true,
    }),
  ),
  // ---- K-client-timeouts: a frozen server with its kernel up acknowledges the query, and only the timer of the client ends it
  ...([
    ["T10.border-off.45", HELD_TIMEOUT - 1, "inside: the reply comes before the read timeout"],
    ["T10.border-off.46", HELD_TIMEOUT + 1, "outside: the read timeout closes the socket first"],
  ] as const).map(([plan, held, side]) =>
    behind({
      plan,
      name: `app-stall behind PgBouncer, the server holds the query ${held} s, socketTimeout ${HELD_TIMEOUT} s: ${side}`,
      fault: "app-stall",
      mode: "inflight",
      inflight: sleep(held),
      options: { socketTimeout: HELD_TIMEOUT },
    }),
  ),
  // ---- Pgpool-II 4.7.3 with one backend, at its defaults. A fault at the server is between Pgpool-II and the server
  throughPgpool({
    plan: "T10.defaults.2",
    name: "freeze-process behind Pgpool-II, a query in flight: Pgpool-II waits on the server with no bound, and nothing ends the query",
    fault: "freeze-process",
    mode: "inflight",
  }),
  // The pool keeps one connection (minimumIdle 1), and each run has a new environment. In run 39150949618, at the
  // fixed size of 10, the warm-up held. In the next run, the check of the observed connection got an error 0.1 ms
  // after its empty query, and the client after it got no connection from Pgpool-II. The pool of 10 checks its
  // connections one after the other, each into the black hole, and it opens a new connection after each failed
  // check. Pgpool-II then connects to the server through the black hole, and pgpool-session gives a failover for a
  // failed connect: with its only server detached, Pgpool-II ends each session and refuses each new client
  throughPgpool({
    plan: "T10.defaults.11",
    name: "blackhole behind Pgpool-II, idle, minimumIdle 1: the keepalive checks the connection through the pooler, and its read timeout closes it",
    fault: "blackhole",
    mode: "idle",
    options: { minimumIdle: 1 },
    fresh: true,
  }),
  // ---- O07 through Pgpool-II: the read timeout of pgjdbc against the statement deadline of the server
  ...([
    ["T10.border-off.97", STATEMENT_DEADLINE + 1, "inside: the server ends the query first"],
    ["T10.border-off.98", STATEMENT_DEADLINE - 1, "outside: the read timeout closes the socket first, and the server goes on"],
  ] as const).map(([plan, at, side]) =>
    throughPgpool({
      plan,
      name: `app-stall behind Pgpool-II, statement_timeout ${STATEMENT_DEADLINE} s, socketTimeout ${at} s: ${side}`,
      fault: "app-stall",
      mode: "inflight",
      inflight: SLOW_QUERY,
      server: { statement_timeout: STATEMENT_DEADLINE * 1000 },
      options: { socketTimeout: at },
    }),
  ),
  // ---- K-client-timeouts: the rule of the Command Timeout of Npgsql, a timer of the client against a server that
  // goes on with the statement. Here it is the read timeout of pgjdbc against the statement deadline, as O07 in T01
  ...([
    ["T10.border-off.47", STATEMENT_DEADLINE + 1, "inside: the server ends the query first"],
    ["T10.border-off.48", STATEMENT_DEADLINE - 1, "outside: the read timeout closes the socket first, and the server goes on"],
  ] as const).map(([plan, at, side]) =>
    behind({
      plan,
      name: `app-stall behind PgBouncer, statement_timeout ${STATEMENT_DEADLINE} s, socketTimeout ${at} s: ${side}`,
      fault: "app-stall",
      mode: "inflight",
      inflight: SLOW_QUERY,
      server: { statement_timeout: STATEMENT_DEADLINE * 1000 },
      options: { socketTimeout: at },
    }),
  ),
];

/** This reason is the reason of the cells with Supavisor between the client and the server. */
const SUPAVISOR = "the cell needs Supavisor 2.9 between the client and the server, and the harness has no Supavisor hop";

const NOT_THIS = "the breakpoint names another system's setting: this chain has no such knob";
const NO_TRANSACTION = "the client sends no transaction: the timer acts only on a session in a transaction";
const ONE_QUERY = "the cell needs more queries at once than the pool of PgBouncer holds. The client of the harness sends one query at a time";

/** These are the reasons of the waiting border cells of T10 over HikariCP, by range. */
const REASONS: ReadonlyArray<readonly [number, number, string]> = [
  [1, 2, NO_TRANSACTION],
  [3, 4, "the check of PgBouncer changes only what PgBouncer sends to the server: on each side the client gets the same reply, and no detector of the client ends"],
  [5, 6, NOT_THIS],
  [9, 10, "the choice of an idle server needs several clients at once. The harness starts one client, and it sends one query at a time"],
  [11, 12, "the rule compares the jitter of the lifetime of two pools: Npgsql and pgxpool have none, and HikariCP has its own. One pool has one jitter"],
  [13, 14, ONE_QUERY],
  [15, 16, "the cell needs two clients on one server connection of PgBouncer, one that sets the state of the session and one that reads it. The harness starts one client"],
  [
    17,
    18,
    "the client vanishes in silence toward PgBouncer: then only the keepalive of the client socket of PgBouncer ends the session, at 7875 s at the defaults. That is longer than the window of a cell",
  ],
  [19, 20, NO_TRANSACTION],
  [21, 24, NOT_THIS],
  [25, 26, "HikariCP closes an idle connection only when minimumIdle is below maximumPoolSize. The pool of the client has a fixed size of 10"],
  [27, 34, NOT_THIS],
  [35, 36, "the cell needs a virtual IP that kube-vip moves, which the PG catalog does not have"],
  [37, 40, NOT_THIS],
  [41, 42, NOT_THIS],
  [49, 54, NOT_THIS],
  [55, 56, "HikariCP has no reconnect schedule: a borrow that finds no connection waits up to connectionTimeout, 30 s, while the pool adds connections"],
  [57, 58, "pgjdbc and HikariCP make one attempt for each query: neither retries a query"],
  [59, 60, NOT_THIS],
  [61, 62, "the rule compares the drain of a load balancer with the grace of a pod: no pod and no load balancer are on this chain"],
  [63, 76, NOT_THIS],
  [77, 78, NOT_THIS],
  [79, 80, NOT_THIS],
  [81, 82, "PgBouncer has no timer for one read: query_timeout bounds a whole query, which T10.border-off.7 and .8 place"],
  [
    83,
    84,
    "the connect timer of PgBouncer closes its server socket in SYN_SENT, with no error and no FIN. The judge of the harness reads no end of a socket there",
  ],
  [85, 86, NOT_THIS],
  [87, 88, ONE_QUERY],
  [101, 102, "the cell needs PgBouncer in a pod of kind, which the PG catalog does not have"],
  [103, 104, "the rule compares the liveness probe of a pod with the failover of Pgpool-II: no pod is on this chain"],
];

/** These are the cells of the plan over HikariCP in T10 that this catalog does not start, each with its reason. */
export const T10_HIKARI_WAITING: readonly Waiting[] = [
  { plan: "T10.defaults.3", trigger: "fin", why: SUPAVISOR },
  { plan: "T10.defaults.13", trigger: "event:session", why: "the cell needs two clients on one server connection of PgBouncer, one that sets the state of the session and one that reads it. The harness starts one client" },
  { plan: "T10.defaults.14", trigger: "event:PAUSE", why: "PAUSE is a command of the console of PgBouncer: Pgpool-II has no command that holds the queries of its clients" },
  { plan: "T10.defaults.15", trigger: "event:reload", why: "the harness has no fault that sends SIGHUP to the program of a hop" },
  { plan: "T10.defaults.17", trigger: "load:clients", why: "the cell needs more clients than the pool of PgBouncer holds. The harness starts one client" },
  { plan: "T10.defaults.18", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  ...REASONS.flatMap(([from, to, why]) =>
    Array.from({ length: to - from + 1 }, (_, at) => from + at).map((n): Waiting => ({ plan: `T10.border-off.${n}`, trigger: "border", why })),
  ),
];

/** These are the cells of the plan over HikariCP in T10 that are another cell of the catalogs. */
export const T10_HIKARI_ALIASES: readonly Alias[] = [
  {
    plan: "T10.defaults.16",
    is: "T10.defaults.1",
    why: "the plan puts partition:complete between two nodes of Supavisor. With one PgBouncer, a complete partition from the server is the black hole of T10.defaults.1",
  },
];

/** These are the cells of the plan over pg-8.23 in T10 at the defaults, each with its reason to wait. */
export const T10_PG_WAITING: readonly Waiting[] = [
  { plan: "T10.defaults.7", trigger: "event:PAUSE", why: "the harness has no fault that runs a command on the console of PgBouncer, such as PAUSE" },
  { plan: "T10.defaults.8", trigger: "event:reload", why: "the harness has no fault that sends SIGHUP to the program of a hop" },
  {
    plan: "T10.defaults.32",
    trigger: "event:session",
    why: "the cell needs two clients that share a backend connection of Pgpool-II, one that sets the state of the session and one that reads it. The harness starts one client",
  },
  ...[9, 27, 28, 30, 31, 33, 34].map((n): Waiting => ({ plan: `T10.defaults.${n}`, trigger: "supavisor", why: SUPAVISOR })),
];

/** This value is the client_idle_timeout of PgBouncer that the borders of O01 bind, in seconds: PgBouncer closes a client that is idle for longer. */
export const POOLER_IDLE = 12;

/** These are the cells of T10 over pg-8.23, pgbouncer-1.26-transaction and postgresql that this catalog starts: the borders of O01. */
export const T10_PG_SPECS: readonly PgSpec[] = ([
  ["T10.border-off.91", 10, "inside: the pool closes its idle client first"],
  ["T10.border-off.92", 14, "outside: PgBouncer closes the idle client first"],
] as const).map(
  ([plan, at, side]): PgSpec => ({
    plan,
    name: `event:idle behind PgBouncer, no fault, idleTimeoutMillis ${at} s against client_idle_timeout ${POOLER_IDLE} s: ${side}`,
    fault: "none",
    mode: "idle",
    pooler: pgbouncerHop({ client_idle_timeout: POOLER_IDLE }),
    ...(at === 10 ? {} : { options: { idleTimeoutMillis: at * 1000 } }),
  }),
).concat([
  {
    plan: "T10.defaults.29",
    name: "fin behind Pgpool-II, idle: the FIN of the server ends the session of Pgpool-II, which closes the client",
    fault: "fin",
    mode: "idle",
    pooler: PGPOOL_HOP,
  },
]);

/** This function gives when the prediction of the client ends, in seconds: the end of its band, its reply, or its window. */
const endOf = (prediction: Prediction): number => {
  if (prediction.detects === true) return seconds(prediction.high, "the band");
  if (prediction.detects === false && prediction.replies !== undefined) return seconds(prediction.replies.high, "the reply");
  return seconds(prediction.window, "the window");
};

/**
 * This function gives the prediction of a cell through PgBouncer. When a timer of PgBouncer ends the
 * query before the band of the client, PgBouncer sends the client a FATAL ErrorResponse and closes
 * it. The FATAL reaches the client after one way, and one step of the JVM reads it. Thus the fail
 * line of the query gives the SQLSTATE of PgBouncer. Else the band of the client is the band of the
 * cell, and no timer of PgBouncer can come before its end.
 */
export const t10Prediction = (spec: T10Spec): Prediction => {
  if (spec.observesPooler === true) return atPoolerSocket(spec);
  if (spec.via === "pgpool") {
    // the band of the client is the band of the cell: no timer of Pgpool-II comes before its end,
    // between two queries or while one waits
    const client = hikariPrediction(spec);
    for (const state of ["idle", "waiting"] as const) pgpoolAllows(spec.plan, state, endOf(client));
    return client;
  }
  const client = hikariPrediction(spec);
  const ends = endOf(client);
  const settings = spec.pgbouncer ?? {};
  const own = spec.mode === "inflight" ? pgbouncerFirst("linked", settings) : null;
  if (own !== null && own.band.lo <= ends) {
    const driver = given(hikariValues(RTT_MS, spec.options));
    const slack = seconds(timerOf(HIKARICP_PGJDBC, "start_check", driver).lateness, "the slack of the JVM");
    const high = own.band.hi + PG_RTT_MS / 1000 + slack;
    const clientFirst = client.detects === true ? seconds(client.low, "the band") : Number.POSITIVE_INFINITY;
    if (!(high < clientFirst)) throw new Error(`${spec.plan}: ${own.timer} of PgBouncer and the client can each end the query first`);
    const fails = { ev: "fail", where: { n: 2 }, name: "sqlState" } as const;
    return { detects: true, timer: own.timer, errno: own.errno, from: "request-sent", low: s(own.band.lo), high: s(high), driver: { socket: "pool", ends: fails } };
  }
  const earliest = pgbouncerEarliest(settings);
  if (!(earliest > ends)) throw new Error(`${spec.plan}: a timer of PgBouncer can end the query at ${earliest} s, before the band ends at ${ends} s`);
  return client;
};

/**
 * This time bounds the first retransmission of the RTO timer on the server socket of PgBouncer, in
 * seconds from the send of the query. It is one step of PgBouncer, the probe of the tail loss and one
 * RTO. Each of them is up to 200 ms and a round trip at the defaults.
 */
const FIRST_RTO = 1;

/**
 * This function gives the prediction of a query in flight into a black hole between PgBouncer and
 * the server. The observer is the server socket of PgBouncer. The kernel of PgBouncer acknowledges
 * the query of the client. Thus the client has only its own timers, as for a frozen server.
 *
 * When the read timeout of the client comes first, PgBouncer reads the close of its client. It
 * closes the server, which was not ready (pbs.client-gone-dirty). Its socket goes from ESTABLISHED
 * to FIN_WAIT1, one step of PgBouncer later. Else the kernel of PgBouncer gives up on its server
 * socket, as Linux TCP gives.
 */
const atPoolerSocket = (spec: T10Spec): Prediction => {
  if (spec.fault !== "blackhole" || spec.mode !== "inflight") throw new Error(`${spec.plan}: this catalog observes the server socket of PgBouncer only for a query in flight into a black hole`);
  const driver = given(hikariValues(RTT_MS, spec.options));
  const client = hikariFirstOn("querying", MANIFESTATIONS["freeze-process"], driver, given(linuxValues(spec.linux)));
  if (client.kind === "delivered") throw new Error(`${spec.plan}: ${client.event} reaches the client through PgBouncer`);
  const giveup = predict({ name: spec.name, fault: "blackhole", manifestation: "blackhole", observer: "client", mode: "inflight", linux: spec.poolerLinux ?? {} });
  if (giveup.detects !== true || giveup.timer !== "retrans_giveup") throw new Error(`${spec.plan}: the kernel of PgBouncer does not give up on its server socket`);
  if (client.kind === "timer" && client.band.hi < seconds(giveup.low, "the give-up")) {
    const gone = PGBOUNCER_SERVER.transitions.find((each) => each.id === "pbs.client-gone-dirty");
    if (gone === undefined || gone.to !== "ended") throw new Error(`${spec.plan}: pgbouncer-server does not close a server that is not ready when its client goes`);
    return { detects: true, timer: client.timer, errno: "CLOSED", from: "request-sent", low: s(client.band.lo), high: s(client.band.hi + PGBOUNCER_LATENCY) };
  }
  if (client.kind === "silent" || client.band.lo > seconds(giveup.high, "the give-up") + FIRST_RTO) return giveup;
  throw new Error(`${spec.plan}: the read timeout and the give-up of PgBouncer can each come first`);
};

/** This observer is the server socket of PgBouncer: its socket toward the target. */
const POOLER_SOCKET = { hop: "pgbouncer", toward: "target" } as const;

/**
 * These are the HikariCP cells of T10 for the harness. A cell that observes the server socket of
 * PgBouncer has a fresh environment for each run, as a fin has. The judge finds the server socket
 * that PgBouncer opens in the run. In a second run of an environment, PgBouncer used an older
 * server. Also, its last failed login held the pool in its backoff (CI 39140133521). A cell whose
 * fault changes Pgpool-II has a fresh environment for each run too, and its warm-up has no fault.
 */
export const T10_HIKARI: readonly Cell[] = T10_HIKARI_SPECS.map((spec) => ({
  ...hikariCell(spec),
  ...(spec.observesPooler === true ? { observer: POOLER_SOCKET, environments: RUNS } : {}),
  ...(spec.fresh === true ? { environments: RUNS, fresh: true as const } : {}),
  prediction: t10Prediction(spec),
}));

/** This function gives the settings of PgBouncer for a cell of node-postgres: the settings of its hop, as numbers. */
const settingsOf = (spec: PgSpec): Record<string, number> => {
  const settings: Record<string, number> = {};
  for (const [name, value] of Object.entries(spec.pooler?.settings ?? {})) if (PGBOUNCER_CLIENT.knobs[name]?.unit != null || PGBOUNCER_SERVER.knobs[name]?.unit != null) settings[name] = Number(value);
  return settings;
};

/**
 * This function gives the prediction of a cell of node-postgres through PgBouncer. When
 * client_idle_timeout of PgBouncer comes before the idle timer of the pool, PgBouncer sends the idle
 * client a FATAL and closes it. The kernel of the client stamps the FIN, from ESTABLISHED to
 * CLOSE_WAIT. The timer counts from the last query of the client, thus up to one reply through
 * PgBouncer before the last segment that the client gets. The FIN comes one way after the pass of
 * the janitor. Else the band of the client is the band of the cell.
 */
export const t10PgPrediction = (spec: PgSpec): Prediction => {
  if (spec.pooler?.name === "pgpool") return throughPgpoolPg(spec);
  const client = pgPrediction(spec);
  const ends = endOf(client);
  const settings = settingsOf(spec);
  const own = pgbouncerFirst(spec.mode === "inflight" ? "linked" : "idle", settings);
  if (own !== null && own.band.lo <= ends) {
    if (spec.mode !== "idle") throw new Error(`${spec.plan}: this catalog measures a timer of PgBouncer on a client of node-postgres only when the client is idle`);
    const high = own.band.hi + PG_RTT_MS / 1000;
    const clientFirst = client.detects === true ? seconds(client.low, "the band") : Number.POSITIVE_INFINITY;
    if (!(high < clientFirst)) throw new Error(`${spec.plan}: ${own.timer} of PgBouncer and the pool can each end the client first`);
    return { detects: true, timer: own.timer, errno: "EOF", from: "last-received", low: s(own.band.lo - PGBOUNCER_LATENCY), high: s(high) };
  }
  const earliest = pgbouncerEarliest(settings);
  if (!(earliest > ends)) throw new Error(`${spec.plan}: a timer of PgBouncer can end the client at ${earliest} s, before the band ends at ${ends} s`);
  if (client.detects === true && client.timer === "idle_timeout" && client.errno === "CLOSED") return closedAtTerminate(spec, client);
  return client;
};

/**
 * This function gives the idle close of the pool through PgBouncer. The pool sends the message
 * `Terminate`, and it ends its socket only in the callback of that write (node-postgres
 * connection.js:217-227). PgBouncer closes the client in the pass that reads the message
 * (pbc.gone). Its FIN comes back one way later, before the loop of Node ends the socket. In 13 of
 * 13 runs of run 39133716990, the kernel of the client stamped ESTABLISHED to CLOSE_WAIT. Thus the
 * end is the FIN of PgBouncer, up to one step of PgBouncer after the idle timer.
 */
const closedAtTerminate = (spec: PgSpec, client: Prediction & { readonly detects: true }): Prediction => {
  const gone = PGBOUNCER_CLIENT.transitions.find((each) => [each.from].flat().includes("idle") && [each.on].flat().includes("rx.terminate"));
  if (gone === undefined || gone.to !== "ended") throw new Error(`${spec.plan}: pgbouncer-client does not close an idle client at its Terminate`);
  return { ...client, errno: "EOF", high: s(seconds(client.high, "the band") + PGBOUNCER_LATENCY) };
};

/**
 * This function gives the prediction of a cell of node-postgres through Pgpool-II. The FIN of the
 * server reaches the session of Pgpool-II, whose select() waits on the client and on the server. The
 * session ends with a FATAL error and the close of the client (pps.backend-eof). Thus the client gets
 * its FIN one step of Pgpool-II after the band of the direct pair.
 */
const throughPgpoolPg = (spec: PgSpec): Prediction => {
  const client = pgPrediction(spec);
  if (client.detects !== true || client.from !== "peer-closed" || spec.fault !== "fin") throw new Error(`${spec.plan}: this catalog measures node-postgres through Pgpool-II only for the FIN of the server`);
  const eof = PGPOOL_SESSION.transitions.find((each) => each.id === "pps.backend-eof");
  if (eof === undefined || eof.to !== "ended") throw new Error(`${spec.plan}: pgpool-session does not end a session at the FIN of the backend`);
  pgpoolAllows(spec.plan, "idle", seconds(client.high, "the band"));
  return { ...client, high: s(seconds(client.high, "the band") + PGPOOL_LATENCY) };
};

/** These are the node-postgres cells of T10 for the harness. */
export const T10_PG: readonly Cell[] = T10_PG_SPECS.map((spec) => ({ ...pgCell(spec), prediction: t10PgPrediction(spec) }));
