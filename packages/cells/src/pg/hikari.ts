import type { Detector, KnobValues, Manifestation } from "@mark1russell7/algebra";
import { detection, errnoOf, overValues, timerOf, timerUnder, transitionOn } from "@mark1russell7/algebra";
import type { Cell, Prediction } from "@mark1russell7/harness";
import { HIKARICP_PGJDBC, LINUX_TCP } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { HZ, RTT_MS, RUNS, count, given, predict, s, seconds, sysctlsOf } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Waiting } from "../mongo/cells.ts";
import type { Span } from "../mongo/model.ts";
import { linuxValues, span } from "../mongo/model.ts";
import { PG_RTT_MS, PG_TARGET } from "./t01.ts";

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
  readonly fault: "rst" | "fin" | "unreachable" | "freeze-process" | "stall" | "none" | "blackhole";
  readonly mode: "idle" | "inflight";
  readonly icmp?: "host" | "net" | "port" | "admin";
  /** This time is the length of a stall, in seconds. */
  readonly stall?: number;
  /** These are the sysctls of Linux TCP at the client that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** These are the knobs of the document that differ from the defaults, by its names and in its units. */
  readonly options?: Readonly<Record<string, number>>;
}

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
];

/** This reason is the reason of the cells that need a router between the client and the server. */
const ROUTER = "the cell needs a router between the client and the server, and the PG catalog has no chain yet";
/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T01_HIKARI_WAITING: readonly Waiting[] = [
  { plan: "T01.defaults.58", trigger: "event:server-restart-same-ip", why: "the harness has no restart of a target with its address" },
  { plan: "T01.defaults.59", trigger: "rst", why: "a reset at the first connect ends the start of the pool after the sleep of 1 s of its check, and the first use of the classes of the pool is in that band: no document gives its time" },
  { plan: "T01.defaults.60", trigger: "app-stall", why: "the client of the harness sends one text for each query, thus a slow query delays its first reply too, and the first connect of the JVM takes most of the 15 s that the harness waits for it" },
  { plan: "T01.defaults.61", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  { plan: "T01.defaults.62", trigger: "in-process:event-loop", why: "no document gives the delay of the threads of the JVM in a pause of the process" },
  { plan: "T01.defaults.63", trigger: "workload:write-write-read", why: "pgjdbc sets TCP_NODELAY on each socket (PGStream.java:299-302), thus Nagle holds no write: the pattern does not occur" },
  { plan: "T01.border-off.151", trigger: "border", why: ROUTER },
  { plan: "T01.border-off.152", trigger: "border", why: ROUTER },
  { plan: "T01.border-off.173", trigger: "border", why: "the client of the harness sends one text for each query: the cell needs a slow query only after the client is ready" },
  { plan: "T01.border-off.174", trigger: "border", why: "the client of the harness sends one text for each query: the cell needs a slow query only after the client is ready" },
  { plan: "T01.border-off.197", trigger: "border", why: "the next step of this catalog: the start of the pool against the startup budget of 30 s" },
  { plan: "T01.border-off.198", trigger: "border", why: "the next step of this catalog: the start of the pool against the startup budget of 30 s" },
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

/** A client state is the state of the connection of a cell at the fault: idle in the pool, a query in flight, or a check of the keepalive. */
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

/** This function gives the prediction of a cell for the harness. */
export const hikariPrediction = (spec: HikariSpec): Prediction => {
  // a stall is the stall of Linux TCP: the classic measurement of the socket of the client times it
  if (spec.fault === "stall")
    return predict({ name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall!, linux: spec.linux ?? {} });
  const rtt = { low: { value: 0, unit: "ms" }, high: { value: PG_RTT_MS, unit: "ms" } } as const;
  const driver = given(hikariValues(RTT_MS, spec.options));
  const linux = given(linuxValues(spec.linux));
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

/** This function gives the harness cell of a spec. */
export const hikariCell = (spec: HikariSpec): Cell => ({
  name: hikariNameOf(spec),
  target: PG_TARGET,
  sysctls: sysctlsOf(linuxValues(spec.linux)),
  probe: { mode: spec.mode, keepalive: false, driver: { name: "hikari" } },
  fault: spec.fault,
  prediction: hikariPrediction(spec),
  ...(spec.fault === "unreachable" ? { targetSysctls: { "net.ipv4.icmp_ratelimit": "0" } } : {}),
  ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
  ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
  ...(spec.options === undefined ? {} : { driverOptions: driverOptionsOf(spec.options) }),
  runs: RUNS,
  // a killed server cannot serve the next run: each run of a fin has its own environment
  environments: spec.fault === "fin" ? RUNS : 2,
});

/** These are the HikariCP cells of T01 for the harness. */
export const T01_HIKARI: readonly Cell[] = T01_HIKARI_SPECS.map(hikariCell);
