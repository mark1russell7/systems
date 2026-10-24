import type { Declaration, KubeletProbe, PodSettings, Workload } from "@mark1russell7/kind";
import type { KubeProxyMode, Propagation } from "@mark1russell7/kind";
import { DOCUMENTED, scenario } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { format, valueIn } from "@mark1russell7/quantity";
import { NF_CONNTRACK_TCP } from "@mark1russell7/machines";
import type { RedisKnobs } from "@mark1russell7/service/redis";

/**
 * This module holds the defaults of the plan for the kind templates, T07 and T18, as explicit
 * values. The pod gets the defaults of Kubernetes. The service gets the health design of the
 * plan. Its checks poll every 5 s ± 20 % with a 4 s timeout, and its latch fails after 3 polls and
 * recovers after 1. Its liveness window is 45 s, and each stage of the shutdown has a cap.
 */

export const s = (value: number): Quantity => ({ value, unit: "s" });
export const ms = (value: number): Quantity => ({ value, unit: "ms" });
/** This function prints an amount for the text of a prediction, to the microsecond: `0.105 s`. */
export const say = (amount: Quantity): string => format(amount, { digits: 6 });

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
export const withHold = (hold: Quantity): Declaration["phases"] =>
  DESIGN_PHASES.map(([stage, cap]) =>
    stage === "fail readiness"
      ? [stage, hold]
      : stage === "drain"
        ? [stage, s(valueIn(cap, "s") - (valueIn(hold, "s") - 2))]
        : [stage, cap],
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
 * This workload is the clients of T07: a request each 20 ms on a new connection, and a timeout of
 * 2 s. A SYN or a SYN-ACK that the path loses comes again after `TCP_TIMEOUT_INIT`, 1 s
 * (`include/net/tcp.h` at 6.17, line 155). The timer wheel fires that timer up to 64 ms late at HZ
 * 1000 (`calc_wheel_index` in `kernel/time/timer.c`). With a timeout of 1 s, the client stops
 * before the retransmission, and one lost segment fails a request. With 2 s, the retransmission
 * comes first, and a kernel record shows it with its port. A stale entry of IPVS drops the first
 * SYN only, thus its retransmission gets a live pod.
 */
export const T07_WORKLOAD: Workload = { every: ms(20), timeout: s(2) };

/**
 * This time is how long a node keeps the entry of a connection to a pod address with no answer:
 * SYN_SENT, 2 min. Conntrack, the path of iptables and nftables, gives it in
 * `net/netfilter/nf_conntrack_proto_tcp.c` at 6.17, line 62. A new SYN from the same port goes
 * through that entry and its NAT (lines 576–593), and it does not renew the timer (lines
 * 1309–1316). IPVS gives it in `net/netfilter/ipvs/ip_vs_proto_tcp.c`, line 368, and each packet
 * renews it (`ip_vs_conn.c`, line 472). kube-proxy v1.37.0 removes the stale entries of UDP only
 * (`pkg/proxy/conntrack/cleanup.go`, lines 68 and 127).
 */
export const SYN_SENT: Quantity = s(120);

/**
 * This time is how long a node keeps the entry of a connection that a reset from the server
 * closed. The state is CLOSE, and the time is `nf_conntrack_tcp_timeout_close` of the document of
 * conntrack. Its NAT stays to that server. A SYN on a CLOSE entry looks up again only after a FIN, or after a reset from the
 * client (`net/netfilter/nf_conntrack_proto_tcp.c`, the reopen of a closed connection). Thus a new
 * connection of the same client on the same port goes to the old server. A lookup skips an entry
 * after its timeout, thus the life has no lateness of the garbage collector. In CI on 2026-10-18
 * (run 39086688749), a client used the port of a reset again 6.8 s later, and its SYN went to the
 * deleted pod.
 */
export const CLOSE: Quantity = s(Number(NF_CONNTRACK_TCP.knobs["nf_conntrack_tcp_timeout_close"]!.default));

/**
 * This table is the propagation of the endpoints for each kube-proxy mode, after a deletion. The
 * cluster has one control plane and 2 workers, on a runner of GitHub. Each bound is from the CAL
 * cells of T07: 33 times for each mode, 3 nodes in 11 runs. The upper bound is the
 * longest poll without the pod. The lower bound is the shortest such poll less the 50 ms of a
 * poll, and not below zero. `DOCUMENTED` is the bound before a calibration, `minSyncPeriod`.
 */
export const PROPAGATION: Readonly<Record<KubeProxyMode, Propagation>> = {
  iptables: { lo: s(0), hi: s(0.105), from: "CAL.T07.iptables: median 0.059 s, 33 times" },
  ipvs: { lo: s(0.073), hi: s(0.309), from: "CAL.T07.ipvs: median 0.192 s, 33 times" },
  nftables: { lo: s(0), hi: s(0.079), from: "CAL.T07.nftables: median 0.045 s, 33 times" },
};

/** This propagation is the bound of the documents, for a cell that a calibration does not cover. */
export const UNCALIBRATED: Propagation = DOCUMENTED;

/** This count is the workers of each kind cell: two, the fewest for a propagation across nodes and a drain to another node. */
export const WORKERS = 2;

/**
 * This function gives the propagation of a change that comes while kube-proxy syncs, or in the
 * `minSyncPeriod` after a sync. The source is kube-proxy v1.37.0:
 * - The runner starts the sync, and then it waits `minSyncPeriod` from the end of that sync. A change in
 *   that time waits for the next sync (`pkg/proxy/runner/bounded_frequency_runner.go`, lines 48–51,
 *   117–120 and 132–141).
 * - Thus a change that comes while a sync runs waits for the end of that sync, then `minSyncPeriod`.
 *   The next sync then applies it, as in an idle cluster (`PROPAGATION`).
 *
 * In a rolling update, the new pod comes into the EndpointSlice before it is ready, and that change
 * starts a sync at once. The old pod gets its deletion while that sync runs, or in the wait after it.
 * In kind run 40128267098, the new pod came into the EndpointSlice 41 ms to 93 ms before each first
 * deletion. Thus the bound has one more sync than an idle change.
 *
 * The bound of one sync is the idle propagation of the mode:
 * - iptables applies the rules with one iptables-restore (`pkg/proxy/iptables/proxier.go`, line 1384).
 *   nftables applies them with one transaction (`pkg/proxy/nftables/proxier.go`, line 1872). After it,
 *   a sync only updates its metrics, its health servers and the conntrack entries of UDP. Thus an idle
 *   propagation holds each step of a sync.
 * - IPVS changes the real servers in its loop over the Services (`pkg/proxy/ipvs/proxier.go`, lines
 *   771–859 and 1574–1717). After that loop, it syncs its ipsets and restores iptables (lines 1168–1188).
 *   For IPVS, that bound is an assumption. The prediction gives the band (`propagation`), thus the
 *   judge tests it in each run.
 *
 * In run 40128267098 (IPVS), the rules of the nodes dropped each first old pod 1.232 s to 1.391 s after
 * its deletion. The old bound, `minSyncPeriod` and one idle propagation, was 1.309 s. In run
 * 39090689204 (iptables), the rules dropped each old pod 0.233 s to 1.065 s after its deletion.
 */
export const afterSync = (mode: KubeProxyMode): Propagation => {
  const wait = scenario("lab", mode, WORKERS).kubeProxy.minSyncPeriod;
  const idle = PROPAGATION[mode];
  const sync = valueIn(idle.hi, "s");
  return {
    lo: idle.lo,
    hi: s(Math.round((valueIn(wait, "s") + 2 * sync) * 1e6) / 1e6),
    from: `a sync of up to ${say(idle.hi)} at the change, minSyncPeriod (${say(wait)}) after it, then ${idle.from}`,
  };
};
