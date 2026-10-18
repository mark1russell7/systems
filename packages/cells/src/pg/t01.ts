import type { Detector, KnobValues, Manifestation } from "@mark1russell7/algebra";
import { detection, errnoOf, overValues, timerOf, timerUnder, transitionOn } from "@mark1russell7/algebra";
import type { Cell, Prediction, Target } from "@mark1russell7/harness";
import { LINUX_TCP, NODE_POSTGRES } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { HZ, RTT_MS, RUNS, count, given, predict, s, seconds, sysctlsOf } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Waiting } from "../mongo/cells.ts";
import type { Span } from "../mongo/model.ts";
import { linuxValues, span, spanOf } from "../mongo/model.ts";
import { SLOW_QUERY, STATEMENT_DEADLINE, pgTargetWith, statementDeadline } from "./server.ts";

/**
 * The PostgreSQL catalog of T01: node-postgres (pg 8.23.1 with pg-pool 3.14.0) and one server of
 * PostgreSQL 17.11, on the direct pair. The client is one `pg.Pool` at its defaults. Each cell is
 * named by the cell of the plan that it stands for (`T01.defaults.122` and the next ones, for the
 * tuple pg-8.23 → postgresql).
 *
 * Each band comes from the machine documents `node-postgres` and `linux-tcp`, as the algebra
 * composes them: the timers of the pool, then the kernel below it. At the defaults, pg sets no
 * keepalive and no query timeout. Thus an idle client ends at the idle timer of the pool, and only
 * the kernel ends a query in flight.
 */

/** This image is PostgreSQL 17.11 on Debian trixie, pinned by the digest of its index: the server of each cell. */
export const PG_IMAGE = "postgres:17.11@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3";

/**
 * This target is PostgreSQL as the child of a shell, with trust authentication. The entrypoint
 * first starts a server on a Unix socket only, to initialize the cluster. Thus the line of the TCP
 * listener tells that the real server serves. A `fin` fault stops each postgres process with
 * SIGKILL, and a freeze stops them with SIGSTOP (`program`).
 */
export const PG_TARGET: Target = {
  image: PG_IMAGE,
  port: 5432,
  ready: 'listening on IPv4 address "0.0.0.0", port 5432',
  program: "postgres",
  command: ["sh", "-c", "POSTGRES_HOST_AUTH_METHOD=trust docker-entrypoint.sh postgres & echo $! > /tmp/server.pid; while :; do sleep 3600; done"],
  kill: ["sh", "-c", 'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = postgres ] && kill -KILL "${p#/proc/}"; done; true'],
};

/** This text is the version of the client that each cell loads, as the lockfile of its image pins it. */
export const PG_DRIVER = "pg 8.23.1 with pg-pool 3.14.0 on Node 24.21.0";

/** A spec is one cell of the catalog: its cell of the plan, its fault and the place of the client. It also gives the sysctls of the namespace. */
export interface PgSpec {
  readonly plan: string;
  readonly name: string;
  readonly fault: "blackhole" | "rst" | "fin" | "unreachable" | "freeze-process" | "stall" | "none" | "app-stall";
  readonly mode: "idle" | "inflight";
  readonly icmp?: "host" | "net" | "port" | "admin";
  /** This time is the length of a stall, in seconds. */
  readonly stall?: number;
  /** These are the sysctls of Linux TCP at the client that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** This flag starts the client into a fault that holds already: its first connect meets it. */
  readonly before?: true;
  /** These are the options of the pool that differ from the defaults, by the names and in the units of pg. */
  readonly options?: Readonly<Record<string, number>>;
  /** This text is the query of each query of the client. Without it, the client sends `SELECT 1`. */
  readonly query?: string;
  /** This text is the query in flight. Without it, the query in flight is `query`, as each other query. */
  readonly inflight?: string;
  /** These are the settings of the server that differ from the defaults, by the names and in the units of `postgres-session`. */
  readonly server?: Readonly<Record<string, number>>;
}

