import type { Detector, KnobValues, Manifestation } from "@mark1russell7/algebra";
import { detection, errnoOf, overValues, timerOf, timerUnder, transitionOn } from "@mark1russell7/algebra";
import type { Cell, Prediction, RouterHop } from "@mark1russell7/harness";
import { HIKARICP_PGJDBC, LINUX_TCP, NF_CONNTRACK_TCP } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { HZ, RTT_MS, RUNS, count, given, predict, s, seconds, sysctlsOf } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Waiting } from "../mongo/cells.ts";
import type { Span } from "../mongo/model.ts";
import { linuxValues, plus, span, spanOf } from "../mongo/model.ts";
import { PRESETS } from "../mongo/t03.ts";
import { ackDelay, o03, router as routerHop, routerValues } from "../topologies.ts";
import type { Deadline } from "./server.ts";
import { SLOW_QUERY, STATEMENT_DEADLINE, pgTargetWith, statementDeadline } from "./server.ts";
import { APP_STALL, PG_RTT_MS, PG_TARGET } from "./t01.ts";

/**
 * The PostgreSQL catalog of T01 for HikariCP 7.1.0 over pgjdbc 42.7.13, against one server of
 * PostgreSQL 17.11 on the direct pair. The client is one `HikariDataSource` at its defaults: a pool
 * of a fixed size of 10. Each cell is named by the cell of the plan that it stands for
 * (`T01.defaults.2` and the next ones, for the tuple hikaricp-pgjdbc → postgresql).
 *
 * Each band comes from the machine documents `hikaricp-pgjdbc` and `linux-tcp`, as the algebra
 * composes them. At the defaults, pgjdbc sets no keepalive and no read timeout, thus only the
 * kernel ends a query in flight. HikariCP reads no idle socket: it finds a dead idle connection
 * only at its keepalive, at a phase from the creation of the connection.
 *
 * A borrow checks a connection that was idle for more than 500 ms (aliveBypassWindowMs). The
 * harness sends the second query 0.3 s after the reply to the first one: 307 to 406 ms in the run
 * 39105479743. Thus the borrow does not check the connection, and the second query is the segment
 * in flight.
 */

/** This text is the version of the client that each cell loads, as the image pins it. */
export const HIKARI_DRIVER = "HikariCP 7.1.0 over pgjdbc 42.7.13 on Temurin 21.0.12.1";

/** A spec is one cell of the catalog: its cell of the plan, its fault and the place of the client. It also gives the sysctls of the namespace. */
export interface HikariSpec {
  readonly plan: string;
  readonly name: string;
  readonly fault: "rst" | "fin" | "unreachable" | "freeze-process" | "stall" | "none" | "blackhole" | "app-stall" | "middlebox-forget" | "mtu-blackhole";
  readonly mode: "idle" | "inflight";
  readonly icmp?: "host" | "net" | "port" | "admin";
  /** This time is the length of a stall, in seconds. */
  readonly stall?: number;
  /** These are the sysctls of Linux TCP at the client that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** These are the knobs of the document that differ from the defaults, by its names and in its units. */
  readonly options?: Readonly<Record<string, number>>;
  /** This flag starts the client into a fault that holds already: the start of its pool meets it. */
  readonly before?: true;
  /** This text is the query in flight. Without it, the query in flight is `SELECT 1`, as each other query. */
  readonly inflight?: string;
  /** These are the settings of the server that differ from the defaults, by the names and in the units of `postgres-session`. */
  readonly server?: Readonly<Record<string, number>>;
  /** This router is between the client and the server: its form and its idle timeout, in whole seconds. */
  readonly router?: HikariRouter;
  /** This side is the side of the router that the rules face, for a fault at the router. */
  readonly toward?: "client" | "target";
  /** This size is the largest packet that an MTU black hole lets through, in bytes. */
  readonly mtu?: number;
  /** This time is the window of an idle flow through a router, in seconds. Without it, the window is two and a half idle timeouts. */
  readonly hold?: number;
}

/** A router of a cell is the form of the router of the harness and its idle timeout, in whole seconds. */
export interface HikariRouter {
  readonly form: RouterHop["form"];
  readonly idle: number;
  readonly preset: string;
}

