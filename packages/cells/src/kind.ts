import type { Quantity } from "@mark1russell7/quantity";
import type { RedisKnobs } from "@mark1russell7/service/redis";
import type { Declaration, KubeletProbe, PodSettings, Workload } from "@systems/kind";
import type { KubeProxyMode, Propagation } from "@systems/kind";
import { DOCUMENTED } from "@systems/kind";

/**
 * This module holds the defaults of the plan for the kind templates, T07 and T18, as explicit
 * values. The pod gets the defaults of Kubernetes. The service gets the health design of the
 * plan. Its checks poll every 5 s ± 20 % with a 4 s timeout, and its latch fails after 3 polls and
 * recovers after 1. Its liveness window is 45 s, and each stage of the shutdown has a cap.
 */

export const s = (value: number): Quantity => ({ value, unit: "s" });
export const ms = (value: number): Quantity => ({ value, unit: "ms" });

/** This probe is the default of Kubernetes: a period of 10 s, a threshold of 3 and a timeout of 1 s. */
export const KUBE_PROBE: KubeletProbe = { period: s(10), threshold: 3, timeout: s(1) };
/** This probe is the readiness probe of the chart of the design: 2 s × 3. */
export const CHART_READINESS: KubeletProbe = { period: s(2), threshold: 3, timeout: s(1) };

/** These are the pod settings at the defaults of Kubernetes: a grace of 30 s, no preStop hook and no startup probe. */
export const kubeDefaults = (replicas: number): PodSettings => ({
  replicas,
  grace: s(30),
  preStop: s(0),
  readiness: KUBE_PROBE,
  liveness: KUBE_PROBE,
  startup: null,
});

/** These are the caps of the stages of the shutdown in the design: 28 s in sum, inside the grace of 30 s. */
export const DESIGN_PHASES: Declaration["phases"] = [
  ["fail readiness", s(2)],
  ["stop intake", s(5)],
  ["drain", s(15)],
  ["close transports", s(2)],
  ["stop the poller", s(1)],
  ["tear down dependencies", s(2)],
  ["close the health server", s(1)],
];

/** This function gives the phases of the design with another hold of `fail readiness`, and the drain shorter by the same time. */
export const withHold = (hold: number): Declaration["phases"] =>
  DESIGN_PHASES.map(([stage, cap]) =>
    stage === "fail readiness" ? [stage, s(hold)] : stage === "drain" ? [stage, s(cap.value - (hold - 2))] : [stage, cap],
  );

/** These are the knobs of the Redis client of the service. Each command ends in 2 s, inside the 4 s timeout of a poll. */
export const REDIS_KNOBS: RedisKnobs = {
  connect_bound: s(1),
  request_timeout: s(2),
  driver_writeoff_time: s(3),
  keepalive_idle: s(10),
  heartbeat_interval: s(5),
  heartbeat_timeout: s(1),
  client_retry_window: s(30),
  retry_base: ms(100),
  retry_cap: s(2),
  close_bound: ms(500),
  max_connection_age: { value: "infinite", unit: "s" },
  retrans_giveup_time: s(924.6),
};

/** This declaration is the health design without Redis: the server of T07. Liveness fails readiness, as in the design. */
export const DESIGN: Declaration = {
  poll: { interval: s(5), jitter: 0.2, timeout: s(4) },
  readiness: { type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 },
  liveness: { type: "window", failAfter: s(45) },
  startup: s(60),
  phases: DESIGN_PHASES,
  cooperativeWindow: s(5),
  couplings: [{ from: "liveness", to: "readiness", effect: "fails" }],
  redis: null,
  flag: null,
  watchdog: { tick: s(1), threshold: s(2) },
};

/** This declaration is the health design with Redis: the round trip of the client gates readiness, the fleet of T18. */
export const DESIGN_REDIS: Declaration = { ...DESIGN, redis: { gates: "readiness", knobs: REDIS_KNOBS, misses: 2 } };

/** This workload is one client on each node, with a request each 20 ms on a new connection, and a timeout of 1 s. */
export const WORKLOAD: Workload = { every: ms(20), timeout: s(1) };

/**
 * This table is the propagation of the endpoints for each kube-proxy mode, in seconds after a
 * deletion. The cluster has one control plane and 2 workers, on a runner of GitHub. Each bound is
 * from the CAL cells of T07: 33 times for each mode, 3 nodes in 11 runs. The upper bound is the
 * longest poll without the pod. The lower bound is the shortest such poll less the 50 ms of a
 * poll, and not below zero. `DOCUMENTED` is the bound before a calibration, `minSyncPeriod`.
 */
export const PROPAGATION: Readonly<Record<KubeProxyMode, Propagation>> = {
  iptables: { lo: 0, hi: 0.105, from: "CAL.T07.iptables: median 0.059 s, 33 times" },
  ipvs: { lo: 0.073, hi: 0.309, from: "CAL.T07.ipvs: median 0.192 s, 33 times" },
  nftables: { lo: 0, hi: 0.079, from: "CAL.T07.nftables: median 0.045 s, 33 times" },
};

/** This propagation is the bound of the documents, for a cell that a calibration does not cover. */
export const UNCALIBRATED: Propagation = DOCUMENTED;

/** This count is the workers of each kind cell: two, the fewest for a propagation across nodes and a drain to another node. */
export const WORKERS = 2;
