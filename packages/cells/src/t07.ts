import type { KindCell, KubeProxyMode, Prediction } from "@systems/kind";
import { KUBE_PROXY_MODES, deletionWindow, pausedWindow } from "@systems/kind";
import { CHART_READINESS, DESIGN, KUBE_PROBE, PROPAGATION, WORKERS, WORKLOAD, kubeDefaults, s, withHold } from "./kind.ts";

/**
 * The T07 catalog: the endpoint lifecycle of a Service. A client on each node sends requests on new
 * connections to the ClusterIP. The service of this repository is the server, the
 * node-http-server of the plan. The question is O04 with the hold of the service. The listener of
 * a leaving pod stays open for its preStop sleep and its hold of `fail readiness`. Thus a
 * connection fails when the rules of its node still select the pod after that.
 *
 * Each declaration pair operates in the three kube-proxy modes. Each other trigger uses the mode of
 * its cell of the plan. Kubernetes keeps its timers in real time, thus each cell has the defaults of
 * Kubernetes, not compressed.
 */

/** These are the plan cells of a deletion and a pause in each mode, and the server of the plan that the service replaces. */
const DELETION: Readonly<Record<KubeProxyMode, readonly [string, string | null]>> = {
  ipvs: ["T07.defaults.1", null],
  iptables: ["T07.defaults.9", "valkey-9.1-cluster-glide"],
  nftables: ["T07.defaults.30", "cassandra-5.0"],
};
const PAUSE: Readonly<Record<KubeProxyMode, readonly [string, string | null]>> = {
  ipvs: ["T07.defaults.31", null],
  iptables: ["T07.defaults.34", "bun-serve"],
  nftables: ["T07.defaults.28", "hapi-21"],
};

/** This pause of kube-proxy on one node starts 0.5 s before the deletion and holds 5 s. */
const PAUSE_HOLD = s(5);
const PAUSE_LEAD = s(0.5);

const base = (mode: KubeProxyMode): Omit<KindCell, "id" | "name" | "trigger" | "prediction"> => ({
  template: "T07",
  substitutes: null,
  mode,
  workers: WORKERS,
  pod: kubeDefaults(2),
  declaration: DESIGN,
  workload: WORKLOAD,
  calibrates: false,
  runs: 11,
});

/** This function gives the prediction of a deletion from O04 with the hold: no failure, or a window of refused connections. */
const deletionPrediction = (cell: Pick<KindCell, "declaration" | "pod" | "mode">): Prediction => {
  const window = deletionWindow(cell.declaration, cell.pod.preStop, PROPAGATION[cell.mode]);
  if (window.empty)
    return {
      kind: "none",
      why: `the intake stops ${window.intake} s after the deletion at the earliest, after the propagation (${window.end.hi} s at the most)`,
    };
  return {
    kind: "window",
    nodes: "all",
    start: { from: "intake", band: { lo: 0, hi: window.end.hi } },
    end: { from: "deletion", band: window.end },
    certain: false,
    why: `the intake can stop ${window.intake} s after the deletion, before the propagation (up to ${window.end.hi} s): a connection between the two is refused`,
  };
};

/** This function gives the prediction of a deletion while kube-proxy pauses on one node. */
const pausePrediction = (cell: Pick<KindCell, "declaration" | "pod" | "mode">): Prediction => {
  const window = pausedWindow(cell.declaration, cell.pod.preStop, PAUSE_LEAD, PAUSE_HOLD, PROPAGATION[cell.mode]);
  if (window.empty)
    return {
      kind: "none",
      why: `the intake stops ${window.intake} s after the deletion, after the paused node syncs (${window.resume} s, then up to ${window.end.hi} s)`,
    };
  return {
    kind: "window",
    nodes: "paused",
    start: { from: "intake", band: { lo: 0, hi: window.resume + window.end.hi } },
    end: { from: "resume", band: window.end },
    certain: true,
    why: `the intake stops ${window.intake} s after the deletion, and the paused node selects the pod until it syncs after ${window.resume} s: its connections are refused between the two`,
  };
};

