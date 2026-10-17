import type { KnobValues, Machine } from "@mark1russell7/algebra";
import { evaluate as evaluateTime, realizationOf } from "@mark1russell7/algebra";
import type { ProxyHop, RouterHop, Target } from "@mark1russell7/harness";
import { LISTING } from "@mark1russell7/harness";
import { LINUX_TCP, NF_CONNTRACK_TCP } from "@mark1russell7/machines";
import type { Extent, Quantity, Unknown } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Binding, Rule } from "@mark1russell7/service";
import { evaluate, verdictOf } from "@mark1russell7/service";
import { HZ, REDIS, seconds } from "./catalog.ts";

/** This target is Redis with a command that closes the connection of each client (`CLIENT KILL`). */
export const REDIS_CLOSING: Target = {
  ...REDIS,
  close: ["redis-cli", "CLIENT", "KILL", "TYPE", "normal"],
};

/** This time is the interval of the listing of the router of T03: 0.05 s. A DESTROY follows an expiry within it and two listings (`LISTING`). */
export const ROUTER_PUMP: Quantity = { value: 0.05, unit: "s" };
export { LISTING };

/** This function gives a router hop of T03, with its form and its idle timeout in whole seconds. */
export const router = (form: RouterHop["form"], idle: number): RouterHop => ({
  name: "nat",
  kind: "router",
  form,
  idle: { value: idle, unit: "s" },
  pump: ROUTER_PUMP,
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
): O03Verdict => {
  const refreshing = realizationOf(endpoint.doc, "systems.mechanism.idle-refresh-interval", endpoint.values);
  const forgetting = realizationOf(NF_CONNTRACK_TCP, "systems.mechanism.middlebox-idle", middlebox);
  if (refreshing === undefined || forgetting === undefined) throw new Error("a document realizes no term of O03");
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
