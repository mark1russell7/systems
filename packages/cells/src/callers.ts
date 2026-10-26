import type { Recovery } from "@mark1russell7/algebra";
import { recovery, timerOf } from "@mark1russell7/algebra";
import type { Declaration, KindCell, KubeProxyMode, Workload } from "@mark1russell7/kind";
import { KUBE_PROXY_MODES, learnWindow, stallRemovalBand } from "@mark1russell7/kind";
import { LINUX_TCP } from "@mark1russell7/machines";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { SessionCheckKnobs } from "@mark1russell7/service/http-client";
import { LINUX_66, given, seconds } from "./catalog.ts";
import { CHART_READINESS, DESIGN, PROPAGATION, T07_WORKLOAD, WORKERS, kubeDefaults, ms, s, say } from "./kind.ts";

/**
 * The S2 cells of the dimension "how callers learn that a pod cannot serve". Clients send requests
 * through a Service to two replicas, and one replica loses the ability to serve for the hold. A
 * flag file fails its route, and the same flag fails its readiness check: the flag stands for a
 * dependency of the replica. The cells measure when the callers stop getting errors, and how many
 * requests fail. Three candidates operate on one trigger, one judge and one cell, with two settings:
 * - `endpoints only` (A): the edge keeps each connection open. Readiness fails, then the
 *   EndpointSlice and kube-proxy remove the replica.
 * - `in band` (B): the lame duck of the service. While the service is not ready, each answer of its
 *   edge has `Connection: close`, thus each caller opens a new connection.
 * - `in band on HTTP/2` (C): the same lame duck on an edge of HTTP/2 without TLS (`protocol` h2c).
 *   While the service is not ready, the edge sends GOAWAY on each session. Each client sends its
 *   streams on one session, thus it has fewer connections on the target, and a shorter turn.
 * - `in band on HTTP/2 with a session check` (D): C, and the client checks each session
 *   (`SESSION_CHECK`). A stream timeout closes its session, and so does a PING with no ACK.
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
 *
 * The same cells also measure a second incident: a partitioned pod. A black hole comes between
 * the clients and the target replica for `PARTITION_HOLD`. The kubelet probes the replica from its
 * node, thus the readiness and the endpoint of the replica stay. No candidate gets a signal from
 * the replica, and each caller learns only from its own timeouts and its own TCP.
 *
 * The third incident is a stalled pod, a gray failure: the event loop of the target is blocked for
 * `STALL_HOLD`. The kernel still accepts each connection and acknowledges each segment, but the app
 * and its probes do not answer. The readiness probe removes the target in the stall, and no
 * candidate gets a signal from the replica.
 */

/** This count is the keep-alive connections of each client. Eight spread over two replicas, thus each client has some on the target in almost each run. */
export const CONNECTIONS = 8;

/** This workload is the T07 workload on keep-alive connections: 20 ms between two requests, thus 160 ms between two requests on one connection. */
export const KEEP_ALIVE: Workload = { ...T07_WORKLOAD, connections: CONNECTIONS };

/**
 * This workload is the T07 workload on one session of HTTP/2 for each client. Each request is a
 * stream on it, thus 20 ms come between two requests on one connection. A client of HTTP/2 opens
 * one connection to an origin (RFC 9113, section 9.1).
 */
export const MULTIPLEXED: Workload = { ...T07_WORKLOAD, connections: 1 };

/**
 * These are the knobs of the session check of D (`sessionCheck` of the service). A session with no
 * frame for 0.5 s gets a PING, and it closes with no ACK in 0.5 s. Thus the check closes a session
 * in 1.5 s at the most, before the stream timeout of 2 s. The round trip of a kind node is 0.1 ms,
 * thus a peer that answers always sends its ACK in time.
 */
export const SESSION_CHECK = { keepalive_time: s(0.5), keepalive_timeout: s(0.5) } as const satisfies SessionCheckKnobs;

/** This workload is the workload of C, with the session check of D on each session. */
export const CHECKED: Workload = { ...MULTIPLEXED, sessionCheck: SESSION_CHECK };

/** This time is how long the replica cannot serve. It is longer than the latest removal of the lame duck, thus the heal does not end its window. */
export const CANNOT_SERVE_HOLD = s(30);

