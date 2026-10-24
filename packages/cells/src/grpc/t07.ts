import { recovery, timerOf } from "@mark1russell7/algebra";
import type { KindCell, KubeProxyMode, Prediction, Propagation, TriggerKind } from "@mark1russell7/kind";
import { kubeletBand } from "@mark1russell7/kind";
import { GRPC_JS, LINUX_TCP } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { LINUX_66, given, seconds } from "../catalog.ts";
import { PROPAGATION, T07_WORKLOAD, WORKERS, afterSync, kubeDefaults, s, say } from "../kind.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import { grpcValues } from "./t01.ts";

/**
 * The gRPC cells of T07: the endpoint lifecycle of a Service of grpc-go v1.84.0, with a client of
 * grpc-js 1.14.6 on each node (the stack `grpc` of the kind lab). Each client holds one channel to
 * the ClusterIP and sends a call each 20 ms on it. Thus kube-proxy picks a backend only when grpc-js
 * connects again.
 *
 * At SIGTERM, grpc-go calls GracefulStop: it closes its listener and sends GOAWAY on each connection.
 * A client on that pod then connects again at its next call. Until the rules of its node drop the
 * pod, that connect can go to the pod, whose listener is closed: the pod refuses it. The channel goes
 * to TRANSIENT_FAILURE, and each call fails at once until its next connect, after the first backoff
 * of grpc-js. That connect comes after the propagation, thus it goes to another pod.
 *
 * A rolling update deletes each old pod some milliseconds after a sync of kube-proxy, thus the
 * propagation waits `minSyncPeriod` (`afterSync`). That is longer than the first backoff, and the pod
 * can refuse more than one connect (`lastWait`). Each old pod has a window of its own (`each`).
 *
 * The propagation of a rolling update is also longer than the stop of an old pod. Thus the connect
 * after a GOAWAY can go to an old pod that is gone, while IPVS still has it. That SYN gets no answer,
 * and the calls wait in the queue of the channel. The connect comes two SYNs after the drop of that
 * pod (`stalledConnect`). In kind run 40123580623, 81 calls waited so and ended at their timeout of 2 s.
 *
 * The channels go to the replica that stays after a run, and a new replica gets no client. Thus the
 * target of a run is the replica that answers the most clients, and a scale-in gives it the lowest
 * deletion cost. A target by name had no client in 49 of 55 runs of the first kind run (39388068896).
 *
 * The client connects to the ClusterIP. CoreDNS stays in the cluster for a cell of the plan that names
 * it, but it is not on the path of a connect. The name of the Service resolves to its ClusterIP, which
 * does not change in a run.
 */

/** A wait is the bounds of one wait of the backoff of grpc-js, in seconds. Each bound is its duration less how early it ends, or plus how late. */
export interface Wait {
  readonly lo: number;
  readonly hi: number;
}

/**
 * This function gives the wait `k` of the backoff of grpc-js. A wait goes from the start of a connect
 * that fails to the start of the next connect. It is the timer `reconnect` of the document of grpc-js,
 * with `fired` = k. The wait 0 comes after the first refused connect.
 */
export const backoffOf = (k: number): Wait => {
  const bounds = timerOf(GRPC_JS, "reconnect", given(grpcValues()), k);
  const wait = seconds(bounds.duration, `the wait ${k} of the backoff of grpc-js`);
  return { lo: wait - seconds(bounds.early, "how early the backoff ends"), hi: wait + seconds(bounds.lateness, "how late the backoff ends") };
};

/**
 * This band is the first backoff of grpc-js, the wait 0. The first wait after a ready transport has
 * no jitter, thus it is 1 s and the lateness of one step.
 */
export const FIRST_BACKOFF: Wait = backoffOf(0);

/** This count is the most waits that `lastWait` examines. Their lower bounds add up to more than 60 s, longer than each propagation. */
const MOST_WAITS = 12;

/** This function gives the sum of the lower bounds of the waits 0 to `count` − 1 of the backoff of grpc-js. */
const sumOf = (count: number): number => Array.from({ length: count }, (_, k) => backoffOf(k).lo).reduce((a, b) => a + b, 0);

/**
 * This function gives the index K of the wait after the last connect that a pod can refuse, in a
 * propagation of `hi` seconds. The connect k starts at the earliest after the lower bounds of the
 * waits 0 to k − 1. Only a connect that starts by the end of the propagation can go to the pod. Thus
 * K is the largest k whose sum of these lower bounds is at most `hi`. A propagation shorter than the
 * first wait gives K = 0.
 */
