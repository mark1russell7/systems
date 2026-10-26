import type { KnobValues, Machine, TimerBounds } from "@mark1russell7/algebra";
import { evaluate as evaluateTime, realizationOf, timerOf, transitionOn } from "@mark1russell7/algebra";
import type { ProxyHop, RouterHop, Target } from "@mark1russell7/harness";
import { LISTING, PUMP_SLACK } from "@mark1russell7/harness";
import { HAPROXY_TCP, LINUX_TCP, NF_CONNTRACK_TCP } from "@mark1russell7/machines";
import type { Extent, Quantity, Unknown } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Binding, Rule } from "@mark1russell7/service";
import { evaluate, verdictOf } from "@mark1russell7/service";
import { HZ, REDIS, given, s, seconds } from "./catalog.ts";
import { defaultsOf } from "./mongo/model.ts";

/** This target is Redis with a command that closes the connection of each client (`CLIENT KILL`). */
export const REDIS_CLOSING: Target = {
  ...REDIS,
  close: ["redis-cli", "CLIENT", "KILL", "TYPE", "normal"],
};

/** This time is the interval of the listing of the router of T03: 0.05 s. A DESTROY follows an expiry within it, two listings (`LISTING`) and the slack of the pump (`PUMP_SLACK`). */
export const ROUTER_PUMP: Quantity = { value: 0.05, unit: "s" };
export { LISTING, PUMP_SLACK };

/** This function gives a router hop of T03, with its form and its idle timeout in whole seconds. */
export const router = (form: RouterHop["form"], idle: number): RouterHop => ({
  name: "nat",
  kind: "router",
  form,
  idle: { value: idle, unit: "s" },
  pump: ROUTER_PUMP,
});

/**
 * This function gives the values of conntrack for a router: its idle timeout in seconds, and the lag
 * of its DESTROY. The pump lists the table each ROUTER_PUMP, each listing takes LISTING at most, and
 * the pump can be late by PUMP_SLACK.
 */
export const conntrackValues = (idle: number): KnobValues =>
  given({
    nf_conntrack_tcp_timeout_established: s(idle),
    gc_lag_max: s(valueIn(ROUTER_PUMP, "s") + 2 * valueIn(LISTING, "s") + valueIn(PUMP_SLACK, "s")),
  });

/** This image is HAProxy 3.2.25, pinned by digest: the proxy of T02. */
export const HAPROXY_IMAGE =
  "haproxy:3.2@sha256:e2b397cdbd612221cf79dec325690139d00a78b4ce4eae065530fbc81e1f6192";

/** A proxied service is the name and the port of what HAProxy serves: Redis for T02, the procedures server for WST. */
export interface Proxied {
  readonly name: string;
  readonly port: number;
}

/** This service is Redis on its port: the service of T02. */
const REDIS_SERVICE: Proxied = { name: "redis", port: 6379 };

/**
 * This function gives the HAProxy hop of T02 in TCP mode, with its idle timeout on each side. Each of
 * its sockets has kernel keepalive (`clitcpka`, `srvtcpka`), with the sysctls of its namespace. It
 * serves Redis, or another service on its own port.
 */
export const haproxy = (
  timeouts: { readonly client: number; readonly server: number },
  sysctls: Readonly<Record<string, string>>,
  service: Proxied = REDIS_SERVICE,
): ProxyHop => ({
  name: "haproxy",
  kind: "proxy",
  image: HAPROXY_IMAGE,
  port: service.port,
  command: ["haproxy", "-V", "-f", "/usr/local/etc/haproxy/haproxy.cfg"],
  ready: "Loading success",
  files: {
    "/usr/local/etc/haproxy/haproxy.cfg": [
      "global",
      "  maxconn 256",
      "defaults",
      "  mode tcp",
      "  timeout connect 5s",
      `  timeout client ${timeouts.client}s`,
      `  timeout server ${timeouts.server}s`,
      "  option clitcpka",
      "  option srvtcpka",
      `frontend ${service.name}`,
      `  bind :${service.port}`,
      `  default_backend ${service.name}`,
      `backend ${service.name}`,
      `  server ${service.name} {{next}}`,
      "",
    ].join("\n"),
  },
  sysctls,
  settings: { "timeout client": `${timeouts.client}s`, "timeout server": `${timeouts.server}s` },
});

/** This function gives the values of `HAPROXY_TCP` for the idle timeouts of a hop in seconds, and the defaults of its other knobs. */
export const haproxyValues = (timeouts: { readonly client: number; readonly server: number }): KnobValues =>
  given({ ...defaultsOf(HAPROXY_TCP), timeout_client: s(timeouts.client), timeout_server: s(timeouts.server) });

