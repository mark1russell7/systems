import type { Cell, Fabric, Prediction } from "@mark1russell7/harness";
import { valueIn } from "@mark1russell7/quantity";
import type { Spec } from "./catalog.ts";
import { CELLS, REDIS, ms, predict, q, s } from "./catalog.ts";

/**
 * This module holds the first cells of a routed fabric (SYS-77, layer E3 of docs/S7.md). The
 * question: when a router goes silent and its links stay up, which timer ends the stall of the
 * client? It is a timer of a router. Neighbors learn of the silence only by BGP's hold timer, or by
 * BFD when it runs. Each term comes from the source of FRRouting 10.7.1:
 * - BGP rearms the hold timer at each KEEPALIVE or UPDATE. A KEEPALIVE comes each `keepalive`, thus
 *   the last one came less than `keepalive` before the silence. The hold expires in (hold −
 *   keepalive, hold] after the silence.
 * - bfdd restarts its detection timer at each packet, and it sends each packet at 75 % to 100 % of
 *   `interval`. The time of detection is `multiplier` × `interval` from the last packet. Thus BFD
 *   detects in ((multiplier − 1) × `interval`, `multiplier` × `interval`] after the silence.
 * - The new route then goes from the daemon through zebra to the kernel. `INSTALL` bounds that time.
 *
 * Nothing retransmits at the instant of a move. Until both leaves have moved, each retransmission
 * dies. The first one after the later move gets through, thus the client recovers at a firing of
 * its own ladder, not at the move. The timers of the two cells put each move between two firings.
 * A firing between the moves is a different case. The target gets the request and its reply dies.
 * Then the recovery follows the ladder of the target.
 */

/** This time bounds the path of a new route from the detector to the kernel, for BGP and for BFD. */
export const INSTALL = { bgp: s(0.1), bfd: s(0.08) } as const;

/** This fabric detects by the hold timer alone. */
export const BGP_FABRIC: Fabric = { keepalive: s(2), hold: s(6), bfd: null };

/** This fabric detects by BFD, and it has the same BGP timers. */
export const BFD_FABRIC: Fabric = { ...BGP_FABRIC, bfd: { interval: ms(240), multiplier: 3 } };

/** This count of runs is the rule of a new cell: four runs that count, in two labs. */
const RUNS = 4;

/** The cells of a fabric run alone: each lab adds four routers and their sidecars to the runner. */
const LAB = { runs: RUNS, environments: 2, concurrency: 1 } as const;

/** This function gives the interval of the later move of the leaves after a silence, in seconds. */
export const moveOf = (fabric: Fabric): { readonly low: number; readonly high: number } => {
  if (fabric.bfd === null) {
    const hold = valueIn(fabric.hold, "s");
    return { low: hold - valueIn(fabric.keepalive, "s"), high: hold + valueIn(INSTALL.bgp, "s") };
  }
  const interval = valueIn(fabric.bfd.interval, "s");
  return { low: interval * (fabric.bfd.multiplier - 1), high: interval * fabric.bfd.multiplier + valueIn(INSTALL.bfd, "s") };
};

/**
 * This function gives the prediction of a silence, from the algebra of a stall. A stall has one
 * length, and a move has an interval. So the prediction comes from the two ends of the interval,
 * and it stops if they name two firings. Its band of the end of the stall must hold the interval.
 */
export const silencePrediction = (name: string, fabric: Fabric): Prediction => {
  const { low, high } = moveOf(fabric);
  const at = (stall: number): Prediction => {
    const spec: Spec = { name, fault: "stall", manifestation: "blackhole", observer: "client", mode: "inflight", stall };
    return predict(spec);
  };
  const [first, last] = [at(low), at(high)];
  if (first.detects !== false || last.detects !== false || first.recovers === undefined || last.recovers === undefined)
    throw new Error(`${name}: a silence recovers, it is not detected`);
  if (first.recovers.firing !== last.recovers.firing)
    throw new Error(`${name}: a move from ${low} to ${high} s can end at firing ${first.recovers.firing} or ${last.recovers.firing}`);
  const { heal } = first.recovers;
  if (valueIn(heal.low, "s") >= low || valueIn(heal.high, "s") <= high)
    throw new Error(`${name}: a move from ${low} to ${high} s leaves the band of firing ${first.recovers.firing}`);
  return first;
};

/** This function gives a cell of E1 again on a fabric. Its prediction stays: a fabric between two hosts changes no timer of TCP. */
const bridge = (name: string): Cell => {
  const cell = CELLS.find((each) => each.name === `T01 ${name}`);
  if (cell === undefined) throw new Error(`no cell T01 ${name}`);
  return { ...cell, name: `E3.T01 ${name}`, topology: { name: "E3", hops: [], fabric: BGP_FABRIC }, ...LAB };
};

/** This function gives the cell of a silence of spine1, with a request in flight. */
const silence = (name: string, fabric: Fabric): Cell => ({
  name,
  target: REDIS,
  sysctls: {},
  probe: { mode: "inflight", keepalive: true },
  fault: "silence",
  topology: { name: "E3", hops: [], fabric },
  prediction: silencePrediction(name, fabric),
  ...LAB,
});

/** This stream outlasts the hold time of the fabric: 8 s of a request each 10 ms. */
const CONTROL_REQUESTS = 800;

/** This text tells what the control measures. */
const CONTROL =
  "the control of F1: a stream through the fabric with nothing injected. It shows that a run on the preferred path has no failed request, no change of a route and no change of a session";

/** These are the cells of the first fabric: three cells of E1 as a bridge, then the two detectors and the control. */
export const FABRIC_CELLS: readonly Cell[] = [
  bridge("client idle, blackhole"),
  bridge("client in flight, blackhole, tcp_retries2 = 3"),
  bridge("client in flight, a 1 s stall"),
  silence("E3.F1.bgp", BGP_FABRIC),
  silence("E3.F1.bfd", BFD_FABRIC),
  {
    name: "E3.F1.control",
    target: REDIS,
    sysctls: {},
    probe: { mode: "stream", keepalive: false, count: CONTROL_REQUESTS, interval: ms(10) },
    fault: "none",
    topology: { name: "E3", hops: [], fabric: BGP_FABRIC },
    prediction: { detects: null, window: q(30), why: CONTROL },
    ...LAB,
  },
];
