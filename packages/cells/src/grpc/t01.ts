import type { Detector, KnobValues, Machine, Manifestation } from "@mark1russell7/algebra";
import { detection, errnoOf, overValues, timerOf, timerUnder } from "@mark1russell7/algebra";
import type { Cell, Prediction, RouterHop, Target } from "@mark1russell7/harness";
import { ETCD_SERVER, GRPC_GO_SERVER, GRPC_JS, LINUX_TCP } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import type { Spec } from "../catalog.ts";
import { HZ, RTT_MS, RUNS, count, given, predict, predictAt, s, seconds, sysctlsOf } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import type { Span } from "../mongo/model.ts";
import { linuxValues, span } from "../mongo/model.ts";
import { PRESETS } from "../mongo/t03.ts";
import { ackDelay, conntrackValues, o03, router as routerHop } from "../topologies.ts";

/**
 * The gRPC catalog of T01: grpc-js 1.14.6 on Node 24.21.0 against one server, on the direct pair. The
 * server is a server of grpc-go v1.84.0 (the server of the harness), or etcd v3.6.15 with one member.
 * The client opens one channel at the defaults of grpc-js. Each operation is a unary call of
 * grpc.health.v1.Health/Check, which each server answers at once. Each cell is named by the cell of the
 * plan that it stands for, for the tuple grpc-js-1.14 → grpc-go-server or grpc-js-1.14 → etcd-3.6.
 *
 * Each band comes from the documents `grpc-js`, `grpc-go-server`, `etcd-server` and `linux-tcp`. At the
 * defaults grpc-js has no keepalive, no deadline and no connect timeout, and it sets no TCP keepalive.
 * Thus a silent fault has no detector at the client, and only the kernel ends a call in flight.
 */

/** This image is the stock base of the two servers of the harness, for the record: Alpine 3.22. */
export const GRPC_BASE = "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8";

/** This command holds a server as the child of a shell, thus a fin can stop it with SIGKILL while the container stays up. */
const held = (run: string): readonly string[] => ["sh", "-c", `${run} & echo $! > /tmp/server.pid; while :; do sleep 3600; done`];
const KILL = ["sh", "-c", 'kill -KILL "$(cat /tmp/server.pid)"'] as const;

/** These are the flags of the server of the harness, by the names of the knobs of `grpc-go-server`. Each duration is in seconds. */
const GO_FLAGS: Readonly<Record<string, string>> = {
  keepalive_time: "--keepalive-time",
  keepalive_timeout: "--keepalive-timeout",
  min_time: "--min-time",
  max_connection_idle: "--max-connection-idle",
  max_connection_age: "--max-connection-age",
  max_connection_age_grace: "--max-connection-age-grace",
  listener_keepidle: "--listener-keepalive",
  listener_keepintvl: "--listener-keepalive-interval",
};

/** These are the flags of etcd, by the names of the knobs of `etcd-server`. Each duration is in seconds. */
const ETCD_FLAGS: Readonly<Record<string, string>> = {
  keepalive_time: "--grpc-keepalive-interval",
  keepalive_timeout: "--grpc-keepalive-timeout",
  min_time: "--grpc-keepalive-min-time",
};

/** The two servers of the catalog. */
export type GrpcServer = "grpc-go" | "etcd";

/** This function gives the document of a server. */
export const serverDoc = (server: GrpcServer): Machine => (server === "grpc-go" ? GRPC_GO_SERVER : ETCD_SERVER);

/**
 * This function gives the target of a server, with settings over its defaults by the names of its
 * document. The server of the harness takes each setting as a flag. etcd takes the three of its
 * keepalive. With no settings, each is at its defaults.
 */
export const grpcTarget = (server: GrpcServer, settings: Readonly<Record<string, number>> = {}): Target => {
  const flags = server === "grpc-go" ? GO_FLAGS : ETCD_FLAGS;
  const unknown = Object.keys(settings).filter((name) => flags[name] === undefined && !(server === "grpc-go" && (name === "listener_keepcnt" || name === "permit_without_stream")));
  if (unknown.length > 0) throw new Error(`the ${server} server has no flag for ${unknown.join(", ")}`);
  const args = Object.entries(settings).map(([name, value]) => {
    if (name === "listener_keepcnt") return `--listener-keepalive-count ${value}`;
    if (name === "permit_without_stream") return value === 1 ? "--permit-without-stream" : "";
    return `${flags[name]} ${value}s`;
  });
  if (server === "grpc-go")
    return {
      image: GRPC_BASE,
      subject: { kind: "shipped", name: "grpc-go" },
      port: GRPC_PORT,
      ready: '"ev":"listening"',
      lines: true,
      program: "grpc-go-server",
      command: held(["grpc-go-server", "--port", String(GRPC_PORT), ...args.filter((arg) => arg !== "")].join(" ")),
      kill: KILL,
    };
  return {
    image: GRPC_BASE,
    subject: { kind: "shipped", name: "etcd" },
    port: ETCD_PORT,
    ready: "serving client traffic insecurely",
    program: "etcd",
    command: held(
      [
        "etcd --name n1 --data-dir /tmp/etcd",
        `--listen-client-urls http://0.0.0.0:${ETCD_PORT} --advertise-client-urls http://127.0.0.1:${ETCD_PORT}`,
        "--listen-peer-urls http://127.0.0.1:2380 --initial-advertise-peer-urls http://127.0.0.1:2380 --initial-cluster n1=http://127.0.0.1:2380",
        ...args,
      ].join(" "),
    ),
    kill: KILL,
  };
};

/** These are the ports of the two servers. */
export const GRPC_PORT = 50051;
export const ETCD_PORT = 2379;

/** This text is the version of the client that each cell loads, as the lockfile of its image pins it. */
export const GRPC_DRIVER = "grpc-js 1.14.6 on Node 24.21.0";

/** This range is the first round trip that each band of a reset assumes: 0 to 2 ms on the direct pair. */
export const GRPC_RTT_MS = 2;

/** This time is the most that a server takes to answer a call: one round trip, and one step of the scheduler of Go. */
export const GRPC_LATENCY: number = GRPC_RTT_MS / 1000 + (GRPC_GO_SERVER.knobs["slack"]?.default ?? 0);

/** This time is the hold of the reply of an app-stall: the server of the harness holds the call in flight 5 s. */
export const GRPC_HOLD = 5;

