import type { Cell, ProxyHop, ProxyTime } from "@mark1russell7/harness";
import { LINUX_66, HZ, REDIS, RTT_MS, RUNS, count, ms, q, s, sysctlsOf } from "./catalog.ts";
import { haproxy, toxiproxy } from "./topologies.ts";

/** This count is the number of requests in each run of a calibration: 11 runs give 1,100 times in each direction. */
const REQUESTS = 100;

/** This text tells what a calibration cell measures. */
const WHY =
  "a calibration: the time of the proxy from an arrival on one of its sockets to its write on the other, in each direction. A band through the proxy adds an upper quantile of it";

/**
 * This function gives the calibration cell of a proxy. A stream of PINGs goes through the proxy to
 * Redis, with nothing injected, at the concurrency of the cells through it (one environment at a
 * time). Each request gives one time toward the target, and its reply one time toward the client.
 * Stage 0 measures δ_abs in the same way: the latency of the pipeline on a path that has no timer.
 */
const calibration = (hop: ProxyHop): Cell => ({
  name: `CAL ${hop.name}, a stream of ${REQUESTS} PINGs, nothing injected`,
  target: REDIS,
  sysctls: {},
  probe: { mode: "stream", keepalive: false, count: REQUESTS, interval: ms(10) },
  fault: "none",
  topology: { name: "CAL", hops: [hop] },
  calibrates: hop.name,
  prediction: { detects: null, window: q(30), why: WHY },
  runs: RUNS,
  environments: 2,
  concurrency: 1,
});

/** These are the knobs of Linux TCP in the namespace of HAProxy, as T02 sets them. */
const HAPROXY_SYSCTLS = sysctlsOf({
  ...LINUX_66,
  keepidle: s(3),
  keepintvl: s(1),
  keepcnt: count(3),
  tcp_retries2: count(3),
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(RTT_MS),
});

/** These are the calibration cells of the proxies: HAProxy as T02 has it, and Toxiproxy with no toxic. */
export const CAL_CELLS: readonly Cell[] = [
  calibration(haproxy({ client: 30, server: 30 }, HAPROXY_SYSCTLS)),
  calibration(toxiproxy()),
];

/** This fraction is the quantile of the time of a proxy that a band adds: the 99th percentile, by nearest rank. */
export const QUANTILE = 0.99;

/**
 * These are the times of each proxy in each direction, the 99th percentile of its calibration
 * cell. `up` is toward the target, and `down` toward the client. They come from the cells `CAL
 * haproxy` and `CAL toxiproxy` of 2026-10-16: 11 runs of 100 requests each, at a concurrency of 1.
 * Each direction has 1,100 times. The medians are 0.096 ms and 0.07 ms for HAProxy, and 0.164 ms
 * and 0.132 ms for Toxiproxy. The calibration occurs again after each change to a proxy, the
 * harness, the kernel or Docker.
 */
export const PROXY_TIMES: Readonly<Record<"haproxy" | "toxiproxy", { readonly up: ProxyTime; readonly down: ProxyTime }>> = {
  haproxy: {
    up: { hop: "haproxy", direction: "up", quantile: QUANTILE, time: s(0.000226) },
    down: { hop: "haproxy", direction: "down", quantile: QUANTILE, time: s(0.000201) },
  },
  toxiproxy: {
    up: { hop: "toxiproxy", direction: "up", quantile: QUANTILE, time: s(0.00038) },
    down: { hop: "toxiproxy", direction: "down", quantile: QUANTILE, time: s(0.00035) },
  },
};
