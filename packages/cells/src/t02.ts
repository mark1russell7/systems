import type { KnobValues } from "@mark1russell7/algebra";
import { detection, overValues, stackedDetection, timerUnder } from "@mark1russell7/algebra";
import type { Cell, FaultPlace, Observer, Prediction } from "@mark1russell7/harness";
import type { Extent } from "@mark1russell7/quantity";
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
import { haproxy } from "./topologies.ts";

/** These are the knobs of Linux TCP in the namespace of the proxy: keepalive at 3 s idle and 3 probes 1 s apart, 6 s in all. */
const PROXY_LINUX = { keepidle: s(3), keepintvl: s(1), keepcnt: count(3), tcp_retries2: count(3) };
/** These are the knobs of the client when it has a keepalive of its own: 5 s idle and 3 probes 2 s apart, 11 s in all. */
const CLIENT_KEEPALIVE = { keepidle: s(5), keepintvl: s(2), keepcnt: count(3) };

const values = (knobs: Readonly<Record<string, Extent>>): Record<string, Extent> => ({
  ...LINUX_66,
  ...knobs,
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(RTT_MS),
});

/** This function gives the band of a timer under a black hole: its duration less how early it fires, to its duration plus how late. */
const bandOf = (timer: string, linux: KnobValues): { low: ReturnType<typeof q>; high: ReturnType<typeof q> } => {
  const bounds = timerUnder(LINUX, timer, linux, MANIFESTATIONS.blackhole);
  const duration = seconds(bounds.duration, timer);
  return {
    low: q(duration - seconds(bounds.early, `${timer}'s early bound`)),
    high: q(duration + seconds(bounds.lateness, `${timer}'s lateness`)),
  };
};

/** This function gives the prediction of an idle Linux socket in a black hole: its keepalive gives up, from the last segment it received. */
const idleLinux = (knobs: Readonly<Record<string, Extent>>): Prediction => {
  const linux = given(values(knobs));
  const found = detection(LINUX, { state: "ESTABLISHED", inFlight: false }, MANIFESTATIONS.blackhole, linux);
  if (found.first === null) throw new Error("nothing detects the black hole");
  return { detects: true, timer: found.first.timer, errno: "ETIMEDOUT", from: "last-received", ...bandOf(found.first.timer, linux) };
};

/** This function gives the prediction of the socket of Redis in a black hole: its keepalive from tcp-keepalive, over Linux TCP. */
const idleRedis = (keepalive: number): Prediction => {
  const redis = given({ tcp_keepalive: s(keepalive), timeout: s(0), hz: { value: HZ, unit: "Hz" } });
  const linux = given(values({}));
  const found = stackedDetection(REDIS_CLIENT, LINUX, { state: "CONNECTED", inFlight: false }, MANIFESTATIONS.blackhole, redis, linux);
  if (found.first === null) throw new Error("nothing detects the black hole");
  return { detects: true, timer: found.first.timer, errno: "ETIMEDOUT", from: "last-received", ...bandOf(found.first.timer, overValues(REDIS_CLIENT, redis, linux)) };
};

/** This text tells why a cell of the idle timer of HAProxy is measurement only. */
const NO_DOCUMENT =
  "HAProxy has no machine document. Its documentation gives an inactivity timeout on each side, and a keepalive probe carries no data, but the algebra cannot read that";

/** A T02 spec is one cell of the pooled request chain: client → HAProxy → Redis 7.4. */
interface T02Spec {
  readonly name: string;
  readonly fault: "proxy-idle" | "blackhole";
  readonly observer: Observer;
  readonly faultAt?: FaultPlace;
  /** These are the idle timeouts of HAProxy, in seconds. */
  readonly timeouts: { readonly client: number; readonly server: number };
  /** This flag gives the client its own keepalive: 2 s idle for the idle timers of the proxy, or 5 s against a black hole. */
  readonly keepalive?: "short" | "long";
  /** This time is tcp-keepalive of Redis, in seconds. */
  readonly redisKeepalive?: number;
  readonly prediction: Prediction;
}

const measured = (window: number, why: string): Prediction => ({ detects: null, window: q(window), why, from: "last-received" });