/**
 * These are the two values of the service that R3 binds for the borders of pg. They are the slowest
 * poll of a check (O13) and the startup budget of a pod (O15). A border cell puts the timer of the
 * pool on each side of its value.
 */
export const SLOWEST_POLL = 10;
export const STARTUP_BUDGET = 30;

/** This time is the hold of the server in the app-stall cell: `pg_sleep` of each query, in seconds. */
export const APP_STALL = 5;

/** These are the cells of T01 over pg-8.23 and postgresql: the defaults, then the borders of the law. */
export const T01_PG_SPECS: readonly PgSpec[] = [
  { plan: "T01.defaults.9", name: "rst at connect: the server refuses before the client starts", fault: "rst", mode: "inflight", before: true },
  { plan: "T01.defaults.122", name: "blackhole, idle: the pool ends its idle client before any detector", fault: "blackhole", mode: "idle" },
  { plan: "T01.defaults.123", name: "rst, a query in flight", fault: "rst", mode: "inflight" },
  { plan: "T01.defaults.124", name: "fin, idle", fault: "fin", mode: "idle" },
  {
    plan: "T01.defaults.125",
    name: "unreachable-host, a query in flight, tcp_retries2 = 3",
    fault: "unreachable",
    mode: "inflight",
    icmp: "host",
    linux: { tcp_retries2: count(3) },
  },
  { plan: "T01.defaults.126", name: "freeze-process, a query in flight", fault: "freeze-process", mode: "inflight" },
  { plan: "T01.defaults.127", name: "a 1 s stall, a query in flight", fault: "stall", mode: "inflight", stall: 1 },
  { plan: "T01.defaults.128", name: "event:idle, no fault: the pool ends its idle client at its idle timer", fault: "none", mode: "idle" },
  {
    plan: "T01.defaults.130",
    name: `app-stall: the server holds each reply ${APP_STALL} s, and nothing ends the query`,
    fault: "app-stall",
    mode: "inflight",
    query: `SELECT pg_sleep(${APP_STALL})`,
  },
  // ---- O07: the timer of a query against the statement deadline of the server
  ...([
    ["T01.border-off.171", 10.5, "inside"],
    ["T01.border-off.172", 9.5, "outside"],
  ] as const).map(([plan, at, side]): PgSpec => ({
    plan,
    name: `app-stall in flight, query_timeout ${at} s: ${side} O07 against a statement_timeout of ${STATEMENT_DEADLINE} s`,
    fault: "app-stall",
    mode: "inflight",
    inflight: SLOW_QUERY,
    server: { statement_timeout: STATEMENT_DEADLINE * 1000 },
    options: { query_timeout: at * 1000 },
  })),
  // ---- O13: the timer of a query against the slowest poll of a check
  ...([
    ["T01.border-off.179", 9.5, "inside"],
    ["T01.border-off.180", 10.5, "outside"],
  ] as const).map(([plan, at, side]): PgSpec => ({
    plan,
    name: `blackhole, a query in flight, query_timeout ${at} s: ${side} O13 against a poll of ${SLOWEST_POLL} s`,
    fault: "blackhole",
    mode: "inflight",
    options: { query_timeout: at * 1000 },
  })),
  // ---- O15: the timer of the connect against the startup budget of a pod
  ...([
    ["T01.border-off.191", 29, "inside"],
    ["T01.border-off.192", 31, "outside"],
  ] as const).map(([plan, at, side]): PgSpec => ({
    plan,
    name: `blackhole before the connect, connectionTimeoutMillis ${at} s: ${side} O15 against a startup budget of ${STARTUP_BUDGET} s`,
    fault: "blackhole",
    mode: "inflight",
    before: true,
    options: { connectionTimeoutMillis: at * 1000 },
  })),
];

