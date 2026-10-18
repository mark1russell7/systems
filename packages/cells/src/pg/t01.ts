import type { Detector, KnobValues, Manifestation } from "@mark1russell7/algebra";
import { detection, errnoOf, overValues, timerOf, timerUnder, transitionOn } from "@mark1russell7/algebra";
import type { Cell, DriverBand, Prediction, Target } from "@mark1russell7/harness";
import { LINUX_TCP, NODE_POSTGRES } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { HZ, RTT_MS, RUNS, count, given, predict, s, seconds, sysctlsOf } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Span } from "../mongo/model.ts";
import { linuxValues, span, spanOf } from "../mongo/model.ts";

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
  readonly fault: "blackhole" | "rst" | "fin" | "unreachable" | "freeze-process" | "stall";
  readonly mode: "idle" | "inflight";
  readonly icmp?: "host" | "net" | "port" | "admin";
  /** This time is the length of a stall, in seconds. */
  readonly stall?: number;
  /** These are the sysctls of Linux TCP at the client that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
}

/** These are the cells of T01 over pg-8.23 and postgresql, at the defaults. */
export const T01_PG_SPECS: readonly PgSpec[] = [
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
];

/**
 * This function gives the values of the knobs of node-postgres: the defaults of 8.23.1, at a round
 * trip in ms. A knob at the value that turns its timer off has no bound (`infinite`).
 */
export const pgValues = (rttMs = RTT_MS): Record<string, Extent> => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(NODE_POSTGRES.knobs)) {
    if (knob.default === null || knob.unit === null) continue;
    out[name] = { value: knob.off !== undefined && knob.default === knob.off ? "infinite" : knob.default, unit: knob.unit };
  }
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

/**
 * This function gives the first detection on the socket of the client. It composes the document of
 * node-postgres over Linux TCP. The timers of the pool see what the fault lets through. The timers
 * of the kernel use the keepalive that pg sets. An idle client is `pooled`, and a client with a
 * query in flight is `querying`.
 */
export const firstOn = (inFlight: boolean, manifestation: Manifestation, driver: KnobValues, linux: KnobValues): First => {
  const state = inFlight ? "querying" : "pooled";
  const own = detection(NODE_POSTGRES, { state, inFlight }, { name: manifestation.name, passes: [] }, driver);
  const lower = overValues(NODE_POSTGRES, driver, linux);
  const below = detection(LINUX_TCP, { state: "ESTABLISHED", inFlight }, manifestation, lower);
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
      : (errnoOf(LINUX_TCP, "ESTABLISHED", winner.d, manifestation) ?? "ETIMEDOUT");
  return { kind: "timer", timer: winner.d.timer, layer: winner.layer, name, band: winner.band };
};

/** This range is the first round trip that each band of a reset or a FIN assumes: 0 to 2 ms on the direct pair. */
export const PG_RTT_MS = 2;

/** This function gives the manifestation of a fault to the kernel of the client. */
const manifestationOf = (spec: PgSpec): Manifestation => {
  if (spec.fault === "unreachable") return MANIFESTATIONS[`unreachable-${spec.icmp ?? "host"}` as keyof typeof MANIFESTATIONS];
  if (spec.fault === "freeze-process") return MANIFESTATIONS["freeze-process"];
  if (spec.fault === "fin") return MANIFESTATIONS.fin;
  return MANIFESTATIONS.blackhole;
};

/** These lines of the client must not occur in the window of a silent cell. They are a failure of the query and an error of the socket. */
const QUIET = [{ ev: "fail" }, { ev: "socket-error" }] as const;

/** This function gives the prediction of a cell for the harness. */
export const pgPrediction = (spec: PgSpec): Prediction => {
  // a stall is the stall of Linux TCP: the classic measurement of the socket of the client times it
  if (spec.fault === "stall")
    return predict({ name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall!, linux: spec.linux ?? {} });
  const rtt = { low: { value: 0, unit: "ms" }, high: { value: PG_RTT_MS, unit: "ms" } } as const;
  const driver = given(pgValues());
  const linux = given(linuxValues(spec.linux));
  const slack = seconds(timerOf(NODE_POSTGRES, "idle_timeout", driver).lateness, "the slack of Node");
  // a reset answers the query at once
  if (spec.fault === "rst") {
    const errno = transitionOn(LINUX_TCP, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET";
    return { detects: true, timer: "the reset of the query", errno, from: "request-sent", low: s(0), high: s(PG_RTT_MS / 1000), rtt, driver: { socket: "pool" } };
  }
  const first = firstOn(spec.mode === "inflight", manifestationOf(spec), driver, linux);
  if (first.kind === "delivered")
    return { detects: true, timer: `the server ends the connection: ${first.event}`, errno: first.name, from: "peer-closed", low: s(0), high: s(PG_RTT_MS / 1000 + slack), rtt, driver: { socket: "pool" } };
  if (first.kind === "silent") return { detects: false, window: s(60), driver: { socket: "pool", quiet: [...QUIET] } };
  const band = first.band;
  if (first.layer === "driver") {
    // the pool ends its idle client: its own close, which a line of the client marks
    const ends = { ev: "pool", where: { event: "remove" } };
    const own: DriverBand = { socket: "pool", ends, quiet: [...QUIET] };
    return { detects: true, timer: first.timer, errno: "CLOSED", from: "last-received", low: s(band.lo), high: s(band.hi), driver: own };
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
  target: PG_TARGET,
  sysctls: sysctlsOf(linuxValues(spec.linux)),
  probe: { mode: spec.mode, keepalive: false, driver: { name: "pg" } },
  fault: spec.fault,
  prediction: pgPrediction(spec),
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
