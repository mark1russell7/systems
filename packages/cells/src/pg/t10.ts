import type { KnobValues, Machine } from "@mark1russell7/algebra";
import { detection, timerOf } from "@mark1russell7/algebra";
import type { Cell, ProxyHop } from "@mark1russell7/harness";
import { PGBOUNCER_CLIENT, PGBOUNCER_SERVER } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { given, seconds } from "../catalog.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import type { HikariSpec } from "./hikari.ts";
import { hikariCell, hikariPrediction } from "./hikari.ts";
import { APP_STALL, PG_RTT_MS } from "./t01.ts";

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

/** This text is the configuration of PgBouncer for a cell: one database and its server, in transaction pooling. Each other setting has its default. */
const PGBOUNCER_INI = [
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
  "",
].join("\n");

/** This hop is PgBouncer 1.26.1 in transaction pooling, from the image that the harness ships. */
export const PGBOUNCER_HOP: ProxyHop = {
  name: "pgbouncer",
  kind: "proxy",
  image: { kind: "shipped", name: "pgbouncer" },
  port: 6432,
  files: { "/etc/pgbouncer/pgbouncer.ini": PGBOUNCER_INI, "/etc/pgbouncer/userlist.txt": '"postgres" ""\n' },
  ready: "process up: PgBouncer 1.26.1",
  settings: { pool_mode: "transaction", ignore_startup_parameters: "extra_float_digits", version: "1.26.1" },
};

/** This function gives the values of the knobs of a document of PgBouncer: its defaults, with no bound for a timer that is off. */
const pgbouncerValues = (doc: Machine): KnobValues => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(doc.knobs)) {
    if (knob.unit === null || knob.default === null) continue;
    out[name] = { value: knob.off !== undefined && knob.default === knob.off ? "infinite" : knob.default, unit: knob.unit };
  }
  return given(out);
};

/**
 * This function gives the earliest time at which a timer of PgBouncer can end a query of its client,
 * in seconds, at the defaults. The client waits in the queue or is linked to a server, and the server
 * is linked or in its check. A timer that is off has no bound.
 */
export const pgbouncerEarliest = (): number => {
  const places: ReadonlyArray<readonly [Machine, string]> = [
    [PGBOUNCER_CLIENT, "waiting"],
    [PGBOUNCER_CLIENT, "linked"],
    [PGBOUNCER_SERVER, "tested"],
    [PGBOUNCER_SERVER, "active"],
  ];
  let earliest = Number.POSITIVE_INFINITY;
  for (const [doc, state] of places) {
    const values = pgbouncerValues(doc);
    const own = detection(doc, { state, inFlight: true }, { name: "blackhole", passes: [] }, values);
    for (const detector of own.detectors) {
      const bounds = timerOf(doc, detector.timer, values);
      if ("unknown" in bounds.duration || bounds.duration.value === "infinite") continue;
      earliest = Math.min(earliest, seconds(bounds.duration, detector.timer) - seconds(bounds.early, "early"));
    }
  }
  return earliest;
};

/** This time is the most that PgBouncer adds to a reply: one more round trip, and one step of its loop of events. */
export const PGBOUNCER_LATENCY: number = PG_RTT_MS / 1000 + seconds(pgbouncerValues(PGBOUNCER_CLIENT)("slack"), "the slack of PgBouncer");

/** These are the cells of T10 over hikaricp-pgjdbc, pgbouncer-1.26-transaction and postgresql that this catalog starts. */
export const T10_HIKARI_SPECS: readonly HikariSpec[] = [
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
];

/** This reason is the reason of the cells with Pgpool-II between the client and the server. */
const PGPOOL = "the cell needs Pgpool-II 4.7 between the client and the server, and the harness has no Pgpool hop";
/** This reason is the reason of the cells with Supavisor between the client and the server. */
const SUPAVISOR = "the cell needs Supavisor 2.9 between the client and the server, and the harness has no Supavisor hop";

/** These are the cells of the plan over HikariCP in T10 at the defaults that this catalog does not start, each with its reason. */
export const T10_HIKARI_WAITING: readonly Waiting[] = [
  { plan: "T10.defaults.2", trigger: "freeze-process", why: PGPOOL },
  { plan: "T10.defaults.3", trigger: "fin", why: SUPAVISOR },
  { plan: "T10.defaults.11", trigger: "blackhole", why: PGPOOL },
  { plan: "T10.defaults.13", trigger: "event:session", why: "the cell needs two clients on one server connection of PgBouncer, one that sets the state of the session and one that reads it. The harness starts one client" },
  { plan: "T10.defaults.14", trigger: "event:PAUSE", why: PGPOOL },
  { plan: "T10.defaults.15", trigger: "event:reload", why: "the harness has no fault that sends SIGHUP to the program of a hop" },
  { plan: "T10.defaults.17", trigger: "load:clients", why: "the cell needs more clients than the pool of PgBouncer holds. The harness starts one client" },
  { plan: "T10.defaults.18", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
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

/**
 * This function checks that no timer of PgBouncer ends the query of a cell before the band of the
 * client ends. Then the band of the client is the band of the cell.
 */
const throughPgbouncer = (spec: HikariSpec): HikariSpec => {
  const prediction = hikariPrediction(spec);
  const ends = prediction.detects === true ? seconds(prediction.high, "the band") : seconds(prediction.window, "the window");
  const earliest = pgbouncerEarliest();
  if (!(earliest > ends)) throw new Error(`${spec.plan}: a timer of PgBouncer can end the query at ${earliest} s, before the band ends at ${ends} s`);
  return spec;
};

/** These are the HikariCP cells of T10 for the harness. */
export const T10_HIKARI: readonly Cell[] = T10_HIKARI_SPECS.map((spec) => hikariCell(throughPgbouncer(spec)));
