import { readFileSync } from "node:fs";
import type { Detection, KnobValues, Machine, Manifestation } from "@mark1russell7/algebra";
import {
  detection,
  errnoOf,
  machineSchema,
  overValues,
  recovery,
  stackedDetection,
  timerUnder,
} from "@mark1russell7/algebra";
import type { Cell, Fault, Prediction, Reference, Target } from "@mark1russell7/harness";
import type { Extent, Quantity, Unknown } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { ManifestationName } from "./manifestations.ts";
import { MANIFESTATIONS } from "./manifestations.ts";

/** This function reads a machine document from the fixtures of the algebra in this repository. */
const fixture = (name: string): Machine =>
  machineSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../algebra/src/fixtures/${name}.json`, import.meta.url), "utf8"),
    ),
  ) as Machine;

/** This document is Linux TCP at v6.6: the socket of the client, and the socket of the server. */
export const LINUX: Machine = fixture("linux-tcp");
/** This document is the hold of Redis on one client, over its socket. */
export const REDIS_CLIENT: Machine = fixture("redis-client");

const s = (value: number): Quantity => ({ value, unit: "s" });
const ms = (value: number): Quantity => ({ value, unit: "ms" });
const count = (value: number): Quantity => ({ value, unit: "count" });

/** This image is the target of each cell: a stock Redis 7.4, pinned by digest. */
const IMAGE = "redis:7.4@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f";
/** This target is Redis as its image starts it. */
export const REDIS: Target = {
  image: IMAGE,
  port: 6379,
  ready: "Ready to accept connections",
  settings: { set: ["redis-cli", "CONFIG", "SET"], get: ["redis-cli", "CONFIG", "GET"] },
};
/**
 * This target is Redis as the child of a shell. A `fin` fault stops the server, and the shell
 * keeps the container up. The image stays stock: only its command changes.
 */
export const REDIS_HELD: Target = {
  ...REDIS,
  command: ["sh", "-c", "redis-server & echo $! > /tmp/server.pid; while :; do sleep 3600; done"],
  kill: ["sh", "-c", 'kill -KILL "$(cat /tmp/server.pid)"'],
};

/** This count is the number of runs of each cell, as the verdict asks for. */
export const RUNS = 11;
/** This time is the window in which a silent cell must stay silent. */
export const WINDOW = 20;
/** This time is the round trip of the Docker network that the models read, without a latency. */
const RTT_MS = 1;
/** The kernel of the VM counts time at HZ 250. */
const HZ = 250;

/** These are the Linux 6.6 values of the knobs of Linux TCP. A cell gives each knob, thus nothing is left to a default. */
const LINUX_66: Readonly<Record<string, Extent>> = {
  tcp_syn_retries: count(6),
  tcp_syn_linear_timeouts: count(4),
  tcp_retries2: count(15),
  tcp_rto_min: ms(200),
  tcp_rto_max: ms(120_000),
  keepidle: s(7200),
  keepintvl: s(75),
  keepcnt: count(9),
  tcp_user_timeout: { value: "infinite", unit: "ms" },
  tcp_fin_timeout: s(60),
};
/** These are the keepalive settings of the cells: 5 s idle, then 3 probes 2 s apart, 11 s in all. */
const KEEPALIVE = { keepidle: s(5), keepintvl: s(2), keepcnt: count(3) };
/** Redis sets the keepalive of each client from tcp-keepalive: at 5 s, 5 s idle and 3 probes 1 s apart. */
const SERVER_KEEPALIVE = { tcp_keepalive: s(5), timeout: s(0) };
/** A BLPOP with a timeout of 2 s holds the request in the server, thus a reply or a close can come while it waits. */
const HELD_REQUEST = "BLPOP nothing 2";

/** A spec is one cell of the catalog, before its prediction. */
export interface Spec {
  readonly name: string;
  readonly fault: Fault;
  readonly manifestation: ManifestationName;
  readonly observer: "client" | "server";
  readonly mode: "idle" | "inflight" | "stream";
  /** These are the knobs of Linux TCP at the observer that differ from Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** These are the settings of Redis, for a cell on the server side. */
  readonly redis?: Readonly<Record<string, Extent>>;
  /** This delay goes on the egress of the target, in milliseconds. */
  readonly latency?: number;
  readonly icmp?: Cell["icmp"];
  readonly drops?: Cell["drops"];
  readonly mtu?: number;
  readonly netem?: string;
  /** This time is the length of a stall, in seconds. */
  readonly stall?: number;
  /** This text is the reason that a cell is measurement only: its outcome is a distribution. */
  readonly why?: string;
}

/**
 * The T01 catalog: the direct pair, a client and a stock Redis, crossed over its manifestations,
 * workloads, observers, timer settings and latencies. Each axis moves a prediction or tests one
 * that the algebra makes.
 */
export const SPECS: readonly Spec[] = [
  // ---- the client, idle: keepalive detects each silent fault, with the errno of the fault
  ...(
    [
      ["blackhole", "blackhole", {}],
      ["unreachable-host", "unreachable", { icmp: "host" }],
      ["unreachable-net", "unreachable", { icmp: "net" }],
      ["unreachable-port", "unreachable", { icmp: "port" }],
      ["unreachable-admin", "unreachable", { icmp: "admin" }],
      ["simplex-to-server", "simplex", { drops: "to-server" }],
      ["simplex-to-client", "simplex", { drops: "to-client" }],
      ["fin", "fin", {}],
    ] as const
  ).map(
    ([manifestation, fault, extra]): Spec => ({
      name: `client idle, ${manifestation}`,
      fault,
      manifestation,
      observer: "client",
      mode: "idle",
      linux: KEEPALIVE,
      ...extra,
    }),
  ),
  // ---- the client, a request in flight: the retransmissions detect it, at tcp_retries2 = 3
  ...(
    [
      ["blackhole", "blackhole", {}],
      ["unreachable-host", "unreachable", { icmp: "host" }],
      ["unreachable-net", "unreachable", { icmp: "net" }],
      ["unreachable-port", "unreachable", { icmp: "port" }],
      ["unreachable-admin", "unreachable", { icmp: "admin" }],
      ["simplex-to-server", "simplex", { drops: "to-server" }],
      ["simplex-to-client", "simplex", { drops: "to-client" }],
      ["fin", "fin", {}],
    ] as const
  ).map(
    ([manifestation, fault, extra]): Spec => ({
      name: `client in flight, ${manifestation}, tcp_retries2 = 3`,
      fault,
      manifestation,
      observer: "client",
      mode: "inflight",
      linux: { ...KEEPALIVE, tcp_retries2: count(3) },
      ...extra,
    }),
  ),
  // ---- tcp_retries2 = 5, where the revert of RFC 6069 moves the give-up the most
  ...(
    [
      ["blackhole", "blackhole", {}],
      ["unreachable-host", "unreachable", { icmp: "host" }],
    ] as const
  ).map(
    ([manifestation, fault, extra]): Spec => ({
      name: `client in flight, ${manifestation}, tcp_retries2 = 5`,
      fault,
      manifestation,
      observer: "client",
      mode: "inflight",
      linux: { ...KEEPALIVE, tcp_retries2: count(5) },
      ...extra,
    }),
  ),
  // ---- the latency axis: a longer round trip is a longer RTO, and each step of the ladder moves
  ...([20, 100] as const).flatMap((latency) =>
    (
      [
        ["blackhole", "blackhole", {}],
        ["unreachable-host", "unreachable", { icmp: "host" }],
      ] as const
    ).map(
      ([manifestation, fault, extra]): Spec => ({
        name: `client in flight, ${manifestation}, tcp_retries2 = 3, ${latency} ms latency`,
        fault,
        manifestation,
        observer: "client",
        mode: "inflight",
        linux: { ...KEEPALIVE, tcp_retries2: count(3) },
        latency,
        ...extra,
      }),
    ),
  ),
  // ---- a frozen process: its kernel acknowledges, and nothing detects it
  {
    name: "client in flight, freeze-process",
    fault: "freeze-process",
    manifestation: "freeze-process",
    observer: "client",
    mode: "inflight",
    linux: { ...KEEPALIVE, tcp_retries2: count(3) },
  },
  // ---- recovery from a stall, at each latency: the first firing after the stall, one round trip later
  ...(
    [
      [1, 0],
      [1, 20],
      [1, 100],
      [3.5, 0],
      [3.5, 100],
    ] as const
  ).map(
    ([stall, latency]): Spec => ({
      name: `client in flight, a ${stall} s stall${latency === 0 ? "" : `, ${latency} ms latency`}`,
      fault: "stall",
      manifestation: "blackhole",
      observer: "client",
      mode: "inflight",
      stall,
      ...(latency === 0 ? {} : { latency }),
    }),
  ),
  // ---- the server: its keepalive from tcp-keepalive, and its retransmissions of a reply
  ...(
    [
      ["blackhole", "blackhole", {}],
      ["unreachable-host", "unreachable", { icmp: "host" }],
      ["simplex-to-server", "simplex", { drops: "to-server" }],
      ["simplex-to-client", "simplex", { drops: "to-client" }],
      ["fin", "fin", {}],
    ] as const
  ).map(
    ([manifestation, fault, extra]): Spec => ({
      name: `server idle, ${manifestation}`,
      fault,
      manifestation,
      observer: "server",
      mode: "idle",
      redis: SERVER_KEEPALIVE,
      ...extra,
    }),
  ),
  ...(
    [
      ["blackhole", "blackhole", {}],
      ["unreachable-host", "unreachable", { icmp: "host" }],
      ["simplex-to-server", "simplex", { drops: "to-server" }],
      ["simplex-to-client", "simplex", { drops: "to-client" }],
    ] as const
  ).map(
    ([manifestation, fault, extra]): Spec => ({
      name: `server, a reply in flight, ${manifestation}, tcp_retries2 = 3`,
      fault,
      manifestation,
      observer: "server",
      mode: "inflight",
      linux: { tcp_retries2: count(3) },
      redis: SERVER_KEEPALIVE,
      ...extra,
    }),
  ),
  {
    name: "server idle, freeze-process",
    fault: "freeze-process",
    manifestation: "freeze-process",
    observer: "server",
    mode: "idle",
    redis: SERVER_KEEPALIVE,
  },
  // ---- an MTU black hole: the server cannot send a 2 MB value in segments over 1200 bytes
  {
    name: "server, a long reply, mtu-blackhole, tcp_retries2 = 3",
    fault: "mtu-blackhole",
    manifestation: "mtu-blackhole",
    observer: "server",
    mode: "inflight",
    linux: { tcp_retries2: count(3) },
    redis: SERVER_KEEPALIVE,
    mtu: 1200,
  },
  // ---- distributions: netem on each segment from the server, measured and not judged
  ...(
    [
      ["loss 5%", "a lost segment waits for a retransmission"],
      ["loss 20%", "a lost segment waits for a retransmission"],
      ["duplicate 10%", "a duplicate costs nothing but a duplicate ACK"],
      ["delay 10ms reorder 25% 50%", "a segment out of order can start a fast retransmission"],
      ["corrupt 5%", "a corrupt segment fails its checksum, as a lost one does"],
      ["delay 20ms 10ms", "a jitter moves the RTO, which the round trip of one sample does not give"],
    ] as const
  ).map(
    ([netem, reason]): Spec => ({
      name: `client stream, netem ${netem}`,
      fault: "netem",
      manifestation: "blackhole",
      observer: "client",
      mode: "stream",
      netem,
      why: `its reply times are a distribution: ${reason}. A simulator predicts it, and the algebra does not`,
    }),
  ),
];

/** This function gives the values of a cell's knobs: Linux 6.6, then the knobs that the cell sets, then the environment. */
const linuxValues = (spec: Spec): Record<string, Extent> => ({
  ...LINUX_66,
  ...spec.linux,
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(RTT_MS + (spec.latency ?? 0)),
});
const given =
  (values: Readonly<Record<string, Extent>>): KnobValues =>
  (name) =>
    values[name];

/** This function gives the number of seconds of an extent, or fails when nothing gives it. */
const seconds = (extent: Extent | Unknown | undefined, what: string): number => {
  if (extent === undefined) return 0;
  if ("unknown" in extent) throw new Error(`${what}: ${extent.unknown}`);
  if (extent.value === "infinite") throw new Error(`${what} has no bound`);
  return valueIn(extent as Quantity, "s");
};
const q = (value: number): Quantity => ({ value: Math.round(value * 1e9) / 1e9, unit: "s" });

/** This function gives the event that arms a timer, as the reference event of a measurement. */
const referenceOf = (timer: string): Reference => {
  const arms = LINUX.timers[timer]?.arms ?? [];
  if (arms.includes("tx.retransmit.first")) return "first-retransmission";
  if (arms.includes("rx.ack")) return "last-received";
  throw new Error(`no reference for ${timer}: it is armed by ${arms.join(", ")}`);
};

/** This function gives the prediction of a cell from the algebra. */
export const predict = (spec: Spec): Prediction => {
  if (spec.why !== undefined) return { detects: null, window: q(30), why: spec.why };
  const linux = linuxValues(spec);
  const rtt = seconds(linux["rtt"], "rtt");
  const manifestation: Manifestation = MANIFESTATIONS[spec.manifestation];

  if (spec.stall !== undefined) {
    // nothing may detect a stall in its window: the give-up must outlast it
    const giveUp = detection(LINUX, { state: "ESTABLISHED", inFlight: true }, manifestation, given(linux));
    if (giveUp.first !== null && seconds(giveUp.first.duration, "the give-up") <= WINDOW)
      throw new Error(`${spec.name}: ${giveUp.first.timer} can detect the stall in its window`);
    const after = recovery(LINUX, "retransmit", given(linux), s(spec.stall));
    if ("unknown" in after) throw new Error(`${spec.name}: ${after.unknown}`);
    if (after.first.length !== 1)
      throw new Error(`${spec.name}: the stall ends in the bounds of firing ${after.first[0]}`);
    const firing = after.first[0]!;
    const heal = {
      low: after.firings.find((each) => each.fired === firing - 1)?.high ?? q(0),
      high: after.firings.find((each) => each.fired === firing)!.low,
    };
    return {
      detects: false,
      window: q(WINDOW),
      recovers: { firing, low: after.low, high: q(valueIn(after.high, "s") + rtt), heal },
    };
  }

  const situation = { inFlight: spec.mode !== "idle" };
  const redis = { ...SERVER_KEEPALIVE, ...spec.redis, hz: { value: HZ, unit: "Hz" } };
  const found: Detection =
    spec.observer === "server"
      ? stackedDetection(
          REDIS_CLIENT,
          LINUX,
          { state: "CONNECTED", ...situation },
          manifestation,
          given(redis),
          given(linux),
        )
      : detection(LINUX, { state: "ESTABLISHED", ...situation }, manifestation, given(linux));
  const [delivered] = found.delivered;
  if (delivered !== undefined) {
    // a FIN comes one way: from the change of state of the peer to the change of the observer
    return {
      detects: true,
      timer: delivered.event,
      errno: delivered.errno ?? "EOF",
      from: "peer-closed",
      low: q(0),
      high: q(rtt),
    };
  }
  if (found.unsettled.length > 0)
    throw new Error(`${spec.name}: a live detector has no time: ${found.unsettled.join(", ")}`);
  if (found.first === null) return { detects: false, window: q(WINDOW) };
  const { timer, fires } = found.first;
  // the values of the socket: for the server, those that Redis sets over its kernel's
  const values =
    spec.observer === "server" ? overValues(REDIS_CLIENT, given(redis), given(linux)) : given(linux);
  const bounds = timerUnder(LINUX, timer, values, manifestation);
  const duration = seconds(bounds.duration, timer);
  return {
    detects: true,
    timer,
    errno: errnoOf(LINUX, "ESTABLISHED", { timer, fires }, manifestation) ?? "ETIMEDOUT",
    from: referenceOf(timer),
    low: q(duration - seconds(bounds.early, `${timer}'s early bound`)),
    high: q(duration + seconds(bounds.lateness, `${timer}'s lateness`)),
  };
};