/** A spec is one cell of the catalog: its cell of the plan, its server, its fault and the mode of the client. */
export interface GrpcSpec {
  readonly plan: string;
  readonly name: string;
  readonly server: GrpcServer;
  readonly fault: "blackhole" | "rst" | "fin" | "unreachable" | "freeze-process" | "stall" | "none" | "app-stall" | "middlebox-forget" | "simplex";
  readonly mode: "idle" | "inflight";
  /** This side is the observer: the client, or the socket of the server for the connection of the client. */
  readonly observer?: "server";
  /** This router is between the client and the server: its form and its idle timeout, in whole seconds. */
  readonly router?: { readonly form: RouterHop["form"]; readonly idle: number; readonly preset: string };
  /** These are the sysctls of Linux TCP at the server that differ from Linux 6.6. */
  readonly serverLinux?: Readonly<Record<string, Extent>>;
  /** This side is the one that a fault at the router faces. Without it, the fault is at the peer of the observer. */
  readonly toward?: "client" | "target";
  /** This direction is the one that a simplex fault drops. */
  readonly drops?: "to-server" | "to-client";
  /**
   * This stream is the operation in flight of a border of O26. It is a call that the server of the
   * harness holds for `held` seconds, or a Watch that stays open. The PINGs of the client go on it.
   */
  readonly stream?: { readonly kind: "held"; readonly held: number } | { readonly kind: "watch" };
  readonly icmp?: "host" | "net" | "port" | "admin";
  /** This time is the length of a stall, in seconds. */
  readonly stall?: number;
  /** These are the sysctls of Linux TCP at the client that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** This flag starts the client into a fault that holds already: its connect meets it. */
  readonly before?: true;
  /** These are the options of grpc-js that differ from the defaults, by the names of the document (`keepalive_time` in ms, `deadline` in ms). */
  readonly options?: Readonly<Record<string, number>>;
  /** These are the settings of the server that differ from its defaults, by the names of its document. */
  readonly settings?: Readonly<Record<string, number>>;
  /** This time is the window of a cell with no fault, in seconds. */
  readonly hold?: number;
}

/** These are the channel options of grpc-js by the names of the knobs of its document. The deadline is an option of the client of the harness. */
const OPTION_OF: Readonly<Record<string, string>> = {
  keepalive_time: "grpc.keepalive_time_ms",
  keepalive_timeout: "grpc.keepalive_timeout_ms",
  keepalive_permit_without_calls: "grpc.keepalive_permit_without_calls",
  initial_reconnect_backoff: "grpc.initial_reconnect_backoff_ms",
  max_reconnect_backoff: "grpc.max_reconnect_backoff_ms",
  client_idle_timeout: "grpc.client_idle_timeout_ms",
  deadline: "deadline_ms",
};

/** This function gives the options of the client of the harness for the options of a spec. */
export const driverOptionsOf = (options: Readonly<Record<string, number>>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(options)) {
    const option = OPTION_OF[name];
    if (option === undefined) throw new Error(`grpc-js has no option for the knob ${name}`);
    out[option] = value;
  }
  return out;
};

/** This function gives the values of the knobs of grpc-js for a cell: the defaults of the document, and the options of the cell. */
export const grpcValues = (options: Readonly<Record<string, number>> = {}): Record<string, Extent> => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(GRPC_JS.knobs)) {
    if (knob.unit === null) continue;
    const value = options[name] ?? knob.default;
    if (value === null) continue;
    out[name] = { value: knob.off !== undefined && value === knob.off ? "infinite" : value, unit: knob.unit };
  }
  const unknown = Object.keys(options).filter((name) => GRPC_JS.knobs[name]?.unit == null);
  if (unknown.length > 0) throw new Error(`grpc-js has no knob with a unit for ${unknown.join(", ")}`);
  out["hz"] = { value: HZ, unit: "Hz" };
  out["rtt"] = { value: RTT_MS, unit: "ms" };
  return out;
};

/** A state of the client at the fault: an idle transport, or a call in flight. */
type GrpcState = "idle" | "waiting";

/** A first detection is the detector that fires first on the socket of the client, or an event that the fault delivers. */
type First =
  | { readonly kind: "timer"; readonly timer: string; readonly layer: "driver" | "kernel"; readonly name: string; readonly band: Span }
  | { readonly kind: "delivered"; readonly event: string; readonly name: string }
  | { readonly kind: "silent" };

const finite = (d: Detector): boolean => !("unknown" in d.duration) && d.duration.value !== "infinite";

/**
 * This function gives the first detection on the socket of the client. It composes the document of
 * grpc-js over Linux TCP. grpc-js sets no keepalive, thus the kernel uses the knobs of the namespace.
 */
const firstOn = (state: GrpcState, manifestation: Manifestation, driver: KnobValues, linux: KnobValues): First => {
  const inFlight = state === "waiting";
  const own = detection(GRPC_JS, { state, inFlight }, { name: manifestation.name, passes: [] }, driver);
  const lower = overValues(GRPC_JS, driver, linux);
  const socket = GRPC_JS.over?.states[state];
  if (socket === undefined) throw new Error(`grpc-js maps no state of Linux TCP for ${state}`);
  const below = detection(LINUX_TCP, { state: socket, inFlight }, manifestation, lower);
  const [delivered] = below.delivered;
  if (delivered !== undefined) return { kind: "delivered", event: delivered.event, name: delivered.errno ?? "EOF" };
  const all = [
    // the keepalive and its wait for the ACK are two timers of one detector: the band below takes them together
    ...own.detectors.filter(finite).filter((d) => d.timer !== "keepalive" && d.timer !== "ping_timeout").map((d) => ({ d, layer: "driver" as const })),
    ...below.detectors.filter(finite).map((d) => ({ d, layer: "kernel" as const })),
  ].map((each) => {
    const bounds = each.layer === "driver" ? timerOf(GRPC_JS, each.d.timer, driver) : timerUnder(LINUX_TCP, each.d.timer, lower, manifestation);
    const duration = seconds(bounds.duration, each.d.timer);
    return { ...each, band: span(duration - seconds(bounds.early, "early"), duration + seconds(bounds.lateness, "lateness")) };
  });
  all.sort((a, b) => a.band.lo - b.band.lo);
  const [winner, next] = all;
  if (winner === undefined) return { kind: "silent" };
  if (next !== undefined && next.band.lo <= winner.band.hi) throw new Error(`${winner.d.timer} and ${next.d.timer} can both fire first`);
  const name = winner.layer === "driver" ? (winner.d.timer === "deadline" ? "DEADLINE_EXCEEDED" : winner.d.fires) : (errnoOf(LINUX_TCP, socket, winner.d, manifestation) ?? "ETIMEDOUT");
  return { kind: "timer", timer: winner.d.timer, layer: winner.layer, name, band: winner.band };
};

