import type { Dataplane, Declaration, KindCell } from "@mark1russell7/kind";
import { learnWindow } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Expected } from "./callers.ts";
import {
  CALLERS_MODES,
  CANNOT_SERVE,
  CANNOT_SERVE_HOLD,
  DEPENDENCY_HOLD,
  FLAPS,
  FLAP_FAULTS,
  FLAP_HOLD,
  KEEP_ALIVE,
  expectedFailures,
  falseOf,
  flappingOf,
} from "./callers.ts";
import { CHART_READINESS, DESIGN_REDIS, PROPAGATION, WORKERS, kubeDefaults, ms, s, say } from "./kind.ts";

/**
 * The S6 cells of the shared gate, the candidate E of "how callers learn". E is B, the lame duck on
 * HTTP/1.1, with one more setting: `sharedGate` of the declaration. The readiness probe that the
 * kubelet reads leaves out each check of Redis, a dependency that each replica shares. The
 * controller still reads those checks, thus the service refuses each request at once with a 503.
 *
 * The second signal of the gate is the declaration itself: the author tells that each replica uses
 * the same Redis. No replica can tell alone if its peers fail too. Thus a failure of Redis keeps
 * each replica in the endpoints, and a failure of a check of no dependency still removes the replica.
 *
 * The cells measure E in three incidents, in each mode of kube-proxy:
 * - The black-holed shared dependency, and the flapping dependency, where the gate can help. The
 *   Service keeps its replicas, thus each caller gets fast 503s, as A does.
 * - A pod that cannot serve, where the gate must not hurt. The flag fails a check of no dependency.
 *   Thus the kubelet removes the target as for B. The cell has Redis, thus the gate is active.
 *
 * The decision rule of S6 compares E with the medians of B in the earlier measurements of each incident.
 */

/** This name is the candidate E: the lame duck with the shared gate. */
export const GATE = "in band with a shared gate";

/** These are the incidents of the shared gate, by the words of the id of each cell. */
export type GateFault = "shared dependency" | "flapping dependency" | "cannot serve";

/** These are the incidents of the shared gate in their sequence. */
export const GATE_FAULTS: readonly GateFault[] = ["shared dependency", "flapping dependency", "cannot serve"];

/**
 * This time is the largest lag of the first failed request after a fault in the kind run 40464814086
 * of the flapping dependency. The lag was 39 ms, against a band of 20 ms. The rule of the injector
 * commits after the stamp of the fault. Thus the band of the first failure gets this lag.
 */
export const FAULT_LAG = ms(39);

/** This declaration is the design with Redis and the lame duck, with the shared gate: the server of E in a shared dependency. */
export const GATE_DEPENDENCY: Declaration = { ...CANNOT_SERVE, flag: null, redis: DESIGN_REDIS.redis, sharedGate: true };

/**
 * This declaration is the server of E in a pod that cannot serve: the flag on readiness, and Redis
 * with the shared gate. Redis stays up, thus only the check of the flag fails.
 */
export const GATE_CANNOT_SERVE: Declaration = { ...CANNOT_SERVE, redis: DESIGN_REDIS.redis, sharedGate: true };

const time = (value: number): Quantity => s(Math.round(value * 1e6) / 1e6);

/** This band is a time, from its reference. */
interface Band {
  readonly lo: Quantity;
  readonly hi: Quantity;
}

/** This is the prediction of E in a shared dependency, or in a flapping dependency: no removal, and the window of the failed requests. */
export interface GateDependencyPrediction {
  /** These are the failed requests of the run. */
  readonly expected: Expected;
  /** These are the failed requests of one fault. */
  readonly each: Expected;
  /** This band is the first failed request, from the fault. */
  readonly start: Band;
  /** This band is the last failed request, from the heal. */
  readonly end: Band;
  /** This band is the start of the last slow failure, from the fault. After it, each failure is a fast 503. */
  readonly knows: Band;
  readonly why: string;
}

/**
 * This function gives the prediction of E in a black-holed shared dependency, or in a flapping one
 * (`faults` 3). E keeps each replica in the endpoints. Thus it has the bands of A, with the
 * corrections of the flapping dependency (`flappingOf`), and the lag of the first failure:
 * - Before the readiness latch trips, each request waits for Redis and fails slowly.
 * - After the trip, the service refuses each request with a 503, and the lame duck closes its
 *   connection. The next connection gets a replica at once, because the Service is not empty.
 * - After the heal, the readiness of the service recovers, and the next request succeeds. E does
 *   not wait for the kubelet and the propagation.
 */