/** This reason is the reason of the O03 cells of a pool client through a router. */
const POOLED =
  "on each side of the border the pool closes its idle client at its own timer: only the socket of the server shows that the router forgot the flow. The PG catalog has no cell with the server as its observer yet";
/** This reason is the reason of the O03 cells of a client that the application holds. */
const HELD = "the client of the harness gives its client back to the pool after each query: it has no mode for a client that the application holds";

/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T01_PG_WAITING: readonly Waiting[] = [
  { plan: "T01.defaults.129", trigger: "event:server-restart-same-ip", why: "the harness has no restart of a target with its address" },
  { plan: "T01.defaults.131", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  { plan: "T01.defaults.132", trigger: "in-process:event-loop", why: "no document gives the sequence of the timers of Node that are late after a block of its event loop" },
  { plan: "T01.defaults.133", trigger: "workload:write-write-read", why: "pg sets TCP_NODELAY before the connect (connection.js:40-52), thus Nagle holds no write: the pattern does not occur" },
  { plan: "T01.border-off.157", trigger: "border", why: POOLED },
  { plan: "T01.border-off.158", trigger: "border", why: POOLED },
  { plan: "T01.border-off.159", trigger: "border", why: HELD },
  { plan: "T01.border-off.160", trigger: "border", why: HELD },
];

/**
 * This function gives the values of the knobs of node-postgres: the defaults of 8.23.1, at a round
 * trip in ms. A knob at the value that turns its timer off has no bound (`infinite`).
 */
export const pgValues = (rttMs = RTT_MS, options: Readonly<Record<string, number>> = {}): Record<string, Extent> => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(NODE_POSTGRES.knobs)) {
    if (knob.unit === null) continue;
    // an option of the cell replaces the default, in the unit of the knob, as pg reads it
    const value = options[name] ?? knob.default;
    if (value === null) continue;
    out[name] = { value: knob.off !== undefined && value === knob.off ? "infinite" : value, unit: knob.unit };
  }
  const unknown = Object.keys(options).filter((name) => NODE_POSTGRES.knobs[name]?.unit == null);
  if (unknown.length > 0) throw new Error(`node-postgres has no knob with a unit for ${unknown.join(", ")}`);
  out["hz"] = { value: HZ, unit: "Hz" };
  out["rtt"] = { value: rttMs, unit: "ms" };
  return out;
};

/**
 * A first detection is the detector that fires first on the socket of the client. It is a timer of
 * the pool or of the kernel, or an event that the fault delivers. Its span counts from the
 * reference of the socket: its last received segment, or its first retransmission.
 */
export type First =
  | { readonly kind: "timer"; readonly timer: string; readonly layer: "driver" | "kernel"; readonly name: string; readonly band: Span }
  | { readonly kind: "delivered"; readonly event: string; readonly name: string }
  | { readonly kind: "silent"; readonly held: readonly string[] };

const finite = (d: Detector): boolean => !("unknown" in d.duration) && d.duration.value !== "infinite";

/** A client state is the state of the client of a cell at the fault. It is idle in the pool, a query in flight, or the first connect. */
export type ClientState = "pooled" | "querying" | "connecting";

/**
 * This function gives the first detection on the socket of the client. It composes the document of
 * node-postgres over Linux TCP. The timers of the pool see what the fault lets through. The timers
 * of the kernel use the keepalive that pg sets. The document maps each state of the client to a
 * state of the socket: `connecting` is SYN_SENT, and the others are ESTABLISHED.
 */
