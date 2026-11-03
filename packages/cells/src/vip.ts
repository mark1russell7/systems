import type { KindCell, Workload } from "@mark1russell7/kind";
import { KUBE_VIP_ARP_RATE, KUBE_VIP_ELECTION } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { DESIGN, WORKERS, WORKLOAD, kubeDefaults, s, say } from "./kind.ts";

/**
 * This module holds the cell of kube-vip in S2 (SYS-51). Clients outside the cluster call a Service
 * of type LoadBalancer at its VIP. The DaemonSet of kube-vip holds the VIP in ARP mode on one worker.
 * A zone loss takes that worker away. The question of the family: when do callers learn that the
 * holder of a VIP is gone, and which timer sets that time?
 *
 * Each term comes from the source of kube-vip v1.3.1 and of client-go v0.37.1:
 * - One Lease elects the holder of each VIP of a Service (`svc_election` off). The election is
 *   `leaderelection.RunOrDie` with the defaults of kube-vip (cmd/kube-vip.go, lines 91–94). They are
 *   a lease duration L of 15 s, a renew deadline of 10 s and a retry period R of 2 s.
 * - The leader renews the Lease each R. A follower tries to take it each R to 2.2R. The reason:
 *   client-go adds a jitter with the factor 1.2 to R (`wait.JitterUntil`). A follower sees a change
 *   of the Lease at its next try. The Lease expires L after that time (`isLeaseValid`).
 * - The last renew is less than R before the fault. A follower sees it up to 2.2R after it. The Lease
 *   expires L after that, and the follower takes it at its next try, up to 2.2R later. Thus the new
 *   holder takes the VIP from L − R to L + 4.4R after the fault.
 * - The new holder adds the VIP to its link at once. Its ARP manager sends the first gratuitous ARP
 *   at its next tick, up to `vip_arpRate` (3 s) later (pkg/arp/arp.go). Until then, a client sends to
 *   the old MAC address. The lost node still answers ARP: the drops of a zone loss are in iptables,
 *   and iptables does not see ARP.
 * - A request that starts before the gratuitous ARP fails at its timeout: its SYN goes to the lost
 *   node. A client stops a kept connection at its first timeout, thus each client acts as with new
 *   connections. The cell has no control with kept connections.
 */

/** These are the terms of the election of kube-vip, in seconds: the lease duration L, the retry period R and the jitter factor of client-go. */
export const ELECTION: { readonly lease: Quantity; readonly retry: Quantity; readonly jitter: number } = {
  lease: KUBE_VIP_ELECTION.lease,
  retry: KUBE_VIP_ELECTION.retry,
  jitter: 1.2,
};

/**
 * This time is the most that the new holder takes from its election to its first gratuitous ARP,
 * past the tick of the ARP manager. It is the update of the Service and the add of the address. This
 * value is an assumption: the record of the ARP of each client measures it.
 */
export const VIP_SETUP: Quantity = s(0.5);

/** This time is the most that the drops of a zone loss take to act after the stamp of the act. */
export const VIP_ACT: Quantity = s(0.5);

/** This time is the hold of the zone loss. It is past the end of the band, and less than the grace of the node lifecycle controller (40 s). */
export const VIP_HOLD: Quantity = s(35);

/** These are the clients outside the cluster, on the Docker network of the nodes. Each one makes a request each 20 ms on a new connection. */
export const VIP_CLIENTS = 3;

/** This workload is the clients of the VIP: a request each 20 ms on a new connection, with a timeout of 1 s. */
export const VIP_WORKLOAD: Workload = WORKLOAD;

/** A band is a time from its reference. */
interface Band {
  readonly lo: Quantity;
  readonly hi: Quantity;
}

const time = (value: number): Quantity => s(Math.round(value * 1e6) / 1e6);

