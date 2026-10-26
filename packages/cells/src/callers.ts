import type { Declaration, KindCell, Workload } from "@mark1russell7/kind";
import { learnWindow } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { CHART_READINESS, DESIGN, PROPAGATION, T07_WORKLOAD, WORKERS, kubeDefaults, s, say } from "./kind.ts";

/**
 * The S2 cells of the dimension "how callers learn that a pod cannot serve". Clients send requests
 * through a Service to two replicas, and one replica loses the ability to serve for the hold. A
 * flag file fails its route, and the same flag fails its readiness check: the flag stands for a
 * dependency of the replica. The cells measure when the callers stop getting errors, and how many
 * requests fail. Two candidates operate on one trigger, one judge and one cell, with one setting:
 * - `endpoints only` (A): the edge keeps each connection open. Readiness fails, then the
 *   EndpointSlice and kube-proxy remove the replica.
 * - `in band` (B): the lame duck of the service. While the service is not ready, each answer of its
 *   edge has `Connection: close`, thus each caller opens a new connection.
 *
 * The scenario is the smallest one that can tell the two apart:
 * - The clients keep their connections (`KEEP_ALIVE`). kube-proxy selects a backend only for a new
 *   connection, and an established flow keeps its conntrack NAT. A client with a new connection for
 *   each request learns from the rules alone, thus an in-band signal changes nothing for it.
 * - T07 in iptables only: the default mode of kube-proxy, with a calibrated propagation. The question
 *   is about the edge of the service, not about the mode.
 * - Two replicas: the fewest with a replica that can serve.
 * - The readiness probe of the chart (2 s, 3 times): short runs, and the same probe as T18.
 */

/** This count is the keep-alive connections of each client. Eight spread over two replicas, thus each client has some on the target in almost each run. */
export const CONNECTIONS = 8;

/** This workload is the T07 workload on keep-alive connections: 20 ms between two requests, thus 160 ms between two requests on one connection. */
export const KEEP_ALIVE: Workload = { ...T07_WORKLOAD, connections: CONNECTIONS };

/** This time is how long the replica cannot serve. It is longer than the latest removal of the lame duck, thus the heal does not end its window. */
export const CANNOT_SERVE_HOLD = s(30);

/** This declaration is the design, with the flag check on readiness: the readiness of the service fails while the replica cannot serve. */
export const CANNOT_SERVE: Declaration = { ...DESIGN, flag: "readiness" };

/** These are the two candidates, by the name of the setting `lameDuck`. */
export type Candidate = "endpoints only" | "in band (lame duck)";

/** This function gives the expected count of failed requests in a window. Half of the connections of the clients go to the target. */
const failuresOf = (lo: number, hi: number): string => {
  // one client on each worker and one on the control plane
  const rate = (WORKERS + 1) / valueIn(KEEP_ALIVE.every, "s") / 2;
  return `${Math.round(rate * lo)}–${Math.round(rate * hi)}`;
};

const cellOf = (candidate: Candidate): KindCell => {
  const lameDuck = candidate === "in band (lame duck)";
  const declaration: Declaration = lameDuck ? CANNOT_SERVE : { ...CANNOT_SERVE, lameDuck: false };
  const pod = { ...kubeDefaults(2), readiness: CHART_READINESS };
  const propagation = PROPAGATION.iptables;
  const window = learnWindow(declaration, CHART_READINESS, propagation, KEEP_ALIVE);
  const latch = { lo: valueIn(window.latch.lo, "s"), hi: valueIn(window.latch.hi, "s") };
  const end = valueIn(window.end.band.hi, "s");
  const hold = valueIn(CANNOT_SERVE_HOLD, "s");
  const why = lameDuck
    ? `Each request on a connection to the target fails until the readiness latch of the service trips (${say(window.latch.lo)}–${say(window.latch.hi)}). Then each answer closes its connection, and the next connection can go to the target until the readiness probe and the propagation (${propagation.from}) remove it, up to ${say(window.end.band.hi)}. About ${failuresOf(latch.lo, latch.hi)} requests fail`
    : `Each connection to the target stays open, and the rules select a backend only for a new connection. Thus the removal of the endpoint changes nothing, and each request on those connections fails for the hold (${say(CANNOT_SERVE_HOLD)}) and until the readiness of the service recovers, up to ${say(window.end.band.hi)} after the heal. About ${failuresOf(hold, hold + end)} requests fail`;
  return {
    id: `S2.T07.${lameDuck ? "lame-duck" : "endpoints"}`,
    name: `T07 iptables, callers learn that a pod cannot serve: ${candidate}`,
    template: "T07",
    substitutes: null,
    mode: "iptables",
    workers: WORKERS,
    trigger: { kind: "cannot-serve", hold: CANNOT_SERVE_HOLD },
    pod,
    declaration,
    workload: KEEP_ALIVE,
    prediction: {
      kind: "window",
      nodes: "all",
      start: { from: "fault", band: window.start },
      end: window.end,
      certain: true,
      outcomes: ["503"],
      why,
    },
    calibrates: false,
    runs: 11,
  };
};

/** These are the cells of the two candidates: endpoint propagation (A), then the in-band signal (B). */
export const CALLERS_CELLS: readonly KindCell[] = [cellOf("endpoints only"), cellOf("in band (lame duck)")];
