import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Poll, Stage, Timing } from "@mark1russell7/service";
import { failSpan, recoverSpan } from "@mark1russell7/service";
import { bandOf, seconds, secondsOf } from "./bands.ts";
import type { Band, Declaration, KubeletProbe, Reference, Workload } from "./cell.ts";

/**
 * This module is the arithmetic of the predictions. Each band is a range of times after a
 * reference event of the run. Each term comes from a declaration, from the pod settings, or from
 * the calibration of the propagation. No term comes from a default. The arithmetic operates in
 * seconds, and each result is a quantity.
 */

const s = (amount: Quantity): number => valueIn(amount, "s");
/** This function rounds a time to the microsecond, thus a band has no float residue. */
const us = (value: number): number => Math.round(value * 1e6) / 1e6;
const band = (lo: number, hi: number): Band => bandOf(us(lo), us(hi));

/**
 * A propagation is the time from a change of an endpoint to the rules of each node. A
 * calibration measures it for each kube-proxy mode and node count. Without a calibration, its upper
 * bound is `minSyncPeriod`: an idle kube-proxy syncs a change at once, or one `minSyncPeriod`
 * after its last sync.
 */
export interface Propagation extends Band {
  /** This text tells where the bound comes from: a calibration, or the documented `minSyncPeriod`. */
  readonly from: string;
}

/** This propagation is the documented bound, before a calibration: from zero to one `minSyncPeriod` of 1 s. */
export const DOCUMENTED: Propagation = { lo: seconds(0), hi: seconds(1), from: "minSyncPeriod (1 s), not calibrated" };

/**
 * This function gives the time from a flip of the probed state to the decision of the kubelet. The
 * next probe comes within one period, then `threshold − 1` more periods follow. A probe of an
 * endpoint that does not answer fails at its timeout.
 */
export const kubeletBand = (probe: KubeletProbe, hangs: boolean): Band => {
  const late = hangs ? s(probe.timeout) : 0;
  return band((probe.threshold - 1) * s(probe.period) + late, probe.threshold * s(probe.period) + late);
};

/**
 * This function gives the time from a fault of a dependency to the trip of a readiness or liveness
 * latch. A dependency that refuses fails each poll at once. A silent dependency fails each poll at
 * the request timeout of its client, or at the timeout of the poll when that is shorter. The
 * watchdog of the client can close the connection sooner, and then each poll fails at once.
 */
export const latchBand = (
  timing: Timing,
  poll: Poll,
  failure: "refuses" | "silent",
  requestTimeout?: Quantity,
): Band => {
  const error = failSpan(timing, poll, "error");
  if (failure === "refuses") return band(s(error.min), s(error.max));
  const wait = requestTimeout === undefined ? s(poll.timeout) : Math.min(s(requestTimeout), s(poll.timeout));
  const late = failSpan(timing, { ...poll, timeout: seconds(wait) }, "timeout");
  return band(s(error.min), s(late.max));
};

/** This function gives the time from a fault to the removal of the endpoints from the rules: the latch, then the kubelet, then the propagation. */
export const removalBand = (latch: Band, probe: KubeletProbe, propagation: Propagation): Band => {
  const kubelet = secondsOf(kubeletBand(probe, false));
  const trip = secondsOf(latch);
  const spread = secondsOf(propagation);
  return band(trip.lo + kubelet.lo + spread.lo, trip.hi + kubelet.hi + spread.hi);
};

/**
 * This function gives the time from a fault to the SIGTERM of a replica whose liveness fails with
 * its readiness. The time is the latch, then the liveness probes of the kubelet, then the preStop sleep.
 */
export const restartBand = (latch: Band, liveness: KubeletProbe, preStop: Quantity): Band => {
  const kubelet = secondsOf(kubeletBand(liveness, false));
  const trip = secondsOf(latch);
  return band(trip.lo + kubelet.lo + s(preStop), trip.hi + kubelet.hi + s(preStop));
};

/**
 * This function gives the time from the start of a stall of the event loop to the removal of the
 * replica from the rules. Each probe in the stall fails at its timeout, because the loop does not answer it.
 */
export const stallRemovalBand = (readiness: KubeletProbe, propagation: Propagation): Band => {
  const kubelet = secondsOf(kubeletBand(readiness, true));
  const spread = secondsOf(propagation);
  return band(kubelet.lo + spread.lo, kubelet.hi + spread.hi);
};