/**
 * This function gives the band of the keepalive of grpc-js, from the start of the first call. The PING
 * goes out after keepalive_time, and the transport ends keepalive_timeout after it with no ACK. The band
 * is null when the keepalive is off.
 */
const keepaliveBand = (driver: KnobValues): Span | null => {
  const ping = timerOf(GRPC_JS, "keepalive", driver);
  const wait = timerOf(GRPC_JS, "ping_timeout", driver);
  if ("unknown" in ping.duration || ping.duration.value === "infinite") return null;
  const total = seconds(ping.duration, "the keepalive") + seconds(wait.duration, "the wait for the ACK");
  return span(total, total + seconds(ping.lateness, "its lateness") + seconds(wait.lateness, "the lateness of the wait"));
};

/** This function gives the manifestation of a fault to the kernel of the client. */
const manifestationOf = (spec: GrpcSpec): Manifestation => {
  if (spec.fault === "unreachable") return MANIFESTATIONS[`unreachable-${spec.icmp ?? "host"}` as keyof typeof MANIFESTATIONS];
  if (spec.fault === "freeze-process") return MANIFESTATIONS["freeze-process"];
  if (spec.fault === "simplex") return MANIFESTATIONS[spec.drops === "to-server" ? "simplex-to-server" : "simplex-to-client"];
  // the kernel of a killed server closes its socket with a FIN: Go sets no linger, and nothing is unread
  if (spec.fault === "fin") return MANIFESTATIONS.fin;
  return MANIFESTATIONS.blackhole;
};

/** This time is the window of a cell where nothing detects the fault, in seconds. */
export const SILENT_WINDOW = 60;

/** These lines of the client must not occur in the window of a silent cell: a failed call, or an error of the socket. */
const QUIET = [{ ev: "fail" }, { ev: "socket-error" }] as const;

/** This function checks that nothing of the server ends an idle connection in a window: its keepalive and its timers of the connection. */
const serverKeeps = (spec: GrpcSpec, window: number): void => {
  const doc = serverDoc(spec.server);
  const values = (name: string) => {
    const knob = doc.knobs[name];
    const value = spec.settings?.[name] ?? knob?.default;
    if (knob === undefined || knob.unit === null || value === null || value === undefined) return undefined;
    return { value: knob.off !== undefined && value === knob.off ? ("infinite" as const) : value, unit: knob.unit };
  };
  for (const timer of ["keepalive", "max_idle", "max_age"]) {
    const bounds = timerOf(doc, timer, values);
    if (!("unknown" in bounds.duration) && bounds.duration.value !== "infinite" && seconds(bounds.duration, timer) <= window)
      throw new Error(`${spec.plan}: the timer ${timer} of ${doc.id} can act in the window of ${window} s`);
  }
};

/** This function gives the values of the knobs of a server for a cell: the defaults of its document, and the settings of the cell. */
export const serverValues = (server: GrpcServer, settings: Readonly<Record<string, number>> = {}): Record<string, Extent> => {
  const doc = serverDoc(server);
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(doc.knobs)) {
    if (knob.unit === null) continue;
    const value = settings[name] ?? knob.default;
    if (value === null) continue;
    out[name] = { value: knob.off !== undefined && value === knob.off ? "infinite" : value, unit: knob.unit };
  }
  out["hz"] = { value: HZ, unit: "Hz" };
  out["rtt"] = { value: RTT_MS, unit: "ms" };
  return out;
};

/** This time is the window of a border cell where the flow lives, in seconds. */
export const BORDER_WINDOW = 150;

/**
 * This function gives the prediction of a cell that observes the socket of the server, for the
 * connection of an idle client. The kernel of the server times each end:
 * - O25: the keepalive of the listener under TCP_USER_TIMEOUT, behind a black hole of the client.
 * - O17: the keepalive of gRPC (a PING after Time with no read, the close Timeout after it) against
 *   the give-up of the kernel on that PING, behind a black hole of the client.
 * - O03: the keepalive of the listener against a router that forgets an idle flow. The router drops
 *   each late packet from outside, thus the probes of the server get no answer after the forget.
 */