export const lastWait = (hi: number): number => {
  for (let k = 1; k <= MOST_WAITS; k += 1) if (sumOf(k) > hi) return k - 1;
  throw new Error(`a propagation of ${hi} s is longer than ${MOST_WAITS} waits of the backoff of grpc-js`);
};

/** This function rounds a time to the microsecond, thus a band has no float residue. */
const us = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * These are the values of the knobs of Linux TCP in a client pod of the kind lab: the defaults of a
 * network namespace. The runners have Linux 6.17 with `CONFIG_HZ=1000`, and each kind run records them (`runner.txt`).
 */
const KIND_LINUX = given({ ...LINUX_66, hz: { value: 1000, unit: "Hz" } });

/** This function gives the bounds of the wait `k` of the SYN timer of Linux TCP (`syn_retransmit`) in a client pod. */
export const synWaitOf = (k: number): Wait => {
  const bounds = timerOf(LINUX_TCP, "syn_retransmit", KIND_LINUX, k);
  const wait = seconds(bounds.duration, `the wait ${k} of the SYN`);
  return { lo: wait - seconds(bounds.early, "how early the SYN timer fires"), hi: wait + seconds(bounds.lateness, "how late the SYN timer fires") };
};

/**
 * This function gives the latest connect after a SYN to an old pod that is gone, in seconds after
 * the drop of that pod. Until the drop, IPVS sends each SYN to the pod, and no SYN gets an answer.
 * The kube-proxy of v1.37.0 sets `expire_nodest_conn` (`pkg/proxy/ipvs/proxier.go`, line 281). At the
 * drop, it gives the real server the weight 0, or it deletes it (`graceful_termination.go`, lines 147–167).
 *
 * The first SYN after the drop finds the entry of its connection. IPVS expires the entry and drops
 * the SYN, because the conntrack entry of the first SYN is confirmed. The source is
 * `net/netfilter/ipvs/ip_vs_core.c` at 6.17, lines 1997–2048, and `include/net/ip_vs.h`, lines 1812–1824.
 * The expiry also deletes that conntrack entry (`ip_vs_conn.c`, lines 881–890). Thus IPVS sends the next SYN to a live pod (line 2054).
 *
 * The SYN timer arms again at each firing. Thus its first firing after the drop comes one wait later
 * at the most, and the next SYN comes one more wait later. The stall lasts from the first SYN to the drop,
 * up to `hi`. `recovery` gives the firings through that stall, and the longest of their waits bounds each of the two.
 */
export const stalledConnect = (hi: number): number => {
  const through = recovery(LINUX_TCP, "syn_retransmit", KIND_LINUX, s(hi));
  if ("unknown" in through) throw new Error(`the SYN timer through a stall of ${hi} s: ${through.unknown}`);
  // the firing that gets a live pod comes after the last firing that can be the first after the drop
  const connect = Math.max(...through.first) + 1;
  const longest = Math.max(...Array.from({ length: connect + 1 }, (_, k) => synWaitOf(k).hi));
  return us(2 * longest);
};

/**
 * This function gives the time from the deletion to the SIGTERM of grpc-go, from the source of the
 * kubelet of v1.37.0 (`pkg/kubelet/kuberuntime/kuberuntime_container.go`):
 * - `killContainer` starts the preStop hook only when the grace is more than zero (lines 895–898).
 * - `executePreStopHook` waits for the hook for the grace at the most (lines 801–808). It gives the
 *   whole seconds of that wait, and `killContainer` subtracts them from the grace (line 897).
 * - Then the grace is 2 s at the least (lines 907–910, `minimumGracePeriodInSeconds` in
 *   `kuberuntime_manager.go`, line 84). `StopContainer` sends SIGTERM, and SIGKILL after that grace (line 915).
 *
 * Thus a preStop sleep that is longer than the grace stops at the grace, and SIGTERM comes then.
 */
const sigtermOf = (pod: KindCell["pod"]): number => {
  const preStop = valueIn(pod.preStop, "s");
  const grace = valueIn(pod.grace, "s");
  return grace > 0 ? Math.min(preStop, grace) : 0;
};

/**
 * This function gives the prediction of a deletion of a pod of grpc-go. It is a window of failed
 * calls, or none when the SIGTERM comes after the propagation. The window opens at the GOAWAY of the
 * pod (its line `stopping`). A connect that the pod refused waits the backoff of grpc-js. Thus the
 * window closes at most the wait K (`lastWait`) after the propagation, and the next connect goes to
 * another pod. With `each`, the prediction is a window for each deleted replica: a rolling update.
 *
 * In a rolling update, the connect can also go to an old pod that is gone (`stalledConnect`). Then
 * the window closes at the later of the two ends. Only IPVS expires the entry of a SYN to a pod that
 * it dropped. Conntrack keeps the NAT of such a SYN (`SYN_SENT`), thus a rolling update of the other modes has no model here.
 */
