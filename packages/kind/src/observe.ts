/**
 * This module reads a run from its lines. Each time is in milliseconds on CLOCK_MONOTONIC. All the
 * containers of the VM share that clock: the clients, the service, the agents, the injector, the
 * watcher and the prober.
 */

/**
 * A line is one JSON line of a source of a run, with its stamp `t` in milliseconds on
 * CLOCK_MONOTONIC. It is a request of a client, a record of the service, a line of grpc-go or a probe answer. It is
 * also a pod, an EndpointSlice or an event of the API. Or it is the backends of the rules of a
 * node, a kernel record, or an act of the lab. A record keeps each line as its source wrote it.
 */
export interface Line {
  readonly ev: string;
  readonly t: number;
  readonly [field: string]: unknown;
}

/**
 * A request is one request of a client: its start, its duration in ms, its outcome, its client and
 * the node of the client. The backend (`b`) is the pod that answered. The local port (`lp`) is on
 * each request from 0.1.3, and on the failed ones before it. A conntrack entry is per port, thus the
 * requests on one port show which connection a stale entry came from.
 */
export interface Request {
  readonly t: number;
  readonly d: number;
  readonly o: string;
  readonly p: string;
  readonly n: string;
  readonly b?: string;
  readonly lp?: number | null;
}

/** A pod line is one state of a pod, as the watcher received it. */
export interface PodLine {
  readonly t: number;
  readonly type: string;
  readonly name: string;
  readonly node: string | null;
  readonly ip: string | null;
  readonly del: boolean;
  readonly ready: boolean;
  readonly phase: string | null;
  readonly cs: ReadonlyArray<{ readonly n: string; readonly r: boolean; readonly rc: number; readonly st: string; readonly id: string | null }>;
  readonly labels: Readonly<Record<string, string>>;
}

/** An endpoint is one endpoint of an EndpointSlice: its address, its conditions and its pod. */
export interface Endpoint {
  readonly ip: string | null;
  readonly r: boolean | null;
  readonly s: boolean | null;
  readonly x: boolean | null;
  readonly pod: string | null;
  readonly node: string | null;
}

/** A slice line is one state of an EndpointSlice. */
export interface SliceLine {
  readonly t: number;
  readonly type: string;
  readonly name: string;
  readonly svc: string | null;
  readonly eps: readonly Endpoint[];
}

/** A rules line is the backends of the Service in the rules of one node, after a change. `prev` is the start of the poll before it. */
export interface RulesLine {
  readonly t: number;
  readonly prev: number | null;
  readonly node: string;
  readonly b: readonly string[];
}

/** A record line is one transition of a machine of the service, with its own stamp `at`. */
export interface RecordLine {
  readonly t: number;
  readonly at: number;
  readonly p: string;
  readonly m: string;
  readonly i: string;
  readonly from: string;
  readonly to: string;
  readonly on: string;
  readonly d: string | null;
}

const of = <T>(lines: readonly Line[], ev: string): T[] => lines.filter((line) => line.ev === ev) as unknown as T[];

export const requestsOf = (lines: readonly Line[]): Request[] => of<Request>(lines, "req");
export const podsOf = (lines: readonly Line[]): PodLine[] => of<PodLine>(lines, "pod").sort((a, b) => a.t - b.t);
export const slicesOf = (lines: readonly Line[], svc: string): SliceLine[] =>
  of<SliceLine>(lines, "slice").filter((line) => line.svc === svc);
export const rulesOf = (lines: readonly Line[]): RulesLine[] => of<RulesLine>(lines, "rules").sort((a, b) => a.t - b.t);
export const recordsOf = (lines: readonly Line[]): RecordLine[] => of<RecordLine>(lines, "rec");

/** This function gives the requests that did not succeed, in sequence of their start. */
export const failuresOf = (lines: readonly Line[]): Request[] =>
  requestsOf(lines)
    .filter((request) => request.o !== "ok")
    .sort((a, b) => a.t - b.t);

/** This function counts the outcomes of the requests, by outcome. */
export const outcomesOf = (requests: readonly Request[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const request of requests) out[request.o] = (out[request.o] ?? 0) + 1;
  return out;
};

/**
 * This function orders the replicas by how many clients each one answered last, the most first,
 * then by name. `answers` gives the backend of the last answer of each client, by client. A client
 * of gRPC holds its connection to one replica, thus the first replica is the one whose stop the
 * most clients see.
 */
export const byClients = <T extends { readonly pod: string }>(replicas: readonly T[], answers: ReadonlyMap<string, string>): T[] => {
  const count = (pod: string): number => [...answers.values()].filter((backend) => backend === pod).length;
  return [...replicas].sort((a, b) => count(b.pod) - count(a.pod) || a.pod.localeCompare(b.pod));
};

/** This function gives the requests of each node, by the name of the node. */
export const byNode = (requests: readonly Request[]): Map<string, Request[]> => {
  const out = new Map<string, Request[]>();
  for (const request of requests) out.set(request.n, [...(out.get(request.n) ?? []), request]);
  return out;
};

