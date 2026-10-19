import type { Detector, KnobValues, Manifestation } from "@mark1russell7/algebra";
import { detection, errnoOf, overValues, timerOf, timerUnder, transitionOn } from "@mark1russell7/algebra";
import type { Cell, Prediction, RouterHop, Target } from "@mark1russell7/harness";
import { AMQPLIB, LINUX_TCP, RABBITMQ_CONNECTION } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import type { Spec } from "../catalog.ts";
import { HZ, RTT_MS, RUNS, count, given, predict, predictAt, s, seconds, sysctlsOf } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import type { Span } from "../mongo/model.ts";
import { linuxValues, span } from "../mongo/model.ts";
import { PRESETS } from "../mongo/t03.ts";
import { conntrackValues, o03, router as routerHop } from "../topologies.ts";

/**
 * The RabbitMQ catalog of T01: amqplib 2.2.0 on Node 24.21.0 against one broker of RabbitMQ 4.3.6, on
 * the direct pair. The client opens one connection and one channel at the defaults of amqplib. Each
 * operation is an RPC of the channel: a passive declare of one queue, which the broker answers at once.
 * Each cell is named by the cell of the plan that it stands for (`T01.defaults.134` and the next ones,
 * for the tuple amqplib-2.2 → rabbitmq-4.3).
 *
 * Each band comes from the documents `amqplib`, `rabbitmq-connection` and `linux-tcp`. At the defaults
 * the client takes the heartbeat of the broker, 60 s. It ends a connection 2 to 3 heartbeats after the
 * last bytes of the broker. The broker sends a heartbeat frame each 30 s on an idle connection. The
 * client has no timer on an RPC. Thus a silent fault ends at the heartbeat, long before the kernel gives up.
 */

/** This image is RabbitMQ 4.3.6, pinned by the digest of its index (2026-10-17). */
export const RABBIT_IMAGE = "rabbitmq:4.3.6@sha256:3e5cc23235b0eb850f604e8ace10d9a9b6d05be3e36730e53522ee9ead707a9e";

/**
 * This target is one broker of RabbitMQ 4.3.6. At the defaults the user guest connects only from
 * localhost (loopback_users), thus a file of conf.d lets it connect from the client. The broker starts as
 * the child of a shell, and a fin stops the BEAM (beam.smp) with SIGKILL.
 */
export const RABBIT_TARGET: Target = {
  image: RABBIT_IMAGE,
  port: 5672,
  ready: "Server startup complete",
  program: "beam.smp",
  command: ["sh", "-c", "echo loopback_users.guest = false > /etc/rabbitmq/conf.d/90-harness.conf; docker-entrypoint.sh rabbitmq-server & echo $! > /tmp/server.pid; while :; do sleep 3600; done"],
  kill: ["sh", "-c", 'for p in /proc/[0-9]*; do [ "$(cat "$p/comm" 2>/dev/null)" = beam.smp ] && kill -KILL "${p#/proc/}"; done; true'],
};

/** This text is the version of the client that each cell loads, as the lockfile of its image pins it. */
export const AMQP_DRIVER = "amqplib 2.2.0 on Node 24.21.0";

/** This range is the first round trip that each band of a reset assumes: 0 to 2 ms on the direct pair. */
export const RABBIT_RTT_MS = 2;

/** This time is the most that the broker takes to answer an RPC that reaches it: one round trip, and one step of the BEAM. */
export const RABBIT_LATENCY: number = RABBIT_RTT_MS / 1000 + (RABBITMQ_CONNECTION.knobs["slack"]?.default ?? 0);

/** A spec is one cell of the catalog: its cell of the plan, its fault and the mode of the client. It also gives the sysctls of the namespace. */
export interface AmqpSpec {
  readonly plan: string;
  readonly name: string;
  readonly fault: "blackhole" | "rst" | "fin" | "unreachable" | "freeze-process" | "stall" | "none" | "middlebox-forget";
  readonly mode: "idle" | "inflight";
  readonly icmp?: "host" | "net" | "port" | "admin";
  /** This time is the length of a stall, in seconds. */
  readonly stall?: number;
  /** These are the sysctls of Linux TCP at the client that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** This flag starts the client into a fault that holds already: its connect meets it. */
  readonly before?: true;
  /** These are the options of amqplib that differ from the defaults, by the names and in the units of the document. */
  readonly options?: Readonly<Record<string, number>>;
  /** This time is the window of a cell with no fault, in seconds. */
  readonly hold?: number;
  /** This router is between the client and the broker: its form and its idle timeout, in whole seconds. */
  readonly router?: { readonly form: RouterHop["form"]; readonly idle: number; readonly preset: string };
}