/**
 * This factor divides the idle timeout of the router of the borders of O03, and the keepalive of the
 * pool. HikariCP turns a keepaliveTime below 30 s off (HikariConfig.java:1101-1152), thus the factor
 * is 4, and not the 20 of the MongoDB catalog. The 240 s of the Azure LB become 60 s.
 */
export const HIKARI_K = 4;

/** This router is the Azure LB at its default, with its idle timeout divided by HIKARI_K: a silent drop at 60 s. */
export const HIKARI_ROUTER: HikariRouter = { ...PRESETS.azureLb, idle: PRESETS.azureLb.idle / HIKARI_K, preset: `${PRESETS.azureLb.preset}, divided by ${HIKARI_K}` };

/** This value is the startup budget of a pod that R3 binds for the borders of O15: 30 s. */
export const HIKARI_STARTUP_BUDGET = 30;

/** This value is the slowest poll of a check that R3 binds for the borders of O13: 10 s. */
export const HIKARI_SLOWEST_POLL = 10;

/** These are the cells of T01 over hikaricp-pgjdbc and postgresql that this catalog starts, at the defaults. */
export const T01_HIKARI_SPECS: readonly HikariSpec[] = [
  { plan: "T01.defaults.2", name: "rst, a query in flight", fault: "rst", mode: "inflight" },
  { plan: "T01.defaults.52", name: "blackhole, idle: the keepalive of the pool checks the connection, and the read timeout closes it", fault: "blackhole", mode: "idle" },
  { plan: "T01.defaults.53", name: "fin, idle", fault: "fin", mode: "idle" },
  {
    plan: "T01.defaults.54",
    name: "unreachable-host, a query in flight, tcp_retries2 = 3",
    fault: "unreachable",
    mode: "inflight",
    icmp: "host",
    linux: { tcp_retries2: count(3) },
  },
  { plan: "T01.defaults.55", name: "freeze-process, a query in flight", fault: "freeze-process", mode: "inflight" },
  { plan: "T01.defaults.56", name: "a 1 s stall, a query in flight", fault: "stall", mode: "inflight", stall: 1 },
  { plan: "T01.defaults.57", name: "event:idle, no fault: the pool keeps its idle connection", fault: "none", mode: "idle" },
  { plan: "T01.defaults.59", name: "rst at the start: the server refuses the check of the pool", fault: "rst", mode: "inflight", before: true },
  {
    plan: "T01.defaults.60",
    name: `app-stall: the server holds the query in flight ${APP_STALL} s, and nothing ends it`,
    fault: "app-stall",
    mode: "inflight",
    inflight: `SELECT pg_sleep(${APP_STALL})`,
  },
  // ---- O03: the keepalive of the pool against a router that forgets an idle flow, each divided by HIKARI_K
  ...([
    ["T01.border-off.151", 55, "inside"],
    ["T01.border-off.152", 80, "outside"],
  ] as const).map(([plan, at, side]): HikariSpec => ({
    plan,
    name: `middlebox-forget, idle, keepaliveTime ${at} s: ${side} O03 against a ${HIKARI_ROUTER.form} router at ${HIKARI_ROUTER.idle} s`,
    fault: "middlebox-forget",
    mode: "idle",
    router: HIKARI_ROUTER,
    options: { keepaliveTime: at * 1000 },
  })),
  // ---- O13: the read timeout of pgjdbc against the slowest poll of a check
  ...([
    ["T01.border-off.187", 9, "inside"],
    ["T01.border-off.188", 11, "outside"],
  ] as const).map(([plan, at, side]): HikariSpec => ({
    plan,
    name: `blackhole, a query in flight, socketTimeout ${at} s: ${side} O13 against a poll of ${HIKARI_SLOWEST_POLL} s`,
    fault: "blackhole",
    mode: "inflight",
    options: { socketTimeout: at },
  })),
  // ---- O07: the read timeout of pgjdbc against the statement deadline of the server
  ...([
    ["T01.border-off.173", 11, "inside"],
    ["T01.border-off.174", 9, "outside"],
  ] as const).map(([plan, at, side]): HikariSpec => ({
    plan,
    name: `app-stall in flight, socketTimeout ${at} s: ${side} O07 against a statement_timeout of ${STATEMENT_DEADLINE} s`,
    fault: "app-stall",
    mode: "inflight",
    inflight: SLOW_QUERY,
    server: { statement_timeout: STATEMENT_DEADLINE * 1000 },
    options: { socketTimeout: at },
  })),
  // ---- O15: the start of the pool against the startup budget of a pod
  ...([
    ["T01.border-off.197", 28, "inside"],
    ["T01.border-off.198", 30, "outside"],
  ] as const).map(([plan, at, side]): HikariSpec => ({
    plan,
    name: `blackhole before the start, connectTimeout ${at} s: the start of the pool fails ${side} O15 against a budget of ${HIKARI_STARTUP_BUDGET} s`,
    fault: "blackhole",
    mode: "inflight",
    before: true,
    options: { connectTimeout: at },
  })),
];

