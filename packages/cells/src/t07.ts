import type { KindCell, KubeProxyMode, Prediction, Propagation } from "@mark1russell7/kind";
import { KUBE_PROXY_MODES, deletionWindow, pausedWindow } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { CHART_READINESS, CLOSE, DESIGN, KUBE_PROBE, PROPAGATION, SYN_SENT, T07_WORKLOAD, WORKERS, afterSync, kubeDefaults, s, say, withHold } from "./kind.ts";

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
  workload: T07_WORKLOAD,
  calibrates: false,
  runs: 11,
});

/**
 * These modes keep the NAT of a flow in conntrack, thus a reset leaves a CLOSE entry to the pod
 * (`CLOSE`). IPVS keeps its own connection table, and the run gives what it does.
 */
const CONNTRACK_NAT: ReadonlySet<KubeProxyMode> = new Set(["iptables", "nftables"]);

/**
 * This function gives the prediction of a deletion from O04 with the hold: no failure, or a window
 * of refused connections. The propagation is the calibration of the mode, or another bound for a
 * deletion that comes immediately after a sync (`afterSync`).
 *
 * In the window, the pod can reset a connection in flight. In a mode with the NAT in conntrack,
 * that leaves a CLOSE entry to the pod for `CLOSE`. A later connection of the same client on the
 * same port goes to the deleted pod, and it times out.
 */
const deletionPrediction = (cell: Pick<KindCell, "declaration" | "pod" | "mode">, propagation: Propagation = PROPAGATION[cell.mode]): Prediction => {
  const window = deletionWindow(cell.declaration, cell.pod.preStop, propagation);
  if (window.empty)
    return {
      kind: "none",
      why: `the intake stops ${say(window.intake)} after the deletion at the earliest, after the propagation (${say(window.end.hi)} at the most, ${propagation.from})`,
    };
  return {
    kind: "window",
    nodes: "all",
    start: { from: "intake", band: { lo: s(0), hi: window.end.hi } },
    end: { from: "deletion", band: window.end },
    certain: false,
    ...(CONNTRACK_NAT.has(cell.mode) ? { afterReset: { life: CLOSE, outcome: "timeout" } } : {}),
    why: `the intake can stop ${say(window.intake)} after the deletion, before the propagation (up to ${say(window.end.hi)}): a connection between the two is refused${
      CONNTRACK_NAT.has(cell.mode) ? `. A connection that the pod resets leaves a CLOSE entry to the pod for ${say(CLOSE)}, and a later connection from the same port meets it and times out` : ""
    }`,
  };
};

/**
 * This function gives how long a connection of the window can fail a later connection: the life of
 * its stale entry. The last SYN of a connection comes before the timeout of its client, and the
 * entry lives `SYN_SENT` after that SYN at the most. A later connection from the same port goes
 * through the entry to the address of the pod. In CI, each late failure came 10.7 s to 84.1 s after
 * a timeout of a window on its port.
 */
const staleLife = (cell: Pick<KindCell, "workload">): number => valueIn(SYN_SENT, "s") + valueIn(cell.workload.timeout, "s");

/**
 * This function gives the prediction of a deletion while kube-proxy pauses on one node. The window
 * opens at the stop of the intake and closes when the paused node syncs. In it, a connection of the
 * paused node goes to the pod. It is refused while the pod is alive, and it gets no answer when the
 * address of the pod is gone.
 *
 * A connection with no answer leaves a stale entry. Thus a timeout from the same port can come
 * later, up to `staleLife` after the window. The cluster keeps its entries from one run to the
 * next. Thus a timeout can also come before the intake, from the window of an earlier run. The
 * prediction still holds the failures to the paused node, at least one, and the last one after the sync.
 */
const pausePrediction = (cell: Pick<KindCell, "declaration" | "pod" | "mode" | "workload">): Prediction => {
  const window = pausedWindow(cell.declaration, cell.pod.preStop, PAUSE_LEAD, PAUSE_HOLD, PROPAGATION[cell.mode]);
  if (window.empty)
    return {
      kind: "none",
      why: `the intake stops ${say(window.intake)} after the deletion, after the paused node syncs (${say(window.resume)}, then up to ${say(window.end.hi)})`,
    };
  const stale = staleLife(cell);
  const sync = valueIn(window.resume, "s") + valueIn(window.end.hi, "s");
  return {
    kind: "window",
    nodes: "paused",
    start: { from: "intake", band: { lo: s(-stale), hi: s(sync) } },
    end: { from: "resume", band: { lo: window.end.lo, hi: s(valueIn(window.end.hi, "s") + stale) } },
    certain: true,
    why: `the intake stops ${say(window.intake)} after the deletion, and the paused node selects the pod until it syncs after ${say(window.resume)}: its connections fail between the two. Each one with no answer leaves a SYN_SENT entry for up to ${say(s(stale))}, and a later connection from the same port meets it and times out, in this run or in the next runs of the cluster`,
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
  const noHold = { ...base(mode), declaration: { ...DESIGN, phases: withHold(s(0)) } };
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
  const longHold = { ...base(mode), declaration: { ...DESIGN, phases: withHold(s(8)) } };
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
    // each old pod goes some milliseconds after the sync for a new ready pod: its removal waits minSyncPeriod
    prediction: deletionPrediction(iptables, afterSync("iptables")),
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
      start: { from: "intake", band: { lo: s(0), hi: s(10) } },
      end: null,
      certain: true,
      why: "W8: the endpoint stays ready until the kill, and the intake stops after the hold: each connection until the removal is refused, and no document bounds that removal",
    },
  },
];
