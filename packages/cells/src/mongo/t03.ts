import { realizationOf } from "@mark1russell7/algebra";
import { transitionOn } from "@mark1russell7/algebra";
import { LINUX_TCP, MONGODB_NODE, NF_CONNTRACK_TCP } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { RTT_MS, given, s, seconds } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import { LISTING, ROUTER_PUMP, o03 } from "../topologies.ts";
import type { Alias, MongoCell, MongoPrediction, MongoRouter, MongoSpec, Waiting } from "./cells.ts";
import { sec } from "./cells.ts";
import type { DriverOptions, Span } from "./model.ts";
import { driverValues, firstOn, linuxValues, plus, realizedSpan, secondsOf, sessionKeepalive, span, spanOf } from "./model.ts";
import { OP_ERROR, POOL_RX, SOCKET_END, WRITE_OFF, assumingSingle, bandOf, predictSingle } from "./single.ts";
import { nameOf } from "./t01.ts";

/**
 * The MongoDB catalog of T03: the driver, a NAT router with conntrack, and a replica set of one
 * member. Each router stands for a cloud preset: its form and its idle timeout. The defaults stage
 * gives each preset its own idle timeout, in real time. The border cells of a forgotten flow
 * divide each timer of the chain by one factor, `K`.
 */

/** These are the routers of the plan's presets, at their own idle timeouts. */
export const PRESETS = {
  aws: { form: "reset-next", idle: 350, preset: "the AWS NAT or NLB form: 350 s, a reset to the next sender" },
  azureNat: { form: "reset-next", idle: 240, preset: "the Azure NAT form: 240 s, then a reset to a late sender from inside" },
  azureLbReset: { form: "reset-both", idle: 240, preset: "the Azure LB with TCP reset, as AKS sets it: 240 s, a reset to both ends" },
  azureLb: { form: "silent-drop", idle: 240, preset: "the Azure LB default: 240 s, then a silent drop" },
  gcp: { form: "silent-drop", idle: 600, preset: "the GCP firewall form: 600 s, then a silent drop" },
  linux: { form: "none", idle: 432000, preset: "a plain router at the conntrack default of Linux: 432000 s" },
} as const satisfies Readonly<Record<string, MongoRouter>>;

/** This factor divides each timer of a border cell of a forgotten flow: 240 s is 12 s, and the driver's 120 s keepalive delay is 6 s. */
export const K = 20;

/** This function gives a router of a preset with its timer divided by `K`. */
const scaled = (router: MongoRouter): MongoRouter => ({ ...router, idle: router.idle / K, preset: `${router.preset}, divided by ${K}` });

/** These are the options of the driver with each timer divided by `K`, and a keepalive delay in whole seconds. */
const scaledDriver = (keepAliveSeconds: number): DriverOptions => ({
  heartbeatFrequencyMS: 10000 / K,
  connectTimeoutMS: 30000 / K,
  serverSelectionTimeoutMS: 30000 / K,
  keepAliveInitialDelay: keepAliveSeconds * 1000,
});

/** This function gives the values of conntrack for a router: its idle timeout, and the lag of its DESTROY. */
const routerValues = (idle: number) =>
  given({
    nf_conntrack_tcp_timeout_established: s(idle),
    gc_lag_max: s(valueIn(ROUTER_PUMP, "s") + 2 * valueIn(LISTING, "s")),
  });

