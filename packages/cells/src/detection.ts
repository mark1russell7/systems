import type { KindCell, MemberlistSettings } from "@mark1russell7/kind";
import { memberlistTermsOf, suspicionOf } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { DESIGN, WORKERS, kubeDefaults, s, say } from "./kind.ts";
import { SPEAKERS, metallbCellOf, settingsTag } from "./metallb.ts";
import { VIP_CLIENTS, VIP_WORKLOAD } from "./vip.ts";

/**
 * This module holds the sweep of the detection settings of MetalLB (SYS-57). Each setting is a probe
 * interval I and a SuspicionMult m of memberlist, with the probe timeout at I / 2. The install writes
 * each setting to the config file of memberlist. Each setting has two cells on one cluster:
 * - The failure time: the zone loss of SYS-53, with the later law of SYS-53. The lost node is dead
 *   I + S to act + 3I + S after the fault, with S = m × I for two speakers.
 * - The false deaths: no fault, but a schedule of pauses (SIGSTOP, then SIGCONT) of the speaker of
 *   the owner. The other speaker marks a live speaker dead if a pause is longer than the probe, its
 *   deadline and the suspicion timeout.
 *
 * The terms of a false death come from the source of hashicorp/memberlist v0.5.1:
 * - The other speaker probes the paused speaker. The probe fails at its deadline, one probe interval
 *   after its start, and the paused speaker is suspect (state.go, lines 306–524).
 * - With two members, a tick after the shuffle of the members can probe no node (state.go, lines
 *   232–274). Thus a gap between two probes is 1 or 2 ticks. In the steady chain of the ticks, a
 *   gap of 1 tick has the share 1/4, and a gap of 2 ticks has the share 3/4.
 * - The suspicion timer fires S after the suspicion, with no confirmation (suspicion.go, lines 70–76).
 * - At the SIGCONT, the paused speaker reads the suspicion in its queue and refutes it. The refute
 *   gets to the other speaker in approximately one gossip interval, 200 ms.
 * Thus a pause of length p from a random phase gives a death if p is more than φ + I + S. The time φ
 * is from the SIGSTOP to the next probe, in 0 to 2I. The least pause that can kill a live speaker is
 * I + S, and that is also the least failure time of the zone loss. This is the trade-off in one number.
 */

/** These are the settings of the sweep: the probe intervals 1 s and 500 ms, and the multipliers 4 and 2. The probe timeout is half the interval. */
export const DETECTION_SETTINGS: readonly MemberlistSettings[] = [
  { probeInterval: s(1), probeTimeout: s(0.5), suspicionMult: 4 },
  { probeInterval: s(1), probeTimeout: s(0.5), suspicionMult: 2 },
  { probeInterval: s(0.5), probeTimeout: s(0.25), suspicionMult: 4 },
  { probeInterval: s(0.5), probeTimeout: s(0.25), suspicionMult: 2 },
];

/** These are the pauses of the speaker of the owner in each run, in their sequence. The same schedule is the load of each setting. */
export const PAUSES: readonly Quantity[] = [s(1), s(2), s(4), s(6), s(9)];

/** This time is the rest from the SIGCONT of a pause to the SIGSTOP of the next one: a rejoin of memberlist and a move back of the VIP. */
export const PAUSE_REST: Quantity = s(20);

/** This time is the most from the end of a hold to the SIGCONT: the act of the lab. The pause of the record can be this much longer than its hold. */
export const PAUSE_SLACK: Quantity = s(0.1);

/** This time is the most from a SIGCONT to the refute at the other speaker: one gossip interval of memberlist. */
export const REFUTE: Quantity = s(0.2);

/** This time is the most jitter of the ticks of the probes. A pause this much past the band of a certain death gives a death. */
export const TICK_JITTER: Quantity = s(0.1);

/** The class of a pause: no death, a death, or either one. */
export type PauseClass = "never" | "either" | "always";

/** This is the prediction of one pause: its class and the probability of a death. */
export interface PausePrediction {
  readonly pause: Quantity;
  readonly class: PauseClass;
  readonly p: number;
}