const serverPrediction = (spec: GrpcSpec): Prediction => {
  const doc = serverDoc(spec.server);
  const values = given(serverValues(spec.server, spec.settings));
  const lower = overValues(doc, values, given(linuxValues(spec.serverLinux)));
  const slack = seconds(timerOf(doc, "keepalive", values).lateness, "the slack of Go");
  const abort = (): Prediction => {
    const keepalive = timerUnder(LINUX_TCP, "keepalive", lower, MANIFESTATIONS.blackhole);
    const duration = seconds(keepalive.duration, "the keepalive of the listener");
    const band = span(duration - seconds(keepalive.early, "early"), duration + seconds(keepalive.lateness, "lateness"));
    return { detects: true, timer: "keepalive", errno: "ETIMEDOUT", from: "last-received", low: s(band.lo), high: s(band.hi) };
  };
  if (spec.fault === "middlebox-forget") {
    const router = spec.router;
    if (router === undefined) throw new Error(`${spec.plan}: a forgotten flow needs a router`);
    if (router.form !== "reset-next" && router.form !== "silent-drop") throw new Error(`${spec.plan}: the router must drop a late packet from outside, not ${router.form}`);
    const verdict = o03({ doc, values }, conntrackValues(router.idle), GRPC_RTT_MS / 1000);
    if (verdict.holds) return { detects: false, window: s(BORDER_WINDOW) };
    // the router forgot the flow: each probe of the server drops, and the keepalive aborts the socket
    return abort();
  }
  if (spec.fault !== "blackhole") throw new Error(`${spec.plan}: this catalog observes the server only behind a black hole or a router`);
  // the keepalive of gRPC: the PING after Time with no read, then the close Timeout after it, before
  // the kernel gives up on that PING. Its last read is the call of operation 1. The last segment
  // that the server gets is the ACK of the client for the reply: up to one round trip and the delayed
  // ACK after that read
  const ping = timerOf(doc, "keepalive", values);
  const time = seconds(ping.duration, "Time");
  const timeout = seconds(timerOf(doc, "ping_timeout", values).duration, "Timeout");
  const giveUp = timerUnder(LINUX_TCP, "retrans_giveup", lower, MANIFESTATIONS.blackhole);
  const kernel = span(seconds(giveUp.duration, "the give-up") - seconds(giveUp.early, "early"), seconds(giveUp.duration, "the give-up") + seconds(giveUp.lateness, "lateness"));
  const keepidle = seconds(lower("keepidle") ?? s(0), "the keepalive idle of the listener");
  // the PING after the first probe of the listener: the keepalive of the listener ends the socket
  if (time >= keepidle) return abort();
  // the PING goes before the keepalive of the listener, and with data in flight that keepalive does
  // not fire. The kernel gives up on the PING from its first retransmission, one RTO after it
  if (timeout + 3 * slack < RTO_FIRST + kernel.lo) {
    const before = GRPC_RTT_MS / 1000 + ackDelay(RTT_MS).hi + GRPC_LATENCY;
    return { detects: true, timer: "ping_timeout", errno: "CLOSED", from: "last-received", low: s(time + timeout - before), high: s(time + timeout + 3 * slack) };
  }
  if (timeout > RTO_LAST + kernel.hi) return { detects: true, timer: "retrans_giveup", errno: "ETIMEDOUT", from: "first-retransmission", low: s(kernel.lo), high: s(kernel.hi) };
  throw new Error(`${spec.plan}: the close of gRPC and the give-up of the kernel can both come first`);
};

/**
 * These are the earliest and the latest first retransmission of the PING, after the PING. The RTO is
 * 200 ms over the smoothed round trip. A sample of the server can hold the delayed ACK of the client.
 */
const RTO_FIRST = 0.2;
const RTO_LAST = 0.2 + 0.05;

/** This time is the window of a border of O26 with a Watch and no GOAWAY, in seconds: six PINGs at 6 s. */
export const POLICY_WINDOW = 40;

/**
 * This function gives the prediction of a border of O26: the PINGs of grpc-js on a stream in flight,
 * against the policy of the server. The keepalive timer starts with operation 1, and each next PING
 * comes keepalive_time after the ACK of the one before. The first PING clears the strikes, because the
 * server wrote a reply since the last PING. Each later PING less than MinTime after the one before is a
 * strike. The strike after max_ping_strikes gives GOAWAY too_many_pings, and the server closes the connection.
 */
const policyPrediction = (spec: GrpcSpec, driver: KnobValues, slack: number): Prediction => {
  const stream = spec.stream;
  if (stream === undefined) throw new Error(`${spec.plan}: a border of O26 needs a stream in flight`);
  const interval = seconds(timerOf(GRPC_JS, "keepalive", driver).duration, "the keepalive of grpc-js");
  const values = given(serverValues(spec.server, spec.settings));
  const minTime = seconds(values("min_time") ?? s(0), "MinTime");
  const allowed = values("max_ping_strikes");
  if (allowed === undefined || "unknown" in allowed || typeof allowed.value !== "number") throw new Error(`${spec.plan}: no count of the strikes of the server`);
  const strikes = allowed.value;
  if (interval >= minTime) {
    // no PING is a strike: the stream ends at its own end, or it stays open
    if (stream.kind === "watch") return { detects: false, window: s(POLICY_WINDOW), driver: { socket: "connection", quiet: [...QUIET] } };
    const reply = { from: "request-sent", ends: { ev: "ack", where: { n: 2 } } } as const;
    return {
      detects: false,
      window: s(2 * stream.held),
      replies: { low: s(stream.held), high: s(stream.held + GRPC_LATENCY + 2 * slack) },
      driver: { socket: "connection", reply, quiet: [...QUIET] },
    };
  }
  // the first PING clears the strikes, thus the GOAWAY comes at the PING after max_ping_strikes more
  const pings = strikes + 2;
  const at = pings * interval;
  if (stream.kind === "held" && stream.held <= at) throw new Error(`${spec.plan}: the held reply comes before the GOAWAY`);
  const ends = { ev: "error", name: "errno" } as const;
  return {
    detects: true,
    timer: "too_many_pings",
    errno: "too_many_pings",
    from: "last-data",
    low: s(at - GRPC_LATENCY),
    high: s(at + pings * (slack + GRPC_LATENCY) + slack),
    driver: { socket: "connection", ends },
  };
};

