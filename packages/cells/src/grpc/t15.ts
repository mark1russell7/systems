import type { KindCell, Mesh, Prediction, Propagation } from "@mark1russell7/kind";
import { EDS_EVERY, LAST_SLACK } from "@mark1russell7/kind";
import { ENVOY_HTTP2, ZTUNNEL_HBONE } from "@mark1russell7/machines";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Calibration } from "../kind.ts";
import { T07_WORKLOAD, WORKERS, calibrated, kubeDefaults, s, say } from "../kind.ts";
import type { Alias } from "../mongo/cells.ts";
import { backoffOf, lastWait } from "./t07.ts";

/**
 * The gRPC cells of T15: the endpoint lifecycle of T07 through an Istio 1.31.3 mesh in the kind lab.
 * The client of grpc-js 1.14.6 and the server grpc-go v1.84.0 are the stack `grpc` of T07. Each pod
 * has an Envoy sidecar, thus each call crosses two mesh hops: the sidecar of the client and the
 * sidecar of the server. The source of each fact is Istio at the tag 1.31.3, its Envoy v1.39.4, and
 * the kubelet of v1.37.0. The documents `istio-sidecar-outbound`, `istio-sidecar-inbound` and
 * `pilot-agent` of `@mark1russell7/machines` hold these facts.
 *
 * The client sidecar balances each call over the replicas from its endpoints (EDS), not each
 * connection. Thus the propagation of a deletion is the push of istiod to each client sidecar, and
 * not a sync of kube-proxy. A policy goes to the server sidecars as an update of LDS.
 *
 * Step 2 of the plan of T15 gave the deletion its band from the calibration of step 1. The policy
 * got a calibration of its LDS update, and a band from the documented debounce until then.
 *
 * Step 3 adds the ambient mesh: ztunnel on each node, and no sidecar. The agent istio-cni redirects
 * the traffic of each pod to ztunnel in the network namespace of the pod. Each ztunnel balances each
 * connection, not each call. Thus a channel stays on one replica, as in T07. The document
 * `ztunnel-hbone` holds the facts of ztunnel 1.31.3.
 */

/** This mesh is the sidecar flavor of Istio 1.31.3 with each pod of the cell in sidecar mode. */
export const SIDECAR: Mesh = { flavor: "sidecar", mode: "sidecar" };

/** This mesh is the ambient flavor of Istio 1.31.3 with each pod of the cell in ambient mode. */
export const AMBIENT: Mesh = { flavor: "ambient", mode: "ambient" };

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
 * This calibration is the push of EDS after a deletion, from CAL.T15.sidecar in kind run 40147396211.
 * It counts the first poll of each client sidecar without the pod: 3 nodes in 11 runs.
 */
export const EDS_CALIBRATION: Calibration = { cell: "CAL.T15.sidecar", run: 40147396211, count: 33, min: s(0.128), median: s(0.168), max: s(0.205), poll: EDS_EVERY };

/** This propagation is the push of EDS to each client sidecar after a deletion (`calibrated`). */
export const P_EDS: Propagation = calibrated(EDS_CALIBRATION);

/**
 * This propagation is the LDS update of each server sidecar after a change of a policy, before a
 * calibration. The debounce of istiod pushes a change after 100 ms with no other change, and at
 * most 10 s after the first change (tuning.go of Istio 1.31.3, lines 77–90).
 */
export const P_LDS: Propagation = { lo: s(0.1), hi: s(10), from: "PILOT_DEBOUNCE_AFTER (100 ms) to PILOT_DEBOUNCE_MAX (10 s), not calibrated" };

/**
 * This time is the next call of a client to one replica after a change. A client sends a call each
 * 20 ms, and the client sidecar sends each call to either replica with a chance of 1 in 2. Thus 12
 * calls in sequence miss one replica with a chance of 1 in 4096. It is the slack of the last failure
 * of the judge (`LAST_SLACK`), from the same reason.
 */
export const NEXT_CALL: Quantity = LAST_SLACK;

/** This time is the lateness of one step of the event loop of Envoy (`slack` of `envoy-http2`). */
const STEP: Quantity = s(ENVOY_HTTP2.knobs["slack"]!.default!);

/** This function gives the sum of times in seconds, rounded to the microsecond. */
const sum = (...times: readonly Quantity[]): Quantity => s(Math.round(times.reduce((total, time) => total + valueIn(time, "s"), 0) * 1e6) / 1e6);

/**
 * This function gives the window of a deletion in the sidecar mesh. Each failure starts before the
 * client sidecar of its node drops the pod. It is a reset at the SIGKILL of the Envoy of the pod, or
 * a connect with no answer. Thus the window starts at the deletion and ends one propagation of EDS
 * after it. The timeout of the client ends such a call later, but the judge places a call by its
 * start. A drop after the band agrees with the law, and its cell is `extend`.
 */
