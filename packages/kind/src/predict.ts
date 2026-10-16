import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Poll, Stage, Timing } from "@mark1russell7/service";
import { failSpan } from "@mark1russell7/service";
import type { Band, Declaration, KubeletProbe } from "./cell.ts";

/**
 * This module is the arithmetic of the predictions. Each band is in seconds after a reference event
 * of the run. Each term comes from a declaration, from the pod settings, or from the calibration of
 * the propagation. No term comes from a default.
 */

const s = (amount: Quantity): number => valueIn(amount, "s");
/** This function rounds a time to the microsecond, thus a band has no float residue. */
const us = (seconds: number): number => Math.round(seconds * 1e6) / 1e6;
const band = (lo: number, hi: number): Band => ({ lo: us(lo), hi: us(hi) });

/**
 * A propagation is the time from a change of an endpoint to the rules of each node, in seconds. A
 * calibration measures it for each kube-proxy mode and node count. Without a calibration, its upper
 * bound is `minSyncPeriod`: an idle kube-proxy syncs a change at once, or one `minSyncPeriod`
 * after its last sync.
 */
export interface Propagation {
  readonly lo: number;
  readonly hi: number;
  /** This text tells where the bound comes from: a calibration, or the documented `minSyncPeriod`. */
  readonly from: string;
}

/** This propagation is the documented bound, before a calibration: from zero to one `minSyncPeriod` of 1 s. */
export const DOCUMENTED: Propagation = { lo: 0, hi: 1, from: "minSyncPeriod (1 s), not calibrated" };

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
  const late = failSpan(timing, { ...poll, timeout: { value: wait, unit: "s" } }, "timeout");
  return band(s(error.min), s(late.max));
};

/** This function gives the time from a fault to the removal of the endpoints from the rules: the latch, then the kubelet, then the propagation. */
export const removalBand = (latch: Band, probe: KubeletProbe, propagation: Propagation): Band => {
  const kubelet = kubeletBand(probe, false);
  return band(latch.lo + kubelet.lo + propagation.lo, latch.hi + kubelet.hi + propagation.hi);
};

/**
 * This function gives the time from a fault to the SIGTERM of a replica whose liveness fails with
 * its readiness. The time is the latch, then the liveness probes of the kubelet, then the preStop sleep.
 */
export const restartBand = (latch: Band, liveness: KubeletProbe, preStop: Quantity): Band => {
  const kubelet = kubeletBand(liveness, false);
  return band(latch.lo + kubelet.lo + s(preStop), latch.hi + kubelet.hi + s(preStop));
};

/**
 * This function gives the time from the start of a stall of the event loop to the removal of the
 * replica from the rules. Each probe in the stall fails at its timeout, because the loop does not answer it.
 */
export const stallRemovalBand = (readiness: KubeletProbe, propagation: Propagation): Band => {
  const kubelet = kubeletBand(readiness, true);
  return band(kubelet.lo + propagation.lo, kubelet.hi + propagation.hi);
};

/** This function gives the cap of a stage in a declaration, or zero when the declaration does not name the stage. */
export const capOf = (declaration: Declaration, stage: Stage): number => {
  const found = declaration.phases.find(([name]) => name === stage);
  return found === undefined ? 0 : s(found[1]);
};

/**
 * This function gives the shortest time from the deletion of a pod to the stop of its intake. It
 * is the preStop sleep, then the hold of `fail readiness`. The kubelet adds its own delay before
 * the preStop, thus the real time is longer.
 */
export const intakeAfter = (declaration: Declaration, preStop: Quantity): number =>
  us(s(preStop) + capOf(declaration, "fail readiness"));

/**
 * A deletion window is what a deletion predicts on one node. The listener of the pod closes at the
 * stop of its intake. The rules of the node stop the new connections to the pod at the
 * propagation. A connection between the two is refused. Thus the window is empty when the intake
 * stops after the latest propagation.
 */
export interface DeletionWindow {
  /** This flag tells that no connection can meet a closed listener. */
  readonly empty: boolean;
  /** This band is the end of the window, in seconds after the deletion: the propagation. */
  readonly end: Band;
  /** This time is the earliest stop of the intake, in seconds after the deletion. */
  readonly intake: number;
}

/** This function gives the deletion window of a declaration and a preStop sleep on a node with a propagation. */
export const deletionWindow = (declaration: Declaration, preStop: Quantity, propagation: Propagation): DeletionWindow => {
  const intake = intakeAfter(declaration, preStop);
  return { empty: intake >= propagation.hi, end: band(propagation.lo, propagation.hi), intake };
};

/**
 * This function gives the window on a node whose kube-proxy pauses across a deletion. The pause
 * starts `lead` before the deletion and holds for `hold`. The node then syncs in one propagation
 * after the end of the pause. The window is empty when the intake stops after that.
 */
export const pausedWindow = (
  declaration: Declaration,
  preStop: Quantity,
  lead: Quantity,
  hold: Quantity,
  propagation: Propagation,
): DeletionWindow & { readonly resume: number } => {
  const intake = intakeAfter(declaration, preStop);
  const resume = us(s(hold) - s(lead));
  return { empty: intake >= resume + propagation.hi, end: band(propagation.lo, propagation.hi), intake, resume };
};

/** This function gives a band in a short form for a name or a table: `[28, 49] s`. */
export const showBand = (b: Band): string => `[${b.lo}, ${b.hi}] s`;