/** This reason is the reason of the cells that need a router between the client and the server. */
/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T01_HIKARI_WAITING: readonly Waiting[] = [
  { plan: "T01.defaults.58", trigger: "event:server-restart-same-ip", why: "the harness has no restart of a target with its address" },
  { plan: "T01.defaults.61", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  { plan: "T01.defaults.62", trigger: "in-process:event-loop", why: "no document gives the delay of the threads of the JVM in a pause of the process" },
  { plan: "T01.defaults.63", trigger: "workload:write-write-read", why: "pgjdbc sets TCP_NODELAY on each socket (PGStream.java:299-302), thus Nagle holds no write: the pattern does not occur" },
  { plan: "T01.border-off.237", trigger: "border", why: "the cell needs a virtual IP that kube-vip moves, which the PG catalog does not have" },
  { plan: "T01.border-off.238", trigger: "border", why: "the cell needs a virtual IP that kube-vip moves, which the PG catalog does not have" },
];

/**
 * This function gives the values of the knobs of HikariCP and pgjdbc: their defaults, at a round
 * trip in ms. A knob at the value that turns its timer off has no bound (`infinite`).
 */
export const hikariValues = (rttMs = RTT_MS, options: Readonly<Record<string, number>> = {}): Record<string, Extent> => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(HIKARICP_PGJDBC.knobs)) {
    if (knob.unit === null) continue;
    // an option of the cell replaces the default, in the unit of the knob
    const value = options[name] ?? knob.default;
    if (value === null) continue;
    out[name] = { value: knob.off !== undefined && value === knob.off ? "infinite" : value, unit: knob.unit };
  }
  const unknown = Object.keys(options).filter((name) => HIKARICP_PGJDBC.knobs[name]?.unit == null);
  if (unknown.length > 0) throw new Error(`hikaricp-pgjdbc has no knob with a unit for ${unknown.join(", ")}`);
  out["hz"] = { value: HZ, unit: "Hz" };
  out["rtt"] = { value: rttMs, unit: "ms" };
  return out;
};

/** A client state is the state of the connection of a cell at the fault. It is idle in the pool, a query in flight, or a check of the keepalive. */
export type HikariState = "pooled" | "querying" | "probing";

/** A first detection is the detector that fires first on the socket of the connection, an event that the fault delivers, or none. */
export type HikariFirst =
  | { readonly kind: "timer"; readonly timer: string; readonly layer: "driver" | "kernel"; readonly name: string; readonly band: Span }
  | { readonly kind: "delivered"; readonly event: string; readonly name: string }
  | { readonly kind: "silent" };

const finite = (d: Detector): boolean => !("unknown" in d.duration) && d.duration.value !== "infinite";

/**
 * This function gives the first detection on the socket of the connection. It composes the
 * document of HikariCP over pgjdbc over Linux TCP, as the PG catalog of node-postgres does.
 */