/** These are the cells of T03 over mongodb-node-7.7 and mongodb-replset. */
export const T03_MONGO_SPECS: readonly MongoSpec[] = [
  // ---- the defaults stage: each preset at its own idle timeout
  { plan: "T03.defaults.1", name: "middlebox-forget, idle for 400 s, AWS NAT form", fault: "middlebox-forget", mode: "idle", router: PRESETS.aws, hold: 400 },
  { plan: "T03.defaults.2", name: "blackhole at the router, a write in flight, Azure NAT form", fault: "blackhole", mode: "inflight", router: PRESETS.azureNat, toward: "client" },
  {
    plan: "T03.defaults.3",
    name: "unreachable-host at the router, idle, Azure LB with TCP reset",
    fault: "unreachable",
    mode: "idle",
    icmp: "host",
    router: PRESETS.azureLbReset,
    toward: "client",
  },
  {
    plan: "T03.defaults.4",
    name: "mtu-blackhole at the router, a read of a 2 MB document, GCP firewall form",
    fault: "mtu-blackhole",
    mode: "inflight",
    op: "read-long",
    mtu: 1200,
    router: PRESETS.gcp,
    // the rule drops each long segment that comes from the side it faces: the reply comes from the target
    toward: "target",
  },
  { plan: "T03.defaults.5", name: "a 1 s stall at the router, a write in flight, a plain router", fault: "stall", mode: "inflight", stall: 1, router: PRESETS.linux, toward: "client" },
  {
    plan: "T03.defaults.28",
    name: "blackhole at the router, mongod's socket for an idle pool connection, AWS NAT form",
    fault: "blackhole",
    mode: "idle",
    observer: "server",
    router: PRESETS.aws,
    toward: "client",
  },
  { plan: "T03.defaults.38", name: "rst at the router, a write in flight, GCP firewall form", fault: "rst", mode: "inflight", router: PRESETS.gcp, toward: "client" },
  {
    plan: "T03.defaults.39",
    name: "simplex-to-client at the router, a write in flight, GCP firewall form",
    fault: "simplex",
    drops: "to-client",
    mode: "inflight",
    router: PRESETS.gcp,
    toward: "client",
  },
  { plan: "T03.defaults.41", name: "fin, idle, Azure NAT form", fault: "fin", mode: "idle", router: PRESETS.azureNat },
  // ---- the border stage: O03 on each side, with each timer divided by K
  ...(
    [
      ["T03.border-off.7", "T03.border-off.8", PRESETS.azureLbReset],
      ["T03.border-off.9", "T03.border-off.10", PRESETS.azureNat],
      ["T03.border-off.11", "T03.border-off.12", PRESETS.azureLb],
    ] as const
  ).flatMap(([inside, outside, router]): MongoSpec[] => [
    {
      plan: inside,
      name: `middlebox-forget, an idle pool connection, keepAliveInitialDelay 11 s, ${router.form} at ${router.idle / K} s`,
      fault: "middlebox-forget",
      mode: "idle",
      router: scaled(router),
      options: scaledDriver(11),
      hold: 30,
    },
    {
      plan: outside,
      name: `middlebox-forget, an idle pool connection, keepAliveInitialDelay 13 s, ${router.form} at ${router.idle / K} s`,
      fault: "middlebox-forget",
      mode: "idle",
      router: scaled(router),
      options: scaledDriver(13),
      hold: 30,
    },
  ]),
  // ---- O17's border for the monitor through a router that drops a forgotten flow: its heartbeat against the idle timeout
  {
    plan: "T01.border-off.207",
    name: "middlebox-forget, the monitor's heartbeat 11 s, silent-drop at 12 s",
    fault: "middlebox-forget",
    mode: "idle",
    router: scaled(PRESETS.azureLb),
    options: { ...scaledDriver(6), heartbeatFrequencyMS: 11000 },
    hold: 30,
  },
  {
    plan: "T01.border-off.208",
    name: "middlebox-forget, the monitor's heartbeat 13 s, silent-drop at 12 s: the keepalive at 6 s refreshes the flow",
    fault: "middlebox-forget",
    mode: "idle",
    router: scaled(PRESETS.azureLb),
    options: { ...scaledDriver(6), heartbeatFrequencyMS: 13000 },
    hold: 30,
  },
];

/** This is the mechanism of the corpus that the delay of an ACK is. */
export const ACK_DELAY = "systems.mechanism.ack-delay";
/**
 * This function gives the delay of the client's ACK of the last reply, in seconds, from the document
 * of Linux TCP. The ACK goes at once in quick-ACK mode. Else the delayed-ACK timer sends it after
 * max(TCP_DELACK_MIN, srtt) at most, 40 ms on a fast path, rounded on the wheel.
 */