export const sidecarDeletion = (propagation: Propagation, why: string): Prediction => ({
  kind: "window",
  nodes: "all",
  start: { from: "deletion", band: { lo: s(0), hi: propagation.hi } },
  end: { from: "deletion", band: { lo: s(0), hi: propagation.hi } },
  certain: false,
  propagation: { lo: propagation.lo, hi: propagation.hi },
  why,
});

/**
 * This function gives the window of a policy that denies the clients for `hold`. Each server sidecar
 * takes the update in `propagation` after the apply. Its open connection keeps the old chain until its
 * next response carries the GOAWAY notice. The next call after it opens a connection on the new chain,
 * and gets a denial. Thus the first denial starts by the update and two next calls.
 *
 * After the delete, the next call on the denying chain is the last denial. The window is certain when
 * the latest first denial comes before the delete.
 */
export const policyWindow = (propagation: Propagation, hold: Quantity, why: string): Prediction => {
  const first = sum(propagation.hi, NEXT_CALL, NEXT_CALL, STEP);
  return {
    kind: "window",
    nodes: "all",
    start: { from: "fault", band: { lo: propagation.lo, hi: first } },
    end: { from: "heal", band: { lo: propagation.lo, hi: sum(propagation.hi, NEXT_CALL, STEP) } },
    certain: valueIn(first, "s") < valueIn(hold, "s"),
    outcomes: ["denied"],
    propagation: { lo: propagation.lo, hi: propagation.hi },
    why,
  };
};

/**
 * This text is why the deletion of T15.defaults.13 fails in its window. Each fact has its source in
 * Istio 1.31.3, Envoy v1.39.4 or the kubelet of v1.37.0.
 */
const DELETION_WHY = [
  "At the deletion, grpc-go gets SIGTERM, and the preStop hook of the native sidecar starts the drain of pilot-agent at the same time (injection-template.yaml of Istio 1.31.3, lines 225–235, and kuberuntime_container.go at v1.37.0, lines 895–915).",
  "grpc-go closes its listener and sends GOAWAY. A call that reaches the leaving pod then gets a local 503 from its inbound sidecar, thus UNAVAILABLE. The inbound route of a port of gRPC has no retry policy (route.go, lines 1321–1341). The client sidecar retries the call on the other replica (retry.go, lines 35–50).",
  "When grpc-go exits, the kubelet stops the sidecar, and pilot-agent kills Envoy (agent.go, lines 146–164). A call in flight on that connection gets a reset before its headers, and a reset is not on the retry list.",
  "A connect after the address of the pod goes gets no answer until EDS drops the pod (endpoint_builder.go, lines 623–632). The connect timeout of the sidecar is 10 s, longer than the 2 s of the client.",
  `Each such call starts before the client sidecar of its node drops the pod, thus the window ends one push of EDS after the deletion: ${say(P_EDS.hi)} (${P_EDS.from}). The timeout ends such a call later, but the judge places a call by its start.`,
].join(" ");

/** This hold is the time of a policy: longer than the documented debounce and two next calls, thus the policy denies a call in it. */
const POLICY_HOLD = s(15);

/** This text is why the policy of T15.defaults.5 fails only in its window, and only with PERMISSION_DENIED. */
const POLICY_WHY = [
  "The policy denies the principal of the clients on the server pods. Its RBAC filter is in the inbound chain, and a change of it pushes LDS (builder.go of Istio 1.31.3, lines 321–330, and lds.go, lines 46–55).",
  "Envoy updates the chain in place. An open connection keeps the old chain until the headers of its next response carry the GOAWAY notice (conn_manager_impl.cc of Envoy v1.39.4, lines 1959–1968).",
  "A call on a new connection meets the new chain: the local reply 403, thus PERMISSION_DENIED (rbac_filter.cc, lines 234–235, and status.cc, lines 14–15). The client sidecar does not retry it, because retriable-status-codes lists no code.",
  `Each server sidecar takes the update in ${say(P_LDS.lo)} to ${say(P_LDS.hi)} after the apply and after the delete (${P_LDS.from}). Each next call to one replica comes in ${say(NEXT_CALL)}.`,
  "The judge places a call by its start, and a call starts before the handshake of its new connection, thus the band has no handshake.",
].join(" ");

/** This time is the lateness of one step of the runtime of ztunnel (`slack` of `ztunnel-hbone`). */
const ZTUNNEL_STEP: Quantity = s(ZTUNNEL_HBONE.knobs["slack"]!.default!);

/** This hold is the time of the reset of T15.defaults.12. */
const RESET_HOLD = s(10);

/**
 * This time is the most that the heal of a reset comes after its hold. The lab commits the clear
 * 700 ms after the end of the hold (`--at`), and it reads the tables of each replica before it.
 */
const HEAL_LATE = s(2);

/** This function rounds a time in seconds to the microsecond, as a quantity. */
const us = (seconds: number): Quantity => s(Math.round(seconds * 1e6) / 1e6);