export const hikariFirstOn = (state: HikariState, manifestation: Manifestation, driver: KnobValues, linux: KnobValues): HikariFirst => {
  const inFlight = state !== "pooled";
  const own = detection(HIKARICP_PGJDBC, { state, inFlight }, { name: manifestation.name, passes: [] }, driver);
  const lower = overValues(HIKARICP_PGJDBC, driver, linux);
  const socket = HIKARICP_PGJDBC.over?.states[state];
  if (socket === undefined) throw new Error(`hikaricp-pgjdbc maps no state of Linux TCP for ${state}`);
  const below = detection(LINUX_TCP, { state: socket, inFlight }, manifestation, lower);
  const [delivered] = below.delivered;
  if (delivered !== undefined) return { kind: "delivered", event: delivered.event, name: delivered.errno ?? "EOF" };
  const all = [
    ...own.detectors.filter(finite).map((d) => ({ d, layer: "driver" as const })),
    ...below.detectors.filter(finite).map((d) => ({ d, layer: "kernel" as const })),
  ].map((each) => {
    const bounds = each.layer === "driver" ? timerOf(HIKARICP_PGJDBC, each.d.timer, driver) : timerUnder(LINUX_TCP, each.d.timer, lower, manifestation);
    const duration = seconds(bounds.duration, each.d.timer);
    return { ...each, band: span(duration - seconds(bounds.early, "early"), duration + seconds(bounds.lateness, "lateness")) };
  });
  all.sort((a, b) => a.band.lo - b.band.lo);
  const [winner, next] = all;
  if (winner === undefined) return { kind: "silent" };
  if (next !== undefined && next.band.lo <= winner.band.hi) throw new Error(`${winner.d.timer} and ${next.d.timer} can both fire first`);
  const name =
    winner.layer === "driver"
      ? (transitionOn(HIKARICP_PGJDBC, state, winner.d.fires)?.errno ?? winner.d.fires)
      : (errnoOf(LINUX_TCP, socket, winner.d, manifestation) ?? "ETIMEDOUT");
  return { kind: "timer", timer: winner.d.timer, layer: winner.layer, name, band: winner.band };
};

/** This manifestation is no fault: each incoming event of Linux TCP gets through. */
const NO_FAULT: Manifestation = { name: "none", passes: Object.keys(LINUX_TCP.events).filter((event) => event.startsWith("rx.")) };

/** This function gives the manifestation of a fault to the kernel of the client. */
const manifestationOf = (spec: HikariSpec): Manifestation => {
  if (spec.fault === "unreachable") return MANIFESTATIONS[`unreachable-${spec.icmp ?? "host"}` as keyof typeof MANIFESTATIONS];
  if (spec.fault === "freeze-process") return MANIFESTATIONS["freeze-process"];
  if (spec.fault === "fin") return MANIFESTATIONS.fin;
  if (spec.fault === "none") return NO_FAULT;
  return MANIFESTATIONS.blackhole;
};

/** These lines of the client must not occur in the window of a silent cell: a failure of a query. */
const QUIET = [{ ev: "fail" }] as const;

/**
 * This function gives the prediction of a cell whose fault holds before the client starts. The
 * start of the pool makes one try, and after a failure it sleeps 1 s (start_check). At the
 * default initializationFailTimeout of 1 ms, the start then fails, and the constructor of the pool
 * throws. The fail line of the first query ends the band, with the SQLState of the try. The
 * band counts from the connecting line of the client, which comes after the warm-up of its classes.
 */
const atStart = (spec: HikariSpec, driver: KnobValues): Prediction => {
  const fails = { socket: "pool", ends: { ev: "fail", where: { n: 1 }, name: "sqlState" } };
  const check = timerOf(HIKARICP_PGJDBC, "start_check", driver);
  const sleep = span(seconds(check.duration, "the start check"), seconds(check.duration, "the start check") + seconds(check.lateness, "its lateness"));
  const failed = transitionOn(HIKARICP_PGJDBC, "connecting", "peer.rst")?.errno ?? "08001";
  // a reset of the SYN refuses the try at once
  if (spec.fault === "rst")
    return { detects: true, timer: "start_check", errno: failed, from: "client-start", low: s(sleep.lo), high: s(sleep.hi + PG_RTT_MS / 1000), driver: fails };
  // a black hole: the connect timeout of pgjdbc ends the try. At sslmode prefer, one more
  // connect with SSL off gets the 1 ms left of the budget, and it waits in poll() for that 1 ms
  // (ConnectionFactoryImpl.java:195-208, :378-382)
  const connect = timerOf(HIKARICP_PGJDBC, "connect_timeout", driver);
  const wait = span(seconds(connect.duration, "the connect timeout"), seconds(connect.duration, "the connect timeout") + seconds(connect.lateness, "its lateness"));
  const retry = span(0.001, 0.001 + seconds(check.lateness, "the slack of the JVM"));
  return {
    detects: true,
    timer: "connect_timeout",
    errno: failed,
    from: "client-start",
    low: s(wait.lo + retry.lo + sleep.lo),
    high: s(wait.hi + retry.hi + sleep.hi),
    driver: fails,
  };
};