export const firstOn = (state: ClientState, manifestation: Manifestation, driver: KnobValues, linux: KnobValues): First => {
  const inFlight = state !== "pooled";
  const own = detection(NODE_POSTGRES, { state, inFlight }, { name: manifestation.name, passes: [] }, driver);
  const lower = overValues(NODE_POSTGRES, driver, linux);
  const socket = NODE_POSTGRES.over?.states[state];
  if (socket === undefined) throw new Error(`node-postgres maps no state of Linux TCP for ${state}`);
  const below = detection(LINUX_TCP, { state: socket, inFlight }, manifestation, lower);
  const [delivered] = below.delivered;
  if (delivered !== undefined) return { kind: "delivered", event: delivered.event, name: delivered.errno ?? "EOF" };
  const all = [
    ...own.detectors.filter(finite).map((d) => ({ d, layer: "driver" as const })),
    ...below.detectors.filter(finite).map((d) => ({ d, layer: "kernel" as const })),
  ].map((each) => {
    const bounds = each.layer === "driver" ? timerOf(NODE_POSTGRES, each.d.timer, driver) : timerUnder(LINUX_TCP, each.d.timer, lower, manifestation);
    const duration = seconds(bounds.duration, each.d.timer);
    return { ...each, band: span(duration - seconds(bounds.early, "early"), duration + seconds(bounds.lateness, "lateness")) };
  });
  all.sort((a, b) => a.band.lo - b.band.lo);
  const [winner, next] = all;
  if (winner === undefined) return { kind: "silent", held: [...own.held, ...below.held].map((h) => `${h.timer}: ${h.why}`) };
  if (next !== undefined && next.band.lo <= winner.band.hi) throw new Error(`${winner.d.timer} and ${next.d.timer} can both fire first`);
  const name =
    winner.layer === "driver"
      ? (transitionOn(NODE_POSTGRES, state, winner.d.fires)?.errno ?? winner.d.fires)
      : (errnoOf(LINUX_TCP, socket, winner.d, manifestation) ?? "ETIMEDOUT");
  return { kind: "timer", timer: winner.d.timer, layer: winner.layer, name, band: winner.band };
};

/** This range is the first round trip that each band of a reset or a FIN assumes: 0 to 2 ms on the direct pair. */
export const PG_RTT_MS = 2;

/**
 * This manifestation is no fault: each incoming event of Linux TCP gets through. A cell with no
 * fault reads it.
 */
const NO_FAULT: Manifestation = { name: "none", passes: Object.keys(LINUX_TCP.events).filter((event) => event.startsWith("rx.")) };

/** This function gives the manifestation of a fault to the kernel of the client. */
const manifestationOf = (spec: PgSpec): Manifestation => {
  if (spec.fault === "unreachable") return MANIFESTATIONS[`unreachable-${spec.icmp ?? "host"}` as keyof typeof MANIFESTATIONS];
  if (spec.fault === "freeze-process") return MANIFESTATIONS["freeze-process"];
  if (spec.fault === "fin") return MANIFESTATIONS.fin;
  if (spec.fault === "none") return NO_FAULT;
  return MANIFESTATIONS.blackhole;
};

/** These lines of the client must not occur in the window of a silent cell. They are a failure of the query and an error of the socket. */
const QUIET = [{ ev: "fail" }, { ev: "socket-error" }] as const;

/**
 * This function gives the prediction of a cell whose fault holds before the client starts. Its
 * first connect meets the fault, and the fail line of its first query ends the band. The band
 * counts from the first line of the client.
 */
const atConnect = (spec: PgSpec, driver: KnobValues, linux: KnobValues, slack: number): Prediction => {
  const fails = (name: "code" | "message") => ({ socket: "pool", ends: { ev: "fail", where: { n: 1 }, name } });
  // a reset of the SYN refuses the connect at once. Two steps of Node come after it: the error of
  // the socket, and the callback of the checkout
  if (spec.fault === "rst") {
    const errno = transitionOn(LINUX_TCP, "SYN_SENT", "rx.rst")?.errno ?? "ECONNREFUSED";
    return { detects: true, timer: "the reset of the connect", errno, from: "client-start", low: s(0), high: s(PG_RTT_MS / 1000 + 2 * slack), driver: fails("code") };
  }
  const first = firstOn("connecting", manifestationOf(spec), driver, linux);
  if (first.kind !== "timer") throw new Error(`${spec.plan}: no timer ends the first connect`);
  // a timer of the pool fails the query with its own message, and the kernel with the code of the socket
  return {
    detects: true,
    timer: first.timer,
    errno: first.name,
    from: "client-start",
    low: s(first.band.lo),
    high: s(first.band.hi),
    driver: fails(first.layer === "driver" ? "message" : "code"),
  };
};