/** A FIN answer names the transition of the document of a target that takes the FIN of HAProxy. It also names the FIN of the target. */
export interface FinAnswer {
  readonly doc: Machine;
  readonly state: string;
  readonly on: string;
  readonly fin: string;
}

/**
 * An idle end of HAProxy is the timer of HAProxy that ends an idle connection, and when its FIN
 * reaches the client. The time is in seconds from the last data that the client received. A why
 * tells why the documents give no such time.
 */
export type HaproxyIdle = { readonly timer: string; readonly lo: number; readonly hi: number } | { readonly why: string };

/** This event of `HAPROXY_TCP` is its FIN to the client. */
const CLIENT_FIN = "tx.client-fin";
/** This event of `HAPROXY_TCP` is its FIN to the target. */
const UPSTREAM_FIN = "tx.upstream-fin";

/**
 * This function gives how HAProxy ends an idle connection, from `HAPROXY_TCP`, at a round trip to
 * the target in seconds. Only bytes reset the timer of each side, thus each timer counts from the
 * last data. The timer that fires first decides.
 * - `timeout server` sends a FIN to the client at once.
 * - `timeout client` sends a FIN to the target, and the FIN to the client follows the FIN of the
 *   target. Then the band gets one round trip to the target and one step of HAProxy. The document of
 *   the target must answer the FIN with its own (`target`), else the band is unknown.
 */
export const haproxyIdle = (
  timeouts: { readonly client: number; readonly server: number },
  rtt: number,
  target?: FinAnswer,
): HaproxyIdle => {
  const values = haproxyValues(timeouts);
  const spans = (["timeout_client", "timeout_server"] as const)
    .flatMap((timer) => {
      const bounds = timerOf(HAPROXY_TCP, timer, values);
      const duration = secondsOrInfinite(bounds.duration, timer);
      if (duration === "inf") return [];
      return [{ timer, lo: duration - seconds(bounds.early, `${timer}'s early bound`), hi: duration + seconds(bounds.lateness, `${timer}'s lateness`) }];
    })
    .sort((a, b) => a.lo - b.lo);
  const [first, next] = spans;
  if (first === undefined) return { why: "HAProxy has no idle timeout on either side" };
  if (next !== undefined && !(first.hi < next.lo)) return { why: "the two idle timeouts of HAProxy can fire in either sequence" };
  const ends = transitionOn(HAPROXY_TCP, "linked", HAPROXY_TCP.timers[first.timer]!.fires);
  if (ends?.emits?.includes(CLIENT_FIN)) return first;
  if (ends === undefined || !ends.emits?.includes(UPSTREAM_FIN)) throw new Error(`${HAPROXY_TCP.title}: ${first.timer} sends no FIN`);
  if (target === undefined) return { why: `${first.timer} sends a FIN to the target, and no document tells what the target does then` };
  if (!(transitionOn(target.doc, target.state, target.on)?.emits ?? []).includes(target.fin))
    return { why: `${first.timer} sends a FIN to the target, and the document ${target.doc.id} of the target gives no FIN back` };
  if (!(transitionOn(HAPROXY_TCP, ends.to, "peer.upstream-fin")?.emits ?? []).includes(CLIENT_FIN))
    throw new Error(`${HAPROXY_TCP.title}: the FIN of the target sends no FIN to the client`);
  return { timer: first.timer, lo: first.lo, hi: first.hi + rtt + seconds(values("slack"), "the slack of HAProxy") };
};

/** This image is Toxiproxy 2.12.0, pinned by digest: the subject of the TOX cells. */
export const TOXIPROXY_IMAGE =
  "ghcr.io/shopify/toxiproxy:2.12.0@sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e";

/** This function gives the Toxiproxy hop: one proxy `redis` from port 6380 to the next hop, and its API on 8474. */
export const toxiproxy = (sysctls: Readonly<Record<string, string>> = {}): ProxyHop => ({
  name: "toxiproxy",
  kind: "proxy",
  image: TOXIPROXY_IMAGE,
  port: 6380,
  command: ["-host=0.0.0.0", "-config", "/toxiproxy.json"],
  ready: "Starting Toxiproxy HTTP server",
  files: {
    "/toxiproxy.json": JSON.stringify([
      { name: "redis", listen: "0.0.0.0:6380", upstream: "{{next}}", enabled: true },
    ]),
  },
  api: { port: 8474, proxy: "redis" },
  ...(Object.keys(sysctls).length === 0 ? {} : { sysctls }),
});

/**
 * This rule is O03 of the ordering law: every idle flow is refreshed more often than each
 * middlebox on its path forgets it. Its margin is the round trip to the middlebox and one jiffy,
 * because conntrack counts its timeout in jiffies.
 */
