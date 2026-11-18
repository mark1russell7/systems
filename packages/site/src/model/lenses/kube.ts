/**
 * The lens of Kubernetes: the readiness probe of the kubelet, the propagation of a removal to the rules of
 * each node, and conntrack. The measured values are the kind cell T18, the calibrations of T07 and the S2
 * cells of a stalled pod.
 */
import { detection, probeTrain, timerOf } from "@mark1russell7/automata";
import { KUBELET_READINESS, NF_CONNTRACK_TCP } from "@mark1russell7/machines";
import { add, format, quantity, valueIn } from "@mark1russell7/quantity";
import kind from "../../data/kind-2026-10-18.json";
import stall from "../../data/s2-stall-2026-10-26.json";
import stallCilium from "../../data/s2-stall-cilium-2026-10-27.json";
import { bandOf, say, sayBand, type Band, type Fact, type Lens, type Mark, type Measured } from "../lens.ts";
import { atLeast, bandOfTimer, conntrackValues, count, probeValues, s, type Dataplane, type LayerId, type LayerResult, type Settings } from "../path.ts";

/** The measured propagation of a deletion to the rules of each node, by the mode of kube-proxy (the calibrations of T07). */
const propagationOf = (dataplane: Dataplane): Band | null => {
  if (dataplane === "cilium") return null;
  const all = kind.propagation[dataplane].all;
  return bandOf(s(all.min), s(all.max));
};

/** The S2 cell of a stalled pod with endpoints only, by its dataplane: its failed requests in the median run. */
const stallCellOf = (dataplane: Dataplane) => [...stall.cells, ...stallCilium.cells].find((cell) => cell.mode === dataplane && cell.id.endsWith(".endpoints.stall"));

/** This function gives what Kubernetes does: the readiness probe, the propagation to the rules, and conntrack. */
export const kubeLane = (settings: Settings): LayerResult => {
  const facts: Fact[] = [];
  const marks: Mark[] = [];
  const measured: Measured[] = [];
  const propagation = propagationOf(settings.dataplane);
  facts.push({ label: `Propagation, ${settings.dataplane}`, value: propagation === null ? "not calibrated" : `${sayBand(propagation)} (measured)` });
  // conntrack: the flow of this connection, and its timeout
  const ct = detection(NF_CONNTRACK_TCP, { state: "ESTABLISHED", inFlight: settings.inFlight }, { name: "blackhole", passes: settings.inFlight ? ["orig.ack"] : [] }, conntrackValues(settings));
  const forgets = ct.first === null ? null : bandOfTimer(timerOf(NF_CONNTRACK_TCP, ct.first.timer, conntrackValues(settings)));
  facts.push({ label: "conntrack keeps this flow", value: forgets === null ? "while packets pass" : `for ${say(forgets.low)} of silence` });
  let warning: string | null = null;
  if (settings.keepaliveOn && !atLeast(settings.ctEstablished, settings.keepidle)) {
    warning = `The keepalive idle time (${say(settings.keepidle)}) is longer than the conntrack timeout (${say(settings.ctEstablished)}). An idle connection loses its NAT entry before its first probe.`;
  }
  if (settings.fault === "stall") {
    const values = probeValues(settings);
    const kubelet = bandOfTimer(timerOf(KUBELET_READINESS, "unready", values));
    if (kubelet === null) throw new Error("the readiness probe has no time");
    const band = propagation === null ? kubelet : bandOf(add(kubelet.low, propagation.low), add(kubelet.high, propagation.high));
    // the first probe after the fault fails at its timeout, and each next probe comes one interval later
    const interval = timerOf(KUBELET_READINESS, "probe", values, 0).duration;
    if ("unknown" in interval) throw new Error("the readiness probe has no interval");
    probeTrain(settings.probeTimeout, interval, settings.threshold).forEach((t, n) => marks.push({ t, label: `Readiness probe ${n + 1} fails`, kind: "probe" }));
    marks.push({ t: band.low, label: "The pod leaves the Service", kind: "detect" });
    facts.push({ label: "The kubelet marks it not ready", value: sayBand(kubelet) });
    const t18 = kind.cells.find((cell) => cell.trigger === "app-stall");
    if (
      t18 !== undefined &&
      settings.dataplane === "iptables" &&
      valueIn(settings.period, "s") === 10 &&
      settings.threshold === 3 &&
      valueIn(settings.probeTimeout, "s") === 1 &&
      t18.median !== null
    ) {
      measured.push({ cell: `${t18.id}: ${t18.name}`, measured: `${say(s(t18.median))} (median of ${t18.counted} runs)`, computed: sayBand(band), href: "results/kind/#a-stall-a-rollout-and-a-throttle", at: s(t18.median) });
    }
    if (settings.dataplane !== "cilium" && propagation !== null) {
      const all = kind.propagation[settings.dataplane].all;
      measured.push({
        cell: `The propagation of a deletion, ${settings.dataplane}`,
        measured: `${sayBand(propagation)} (${format(count(all.count))} deletions)`,
        computed: "no closed form: the page adds the measured band",
        href: "results/kind/#the-propagation",
        at: null,
      });
    }
    const s2 = stallCellOf(settings.dataplane);
    if (s2 !== undefined && s2.median !== null) {
      measured.push({ cell: `${s2.id}: ${s2.name}`, measured: `${format(quantity(s2.median, "count"))} failed requests (median of ${s2.counted} runs)`, computed: "the requests that start before the removal", href: "results/kind/#a-stalled-pod", at: null });
    }
    return {
      id: "kube",
      verdict: "detects",
      band,
      summary: `The readiness probe times out, and the pod leaves the Service at ${sayBand(band)}. New connections go to other pods. This connection stays on the stalled pod: conntrack keeps its NAT.`,
      facts,
      marks,
      measured,
      warning,
    };
  }
  return {
    id: "kube",
    verdict: "blind",
    band: null,
    summary:
      settings.fault === "partition"
        ? "The kubelet probes the pod from its own node, and the partition is between the nodes. Each probe passes, and the pod stays in the Service."
        : "The kubelet probes the pod from its own node, and the black hole is on the path between the nodes. Each probe passes, and the pod stays in the Service.",
    facts,
    marks,
    measured,
    warning,
  };
};

export const KUBE: Lens<Settings, LayerId> = {
  id: "kube",
  names: { title: "Kubernetes", label: "Kubernetes", short: "Kube", term: "kube-proxy" },
  knobs: ["dataplane", "period", "threshold", "probeTimeout", "ctEstablished"],
  lanes: (settings) => [kubeLane(settings)],
};