/**
 * This function gives the prediction of a cell whose server holds the query in flight, with a
 * statement deadline (O07). The kernel of the server acknowledges the query, as for a frozen
 * process. The first of two timers ends the query: query_timeout of the pool, or the statement
 * timer of the server. The server then fails the query with ERROR 57014 and keeps the session.
 * Two steps of Node read the error: the callback of the query, and the release to the pool.
 */
const atDeadline = (spec: PgSpec, driver: KnobValues, linux: KnobValues, slack: number): Prediction => {
  const own = firstOn("querying", MANIFESTATIONS["freeze-process"], driver, linux);
  if (own.kind === "delivered") throw new Error(`${spec.plan}: ${own.event} ends the query in the hold`);
  const server = statementDeadline(spec.server!, PG_RTT_MS, 2 * slack);
  if (server === null) throw new Error(`${spec.plan}: the server has no statement deadline`);
  if (own.kind === "timer" && own.band.lo <= server.band.hi && server.band.lo <= own.band.hi)
    throw new Error(`${spec.plan}: ${own.timer} and statement_timeout can both end the query first`);
  // the server ends the query first: the fail line of the query gives the SQLSTATE of its error
  if (own.kind === "silent" || server.band.hi < own.band.lo) {
    const ends = { ev: "fail", where: { n: 2 }, name: "code" };
    return { detects: true, timer: "statement_timeout", errno: server.errno, from: "request-sent", low: s(server.band.lo), high: s(server.band.hi), driver: { socket: "pool", ends } };
  }
  // the timer of the pool fails the query first, as in a black hole (O13). The server goes on with the statement
  if (own.layer !== "driver") throw new Error(`${spec.plan}: the kernel ends the query first, with ${own.timer}`);
  const ends = { ev: "fail", where: { n: 2 }, name: "message" };
  return { detects: true, timer: own.timer, errno: own.name, from: "request-sent", low: s(own.band.lo), high: s(own.band.hi), driver: { socket: "pool", ends } };
};

