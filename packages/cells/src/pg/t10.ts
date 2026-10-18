import type { KnobValues, Machine } from "@mark1russell7/algebra";
import { detection, timerOf, transitionOn } from "@mark1russell7/algebra";
import type { Cell, Prediction, ProxyHop } from "@mark1russell7/harness";
import { HIKARICP_PGJDBC, PGBOUNCER_CLIENT, PGBOUNCER_SERVER } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { RTT_MS, given, s, seconds } from "../catalog.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import type { Span } from "../mongo/model.ts";
import { span } from "../mongo/model.ts";
import type { HikariSpec } from "./hikari.ts";
import { hikariCell, hikariPrediction, hikariValues } from "./hikari.ts";
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

/** This function gives the hop of PgBouncer 1.26.1 in transaction pooling, from the image that the harness ships, with the settings of a cell. */
export const pgbouncerHop = (settings: Readonly<Record<string, number>> = {}): ProxyHop => {
  const unknown = Object.keys(settings).filter((name) => PGBOUNCER_CLIENT.knobs[name]?.unit == null && PGBOUNCER_SERVER.knobs[name]?.unit == null);
  if (unknown.length > 0) throw new Error(`no document of PgBouncer has a knob with a unit for ${unknown.join(", ")}`);
  return {
    name: "pgbouncer",
    kind: "proxy",
    image: { kind: "shipped", name: "pgbouncer" },
    port: 6432,
    files: { "/etc/pgbouncer/pgbouncer.ini": pgbouncerIni(settings), "/etc/pgbouncer/userlist.txt": '"postgres" ""\n' },
    ready: "process up: PgBouncer 1.26.1",
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

/** A spec of T10 is a spec of HikariCP with the settings of PgBouncer that differ from its defaults, by the names of the documents. */
export interface T10Spec extends HikariSpec {
  readonly pgbouncer?: Readonly<Record<string, number>>;
}

/** This function puts a spec behind PgBouncer: the hop with the settings of the spec, and the latency that PgBouncer adds to a reply. */
const behind = (spec: Omit<T10Spec, "pooler" | "poolerLatency">): T10Spec => ({ ...spec, pooler: pgbouncerHop(spec.pgbouncer), poolerLatency: PGBOUNCER_LATENCY });

/** This query sleeps for a time, as a server that holds the query in flight: its kernel acknowledges the query. */
const sleep = (seconds: number): string => `SELECT pg_sleep(${seconds})`;

/** This value is the read timeout of pgjdbc that the borders of a held query bind: 10 s. */
const HELD_TIMEOUT = 10;

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

/** This reason is the reason of the cells with Pgpool-II between the client and the server. */
const PGPOOL = "the cell needs Pgpool-II 4.7 between the client and the server, and the harness has no Pgpool hop";
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
  [41, 42, PGPOOL],
  [
    43,
    44,
    "behind PgBouncer the socket of the client sends no retransmission. The kernel of PgBouncer gives up on its server socket, and no cell of this catalog observes that socket",
  ],
  [49, 54, NOT_THIS],
  [55, 56, "HikariCP has no reconnect schedule: a borrow that finds no connection waits up to connectionTimeout, 30 s, while the pool adds connections"],
  [57, 58, "pgjdbc and HikariCP make one attempt for each query: neither retries a query"],
  [59, 60, NOT_THIS],
  [61, 62, "the rule compares the drain of a load balancer with the grace of a pod: no pod and no load balancer are on this chain"],
  [63, 76, NOT_THIS],
  [77, 78, PGPOOL],
  [79, 80, NOT_THIS],
  [81, 82, "PgBouncer has no timer for one read: query_timeout bounds a whole query, which T10.border-off.7 and .8 place"],
  [
    83,
    84,
    "the connect timer of PgBouncer acts on its server socket, which no cell of this catalog observes. The client sees the login of PgBouncer, which client_login_timeout bounds",
  ],
  [85, 86, NOT_THIS],
  [87, 88, ONE_QUERY],
  [97, 98, PGPOOL],
  [101, 102, "the cell needs PgBouncer in a pod of kind, which the PG catalog does not have"],
  [103, 104, PGPOOL],
];

/** These are the cells of the plan over HikariCP in T10 that this catalog does not start, each with its reason. */
export const T10_HIKARI_WAITING: readonly Waiting[] = [
  { plan: "T10.defaults.2", trigger: "freeze-process", why: PGPOOL },
  { plan: "T10.defaults.3", trigger: "fin", why: SUPAVISOR },
  { plan: "T10.defaults.11", trigger: "blackhole", why: PGPOOL },
  { plan: "T10.defaults.13", trigger: "event:session", why: "the cell needs two clients on one server connection of PgBouncer, one that sets the state of the session and one that reads it. The harness starts one client" },
  { plan: "T10.defaults.14", trigger: "event:PAUSE", why: PGPOOL },
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
  ...[8, 29, 32].map((n): Waiting => ({ plan: `T10.defaults.${n}`, trigger: "pgpool", why: PGPOOL })),
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
);

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

/** These are the HikariCP cells of T10 for the harness. */
export const T10_HIKARI: readonly Cell[] = T10_HIKARI_SPECS.map((spec) => ({ ...hikariCell(spec), prediction: t10Prediction(spec) }));

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

/** These are the node-postgres cells of T10 for the harness. */
export const T10_PG: readonly Cell[] = T10_PG_SPECS.map((spec) => ({ ...pgCell(spec), prediction: t10PgPrediction(spec) }));
