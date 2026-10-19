import type { Machine } from "@mark1russell7/algebra";
import type { Cell, Cluster, GroupPlace, GroupPrediction, Prediction } from "@mark1russell7/harness";
import { AMQPLIB, ATEN_DETECTOR, RA_MEMBER } from "@mark1russell7/machines";
import type { Extent, Quantity } from "@mark1russell7/quantity";
import { RUNS, given, s } from "../catalog.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import type { Span } from "../mongo/model.ts";
import { plus, span, spanOf } from "../mongo/model.ts";
import { RABBIT_IMAGE, RABBIT_LATENCY, RABBIT_RTT_MS, RABBIT_TARGET, amqpValues } from "./t01.ts";

/**
 * The RabbitMQ catalog of T11: amqplib 2.2.0 on Node 24.21.0 against a cluster of three nodes of RabbitMQ
 * 4.3.6, with one quorum queue. The members of the queue elect its leader by Raft (ra 3.1.10), one member
 * on each node. The client publishes a stream of sequence numbers with confirms, one at a time, 50 ms
 * after each confirm. It publishes through the node of a follower. Thus a fault at the node of the
 * leader acts on the queue, and not on the connection of the client.
 *
 * Each band comes from the documents `aten`, `ra-member` and `amqplib`. When the node of the leader goes
 * silent, aten on each follower reports it down. A follower then waits 1 s to 2 s for its election.
 * The new leader tells the channel of the client, and the channel sends its pending publish again.
 */

/** This cluster is three nodes of RabbitMQ 4.3.6 with the quorum queue `cells`, at the defaults of each timer. */
export const RABBIT_CLUSTER: Cluster = {
  image: RABBIT_IMAGE,
  members: ["r1", "r2", "r3"],
  port: 5672,
  cookie: "cells-of-t11-share-this-cookie",
  conf: [],
  queue: "cells",
  ready: "Server startup complete",
  programs: { server: "beam.smp", start: "docker-entrypoint.sh rabbitmq-server" },
};

/** This time is the wait of the client after each confirm, before its next publish, in seconds. */
export const INTERVAL = 0.05;
/** This time is how long a network fault or a freeze holds, in seconds. Each band ends long before it. */
export const HOLD = 20;
/** This time is how long a fault holds when the client is on the node of the fault, in seconds. It is longer than the end of its heartbeat. */
export const CLIENT_HOLD = 200;
/** This time is the wait of the client before it connects to the next node, in seconds (client-cluster.mjs, --reconnect-ms). */
export const RECONNECT = 1;
/** This time is the error of the stamps of the log of a node on the monotonic clock. The clock lines of the client truncate to 1 ms. */
export const NODE_STAMPS: Quantity = { value: 2, unit: "ms" };

/** A spec is one cell of the catalog: its cell of the plan, its fault and the node of the fault. */
export interface ClusterSpec {
  readonly plan: string;
  readonly name: string;
  readonly fault: "blackhole" | "partition" | "freeze-process" | "step-down" | "drain";
  readonly at: GroupPlace;
  readonly hold?: number;
  /** This place puts the client on the node of the leader. Without it, the client is on the node of a follower. */
  readonly clientAt?: "leader";
}

/** These are the cells of T11 over amqplib-2.2 and rabbitmq-4.3 at the defaults that this catalog starts. */
export const T11_RABBIT_SPECS: readonly ClusterSpec[] = [
  { plan: "T11.defaults.7", name: "event:stepdown, transfer_leadership to a follower", fault: "step-down", at: { role: "primary" } },
  { plan: "T11.defaults.74", name: `freeze-process at the node of the leader, ${HOLD} s`, fault: "freeze-process", at: { role: "primary" }, hold: HOLD },
  { plan: "T11.defaults.75", name: `blackhole at the node of the leader, cut from each node and the client, ${HOLD} s`, fault: "blackhole", at: { role: "primary", cuts: "all" }, hold: HOLD },
  {
    plan: "T11.defaults.76",
    name: `partition:complete, the node of the leader cut from the other nodes, ${HOLD} s`,
    fault: "partition",
    at: { role: "primary", cuts: "group" },
    hold: HOLD,
  },
  { plan: "T11.defaults.77", name: `partition:partial, the node of the leader cut from one follower, ${HOLD} s`, fault: "partition", at: { role: "primary", cuts: "one" }, hold: HOLD },
  {
    plan: "T11.defaults.78",
    name: `partition:simplex, the segments from the node of the leader to one follower dropped, ${HOLD} s`,
    fault: "partition",
    at: { role: "primary", cuts: "one-way" },
    hold: HOLD,
  },
  { plan: "T11.defaults.79", name: "event:broker-drain, rabbitmq-upgrade drain at the node of the leader", fault: "drain", at: { role: "primary" } },
  // ---- the client on the node of the leader: its connection meets the fault too
  {
    plan: "T11.defaults.74",
    name: `freeze-process at the node of the leader, the client on it, ${CLIENT_HOLD} s`,
    fault: "freeze-process",
    at: { role: "primary" },
    hold: CLIENT_HOLD,
    clientAt: "leader",
  },
  {
    plan: "T11.defaults.75",
    name: `blackhole at the node of the leader, the client on it, ${CLIENT_HOLD} s`,
    fault: "blackhole",
    at: { role: "primary", cuts: "all" },
    hold: CLIENT_HOLD,
    clientAt: "leader",
  },
];

