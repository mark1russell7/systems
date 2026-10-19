import type { Detector, KnobValues, Manifestation } from "@mark1russell7/algebra";
import { detection, errnoOf, overValues, timerOf, timerUnder, transitionOn } from "@mark1russell7/algebra";
import type { Cell, Prediction, Target } from "@mark1russell7/harness";
import { AMQPLIB, LINUX_TCP, RABBITMQ_CONNECTION } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { HZ, RTT_MS, RUNS, count, given, predict, s, seconds, sysctlsOf } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Waiting } from "../mongo/cells.ts";
import type { Span } from "../mongo/model.ts";
import { linuxValues, span } from "../mongo/model.ts";

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

/** A spec is one cell of the catalog: its cell of the plan, its fault and the mode of the client. It also gives the sysctls of the namespace. */
export interface AmqpSpec {
  readonly plan: string;
  readonly name: string;
  readonly fault: "blackhole" | "rst" | "fin" | "unreachable" | "freeze-process" | "stall" | "none";
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
}

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
  if (spec.fault === "stall")
    return predict({ name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall!, linux: spec.linux ?? {} });
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
    return { detects: true, timer: first.timer, errno: "CLOSED", from: "last-received", low: s(first.band.lo), high: s(first.band.hi) };
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
  runs: RUNS,
  // a killed broker cannot serve the next run: each run of a fin has its own environment
  environments: spec.fault === "fin" ? RUNS : 2,
});

/** These are the RabbitMQ cells of T01 for the harness. */
export const T01_AMQP: readonly Cell[] = T01_AMQP_SPECS.map(amqpCell);