/**
 * The T02 catalog: client → HAProxy 3.2 in TCP mode → Redis 7.4. HAProxy ends each connection,
 * thus each leg has its own sockets and its own timers. Its idle timeouts count data only, and the
 * cells put a keepalive against each of them. A black hole goes on each leg, from each side. Each
 * socket that can detect it is an observer. Thus the cells tell which side detects first, and what the others get.
 */
const T02_SPECS: readonly T02Spec[] = [
  // ---- the idle timers of the proxy against the keepalive of each end
  {
    name: "client idle, keepalive 2 s, HAProxy timeout client 5 s",
    fault: "proxy-idle",
    observer: "client",
    timeouts: { client: 5, server: 30 },
    keepalive: "short",
    prediction: measured(10, `${NO_DOCUMENT}: the client side times out at 5 s whether or not the client sends keepalive probes`),
  },
  {
    name: "client idle, keepalive 2 s, HAProxy timeout server 5 s, Redis tcp-keepalive 2 s",
    fault: "proxy-idle",
    observer: "client",
    timeouts: { client: 30, server: 5 },
    keepalive: "short",
    redisKeepalive: 2,
    prediction: measured(10, `${NO_DOCUMENT}: the server side times out at 5 s whether or not Redis sends keepalive probes`),
  },
  // ---- a black hole between the client and the proxy: the client at 11 s, the proxy at 6 s
  {
    name: "client idle, keepalive 5 s, blackhole at HAProxy toward the client",
    fault: "blackhole",
    observer: "client",
    faultAt: { hop: "haproxy", toward: "client" },
    timeouts: { client: 30, server: 30 },
    keepalive: "long",
    prediction: idleLinux(CLIENT_KEEPALIVE),
  },
  {
    name: "HAProxy toward the client idle, blackhole at the client",
    fault: "blackhole",
    observer: { hop: "haproxy", toward: "client" },
    faultAt: "client",
    timeouts: { client: 30, server: 30 },
    prediction: idleLinux(PROXY_LINUX),
  },
  // ---- a black hole between the proxy and Redis: the proxy at 6 s, Redis at 8 s, and the client hears a close
  {
    name: "server idle, tcp-keepalive 5 s, blackhole at HAProxy toward the target",
    fault: "blackhole",
    observer: "server",
    faultAt: { hop: "haproxy", toward: "target" },
    timeouts: { client: 30, server: 30 },
    redisKeepalive: 5,
    prediction: idleRedis(5),
  },
  {
    name: "HAProxy toward the target idle, blackhole at the target",
    fault: "blackhole",
    observer: { hop: "haproxy", toward: "target" },
    faultAt: "target",
    timeouts: { client: 30, server: 30 },
    prediction: idleLinux(PROXY_LINUX),
  },
  {
    name: "client idle, blackhole at the target",
    fault: "blackhole",
    observer: "client",
    faultAt: "target",
    timeouts: { client: 30, server: 30 },
    prediction: measured(
      15,
      "HAProxy has no machine document for what it does on one side when the other side fails: the client hears what HAProxy sends when its own keepalive gives up on the server",
    ),
  },
];

/** This function gives the cell of a T02 spec for the harness. */
const t02Cell = (spec: T02Spec): Cell => ({
  name: `T02 ${spec.name}`,
  target: REDIS,
  sysctls:
    spec.keepalive === undefined
      ? {}
      : sysctlsOf(values(spec.keepalive === "short" ? { keepidle: s(2), keepintvl: s(1), keepcnt: count(3) } : CLIENT_KEEPALIVE)),
  probe: { mode: "idle", keepalive: spec.keepalive !== undefined },
  fault: spec.fault,
  topology: { name: "T02", hops: [haproxy(spec.timeouts, sysctlsOf(values(PROXY_LINUX)))] },
  prediction: spec.prediction,
  ...(spec.observer === "client" ? {} : { observer: spec.observer }),
  ...(spec.faultAt === undefined ? {} : { faultAt: spec.faultAt }),
  ...(spec.redisKeepalive === undefined
    ? {}
    : { targetSettings: { "tcp-keepalive": String(spec.redisKeepalive), timeout: "0" } }),
  runs: RUNS,
  environments: 2,
});

/** These are the cells of the T02 catalog. */
export const T02_CELLS: readonly Cell[] = T02_SPECS.map(t02Cell);
