import { timerOf } from "@mark1russell7/algebra";
import type { KindCell, KubeProxyMode, Prediction, Propagation, TriggerKind } from "@mark1russell7/kind";
import { GRPC_JS } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { given, seconds } from "../catalog.ts";
import { PROPAGATION, T07_WORKLOAD, WORKERS, kubeDefaults, s, say } from "../kind.ts";
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
 * The channels go to the replica that stays after a run, and a new replica gets no client. Thus the
 * target of a run is the replica that answers the most clients, and a scale-in gives it the lowest
 * deletion cost. A target by name had no client in 49 of 55 runs of the first kind run (39388068896).
 *
 * The client connects to the ClusterIP. CoreDNS stays in the cluster for a cell of the plan that names
 * it, but it is not on the path of a connect. The name of the Service resolves to its ClusterIP, which
 * does not change in a run.
 */

/**
 * This band is the first backoff of grpc-js: from the start of a connect that fails to the start of
 * the next connect. It is the timer `reconnect` of the document of grpc-js, at its first wait.
 */
export const FIRST_BACKOFF = (() => {
  const bounds = timerOf(GRPC_JS, "reconnect", given(grpcValues()), 0);
  const wait = seconds(bounds.duration, "the first backoff of grpc-js");
  return { lo: wait - seconds(bounds.early, "how early the backoff ends"), hi: wait + seconds(bounds.lateness, "how late the backoff ends") };
})();

/** This function rounds a time to the microsecond, thus a band has no float residue. */
const us = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * This function gives the prediction of a deletion of a pod of grpc-go. It is a window of failed
 * calls, or none when the preStop sleep outlasts the propagation. The window opens at the GOAWAY of
 * the pod (its line `stopping`). It closes at most one first backoff after the propagation. A connect
 * that the pod refused waits that backoff, and the next connect goes to another pod.
 */
export const grpcDeletion = (cell: Pick<KindCell, "pod" | "mode">, propagation: Propagation = PROPAGATION[cell.mode]): Prediction => {
  const preStop = valueIn(cell.pod.preStop, "s");
  const hi = valueIn(propagation.hi, "s");
  if (preStop > hi)
    return {
      kind: "none",
      why: `grpc-go gets SIGTERM ${say(cell.pod.preStop)} after the deletion, after the propagation (${say(propagation.hi)} at the most, ${propagation.from}). Thus its GOAWAY comes after the rules drop the pod, and each client connects again to another pod`,
    };
  // the second connect of a client must come after the propagation, else the pod can refuse it too
  if (hi >= FIRST_BACKOFF.lo)
    throw new Error(`the propagation (${hi} s) is not shorter than the first backoff of grpc-js (${FIRST_BACKOFF.lo} s): a client can connect to the pod twice`);
  return {
    kind: "window",
    nodes: "all",
    start: { from: "intake", band: { lo: s(0), hi: propagation.hi } },
    end: { from: "deletion", band: { lo: s(us(FIRST_BACKOFF.lo)), hi: s(us(hi + FIRST_BACKOFF.hi)) } },
    certain: false,
    why: `grpc-go gets SIGTERM at the deletion (no preStop), closes its listener and sends GOAWAY. A client on that pod connects again, and until the propagation (${say(propagation.hi)} at the most, ${propagation.from}) its connect can go to the pod, which refuses it. Each call then fails at once until the next connect, ${say(s(us(FIRST_BACKOFF.lo)))} to ${say(s(us(FIRST_BACKOFF.hi)))} later (the first backoff of grpc-js), and that connect goes to another pod`,
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

/** These are the specs of the gRPC cells of T07. */
export const T07_GRPC_SPECS: readonly Spec[] = [
  { id: "T07.defaults.38", mode: "ipvs", trigger: "pod-deletion", pod: kubeDefaults(2), name: "T07 ipvs, gRPC, pod deletion: GOAWAY at SIGTERM, no preStop" },
  { id: "T07.defaults.4", mode: "iptables", trigger: "scale-in", pod: kubeDefaults(3), name: "T07 iptables, gRPC, scale-in from 3 to 2: GOAWAY at SIGTERM, no preStop" },
  { id: "T07.defaults.10", mode: "nftables", trigger: "node-drain", pod: kubeDefaults(2), name: "T07 nftables, gRPC, node drain: GOAWAY at SIGTERM, no preStop" },
  { id: "T07.array.47", mode: "iptables", trigger: "node-drain", pod: kubeDefaults(2), name: "T07 iptables, gRPC, node drain: GOAWAY at SIGTERM, no preStop" },
  { id: "T07.array.4", mode: "iptables", trigger: "scale-in", pod: HARDENED, name: "T07 iptables, gRPC, scale-in from 3 to 2: GOAWAY after a preStop of 20 s (DP28)" },
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
  return { ...cell, prediction: grpcDeletion(cell) };
};

/** These are the gRPC cells of T07 for the kind lab. */
export const T07_GRPC: readonly KindCell[] = T07_GRPC_SPECS.map(cellOf);

/** These are the cells of the plan over grpc-go in T07 that are cells of this catalog under other names. */
export const T07_GRPC_ALIASES: readonly Alias[] = [
  { plan: "T07.array.10", is: "T07.defaults.10", why: "DP07 sets ingress-nginx in front of Node: no knob of grpc-go, grpc-js or kube-proxy" },
  { plan: "T07.array.38", is: "T07.defaults.38", why: "DP37 sets the timeouts of conntrack for an established flow (86,400 s) and for CLOSE_WAIT (3,600 s): no flow of a run lives that long" },
];

const ROLLING = "a rolling update deletes each old pod in turn, and a window of the judge has one target: each old pod needs its own window";
const CILIUM = "the kind lab has the dataplane of kube-proxy only: no Cilium";
const LIVENESS = "the liveness probe of grpc-go is the gRPC probe of the kubelet, and nothing fails it while the process serves: grpc-go has no seam for a liveness restart";

/** These are the cells of the plan over grpc-go in T07 that this catalog does not start, each with its reason. */
export const T07_GRPC_WAITING: readonly Waiting[] = [
  { plan: "T07.defaults.12", trigger: "event:rolling-update", why: ROLLING },
  { plan: "T07.array.12", trigger: "event:rolling-update", why: `as T07.defaults.12. DP53 sets externalTrafficPolicy Local behind a cloud load balancer, and T07 has none` },
  { plan: "T07.array.46", trigger: "event:rolling-update", why: `as T07.defaults.12, with the preStop of DP29 longer than the grace` },
  { plan: "T07.defaults.35", trigger: "event:liveness-restart", why: LIVENESS },
  { plan: "T07.array.35", trigger: "event:liveness-restart", why: "as T07.defaults.35. DP26 is the defaults of a rollout" },
  { plan: "T07.defaults.17", trigger: "event:crash", why: CILIUM },
  { plan: "T07.array.17", trigger: "event:crash", why: CILIUM },
  { plan: "T07.defaults.20", trigger: "freeze-process", why: CILIUM },
  { plan: "T07.array.20", trigger: "freeze-process", why: CILIUM },
];