/** This function gives the values of the knobs of a document: its defaults, and the round trip between the nodes. */
const valuesOf = (doc: Machine): Record<string, Extent> => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(doc.knobs)) {
    if (knob.unit === null || knob.default === null) continue;
    out[name] = { value: knob.default, unit: knob.unit };
  }
  out["rtt"] = { value: RABBIT_RTT_MS, unit: "ms" };
  return out;
};
const ATEN = valuesOf(ATEN_DETECTOR);
const RA = valuesOf(RA_MEMBER);
const ms = (values: Readonly<Record<string, Extent>>, name: string): number => {
  const value = values[name];
  if (value === undefined || value.value === "infinite") throw new Error(`no value of ${name}`);
  return (value.value as number) / (value.unit === "ms" ? 1000 : 1);
};

/**
 * These are the parts of each band, in seconds: the detection of aten and the election timeouts. Also a
 * round of votes, a commit, and the wait of the client.
 */
export const PARTS = (() => {
  const detect = spanOf(ATEN_DETECTOR, "detect", given(ATEN));
  // the last heartbeat of the node came up to one heartbeat interval before the fault
  const fromFault = span(detect.lo - ms(ATEN, "heartbeat_interval"), detect.hi);
  const long = spanOf(RA_MEMBER, "election_long", given(RA));
  const short = spanOf(RA_MEMBER, "election_short", given(RA));
  // one round of requests and answers between the members, each with one step of the BEAM
  const round = span(0, RABBIT_RTT_MS / 1000 + ms(RA, "slack"));
  const commit = ms(RA, "commit_work");
  const slack = (AMQPLIB.knobs["slack"]?.default ?? 0) * (AMQPLIB.knobs["slack"]?.unit === "ms" ? 1 / 1000 : 1);
  return { detect, fromFault, long, short, round, commit, gap: span(INTERVAL, INTERVAL + slack) };
})();

/**
 * This function gives the band of the new leader after the node of the leader goes silent, from the
 * fault. First aten on a follower reports the node down. Then the long election timeout fires, and a
 * round of pre-votes and a round of votes follow.
 *
 * When the first candidate has a log behind the other follower, the other follower declines it. Its
 * own timeout, which it armed at its own report of aten, then elects it, in the same band. One split
 * vote adds a short timeout and its two rounds.
 */
export const silentLeader = (): Span => {
  const { fromFault, long, short, round } = PARTS;
  const first = plus(plus(fromFault, long), plus(round, round));
  return span(first.lo, first.hi + short.hi + 2 * round.hi);
};

/**
 * This function gives the band of a transfer of the leadership, from the NOTICE of the old leader. The
 * old leader sends its election timeout to the target, then the two rounds follow.
 */
export const transfer = (): Span => {
  const { round } = PARTS;
  return span(0, 3 * round.hi);
};

/**
 * This function gives the band of the first confirm of a publish that the client sent after the fault.
 * The new leader tells the channel, and the channel sends its pending publish again: one commit. The
 * client then waits, and its next publish takes one commit more. A fault in the wait of the client
 * makes that next publish the pending one.
 */
export const firstConfirm = (leader: Span): Span => {
  const { commit, gap } = PARTS;
  return span(leader.lo, leader.hi + commit + gap.hi + commit);
};

/** This function gives the prediction of a cell: the band of its first confirm, and the stages of the cluster. */
/**
 * This function gives the band of the first confirm when the node of the client goes silent, from the
 * fault. Only the heartbeat of amqplib ends the connection: 2 to 3 heartbeats after its last data, the
 * last confirm before the fault. That confirm came up to one wait and one commit before the fault. Then
 * the client waits, connects to the next node and opens its channel, and its publish takes one commit.
 */
export const silentClient = (): Span => {
  const { commit, gap } = PARTS;
  const heartbeat = spanOf(AMQPLIB, "heartbeat", given(amqpValues()));
  const end = span(heartbeat.lo - gap.hi - commit, heartbeat.hi);
  // the handshake of AMQP and the open of the channel and of its confirms: six exchanges with the broker
  const connect = span(0, 6 * RABBIT_LATENCY);
  const reconnect = span(RECONNECT, RECONNECT + gap.hi - gap.lo);
  return plus(plus(end, reconnect), plus(connect, span(0, commit)));
};

