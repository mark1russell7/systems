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

/**
 * A node lifecycle is the set of timers that removes the pods of a lost node. The same timers give
 * them back after the heal of the node. The lab sets none of them, thus each one is a default of Kubernetes
 * v1.37.0 (file and line in that tag).
 */
export interface NodeLifecycle {
  /**
   * This time is `NodeMonitorGracePeriod`. The node lifecycle controller marks a node Unknown when
   * it saw no renewal of its lease for this time. Then it marks each pod of the node not ready.
   */
  readonly grace: Quantity;
  /** This time is `NodeMonitorPeriod`: the controller checks each node once in it. */
  readonly monitor: Quantity;
  /** This time is the renewal interval of the lease of the kubelet. */
  readonly renew: Quantity;
  /** This share is the jitter of each renewal interval: a renewal comes `renew` to `renew × (1 + jitter)` after the one before it. */
  readonly jitter: number;
  /** This time is the margin of the writes of the controller: the status of the node, then each pod of the node. */
  readonly writes: Quantity;
  /** This time is the PING timeout of the HTTP/2 health check of client-go. A kubelet that gets no PING ACK in it connects again. */
  readonly pingTimeout: Quantity;
  /** This time is the longest first backoff of a reflector of client-go before it watches again. */
  readonly rewatch: Quantity;
  /** This time is the sync period of the status manager of the kubelet: it puts back a pod status that the controller changed. */
  readonly statusSync: Quantity;
}

/**
 * These are the defaults of Kubernetes v1.37.0 for a lost node:
 * - `grace` 50 s and `monitor` 5 s: pkg/controller/nodelifecycle/config/v1alpha1/defaults.go, lines
 *   46 and 52. The controller checks the nodes on a sliding period (node_lifecycle_controller.go,
 *   lines 506–510). It sets the probe time when it sees a new lease (lines 952–960), and it marks the
 *   node Unknown after `grace` (line 962). Then it marks each pod of the node not ready (lines 768–773).
 * - `renew` 10 s: `NodeLeaseDurationSeconds` 40 (pkg/kubelet/apis/config/v1beta1/defaults.go, line 150)
 *   times the fraction 0.25 (pkg/kubelet/kubelet.go, lines 237 and 1156).
 * - `jitter` 0.04: the lease controller renews on a sliding jitter of 0.04
 *   (staging/src/k8s.io/component-helpers/apimachinery/lease/controller.go, line 153).
 * - `pingTimeout` 15 s: the PING timeout of the HTTP/2 health check, after a read idle timeout of 30 s
 *   (staging/src/k8s.io/apimachinery/pkg/util/net/http.go, lines 131–192).
 * - `rewatch` 1.6 s: a first backoff of 800 ms with a jitter of 1.0
 *   (staging/src/k8s.io/client-go/tools/cache/reflector.go, lines 62–67).
 * - `statusSync` 10 s: the sync period of the status manager (pkg/kubelet/status/status_manager.go, line 215).
 * - `writes` 0.25 s is a margin of the lab, not a default.
 */
export const NODE_LIFECYCLE: NodeLifecycle = {
  grace: seconds(50),
  monitor: seconds(5),
  renew: seconds(10),
  jitter: 0.04,
  writes: seconds(0.25),
  pingTimeout: seconds(15),
  rewatch: seconds(1.6),
  statusSync: seconds(10),
};

/**
 * This function gives the time from the loss of a node to the drop of its pods from the rules of
 * the other nodes. The last renewal of the lease comes up to `renew × (1 + jitter)` before the loss.
 * The controller sees it up to one `monitor` later, and marks the node `grace` after that. Then the
 * writes and the propagation follow. The band does not add the low bound of the propagation.
 */
export const nodeLossBand = (lifecycle: NodeLifecycle, propagation: Propagation): Band => {
  const last = s(lifecycle.renew) * (1 + lifecycle.jitter);
  return band(s(lifecycle.grace) - last, s(lifecycle.grace) + s(lifecycle.monitor) + s(lifecycle.writes) + s(propagation.hi));
};

/**
 * This function gives the time from the heal of a lost node until its pods are ready again in the
 * EndpointSlice. The kubelet connects again in one PING timeout at the most: its old connection
 * waits behind the backoff of TCP. Its reflectors watch again after their first backoff. Then its
 * status manager puts back the pod status in one sync period at the most.
 */
export const nodeReturnBand = (lifecycle: NodeLifecycle): Band =>
  band(0, s(lifecycle.pingTimeout) + s(lifecycle.rewatch) + s(lifecycle.statusSync) + s(lifecycle.writes));

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
  /**
   * This time is the interval between two requests on one connection of a client: `every` times the
   * connections. A client of HTTP/2 sends its streams on fewer connections, thus its turn is shorter.
   */
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
 * - The lame duck (`lameDuck` true or no value): after the latch, each answer closes its connection,
 *   thus each connection of the replica gets one more failure and opens again. The rules select the
 *   replica until the removal, thus the last failure comes in one turn after it.
 * - The signal of the lame duck is `Connection: close` on HTTP/1.1, and GOAWAY on HTTP/2. The
 *   arithmetic is the same: the turn is `every` times the connections, which are sessions on HTTP/2.
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

/**
 * The backlog term of a stall (SYS-42) is in `bands.ts`, thus the judge reads it with no other
 * import. `backlogEnd` adds n × d to the end band. `requestBand` counts the failed requests from
 * the measured period. A window carries the term in `backlog` (`BacklogTerm`).
 */
export type { CountBand } from "./bands.ts";
export { backlogEnd, requestBand, showBand } from "./bands.ts";