/** This is the prediction of a setting: the least failure time I + S, each pause, and the band and the mean of the deaths in a run. */
export interface DetectionPrediction {
  readonly floor: Quantity;
  readonly pauses: readonly PausePrediction[];
  readonly deaths: { readonly lo: number; readonly hi: number; readonly mean: number };
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * This function gives the share of pauses with the next probe in `x` of the SIGSTOP, from a random
 * phase. The gap of 1 tick has the share 1/4 and the gap of 2 ticks 3/4. A random phase is in a gap
 * by its length, thus in a gap of 1 tick with the probability 1/7, and in a gap of 2 ticks with 6/7.
 */
export const nextProbeShare = (x: number, interval: number): number => {
  if (x <= 0) return 0;
  if (x <= interval) return (4 * x) / (7 * interval);
  if (x <= 2 * interval) return 4 / 7 + (3 * (x - interval)) / (7 * interval);
  return 1;
};

/**
 * This function gives the prediction of a setting for the schedule `pauses`:
 * - A pause gives no death if its end and the refute come before I + S, the least death.
 * - A pause gives a death if it is longer than 3I + S and the jitter of the ticks: past the latest death.
 * - Each other pause can give a death. Its probability is the share of phases with the death before the SIGCONT.
 */
export const detectionOf = (settings: MemberlistSettings, pauses: readonly Quantity[] = PAUSES): DetectionPrediction => {
  const terms = memberlistTermsOf(settings);
  const interval = valueIn(terms.probeInterval, "s");
  const floor = interval + valueIn(suspicionOf(SPEAKERS, terms), "s");
  const each = pauses.map((pause): PausePrediction => {
    const p = valueIn(pause, "s");
    if (p + valueIn(PAUSE_SLACK, "s") + valueIn(REFUTE, "s") < floor) return { pause, class: "never", p: 0 };
    if (p > floor + 2 * interval + valueIn(TICK_JITTER, "s")) return { pause, class: "always", p: 1 };
    return { pause, class: "either", p: round(nextProbeShare(p - floor, interval)) };
  });
  const always = each.filter((pause) => pause.class === "always").length;
  const either = each.filter((pause) => pause.class === "either").length;
  return { floor: s(round(floor)), pauses: each, deaths: { lo: always, hi: always + either, mean: round(each.reduce((sum, pause) => sum + pause.p, 0)) } };
};

/** This function gives the cell of the pauses of the speaker of the owner, with the settings `settings`. The prediction is measured: the result reads the deaths from the record. */
const pausesCellOf = (settings: MemberlistSettings): KindCell => {
  const predicted = detectionOf(settings);
  const [first, ...rest] = PAUSES;
  const classes = predicted.pauses.map((pause) => `${say(pause.pause)} ${pause.class}${pause.class === "either" ? ` (p ${pause.p})` : ""}`).join(", ");
  return {
    id: `S2.T07.iptables.metallb.pauses.${settingsTag(settings)}`,
    name: `T07 iptables, MetalLB detection ${say(settings.probeInterval)} x ${settings.suspicionMult} pauses the speaker of the owner: false deaths`,
    template: "T07",
    substitutes: null,
    mode: "iptables",
    workers: WORKERS,
    pod: kubeDefaults(2),
    declaration: DESIGN,
    workload: VIP_WORKLOAD,
    trigger: { kind: "freeze-process", hold: first!, flaps: rest.map((hold) => ({ rest: PAUSE_REST, hold })) },
    vip: { clients: VIP_CLIENTS, announcer: "metallb", memberlist: settings },
    calibrates: false,
    runs: 4,
    prediction: {
      kind: "measured",
      why: `No fault: a schedule of pauses of the speaker of the owner, ${PAUSES.map(say).join(", ")}, each ${say(PAUSE_REST)} after the last one. The other speaker probes each ${say(settings.probeInterval)}, and the suspicion timeout is ${say(suspicionOf(SPEAKERS, memberlistTermsOf(settings)))}. A pause longer than the next probe, its deadline and the suspicion timeout gives a false death. The least such pause is ${say(predicted.floor)}, the least failure time of the zone loss. By pause: ${classes}. Thus ${predicted.deaths.lo} to ${predicted.deaths.hi} false deaths in each run, with a mean of ${predicted.deaths.mean}`,
    },
  };
};

/** These are the cells of the sweep: for each setting, the zone loss of the announcer, then the pauses of the speaker of the owner. */
export const DETECTION_CELLS: readonly KindCell[] = DETECTION_SETTINGS.flatMap((settings) => [metallbCellOf(settings), pausesCellOf(settings)]);