/** This factor divides the idle timeout of the router of the borders of O03, and the heartbeat goes with it: 240 s is 30 s. */
export const RABBIT_K = 8;

/** This router is the Azure LB at its default, with its idle timeout divided by RABBIT_K: a silent drop at 30 s. */
export const RABBIT_ROUTER = { ...PRESETS.azureLb, idle: PRESETS.azureLb.idle / RABBIT_K, preset: `${PRESETS.azureLb.preset}, divided by ${RABBIT_K}` };

/** This function gives the values of the knobs of amqplib for a cell: the defaults of the document, and the options of the cell. */
export const amqpValues = (options: Readonly<Record<string, number>> = {}): Record<string, Extent> => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(AMQPLIB.knobs)) {
    if (knob.unit === null) continue;
    const value = options[name] ?? knob.default;
    if (value === null) continue;
    out[name] = { value: knob.off !== undefined && value === knob.off ? "infinite" : value, unit: knob.unit };
  }
  const unknown = Object.keys(options).filter((name) => AMQPLIB.knobs[name]?.unit == null);
  if (unknown.length > 0) throw new Error(`amqplib has no knob with a unit for ${unknown.join(", ")}`);
  out["hz"] = { value: HZ, unit: "Hz" };
  out["rtt"] = { value: RTT_MS, unit: "ms" };
  return out;
};

/** A state of the client at the fault: an idle connection, or an RPC in flight. */
type AmqpState = "idle" | "waiting";

/** A first detection is the detector that fires first on the socket of the client, or an event that the fault delivers. */
type First =
  | { readonly kind: "timer"; readonly timer: string; readonly layer: "driver" | "kernel"; readonly name: string; readonly band: Span }
  | { readonly kind: "delivered"; readonly event: string; readonly name: string }
  | { readonly kind: "silent" };

const finite = (d: Detector): boolean => !("unknown" in d.duration) && d.duration.value !== "infinite";

/**
 * This function gives the first detection on the socket of the client. It composes the document of
 * amqplib over Linux TCP. The heartbeat of amqplib sees what the fault lets through, and the kernel
 * uses the knobs of the namespace: amqplib sets no keepalive.
 */
const firstOn = (state: AmqpState, manifestation: Manifestation, driver: KnobValues, linux: KnobValues): First => {
  const inFlight = state === "waiting";
  const own = detection(AMQPLIB, { state, inFlight }, { name: manifestation.name, passes: [] }, driver);
  const lower = overValues(AMQPLIB, driver, linux);
  const socket = AMQPLIB.over?.states[state];
  if (socket === undefined) throw new Error(`amqplib maps no state of Linux TCP for ${state}`);
  const below = detection(LINUX_TCP, { state: socket, inFlight }, manifestation, lower);
  const [delivered] = below.delivered;
  if (delivered !== undefined) return { kind: "delivered", event: delivered.event, name: delivered.errno ?? "EOF" };
  const all = [
    ...own.detectors.filter(finite).map((d) => ({ d, layer: "driver" as const })),
    ...below.detectors.filter(finite).map((d) => ({ d, layer: "kernel" as const })),
  ].map((each) => {
    const bounds = each.layer === "driver" ? timerOf(AMQPLIB, each.d.timer, driver) : timerUnder(LINUX_TCP, each.d.timer, lower, manifestation);
    const duration = seconds(bounds.duration, each.d.timer);
    return { ...each, band: span(duration - seconds(bounds.early, "early"), duration + seconds(bounds.lateness, "lateness")) };
  });
  all.sort((a, b) => a.band.lo - b.band.lo);
  const [winner, next] = all;
  if (winner === undefined) return { kind: "silent" };
  if (next !== undefined && next.band.lo <= winner.band.hi) throw new Error(`${winner.d.timer} and ${next.d.timer} can both fire first`);
  const name =
    winner.layer === "driver" ? (transitionOn(AMQPLIB, state, winner.d.fires)?.errno ?? winner.d.fires) : (errnoOf(LINUX_TCP, socket, winner.d, manifestation) ?? "ETIMEDOUT");
  return { kind: "timer", timer: winner.d.timer, layer: winner.layer, name, band: winner.band };
};