export const clusterPrediction = (spec: ClusterSpec): Prediction => {
  const stages = (elected: Span, first: Span): GroupPrediction["stages"] => [
    { stage: "elected", low: s(elected.lo), high: s(elected.hi) },
    { stage: "first-write", low: s(first.lo), high: s(first.hi) },
  ];
  // a cut of one follower leaves the leader a majority: the cut follower asks for pre-votes, and the
  // other follower declines each one, because the log of the cut follower falls behind
  if (spec.fault === "partition" && (spec.at.cuts === "one" || spec.at.cuts === "one-way")) {
    const first = firstConfirm(span(0, 0));
    const group: GroupPrediction = { lands: "same", failover: false, stages: [{ stage: "first-write", low: s(first.lo), high: s(first.hi) }], stamps: NODE_STAMPS, quiet: ["elected"] };
    return { detects: true, timer: "the next confirm, with no new leader", errno: "OK", from: "fault", low: s(first.lo), high: s(first.hi), group };
  }
  const elected = spec.fault === "step-down" || spec.fault === "drain" ? transfer() : silentLeader();
  // the client on the silent node: its own heartbeat ends its connection long after the new leader
  const first = spec.clientAt === "leader" ? silentClient() : firstConfirm(elected);
  const group: GroupPrediction = { lands: "same", failover: true, stages: stages(elected, first), stamps: NODE_STAMPS };
  return { detects: true, timer: "the first confirm through the new leader", errno: "OK", from: "fault", low: s(first.lo), high: s(first.hi), group };
};

/** This function gives the name of a cell: its cell of the plan, its tuple of systems, and what it does. */
export const clusterNameOf = (spec: ClusterSpec): string => `${spec.plan} amqplib-2.2 to rabbitmq-4.3 cluster, ${spec.name}`;

/** This function gives the harness cell of a spec. */
export const clusterCell = (spec: ClusterSpec): Cell => ({
  name: clusterNameOf(spec),
  target: RABBIT_TARGET,
  sysctls: {},
  probe: { mode: "stream", keepalive: false, interval: { value: INTERVAL * 1000, unit: "ms" } },
  fault: spec.fault,
  faultAt: spec.at,
  cluster: RABBIT_CLUSTER,
  ...(spec.hold === undefined ? {} : { hold: s(spec.hold) }),
  ...(spec.clientAt === undefined ? {} : { clientAt: spec.clientAt }),
  prediction: clusterPrediction(spec),
  runs: RUNS,
  environments: 2,
  // a cluster has 10 containers, and its timeline reads three nodes: one cell at a time
  concurrency: 1,
});

/** These are the RabbitMQ cells of T11 for the harness. */
export const T11_RABBIT: readonly Cell[] = T11_RABBIT_SPECS.map(clusterCell);

/** These are the cells of the plan at the defaults that this catalog does not start, each with its reason. */
export const T11_RABBIT_WAITING: readonly Waiting[] = [
  { plan: "T11.defaults.80", trigger: "event:node-drain", why: "the harness has no node of Kubernetes to drain" },
  { plan: "T11.defaults.81", trigger: "cpu-throttle", why: "the harness has no throttle of the CPU of a node" },
  { plan: "T11.defaults.82", trigger: "event:rolling-upgrade", why: "a rolling upgrade needs two releases of RabbitMQ and a restart of each node in turn, which the harness does not do" },
  { plan: "T11.defaults.83", trigger: "timed:mid-commit", why: "the harness has no injector that times a fault to a reply" },
  { plan: "T11.defaults.84", trigger: "event:restore-without-volume", why: "the harness has no restart of a node from an empty volume" },
];

/**
 * The array stage of the plan gives each cell at the defaults the profile DP42. DP42 sets an aggressive
 * TCP keepalive (1 s, 1 s, 5 probes), the timeouts of a JDBC client and the DNS TTL of the JVM. It also
 * puts each host in the connection string. The client already connects to each node in turn.
 *
 * The keepalive acts on the socket of the client. With the client on a follower, no fault acts on that
 * socket. With the client on the node of the fault, Linux sends no keepalive probe while data is in
 * flight (tcp_timer.c:757-758 at v6.6). The client sends its next publish into the fault in most runs,
 * thus the keepalive can end only some runs. Thus each array cell is its cell at the defaults with the
 * client on a follower, or it waits for the reason of that cell.
 */
export const T11_RABBIT_ARRAY_ALIASES: readonly Alias[] = [...new Set(T11_RABBIT_SPECS.map((spec) => spec.plan))].map((plan) => ({
  plan: plan.replace(".defaults.", ".array."),
  is: plan,
  why: "DP42 sets the TCP keepalive of the client. With the client on a follower the fault does not act on its socket, and Linux sends no keepalive probe while data is in flight",
}));

/** These are the cells of the array stage that wait. Each one waits for the reason of its cell at the defaults. */
export const T11_RABBIT_ARRAY_WAITING: readonly Waiting[] = T11_RABBIT_WAITING.map((each) => ({
  plan: each.plan.replace(".defaults.", ".array."),
  trigger: each.trigger,
  why: `as ${each.plan}, under DP42: ${each.why}`,
}));