/** This function gives the cap of a stage in a declaration, or zero when the declaration does not name the stage. */
export const capOf = (declaration: Declaration, stage: Stage): Quantity => {
  const found = declaration.phases.find(([name]) => name === stage);
  return seconds(found === undefined ? 0 : s(found[1]));
};

/**
 * This function gives the shortest time from the deletion of a pod to the stop of its intake. It
 * is the preStop sleep, then the hold of `fail readiness`. The kubelet adds its own delay before
 * the preStop, thus the real time is longer.
 */
export const intakeAfter = (declaration: Declaration, preStop: Quantity): Quantity =>
  seconds(us(s(preStop) + s(capOf(declaration, "fail readiness"))));

/**
 * A deletion window is what a deletion predicts on one node. The listener of the pod closes at the
 * stop of its intake. The rules of the node stop the new connections to the pod at the
 * propagation. A connection between the two is refused. Thus the window is empty when the intake
 * stops after the latest propagation.
 */
export interface DeletionWindow {
  /** This flag tells that no connection can meet a closed listener. */
  readonly empty: boolean;
  /** This band is the end of the window after the deletion: the propagation. */
  readonly end: Band;
  /** This time is the earliest stop of the intake after the deletion. */
  readonly intake: Quantity;
}

/** This function gives the deletion window of a declaration and a preStop sleep on a node with a propagation. */
export const deletionWindow = (declaration: Declaration, preStop: Quantity, propagation: Propagation): DeletionWindow => {
  const intake = intakeAfter(declaration, preStop);
  const spread = secondsOf(propagation);
  return { empty: s(intake) >= spread.hi, end: band(spread.lo, spread.hi), intake };
};

/**
 * This function gives the window on a node whose kube-proxy pauses across a deletion. The pause
 * starts `lead` before the deletion and holds for `hold`. The node then syncs in one propagation
 * after the end of the pause, at `resume` after the deletion. The window is empty when the intake
 * stops after that.
 */
export const pausedWindow = (
  declaration: Declaration,
  preStop: Quantity,
  lead: Quantity,
  hold: Quantity,
  propagation: Propagation,
): DeletionWindow & { readonly resume: Quantity } => {
  const intake = intakeAfter(declaration, preStop);
  const resume = us(s(hold) - s(lead));
  const spread = secondsOf(propagation);
  return { empty: s(intake) >= resume + spread.hi, end: band(spread.lo, spread.hi), intake, resume: seconds(resume) };
};

/**
 * A learn window is what `cannot-serve` predicts: when the callers stop getting errors from a
 * replica that cannot serve. The window starts at the fault, and its end comes from `end.from`.
 */
export interface LearnWindow {
  /** This time is the interval between two requests on one connection of a client: `every` times the connections. */
  readonly turn: Quantity;
  /** This band is the trip of the readiness latch of the service after the fault. */
  readonly latch: Band;
  /** This band is the first failed request after the fault: within one turn. */
  readonly start: Band;
  readonly end: { readonly from: Reference; readonly band: Band };
}

/**
 * This function gives the learn window of a declaration, its readiness probe, a propagation and a
 * workload of keep-alive connections. A caller selects a replica only when it opens a connection:
 * - The lame duck (`lameDuck` true or no value): after the latch, each answer has `Connection: close`,
 *   thus each connection of the replica gets one more failure and opens again. The rules select the
 *   replica until the removal, thus the last failure comes in one turn after it.
 * - No lame duck: no connection opens again, thus the rules do not matter. The failures end only
 *   when the readiness of the service recovers after the heal, and one turn after it.
 */
export const learnWindow = (declaration: Declaration, readiness: KubeletProbe, propagation: Propagation, workload: Workload): LearnWindow => {
  const turn = us(s(workload.every) * (workload.connections ?? 1));
  const latch = latchBand(declaration.readiness, declaration.poll, "refuses");
  const start = band(0, turn);
  if (declaration.lameDuck === false) {
    const recover = recoverSpan(declaration.readiness, declaration.poll);
    return { turn: seconds(turn), latch, start, end: { from: "heal", band: band(0, s(recover.max) + turn) } };
  }
  const removal = secondsOf(removalBand(latch, readiness, propagation));
  return { turn: seconds(turn), latch, start, end: { from: "fault", band: band(secondsOf(latch).lo, removal.hi + turn) } };
};

export { showBand } from "./bands.ts";