/**
 * This function gives the prediction of a cell whose server holds the query in flight. The kernel
 * of the server acknowledges the query, as for a frozen process. At the defaults nothing ends the
 * query, and its reply comes after the hold. With a statement deadline (O07), the first of two
 * timers ends the query: the read timeout of pgjdbc, or the statement timer of the server. The
 * server then fails the query with ERROR 57014 and keeps the session.
 */
const atHold = (spec: HikariSpec, driver: KnobValues, linux: KnobValues): Prediction => {
  const own = hikariFirstOn("querying", MANIFESTATIONS["freeze-process"], driver, linux);
  if (own.kind === "delivered") throw new Error(`${spec.plan}: ${own.event} ends the query in the hold`);
  // one step of the JVM reads the reply or the error of the server
  const slack = seconds(timerOf(HIKARICP_PGJDBC, "start_check", driver).lateness, "the slack of the JVM");
  const server: Deadline | null = spec.server === undefined ? null : statementDeadline(spec.server, PG_RTT_MS, slack);
  if (server === null) {
    if (own.kind !== "silent") throw new Error(`${spec.plan}: ${own.timer} ends the query in the hold`);
    const reply = { from: "request-sent", ends: { ev: "ack", where: { n: 2 } } } as const;
    return {
      detects: false,
      window: s(6 * APP_STALL),
      replies: { low: s(APP_STALL), high: s(APP_STALL + PG_RTT_MS / 1000 + slack) },
      driver: { socket: "pool", reply, quiet: [...QUIET] },
    };
  }
  if (own.kind === "timer" && own.band.lo <= server.band.hi && server.band.lo <= own.band.hi)
    throw new Error(`${spec.plan}: ${own.timer} and statement_timeout can both end the query first`);
  // the server ends the query first: the fail line of the query gives the SQLState of its error
  if (own.kind === "silent" || server.band.hi < own.band.lo) {
    const ends = { ev: "fail", where: { n: 2 }, name: "sqlState" };
    return { detects: true, timer: "statement_timeout", errno: server.errno, from: "request-sent", low: s(server.band.lo), high: s(server.band.hi), driver: { socket: "pool", ends } };
  }
  // the read timeout closes the socket first, as in a black hole (O13). The server goes on with the statement
  if (own.layer !== "driver" || own.timer !== "socket_timeout") throw new Error(`${spec.plan}: ${own.timer} ends the query first, which this catalog does not measure yet`);
  return { detects: true, timer: own.timer, errno: "CLOSED", from: "request-sent", low: s(own.band.lo), high: s(own.band.hi) };
};

/**
 * This function gives the prediction of an idle connection through a router that forgets an idle
 * flow. O03 decides it: the keepalive of the pool against the idle timeout of conntrack. When O03
 * holds, the keepalive refreshes the flow, and nothing occurs in the window. When O03 fails, the
 * router forgets the flow before the first keepalive. A silent drop then takes the empty query of
 * the check, as a black hole does. The read timeout of the check closes the socket.
 */