/** This is the prediction of the loss of the holder of a VIP: each band from the fault, and the reasons. */
export interface VipPrediction {
  /** This band is the first failed request, from the fault. */
  readonly start: Band;
  /** This band is the take of the Lease by the new holder, from the fault: L − R to L + 4.4R. */
  readonly take: Band;
  /** This band is the take of the Lease in the naive law: L − R to L + R after the fault. The judge does not use it. */
  readonly naive: Band;
  /** This band is the first gratuitous ARP of the new holder, from the fault: the take, the tick of the ARP manager and the setup. */
  readonly arp: Band;
  /** This band is the last failed request, from the fault. */
  readonly end: Band;
  /** This band is the permitted failures after the heal: the old holder can send one more gratuitous ARP before it stops. */
  readonly thaw: Band;
  readonly why: string;
}

/**
 * This function gives the bands of the loss of the holder of a VIP from the terms of the module:
 * - The first failure is the first request after the drops, up to one interval and the act later.
 * - The last failure is the last request that starts before the gratuitous ARP of the new holder.
 *   It is less than one interval before the ARP.
 * - After the heal, the thawed node can send a gratuitous ARP before it sees that it lost the Lease.
 *   Its timers fire at the thaw, thus the permitted failures are up to one tick and the setup later.
 */
export const vipOf = (workload: Workload, hold: Quantity): VipPrediction => {
  const every = valueIn(workload.every, "s");
  const lease = valueIn(ELECTION.lease, "s");
  const retry = valueIn(ELECTION.retry, "s");
  const slowest = retry * (1 + ELECTION.jitter);
  const tick = valueIn(KUBE_VIP_ARP_RATE, "s");
  const setup = valueIn(VIP_SETUP, "s");
  const act = valueIn(VIP_ACT, "s");
  const take = { lo: time(lease - retry), hi: time(lease + 2 * slowest) };
  const arp = { lo: take.lo, hi: time(valueIn(take.hi, "s") + tick + setup) };
  if (valueIn(hold, "s") <= valueIn(arp.hi, "s") + valueIn(workload.timeout, "s"))
    throw new RangeError(`the hold of the loss of a VIP is more than ${say(arp.hi)} and the timeout, not ${say(hold)}`);
  const start = { lo: s(0), hi: time(every + act) };
  const end = { lo: time(valueIn(take.lo, "s") - every), hi: arp.hi };
  const naive = { lo: time(lease - retry), hi: time(lease + retry) };
  const thaw = { lo: s(0), hi: time(tick + setup) };
  const why = `${VIP_CLIENTS} clients outside the cluster call the VIP of kube-vip, on a new connection each ${say(workload.every)}. The zone loss takes away the holder of the VIP, and the lost node still answers ARP. Thus each request from the fault fails at its timeout of ${say(workload.timeout)}. A follower takes the Lease ${say(take.lo)}–${say(take.hi)} after the fault: the lease duration of ${say(ELECTION.lease)}, the retry period of ${say(ELECTION.retry)} with the jitter of client-go, the last renew and the try that sees it. Its first gratuitous ARP comes up to ${say(KUBE_VIP_ARP_RATE)} and ${say(VIP_SETUP)} later. Thus the last failure starts ${say(end.lo)}–${say(end.hi)} after the fault. The naive law gives the take ${say(naive.lo)}–${say(naive.hi)} after the fault`;
  return { start, take, naive, arp, end, thaw, why };
};

/** This function gives the cell of the loss of the holder of a VIP. */
const vipCellOf = (): KindCell => {
  const predicted = vipOf(VIP_WORKLOAD, VIP_HOLD);
  return {
    id: "S2.T07.iptables.vip.zone-loss",
    name: "T07 iptables, kube-vip loses the holder of its VIP: clients outside the cluster",
    template: "T07",
    substitutes: null,
    mode: "iptables",
    workers: WORKERS,
    pod: kubeDefaults(2),
    declaration: DESIGN,
    workload: VIP_WORKLOAD,
    trigger: { kind: "zone-loss", hold: VIP_HOLD },
    vip: { clients: VIP_CLIENTS },
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
        why: `The thawed node held the VIP. Its timers fire at the thaw, thus it can send one more gratuitous ARP before it sees that it lost the Lease, up to ${say(predicted.thaw.hi)} after the heal. A request to it in that time can fail`,
      },
      why: predicted.why,
    },
  };
};

/** These are the cells of kube-vip: the loss of the holder of the VIP. */
export const VIP_CELLS: readonly KindCell[] = [vipCellOf()];