export const grpcDeletion = (cell: Pick<KindCell, "pod" | "mode">, propagation: Propagation = PROPAGATION[cell.mode], each = false): Prediction => {
  const preStop = valueIn(cell.pod.preStop, "s");
  const sigterm = sigtermOf(cell.pod);
  const hi = valueIn(propagation.hi, "s");
  const after = `after the propagation (${say(propagation.hi)} at the most, ${propagation.from}). Thus its GOAWAY comes after the rules drop the pod, and each client connects again to another pod`;
  if (sigterm > hi)
    return {
      kind: "none",
      why:
        sigterm < preStop
          ? `the kubelet waits for the preStop sleep of ${say(cell.pod.preStop)} only for the grace of ${say(cell.pod.grace)}, and then it sends SIGTERM with a grace of 2 s (kuberuntime_container.go at v1.37.0, lines 801–808 and 895–915). Thus grpc-go gets SIGTERM ${say(s(sigterm))} after the deletion, ${after}`
          : `grpc-go gets SIGTERM ${say(cell.pod.preStop)} after the deletion, ${after}`,
    };
  const last = lastWait(hi);
  const wait = backoffOf(last);
  const refused = us(hi + wait.hi);
  const connects =
    last === 0
      ? `Each call then fails at once until the next connect, ${say(s(us(FIRST_BACKOFF.lo)))} to ${say(s(us(FIRST_BACKOFF.hi)))} later (the first backoff of grpc-js), and that connect goes to another pod`
      : `Each call then fails at once until the next connect, after the backoff of grpc-js. The waits before the connect ${last} add up to ${say(s(us(sumOf(last))))} at the least, thus the pod can refuse ${last + 1} connects. The last one starts by ${say(propagation.hi)}, and the next connect comes ${say(s(us(wait.hi)))} later at the most (the wait ${last}) and goes to another pod`;
  const why = `grpc-go gets SIGTERM at the deletion (no preStop), closes its listener and sends GOAWAY. A client on that pod connects again, and until the propagation (${say(propagation.hi)} at the most, ${propagation.from}) its connect can go to the pod, which refuses it. ${connects}`;
  const window = (end: number, text: string): Prediction => ({
    kind: "window",
    nodes: "all",
    start: { from: "intake", band: { lo: s(0), hi: propagation.hi } },
    end: { from: "deletion", band: { lo: s(us(FIRST_BACKOFF.lo)), hi: s(end) } },
    certain: false,
    ...(each ? { each: true } : {}),
    why: text,
  });
  if (!each) return window(refused, why);
  if (cell.mode !== "ipvs")
    throw new Error(`a rolling update of ${cell.mode} with SIGTERM before the propagation: conntrack keeps the NAT of a SYN to an old pod that is gone, and no model gives that window`);
  const stall = stalledConnect(hi);
  const end = Math.max(refused, us(hi + stall));
  const first = timerOf(LINUX_TCP, "syn_retransmit", KIND_LINUX, 0);
  const nominal = seconds(first.duration, "the first wait of the SYN");
  const late = seconds(first.lateness, "how late the SYN timer fires");
  return window(
    end,
    `${why}. A rolling update deletes each old pod in turn, thus each old pod has a window of its own. The connect can also go to an old pod of an earlier deletion while the rules still have it. A pod that still runs refuses it, because its listener is closed. A pod that is gone gives no answer, and the calls wait in the queue of the channel until the connect or their timeout. kube-proxy sets expire_nodest_conn (proxier.go at v1.37.0, line 281). The first SYN after the drop of that pod expires its entry of IPVS, and IPVS drops it, because its conntrack entry is confirmed (ip_vs_core.c at 6.17, lines 1997–2048). The next SYN gets a live pod. Each SYN comes ${say(s(nominal))} after the last (tcp_syn_linear_timeouts), ${say(s(late))} late at the most at HZ 1000. Thus the connect comes ${say(s(stall))} after the propagation at the most, ${say(s(end))} after the deletion, and each call that fails starts before it`,
  );
};

