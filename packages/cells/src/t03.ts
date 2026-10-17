import type { KnobValues } from "@mark1russell7/algebra";
import {
  detection,
  overValues,
  realizationOf,
  recovery,
  stackedDetection,
  timerOf,
  timerUnder,
  transitionOn,
} from "@mark1russell7/algebra";
import type { Cell, MiddleboxForm, Prediction } from "@mark1russell7/harness";
import { LINUX_TCP, NF_CONNTRACK_TCP, REDIS_CLIENT } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Spec } from "./catalog.ts";
import {
  HZ,
  KEEPALIVE,
  LINUX_66,
  REDIS,
  RTT_MS,
  RUNS,
  count,
  given,
  ms,
  predictAt,
  q,
  s,
  seconds,
  sysctlsOf,
} from "./catalog.ts";
import type { ManifestationName } from "./manifestations.ts";
import { MANIFESTATIONS } from "./manifestations.ts";
import { assuming } from "./rtt.ts";
import type { O03Verdict } from "./topologies.ts";
import { LISTING, ROUTER_PUMP, o03, router } from "./topologies.ts";

/** This time is the idle timeout of the router, nf_conntrack_tcp_timeout_established: 5 s, a cloud NAT's 350 s scaled by 70. */
export const IDLE = 5;
/** This time is the window of a silent T03 cell: longer than each detection that a forgotten flow can give. */
const WINDOW = 15;
/** This time is how long an in-flight client stays idle before its request: longer than the latest forget. */
const IDLE_BEFORE = 8;

/** A T03 spec is one cell of the stateful middlebox chain, before its prediction. */
export interface T03Spec {
  readonly name: string;
  readonly form: MiddleboxForm;
  readonly observer: "client" | "server";
  readonly mode: "idle" | "inflight";
  /** This time is the keepalive idle time of the client, in seconds: its interval is 1 s, and its count 3. Without it, the client has no keepalive. */
  readonly keepidle?: number;
  /** This time is tcp-keepalive of Redis, in seconds, for a cell on the server side. */
  readonly redisKeepalive?: number;
  /** This count is tcp_retries2 of the client. */
  readonly retries?: number;
}

/**
 * The T03 catalog: client → NAT router (conntrack) → Redis 7.4. The router forgets an idle flow at
 * 5 s, and its form tells what a late packet then meets. The keepalive of the endpoint is on each
 * side of the border of O03. At 4 s, it refreshes the flow before the router forgets it. At 6 s, it does not.
 */
export const T03_SPECS: readonly T03Spec[] = [
  // ---- DV-12's three cases, with the keepalive of the client on each side of the border of O03
  ...(["reset-both", "reset-next", "silent-drop"] as const).flatMap((form) =>
    [4, 6].map(
      (keepidle): T03Spec => ({
        name: `client idle, ${form}, keepidle ${keepidle} s`,
        form,
        observer: "client",
        mode: "idle",
        keepidle,
      }),
    ),
  ),
  // ---- the next packet is a request after an idle time, with no keepalive at all
  { name: "client in flight after 8 s idle, reset-next", form: "reset-next", observer: "client", mode: "inflight" },
  {
    name: "client in flight after 8 s idle, silent-drop, tcp_retries2 = 3",
    form: "silent-drop",
    observer: "client",
    mode: "inflight",
    retries: 3,
  },
  { name: "client in flight after 8 s idle, recreate", form: "recreate", observer: "client", mode: "inflight" },
  // ---- the server's keepalive (tcp-keepalive of Redis) against the router: a reset to both, to one side, or none
  ...(["reset-both", "reset-next", "none"] as const).map(
    (form): T03Spec => ({
      name: `server idle, ${form}, tcp-keepalive 6 s`,
      form,
      observer: "server",
      mode: "idle",
      redisKeepalive: 6,
    }),
  ),
  { name: "server idle, reset-both, tcp-keepalive 4 s", form: "reset-both", observer: "server", mode: "idle", redisKeepalive: 4 },
];