/** This function gives the prediction of a cell for the harness. */
export const pgPrediction = (spec: PgSpec): Prediction => {
  // a stall is the stall of Linux TCP: the classic measurement of the socket of the client times it
  if (spec.fault === "stall")
    return predict({ name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall!, linux: spec.linux ?? {} });
  const rtt = { low: { value: 0, unit: "ms" }, high: { value: PG_RTT_MS, unit: "ms" } } as const;
  const driver = given(pgValues(RTT_MS, spec.options));
  const linux = given(linuxValues(spec.linux));
  const slack = seconds(timerOf(NODE_POSTGRES, "idle_timeout", driver).lateness, "the slack of Node");
  if (spec.before === true) return atConnect(spec, driver, linux, slack);
  // a reset answers the query at once
  if (spec.fault === "rst") {
    const errno = transitionOn(LINUX_TCP, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET";
    return { detects: true, timer: "the reset of the query", errno, from: "request-sent", low: s(0), high: s(PG_RTT_MS / 1000), rtt, driver: { socket: "pool" } };
  }
  // the server holds the query, and its statement deadline ends it: the first of two timers ends
  // the query, the timer of the pool or the statement timer of the server (O07)
  if (spec.fault === "app-stall" && spec.server !== undefined) return atDeadline(spec, driver, linux, slack);
  // the server holds the reply while its kernel acknowledges the query, as for a frozen process:
  // nothing ends the query at the defaults, and the reply comes after the hold
  if (spec.fault === "app-stall") {
    const held = firstOn("querying", MANIFESTATIONS["freeze-process"], driver, linux);
    if (held.kind !== "silent") throw new Error(`${spec.plan}: ${held.kind === "timer" ? held.timer : held.event} ends the query in the hold`);
    const reply = { from: "request-sent", ends: { ev: "ack", where: { n: 2 } } } as const;
    return {
      detects: false,
      window: s(6 * APP_STALL),
      replies: { low: s(APP_STALL), high: s(APP_STALL + PG_RTT_MS / 1000 + 2 * slack) },
      driver: { socket: "pool", reply, quiet: [...QUIET] },
    };
  }
  const first = firstOn(spec.mode === "inflight" ? "querying" : "pooled", manifestationOf(spec), driver, linux);
  if (first.kind === "delivered")
    return { detects: true, timer: `the server ends the connection: ${first.event}`, errno: first.name, from: "peer-closed", low: s(0), high: s(PG_RTT_MS / 1000 + slack), rtt, driver: { socket: "pool" } };
  if (first.kind === "silent") return { detects: false, window: s(60), driver: { socket: "pool", quiet: [...QUIET] } };
  const band = first.band;
  if (first.layer === "driver" && first.timer !== "idle_timeout") {
    // a timer of the pool fails the query into the fault: the fail line of that query ends the band.
    // The timer starts at client.query, thus the band counts from the send of the query
    const ends = { ev: "fail", where: { n: 2 }, name: "message" };
    return { detects: true, timer: first.timer, errno: first.name, from: "request-sent", low: s(band.lo), high: s(band.hi), driver: { socket: "pool", ends } };
  }
  if (first.layer === "driver") {
    // the pool ends its idle client: its own close. The kernel stamps the FIN that it sends, from
    // ESTABLISHED to FIN_WAIT1. The line `remove` of the pool does not mark it: the pool emits it
    // only when the socket closes, and behind a black hole the FIN gets no answer
    return { detects: true, timer: first.timer, errno: "CLOSED", from: "last-received", low: s(band.lo), high: s(band.hi) };
  }
  // the kernel gives up on the query: its retransmissions count from the first one
  const from = first.timer === "retrans_giveup" ? "first-retransmission" : "last-received";
  return { detects: true, timer: first.timer, errno: first.name, from, low: s(band.lo), high: s(band.hi), driver: { socket: "pool" } };
};

/** This function gives the name of a cell: its cell of the plan, its tuple of systems, and what it does. */
export const nameOf = (spec: PgSpec): string => `${spec.plan} pg-8.23 to postgresql, ${spec.name}`;

/** This function gives the harness cell of a spec. */
export const pgCell = (spec: PgSpec): Cell => ({
  name: nameOf(spec),
  target: spec.server === undefined ? PG_TARGET : pgTargetWith(PG_TARGET, spec.server),
  sysctls: sysctlsOf(linuxValues(spec.linux)),
  probe: {
    mode: spec.mode,
    keepalive: false,
    driver: { name: "pg", ...(spec.query === undefined ? {} : { query: spec.query }), ...(spec.inflight === undefined ? {} : { inflight: spec.inflight }) },
  },
  fault: spec.fault,
  prediction: pgPrediction(spec),
  ...(spec.before === true ? { before: true } : {}),
  ...(spec.options === undefined ? {} : { driverOptions: spec.options }),
  ...(spec.fault === "unreachable" ? { targetSysctls: { "net.ipv4.icmp_ratelimit": "0" } } : {}),
  ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
  ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
  runs: RUNS,
  // a killed server cannot serve the next run: each run of a fin has its own environment
  environments: spec.fault === "fin" ? RUNS : 2,
});

/** These are the PostgreSQL cells of T01 for the harness. */
export const T01_PG: readonly Cell[] = T01_PG_SPECS.map(pgCell);

/** This span is the idle timer of the pool at its defaults, in seconds: the band of an idle cell. */
export const POOL_IDLE: Span = spanOf(NODE_POSTGRES, "idle_timeout", given(pgValues()));