/**
 * This function gives the prediction of a liveness restart of grpc-go. The kind lab writes the flag
 * file, and the check of `liveness` answers NOT_SERVING. The source of the kubelet of v1.37.0 gives each step:
 * - The worker of the liveness probe sets a failure only after the threshold of failed probes in
 *   sequence (`pkg/kubelet/prober/worker.go`, lines 366–379). That is 20 s to 30 s at the defaults (`kubeletBand`).
 * - Then the worker stops until it sees a new container (lines 381–390). The failure syncs the pod
 *   (`pkg/kubelet/kubelet.go`, lines 2809–2811).
 * - The sync stops the container and puts it in the containers to start (`kuberuntime_manager.go`, lines
 *   1447–1470). The stop is SIGTERM with the grace of the pod, 30 s (`kuberuntime_container.go`, lines 882–915 and 1423–1439).
 * - The server grpc-go writes `stopping`, and GracefulStop closes its listener and sends GOAWAY. The
 *   container exits when the calls in flight end.
 * - The same sync then starts the new container (`kuberuntime_manager.go`, lines 1620–1629 and
 *   1954–1961). The first restart has no back-off, because the status of the sync has no exited container (lines 2077–2090).
 * - The endpoint stays ready through the stop. A sync sets the status of the pod before its stop and
 *   its start (`kubelet.go`, lines 2108, 2135 and 2267).
 * - The next sync waits for a relist of the PLEG after this one (`pod_workers.go`, line 1288). The PLEG
 *   relists each 1 s (`kubelet.go`, line 215).
 * - In that sync, the new container is not ready until its readiness probe passes, and the kubelet
 *   starts that probe at once (`prober_manager.go`, lines 354–370). The probe checks "".
 * - While the pod is not ready, its endpoint is not ready in the EndpointSlice
 *   (`staging/src/k8s.io/endpointslice/utils.go`, lines 38–43), and the rules drop it after the propagation.
 *
 * A client on the pod connects again at its next call after the GOAWAY. The rules still select the
 * pod, thus that connect can go to it. Until the new container listens, the pod refuses it. Each call
 * of that client then fails at once until its next connect, after the backoff of grpc-js. No document
 * bounds the time from the stop to the listener of the new container. Thus the window opens at the
 * GOAWAY, and it has no end.
 */
export const grpcRestart = (cell: Pick<KindCell, "pod">): Prediction => {
  const kill = kubeletBand(cell.pod.liveness, false);
  return {
    kind: "window",
    nodes: "all",
    start: { from: "intake", band: { lo: s(0), hi: s(0) } },
    end: null,
    certain: false,
    why: `The flag file fails the check of the service liveness. After ${cell.pod.liveness.threshold} failed probes, ${say(kill.lo)} to ${say(kill.hi)} after the flag, the kubelet stops the container with SIGTERM (worker.go at v1.37.0, lines 366–390, and kuberuntime_container.go, lines 882–915). Then grpc-go closes its listener and sends GOAWAY. The same sync starts the new container, with no back-off (kuberuntime_manager.go, lines 1447–1470, 1954–1961 and 2077–2090). The readiness probe checks the service "", thus the endpoint stays ready through the stop. A client on the pod connects again at its next call, and that connect can go to the pod. Until the new container listens, the pod refuses it, and each call of that client fails at once until its next connect, after the backoff of grpc-js. No document bounds the time from the stop to the listener of the new container, thus the window has no end`,
  };
};

/** A spec is one cell: its cell of the plan, its mode, its trigger, its pod and its name. */
interface Spec {
  readonly id: string;
  readonly mode: KubeProxyMode;
  readonly trigger: TriggerKind;
  readonly pod: KindCell["pod"];
  readonly name: string;
}

/** DP28, the hardened rollout: a preStop sleep of 20 s by the native sleep action, in a grace of 30 s. */
const HARDENED = { ...kubeDefaults(3), preStop: s(20), grace: s(30) };

/**
 * DP29, the misconfiguration: a preStop sleep of 60 s in the default grace of 30 s, as 1,070 public
 * files write it. The other form of DP29 is a grace of 0. That is a force deletion at the API server,
 * not a path of the kubelet. Thus this cell has the longer sleep. The API server refuses a sleep action
 * longer than the grace, thus the lab gives the sleep as a command of the container (`serverObjects`).
 *
 * The kubelet of v1.37.0 waits for the hook for the grace at the most (`sigtermOf`). Thus grpc-go gets
 * SIGTERM 30 s after the deletion, after the propagation of a rolling update. The prediction is no failure.
 */
const PRESTOP_PAST_GRACE = { ...kubeDefaults(2), preStop: s(60), grace: s(30) };