/** These are the values of the conntrack document for the router of T03: its idle timeout, and the lag of its DESTROY. */
export const routerValues: KnobValues = given({
  nf_conntrack_tcp_timeout_established: s(IDLE),
  // the pump lists the table every PUMP, and each listing takes LISTING at most
  gc_lag_max: s(valueIn(ROUTER_PUMP, "s") + 2 * valueIn(LISTING, "s")),
});

/** This function gives the values of Linux TCP at the client of a spec, at a round trip in ms. */
const clientValues = (spec: T03Spec, rttMs = RTT_MS): Record<string, Extent> => ({
  ...LINUX_66,
  ...(spec.keepidle === undefined ? {} : { keepidle: s(spec.keepidle), keepintvl: s(1), keepcnt: count(3) }),
  ...(spec.retries === undefined ? {} : { tcp_retries2: count(spec.retries) }),
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(rttMs),
});
const redisValues = (spec: T03Spec): Record<string, Extent> => ({
  tcp_keepalive: s(spec.redisKeepalive ?? 300),
  timeout: s(0),
  hz: { value: HZ, unit: "Hz" },
});

/** This function gives the errno of a reset at an established socket, from the Linux TCP document. */
const resetErrno = (): string => transitionOn(LINUX_TCP, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET";

/** This function gives the band of a timer: its duration less how early it fires, to its duration plus how late, plus a delay. */
const band = (
  bounds: { duration: Extent | { unknown: string }; lateness?: unknown; early?: unknown },
  what: string,
  plus = 0,
): { low: ReturnType<typeof q>; high: ReturnType<typeof q> } => {
  const duration = seconds(bounds.duration as Extent, what);
  return {
    low: q(duration - seconds(bounds.early as Extent | undefined, `${what}'s early bound`)),
    high: q(duration + seconds(bounds.lateness as Extent | undefined, `${what}'s lateness`) + plus),
  };
};

/** This band is when the router forgets a flow after its last packet: expire_established, late by the pump and two listings at most. */
const forgetBand = (): { low: ReturnType<typeof q>; high: ReturnType<typeof q> } =>
  band(timerOf(NF_CONNTRACK_TCP, "expire_established", routerValues), "expire_established");

/**
 * This function tells if the socket of the observer of a spec has keepalive on. The client sets
 * SO_KEEPALIVE only when the spec gives it a keepalive idle time. Redis sets it on each client
 * when its tcp-keepalive is more than 0.
 */
export const keepaliveOn = (spec: T03Spec): boolean =>
  spec.observer === "server" ? (spec.redisKeepalive ?? 300) > 0 : spec.keepidle !== undefined;

/**
 * This function gives the O03 verdict of a spec: the keepalive of its observer against the router,
 * at a round trip in ms. The refresh comes from the keepalive of the socket as it is. A socket
 * without keepalive refreshes nothing, whatever the keepalive sysctls of its namespace say. Thus
 * its refresh has no bound, and O03 does not hold by its construction.
 */
export const o03Of = (spec: T03Spec, rttMs = RTT_MS): O03Verdict => {
  const off: Extent = { value: "infinite", unit: "s" };
  if (spec.observer === "server") {
    const redis = redisValues(spec);
    return o03({ doc: REDIS_CLIENT, values: given(keepaliveOn(spec) ? redis : { ...redis, tcp_keepalive: off }) }, routerValues, rttMs / 1000);
  }
  const linux = clientValues(spec, rttMs);
  return o03({ doc: LINUX_TCP, values: given(keepaliveOn(spec) ? linux : { ...linux, keepidle: off }) }, routerValues, rttMs / 1000);
};

/**
 * This function gives the prediction of a T03 cell from the algebra, with the range of first round
 * trips that its band assumes. The conntrack document gives the forget, and Linux TCP gives the
 * endpoint. O03 decides if the forget occurs at all.
 * - When O03 holds, the keepalive refreshes the flow, and nothing detects anything in the window.
 * - When it does not, the form decides. A reset to both ends comes at the forget. A reset to the
 *   next packet comes at the first send after the forget. A silent drop leaves the endpoint to its
 *   own give-up: keepalive, or the retransmissions of a request.
 */
export const predictT03 = (spec: T03Spec): Prediction => assuming((rtt) => predictT03At(spec, rtt), RTT_MS);

const predictT03At = (spec: T03Spec, rttMs: number): Prediction => {
  const rtt = rttMs / 1000;
  const verdict = o03Of(spec, rttMs);
  const forget = forgetBand();
  if (spec.mode === "inflight") {
    // the request goes after the latest forget: it meets a router that forgot the flow
    if (!(IDLE_BEFORE > valueIn(forget.high, "s") + verdict.margin))
      throw new Error(`${spec.name}: the request can go before the router forgets the flow`);
    const linux = given(clientValues(spec, rttMs));
    if (spec.form === "reset-next")
      return { detects: true, timer: "rx.rst", errno: resetErrno(), from: "request-sent", low: q(0), high: q(rtt) };
    if (spec.form === "recreate") {
      // nf_conntrack_tcp_loose lets a mid-stream ACK make a new ESTABLISHED entry (ct.none.established)
      const pickup = transitionOn(NF_CONNTRACK_TCP, "NONE", "orig.ack");
      if (pickup?.to !== "ESTABLISHED") throw new Error(`${spec.name}: conntrack picks up no flow mid-stream`);
      return { detects: false, window: q(2), replies: { low: q(0), high: q(rtt) } };
    }
    const found = detection(LINUX_TCP, { state: "ESTABLISHED", inFlight: true }, MANIFESTATIONS.blackhole, linux);
    if (found.first === null) throw new Error(`${spec.name}: nothing detects a forgotten flow`);
    return {
      detects: true,
      timer: found.first.timer,
      errno: "ETIMEDOUT",
      from: "first-retransmission",
      ...band(timerUnder(LINUX_TCP, found.first.timer, linux, MANIFESTATIONS.blackhole), found.first.timer),
    };
  }
  if (verdict.holds) return { detects: false, window: q(WINDOW) };
  if (spec.form === "reset-both")
    return { detects: true, timer: "expire_established", errno: resetErrno(), from: "last-received", ...forget };
  if (spec.observer === "client") {
    const linux = given(clientValues(spec, rttMs));
    if (spec.form === "reset-next") {
      // the first keepalive probe after the forget meets the reset: the refresh of the client, one round trip later
      const first = realizationOf(LINUX_TCP, "systems.mechanism.idle-refresh-interval", linux)!;
      return { detects: true, timer: "rx.rst", errno: resetErrno(), from: "last-received", ...band(first, "keepidle", rtt) };
    }
    const found = detection(LINUX_TCP, { state: "ESTABLISHED", inFlight: false }, MANIFESTATIONS.blackhole, linux);
    if (found.first === null) throw new Error(`${spec.name}: nothing detects a forgotten flow`);
    return {
      detects: true,
      timer: found.first.timer,
      errno: "ETIMEDOUT",
      from: "last-received",
      ...band(timerUnder(LINUX_TCP, found.first.timer, linux, MANIFESTATIONS.blackhole), found.first.timer),
    };
  }
  // the server: a late packet from outside is dropped (reset-next), or meets the reset of the router's own stack (none)
  const redis = given(redisValues(spec));
  const linux = given(clientValues(spec, rttMs));
  if (spec.form === "none") {
    const first = realizationOf(REDIS_CLIENT, "systems.mechanism.idle-refresh-interval", redis)!;
    return { detects: true, timer: "rx.rst", errno: resetErrno(), from: "last-received", ...band(first, "tcp-keepalive", rtt) };
  }
  const found = stackedDetection(
    REDIS_CLIENT,
    LINUX_TCP,
    { state: "CONNECTED", inFlight: false },
    MANIFESTATIONS.blackhole,
    redis,
    linux,
  );
  if (found.first === null) throw new Error(`${spec.name}: nothing detects a forgotten flow`);
  const values = overValues(REDIS_CLIENT, redis, linux);
  return {
    detects: true,
    timer: found.first.timer,
    errno: "ETIMEDOUT",
    from: "last-received",
    ...band(timerUnder(LINUX_TCP, found.first.timer, values, MANIFESTATIONS.blackhole), found.first.timer),
  };
};

/** This function gives the cell of a T03 spec for the harness. */
export const t03Cell = (spec: T03Spec): Cell => {
  const server = spec.observer === "server";
  return {
    name: `T03 ${spec.name}`,
    target: REDIS,
    sysctls: server ? {} : sysctlsOf(clientValues(spec)),
    probe: { mode: spec.mode, keepalive: !server && keepaliveOn(spec) },
    fault: "middlebox-forget",
    topology: { name: "T03", hops: [router(spec.form, IDLE)] },
    prediction: predictT03(spec),
    ...(server
      ? {
          observer: "server" as const,
          targetSettings: { "tcp-keepalive": String(spec.redisKeepalive ?? 300), timeout: "0" },
        }
      : {}),
    ...(spec.mode === "inflight" ? { idleBefore: s(IDLE_BEFORE) } : {}),
    runs: RUNS,
    environments: 2,
    // the listing of a router reaps the expired flows of each namespace: the cells of T03 go one at a time
    concurrency: 1,
  };
};

// ---------------------------------------------------------------------------------------------
// a fault at the router: FORWARD rules on its device toward one side
// ---------------------------------------------------------------------------------------------

/** A T03 fault spec is one cell of a fault at the router, before its prediction. */
export interface T03FaultSpec {
  readonly name: string;
  readonly form: MiddleboxForm;
  readonly fault: "blackhole" | "rst" | "unreachable" | "simplex" | "netem";
  /** This name is the manifestation that the client meets, as the T01 cells name it. */
  readonly manifestation: ManifestationName;
  /** This side is the side of the router that the rules face. */
  readonly toward: "client" | "target";
  readonly mode: "idle" | "inflight";
  /** These are the knobs of Linux TCP at the client that differ from Linux 6.6. */
  readonly linux: Readonly<Record<string, Extent>>;
  readonly icmp?: Cell["icmp"];
  readonly drops?: Cell["drops"];
  /** This delay is netem on the device of the router toward the side, in milliseconds. */
  readonly delay?: number;
  /** This flag marks a cell where the router forgets the flow while the fault holds. */
  readonly forgets?: true;
}

const IN_FLIGHT = { ...KEEPALIVE, tcp_retries2: count(3) };

/**
 * The T03 cells of a fault at the router. The router forwards, thus the rules of the fault are
 * FORWARD rules in its namespace, on its device toward one side. A reject answers from the router:
 * a reset with the address of the target, or an ICMP error from the address of the router. The
 * form is a plain NAT (`none`), except in the cells where the router forgets the flow while the
 * fault holds.
 */
export const T03_FAULT_SPECS: readonly T03FaultSpec[] = [
  // ---- a black hole at the router: the band of the direct pair, while the router keeps the flow
  {
    name: "client idle, blackhole at the router, keepidle 5 s, none",
    form: "none",
    fault: "blackhole",
    manifestation: "blackhole",
    toward: "client",
    mode: "idle",
    linux: KEEPALIVE,
  },
  {
    name: "client in flight, blackhole at the router, tcp_retries2 = 3, none",
    form: "none",
    fault: "blackhole",
    manifestation: "blackhole",
    toward: "client",
    mode: "inflight",
    linux: IN_FLIGHT,
  },
  // ---- a reset and the ICMP errors of the router, toward the client
  {
    name: "client in flight, rst at the router toward the client",
    form: "none",
    fault: "rst",
    manifestation: "blackhole",
    toward: "client",
    mode: "inflight",
    linux: IN_FLIGHT,
  },
  ...(["host", "net", "port", "admin"] as const).map(
    (icmp): T03FaultSpec => ({
      name: `client in flight, unreachable-${icmp} at the router toward the client, tcp_retries2 = 3`,
      form: "none",
      fault: "unreachable",
      manifestation: `unreachable-${icmp}`,
      toward: "client",
      mode: "inflight",
      linux: IN_FLIGHT,
      icmp,
    }),
  ),
  // ---- a simplex partition at the router, in each direction
  ...(["to-server", "to-client"] as const).map(
    (drops): T03FaultSpec => ({
      name: `client in flight, simplex-${drops} at the router toward the client, tcp_retries2 = 3`,
      form: "none",
      fault: "simplex",
      manifestation: `simplex-${drops}`,
      toward: "client",
      mode: "inflight",
      linux: IN_FLIGHT,
      drops,
    }),
  ),
  // ---- netem on the device of the router toward each side
  ...(["client", "target"] as const).map(
    (toward): T03FaultSpec => ({
      name: `client in flight, netem delay 100 ms at the router toward the ${toward}`,
      form: "none",
      fault: "netem",
      manifestation: "blackhole",
      toward,
      mode: "inflight",
      linux: IN_FLIGHT,
      delay: 100,
    }),
  ),
  // ---- the router forgets the flow behind its own black hole: its conntrack still acts
  {
    name: "client idle, blackhole at the router, keepidle 6 s, none, the router forgets the flow",
    form: "none",
    fault: "blackhole",
    manifestation: "blackhole",
    toward: "client",
    mode: "idle",
    linux: { keepidle: s(6), keepintvl: s(1), keepcnt: count(3) },
    forgets: true,
  },
  {
    name: "client idle, blackhole at the router, keepidle 6 s, reset-both, the router forgets the flow",
    form: "reset-both",
    fault: "blackhole",
    manifestation: "blackhole",
    toward: "client",
    mode: "idle",
    linux: { keepidle: s(6), keepintvl: s(1), keepcnt: count(3) },
    forgets: true,
  },
  {
    name: "client in flight, blackhole at the router, tcp_retries2 = 8, reset-both, the router forgets the flow",
    form: "reset-both",
    fault: "blackhole",
    manifestation: "blackhole",
    toward: "client",
    mode: "inflight",
    linux: { ...KEEPALIVE, tcp_retries2: count(8) },
    forgets: true,
  },
];

/** This function gives the values of Linux TCP at the client of a fault spec, at a round trip in ms. */
const faultValues = (spec: T03FaultSpec, rttMs = RTT_MS): Record<string, Extent> => ({
  ...LINUX_66,
  ...spec.linux,
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(rttMs),
});

/** This function gives the T01 spec that a fault at the router is to the client: the same manifestation and knobs. */
const asDirect = (spec: T03FaultSpec): Spec => ({
  name: spec.name,
  fault: spec.fault,
  manifestation: spec.manifestation,
  observer: "client",
  mode: spec.mode,
  linux: spec.linux,
  ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
  ...(spec.drops === undefined ? {} : { drops: spec.drops }),
});

/**
 * This function gives the time of the forget of a flow in flight, from the send of its request.
 * Each retransmission refreshes the conntrack entry, because conntrack sees each segment before
 * the FORWARD rules drop it. Thus the router forgets the flow one idle timeout after the last
 * retransmission before a wait longer than that timeout. The firings come from the retransmit
 * timer of Linux TCP, each with its bounds.
 */
const forgetInFlight = (spec: T03FaultSpec, rttMs: number): { low: number; high: number } => {
  const linux = given(faultValues(spec, rttMs));
  const ladder = recovery(LINUX_TCP, "retransmit", linux, s(60));
  if ("unknown" in ladder) throw new Error(`${spec.name}: ${ladder.unknown}`);
  const forget = forgetBand();
  const [earliest, latest] = [valueIn(forget.low, "s"), valueIn(forget.high, "s")];
  // the send is the first packet: firing −1, at 0
  const firings = [{ low: 0, high: 0 }, ...ladder.firings.map((f) => ({ low: valueIn(f.low, "s"), high: valueIn(f.high, "s") }))];
  for (let at = 0; at + 1 < firings.length; at += 1) {
    const [here, next] = [firings[at]!, firings[at + 1]!];
    // the router keeps the flow when the next firing surely comes before the earliest forget
    if (next.high - here.low < earliest) continue;
    // and forgets it when the next firing surely comes after the latest forget
    if (next.low - here.high > latest) return { low: here.low + earliest, high: here.high + latest };
    throw new Error(`${spec.name}: the forget can come before or after firing ${at}`);
  }
  throw new Error(`${spec.name}: no wait of the ladder is longer than the idle timeout`);
};

/**
 * This function gives the prediction of a fault at the router, at a round trip in ms.
 * - netem delays each segment toward its side: the reply comes back after the delay and a round trip.
 * - A reset answers the request from the router at once.
 * - Each other fault is the manifestation of the direct pair, with the same knobs. The router is
 *   between the two ends, and the client meets what the rules let through. A plain NAT router
 *   that forgets the flow passes a late packet into the fault, thus the forget changes nothing.
 * - A router that resets both ends at the forget does it from its own stack, past its own FORWARD
 *   rules. Idle, that is one idle timeout after the last segment. In flight, it is one idle
 *   timeout after the last retransmission before a long wait (`forgetInFlight`).
 */
const predictFaultAt = (spec: T03FaultSpec, rttMs: number): Prediction => {
  const rtt = rttMs / 1000;
  if (spec.fault === "netem") {
    const delay = (spec.delay ?? 0) / 1000;
    return { detects: false, window: q(2), replies: { low: q(delay), high: q(delay + rtt) } };
  }
  if (spec.fault === "rst")
    return { detects: true, timer: "rx.rst", errno: resetErrno(), from: "request-sent", low: q(0), high: q(rtt) };
  if (spec.forgets === true && spec.form === "reset-both") {
    if (spec.mode === "idle")
      return { detects: true, timer: "expire_established", errno: resetErrno(), from: "last-received", ...forgetBand() };
    const forget = forgetInFlight(spec, rttMs);
    const giveUp = predictAt(asDirect(spec), rttMs);
    if (giveUp.detects !== true || valueIn(giveUp.low, "s") <= forget.high)
      throw new Error(`${spec.name}: the give-up can come before the forget`);
    return { detects: true, timer: "expire_established", errno: resetErrno(), from: "request-sent", low: q(forget.low), high: q(forget.high) };
  }
  if (spec.form !== "none") throw new Error(`${spec.name}: only a plain NAT router passes a late packet into the fault`);
  return predictAt(asDirect(spec), rttMs);
};

/** This function gives the cell of a fault at the router for the harness. */
export const t03FaultCell = (spec: T03FaultSpec): Cell => {
  const hop = router(spec.form, IDLE);
  return {
    name: `T03 ${spec.name}`,
    target: REDIS,
    sysctls: sysctlsOf(faultValues(spec)),
    probe: { mode: spec.mode, keepalive: true },
    fault: spec.fault,
    // the router sends each ICMP error: its rate limit is 0, thus each retransmission draws one
    topology: {
      name: "T03",
      hops: [spec.fault === "unreachable" ? { ...hop, sysctls: { "net.ipv4.icmp_ratelimit": "0" } } : hop],
    },
    faultAt: { hop: hop.name, toward: spec.toward },
    prediction: assuming((rtt) => predictFaultAt(spec, rtt), RTT_MS),
    ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
    ...(spec.drops === undefined ? {} : { drops: spec.drops }),
    ...(spec.delay === undefined ? {} : { netem: `delay ${spec.delay}ms` }),
    runs: RUNS,
    environments: 2,
    concurrency: 1,
  };
};

/** These are the cells of the T03 catalog: a forgotten flow, then a fault at the router. */
export const T03_CELLS: readonly Cell[] = [...T03_SPECS.map(t03Cell), ...T03_FAULT_SPECS.map(t03FaultCell)];