export const O03: Rule = {
  id: "O03",
  rule: "every idle flow is refreshed more often than every middlebox on its path forgets it",
  window: "the endpoint holds a connection that the middlebox forgot",
  expr: {
    lhs: { terms: [{ knob: "idle_refresh_interval", coef: 1, at: "endpoint" }] },
    op: "<",
    rhs: { terms: [{ knob: "middlebox_idle", coef: 1, at: "middlebox" }] },
  },
};

/** This is the mechanism of the corpus that the delay of an ACK is. */
export const ACK_DELAY = "systems.mechanism.ack-delay";

/**
 * This function gives the delay of the ACK of the last data of a flow, in seconds, from the document
 * of Linux TCP. That ACK is the last segment of an idle flow, thus the idle time of a router counts
 * from it. The kernel acknowledges at once in quick-ACK mode. Else its delayed-ACK timer sends the
 * ACK after max(TCP_DELACK_MIN, srtt) at most, 40 ms on a fast path, rounded on the wheel.
 */
export const ackDelay = (rttMs: number): { readonly lo: number; readonly hi: number } => {
  const values: KnobValues = (name) =>
    name === "rtt" ? { value: rttMs, unit: "ms" } : name === "hz" ? { value: HZ, unit: "Hz" } : undefined;
  const bounds = realizationOf(LINUX_TCP, ACK_DELAY, values);
  if (bounds === undefined) throw new Error(`${LINUX_TCP.title} does not realize ${ACK_DELAY}`);
  const duration = seconds(bounds.duration, "the ack delay");
  return {
    lo: duration - seconds(bounds.early, "the early bound of the ack delay"),
    hi: duration + seconds(bounds.lateness, "the lateness of the ack delay"),
  };
};

/** This function gives the number of seconds of a time of the algebra, or of no bound. */
const secondsOrInfinite = (extent: Extent | Unknown | undefined, what: string): number | "inf" => {
  // a knob that nothing sets is no bound: a keepalive that is off never refreshes the flow
  if (extent !== undefined && !("unknown" in extent) && extent.value === "infinite") return "inf";
  return seconds(extent, what);
};

/** An O03 verdict is the verdict of the law on one chain, with the two terms at their worst. */
export interface O03Verdict {
  readonly holds: boolean;
  /** This time is the latest refresh of the endpoint: its idle time plus how late its timer can fire. */
  readonly refresh: number | "inf";
  /** This time is the earliest forget of the middlebox: its idle timeout less how early it can fire. */
  readonly forget: number;
  readonly margin: number;
}

/**
 * This function decides O03 for an endpoint on a middlebox, from their machine documents. Each term
 * is at its worst: the refresh at its latest, the forget at its earliest. The law of
 * `@mark1russell7/service` decides it as the linter of the research does.
 */
export const o03 = (
  endpoint: { readonly doc: Machine; readonly values: KnobValues },
  middlebox: KnobValues,
  rtt: number,
  forgetter: Machine = NF_CONNTRACK_TCP,
): O03Verdict => {
  const refreshing = realizationOf(endpoint.doc, "systems.mechanism.idle-refresh-interval", endpoint.values);
  if (refreshing === undefined) throw new Error("a document realizes no term of O03");
  return o03From(refreshing, middlebox, rtt, forgetter);
};

/**
 * This function decides O03 for a refresh that a timer of a document gives, on a middlebox. The
 * refresh is the timer at its latest. The forget is the idle timeout of the middlebox at its
 * earliest: the realization of `systems.mechanism.middlebox-idle` in its document. That is
 * conntrack of a router, or the earlier timeout of a proxy (`HAPROXY_TCP`).
 */
export const o03From = (
  refreshing: TimerBounds,
  middlebox: KnobValues,
  rtt: number,
  forgetter: Machine = NF_CONNTRACK_TCP,
): O03Verdict => {
  const forgetting = realizationOf(forgetter, "systems.mechanism.middlebox-idle", middlebox);
  if (forgetting === undefined) throw new Error(`${forgetter.title} realizes no term of O03`);
  const idle = secondsOrInfinite(refreshing.duration, "the refresh");
  const refresh = idle === "inf" ? "inf" : idle + seconds(refreshing.lateness, "the lateness of the refresh");
  const forget =
    seconds(forgetting.duration, "the forget") - seconds(forgetting.early, "the early bound of the forget");
  const jiffy = evaluateTime(LINUX_TCP, { model: "linux.jiffy", knobs: ["hz"], unit: "s" }, (name) =>
    name === "hz" ? { value: HZ, unit: "Hz" } : undefined,
  );
  const margin = rtt + valueIn(jiffy as Quantity, "s");
  const binding: Binding = {
    "idle_refresh_interval@endpoint": refresh,
    "middlebox_idle@middlebox": forget,
    margin,
  };
  const holds = verdictOf(O03, binding, evaluate(O03, binding)) === "holds";
  return { holds, refresh, forget, margin };
};