export const gateDependencyOf = (mode: Dataplane, faults: 1 | typeof FLAP_FAULTS): GateDependencyPrediction => {
  const a = flappingOf(mode, "endpoints only");
  const every = valueIn(KEEP_ALIVE.every, "s");
  const start = { lo: s(0), hi: time(every + valueIn(FAULT_LAG, "s")) };
  const expected = faults === 1 ? a.each : a.expected;
  const flaps = faults === 1 ? `Redis is black-holed for each replica for ${say(DEPENDENCY_HOLD)}` : `Redis is black-holed ${FLAP_FAULTS} times for ${say(FLAP_HOLD)}, as in the flapping dependency`;
  const why = `${flaps}. The shared gate keeps the checks of Redis out of the readiness that the kubelet reads, thus no replica leaves the Service, and no request is refused. Before the readiness latch trips, each request waits for Redis and fails slowly. Then the service refuses each request at once with a 503, and the lame duck closes its connection. The next connection gets a replica at once. After the heal, the readiness of the service recovers up to ${say(a.end.hi)} later, and E does not wait for the kubelet. Thus E has the bands of A: approximately ${a.each.lo.value}–${a.each.hi.value} failed requests in each fault, and ${expected.lo.value}–${expected.hi.value} in the run. The first failure starts up to ${say(FAULT_LAG)} after the first request after the fault`;
  return { expected, each: a.each, start, end: { lo: s(0), hi: a.end.hi }, knows: a.knows, why };
};

/** This is the prediction of E in a pod that cannot serve: the bands of B, and the removal of the target. */
export interface GateCannotServePrediction {
  readonly expected: Expected;
  readonly start: Band;
  readonly end: ReturnType<typeof learnWindow>["end"];
  /** This band is the removal of the target from the EndpointSlice and the rules, from the fault. */
  readonly removal: Band;
  readonly certain: boolean;
  readonly why: string;
}

/**
 * This function gives the prediction of E in a pod that cannot serve. The flag fails the route and
 * a check of no dependency, and Redis stays up. Thus the gate leaves the probe as it is, and E has
 * each band of B: the failed requests, their window, and the removal (`falseOf` gives the same
 * latch, probe and propagation).
 */
export const gateCannotServeOf = (mode: Dataplane): GateCannotServePrediction => {
  const b = "in band (lame duck)" as const;
  const window = learnWindow(CANNOT_SERVE, CHART_READINESS, PROPAGATION[mode], KEEP_ALIVE);
  const expected = expectedFailures(b, mode);
  const removal = falseOf(mode, b).removal;
  const why = `The flag fails the route of the target and its check, a check of no dependency. Redis stays up. Thus the shared gate leaves the readiness probe as it is, and the kubelet and the propagation remove the target ${say(removal.lo)}–${say(removal.hi)} after the fault, as for B. Each request on the target fails until the latch trips (${say(window.latch.lo)}–${say(window.latch.hi)}), and the lame duck closes its connection. Thus E has the band of B: approximately ${expected.lo.value}–${expected.hi.value} failed requests`;
  return { expected, start: window.start, end: window.end, removal, certain: expected.connections.lo.value > 0, why };
};

/** This function gives the cell of E in a mode, for an incident. */
const gateCellOf = (mode: Dataplane, fault: GateFault): KindCell => {
  const pod = { ...kubeDefaults(2), readiness: CHART_READINESS };
  const base = { template: "T07" as const, substitutes: null, mode, workers: WORKERS, pod, workload: KEEP_ALIVE, calibrates: false, runs: 3 };
  if (fault === "cannot serve") {
    const predicted = gateCannotServeOf(mode);
    return {
      ...base,
      id: `S2.T07.${mode}.shared-gate`,
      name: `T07 ${mode}, callers learn that a pod cannot serve: ${GATE}`,
      trigger: { kind: "cannot-serve", hold: CANNOT_SERVE_HOLD },
      declaration: GATE_CANNOT_SERVE,
      prediction: {
        kind: "leaves",
        band: predicted.removal,
        window: { kind: "window", nodes: "all", start: { from: "fault", band: predicted.start }, end: predicted.end, certain: predicted.certain, outcomes: ["503"], why: predicted.why },
        why: `The flag fails a check of no dependency, thus the shared gate does not keep the target. The kubelet removes it ${say(predicted.removal.lo)}–${say(predicted.removal.hi)} after the fault, as for B`,
      },
    };
  }
  const flapping = fault === "flapping dependency";
  const predicted = gateDependencyOf(mode, flapping ? FLAP_FAULTS : 1);
  return {
    ...base,
    id: `S2.T07.${mode}.shared-gate.${flapping ? "flapping" : "dependency"}`,
    name: `T07 ${mode}, callers learn that a shared dependency ${flapping ? "flaps" : "is black-holed"}: ${GATE}`,
    trigger: flapping ? { kind: "blackhole", hold: FLAP_HOLD, flaps: FLAPS } : { kind: "blackhole", hold: DEPENDENCY_HOLD },
    declaration: GATE_DEPENDENCY,
    prediction: {
      kind: "stays",
      failures: {
        kind: "window",
        nodes: "all",
        start: { from: "fault", band: predicted.start },
        end: { from: "heal", band: predicted.end },
        certain: true,
        ...(flapping ? { flaps: true } : {}),
        why: predicted.why,
      },
      why: `The round trip of Redis gates the readiness of the service, but the shared gate keeps it out of the readiness probe. Thus no replica leaves the Service${flapping ? ` in each of the ${FLAP_FAULTS} faults` : ""}, and no request is refused`,
    },
  };
};

/** These are the cells of E in each incident and each mode. Their sequence is by incident, then by mode. */
export const GATE_CELLS: readonly KindCell[] = GATE_FAULTS.flatMap((fault) => CALLERS_MODES.map((mode) => gateCellOf(mode, fault)));
