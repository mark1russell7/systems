import type { KindCell, Workload } from "@mark1russell7/kind";
import { MEMBERLIST, suspicionOf } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { DESIGN, WORKERS, kubeDefaults, s, say } from "./kind.ts";
import { VIP_ACT, VIP_CLIENTS, VIP_HOLD, VIP_SETUP, VIP_WORKLOAD } from "./vip.ts";

/**
 * This module holds the cell of MetalLB in S2 (SYS-53). The clients outside the cluster and the
 * Service of type LoadBalancer are the same as in the cell of kube-vip (SYS-51). MetalLB 0.16.1 in L2
 * mode gives the VIP, with a speaker on each worker. A zone loss takes away the node that announces
 * the VIP. The question: when do callers outside the cluster see the new announcer?
 *
 * Each term comes from the source of MetalLB v0.16.1 and of hashicorp/memberlist v0.5.1:
 * - The speaker answers ARP for the VIP in user space, and the VIP is on no interface. The zone loss
 *   freezes the speaker of the lost node, thus no node answers ARP for the VIP until a new owner.
 * - The owner is the first usable speaker in the order of sha256(node + "#" + VIP). A speaker is
 *   usable until memberlist marks its node dead. Thus a suspect node keeps the VIP.
 * - The other speaker probes the lost node each probe interval of 1 s. A probe fails at its deadline,
 *   one probe interval after it starts. With two members there is no indirect probe. Then the node
 *   is suspect.
 * - The suspicion timeout is SuspicionMult × max(1, log10 n) × ProbeInterval, 4 s for n = 2. No
 *   other member can confirm the suspicion, thus the timer fires at this minimum.
 * - The dead node causes an event of memberlist, and the event reconciles each Service at once. The
 *   new owner sends its first gratuitous ARP at once, then one each 1100 ms for 5 s.
 * - A request that starts before that gratuitous ARP fails at its timeout: its SYN goes to the lost node.
 *
 * Two other paths can move the VIP. Neither one is first:
 * - The node condition: a speaker excludes a node with NetworkUnavailable. The node lifecycle
 *   controller marks a node NotReady after 40 s, and that is not NetworkUnavailable. The hold of 35 s
 *   ends before it.
 * - The endpoints: a speaker of the Cluster policy needs only one ready endpoint in the cluster. Each
 *   replica is in the kept zone, thus the endpoints do not change.
 */

/** This count is the members of memberlist: one speaker on each worker. */
export const SPEAKERS = WORKERS;

/** A band is a time from its reference. */
interface Band {
  readonly lo: Quantity;
  readonly hi: Quantity;
}

const time = (value: number): Quantity => s(Math.round(value * 1e6) / 1e6);

/** This is the prediction of the loss of the announcer of a VIP of MetalLB: each band from the fault, and the reasons. */
export interface MetallbPrediction {
  /** This band is the first failed request, from the fault. */
  readonly start: Band;
  /** This band is the first failed probe of the lost node, from the fault: up to the act and one probe interval later. */
  readonly probe: Band;
  /** This band is the mark of the lost node as dead, from the fault: the probe, its deadline and the suspicion timeout. */
  readonly dead: Band;
  /** This band is the dead node in the naive law: the suspicion timeout as 4 × log10(n + 1) × ProbeInterval. The judge does not use it. */
  readonly naive: Band;
  /** This band is the first gratuitous ARP of the new owner, from the fault: the death and the setup. */
  readonly arp: Band;
  /** This band is the last failed request, from the fault. */
  readonly end: Band;
  /** This band is the permitted failures after the heal: a speaker that froze in its gratuitous ARPs sends the next one at the thaw. */
  readonly thaw: Band;
  /** This time is the least observation after the heal: past the band of the gratuitous ARP from the fault. */
  readonly watch: Quantity;
  readonly why: string;
}

/**
 * This function gives the bands of the loss of the announcer of a VIP of MetalLB from the terms of the module:
 * - The first failure is the first request after the drops, up to one interval and the act later.
 * - The first failed probe starts from the fault, up to the act and one probe interval later.
 * - The node is suspect one probe interval after that probe, and dead the suspicion timeout later.
 * - The last failure is the last request that starts before the gratuitous ARP of the new owner.
 * - After the heal, the thawed speaker can send one more gratuitous ARP before its drops end. Thus the
 *   permitted failures are up to the setup after the heal. The record goes on past the band of the
 *   gratuitous ARP from the fault, because the thawed speaker rejoins memberlist.
 */