/** This function gives the sysctls of the namespace knobs of Linux TCP, by their keys. */
const sysctlsOf = (values: Readonly<Record<string, Extent>>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, knob] of Object.entries(LINUX.knobs)) {
    if (knob.scope !== "netns") continue;
    const value = values[name];
    if (value === undefined || value.value === "infinite")
      throw new Error(`${name} has no value to set`);
    out[knob.key] = String(knob.unit === null || knob.unit === "count" ? value.value : valueIn(value as Quantity, knob.unit));
  }
  return out;
};

/** This function gives the cell of a spec for the harness, with its prediction. */
export const cellOf = (spec: Spec): Cell => {
  const server = spec.observer === "server";
  const linux = linuxValues(spec);
  const namespace = sysctlsOf(linux);
  // the namespace that sends an ICMP sets its rate limit to 0, thus each segment draws one
  const icmp = spec.fault === "unreachable" ? { "net.ipv4.icmp_ratelimit": "0" } : {};
  const sysctls = server ? icmp : namespace;
  const targetSysctls = server
    ? { ...namespace, ...(spec.fault === "mtu-blackhole" ? { "net.ipv4.tcp_mtu_probing": "0" } : {}) }
    : icmp;
  const targetSettings = server
    ? Object.fromEntries(
        Object.entries({ ...SERVER_KEEPALIVE, ...spec.redis }).map(([name, value]) => [
          REDIS_CLIENT.knobs[name]!.key.replace(/^redis /, ""),
          String(valueIn(value as Quantity, "s")),
        ]),
      )
    : {};
  const request =
    spec.fault === "mtu-blackhole" ? "GET big" : server || spec.fault === "fin" ? HELD_REQUEST : undefined;
  const probe: Cell["probe"] = {
    mode: spec.mode,
    // the server must notice first, thus its client has no keepalive of its own
    keepalive: !server,
    ...(spec.mode !== "idle" && request !== undefined ? { request } : {}),
    ...(spec.mode === "stream" ? { count: 100, interval: ms(10) } : {}),
  };
  // a killed server cannot serve the next run: each run of a client fin cell has its own environment
  const killsServer = spec.fault === "fin" && !server;
  return {
    name: `T01 ${spec.name}`,
    target: killsServer ? REDIS_HELD : REDIS,
    sysctls,
    probe,
    fault: spec.fault,
    prediction: predict(spec),
    ...(server ? { observer: "server" as const } : {}),
    ...(Object.keys(targetSettings).length === 0 ? {} : { targetSettings }),
    ...(Object.keys(targetSysctls).length === 0 ? {} : { targetSysctls }),
    ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
    ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
    ...(spec.drops === undefined ? {} : { drops: spec.drops }),
    ...(spec.mtu === undefined ? {} : { mtu: spec.mtu }),
    ...(spec.netem === undefined ? {} : { netem: spec.netem }),
    ...(spec.latency === undefined ? {} : { latency: ms(spec.latency) }),
    ...(spec.fault === "mtu-blackhole"
      ? {
          targetSetup: [
            ["sh", "-c", "head -c 2000000 /dev/zero | tr '\\000' x | redis-cli -x SET big > /dev/null"],
          ],
        }
      : {}),
    runs: RUNS,
    environments: killsServer ? RUNS : 2,
  };
};

/** These are the cells of the T01 catalog, in the sequence of the specs. */
export const CELLS: readonly Cell[] = SPECS.map(cellOf);