/** This function gives the prediction of a cell of the catalog. */
export const grpcPrediction = (spec: GrpcSpec): Prediction => {
  if (spec.observer === "server") return serverPrediction(spec);
  if (spec.fault === "stall") {
    const stall: Spec = { name: spec.name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall: spec.stall!, linux: spec.linux ?? {} };
    const stalled = predict(stall);
    if (stalled.detects !== false || stalled.recovers === undefined) return stalled;
    // the first segment back can be the reply of the server to the call that got through: its socket
    // delays its ACK, and the reply comes one step of the server later. Each RTT sample of the client
    // holds the reply time of the server, which ACKs the call. Thus the latest return is the one at a
    // round trip of GRPC_LATENCY, as for amqplib
    const slowest = predictAt(stall, GRPC_LATENCY * 1000);
    if (slowest.detects !== false || slowest.recovers?.firing !== stalled.recovers.firing)
      throw new Error(`${spec.plan}: at a round trip of ${GRPC_LATENCY * 1000} ms, another firing of the RTO returns the reply`);
    return { ...stalled, recovers: { ...stalled.recovers, high: slowest.recovers.high } };
  }
  const rtt = { low: { value: 0, unit: "ms" }, high: { value: GRPC_RTT_MS, unit: "ms" } } as const;
  const driver = given(grpcValues(spec.options));
  const linux = given(linuxValues(spec.linux));
  const slack = seconds(timerOf(GRPC_JS, "deadline", given(grpcValues({ deadline: 1000 }))).lateness, "the slack of Node");
  // a reset of the SYN fails the connect: the subchannel goes to TRANSIENT_FAILURE, and the call fails at once
  if (spec.before === true) {
    if (spec.fault !== "rst") throw new Error(`${spec.plan}: this catalog starts a client into a reset only`);
    const ends = { ev: "fail", where: { n: 1 }, name: "name" } as const;
    return { detects: true, timer: "the reset of the connect", errno: "UNAVAILABLE", from: "client-start", low: s(0), high: s(GRPC_RTT_MS / 1000 + 3 * slack), driver: { socket: "connection", ends } };
  }
  // a reset answers the call at once: the kernel reports it on the socket of the transport
  if (spec.fault === "rst") return { detects: true, timer: "the reset of the call", errno: "ECONNRESET", from: "request-sent", low: s(0), high: s(GRPC_RTT_MS / 1000), rtt, driver: { socket: "connection" } };
  if (spec.stream !== undefined) return policyPrediction(spec, driver, slack);
  // an idle flow through a router, as the client sees it: the probes of the listener of the server
  // refresh it (O03), and nothing ends the connection in the window
  if (spec.fault === "middlebox-forget") {
    const router = spec.router;
    if (router === undefined) throw new Error(`${spec.plan}: a forgotten flow needs a router`);
    const doc = serverDoc(spec.server);
    const verdict = o03({ doc, values: given(serverValues(spec.server, spec.settings)) }, conntrackValues(router.idle), GRPC_RTT_MS / 1000);
    if (!verdict.holds) throw new Error(`${spec.plan}: the router forgets the flow, which this catalog observes only at the server`);
    const window = spec.hold ?? BORDER_WINDOW;
    serverKeeps(spec, window);
    return { detects: false, window: s(window), driver: { socket: "connection", quiet: [...QUIET] } };
  }
  // the server holds the reply. A deadline of the call shorter than the hold ends the call first
  if (spec.fault === "app-stall") {
    if (spec.server !== "grpc-go") throw new Error(`${spec.plan}: only the server of the harness holds a reply`);
    const first = firstOn("waiting", MANIFESTATIONS["freeze-process"], driver, linux);
    if (first.kind === "timer" && first.layer === "driver" && first.timer === "deadline" && first.band.hi < GRPC_HOLD) {
      // the server of grpc-go starts a timer of the same time from the header grpc-timeout, and it resets
      // the stream at its end (grpc-go-server, call_deadline). The two timers race: the call ends with
      // DEADLINE_EXCEEDED, or with CANCELLED when the reset of the server reaches it first
      const server = timerOf(GRPC_GO_SERVER, "call_deadline", given({ ...serverValues("grpc-go"), call_timeout: s(first.band.lo) }));
      if (seconds(server.duration, "the deadline at the server") !== first.band.lo) throw new Error(`${spec.plan}: the server of grpc-go keeps no deadline of the call`);
      return {
        detects: null,
        window: s(2 * GRPC_HOLD),
        from: "request-sent",
        why: `the deadline of grpc-js (DEADLINE_EXCEEDED) and the deadline of the call at the server of grpc-go (a RST_STREAM CANCEL, thus CANCELLED) end the call at the same time, ${first.band.lo} to ${first.band.hi} s after its send`,
      };
    }
    if (first.kind !== "silent") throw new Error(`${spec.plan}: ${first.kind === "timer" ? first.timer : first.event} ends the call in the hold`);
    const reply = { from: "request-sent", ends: { ev: "ack", where: { n: 2 } } } as const;
    return {
      detects: false,
      window: s(6 * GRPC_HOLD),
      replies: { low: s(GRPC_HOLD), high: s(GRPC_HOLD + GRPC_LATENCY + 2 * slack) },
      driver: { socket: "connection", reply, quiet: [...QUIET] },
    };
  }
  // no fault: nothing of grpc-js runs on an idle transport, and the timers of the server act after the window
  if (spec.fault === "none") {
    const window = spec.hold ?? 300;
    serverKeeps(spec, window);
    const idle = timerOf(GRPC_JS, "idle_timeout", driver);
    if (seconds(idle.duration, "the idle timeout") <= window) throw new Error(`${spec.plan}: the channel goes idle in the window`);
    return { detects: false, window: s(window), driver: { socket: "connection", quiet: [...QUIET] } };
  }
  const state: GrpcState = spec.mode === "inflight" ? "waiting" : "idle";
  const first = firstOn(state, manifestationOf(spec), driver, linux);
  // the kill of the server: its kernel ends the connection with a FIN at once
  if (first.kind === "delivered")
    return { detects: true, timer: `the server ends the connection: ${first.event}`, errno: first.name, from: "peer-closed", low: s(0), high: s(GRPC_RTT_MS / 1000 + slack), rtt, driver: { socket: "connection" } };
  // the keepalive of grpc-js, when a profile turns it on: a frozen server answers no PING. The timer
  // starts with the first call, thus it counts from the reply to operation 1, less the time of one reply
  const keepalive = state === "waiting" && spec.fault === "freeze-process" ? keepaliveBand(driver) : null;
  if (keepalive !== null && (first.kind === "silent" || first.band.lo > keepalive.hi))
    return { detects: true, timer: "keepalive", errno: "CLOSED", from: "last-data", low: s(keepalive.lo - GRPC_LATENCY), high: s(keepalive.hi) };
  // nothing detects the fault in the window: the first detector, for example the idle timeout of the
  // channel (30 min), comes after it
  if (first.kind === "silent" || first.band.lo > SILENT_WINDOW) return { detects: false, window: s(SILENT_WINDOW), driver: { socket: "connection", quiet: [...QUIET] } };
  if (first.layer === "driver") throw new Error(`${spec.plan}: ${first.timer} of grpc-js fires first, which this catalog does not measure yet`);
  // the kernel gives up on the call: its retransmissions count from the first one
  const from = first.timer === "retrans_giveup" ? "first-retransmission" : "last-received";
  return { detects: true, timer: first.timer, errno: first.name, from, low: s(first.band.lo), high: s(first.band.hi), driver: { socket: "connection" } };
};