const atForget = (spec: HikariSpec, driver: KnobValues, linux: KnobValues): Prediction => {
  const router = spec.router;
  if (router === undefined) throw new Error(`${spec.plan}: a forgotten flow needs a router`);
  const conntrack = routerValues(router.idle);
  const verdict = o03({ doc: HIKARICP_PGJDBC, values: driver }, conntrack, PG_RTT_MS / 1000);
  // the window holds two and a half idle timeouts of the router, or the hold of the cell
  if (verdict.holds) return { detects: false, window: s(spec.hold ?? 2.5 * router.idle), driver: { socket: "pool", quiet: [...QUIET] } };
  if (router.form !== "silent-drop") throw new Error(`${spec.plan}: this catalog measures a forgotten flow only at a silent drop, not at ${router.form}`);
  // the delayed ACK of the reply is the last segment of the flow: the idle time counts from it.
  // The keepalive counts from the creation of the connection, which comes before that reply
  const forget = plus(ackDelay(RTT_MS), spanOf(NF_CONNTRACK_TCP, "expire_established", conntrack));
  const keepalive = timerOf(HIKARICP_PGJDBC, "keepalive", driver);
  const earliest = seconds(keepalive.duration, "the keepalive") - seconds(keepalive.early, "its variance");
  if (!(earliest > forget.hi)) throw new Error(`${spec.plan}: the first keepalive can come before the router forgets the flow`);
  const check = hikariFirstOn("probing", MANIFESTATIONS.blackhole, driver, linux);
  if (check.kind !== "timer" || check.layer !== "driver") throw new Error(`${spec.plan}: no timer of the pool ends the check of the keepalive`);
  const latest = seconds(keepalive.duration, "the keepalive") + seconds(keepalive.lateness, "its lateness");
  return { detects: true, timer: check.timer, errno: "CLOSED", from: "first-sent", low: s(check.band.lo), high: s(check.band.hi), startsBy: s(latest) };
};