/**
 * This manifestation is the stop of the broker with SIGKILL. Each socket of its listener has linger 0
 * (rabbitmq-connection), thus the kernel closes it with a reset, not a FIN.
 */
const KILLED: Manifestation = { name: "fin", passes: [], delivers: ["rx.rst"] };

/** This function gives the manifestation of a fault to the kernel of the client. */
const manifestationOf = (spec: AmqpSpec): Manifestation => {
  if (spec.fault === "unreachable") return MANIFESTATIONS[`unreachable-${spec.icmp ?? "host"}` as keyof typeof MANIFESTATIONS];
  if (spec.fault === "freeze-process") return MANIFESTATIONS["freeze-process"];
  if (spec.fault === "fin") return KILLED;
  return MANIFESTATIONS.blackhole;
};

/** These lines of the client must not occur in the window of a silent cell: a failed operation, or an error of the socket. */
const QUIET = [{ ev: "fail" }, { ev: "socket-error" }] as const;

/**
 * This function checks that the broker keeps an idle connection alive for amqplib. Its heartbeat frame
 * comes before the heartbeat of amqplib can end the connection.
 */
const brokerKeeps = (plan: string, driver: KnobValues): void => {
  // the broker uses the heartbeat of the tune-ok of the client
  const heartbeat = seconds(driver("heartbeat"), "the heartbeat");
  const broker = timerOf(RABBITMQ_CONNECTION, "beat", given({ heartbeat: { value: heartbeat, unit: "s" }, slack: { value: 0.01, unit: "s" } }));
  const latest = seconds(broker.duration, "the beat of the broker") + seconds(broker.lateness, "its lateness");
  const ends = seconds(timerOf(AMQPLIB, "heartbeat", driver).duration, "the heartbeat of amqplib");
  if (!(latest < ends)) throw new Error(`${plan}: the broker can be silent for ${latest} s, and amqplib ends the connection at ${ends} s`);
};