/** These are the specs of the gRPC cells of T07. */
export const T07_GRPC_SPECS: readonly Spec[] = [
  { id: "T07.defaults.38", mode: "ipvs", trigger: "pod-deletion", pod: kubeDefaults(2), name: "T07 ipvs, gRPC, pod deletion: GOAWAY at SIGTERM, no preStop" },
  { id: "T07.defaults.4", mode: "iptables", trigger: "scale-in", pod: kubeDefaults(3), name: "T07 iptables, gRPC, scale-in from 3 to 2: GOAWAY at SIGTERM, no preStop" },
  { id: "T07.defaults.10", mode: "nftables", trigger: "node-drain", pod: kubeDefaults(2), name: "T07 nftables, gRPC, node drain: GOAWAY at SIGTERM, no preStop" },
  { id: "T07.array.47", mode: "iptables", trigger: "node-drain", pod: kubeDefaults(2), name: "T07 iptables, gRPC, node drain: GOAWAY at SIGTERM, no preStop" },
  { id: "T07.array.4", mode: "iptables", trigger: "scale-in", pod: HARDENED, name: "T07 iptables, gRPC, scale-in from 3 to 2: GOAWAY after a preStop of 20 s (DP28)" },
  { id: "T07.defaults.12", mode: "ipvs", trigger: "rolling-update", pod: kubeDefaults(2), name: "T07 ipvs, gRPC, rolling update: GOAWAY at SIGTERM, no preStop" },
  {
    id: "T07.array.46",
    mode: "iptables",
    trigger: "rolling-update",
    pod: PRESTOP_PAST_GRACE,
    name: "T07 iptables, gRPC, rolling update: a preStop of 60 s in a grace of 30 s (DP29)",
  },
  { id: "T07.defaults.35", mode: "nftables", trigger: "liveness-restart", pod: kubeDefaults(2), name: "T07 nftables, gRPC, liveness restart: GOAWAY at SIGTERM, the endpoint stays ready" },
];

/** This function gives the cell of a spec. */
const cellOf = (spec: Spec): KindCell => {
  const cell = {
    id: spec.id,
    name: spec.name,
    template: "T07",
    stack: "grpc",
    substitutes: null,
    mode: spec.mode,
    workers: WORKERS,
    trigger: { kind: spec.trigger },
    pod: spec.pod,
    declaration: null,
    workload: T07_WORKLOAD,
    calibrates: false,
    runs: 11,
  } as const;
  // a rolling update deletes each old pod in turn, each one some milliseconds after the sync for a new
  // ready pod: its removal waits minSyncPeriod (`afterSync`), and each old pod has a window of its own
  const rolling = spec.trigger === "rolling-update";
  if (rolling) return { ...cell, prediction: grpcDeletion(cell, afterSync(spec.mode), true) };
  // the kubelet stops the container and starts it again: no deletion, and the endpoint stays ready
  return { ...cell, prediction: spec.trigger === "liveness-restart" ? grpcRestart(cell) : grpcDeletion(cell) };
};

/** These are the gRPC cells of T07 for the kind lab. */
export const T07_GRPC: readonly KindCell[] = T07_GRPC_SPECS.map(cellOf);

/** These are the cells of the plan over grpc-go in T07 that are cells of this catalog under other names. */
export const T07_GRPC_ALIASES: readonly Alias[] = [
  { plan: "T07.array.10", is: "T07.defaults.10", why: "DP07 sets ingress-nginx in front of Node: no knob of grpc-go, grpc-js or kube-proxy" },
  { plan: "T07.array.38", is: "T07.defaults.38", why: "DP37 sets the timeouts of conntrack for an established flow (86,400 s) and for CLOSE_WAIT (3,600 s): no flow of a run lives that long" },
  {
    plan: "T07.array.12",
    is: "T07.defaults.12",
    why: "DP53 sets externalTrafficPolicy Local behind a cloud load balancer: no knob of grpc-go, grpc-js or kube-proxy on the path to the ClusterIP, and T07 has no cloud load balancer",
  },
  {
    plan: "T07.array.35",
    is: "T07.defaults.35",
    why: "DP26 is the defaults of a rollout: a grace of 30 s, no preStop, and probes of 10 s with a timeout of 1 s and a threshold of 3. Each one is the default of Kubernetes, as in T07.defaults.35",
  },
];

const CILIUM = "the kind lab has the dataplane of kube-proxy only: no Cilium";

/** These are the cells of the plan over grpc-go in T07 that this catalog does not start, each with its reason. */
export const T07_GRPC_WAITING: readonly Waiting[] = [
  { plan: "T07.defaults.17", trigger: "event:crash", why: CILIUM },
  { plan: "T07.array.17", trigger: "event:crash", why: CILIUM },
  { plan: "T07.defaults.20", trigger: "freeze-process", why: CILIUM },
  { plan: "T07.array.20", trigger: "freeze-process", why: CILIUM },
];