const modeCells = (mode: KubeProxyMode): KindCell[] => {
  const cells: KindCell[] = [];
  const calibration = { ...base(mode), pod: { ...kubeDefaults(2), preStop: s(10), grace: s(40) } };
  cells.push({
    ...calibration,
    id: `CAL.T07.${mode}`,
    name: `T07 ${mode}, the propagation of a deletion, preStop 10 s`,
    trigger: { kind: "pod-deletion" },
    prediction: { kind: "none", why: "a preStop sleep of 10 s and a hold of 2 s outlast the propagation of an idle cluster" },
    calibrates: true,
  });
  const [deletionId, deletionSub] = DELETION[mode];
  const defaults = base(mode);
  cells.push({
    ...defaults,
    id: deletionId,
    name: `T07 ${mode}, pod deletion, the design's hold of 2 s`,
    substitutes: deletionSub === null ? null : `node-http-server (the service) stands for ${deletionSub}`,
    trigger: { kind: "pod-deletion" },
    prediction: deletionPrediction(defaults),
  });
  const noHold = { ...base(mode), declaration: { ...DESIGN, phases: withHold(0) } };
  cells.push({
    ...noHold,
    id: "T07.border-off.68",
    name: `T07 ${mode}, pod deletion, no hold and no preStop`,
    trigger: { kind: "pod-deletion" },
    prediction: deletionPrediction(noHold),
  });
  const [pauseId, pauseSub] = PAUSE[mode];
  cells.push({
    ...defaults,
    id: pauseId,
    name: `T07 ${mode}, pod deletion while kube-proxy pauses 5 s on one node, the design's hold of 2 s`,
    substitutes: pauseSub === null ? null : `node-http-server (the service) stands for ${pauseSub}`,
    trigger: { kind: "freeze-process", hold: PAUSE_HOLD, lead: PAUSE_LEAD },
    prediction: pausePrediction(defaults),
  });
  const longHold = { ...base(mode), declaration: { ...DESIGN, phases: withHold(8) } };
  cells.push({
    ...longHold,
    id: "T07.border-off.1",
    name: `T07 ${mode}, pod deletion while kube-proxy pauses 5 s on one node, a hold of 8 s`,
    trigger: { kind: "freeze-process", hold: PAUSE_HOLD, lead: PAUSE_LEAD },
    prediction: pausePrediction(longHold),
  });
  return cells;
};

const iptables = base("iptables");
const flagged = { ...DESIGN, flag: "liveness" as const };
const chart = { ...kubeDefaults(2), readiness: CHART_READINESS, liveness: KUBE_PROBE };

/** These are the cells of T07: the pairs in each mode, then one cell for each other trigger, in the mode of its plan cell. */
export const T07_CELLS: readonly KindCell[] = [
  ...KUBE_PROXY_MODES.flatMap(modeCells),
  {
    ...iptables,
    id: "T07.defaults.23",
    name: "T07 iptables, rolling update, the design's hold of 2 s",
    trigger: { kind: "rolling-update" },
    prediction: deletionPrediction(iptables),
  },
  {
    ...base("nftables"),
    pod: kubeDefaults(3),
    id: "T07.defaults.27",
    name: "T07 nftables, scale-in from 3 to 2, the design's hold of 2 s",
    trigger: { kind: "scale-in" },
    prediction: deletionPrediction(base("nftables")),
  },
  {
    ...iptables,
    id: "T07.defaults.24",
    name: "T07 iptables, node drain, the design's hold of 2 s",
    substitutes: "node-http-server (the service) stands for hapi-21",
    trigger: { kind: "node-drain" },
    prediction: deletionPrediction(iptables),
  },
  {
    ...iptables,
    id: "T07.defaults.25",
    name: "T07 iptables, crash of the server process",
    substitutes: "node-http-server (the service) stands for bun-serve",
    trigger: { kind: "crash" },
    prediction: {
      kind: "measured",
      why: "no document bounds the time from the exit of a container to the removal of its endpoint: the kubelet finds the exit at its own relist, which is not a setting",
    },
  },
  {
    ...base("ipvs"),
    pod: chart,
    declaration: flagged,
    id: "T07.defaults.11",
    name: "T07 ipvs, liveness restart, liveness fails readiness, readiness 2 s × 3 and liveness 10 s × 3",
    substitutes: "node-http-server (the service) stands for hapi-21",
    trigger: { kind: "liveness-restart" },
    prediction: {
      kind: "none",
      // the service answers 503 while its readiness fails and the pod is still in the rules: an answer, not a lost connection
      outcomes: ["refused", "reset", "timeout", "unreachable", "error"],
      why: "liveness fails readiness: the readiness probes remove the pod within 6 s and the propagation, before the liveness probes kill it at 20 s at the earliest. No connection fails, and the service answers 503 until the removal",
    },
  },
  {
    ...base("ipvs"),
    pod: chart,
    declaration: { ...flagged, couplings: [] },
    id: "T07.defaults.11",
    name: "T07 ipvs, liveness restart, liveness does not fail readiness",
    substitutes: "node-http-server (the service) stands for hapi-21",
    trigger: { kind: "liveness-restart" },
    prediction: {
      kind: "window",
      nodes: "all",
      start: { from: "intake", band: { lo: 0, hi: 10 } },
      end: null,
      certain: true,
      why: "W8: the endpoint stays ready until the kill, and the intake stops after the hold: each connection until the removal is refused, and no document bounds that removal",
    },
  },
];
