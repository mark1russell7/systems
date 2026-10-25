import type { KindCell, Mesh } from "@mark1russell7/kind";
import { T07_WORKLOAD, WORKERS, kubeDefaults, s } from "../kind.ts";
import type { Alias } from "../mongo/cells.ts";

/**
 * The gRPC cells of T15: the endpoint lifecycle of T07 through an Istio 1.31.3 mesh in the kind lab.
 * The client of grpc-js 1.14.6 and the server grpc-go v1.84.0 are the stack `grpc` of T07. Each pod
 * has an Envoy sidecar, thus each call crosses two mesh hops: the sidecar of the client and the
 * sidecar of the server. The source of each fact is Istio at the tag 1.31.3 (`I/`), its Envoy
 * v1.39.4, and the kubelet of v1.37.0.
 *
 * The client sidecar balances each call over the replicas from its endpoints (EDS), not each
 * connection. Thus the propagation of a deletion is the push of istiod to each client sidecar, and
 * not a sync of kube-proxy. The calibration measures that push: from the deletion to the first poll
 * of each client sidecar without the pod.
 *
 * This is step 1 of the plan of T15: the sidecar flavor in kind, the calibration, and the deletion as
 * a measurement. Step 2 gives the deletion its band from the calibration.
 */

/** This mesh is the sidecar flavor of Istio 1.31.3 with each pod of the cell in sidecar mode. */
export const SIDECAR: Mesh = { flavor: "sidecar", mode: "sidecar" };

/** These are the parts of each sidecar cell of T15: the stack `grpc` of T07 in the sidecar mesh, on iptables, with 2 workers. */
const BASE = {
  template: "T15",
  stack: "grpc",
  mesh: SIDECAR,
  substitutes: null,
  mode: "iptables",
  workers: WORKERS,
  declaration: null,
  workload: T07_WORKLOAD,
  runs: 11,
} as const;

/**
 * This text is why the deletion of T15.defaults.13 is a measurement. Each fact has its source in
 * Istio 1.31.3, Envoy v1.39.4 or the kubelet of v1.37.0.
 */
const DELETION_WHY = [
  "At the deletion, grpc-go gets SIGTERM, and the preStop hook of the native sidecar starts the drain of pilot-agent at the same time (injection-template.yaml of Istio 1.31.3, lines 225–235, and kuberuntime_container.go at v1.37.0, lines 895–915).",
  "grpc-go closes its listener and sends GOAWAY. A call that reaches the leaving pod then gets a local 503 from its inbound sidecar, thus UNAVAILABLE, and the client sidecar retries it on the other replica (retry.go, lines 36–57: 2 retries on connect-failure, refused-stream, unavailable and cancelled).",
  "When grpc-go exits, the kubelet stops the sidecar, and pilot-agent kills Envoy (agent.go, lines 146–163). A call in flight on that connection gets a reset before its headers, and a reset is not on the retry list.",
  "A connect after the address of the pod goes gets no answer until EDS drops the pod. istiod drops a terminating endpoint (endpoint_builder.go, lines 623–632) after its debounce of 100 ms to 10 s (tuning.go, lines 77–104). The connect timeout of the sidecar is 10 s, longer than the 2 s of the client.",
  "No calibration bounds the push of EDS yet (CAL.T15.sidecar), thus the run keeps the measurement.",
].join(" ");

/** These are the gRPC cells of T15 for the kind lab: the calibration of the propagation, and the deletion. */
export const T15_GRPC: readonly KindCell[] = [
  {
    ...BASE,
    id: "CAL.T15.sidecar",
    name: "T15 sidecar, gRPC, the propagation of a deletion to each client sidecar, preStop 10 s",
    trigger: { kind: "pod-deletion" },
    pod: { ...kubeDefaults(2), preStop: s(10), grace: s(40) },
    prediction: {
      kind: "none",
      why: "grpc-go gets SIGTERM after a preStop sleep of 10 s. EDS drops the terminating endpoint before that (endpoint_builder.go of Istio 1.31.3, lines 623–632), thus each call goes to the other replica",
    },
    calibrates: true,
  },
  {
    ...BASE,
    id: "T15.defaults.13",
    name: "T15 sidecar, gRPC, pod deletion: the retries of the client sidecar, no preStop",
    trigger: { kind: "pod-deletion" },
    pod: kubeDefaults(2),
    prediction: { kind: "measured", why: DELETION_WHY },
    calibrates: false,
  },
];

/** These are the cells of the plan over grpc-go in T15 that are cells of this catalog under other names. */
export const T15_GRPC_ALIASES: readonly Alias[] = [
  {
    plan: "T15.array.13",
    is: "T15.defaults.13",
    why: "DP51 is the sidecar at the defaults of Istio 1.31: a terminationDrainDuration of 5 s, native sidecars on, and no DestinationRule, thus no pool settings and no outlier detection. Each one is a default of the install of the lab, as in T15.defaults.13",
  },
];
