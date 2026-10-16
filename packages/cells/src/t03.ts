import type { KnobValues } from "@mark1russell7/algebra";
import { detection, overValues, stackedDetection, timerOf, timerUnder, transitionOn, realizationOf } from "@mark1russell7/algebra";
import type { Cell, MiddleboxForm, Prediction } from "@mark1russell7/harness";
import type { Extent } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import {
  HZ,
  LINUX,
  LINUX_66,
  REDIS,
  REDIS_CLIENT,
  RTT_MS,
  RUNS,
  count,
  given,
  ms,
  q,
  s,
  seconds,
  sysctlsOf,
} from "./catalog.ts";
import { MANIFESTATIONS } from "./manifestations.ts";
import type { O03Verdict } from "./topologies.ts";
import { CONNTRACK, LISTING, ROUTER_PUMP, o03, router } from "./topologies.ts";

/** This time is the idle timeout of the router, nf_conntrack_tcp_timeout_established: 5 s, a cloud NAT's 350 s scaled by 70. */
export const IDLE = 5;
/** This time is the window of a silent T03 cell: longer than each detection that a forgotten flow can give. */
const WINDOW = 15;
/** This time is how long an in-flight client stays idle before its request: longer than the latest forget. */
const IDLE_BEFORE = 8;
const rtt = RTT_MS / 1000;

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

/** This function gives the values of Linux TCP at the client of a spec. */
const clientValues = (spec: T03Spec): Record<string, Extent> => ({
  ...LINUX_66,
  ...(spec.keepidle === undefined ? {} : { keepidle: s(spec.keepidle), keepintvl: s(1), keepcnt: count(3) }),
  ...(spec.retries === undefined ? {} : { tcp_retries2: count(spec.retries) }),
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(RTT_MS),
});
const redisValues = (spec: T03Spec): Record<string, Extent> => ({
  tcp_keepalive: s(spec.redisKeepalive ?? 300),
  timeout: s(0),
  hz: { value: HZ, unit: "Hz" },
});

/** This function gives the errno of a reset at an established socket, from the Linux TCP document. */
const resetErrno = (): string => transitionOn(LINUX, "ESTABLISHED", "rx.rst")?.errno ?? "ECONNRESET";

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

/** This function gives the O03 verdict of a spec: the keepalive of its observer against the router. */
export const o03Of = (spec: T03Spec): O03Verdict =>
  spec.observer === "server"
    ? o03({ doc: REDIS_CLIENT, values: given(redisValues(spec)) }, routerValues, rtt)
    : o03({ doc: LINUX, values: given(clientValues(spec)) }, routerValues, rtt);

/**
 * This function gives the prediction of a T03 cell from the algebra. The conntrack document gives the
 * forget, and Linux TCP gives the endpoint. O03 decides if the forget occurs at all.
 * - When O03 holds, the keepalive refreshes the flow, and nothing detects anything in the window.
 * - When it does not, the form decides. A reset to both ends comes at the forget. A reset to the
 *   next packet comes at the first send after the forget. A silent drop leaves the endpoint to its
 *   own give-up: keepalive, or the retransmissions of a request.
 */
export const predictT03 = (spec: T03Spec): Prediction => {
  const verdict = o03Of(spec);
  const forget = band(timerOf(CONNTRACK, "expire_established", routerValues), "expire_established");
  if (spec.mode === "inflight") {
    // the request goes after the latest forget: it meets a router that forgot the flow
    if (!(IDLE_BEFORE > valueIn(forget.high, "s") + verdict.margin))
      throw new Error(`${spec.name}: the request can go before the router forgets the flow`);
    const linux = given(clientValues(spec));
    if (spec.form === "reset-next")
      return { detects: true, timer: "rx.rst", errno: resetErrno(), from: "request-sent", low: q(0), high: q(rtt) };
    if (spec.form === "recreate") {
      // nf_conntrack_tcp_loose lets a mid-stream ACK make a new ESTABLISHED entry (ct.none.established)
      const pickup = transitionOn(CONNTRACK, "NONE", "orig.ack");
      if (pickup?.to !== "ESTABLISHED") throw new Error(`${spec.name}: conntrack picks up no flow mid-stream`);
      return { detects: false, window: q(2), replies: { low: q(0), high: q(rtt) } };
    }
    const found = detection(LINUX, { state: "ESTABLISHED", inFlight: true }, MANIFESTATIONS.blackhole, linux);
    if (found.first === null) throw new Error(`${spec.name}: nothing detects a forgotten flow`);
    return {
      detects: true,
      timer: found.first.timer,
      errno: "ETIMEDOUT",
      from: "first-retransmission",
      ...band(timerUnder(LINUX, found.first.timer, linux, MANIFESTATIONS.blackhole), found.first.timer),
    };
  }
  if (verdict.holds) return { detects: false, window: q(WINDOW) };
  if (spec.form === "reset-both")
    return { detects: true, timer: "expire_established", errno: resetErrno(), from: "last-received", ...forget };
  if (spec.observer === "client") {
    const linux = given(clientValues(spec));
    if (spec.form === "reset-next") {
      // the first keepalive probe after the forget meets the reset: the refresh of the client, one round trip later
      const first = realizationOf(LINUX, "systems.mechanism.idle-refresh-interval", linux)!;
      return { detects: true, timer: "rx.rst", errno: resetErrno(), from: "last-received", ...band(first, "keepidle", rtt) };
    }
    const found = detection(LINUX, { state: "ESTABLISHED", inFlight: false }, MANIFESTATIONS.blackhole, linux);
    if (found.first === null) throw new Error(`${spec.name}: nothing detects a forgotten flow`);
    return {
      detects: true,
      timer: found.first.timer,
      errno: "ETIMEDOUT",
      from: "last-received",
      ...band(timerUnder(LINUX, found.first.timer, linux, MANIFESTATIONS.blackhole), found.first.timer),
    };
  }
  // the server: a late packet from outside is dropped (reset-next), or meets the reset of the router's own stack (none)
  const redis = given(redisValues(spec));
  const linux = given(clientValues(spec));
  if (spec.form === "none") {
    const first = realizationOf(REDIS_CLIENT, "systems.mechanism.idle-refresh-interval", redis)!;
    return { detects: true, timer: "rx.rst", errno: resetErrno(), from: "last-received", ...band(first, "tcp-keepalive", rtt) };
  }
  const found = stackedDetection(
    REDIS_CLIENT,
    LINUX,
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
    ...band(timerUnder(LINUX, found.first.timer, values, MANIFESTATIONS.blackhole), found.first.timer),
  };
};

/** This function gives the cell of a T03 spec for the harness. */
export const t03Cell = (spec: T03Spec): Cell => {
  const server = spec.observer === "server";
  return {
    name: `T03 ${spec.name}`,
    target: REDIS,
    sysctls: server ? {} : sysctlsOf(clientValues(spec)),
    probe: { mode: spec.mode, keepalive: !server && spec.keepidle !== undefined },
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

/** These are the cells of the T03 catalog. */
export const T03_CELLS: readonly Cell[] = T03_SPECS.map(t03Cell);