/**
 * This function gives the window of a reset of the mesh leg for `hold`, in the ambient mesh. The rule
 * in each replica answers the next segment of each client pod with a reset. A call sends a segment
 * each 20 ms, thus the window starts by one call and one step of ztunnel after the fault.
 *
 * Until the heal, each connect of grpc-js fails in a few milliseconds, and each wait of its backoff
 * follows. After the heal, the next connect comes at the end of the wait in progress. The heal comes
 * at most `hold` and `HEAL_LATE` after the fault. Thus that wait is at most the wait K = `lastWait`
 * of that time, the backoff model of T07.
 */
export const resetWindow = (hold: Quantity, why: string): Prediction => {
  const wait = backoffOf(lastWait(valueIn(hold, "s") + valueIn(HEAL_LATE, "s")));
  return {
    kind: "window",
    nodes: "all",
    start: { from: "fault", band: { lo: s(0), hi: sum(T07_WORKLOAD.every, ZTUNNEL_STEP) } },
    end: { from: "heal", band: { lo: s(0), hi: us(wait.hi) } },
    certain: true,
    outcomes: ["error", "reset", "refused"],
    why,
  };
};

/** This index is the wait of the backoff of grpc-js that the heal of T15.defaults.12 can come in. */
const RESET_WAIT = lastWait(valueIn(RESET_HOLD, "s") + valueIn(HEAL_LATE, "s"));

/**
 * This text is why the reset of T15.defaults.12 fails in its window. Each fact has its source in
 * ztunnel 1.31.3 or grpc-js 1.14.6.
 */
const RESET_WHY = [
  "The rule in each server pod answers the next segment of each client pod with a reset. That segment is on the HBONE connection of the ztunnel of the client, from the address of the client pod to the port 15008.",
  "ztunnel drops the connection, and its copy loop shuts down the socket of the app. grpc-js gets a FIN, and the call in flight fails (h2.rs of ztunnel 1.31.3, lines 229–238, and copy.rs, lines 176–183).",
  "grpc-js connects again, and its local ztunnel accepts. The connect of ztunnel to 15008 gets a reset, and ztunnel closes the socket of the app before any answer. grpc-js counts a failed connect and waits its backoff.",
  "A call in TRANSIENT_FAILURE fails at once (load-balancing-call.ts of grpc-js 1.14.6, lines 338–345). Thus the calls fail until the heal, and no call waits for its timeout.",
  `After the heal, the next connect comes at the end of the wait in progress. The heal comes at most ${say(sum(RESET_HOLD, HEAL_LATE))} after the fault, thus that wait is at most the wait ${RESET_WAIT}: ${say(us(backoffOf(RESET_WAIT).hi))}.`,
].join(" ");

/** These are the gRPC cells of T15 for the kind lab: the calibrations of the propagation, the deletion, the policy and the reset. */
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
    prediction: sidecarDeletion(P_EDS, DELETION_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    id: "CAL.T15.policy",
    name: "T15 sidecar, gRPC, the propagation of a policy to each server sidecar, an account that no pod has",
    trigger: { kind: "authorization-policy", hold: POLICY_HOLD, account: "lab-absent" },
    pod: kubeDefaults(2),
    prediction: {
      kind: "none",
      why: "The policy denies the account lab-absent, and no pod has it. The chain of each server sidecar changes in place, and its open connection drains with a GOAWAY notice, thus no call fails (conn_manager_impl.cc of Envoy v1.39.4, lines 1959–1968)",
    },
    calibrates: true,
  },
  {
    ...BASE,
    id: "T15.defaults.5",
    name: "T15 sidecar, gRPC, an AuthorizationPolicy that denies the clients for 15 s",
    trigger: { kind: "authorization-policy", hold: POLICY_HOLD },
    pod: kubeDefaults(2),
    prediction: policyWindow(P_LDS, POLICY_HOLD, POLICY_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: AMBIENT,
    id: "T15.defaults.12",
    name: "T15 ambient, gRPC, a reset of the HBONE leg for 10 s: the backoff of grpc-js through ztunnel",
    trigger: { kind: "rst", hold: RESET_HOLD },
    pod: kubeDefaults(2),
    prediction: resetWindow(RESET_HOLD, RESET_WHY),
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
  {
    plan: "T15.array.5",
    is: "T15.defaults.5",
    why: "DP51 sets no knob on the path of a policy: the debounce of istiod, the drain of a filter chain and the retry policy are at the defaults of Istio 1.31, as in T15.defaults.5",
  },
  {
    plan: "T15.array.12",
    is: "T15.defaults.12",
    why: "DP36 sets the locality load balancing and the outlier detection of a DestinationRule. ztunnel reads neither of them on an L4 path: its workload API has only routing preferences and a health policy (workload.proto of ztunnel 1.31.3, lines 148–198). Thus the reset is the one of T15.defaults.12",
  },
];