/** These are the cells of T01 at the defaults that this catalog starts, for each server. */
export const T01_GRPC_SPECS: readonly GrpcSpec[] = [
  // ---- grpc-js-1.14 → grpc-go-server
  { plan: "T01.defaults.38", server: "grpc-go", name: "blackhole, idle: grpc-js has no keepalive, and nothing detects it", fault: "blackhole", mode: "idle" },
  { plan: "T01.defaults.198", server: "grpc-go", name: "rst, a call in flight", fault: "rst", mode: "inflight" },
  { plan: "T01.defaults.199", server: "grpc-go", name: "fin, idle: the killed server ends the connection with a FIN", fault: "fin", mode: "idle" },
  { plan: "T01.defaults.200", server: "grpc-go", name: "unreachable-host, a call in flight, tcp_retries2 = 3", fault: "unreachable", mode: "inflight", icmp: "host", linux: { tcp_retries2: count(3) } },
  { plan: "T01.defaults.201", server: "grpc-go", name: "freeze-process, a call in flight: no timer of grpc-js ends the call", fault: "freeze-process", mode: "inflight" },
  { plan: "T01.defaults.202", server: "grpc-go", name: "a 1 s stall, a call in flight", fault: "stall", mode: "inflight", stall: 1 },
  { plan: "T01.defaults.203", server: "grpc-go", name: "event:idle, no fault, idle for 300 s: nothing ends the connection", fault: "none", mode: "idle", hold: 300 },
  { plan: "T01.defaults.205", server: "grpc-go", name: "rst at the connect: the server refuses before the client starts", fault: "rst", mode: "inflight", before: true },
  { plan: "T01.defaults.206", server: "grpc-go", name: `app-stall, the server holds the reply ${GRPC_HOLD} s: no timer of grpc-js ends the call`, fault: "app-stall", mode: "inflight" },
  // ---- grpc-js-1.14 → etcd-3.6
  { plan: "T01.defaults.196", server: "etcd", name: "blackhole, idle: grpc-js has no keepalive, and nothing detects it", fault: "blackhole", mode: "idle" },
  { plan: "T01.defaults.162", server: "etcd", name: "rst, a call in flight", fault: "rst", mode: "inflight" },
  { plan: "T01.defaults.163", server: "etcd", name: "fin, idle: the killed server ends the connection with a FIN", fault: "fin", mode: "idle" },
  { plan: "T01.defaults.197", server: "etcd", name: "unreachable-host, a call in flight, tcp_retries2 = 3", fault: "unreachable", mode: "inflight", icmp: "host", linux: { tcp_retries2: count(3) } },
  { plan: "T01.defaults.164", server: "etcd", name: "freeze-process, a call in flight: no timer of grpc-js ends the call", fault: "freeze-process", mode: "inflight" },
  { plan: "T01.defaults.165", server: "etcd", name: "a 1 s stall, a call in flight", fault: "stall", mode: "inflight", stall: 1 },
  { plan: "T01.defaults.166", server: "etcd", name: "event:idle, no fault, idle for 300 s: nothing ends the connection", fault: "none", mode: "idle", hold: 300 },
  { plan: "T01.defaults.168", server: "etcd", name: "rst at the connect: the server refuses before the client starts", fault: "rst", mode: "inflight", before: true },
];