/** This function gives the prediction of a cell for the harness. */
export const hikariPrediction = (spec: HikariSpec): Prediction => {
  // a stall is the stall of Linux TCP: the classic measurement of the socket of the client times it
  if (spec.fault === "stall")
    return predict({ name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall!, linux: spec.linux ?? {} });
  const rtt = { low: { value: 0, unit: "ms" }, high: { value: PG_RTT_MS, unit: "ms" } } as const;
  const driver = given(hikariValues(RTT_MS, spec.options));
  const linux = given(linuxValues(spec.linux));
  if (spec.before === true) return atStart(spec, driver);
  if (spec.fault === "app-stall") return atHold(spec, driver, linux);
  // an idle flow through a router, with no fault: O03 decides whether the router forgets it
  if (spec.fault === "middlebox-forget" || (spec.fault === "none" && spec.router !== undefined && spec.mode === "idle")) return atForget(spec, driver, linux);
  // an MTU black hole at the router takes each long segment of the reply, and the short ones pass:
  // for the query, the server holds its reply, as a frozen process does. Nothing ends the query
  if (spec.fault === "mtu-blackhole") {
    const held = hikariFirstOn("querying", MANIFESTATIONS["freeze-process"], driver, linux);
    if (held.kind !== "silent") throw new Error(`${spec.plan}: a detector ends a read that the MTU stops`);
    return { detects: false, window: s(60), driver: { socket: "pool", quiet: [...QUIET] } };
  }
  // a reset answers the query at once: the kernel reports it on the socket of the connection
  if (spec.fault === "rst") {
    const errno = transitionOn(LINUX_TCP, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET";
    return { detects: true, timer: "the reset of the query", errno, from: "request-sent", low: s(0), high: s(PG_RTT_MS / 1000), rtt, driver: { socket: "pool" } };
  }
  // behind a black hole, the keepalive of the pool is the only check of an idle connection. It
  // comes at a phase from the creation of the connection: at most one delay after the reply, which
  // the run waits for (startsBy). Its empty query is the first segment that the socket sends after
  // the fault, and the read timeout of the check counts from it. pgjdbc then closes the socket:
  // the kernel stamps the change from ESTABLISHED to FIN_WAIT1
  if (spec.fault === "blackhole" && spec.mode === "idle") {
    const check = hikariFirstOn("probing", manifestationOf(spec), driver, linux);
    if (check.kind !== "timer" || check.layer !== "driver") throw new Error(`${spec.plan}: no timer of the pool ends the check of the keepalive`);
    const keepalive = timerOf(HIKARICP_PGJDBC, "keepalive", driver);
    const latest = seconds(keepalive.duration, "the keepalive") + seconds(keepalive.lateness, "its lateness");
    return { detects: true, timer: check.timer, errno: "CLOSED", from: "first-sent", low: s(check.band.lo), high: s(check.band.hi), startsBy: s(latest) };
  }
  const first = hikariFirstOn(spec.mode === "inflight" ? "querying" : "pooled", manifestationOf(spec), driver, linux);
  // the FIN of a killed server: the kernel moves the socket to CLOSE_WAIT at once, as pgjdbc reads nothing
  if (first.kind === "delivered")
    return { detects: true, timer: `the server ends the connection: ${first.event}`, errno: first.name, from: "peer-closed", low: s(0), high: s(PG_RTT_MS / 1000), rtt, driver: { socket: "pool" } };
  if (first.kind === "silent") return { detects: false, window: s(60), driver: { socket: "pool", quiet: [...QUIET] } };
  if (first.layer === "driver") {
    // a read timeout of pgjdbc closes the socket at once (abort), and then fails the query with
    // 08006. The kernel stamps the close, from ESTABLISHED to FIN_WAIT1. The fail line comes 2 to 9
    // ms after the band: a new JVM builds the exception of pgjdbc and loads its messages, and
    // HikariCP evicts the connection (run 39108284771). The read starts at the send of the query
    if (first.timer !== "socket_timeout") throw new Error(`${spec.plan}: a timer of the pool, ${first.timer}, fires first, which this catalog does not measure yet`);
    return { detects: true, timer: first.timer, errno: "CLOSED", from: "request-sent", low: s(first.band.lo), high: s(first.band.hi) };
  }
  // the kernel gives up on the query: its retransmissions count from the first one
  const from = first.timer === "retrans_giveup" ? "first-retransmission" : "last-received";
  return { detects: true, timer: first.timer, errno: first.name, from, low: s(first.band.lo), high: s(first.band.hi), driver: { socket: "pool" } };
};

/** This function gives the name of a cell: its cell of the plan, its tuple of systems, and what it does. */
export const hikariNameOf = (spec: HikariSpec): string => `${spec.plan} hikaricp-pgjdbc to postgresql, ${spec.name}`;

/**
 * This function gives the options of the client of a cell. A knob of pgjdbc goes to its data
 * source (`dataSource.`). A knob of HikariCP goes to HikariConfig.
 */
const driverOptionsOf = (options: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(Object.entries(options).map(([name, value]) => [HIKARICP_PGJDBC.knobs[name]!.key.startsWith("pgjdbc ") ? `dataSource.${name}` : name, value]));

/**
 * This function gives the topology of a cell with a router: one hop, named for the tier of the
 * cell. The router sends the ICMP errors of an unreachable host at the router, at no rate limit.
 */
const topologyOf = (spec: HikariSpec): Pick<Cell, "topology"> => {
  if (spec.router === undefined) return {};
  const hop = routerHop(spec.router.form, spec.router.idle);
  const icmp = spec.fault === "unreachable" && spec.toward !== undefined;
  return { topology: { name: spec.plan.split(".")[0]!, hops: [icmp ? { ...hop, sysctls: { "net.ipv4.icmp_ratelimit": "0" } } : hop] } };
};

/** This function gives the harness cell of a spec. */
export const hikariCell = (spec: HikariSpec): Cell => ({
  name: hikariNameOf(spec),
  target: spec.server === undefined ? PG_TARGET : pgTargetWith(PG_TARGET, spec.server),
  sysctls: sysctlsOf(linuxValues(spec.linux)),
  probe: { mode: spec.mode, keepalive: false, driver: { name: "hikari", ...(spec.inflight === undefined ? {} : { inflight: spec.inflight }) } },
  fault: spec.fault,
  prediction: hikariPrediction(spec),
  ...(spec.fault === "unreachable" && spec.toward === undefined ? { targetSysctls: { "net.ipv4.icmp_ratelimit": "0" } } : {}),
  ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
  ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
  ...(spec.options === undefined ? {} : { driverOptions: driverOptionsOf(spec.options) }),
  ...(spec.before === true ? { before: true } : {}),
  ...topologyOf(spec),
  ...(spec.router !== undefined && spec.toward !== undefined ? { faultAt: { hop: "nat", toward: spec.toward } } : {}),
  ...(spec.mtu === undefined ? {} : { mtu: spec.mtu }),
  runs: RUNS,
  // a killed server cannot serve the next run: each run of a fin has its own environment
  environments: spec.fault === "fin" ? RUNS : 2,
});

/** These are the HikariCP cells of T01 for the harness. */
export const T01_HIKARI: readonly Cell[] = T01_HIKARI_SPECS.map(hikariCell);