/** These are the incidents of the S2 cells: the target cannot serve, a black hole partitions it from the clients, or its event loop stalls. */
export type CallerFault = "cannot serve" | "partition" | "stall";

/** These are the incidents in their sequence: the cells of "cannot serve" come first. */
export const CALLER_FAULTS: readonly CallerFault[] = ["cannot serve", "partition", "stall"];

/**
 * This time is how long the event loop of the target stays blocked in a stall. It has three bounds:
 * - It is longer than the latest removal by the readiness probe (7.309 s in IPVS), thus the probe removes
 *   the target in the stall.
 * - It is longer than the idle close of the server (6 s). Thus at the resume, the server closes each
 *   session that the stall kept quiet.
 * - It is shorter than the earliest restart by the liveness probe (21 s), thus the pod stays.
 */
export const STALL_HOLD = s(12);

/**
 * This time is how long the partition stays. The first retransmission of HTTP/2 after the heal is
 * then the eighth firing of the timer, with a margin on each side. Thus the end of C has one band.
 */
export const PARTITION_HOLD = s(22);

/**
 * This band is the heal after the hold, from the fault. The runner sleeps for the hold from the
 * fault, then the injector commits the heal 0.7 s later (`INJECT_LEAD_MS`). The commands before the
 * commit take up to 1.3 s more.
 */
export const HEAL_LEAD = { lo: s(0.7), hi: s(2) };

/** These are the TCP knobs of a kind node: Linux 6.6 with HZ 1000, and a round trip of 0.1 ms in one VM. */
export const KIND_TCP = given({ ...LINUX_66, hz: { value: 1000, unit: "Hz" }, rtt: ms(0.1) });

/**
 * This chance is the most for a chain of failed picks longer than the end band of A and B lets.
 * It is over all connections. A chain is a sequence of new connections to the target.
 */
const CHAIN_RISK = 0.001;

/** This declaration is the design, with the flag check on readiness: the readiness of the service fails while the replica cannot serve. */
export const CANNOT_SERVE: Declaration = { ...DESIGN, flag: "readiness" };

/** These are the four candidates, by the names of the settings `lameDuck` and `protocol`, and of the session check of the client. */
export type Candidate = "endpoints only" | "in band (lame duck)" | "in band on HTTP/2 (GOAWAY)" | "in band on HTTP/2 with a session check";

/**
 * These are the four candidates in their sequence on the page. A is endpoint propagation. B is the
 * in-band signal on HTTP/1.1, and C is the in-band signal on HTTP/2. D is C with the session check
 * of the client.
 */
export const CANDIDATES: readonly Candidate[] = ["endpoints only", "in band (lame duck)", "in band on HTTP/2 (GOAWAY)", "in band on HTTP/2 with a session check"];

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
/** This function gives a time in seconds to the microsecond, thus the sums of the bands print clean. */
const time = (value: number): Quantity => s(Math.round(value * 1e6) / 1e6);

/**
 * This function gives the band of the connections of all clients on the target at the fault, for a
 * count of connections of each client. In turn, each client puts half of its connections on each
 * replica. The first pick of each node is not known, thus an odd count gives the floor to the
 * ceiling of the half. At random, the count is binomial, and the band is the central band that has
 * the chance `COVER` at the least.
 */