/** These are the cells of the plan over these systems at the defaults that this catalog does not start, each with its reason. */
export const T01_GRPC_WAITING: readonly Waiting[] = [
  {
    plan: "T01.defaults.39",
    trigger: "unreachable",
    why: "Caddy 2.11 serves no gRPC at its defaults: with no TLS it speaks HTTP/1.1, and the preface of HTTP/2 of grpc-js gets no SETTINGS. A Caddy that proxies gRPC is a cell of T02",
  },
  { plan: "T01.defaults.167", trigger: "event:server-restart-same-ip", why: "the harness has no restart of a target with its address" },
  { plan: "T01.defaults.204", trigger: "event:server-restart-same-ip", why: "the harness has no restart of a target with its address" },
  { plan: "T01.defaults.169", trigger: "app-stall", why: "etcd holds no reply of a call by itself. Its hold needs a fault timed to the request, for example a lost quorum of a cluster" },
  { plan: "T01.defaults.170", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  { plan: "T01.defaults.207", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  { plan: "T01.defaults.171", trigger: "in-process:event-loop", why: "no document gives how late the timers of Node are after a block of its event loop" },
  { plan: "T01.defaults.208", trigger: "in-process:event-loop", why: "no document gives how late the timers of Node are after a block of its event loop" },
  {
    plan: "T01.defaults.13",
    trigger: "workload:write-write-read",
    why: "grpc-js sets TCP_NODELAY on each connection (transport.ts:862), thus a write-write-read does not wait for Nagle. The client of the harness also sends one call at a time",
  },
  {
    plan: "T01.defaults.209",
    trigger: "workload:write-write-read",
    why: "grpc-js sets TCP_NODELAY on each connection (transport.ts:862), thus a write-write-read does not wait for Nagle. The client of the harness also sends one call at a time",
  },
];

/**
 * The array stage of the plan gives each cell at the defaults a practice profile (R3, D-profiles.json),
 * with the same trigger. Two profiles set knobs of grpc-js, and these cells start with them:
 * - DP24, gRPC as its vendor recommends. The keepalive is at least 1 min and at least the permit time of
 *   the server, with a timeout of 20 s. Against etcd (5 s) it is 60 s, against grpc-go (5 min) 300 s.
 * - DP44, the client timeouts of a managed Redis: a command timeout below 5 s. For grpc-js it is the
 *   deadline of a call, 4 s, against the hold of 5 s.
 */
export const T01_GRPC_ARRAY_SPECS: readonly GrpcSpec[] = [
  {
    plan: "T01.array.164",
    server: "etcd",
    name: "freeze-process, a call in flight, under DP24: the keepalive of grpc-js at 60 s and 20 s ends the transport",
    fault: "freeze-process",
    mode: "inflight",
    options: { keepalive_time: 60000 },
  },
  {
    plan: "T01.array.201",
    server: "grpc-go",
    name: "freeze-process, a call in flight, under DP24: the keepalive of grpc-js at 300 s and 20 s ends the transport",
    fault: "freeze-process",
    mode: "inflight",
    options: { keepalive_time: 300000 },
  },
  {
    plan: "T01.array.206",
    server: "grpc-go",
    name: `app-stall, the server holds the reply ${GRPC_HOLD} s, under DP44: a deadline of 4 s ends the call`,
    fault: "app-stall",
    mode: "inflight",
    options: { deadline: 4000 },
  },
];

/** These are the array cells that are their cells at the defaults: the profile sets no knob that the cell reads. */
export const T01_GRPC_ARRAY_ALIASES: readonly Alias[] = [
  { plan: "T01.array.38", is: "T01.defaults.38", why: "DP47 sets tcp_retries2 = 5. An idle connection sends nothing, thus no retransmission starts" },
  { plan: "T01.array.162", is: "T01.defaults.162", why: "DP22 sets the timers and the keepalive of a PostgreSQL server. The reset ends the call before a timer can fire" },
  { plan: "T01.array.163", is: "T01.defaults.163", why: "DP23 is gRPC at its defaults" },
  { plan: "T01.array.165", is: "T01.defaults.165", why: "DP48 is the connect path at the defaults, and the call of this cell is in flight on an open connection" },
  {
    plan: "T01.array.166",
    is: "T01.defaults.166",
    why: "DP40 sets a keepalive of 60 s to 300 s and a deadline on each call. With no call in flight, grpc-js sends no PING (permit_without_calls false), and no call runs: nothing changes",
  },
  { plan: "T01.array.168", is: "T01.defaults.168", why: "DP44 gives the client a connect timeout of 5 s. The reset refuses the connect at once" },
  { plan: "T01.array.196", is: "T01.defaults.196", why: "DP21 sets the timers of a PostgreSQL server, and the keepalive of the kernel at its defaults. grpc-js sets no keepalive" },
  { plan: "T01.array.197", is: "T01.defaults.197", why: "DP21 sets the timers of a PostgreSQL server: it sets no knob of these systems" },
  { plan: "T01.array.198", is: "T01.defaults.198", why: "DP21 sets the timers of a PostgreSQL server: it sets no knob of these systems" },
  { plan: "T01.array.199", is: "T01.defaults.199", why: "DP22 sets the timers and the keepalive of a PostgreSQL server. The FIN of the killed server comes before a timer can fire" },
  { plan: "T01.array.200", is: "T01.defaults.200", why: "DP23 is gRPC at its defaults" },
  {
    plan: "T01.array.202",
    is: "T01.defaults.202",
    why: "DP25 sets an aggressive keepalive of grpc-js, 10 s. Its first PING comes 10 s after the first call, after the stall of 1 s ends",
  },
  {
    plan: "T01.array.203",
    is: "T01.defaults.203",
    why: "DP40 sets a keepalive of 60 s to 300 s and a deadline on each call. With no call in flight, grpc-js sends no PING (permit_without_calls false), and no call runs: nothing changes",
  },
  { plan: "T01.array.205", is: "T01.defaults.205", why: "DP21 sets the timers of a PostgreSQL server: it sets no knob of these systems" },
];

/** These are the profiles of the array cells whose cell at the defaults waits, by the number of the cell. */
const ARRAY_PROFILES: Readonly<Record<string, string>> = {
  "39": "DP25",
  "167": "DP42",
  "204": "DP42",
  "169": "DP45",
  "170": "DP25",
  "207": "DP45",
  "171": "DP47",
  "208": "DP48",
  "13": "DP21",
  "209": "DP21",
};

/** These are the cells of the array stage that wait. Each one waits for the reason of its cell at the defaults. */
export const T01_GRPC_ARRAY_WAITING: readonly Waiting[] = T01_GRPC_WAITING.map((each) => {
  const n = each.plan.replace(/^T01\.defaults\./, "");
  const profile = ARRAY_PROFILES[n];
  if (profile === undefined) throw new Error(`${each.plan}: no profile of the array stage`);
  return { plan: `T01.array.${n}`, trigger: each.trigger, why: `as T01.defaults.${n}, under ${profile}: ${each.why}` };
});

/** This factor divides the idle timeout of the router of the borders of O03 of grpc-go: the AWS NAT form at 350 s is 35 s. */
export const GRPC_K = 10;

/** This router is the AWS NAT form with its idle timeout divided by GRPC_K: 35 s. Then it resets a late sender from inside, and it drops a late packet from outside. */
export const GRPC_ROUTER = { ...PRESETS.aws, idle: PRESETS.aws.idle / GRPC_K, preset: `${PRESETS.aws.preset}, divided by ${GRPC_K}` };

/** This value is the tcp_retries2 of the server for the borders of O17: its kernel gives up 51 s to 108.2 s after the first retransmission. */
export const GRPC_O17_RETRIES = 7;

/** These are the border cells of T01 over grpc-js-1.14 that observe the socket of the server. O03, O17 and O25 each have a setting inside and one outside. */
export const T01_GRPC_BORDER_SPECS: readonly GrpcSpec[] = [
  // ---- O03 of grpc-go: the probes of its listener refresh the flow. The keepalive of the listener moves, and the router stays at 35 s
  ...([
    ["T01.border-off.163", 15, "inside"],
    ["T01.border-off.164", 45, "outside"],
  ] as const).map(
    ([plan, keepidle, side]): GrpcSpec => ({
      plan,
      server: "grpc-go",
      name: `middlebox-forget, idle, the socket of the server, a keepalive of the listener of ${keepidle} s: ${side} O03 against the AWS NAT form at ${GRPC_ROUTER.idle} s`,
      fault: "middlebox-forget",
      mode: "idle",
      observer: "server",
      router: GRPC_ROUTER,
      ...(keepidle === 15 ? {} : { settings: { listener_keepidle: keepidle } }),
    }),
  ),
  // ---- O03 of etcd: its listener probes at 30 s, and no flag of etcd moves it. The router moves
  ...([
    ["T01.border-off.165", 45, "inside"],
    ["T01.border-off.166", 20, "outside"],
  ] as const).map(
    ([plan, idle, side]): GrpcSpec => ({
      plan,
      server: "etcd",
      name: `middlebox-forget, idle, the socket of the server: ${side} O03 for the probe of etcd at 30 s against the AWS NAT form at ${idle} s`,
      fault: "middlebox-forget",
      mode: "idle",
      observer: "server",
      router: { form: PRESETS.aws.form, idle, preset: `the AWS NAT form at ${idle} s` },
    }),
  ),
  // ---- O17 of etcd: the PING of gRPC 10 s after the last read, against the give-up of the kernel on it
  ...([
    ["T01.border-off.209", 20, "inside"],
    ["T01.border-off.210", 120, "outside"],
  ] as const).map(
    ([plan, timeout, side]): GrpcSpec => ({
      plan,
      server: "etcd",
      name: `blackhole, idle, the socket of the server, a keepalive of gRPC of 10 s and ${timeout} s, tcp_retries2 = ${GRPC_O17_RETRIES} at the server: ${side} O17`,
      fault: "blackhole",
      mode: "idle",
      observer: "server",
      settings: { keepalive_time: 10, keepalive_timeout: timeout },
      serverLinux: { tcp_retries2: count(GRPC_O17_RETRIES) },
    }),
  ),
  // ---- O25 of grpc-go: TCP_USER_TIMEOUT (the Timeout of the keepalive of gRPC) against the window of the keepalive of the listener, 150 s
  ...([
    ["T01.border-off.225", 20, "inside"],
    ["T01.border-off.226", 160, "outside"],
  ] as const).map(
    ([plan, timeout, side]): GrpcSpec => ({
      plan,
      server: "grpc-go",
      name: `blackhole, idle, the socket of the server, TCP_USER_TIMEOUT ${timeout} s: ${side} O25 against the keepalive of the listener (15 s, 15 s, 9)`,
      fault: "blackhole",
      mode: "idle",
      observer: "server",
      ...(timeout === 20 ? {} : { settings: { keepalive_timeout: timeout } }),
    }),
  ),
];

/** This value is the MinTime of the server of the harness for the borders of O26: its 5 min divided by 60, as etcd sets it. */
export const GRPC_MIN_TIME = 5;

/** This time is the hold of the call in flight of a border of O26 against grpc-go, in seconds. */
export const POLICY_HOLD = 30;

/**
 * These are the borders of O26: the PINGs of grpc-js on a stream in flight, against the MinTime of the
 * server. A keepalive of 6 s is inside the MinTime of 5 s, and one of 4 s is outside it. Against grpc-go
 * the stream is a call held 30 s, and against etcd a Watch.
 */
export const T01_GRPC_POLICY_SPECS: readonly GrpcSpec[] = [
  ...([
    ["T01.border-off.229", 6, "inside"],
    ["T01.border-off.230", 4, "outside"],
  ] as const).map(
    ([plan, keepalive, side]): GrpcSpec => ({
      plan,
      server: "grpc-go",
      name: `a call held ${POLICY_HOLD} s, the keepalive of grpc-js at ${keepalive} s: ${side} O26 against a MinTime of ${GRPC_MIN_TIME} s`,
      fault: "app-stall",
      mode: "inflight",
      options: { keepalive_time: keepalive * 1000 },
      settings: { min_time: GRPC_MIN_TIME },
      stream: { kind: "held", held: POLICY_HOLD },
    }),
  ),
  ...([
    ["T01.border-off.231", 6, "inside"],
    ["T01.border-off.232", 4, "outside"],
  ] as const).map(
    ([plan, keepalive, side]): GrpcSpec => ({
      plan,
      server: "etcd",
      name: `a Watch, the keepalive of grpc-js at ${keepalive} s: ${side} O26 against the MinTime of etcd, 5 s`,
      fault: "app-stall",
      mode: "inflight",
      options: { keepalive_time: keepalive * 1000 },
      stream: { kind: "watch" },
    }),
  ),
];

/** This function gives the name of a cell: its cell of the plan, its tuple of systems, and what it does. */
export const grpcNameOf = (spec: GrpcSpec): string => `${spec.plan} grpc-js-1.14 to ${spec.server === "grpc-go" ? "grpc-go-server" : "etcd-3.6"}, ${spec.name}`;

/**
 * This function gives the topology of a cell with a router, named for the template of its cell of the
 * plan. The router sends the ICMP errors of an unreachable host at the router, at no rate limit.
 */
const topologyOf = (spec: GrpcSpec): Pick<Cell, "topology"> => {
  if (spec.router === undefined) return {};
  const hop = routerHop(spec.router.form, spec.router.idle);
  const icmp = spec.fault === "unreachable" && spec.toward !== undefined;
  return { topology: { name: spec.plan.split(".")[0]!, hops: [icmp ? { ...hop, sysctls: { "net.ipv4.icmp_ratelimit": "0" } } : hop] } };
};

/** This function gives the operation in flight of a spec: a held call, or a Watch. */
const probeOf = (spec: GrpcSpec): { readonly hold?: { value: number; unit: string }; readonly op?: "watch" } => {
  if (spec.stream?.kind === "watch") return { op: "watch" };
  if (spec.stream?.kind === "held") return { hold: s(spec.stream.held) };
  return spec.fault === "app-stall" ? { hold: s(GRPC_HOLD) } : {};
};

/** This function gives the harness cell of a spec. */
export const grpcCell = (spec: GrpcSpec): Cell => {
  const options = spec.options === undefined ? undefined : driverOptionsOf(spec.options);
  return {
    name: grpcNameOf(spec),
    target: grpcTarget(spec.server, spec.settings),
    sysctls: sysctlsOf(linuxValues(spec.linux)),
    probe: { mode: spec.mode, keepalive: false, driver: { name: "grpc", ...probeOf(spec) } },
    fault: spec.fault,
    prediction: grpcPrediction(spec),
    ...(spec.observer === "server" ? { observer: "server" as const } : {}),
    ...topologyOf(spec),
    ...(spec.router !== undefined && spec.toward !== undefined ? { faultAt: { hop: "nat", toward: spec.toward } } : {}),
    ...(spec.drops === undefined ? {} : { drops: spec.drops }),
    ...(spec.fault === "unreachable" && spec.toward === undefined ? { targetSysctls: { "net.ipv4.icmp_ratelimit": "0" } } : {}),
    ...(spec.serverLinux === undefined ? {} : { targetSysctls: sysctlsOf(linuxValues(spec.serverLinux)) }),
    ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
    ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
    ...(options === undefined ? {} : { driverOptions: options }),
    ...(spec.before === true ? { before: true } : {}),
    runs: RUNS,
    // a killed server cannot serve the next run: each run of a fin has its own environment
    environments: spec.fault === "fin" ? RUNS : 2,
  };
};

/** These are the gRPC cells of T01 for the harness. */
export const T01_GRPC: readonly Cell[] = [...T01_GRPC_SPECS, ...T01_GRPC_ARRAY_SPECS, ...T01_GRPC_BORDER_SPECS, ...T01_GRPC_POLICY_SPECS].map(grpcCell);