export const delayedAck = (rtt: number): Span => realizedSpan(LINUX_TCP, ACK_DELAY, given(linuxValues({}, rtt * 1000)));

/**
 * This function gives the prediction of a forgotten flow, at a round trip in ms. O03 decides it for
 * each flow of the driver against the router's idle timeout. The pool connection refreshes its flow
 * by its keepalive. The monitor refreshes its flow by its heartbeat or its keepalive, the first of
 * the two. When O03 holds for each
 * flow, nothing occurs. When it fails for the idle pool connection, the form decides, as for the
 * TCP client.
 */
const predictForget = (spec: MongoSpec, rttMs: number): MongoPrediction => {
  const rtt = rttMs / 1000;
  const router = spec.router!;
  const conntrack = routerValues(router.idle);
  const raw = driverValues(spec.options, rttMs);
  const values = given(raw);
  const window = sec(spec.hold ?? 30);
  const pool = o03({ doc: MONGODB_NODE, values }, conntrack, rtt);
  // the monitor's flow gets a reply each heartbeat, and a keepalive probe after each idle delay
  const heartbeat = secondsOf(raw, "heartbeatFrequencyMS");
  const refresh = Math.min(heartbeat + rtt, pool.refresh === "inf" ? Number.POSITIVE_INFINITY : pool.refresh);
  if (!(refresh < pool.forget - pool.margin)) throw new Error(`${spec.name}: the router can forget the monitor's flow`);
  if (pool.holds) return { detects: false, bands: [], window, quiet: [WRITE_OFF, SOCKET_END, OP_ERROR, "the router forgets a flow"] };
  // the client's delayed ACK of the last reply is the last segment of the flow: the idle time counts from it
  const forget = plus(delayedAck(rtt), spanOf(NF_CONNTRACK_TCP, "expire_established", conntrack));
  const reset = transitionOn(LINUX_TCP, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET";
  if (router.form === "reset-both")
    return { detects: true, bands: [bandOf("the router forgets the flow and resets both ends", reset, POOL_RX, forget)], window, quiet: [WRITE_OFF] };
  const first = realizationOf(MONGODB_NODE, "systems.mechanism.idle-refresh-interval", values)!;
  const probe: Span = span(
    seconds(first.duration, "the delay") - seconds(first.early, "early"),
    seconds(first.duration, "the delay") + seconds(first.lateness, "lateness"),
  );
  if (!(probe.lo > forget.hi)) throw new Error(`${spec.name}: the first probe can come before the forget`);
  if (router.form === "reset-next")
    return { detects: true, bands: [bandOf("the first keepalive probe meets the router's reset", reset, POOL_RX, plus(probe, span(0, rtt)))], window, quiet: [WRITE_OFF] };
  // silent-drop: the probes go into nothing, and the kernel gives up at the end of the window
  const ends = firstOn({ role: "pool", inFlight: false, manifestation: MANIFESTATIONS.blackhole }, values, given(linuxValues({}, rttMs)));
  if (ends.kind !== "timer") throw new Error(`${spec.name}: nothing ends the pool connection`);
  return { detects: true, bands: [bandOf(`the probes go into nothing: ${ends.timer}`, ends.name, POOL_RX, ends.band)], window, quiet: [WRITE_OFF] };
};

/** This function gives the prediction of a cell of T03, at a round trip in ms. */
export const predictT03Mongo = (spec: MongoSpec, rttMs = RTT_MS): MongoPrediction => {
  if (spec.fault === "middlebox-forget") return predictForget(spec, rttMs);
  if (spec.observer === "server") {
    // mongod's keepalive on its socket of the idle pool connection: 300 s, then 9 probes 1 s apart
    const window = sessionKeepalive();
    const router = spec.router!;
    if (!(window.hi < router.idle)) throw new Error(`${spec.name}: the router can forget the flow before mongod's keepalive ends`);
    return {
      detects: true,
      bands: [bandOf("mongod's keepalive ends its socket of the pool connection", "ETIMEDOUT", { socket: "server", event: "last-received" }, window)],
      window: sec(window.hi + 10),
      quiet: [],
    };
  }
  return predictSingle(spec, rttMs);
};

/** These are the cells of the plan that are another cell of the catalogs. */
export const T03_MONGO_ALIASES: readonly Alias[] = [
  { plan: "T03.defaults.40", is: "T03.defaults.1", why: "an idle connection through the AWS NAT form is the forgotten flow of T03.defaults.1" },
  { plan: "T03.defaults.66", is: "T03.defaults.1", why: "the earlier epoch changes HikariCP's keepalive, which this chain does not have" },
  { plan: "T03.border-off.31", is: "T01.border-off.21", why: "the keepalive delay of the driver: the router changes nothing in the black hole" },
  { plan: "T03.border-off.32", is: "T01.border-off.22", why: "the keepalive delay of the driver: the router changes nothing in the black hole" },
  { plan: "T03.border-off.75", is: "T01.border-off.75", why: "the monitor's write-off at the tuned knobs: the router changes nothing in a freeze" },
  { plan: "T03.border-off.76", is: "T01.border-off.76", why: "the monitor's write-off at the tuned knobs: the router changes nothing in a freeze" },
  { plan: "T03.border-off.89", is: "T01.border-off.51", why: "the kernel's give-up against the write-off: the router keeps the flow while it retransmits" },
  { plan: "T03.border-off.90", is: "T01.border-off.52", why: "the kernel's give-up against the write-off: the router keeps the flow while it retransmits" },
  { plan: "T03.border-off.91", is: "T01.border-off.59", why: "a frozen server inside the write-off: the router changes nothing" },
  { plan: "T03.border-off.92", is: "T01.border-off.60", why: "a frozen server outside the write-off: the router changes nothing" },
  { plan: "T03.border-off.97", is: "T01.border-off.59", why: "the monitor's write-off: the router changes nothing" },
  { plan: "T03.border-off.98", is: "T01.border-off.60", why: "the monitor's write-off: the router changes nothing" },
];

const ALIASED = new Set([7, 8, 9, 10, 11, 12, 31, 32, 75, 76, 89, 90, 91, 92, 97, 98]);
/** These are the reasons of the waiting border cells of T03, by the first cell of each range. */
const REASONS: ReadonlyArray<readonly [number, number, string]> = [
  [1, 6, "a breakpoint of conntrack or of a preset at the Linux keepalive defaults: the driver's own keepalive of 120 s keeps each of its flows"],
  [13, 14, "the breakpoint names another system's setting: this chain has no such knob"],
  [15, 28, "a breakpoint of conntrack or of a preset alone: the TCP client's cells of T03 place it"],
  [29, 30, "the driver's maxIdleTimeMS has no timer: the pool checks it only at a check-out (connection_pool.ts:584)"],
  [33, 62, "a breakpoint of Linux TCP alone: the monitor's write-off at 40 s ends the request before each time that it moves"],
  [63, 68, "a breakpoint of the path MTU alone: T03.defaults.4 shows that nothing of the driver ends a read that the MTU stops"],
  [69, 74, "the breakpoint names another system's setting: this chain has no such knob"],
  [77, 88, "the breakpoint names another system's setting: this chain has no such knob"],
  [93, 96, "the breakpoint names another system's setting: this chain has no such knob"],
  [99, 112, "the rule's verdict names servers at the Linux keepalive defaults: mongod's keepalive is 300 s, which T03.defaults.28 times"],
  [113, 118, "a rule of two stateful hops in series, or of a kind node: the chain has one router"],
];

/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T03_MONGO_WAITING: readonly Waiting[] = REASONS.flatMap(([from, to, why]) =>
  Array.from({ length: to - from + 1 }, (_, at) => from + at)
    .filter((n) => !ALIASED.has(n))
    .map((n): Waiting => ({ plan: `T03.border-off.${n}`, trigger: "border", why })),
);

/** These are the cells of the MongoDB catalog of T03, with their predictions. */
export const T03_MONGO: readonly MongoCell[] = T03_MONGO_SPECS.map((spec) => ({
  spec,
  name: nameOf(spec),
  prediction: assumingSingle(spec, predictT03Mongo),
}));