export const targetConnections = (mode: KubeProxyMode, each: number = CONNECTIONS): Connections => {
  const total = CLIENTS * each;
  if (SELECTION[mode] === "in turn")
    return { lo: connections(CLIENTS * Math.floor(each / REPLICAS)), hi: connections(CLIENTS * Math.ceil(each / REPLICAS)), of: connections(total) };
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

/** This function tells if a candidate operates on HTTP/2: C and D. The session check of D is in the client. Thus the server of D is the server of C. */
const onHttp2 = (candidate: Candidate): boolean => candidate === "in band on HTTP/2 (GOAWAY)" || candidate === "in band on HTTP/2 with a session check";

/** This function gives the declaration of a candidate: the design, with the lame duck or without it, on HTTP/1.1 or on HTTP/2. */
const declarationOf = (candidate: Candidate): Declaration => {
  if (candidate === "endpoints only") return { ...CANNOT_SERVE, lameDuck: false };
  return onHttp2(candidate) ? { ...CANNOT_SERVE, protocol: "h2c" } : CANNOT_SERVE;
};

/**
 * This function gives the workload of a candidate. A and B have keep-alive connections of HTTP/1.1.
 * C has one session of HTTP/2, and D has that session with the session check.
 */
const workloadOf = (candidate: Candidate): Workload =>
  candidate === "in band on HTTP/2 with a session check" ? CHECKED : candidate === "in band on HTTP/2 (GOAWAY)" ? MULTIPLEXED : KEEP_ALIVE;

/** This function tells if a candidate is an in-band signal: the lame duck on HTTP/1.1 or on HTTP/2. */
const inBand = (candidate: Candidate): boolean => candidate !== "endpoints only";

/**
 * This function gives the expected count of failed requests of a candidate in a mode. Each
 * connection on the target fails one request in each turn. The lame duck fails until the latch
 * trips. A fails for the hold and until the readiness recovers.
 *
 * C has the mean of B: an eighth of the connections, each with 8 times the requests. Its band is wider, because each client has one
 * connection. A client on the target fails each of its requests, and a client on the other replica
 * fails none.
 */
export const expectedFailures = (candidate: Candidate, mode: KubeProxyMode, fault: CallerFault = "cannot serve"): Expected => {
  if (fault === "partition") return partitionOf(mode, candidate).expected;
  if (fault === "stall") return stallOf(mode, candidate).expected;
  const workload = workloadOf(candidate);
  const window = learnWindow(declarationOf(candidate), CHART_READINESS, PROPAGATION[mode], workload);
  const turn = valueIn(window.turn, "s");
  const on = targetConnections(mode, workload.connections);
  const [few, many] = [on.lo.value / turn, on.hi.value / turn];
  if (inBand(candidate))
    return { lo: requests(few * valueIn(window.latch.lo, "s")), hi: requests(many * valueIn(window.latch.hi, "s")), connections: on };
  const hold = valueIn(CANNOT_SERVE_HOLD, "s");
  return { lo: requests(few * hold), hi: requests(many * (hold + valueIn(window.end.band.hi, "s"))), connections: on };
};

/** This band is a time from the fault, as quantities in seconds. */
interface Band {
  readonly lo: Quantity;
  readonly hi: Quantity;
}

/** This is the prediction of a candidate in a partition or a stall: the expected failures, the window from the fault, and the reason. */
export interface PartitionPrediction {
  readonly expected: Expected;
  readonly start: Band;
  readonly end: Band;
  readonly outcomes?: readonly string[];
  readonly why: string;
}

/**
 * This function gives the failed picks of the new connections of one node, when IPVS selects in
 * turn. Each failed connection opens a new one, and the picks of one round come within one turn.
 * Thus they are consecutive on the node. The first pick of the node is not known.
 */
const inTurn = (each: number): { readonly lo: number; readonly hi: number; readonly rounds: number } => {
  const outcomes = Array.from({ length: REPLICAS }, (_, first) => {
    // the target is the backend 0, and the pointer of the node goes to the next backend at each pick
    let pick = first;
    let open = each;
    let failures = 0;
    let rounds = 0;
    while (open > 0) {
      let onTarget = 0;
      for (let at = 0; at < open; at += 1) {
        if (pick === 0) onTarget += 1;
        pick = (pick + 1) % REPLICAS;
      }
      if (onTarget > 0) rounds += 1;
      failures += onTarget;
      open = onTarget;
    }
    return { failures, rounds };
  });
  const failures = outcomes.map((outcome) => outcome.failures);
  return { lo: Math.min(...failures), hi: Math.max(...failures), rounds: Math.max(...outcomes.map((outcome) => outcome.rounds)) };
};

/**
 * This function gives the central band of a negative binomial count, with the chance `COVER` at
 * the least. The count is the failures before `successes` successes, with the chance `p` of each.
 */
export const negativeBinomial = (successes: number, p: number): { readonly lo: number; readonly hi: number } => {
  const tail = (1 - COVER) / 2;
  let chance = p ** successes;
  let below = 0;
  let lo = 0;
  for (let k = 0; ; k += 1) {
    if (below <= tail) lo = k;
    if (below + chance >= 1 - tail) return { lo, hi: k };
    below += chance;
    chance *= ((k + successes) / (k + 1)) * (1 - p);
  }
};

/**
 * This function gives the longest chain of picks of the target of one connection, at random. A
 * longer chain over all `total` connections has the chance `CHAIN_RISK` at the most.
 */
const chainOf = (total: number): number => {
  let chain = 1;
  while (total * (1 / REPLICAS) ** (chain + 1) > CHAIN_RISK) chain += 1;
  return chain;
};

/**
 * This function gives the prediction of D in a partition of the target. The session check closes
 * each session on the target, and the next request opens a new session. Its pick is the pick of a
 * new connection of A and B: in turn in IPVS, and at random in the other modes.
 * - The first session on the target: its last frame comes at the fault, up to one turn before. The
 *   check sends a PING at the second tick with no frame, and it closes the session one PING timeout
 *   later. The first stream timeout comes later, thus the PING closes the session.
 * - Each next session on the target does not connect. The first tick finds no SETTINGS frame, and the
 *   check closes the session one PING timeout later.
 * Each stream on a session on the target fails at the close.
 *
 * The same arithmetic gives D in a stall (`stallOf`). The words of the fault and its removal come
 * from its silence. A removal ends each chain: a new session after it goes to the other replica.
 */
const checkedOf = (mode: KubeProxyMode, workload: Workload, start: Band, silence: Silence): PartitionPrediction => {
  const { stays } = silence;
  const quiet = valueIn(SESSION_CHECK.keepalive_time, "s");
  const answer = valueIn(SESSION_CHECK.keepalive_timeout, "s");
  const every = valueIn(workload.every, "s");
  const turn = every * (workload.connections ?? 1);
  const on = targetConnections(mode, 1);
  // the first session closes in [Q + P - turn, 2Q + P], and each next session Q + P after its first stream
  const first = { lo: quiet + answer - turn, hi: 2 * quiet + answer };
  const next = quiet + answer;
  // the streams of a session: one at each request until the close, and the stream that the fault caught
  // a count rounded to six places, thus 1.5 s / 20 ms gives 75, not 74.99999999999999
  const of = (span: number): number => Math.round((span / every) * 1e6) / 1e6;
  const streams = { first: { lo: Math.floor(of(first.lo)), hi: Math.ceil(of(first.hi)) + 1 }, next: { lo: Math.floor(of(next)), hi: Math.ceil(of(next)) + 1 } };
  const check = `${stays}. The client checks its session: a PING after ${say(SESSION_CHECK.keepalive_time)} with no frame, and a close with no ACK in ${say(SESSION_CHECK.keepalive_timeout)}. The first session on the target closes ${say(time(first.lo))}–${say(time(first.hi))} after the fault, before its first stream timeout (${say(workload.timeout)}). Each stream on it fails at the close, ${streams.first.lo}–${streams.first.hi} streams. The next request opens a new session`;
  if (SELECTION[mode] === "in turn") {
    const node = inTurn(1);
    return {
      expected: { lo: requests(CLIENTS * node.lo * streams.first.lo), hi: requests(CLIENTS * node.hi * streams.first.hi), connections: on },
      start,
      end: { lo: s(0), hi: time(first.hi) },
      why: `${check}. IPVS selects in turn on each node, thus the new session goes to the other replica. ${on.lo.value}–${on.hi.value} of the ${on.of.value} sessions are on the target, thus about ${CLIENTS * node.lo * streams.first.lo}–${CLIENTS * node.hi * streams.first.hi} requests fail`,
    };
  }
  const total = CLIENTS;
  const picks = negativeBinomial(total, 1 - 1 / REPLICAS);
  const chain = chainOf(total);
  // at most one pick of each client is its first session, and each other pick is a next session
  const firsts = Math.min(picks.hi, total);
  const hi = firsts * streams.first.hi + (picks.hi - firsts) * streams.next.hi;
  const lo = Math.min(picks.lo, total) * streams.first.lo + Math.max(picks.lo - total, 0) * streams.next.lo;
  // a session that opens before the latest removal closes one check later, thus its last stream starts by then
  const chained = first.hi + (chain - 1) * (next + every);
  const removal = silence.removal ?? Infinity;
  const removed = Math.min(chained, removal + next);
  const ends =
    removed < chained
      ? `. The removal ends each chain: a session opens on the target ${say(time(removal))} after the fault at the latest, and it closes ${say(time(next))} later`
      : "";
  return {
    expected: { lo: requests(lo), hi: requests(hi), connections: on },
    start,
    end: { lo: s(0), hi: time(removed) },
    why: `${check}. It goes to the target at random, and ${silence.next}, and it closes the session ${say(time(next))} after its first stream, ${streams.next.lo}–${streams.next.hi} streams. The picks of the target of the ${total} clients are negative binomial: ${picks.lo}–${picks.hi} in ${COVER * 100} % of the runs, thus about ${lo}–${hi} requests fail. A chain longer than ${chain} picks has a chance of ${CHAIN_RISK} at the most${ends}`,
  };
};

/**
 * A silence is a fault that stops each answer of the target to the callers: a partition or a stall.
 * Its words and its removal are the parts of a prediction that change with the fault.
 */
interface Silence {
  /** This text tells what the readiness and the endpoint of the target do in the fault. */
  readonly stays: string;
  /** This text tells what a new session on the target gets, and how the session check finds it. */
  readonly next: string;
  /** This time is the latest removal of the target from the rules, in seconds after the fault, or null when its endpoint stays. */
  readonly removal: number | null;
}

/**
 * This function gives the prediction of A or B in a silence of the target. Each connection on the
 * target fails one request at its timeout. Then its next request opens a new connection, and the
 * next pick comes one turn later. A chain of picks of the target ends at the first pick of the other
 * replica.
 */
const picksOf = (mode: KubeProxyMode, candidate: Candidate, silence: Silence): PartitionPrediction => {
  const workload = workloadOf(candidate);
  const window = learnWindow(declarationOf(candidate), CHART_READINESS, PROPAGATION[mode], workload);
  const turn = valueIn(window.turn, "s");
  const each = workload.connections ?? 1;
  const on = targetConnections(mode, each);
  const total = CLIENTS * each;
  const start = { lo: s(0), hi: time(turn) };
  const same = candidate === "in band (lame duck)" ? ". The lame duck never starts, thus B is the same as A" : "";
  const picks = `${silence.stays}${same}. Each connection on the target fails one request at its timeout (${say(workload.timeout)}). Then a new connection picks a backend, one turn (${say(window.turn)}) later`;
  if (SELECTION[mode] === "in turn") {
    const node = inTurn(each);
    return {
      expected: { lo: requests(CLIENTS * node.lo), hi: requests(CLIENTS * node.hi), connections: on },
      start,
      end: { lo: s(0), hi: time(node.rounds * turn) },
      outcomes: ["timeout"],
      why: `${picks}. IPVS selects in turn on each node, thus each node fails ${node.lo}–${node.hi} requests in ${node.rounds} turns at the most. About ${CLIENTS * node.lo}–${CLIENTS * node.hi} requests fail`,
    };
  }
  const band = negativeBinomial(total, 1 - 1 / REPLICAS);
  const chain = chainOf(total);
  return {
    expected: { lo: requests(band.lo), hi: requests(band.hi), connections: on },
    start,
    end: { lo: s(0), hi: time(chain * turn) },
    outcomes: ["timeout"],
    why: `${picks}. Each pick goes to the target at random, thus the failures of the ${total} connections are negative binomial: ${band.lo}–${band.hi} in ${COVER * 100} % of the runs. A chain longer than ${chain} picks has a chance of ${CHAIN_RISK} at the most`,
  };
};

/**
 * This function gives the prediction of a candidate in a partition of the target. The readiness
 * and the endpoint of the target stay, thus B is the same as A.
 * - A and B: each connection on the target fails one request at its timeout, and a chain of new
 *   connections follows (`picksOf`).
 * - C: the session of a client on the target stays open. Each stream fails at its timeout until the
 *   first retransmission after the heal reaches the target. Then the target resets the session,
 *   or it sends GOAWAY.
 * - D: the session check closes each session on the target before its first stream timeout
 *   (`checkedOf`).
 */
export const partitionOf = (mode: KubeProxyMode, candidate: Candidate): PartitionPrediction => {
  const workload = workloadOf(candidate);
  const window = learnWindow(declarationOf(candidate), CHART_READINESS, PROPAGATION[mode], workload);
  const turn = valueIn(window.turn, "s");
  const timeout = valueIn(workload.timeout, "s");
  const on = targetConnections(mode, workload.connections ?? 1);
  const hold = valueIn(PARTITION_HOLD, "s");
  const stays = `The kubelet probes the target from its node, thus its readiness and its endpoint stay for the hold (${say(PARTITION_HOLD)})`;
  const silence: Silence = { stays, next: "its SYN gets no answer. The check finds no SETTINGS frame", removal: null };
  if (candidate === "in band on HTTP/2 with a session check") return checkedOf(mode, workload, { lo: s(0), hi: time(valueIn(workload.every, "s")) }, silence);
  if (!onHttp2(candidate)) return picksOf(mode, candidate, silence);
  // the chain of the server starts at its last answer, and the chain of the client one RTO before its first stream after the fault
  const rto = seconds(timerOf(LINUX_TCP, "retransmit", KIND_TCP, 0).duration, "the RTO of a kind node");
  const through = (end: number): Recovery => {
    const after = recovery(LINUX_TCP, "retransmit", KIND_TCP, s(end));
    if ("unknown" in after) throw new Error(`the retransmissions through a stall of ${end} s: ${after.unknown}`);
    return after;
  };
  // the stall of each chain is from its start to the heal
  const early = through(hold + valueIn(HEAL_LEAD.lo, "s") - turn);
  const late = through(hold + valueIn(HEAL_LEAD.hi, "s") + turn + rto);
  const firing = early.first[0];
  if (early.first.length !== 1 || late.first.length !== 1 || firing !== late.first[0])
    throw new Error(`the hold ${say(PARTITION_HOLD)} lets more than one firing be the first after the heal: ${early.first.join(", ")} and ${late.first.join(", ")}`);
  const crosses = { lo: valueIn(early.low, "s") - turn - rto, hi: valueIn(late.high, "s") + turn };
  const end = { lo: time(crosses.lo - timeout - turn), hi: time(crosses.hi) };
  const every = valueIn(workload.every, "s");
  const expected = { lo: requests((on.lo.value * valueIn(end.lo, "s")) / every), hi: requests((on.hi.value * crosses.hi) / every), connections: on };
  return {
    expected,
    start: { lo: s(0), hi: time(every) },
    end,
    why: `${stays}. A client with its session on the target gets no answer, and each stream fails at its timeout (${say(workload.timeout)}). TCP retransmits with a backoff, and firing ${firing} of the timer is the first after the heal: ${say(time(crosses.lo))}–${say(time(crosses.hi))} after the fault. Then the target resets the session, or it sends GOAWAY, and the client opens a new session. The last failure starts up to one timeout before. ${on.lo.value}–${on.hi.value} of the ${on.of.value} sessions are on the target, thus about ${expected.lo.value}–${expected.hi.value} requests fail`,
  };
};

/**
 * This function gives the prediction of a candidate in a stall of the target. The kernel of the
 * target accepts each connection and acknowledges each segment, but the blocked loop sends no frame.
 * Each readiness probe fails at its timeout, thus the target leaves the rules in the stall
 * (`stallRemovalBand`). The watchdog of the service fails one check after the stall, and its
 * liveness window needs more. Thus the service stays ready, and no in-band signal starts.
 * - A and B: the arithmetic of a partition (`picksOf`). The last pick of a chain comes before the
 *   earliest removal, thus the removal changes nothing.
 * - C: the session stays open, and each stream fails at its timeout. The loop resumes after the
 *   hold, and its timers come before its reads. Thus the server closes each quiet session at its
 *   idle close, with GOAWAY. The client sends each stream in flight again on a new session.
 * - D: the arithmetic of a partition (`checkedOf`), and the removal ends each chain.
 */
export const stallOf = (mode: KubeProxyMode, candidate: Candidate): PartitionPrediction => {
  const workload = workloadOf(candidate);
  const every = valueIn(workload.every, "s");
  const timeout = valueIn(workload.timeout, "s");
  const hold = valueIn(STALL_HOLD, "s");
  const removal = stallRemovalBand(CHART_READINESS, PROPAGATION[mode]);
  const removed = { lo: valueIn(removal.lo, "s"), hi: valueIn(removal.hi, "s") };
  const stays = `The event loop of the target is blocked for the hold (${say(STALL_HOLD)}), and so are its probes, but its kernel accepts each connection. Each readiness probe fails at its timeout, thus the target leaves the rules ${say(time(removed.lo))}–${say(time(removed.hi))} after the fault. The service stays ready: its watchdog fails only one check`;
  const silence: Silence = { stays, next: "its TCP connects, but the blocked loop sends no SETTINGS frame. The check sends a PING, which gets no ACK", removal: removed.hi };
  if (candidate === "in band on HTTP/2 with a session check") return checkedOf(mode, workload, { lo: s(0), hi: time(every) }, silence);
  if (!onHttp2(candidate)) {
    const picks = picksOf(mode, candidate, silence);
    const turn = every * (workload.connections ?? 1);
    // the last failed request picked its connection at the timeout of the request one turn before it
    const lastPick = valueIn(picks.end.hi, "s") - turn + timeout;
    if (lastPick >= removed.lo) throw new Error(`the last pick of a chain comes ${lastPick} s after the fault, after the earliest removal (${removed.lo} s)`);
    return { ...picks, why: `${picks.why}. The last pick of a chain comes ${say(time(lastPick))} after the fault at the latest, before the removal. Thus the removal changes nothing` };
  }
  // C: the established flow keeps the session on the target, and its streams fail until one timeout before the resume
  const on = targetConnections(mode, 1);
  const end = { lo: time(hold - timeout - every), hi: time(hold - timeout) };
  // a count rounded to six places, thus 10 s / 20 ms gives 500
  const of = (span: number): number => Math.round((span / every) * 1e6) / 1e6;
  const expected = { lo: requests(on.lo.value * Math.floor(of(hold - timeout - every))), hi: requests(on.hi.value * (Math.ceil(of(hold - timeout)) + 1)), connections: on };
  return {
    expected,
    start: { lo: s(0), hi: time(every) },
    end,
    outcomes: ["timeout"],
    why: `${stays}. A client with its session on the target gets no frame, and each stream fails at its timeout (${say(workload.timeout)}). The established flow keeps the session on the target after the removal. The loop resumes ${say(STALL_HOLD)} after the fault, and its timers come before its reads. Thus the server closes each quiet session at its idle close, with GOAWAY. Each stream in flight is above the last stream of the GOAWAY, thus the client sends it again on a new session, to the other replica. ${on.lo.value}–${on.hi.value} of the ${on.of.value} sessions are on the target, thus about ${expected.lo.value}–${expected.hi.value} requests fail`,
  };
};

/** These are the incidents of a silent target: the words of the name of each cell, and its trigger. */
const SILENT: Readonly<Record<Exclude<CallerFault, "cannot serve">, { readonly what: string; readonly trigger: KindCell["trigger"]; readonly predict: typeof partitionOf }>> = {
  partition: { what: "a pod is partitioned", trigger: { kind: "blackhole", hold: PARTITION_HOLD, partition: true }, predict: partitionOf },
  stall: { what: "a pod is stalled", trigger: { kind: "app-stall", hold: STALL_HOLD }, predict: stallOf },
};

/** These are the parts of the id of each candidate. */
const SUFFIX: Readonly<Record<Candidate, string>> = {
  "endpoints only": "endpoints",
  "in band (lame duck)": "lame-duck",
  "in band on HTTP/2 (GOAWAY)": "goaway",
  "in band on HTTP/2 with a session check": "session-check",
};

/** This function tells the incident of an S2 cell: a partition has the flag `partition` on its black hole, and a stall is an `app-stall`. */
export const callerFaultOf = (cell: KindCell): CallerFault =>
  cell.trigger.partition === true ? "partition" : cell.trigger.kind === "app-stall" ? "stall" : "cannot serve";

/** This function gives the cell of a candidate in a mode, for an incident. The cells of an incident share each setting but the trigger and the prediction. */
const cellOf = (mode: KubeProxyMode, candidate: Candidate, fault: CallerFault): KindCell => {
  const declaration = declarationOf(candidate);
  const workload = workloadOf(candidate);
  const pod = { ...kubeDefaults(2), readiness: CHART_READINESS };
  if (fault !== "cannot serve") {
    const silent = SILENT[fault];
    const predicted = silent.predict(mode, candidate);
    return {
      id: `S2.T07.${mode}.${SUFFIX[candidate]}.${fault}`,
      name: `T07 ${mode}, callers learn that ${silent.what}: ${candidate}`,
      template: "T07",
      substitutes: null,
      mode,
      workers: WORKERS,
      trigger: silent.trigger,
      pod,
      declaration,
      workload,
      prediction: {
        kind: "window",
        nodes: "all",
        start: { from: "fault", band: predicted.start },
        end: { from: "fault", band: predicted.end },
        certain: predicted.expected.connections.lo.value > 0,
        ...(predicted.outcomes !== undefined ? { outcomes: predicted.outcomes } : {}),
        why: predicted.why,
      },
      calibrates: false,
      runs: 3,
    };
  }
  const propagation = PROPAGATION[mode];
  const window = learnWindow(declaration, CHART_READINESS, propagation, workload);
  const expected = expectedFailures(candidate, mode);
  const on = expected.connections;
  const goaway = onHttp2(candidate);
  // the target answers each stream with 503 at once, thus the session check of D closes no session
  const checks = candidate === "in band on HTTP/2 with a session check" ? ". The target answers each stream at once, thus the session check closes no session, and D is the same as C" : "";
  const selects =
    SELECTION[mode] === "random"
      ? `The rules select the backend of each connection at random, thus ${on.lo.value}–${on.hi.value} of the ${on.of.value} connections go to the target in ${COVER * 100} % of the runs at the least`
      : on.lo.value === on.hi.value
        ? `IPVS selects the backends in turn, thus ${on.lo.value} of the ${on.of.value} connections go to the target`
        : `IPVS selects the backends in turn on each node, and the first pick of a node is not known. Thus ${on.lo.value}–${on.hi.value} of the ${on.of.value} connections go to the target`;
  const about = `${selects}. About ${expected.lo.value}–${expected.hi.value} requests fail`;
  // no connection on the target is a run with no failure: 1 in 8 runs at random, thus C is not certain
  const none = on.lo.value === 0 ? ". With no connection on the target, no request fails" : "";
  const why = inBand(candidate)
    ? `Each request on a connection to the target fails until the readiness latch of the service trips (${say(window.latch.lo)}–${say(window.latch.hi)}). Then each answer closes its connection${goaway ? " with a GOAWAY on its session" : ""}, and the next connection can go to the target until the readiness probe and the propagation (${propagation.from}) remove it, up to ${say(window.end.band.hi)}. ${about}${none}${checks}`
    : `Each connection to the target stays open, and the rules select a backend only for a new connection. Thus the removal of the endpoint changes nothing, and each request on those connections fails for the hold (${say(CANNOT_SERVE_HOLD)}) and until the readiness of the service recovers, up to ${say(window.end.band.hi)} after the heal. ${about}`;
  return {
    id: `S2.T07.${mode}.${SUFFIX[candidate]}`,
    name: `T07 ${mode}, callers learn that a pod cannot serve: ${candidate}`,
    template: "T07",
    substitutes: null,
    mode,
    workers: WORKERS,
    trigger: { kind: "cannot-serve", hold: CANNOT_SERVE_HOLD },
    pod,
    declaration,
    workload,
    prediction: {
      kind: "window",
      nodes: "all",
      start: { from: "fault", band: window.start },
      end: window.end,
      certain: on.lo.value > 0,
      outcomes: ["503"],
      why,
    },
    calibrates: false,
    runs: 11,
  };
};

/** These are the cells of the four candidates in each mode and each incident, from one definition. Their sequence is by incident, by mode, then A, B, C and D. */
export const CALLERS_CELLS: readonly KindCell[] = CALLER_FAULTS.flatMap((fault) =>
  CALLERS_MODES.flatMap((mode) => CANDIDATES.map((candidate) => cellOf(mode, candidate, fault))),
);