/** This function gives the time that the watcher first received a deletion timestamp of one of the pods, after a time. */
export const deletionOf = (lines: readonly Line[], pods: readonly string[], after: number): number | null =>
  podsOf(lines).find((pod) => pods.includes(pod.name) && pod.del && pod.t >= after)?.t ?? null;

/** This function gives the stamp of a transition of the service in a pod: the first matching record of a machine, after a time. */
export const transitionOf = (
  lines: readonly Line[],
  pod: string,
  machine: string,
  match: (record: RecordLine) => boolean,
  after: number,
): number | null =>
  recordsOf(lines).find((record) => record.p === pod && record.m === machine && record.at >= after && match(record))?.at ?? null;

/**
 * This function gives the line `stopping` of grpc-go in a pod, after a time. The server writes it at
 * SIGTERM. Then GracefulStop closes its listener and sends GOAWAY on each connection.
 */
export const stoppingOf = (lines: readonly Line[], pod: string, after: number): number | null =>
  lines.find((line) => line.ev === "stopping" && line["p"] === pod && line.t >= after)?.t ?? null;

/**
 * This function gives when the server of a pod stopped its intake. That is the start of the phase
 * `stop intake` of the service, or the line `stopping` of grpc-go.
 */
export const intakeOf = (lines: readonly Line[], pod: string, after: number): number | null =>
  transitionOf(lines, pod, "drain", (record) => record.to === "stop intake", after) ?? stoppingOf(lines, pod, after);

/** This function gives when the server of a pod received its exit signal: a record of the service, or the line `stopping` of grpc-go. */
export const signalOf = (lines: readonly Line[], pod: string, after: number): number | null =>
  transitionOf(lines, pod, "exit", (record) => record.on === "exit.request", after) ?? stoppingOf(lines, pod, after);

/**
 * This function gives when the rules of a node stopped the selection of a backend: the first poll
 * after a time without it. The change came after `prev`, the poll before it, and at the latest at `t`.
 */
export const dropOf = (lines: readonly Line[], node: string, backend: string, after: number): RulesLine | null =>
  rulesOf(lines).find((line) => line.node === node && line.t >= after && !line.b.includes(backend)) ?? null;

/** This function gives when the rules of a node had no backend of the Service, after a time. */
export const emptyOf = (lines: readonly Line[], node: string, after: number): RulesLine | null =>
  rulesOf(lines).find((line) => line.node === node && line.t >= after && line.b.length === 0) ?? null;

/** This function gives when an EndpointSlice of the Service first had no ready endpoint, after a time. */
export const sliceEmptyOf = (lines: readonly Line[], svc: string, after: number): number | null =>
  slicesOf(lines, svc).find((slice) => slice.t >= after && !slice.eps.some((endpoint) => endpoint.r === true))?.t ?? null;

/** This function gives when the endpoint of an address was first not ready in the EndpointSlice of the Service, after a time. */
export const sliceDropOf = (lines: readonly Line[], svc: string, ip: string, after: number): number | null =>
  slicesOf(lines, svc).find((slice) => slice.t >= after && !slice.eps.some((endpoint) => endpoint.ip === ip && endpoint.r === true))?.t ?? null;

/** This function gives the latest state of each pod at a time, by its name. A deleted pod is not in it. */
export const podsAt = (lines: readonly Line[], at: number): Map<string, PodLine> => {
  const out = new Map<string, PodLine>();
  for (const pod of podsOf(lines)) {
    if (pod.t > at) break;
    if (pod.type === "DELETED") out.delete(pod.name);
    else out.set(pod.name, pod);
  }
  return out;
};

/** This function gives the latest backends of each node at a time, by node. */
export const backendsAt = (lines: readonly Line[], at: number): Map<string, readonly string[]> => {
  const out = new Map<string, readonly string[]>();
  for (const line of rulesOf(lines)) {
    if (line.t > at) break;
    out.set(line.node, line.b);
  }
  return out;
};

/** This function gives the kernel records of the kinds that the lab keeps, counted by kind. */
export const kernelCounts = (lines: readonly Line[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const line of lines) if (line.ev.startsWith("kernel.")) out[line.ev.slice(7)] = (out[line.ev.slice(7)] ?? 0) + 1;
  return out;
};

/** This function gives the SIGTERM of each pod in a set after a time, by pod. A pod without one is not in it. */
export const signalsOf = (lines: readonly Line[], pods: readonly string[], after: number): Map<string, number> => {
  const out = new Map<string, number>();
  for (const pod of pods) {
    const at = signalOf(lines, pod, after);
    if (at !== null) out.set(pod, at);
  }
  return out;
};

/** This function gives the restart count of each container of each pod at a time, summed by pod. */
export const restartsAt = (lines: readonly Line[], at: number): Map<string, number> => {
  const out = new Map<string, number>();
  for (const [name, pod] of podsAt(lines, at)) out.set(name, pod.cs.reduce((sum, status) => sum + status.rc, 0));
  return out;
};