/** This function gives the prediction of a cell of the catalog. */
export const amqpPrediction = (spec: AmqpSpec): Prediction => {
  if (spec.fault === "stall") {
    const stall: Spec = { name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall!, linux: spec.linux ?? {} };
    const stalled = predict(stall);
    if (stalled.detects !== false || stalled.recovers === undefined) return stalled;
    // the first segment back can be the reply of the broker to the RPC that got through: a socket in
    // pingpong mode delays its ACK (tcp_in_quickack_mode, Linux). The reply comes one step of the BEAM later.
    // The RTO counts from the smoothed round trip, and each sample of the client is the time to the reply
    // of the broker, which ACKs the RPC (tcp_ack_update_rtt, Linux). Thus the latest return is the one at
    // a round trip of RABBIT_LATENCY: each firing is later, and the reply comes RABBIT_LATENCY after it
    const slowest = predictAt(stall, RABBIT_LATENCY * 1000);
    if (slowest.detects !== false || slowest.recovers?.firing !== stalled.recovers.firing)
      throw new Error(`${spec.plan}: at a round trip of ${RABBIT_LATENCY * 1000} ms, another firing of the RTO returns the reply`);
    return { ...stalled, recovers: { ...stalled.recovers, high: slowest.recovers.high } };
  }
  const rtt = { low: { value: 0, unit: "ms" }, high: { value: RABBIT_RTT_MS, unit: "ms" } } as const;
  const driver = given(amqpValues(spec.options));
  const linux = given(linuxValues(spec.linux));
  const slack = seconds(timerOf(AMQPLIB, "connect_timeout", driver).lateness, "the slack of Node");
  // a reset of the SYN refuses the connect at once: the fail line of operation 1 gives the code of the socket
  if (spec.before === true) {
    if (spec.fault !== "rst") throw new Error(`${spec.plan}: this catalog starts a client into a reset only`);
    const ends = { ev: "fail", where: { n: 1 }, name: "code" } as const;
    return { detects: true, timer: "the reset of the connect", errno: "ECONNREFUSED", from: "client-start", low: s(0), high: s(RABBIT_RTT_MS / 1000 + 2 * slack), driver: { socket: "connection", ends } };
  }
  // a reset answers the operation at once: the kernel reports it on the socket of the connection
  if (spec.fault === "rst") {
    const errno = transitionOn(LINUX_TCP, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET";
    return { detects: true, timer: "the reset of the operation", errno, from: "request-sent", low: s(0), high: s(RABBIT_RTT_MS / 1000), rtt, driver: { socket: "connection" } };
  }
  // an idle flow through a router: O03 decides whether the frames of the broker refresh it before the
  // router forgets it. A forgotten flow drops each frame in silence, and the heartbeat of amqplib ends it
  if (spec.fault === "middlebox-forget") {
    const router = spec.router;
    if (router === undefined) throw new Error(`${spec.plan}: a forgotten flow needs a router`);
    const heartbeat = seconds(driver("heartbeat"), "the heartbeat");
    const broker = { doc: RABBITMQ_CONNECTION, values: given({ heartbeat: s(heartbeat), slack: s(RABBITMQ_CONNECTION.knobs["slack"]?.default ?? 0) }) };
    const verdict = o03(broker, conntrackValues(router.idle), RABBIT_RTT_MS / 1000);
    // the window holds three heartbeats: the latest end that the heartbeat of amqplib can give
    if (verdict.holds) return { detects: false, window: s(spec.hold ?? 3 * heartbeat + 30), driver: { socket: "connection", quiet: [...QUIET] } };
    if (router.form !== "silent-drop") throw new Error(`${spec.plan}: this catalog measures a forgotten flow only at a silent drop, not at ${router.form}`);
    const first = firstOn("idle", MANIFESTATIONS.blackhole, driver, linux);
    if (first.kind !== "timer" || first.layer !== "driver" || first.timer !== "heartbeat") throw new Error(`${spec.plan}: the heartbeat of amqplib does not end the forgotten flow first`);
    return { detects: true, timer: first.timer, errno: "CLOSED", from: "last-data", low: s(first.band.lo), high: s(first.band.hi) };
  }
  // no fault: the heartbeat frames of the broker keep the connection, and nothing ends it in the window
  if (spec.fault === "none") {
    brokerKeeps(spec.plan, driver);
    return { detects: false, window: s(spec.hold ?? 300), driver: { socket: "connection", quiet: [...QUIET] } };
  }
  const first = firstOn(spec.mode === "inflight" ? "waiting" : "idle", manifestationOf(spec), driver, linux);
  // the kill of the broker: its kernel resets the socket at once (linger 0)
  if (first.kind === "delivered")
    return { detects: true, timer: `the broker ends the connection: ${first.event}`, errno: first.name, from: "peer-closed", low: s(0), high: s(RABBIT_RTT_MS / 1000 + slack), rtt, driver: { socket: "connection" } };
  if (first.kind === "silent") return { detects: false, window: s(60), driver: { socket: "connection", quiet: [...QUIET] } };
  if (first.layer === "driver") {
    // the heartbeat of amqplib: the second receive check with nothing, 2 to 3 heartbeats after the last
    // bytes of the broker. amqplib ends its socket, and the kernel stamps the change to FIN_WAIT1
    if (first.timer !== "heartbeat") throw new Error(`${spec.plan}: ${first.timer} of amqplib fires first, which this catalog does not measure yet`);
    return { detects: true, timer: first.timer, errno: "CLOSED", from: "last-data", low: s(first.band.lo), high: s(first.band.hi) };
  }
  // the kernel gives up on the operation: its retransmissions count from the first one
  const from = first.timer === "retrans_giveup" ? "first-retransmission" : "last-received";
  return { detects: true, timer: first.timer, errno: first.name, from, low: s(first.band.lo), high: s(first.band.hi), driver: { socket: "connection" } };
};

/** These are the cells of T01 over amqplib-2.2 and rabbitmq-4.3 that this catalog starts. */
export const T01_AMQP_SPECS: readonly AmqpSpec[] = [
  { plan: "T01.defaults.134", name: "blackhole, idle: the heartbeat of amqplib ends the connection", fault: "blackhole", mode: "idle" },
  { plan: "T01.defaults.135", name: "rst, an operation in flight", fault: "rst", mode: "inflight" },
  { plan: "T01.defaults.136", name: "fin, idle: the killed broker resets the connection, because its sockets have linger 0", fault: "fin", mode: "idle" },
  { plan: "T01.defaults.137", name: "unreachable-host, an operation in flight, tcp_retries2 = 3", fault: "unreachable", mode: "inflight", icmp: "host", linux: { tcp_retries2: count(3) } },
  { plan: "T01.defaults.138", name: "freeze-process, an operation in flight: the heartbeat of amqplib ends the connection", fault: "freeze-process", mode: "inflight" },
  { plan: "T01.defaults.139", name: "a 1 s stall, an operation in flight", fault: "stall", mode: "inflight", stall: 1 },
  { plan: "T01.defaults.140", name: "event:idle, no fault, idle for 300 s: the heartbeat frames keep the connection", fault: "none", mode: "idle", hold: 300 },
  { plan: "T01.defaults.142", name: "rst at the connect: the broker refuses before the client starts", fault: "rst", mode: "inflight", before: true },
];

/**
 * This function gives the earliest give-up of the kernel on an RPC in a black hole, from its first
 * retransmission. The heartbeat of amqplib is off, thus only the kernel detects.
 */
const giveUpOf = (retries: number): number => {
  const first = firstOn("waiting", MANIFESTATIONS.blackhole, given(amqpValues({ heartbeat: 0 })), given(linuxValues({ tcp_retries2: count(retries) })));
  if (first.kind !== "timer" || first.layer !== "kernel") throw new Error(`no give-up of the kernel with tcp_retries2 = ${retries}`);
  return Math.floor(first.band.lo);
};

/**
 * This value is the tcp_retries2 of the borders of O17: the kernel gives up 51 s to 108.2 s after the first
 * retransmission. The last data before the RPC is the reply to operation 1, approximately 0.3 s before it. Thus a
 * heartbeat of 15 s ends the connection at most 45 s after the RPC, and one of 60 s at least 119.7 s after it.
 */
export const O17_RETRIES = 7;

/** These are the border cells of T01 over amqplib-2.2 and rabbitmq-4.3: O03 and O17, each with a setting inside and one outside. */
export const T01_AMQP_BORDER_SPECS: readonly AmqpSpec[] = [
  // ---- O03: the heartbeat frames of the broker, each heartbeat / 2, against a router that forgets an idle flow in silence
  ...([
    ["T01.border-off.161", 40, "inside"],
    ["T01.border-off.162", 80, "outside"],
  ] as const).map(
    ([plan, heartbeat, side]): AmqpSpec => ({
      plan,
      name: `middlebox-forget, idle, heartbeat ${heartbeat} s: ${side} O03 against a ${RABBIT_ROUTER.form} router at ${RABBIT_ROUTER.idle} s`,
      fault: "middlebox-forget",
      mode: "idle",
      router: RABBIT_ROUTER,
      options: { heartbeat },
    }),
  ),
  // ---- O17: the heartbeat of amqplib against the give-up of the kernel, behind a black hole with an RPC in flight
  ...([
    ["T01.border-off.205", 15, "inside"],
    ["T01.border-off.206", 60, "outside"],
  ] as const).map(
    ([plan, heartbeat, side]): AmqpSpec => ({
      plan,
      name: `blackhole, an operation in flight, tcp_retries2 = ${O17_RETRIES}, heartbeat ${heartbeat} s: ${side} O17 against a give-up of the kernel at ${giveUpOf(O17_RETRIES)} s`,
      fault: "blackhole",
      mode: "inflight",
      linux: { tcp_retries2: count(O17_RETRIES) },
      options: { heartbeat },
    }),
  ),
];

/** These are the cells of the plan over these systems at the defaults that this catalog does not start, each with its reason. */
export const T01_AMQP_WAITING: readonly Waiting[] = [
  {
    plan: "T01.defaults.10",
    trigger: "app-stall",
    why: "RabbitMQ holds no reply of an RPC by itself. Its hold is the block of a resource alarm, which needs a command at the broker timed to the request",
  },
  { plan: "T01.defaults.141", trigger: "event:server-restart-same-ip", why: "the harness has no restart of a target with its address" },
  { plan: "T01.defaults.143", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  { plan: "T01.defaults.144", trigger: "in-process:event-loop", why: "no document gives how late the timers of Node are after a block of its event loop" },
  {
    plan: "T01.defaults.145",
    trigger: "workload:write-write-read",
    why: "the client of the harness sends one RPC at a time. Two writes before a read need a workload of the client, with Nagle on in amqplib",
  },
];

/**
 * The array stage of the plan gives each cell at the defaults a practice profile (R3, D-profiles.json),
 * with the same trigger. A profile sets only the knobs of the systems that it names. These profiles
 * name PostgreSQL, gRPC or a managed Redis, or the defaults of RabbitMQ. They set no knob of amqplib or
 * of RabbitMQ, and no knob of Linux TCP that the cell reads. Thus each array cell is its cell at the defaults.
 */
export const T01_AMQP_ARRAY_ALIASES: readonly Alias[] = [
  {
    plan: "T01.array.134",
    is: "T01.defaults.134",
    why: "DP21 sets the timers of the PostgreSQL server, and it keeps the keepalive of the kernel at its defaults. amqplib sets no keepalive",
  },
  {
    plan: "T01.array.135",
    is: "T01.defaults.135",
    why: "DP45 is the defaults of RabbitMQ 4.3: consumer_timeout of 30 min, which binds only a quorum queue, and a heartbeat of 60 s",
  },
  {
    plan: "T01.array.136",
    is: "T01.defaults.136",
    why: "DP22 sets the timers and the keepalive of the PostgreSQL server. The killed broker resets the connection before a timer can fire",
  },
  {
    plan: "T01.array.137",
    is: "T01.defaults.137",
    why: "DP44 gives the client a connect timeout of 5 s and a command timeout. amqplib clears its connect timeout when the connection opens (connect.js:157-159), and it has no command timeout",
  },
  { plan: "T01.array.138", is: "T01.defaults.138", why: "DP48 is the connect path at the defaults, and the operation of this cell is in flight on an open connection" },
  { plan: "T01.array.139", is: "T01.defaults.139", why: "DP23 is gRPC at its defaults: it sets no knob of these systems" },
  { plan: "T01.array.140", is: "T01.defaults.140", why: "DP24 is the keepalive of gRPC that its vendor recommends: it sets no knob of these systems" },
  {
    plan: "T01.array.142",
    is: "T01.defaults.142",
    why: "DP25 is the keepalive of a gRPC client against a server that enforces a minimum: it sets no knob of these systems, and the reset comes before the handshake",
  },
];

/** These are the profiles of the array cells whose cell at the defaults waits, by the number of the cell. */
const ARRAY_PROFILES: Readonly<Record<string, string>> = { "10": "DP47", "141": "DP42", "143": "DP40", "144": "DP44", "145": "DP44" };

/** These are the cells of the array stage that wait. Each one waits for the reason of its cell at the defaults. */
export const T01_AMQP_ARRAY_WAITING: readonly Waiting[] = T01_AMQP_WAITING.map((each) => {
  const n = each.plan.replace(/^T01\.defaults\./, "");
  const profile = ARRAY_PROFILES[n];
  if (profile === undefined) throw new Error(`${each.plan}: no profile of the array stage`);
  return { plan: `T01.array.${n}`, trigger: each.trigger, why: `as T01.defaults.${n}, under ${profile}: ${each.why}` };
});

/** This function gives the name of a cell: its cell of the plan, its tuple of systems, and what it does. */
export const amqpNameOf = (spec: AmqpSpec): string => `${spec.plan} amqplib-2.2 to rabbitmq-4.3, ${spec.name}`;

/** This function gives the harness cell of a spec. */
export const amqpCell = (spec: AmqpSpec): Cell => ({
  name: amqpNameOf(spec),
  target: RABBIT_TARGET,
  sysctls: sysctlsOf(linuxValues(spec.linux)),
  probe: { mode: spec.mode, keepalive: false, driver: { name: "amqp" } },
  fault: spec.fault,
  prediction: amqpPrediction(spec),
  ...(spec.fault === "unreachable" ? { targetSysctls: { "net.ipv4.icmp_ratelimit": "0" } } : {}),
  ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
  ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
  ...(spec.options === undefined ? {} : { driverOptions: spec.options }),
  ...(spec.before === true ? { before: true } : {}),
  ...(spec.router === undefined ? {} : { topology: { name: "T01", hops: [routerHop(spec.router.form, spec.router.idle)] } }),
  runs: RUNS,
  // a killed broker cannot serve the next run: each run of a fin has its own environment
  environments: spec.fault === "fin" ? RUNS : 2,
});

/** These are the RabbitMQ cells of T01 for the harness. */
export const T01_AMQP: readonly Cell[] = [...T01_AMQP_SPECS, ...T01_AMQP_BORDER_SPECS].map(amqpCell);