export const metallbOf = (workload: Workload, hold: Quantity, speakers = SPEAKERS): MetallbPrediction => {
  const every = valueIn(workload.every, "s");
  const interval = valueIn(MEMBERLIST.probeInterval, "s");
  const suspicion = valueIn(suspicionOf(speakers), "s");
  const setup = valueIn(VIP_SETUP, "s");
  const act = valueIn(VIP_ACT, "s");
  const probe = { lo: s(0), hi: time(act + interval) };
  const dead = { lo: time(interval + suspicion), hi: time(valueIn(probe.hi, "s") + interval + suspicion) };
  const arp = { lo: dead.lo, hi: time(valueIn(dead.hi, "s") + setup) };
  if (valueIn(hold, "s") <= valueIn(arp.hi, "s") + valueIn(workload.timeout, "s"))
    throw new RangeError(`the hold of the loss of a VIP is more than ${say(arp.hi)} and the timeout, not ${say(hold)}`);
  const start = { lo: s(0), hi: time(every + act) };
  const end = { lo: time(valueIn(dead.lo, "s") - every), hi: arp.hi };
  const naiveSuspicion = MEMBERLIST.suspicionMult * Math.log10(speakers + 1) * interval;
  const naive = { lo: time(interval + naiveSuspicion), hi: time(2 * interval + naiveSuspicion) };
  const thaw = { lo: s(0), hi: VIP_SETUP };
  const watch = time(Math.ceil(valueIn(arp.hi, "s") + valueIn(workload.timeout, "s") + 2));
  const why = `${VIP_CLIENTS} clients outside the cluster call the VIP of MetalLB, on a new connection each ${say(workload.every)}. The zone loss freezes the speaker that answers ARP for the VIP. Thus each request from the fault fails at its timeout of ${say(workload.timeout)}. The other speaker probes the lost node each ${say(MEMBERLIST.probeInterval)}. A probe fails at its deadline, and the node is suspect. With ${speakers} members no peer can confirm, thus the node is dead ${say(suspicionOf(speakers))} later, ${say(dead.lo)}–${say(dead.hi)} after the fault. The new owner sends its first gratuitous ARP at once, up to ${say(VIP_SETUP)} later. Thus the last failure starts ${say(end.lo)}–${say(end.hi)} after the fault. The naive law, 4 × log10(n + 1) × ProbeInterval, gives the death ${say(naive.lo)}–${say(naive.hi)} after the fault`;
  return { start, probe, dead, naive, arp, end, thaw, watch, why };
};

/** This function gives the cell of the loss of the announcer of a VIP of MetalLB. */
const metallbCellOf = (): KindCell => {
  const predicted = metallbOf(VIP_WORKLOAD, VIP_HOLD);
  return {
    id: "S2.T07.iptables.metallb.zone-loss",
    name: "T07 iptables, MetalLB loses the announcer of its VIP: clients outside the cluster",
    template: "T07",
    substitutes: null,
    mode: "iptables",
    workers: WORKERS,
    pod: kubeDefaults(2),
    declaration: DESIGN,
    workload: VIP_WORKLOAD,
    trigger: { kind: "zone-loss", hold: VIP_HOLD },
    vip: { clients: VIP_CLIENTS, announcer: "metallb" },
    calibrates: false,
    runs: 4,
    prediction: {
      kind: "window",
      nodes: "all",
      start: { from: "fault", band: predicted.start },
      end: { from: "fault", band: predicted.end },
      certain: true,
      outcomes: ["timeout"],
      permits: {
        from: "heal",
        band: predicted.thaw,
        outcomes: ["timeout", "reset"],
        watch: predicted.watch,
        why: `The thawed speaker did not stop its announce. If it froze in its gratuitous ARPs, it sends the next one at the thaw, before its drops end. A request to it in ${say(predicted.thaw.hi)} after the heal can fail. Then the speaker rejoins memberlist, and the other speaker stops its announce. The clients keep the MAC address of the other node, and its kube-proxy still sends the VIP to a replica. Thus no failure is permitted later, to ${say(predicted.watch)} after the heal`,
      },
      why: predicted.why,
    },
  };
};

/** These are the cells of MetalLB: the loss of the announcer of the VIP. */
export const METALLB_CELLS: readonly KindCell[] = [metallbCellOf()];
