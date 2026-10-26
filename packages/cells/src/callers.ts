import type { Declaration, KindCell, KubeProxyMode, Workload } from "@mark1russell7/kind";
import { KUBE_PROXY_MODES, learnWindow } from "@mark1russell7/kind";
import type { Quantity } from "@mark1russell7/quantity";
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
 * - T07 in each mode of kube-proxy with a calibrated propagation: iptables, ipvs and nftables. The
 *   mode is only a parameter of the cell. It gives the propagation of the removal, thus the end of
 *   the window of the lame duck. Each mode keeps an established connection on its backend. The
 *   conntrack NAT keeps it in iptables and nftables. In ipvs, a graceful delete sets the weight of
 *   the backend to 0, and the connection stays.
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

/** These are the two candidates in their sequence on the page: endpoint propagation (A), then the in-band signal (B). */
export const CANDIDATES: readonly Candidate[] = ["endpoints only", "in band (lame duck)"];

/** These are the modes of the S2 cells: each mode of kube-proxy. The type of `PROPAGATION` gives a calibrated propagation to each mode. */
export const CALLERS_MODES: readonly KubeProxyMode[] = KUBE_PROXY_MODES;

/**
 * These are the ways that each mode selects the backend of a new connection. The rules of iptables
 * and nftables select at random (`statistic --mode random`, `numgen random`). IPVS selects in turn, because the
 * default scheduler of kube-proxy is `rr`.
 */
export const SELECTION: Readonly<Record<KubeProxyMode, "random" | "in turn">> = { iptables: "random", ipvs: "in turn", nftables: "random" };

/** This count is the clients: one on each worker and one on the control plane. */
const CLIENTS = WORKERS + 1;

/** This count is the replicas of the S2 cells. One of them is the target. */
const REPLICAS = 2;

/** This share is the chance that the band of the connections on the target covers at the least, when the selection is random. */
const COVER = 0.95;

/**
 * This band is the expected count of failed requests in a run, as quantities in `{request}`. It
 * comes from the band of the connections on the target at the fault (`connections`, in
 * `{connection}`).
 */
export interface Expected {
  readonly lo: Quantity;
  readonly hi: Quantity;
  readonly connections: Connections;
}

/** This band is the count of the connections on the target at the fault, of all the connections of the clients (`of`), in `{connection}`. */
export interface Connections {
  readonly lo: Quantity;
  readonly hi: Quantity;
  readonly of: Quantity;
}

const requests = (value: number): Quantity => ({ value: Math.round(value), unit: "{request}" });
const connections = (value: number): Quantity => ({ value, unit: "{connection}" });

/**
 * This function gives the band of the connections of all clients on the target at the fault. In
 * turn, each client puts half of its connections on each replica. At random, the count is binomial,
 * and the band is the central band that has the chance `COVER` at the least.
 */
export const targetConnections = (mode: KubeProxyMode): Connections => {
  const total = CLIENTS * CONNECTIONS;
  if (SELECTION[mode] === "in turn")
    return { lo: connections(CLIENTS * Math.floor(CONNECTIONS / REPLICAS)), hi: connections(CLIENTS * Math.ceil(CONNECTIONS / REPLICAS)), of: connections(total) };
  const p = 1 / REPLICAS;
  const choose = (k: number): number => (k === 0 ? 1 : (choose(k - 1) * (total - k + 1)) / k);
  const chance = Array.from({ length: total + 1 }, (_, k) => choose(k) * p ** k * (1 - p) ** (total - k));
  const below = (k: number): number => chance.slice(0, k).reduce((sum, each) => sum + each, 0);
  const above = (k: number): number => chance.slice(k + 1).reduce((sum, each) => sum + each, 0);
  const tail = (1 - COVER) / 2;
  let lo = 0;
  while (below(lo + 1) <= tail) lo += 1;
  let hi = total;
  while (above(hi - 1) <= tail) hi -= 1;
  return { lo: connections(lo), hi: connections(hi), of: connections(total) };
};

/** This function gives the declaration of a candidate: the design, with the lame duck or without it. */
const declarationOf = (candidate: Candidate): Declaration => (candidate === "in band (lame duck)" ? CANNOT_SERVE : { ...CANNOT_SERVE, lameDuck: false });

/**
 * This function gives the expected count of failed requests of a candidate in a mode. Each
 * connection on the target fails one request in each turn. The lame duck fails until the latch
 * trips. A fails for the hold and until the readiness recovers.
 */
export const expectedFailures = (candidate: Candidate, mode: KubeProxyMode): Expected => {
  const window = learnWindow(declarationOf(candidate), CHART_READINESS, PROPAGATION[mode], KEEP_ALIVE);
  const turn = valueIn(window.turn, "s");
  const on = targetConnections(mode);
  const [few, many] = [on.lo.value / turn, on.hi.value / turn];
  if (candidate === "in band (lame duck)")
    return { lo: requests(few * valueIn(window.latch.lo, "s")), hi: requests(many * valueIn(window.latch.hi, "s")), connections: on };
  const hold = valueIn(CANNOT_SERVE_HOLD, "s");
  return { lo: requests(few * hold), hi: requests(many * (hold + valueIn(window.end.band.hi, "s"))), connections: on };
};

const cellOf = (mode: KubeProxyMode, candidate: Candidate): KindCell => {
  const lameDuck = candidate === "in band (lame duck)";
  const declaration = declarationOf(candidate);
  const pod = { ...kubeDefaults(2), readiness: CHART_READINESS };
  const propagation = PROPAGATION[mode];
  const window = learnWindow(declaration, CHART_READINESS, propagation, KEEP_ALIVE);
  const expected = expectedFailures(candidate, mode);
  const on = expected.connections;
  const selects =
    SELECTION[mode] === "random"
      ? `The rules select the backend of each connection at random, thus ${on.lo.value}–${on.hi.value} of the ${on.of.value} connections go to the target in ${COVER * 100} % of the runs at the least`
      : `IPVS selects the backends in turn, thus ${on.lo.value} of the ${on.of.value} connections go to the target`;
  const about = `${selects}. About ${expected.lo.value}–${expected.hi.value} requests fail`;
  const why = lameDuck
    ? `Each request on a connection to the target fails until the readiness latch of the service trips (${say(window.latch.lo)}–${say(window.latch.hi)}). Then each answer closes its connection, and the next connection can go to the target until the readiness probe and the propagation (${propagation.from}) remove it, up to ${say(window.end.band.hi)}. ${about}`
    : `Each connection to the target stays open, and the rules select a backend only for a new connection. Thus the removal of the endpoint changes nothing, and each request on those connections fails for the hold (${say(CANNOT_SERVE_HOLD)}) and until the readiness of the service recovers, up to ${say(window.end.band.hi)} after the heal. ${about}`;
  return {
    id: `S2.T07.${mode}.${lameDuck ? "lame-duck" : "endpoints"}`,
    name: `T07 ${mode}, callers learn that a pod cannot serve: ${candidate}`,
    template: "T07",
    substitutes: null,
    mode,
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

/** These are the cells of the two candidates in each mode, from one definition: by mode, then A before B. */
export const CALLERS_CELLS: readonly KindCell[] = CALLERS_MODES.flatMap((mode) => CANDIDATES.map((candidate) => cellOf(mode, candidate)));
