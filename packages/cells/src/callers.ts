import type { Recovery } from "@mark1russell7/algebra";
import { recovery, timerOf } from "@mark1russell7/algebra";
import type { Declaration, Flap, KindCell, KubeProxyMode, Workload } from "@mark1russell7/kind";
import { KUBE_PROXY_MODES, NODE_LIFECYCLE, kubeletBand, latchBand, learnWindow, nodeLossBand, nodeReturnBand, removalBand, stallRemovalBand } from "@mark1russell7/kind";
import { LINUX_TCP } from "@mark1russell7/machines";
import { recoverSpan } from "@mark1russell7/service";
import type { Extent, Quantity } from "@mark1russell7/quantity";
import { isUnbounded, valueIn } from "@mark1russell7/quantity";
import type { SessionCheckKnobs } from "@mark1russell7/service/http-client";
import { LINUX_66, given, seconds } from "./catalog.ts";
import { CHART_READINESS, DESIGN, DESIGN_REDIS, PROPAGATION, T07_WORKLOAD, WORKERS, kubeDefaults, ms, s, say } from "./kind.ts";

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
 *
 * The fourth incident is a failed prober, as a false failure. The flag fails only the readiness
 * check of the target, and its route still serves (`serves` of the trigger). The cells measure the
 * false removal of a replica that can serve, and the requests that fail because of it.
 *
 * The fifth incident is a black-holed shared dependency. The server has Redis, and its round trip
 * gates readiness (`DESIGN_REDIS`). A black hole comes between Redis and each replica for
 * `DEPENDENCY_HOLD`. No replica can serve, thus no candidate can route around the fault. The cells
 * measure when the Service is empty, when the callers get fast failures, and when they recover.
 *
 * The sixth incident is a flapping dependency: the black hole of the fifth incident comes
 * `FLAP_FAULTS` times in one run. `FLAP_REST` is the time from each heal to the next fault (`FLAPS`
 * of the trigger). The cells measure the same times in each fault, and if the Service comes back between two faults.
 *
 * The seventh incident is a lost zone. The cluster has two zones, and the node of the target is the
 * only node of the lost zone. For `ZONE_HOLD`, each packet on its link drops, and its cgroup is frozen.
 * The node lifecycle controller removes the target, and no client is in the lost zone. The cells
 * measure the removal, the failed requests, and the return of the target after the heal.
 *
 * The eighth incident is a slow dependency, a gray failure. Each packet that Redis sends waits
 * `SLOW_DELAY` for `SLOW_HOLD`, thus each replica serves each request that much later. No check
 * fails, thus each replica stays ready. The cells measure the failed requests, and that no replica
 * leaves the Service.
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

/**
 * These are the incidents of the S2 cells. The target cannot serve, a black hole partitions it from
 * the clients, or its event loop stalls. In a false failure, its readiness check fails while it can serve.
 * In a shared dependency, a black hole comes between Redis and each replica. In a flapping
 * dependency, that black hole comes and goes `FLAP_FAULTS` times in one run. In a lost zone, the node
 * of the target is lost for the hold.
 */
export type CallerFault = "cannot serve" | "partition" | "stall" | "false failure" | "shared dependency" | "flapping dependency" | "lost zone" | "slow dependency";

/** These are the incidents in their sequence: the cells of "cannot serve" come first. */
export const CALLER_FAULTS: readonly CallerFault[] = ["cannot serve", "partition", "stall", "false failure", "shared dependency", "flapping dependency", "lost zone", "slow dependency"];

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
 * the chance `COVER` at the least. A lost zone has fewer clients (`clients`): no client is in the lost zone.
 */
export const targetConnections = (mode: KubeProxyMode, each: number = CONNECTIONS, clients: number = CLIENTS): Connections => {
  const total = clients * each;
  if (SELECTION[mode] === "in turn")
    return { lo: connections(clients * Math.floor(each / REPLICAS)), hi: connections(clients * Math.ceil(each / REPLICAS)), of: connections(total) };
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
  if (fault === "false failure") return falseOf(mode, candidate).expected;
  if (fault === "shared dependency") return dependencyOf(mode, candidate).expected;
  if (fault === "flapping dependency") return flappingOf(mode, candidate).expected;
  if (fault === "lost zone") return lostZoneOf(mode, candidate).expected;
  if (fault === "slow dependency") return slowOf(mode, candidate).expected;
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
const checkedOf = (mode: KubeProxyMode, workload: Workload, start: Band, silence: Silence, clients: number = CLIENTS): PartitionPrediction => {
  const { stays } = silence;
  const quiet = valueIn(SESSION_CHECK.keepalive_time, "s");
  const answer = valueIn(SESSION_CHECK.keepalive_timeout, "s");
  const every = valueIn(workload.every, "s");
  const turn = every * (workload.connections ?? 1);
  const on = targetConnections(mode, 1, clients);
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
      expected: { lo: requests(clients * node.lo * streams.first.lo), hi: requests(clients * node.hi * streams.first.hi), connections: on },
      start,
      end: { lo: s(0), hi: time(first.hi) },
      why: `${check}. IPVS selects in turn on each node, thus the new session goes to the other replica. ${on.lo.value}–${on.hi.value} of the ${on.of.value} sessions are on the target, thus about ${clients * node.lo * streams.first.lo}–${clients * node.hi * streams.first.hi} requests fail`,
    };
  }
  const total = clients;
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
const picksOf = (mode: KubeProxyMode, candidate: Candidate, silence: Silence, clients: number = CLIENTS): PartitionPrediction => {
  const workload = workloadOf(candidate);
  const window = learnWindow(declarationOf(candidate), CHART_READINESS, PROPAGATION[mode], workload);
  const turn = valueIn(window.turn, "s");
  const each = workload.connections ?? 1;
  const on = targetConnections(mode, each, clients);
  const total = clients * each;
  const start = { lo: s(0), hi: time(turn) };
  const same = candidate === "in band (lame duck)" ? ". The lame duck never starts, thus B is the same as A" : "";
  const picks = `${silence.stays}${same}. Each connection on the target fails one request at its timeout (${say(workload.timeout)}). Then a new connection picks a backend, one turn (${say(window.turn)}) later`;
  if (SELECTION[mode] === "in turn") {
    const node = inTurn(each);
    return {
      expected: { lo: requests(clients * node.lo), hi: requests(clients * node.hi), connections: on },
      start,
      end: { lo: s(0), hi: time(node.rounds * turn) },
      outcomes: ["timeout"],
      why: `${picks}. IPVS selects in turn on each node, thus each node fails ${node.lo}–${node.hi} requests in ${node.rounds} turns at the most. About ${clients * node.lo}–${clients * node.hi} requests fail`,
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
 * This function gives the first retransmission of a session that crosses the heal of a black hole,
 * in seconds after the fault. The chain of the server starts at its last answer. The chain of the
 * client starts one RTO before its first stream after the fault. The stall of each chain is from its
 * start to the heal. It throws if the hold lets more than one firing be the first after the heal.
 */
const crossingOf = (hold: Quantity, lead: Band, turn: number): { readonly firing: number; readonly crosses: { readonly lo: number; readonly hi: number } } => {
  const rto = seconds(timerOf(LINUX_TCP, "retransmit", KIND_TCP, 0).duration, "the RTO of a kind node");
  const through = (end: number): Recovery => {
    const after = recovery(LINUX_TCP, "retransmit", KIND_TCP, s(end));
    if ("unknown" in after) throw new Error(`the retransmissions through a stall of ${end} s: ${after.unknown}`);
    return after;
  };
  const held = valueIn(hold, "s");
  const early = through(held + valueIn(lead.lo, "s") - turn);
  const late = through(held + valueIn(lead.hi, "s") + turn + rto);
  const firing = early.first[0];
  if (firing === undefined || early.first.length !== 1 || late.first.length !== 1 || firing !== late.first[0])
    throw new Error(`the hold ${say(hold)} lets more than one firing be the first after the heal: ${early.first.join(", ")} and ${late.first.join(", ")}`);
  return { firing, crosses: { lo: valueIn(early.low, "s") - turn - rto, hi: valueIn(late.high, "s") + turn } };
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
  const stays = `The kubelet probes the target from its node, thus its readiness and its endpoint stay for the hold (${say(PARTITION_HOLD)})`;
  const silence: Silence = { stays, next: "its SYN gets no answer. The check finds no SETTINGS frame", removal: null };
  if (candidate === "in band on HTTP/2 with a session check") return checkedOf(mode, workload, { lo: s(0), hi: time(valueIn(workload.every, "s")) }, silence);
  if (!onHttp2(candidate)) return picksOf(mode, candidate, silence);
  const { firing, crosses } = crossingOf(PARTITION_HOLD, HEAL_LEAD, turn);
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

/** This is the prediction of a candidate in a false failure: the expected failures, their window, the false removal, and the reason. */
export interface FalsePrediction {
  readonly expected: Expected;
  /** This band is the first failed request, from the fault. */
  readonly start: Band;
  /** This band is the last failed request, from its reference: the fault, or the heal for A. */
  readonly end: { readonly from: "fault" | "heal"; readonly band: Band };
  /** This band is the false removal of the target from the EndpointSlice and the rules, from the fault. */
  readonly removal: Band;
  readonly why: string;
}

/**
 * This function gives the prediction of a candidate in a false failure of the target. The flag fails
 * only the readiness check, and the route still serves. Thus no request fails before the latch of
 * the check trips. Then the controller of the service is not ready, and the service refuses each
 * request with a 503. The kubelet and the propagation remove the target (`removalBand`): a false removal.
 * - A: each connection on the target stays open. Thus each request on it fails from the trip until
 *   the readiness of the service recovers after the heal.
 * - B, C and D: each refusal closes its connection, and the next connection picks a backend. A chain
 *   of picks of the target ends at the first pick of the other replica, as in a partition. The
 *   target answers at once, thus the session check of D closes no session, and D is the same as C.
 */
export const falseOf = (mode: KubeProxyMode, candidate: Candidate): FalsePrediction => {
  const workload = workloadOf(candidate);
  const propagation = PROPAGATION[mode];
  const window = learnWindow(declarationOf(candidate), CHART_READINESS, propagation, workload);
  const turn = valueIn(window.turn, "s");
  const latch = { lo: valueIn(window.latch.lo, "s"), hi: valueIn(window.latch.hi, "s") };
  const removal = removalBand(window.latch, CHART_READINESS, propagation);
  const removed = { lo: valueIn(removal.lo, "s"), hi: valueIn(removal.hi, "s") };
  const each = workload.connections ?? 1;
  const on = targetConnections(mode, each);
  const start = { lo: time(latch.lo), hi: time(latch.hi + turn) };
  const leaves = { lo: time(removed.lo), hi: time(removed.hi) };
  const serves = `The readiness check of the target fails for the hold (${say(CANNOT_SERVE_HOLD)}), but its route still serves. Its latch trips ${say(window.latch.lo)}–${say(window.latch.hi)} after the fault. Then the controller of the service is not ready, thus the service refuses each request with a 503. The kubelet and the propagation (${propagation.from}) remove the target ${say(leaves.lo)}–${say(leaves.hi)} after the fault: a false removal`;
  if (!inBand(candidate)) {
    const hold = valueIn(CANNOT_SERVE_HOLD, "s");
    const [few, many] = [on.lo.value / turn, on.hi.value / turn];
    const expected = { lo: requests(few * (hold - latch.hi)), hi: requests(many * (hold - latch.lo + valueIn(window.end.band.hi, "s"))), connections: on };
    return {
      expected,
      start,
      end: { from: "heal", band: window.end.band },
      removal: leaves,
      why: `${serves}. Each connection to the target stays open, and the rules select a backend only for a new connection. Thus each request on those connections fails from the trip until the readiness of the service recovers, up to ${say(window.end.band.hi)} after the heal. ${on.lo.value}–${on.hi.value} of the ${on.of.value} connections are on the target, thus about ${expected.lo.value}–${expected.hi.value} requests fail`,
    };
  }
  const checks = candidate === "in band on HTTP/2 with a session check" ? ". The target answers each stream at once, thus the session check closes no session, and D is the same as C" : "";
  const closes = `${serves}. Each refusal closes its connection${onHttp2(candidate) ? " with a GOAWAY on its session" : ""}, and the next request opens a new connection one turn (${say(window.turn)}) later. A chain of picks of the target ends at the first pick of the other replica${checks}`;
  // the last failure of a chain starts one turn after its last pick, and the removal ends each chain
  const ends = (rounds: number): Band => ({ lo: time(latch.lo), hi: time(Math.min(latch.hi + rounds * turn, removed.hi + turn)) });
  if (SELECTION[mode] === "in turn") {
    const node = inTurn(each);
    const expected = { lo: requests(CLIENTS * node.lo), hi: requests(CLIENTS * node.hi), connections: on };
    return {
      expected,
      start,
      end: { from: "fault", band: ends(node.rounds) },
      removal: leaves,
      why: `${closes}. IPVS selects in turn on each node, thus each node fails ${node.lo}–${node.hi} requests in ${node.rounds} turns at the most. About ${expected.lo.value}–${expected.hi.value} requests fail`,
    };
  }
  const total = CLIENTS * each;
  const picks = negativeBinomial(total, 1 - 1 / REPLICAS);
  const chain = chainOf(total);
  const expected = { lo: requests(picks.lo), hi: requests(picks.hi), connections: on };
  return {
    expected,
    start,
    end: { from: "fault", band: ends(chain) },
    removal: leaves,
    why: `${closes}. Each pick goes to the target at random, thus the failures of the ${total} connections are negative binomial: ${picks.lo}–${picks.hi} in ${COVER * 100} % of the runs. A chain longer than ${chain} picks has a chance of ${CHAIN_RISK} at the most`,
  };
};

/**
 * This time is how long Redis stays black-holed for each replica. It has two bounds:
 * - It is longer than the latest removal of both replicas (26.309 s in IPVS), thus the Service is
 *   empty in the hold.
 * - The client of Redis closes its connection at least 3 s after the fault (`driver_writeoff_time`).
 *   Its retry window of 30 s starts at its first try to connect again. Each try before the heal ends
 *   by the heal and one `connect_bound`, 30 s after the fault at the latest. Thus the client connects
 *   again in its retry window.
 */
export const DEPENDENCY_HOLD = s(27);

/** This time is the most that the interval timer of a client fires late, on a quiet loop. Node reads its clock in whole milliseconds. */
const FIRING_LATE = ms(1);

/** This function gives the declaration of a candidate in a shared dependency: its settings on the design with Redis, and no flag. */
const dependencyDeclarationOf = (candidate: Candidate): Declaration => ({ ...declarationOf(candidate), flag: null, redis: DESIGN_REDIS.redis });

/**
 * This is the prediction of a candidate in a shared dependency. It has the expected failures, their
 * window, the empty Service, the last slow failure, and the reason.
 */
export interface DependencyPrediction {
  readonly expected: Expected;
  /** This band is the first failed request, from the fault. */
  readonly start: Band;
  /** This band is the last failed request, from the heal. */
  readonly end: Band;
  /** This band is the empty Service: no ready endpoint in the EndpointSlice, and no backend in the rules, from the fault. */
  readonly removal: Band;
  /** This band is the start of the last slow failure before the heal, from the fault. After it, each failure is fast. */
  readonly knows: Band;
  readonly why: string;
}

/**
 * This function gives the prediction of a candidate in a black-holed shared dependency. Each request
 * needs Redis, thus each request fails from the fault until the callers recover after the heal.
 * - Before the readiness latch of a replica trips, each request waits for Redis and fails slowly.
 *   After the trip, the controller is not ready, and the service refuses each request at once.
 * - The kubelet and the propagation remove both replicas (`removalBand`): the Service is empty.
 * - A: each connection stays open, thus A recovers when the readiness of the service recovers.
 * - B, C and D: the lame duck closes each connection, and the empty Service refuses each new one.
 *   Thus they recover only when the kubelet and the propagation add the replicas again.
 */
export const dependencyOf = (mode: KubeProxyMode, candidate: Candidate): DependencyPrediction => {
  const workload = workloadOf(candidate);
  const declaration = dependencyDeclarationOf(candidate);
  const knobs = declaration.redis!.knobs;
  const propagation = PROPAGATION[mode];
  const every = valueIn(workload.every, "s");
  const timeout = valueIn(workload.timeout, "s");
  const turn = every * (workload.connections ?? 1);
  const hold = valueIn(DEPENDENCY_HOLD, "s");
  const latch = latchBand(declaration.readiness, declaration.poll, "silent", knobs.request_timeout);
  const trip = { lo: valueIn(latch.lo, "s"), hi: valueIn(latch.hi, "s") };
  const removal = removalBand(latch, CHART_READINESS, propagation);
  const removed = { lo: valueIn(removal.lo, "s"), hi: valueIn(removal.hi, "s") };
  if (removed.hi >= hold) throw new Error(`the hold ${say(DEPENDENCY_HOLD)} ends before the latest removal (${removed.hi} s)`);
  // a try at the heal ends at connect_bound, and the next try comes after the backoff: the cap, and a jitter up to the base
  const reconnect = valueIn(knobs.connect_bound, "s") + valueIn(knobs.retry_cap, "s") + valueIn(knobs.retry_base, "s");
  const tries = hold + valueIn(HEAL_LEAD.hi, "s") + valueIn(knobs.connect_bound, "s");
  const finite = (extent: Extent): number => {
    if (isUnbounded(extent)) throw new Error("the client of Redis has an unbounded retry knob");
    return valueIn(extent, "s");
  };
  if (tries - finite(knobs.driver_writeoff_time) >= finite(knobs.client_retry_window))
    throw new Error(`the retry window of the client of Redis can end before its try ${tries} s after the fault`);
  const recover = valueIn(recoverSpan(declaration.readiness, declaration.poll).max, "s");
  // the kubelet finds a ready replica at its next probe: one success, in one period at the most
  const kubelet = valueIn(kubeletBand({ ...CHART_READINESS, threshold: 1 }, false).hi, "s");
  const spread = valueIn(propagation.hi, "s");
  const endHi = inBand(candidate) ? reconnect + recover + kubelet + spread + turn : reconnect + recover + turn;
  const end = { lo: s(0), hi: time(endHi) };
  // each request from the fault to the last failure fails. The timer fires up to FIRING_LATE late, thus a run can send fewer
  const late = valueIn(FIRING_LATE, "s");
  const span = { lo: hold + valueIn(HEAL_LEAD.lo, "s"), hi: hold + valueIn(HEAL_LEAD.hi, "s") + endHi };
  const of = (length: number, gap: number): number => Math.round((length / gap) * 1e6) / 1e6;
  const total = CLIENTS * (workload.connections ?? 1);
  const expected = {
    lo: requests(CLIENTS * (Math.floor(of(span.lo, every + late)) - 1)),
    hi: requests(CLIENTS * (Math.ceil(of(span.hi, every)) + 1)),
    connections: { lo: connections(total), hi: connections(total), of: connections(total) },
  };
  // a request that waits behind a slow one on a connection of HTTP/1.1 can start up to one timeout after the trip
  const knows = { lo: time(trip.lo - every), hi: time(trip.hi + timeout) };
  const fails = `Redis is black-holed for each replica for the hold (${say(DEPENDENCY_HOLD)}). Each request needs Redis, thus each request fails from the fault until the callers recover. Before the readiness latch of a replica trips (${say(latch.lo)}–${say(latch.hi)}), each request on it waits for Redis and fails slowly. Then its controller is not ready, and the service refuses each request at once with a 503. The kubelet and the propagation (${propagation.from}) remove both replicas ${say(removal.lo)}–${say(removal.hi)} after the fault. Then the Service is empty, and its rules refuse each new connection`;
  const back = `After the heal, the client of Redis connects again in ${say(time(reconnect))} at the most, and the readiness of the service recovers up to ${say(time(recover))} later`;
  const about = `Each client sends a request each ${say(workload.every)}, thus about ${expected.lo.value}–${expected.hi.value} requests fail`;
  const sameAsC = candidate === "in band on HTTP/2 with a session check" ? ". A stream timeout before the trip closes its session, and the next stream opens a new one. Thus D is the same as C" : "";
  const why = inBand(candidate)
    ? `${fails}. The lame duck closes each connection after the trip${onHttp2(candidate) ? " with a GOAWAY on its session" : ""}, thus each next request opens a new connection, and the empty Service refuses it. ${back}. The kubelet then finds a replica ready in ${say(time(kubelet))} at the most, and the propagation adds it to the rules. ${about}${sameAsC}`
    : `${fails}. Each connection of A stays open on its replica, thus it gets the 503 of the service and no refusal. ${back}. Then A succeeds on its open connections, before the endpoints come back. ${about}`;
  return { expected, start: { lo: s(0), hi: time(every) }, end, removal: { lo: time(removed.lo), hi: time(removed.hi) }, knows, why };
};

/**
 * This count is the faults of a flapping dependency in one run: the first fault, and two flaps. Three
 * faults give two rests, thus each fault after the first one comes after a full recovery.
 */
export const FLAP_FAULTS = 3;

/** This time is how long Redis stays black-holed in each fault of a flapping dependency: the hold of the black-holed shared dependency. */
export const FLAP_HOLD = DEPENDENCY_HOLD;

/**
 * This time is the rest of a flapping dependency: from the heal of one fault to the next fault. It has
 * two bounds:
 * - It is longer than the latest recovery after a heal (`flappingOf`), thus the Service has its
 *   replicas, and the callers succeed, before the next fault.
 * - It is longer than a period of the readiness debounce (5 s), of the poll (5 s ±20 %) and of the
 *   kubelet probe (2 s). One success resets each of them, thus each fault starts from a steady state.
 */
export const FLAP_REST = s(15);

/** These are the flaps of the trigger: each fault after the first one, with its rest and its hold. */
export const FLAPS: readonly Flap[] = Array.from({ length: FLAP_FAULTS - 1 }, () => ({ rest: FLAP_REST, hold: FLAP_HOLD }));

/**
 * This band is the heal of a black hole on Redis after its hold, from its fault. The runner sleeps for
 * the hold from the stamp of the first inject, thus the heal comes no earlier. The inject of the other
 * replica comes after that stamp. In the kind run 40430856093, the heal came 0.105 s–0.186 s after the
 * hold, in 60 runs. Thus the band is 0 s–0.5 s. `HEAL_LEAD` is the lead of the injector of a partition.
 */
export const REDIS_HEAL_LEAD = { lo: s(0), hi: s(0.5) };

/**
 * This is the prediction of a candidate in a flapping dependency. Each band is for one fault, from
 * the fault or the heal of that fault. `each` is the failed requests of one fault, and `expected` is
 * the failed requests of the run.
 */
export interface FlappingPrediction extends DependencyPrediction {
  readonly each: Expected;
}

/**
 * This function gives the prediction of a candidate in a flapping dependency. It is the black hole
 * of a shared dependency, `FLAP_FAULTS` times, with `FLAP_REST` from a heal to the next fault. Each
 * fault is the same as the first one, because each recovery ends before the next fault. The kind run
 * 40430856093 of the black-holed shared dependency gives three corrections to its bands:
 * - B, C and D: on the empty Service, each request waits for its connect, and fails at its timeout.
 *   Thus the slow failures go on until the heal.
 * - B, C and D: a request that waits for its connect succeeds when an endpoint comes back. Thus the
 *   last failure starts up to one timeout before the heal.
 * - The heal of Redis comes `REDIS_HEAL_LEAD` after the hold, not `HEAL_LEAD`.
 */
export const flappingOf = (mode: KubeProxyMode, candidate: Candidate): FlappingPrediction => {
  const one = dependencyOf(mode, candidate);
  const workload = workloadOf(candidate);
  const every = valueIn(workload.every, "s");
  const timeout = valueIn(workload.timeout, "s");
  const hold = valueIn(FLAP_HOLD, "s");
  const rest = valueIn(FLAP_REST, "s");
  const lead = { lo: valueIn(REDIS_HEAL_LEAD.lo, "s"), hi: valueIn(REDIS_HEAL_LEAD.hi, "s") };
  const removal = { lo: valueIn(one.removal.lo, "s"), hi: valueIn(one.removal.hi, "s") };
  if (removal.hi >= hold) throw new Error(`the hold ${say(FLAP_HOLD)} ends before the latest removal (${removal.hi} s)`);
  const endHi = valueIn(one.end.hi, "s");
  // a request that waits for its connect on the empty Service succeeds when an endpoint comes back
  const endLo = inBand(candidate) ? -timeout : 0;
  // the last request of a recovery ends before the next fault
  if (endHi + timeout >= rest) throw new Error(`the rest ${say(FLAP_REST)} ends before the latest recovery (${endHi + timeout} s)`);
  const late = valueIn(FIRING_LATE, "s");
  const span = { lo: hold + lead.lo + endLo, hi: hold + lead.hi + endHi };
  const of = (length: number, gap: number): number => Math.round((length / gap) * 1e6) / 1e6;
  const per = { lo: CLIENTS * (Math.floor(of(span.lo, every + late)) - 1), hi: CLIENTS * (Math.ceil(of(span.hi, every)) + 1) };
  const each = { lo: requests(per.lo), hi: requests(per.hi), connections: one.expected.connections };
  const expected = { lo: requests(FLAP_FAULTS * per.lo), hi: requests(FLAP_FAULTS * per.hi), connections: one.expected.connections };
  const end = { lo: time(endLo), hi: one.end.hi };
  // B, C and D: the last slow failure starts in the last timeout before the heal. A: at the trip of the latch
  const knows = inBand(candidate) ? { lo: time(hold + lead.lo - timeout - every), hi: time(hold + lead.hi) } : one.knows;
  const flaps = `Redis is black-holed ${FLAP_FAULTS} times for ${say(FLAP_HOLD)}, with a rest of ${say(FLAP_REST)} from each heal to the next fault. The heal comes ${say(REDIS_HEAL_LEAD.lo)}–${say(REDIS_HEAL_LEAD.hi)} after the hold. Each request needs Redis, thus each request fails from each fault until the callers recover`;
  const removed = `The kubelet and the propagation remove both replicas ${say(one.removal.lo)}–${say(one.removal.hi)} after each fault, thus the Service is empty in each fault`;
  const back = `Each recovery ends before the next fault. One success resets the readiness debounce, the kubelet probe and the retry window of the client of Redis. Thus each fault is the same as the first one`;
  const about = `Each client sends a request each ${say(workload.every)}, thus approximately ${per.lo}–${per.hi} requests fail in each fault, and ${expected.lo.value}–${expected.hi.value} in the run`;
  const why = inBand(candidate)
    ? `${flaps}. ${removed}. On the empty Service, each request waits for its connect, and it fails at the timeout of ${say(workload.timeout)}. Thus the slow failures go on until the heal. A request that waits for its connect succeeds when an endpoint comes back. Thus the last failure starts up to ${say(workload.timeout)} before the heal, and up to ${say(one.end.hi)} after it. ${back}. ${about}`
    : `${flaps}. Each connection of A stays open on its replica, thus it gets the 503 of the service at the trip of the latch, and no refusal. ${removed}. A succeeds on its open connections when the readiness of the service recovers, up to ${say(one.end.hi)} after the heal. ${back}. ${about}`;
  return { expected, each, start: one.start, end, removal: one.removal, knows, why };
};

/**
 * This time is how long the zone stays lost. It has three bounds:
 * - It is longer than the latest removal of the target (55.559 s in IPVS). Thus the node lifecycle
 *   controller removes the target in the hold.
 * - It is shorter than the toleration of a pod for a node that is not ready or unreachable (300 s,
 *   `DefaultTolerationSeconds`). Thus no pod is evicted.
 * - The heal comes between the eighth retransmission (51 s) and the ninth (102.2 s), with a margin on
 *   each side. Thus the end of C has one band.
 */
export const ZONE_HOLD = s(70);

/**
 * This band is the heal after the hold, from the fault. The runner sleeps for the hold from the
 * fault. Then the agent thaws the node and stamps the heal, with no lead of the injector. Its commands
 * take up to 2 s.
 */
export const ZONE_HEAL_LEAD = { lo: s(0), hi: s(2) };

/** This count is the clients of a lost zone: one on each node of the kept zone. No client is in the lost zone. */
export const ZONE_CLIENTS = CLIENTS - 1;

/** This is the prediction of a candidate in a lost zone: the prediction of a silence, the removal of the target, and its return. */
export interface ZonePrediction extends PartitionPrediction {
  /** This band is the removal of the target from the rules of each kept node, from the fault. */
  readonly removal: Band;
  /** This band is the return of the target to its EndpointSlice as ready, from the heal. */
  readonly returns: Band;
}

/**
 * This function gives the prediction of a candidate in a lost zone. The node of the target is lost:
 * each packet on its link drops, and its cgroup is frozen, thus its kubelet stops too. Its lease
 * expires, and the node lifecycle controller marks the target not ready (`nodeLossBand`). No client is
 * in the lost zone, and the service of the target sends no signal in band.
 * - A and B: the arithmetic of a partition (`picksOf`), with the clients of the kept zone. The last
 *   pick of a chain comes before the earliest removal, thus the removal changes nothing.
 * - C: the session stays on the target, and each stream fails at its timeout. The first
 *   retransmission after the heal crosses, as in a partition. If the target had no unacked data, its
 *   GOAWAY at the thaw ends C near the heal. Thus the end band starts one timeout before the heal.
 * - D: the arithmetic of a partition (`checkedOf`), and the removal ends each chain.
 */
export const lostZoneOf = (mode: KubeProxyMode, candidate: Candidate): ZonePrediction => {
  const workload = workloadOf(candidate);
  const every = valueIn(workload.every, "s");
  const timeout = valueIn(workload.timeout, "s");
  const removal = nodeLossBand(NODE_LIFECYCLE, PROPAGATION[mode]);
  const returns = nodeReturnBand(NODE_LIFECYCLE);
  const removed = { lo: valueIn(removal.lo, "s"), hi: valueIn(removal.hi, "s") };
  const stays = `The node of the target is lost for the hold (${say(ZONE_HOLD)}). Each packet on its link drops, and its kubelet is frozen. Its lease expires, thus the node lifecycle controller marks the target not ready, and it leaves the rules ${say(removal.lo)}–${say(removal.hi)} after the fault. No client is in the lost zone`;
  const silence: Silence = { stays, next: "its SYN gets no answer. The check finds no SETTINGS frame", removal: removed.hi };
  if (candidate === "in band on HTTP/2 with a session check") return { ...checkedOf(mode, workload, { lo: s(0), hi: time(every) }, silence, ZONE_CLIENTS), removal, returns };
  if (!onHttp2(candidate)) {
    const picks = picksOf(mode, candidate, silence, ZONE_CLIENTS);
    const turn = every * (workload.connections ?? 1);
    // the last failed request picked its connection at the timeout of the request one turn before it
    const lastPick = valueIn(picks.end.hi, "s") - turn + timeout;
    if (lastPick >= removed.lo) throw new Error(`the last pick of a chain comes ${lastPick} s after the fault, after the earliest removal (${removed.lo} s)`);
    return { ...picks, removal, returns, why: `${picks.why}. The last pick of a chain comes ${say(time(lastPick))} after the fault at the latest, before the removal. Thus the removal changes nothing` };
  }
  // C: the established flow keeps the session on the target until the first retransmission after the heal crosses
  const on = targetConnections(mode, 1, ZONE_CLIENTS);
  const { firing, crosses } = crossingOf(ZONE_HOLD, ZONE_HEAL_LEAD, every);
  const heal = valueIn(ZONE_HOLD, "s") + valueIn(ZONE_HEAL_LEAD.lo, "s");
  const end = { lo: time(heal - timeout - every), hi: time(crosses.hi) };
  // a count rounded to six places, as in a stall
  const of = (span: number): number => Math.round((span / every) * 1e6) / 1e6;
  const expected = { lo: requests(on.lo.value * of(valueIn(end.lo, "s"))), hi: requests(on.hi.value * of(crosses.hi)), connections: on };
  return {
    expected,
    start: { lo: s(0), hi: time(every) },
    end,
    removal,
    returns,
    why: `${stays}. The established flow keeps the session of a client on the target after the removal. Each stream on it fails at its timeout (${say(workload.timeout)}). TCP retransmits with a backoff, and firing ${firing} of the timer is the first after the heal: ${say(time(crosses.lo))}–${say(time(crosses.hi))} after the fault. Then the target resets the session, or it sends GOAWAY, and the client opens a new session. If the target had no unacked data, its GOAWAY at the thaw ends the failures near the heal. Thus the last failure starts ${say(end.lo)} after the fault at the earliest. ${on.lo.value}–${on.hi.value} of the ${on.of.value} sessions are on the target, thus about ${expected.lo.value}–${expected.hi.value} requests fail`,
  };
};

/**
 * This time is how long each packet that Redis sends waits in a slow dependency. It has three bounds:
 * - It is longer than the turn of a connection of HTTP/1.1 (8 × 20 ms = 160 ms). Thus a connection of A
 *   or B gets its next request before it has the answer to the last one, and its queue grows.
 * - It is shorter than the `keepalive_time` of the session check of D (0.5 s). Thus each session of
 *   D hears a frame in each tick, and it sends no PING.
 * - It is shorter than each bound of a check. The bounds are the `heartbeat_timeout` of the Redis
 *   client (1 s), the round-trip check (2 s) and the readiness probe of Redis (1 s). Thus each check
 *   passes, and no replica leaves the Service.
 */
export const SLOW_DELAY = ms(300);

/** This time is how long Redis stays slow: the hold of the black-holed shared dependency, thus the two incidents have the same length. */
export const SLOW_HOLD = DEPENDENCY_HOLD;

/**
 * This time is the most that a request takes on a replica, apart from the delay of Redis. It has
 * the path from the client, the service, and the command of Redis. In kind it is a few milliseconds.
 */
const SLOW_REST = ms(100);

/**
 * This time is the most from the stamp of the heal to the instant that the delay is zero. It has the
 * start of `tc` in the injector, and its change of the qdisc.
 */
const SLOW_HEAL_EFFECT = ms(100);

/**
 * This is the prediction of a candidate in a slow dependency. `fails` tells that each request fails
 * from the start band to the end band. With no failure, the bands are null.
 */
export interface SlowPrediction {
  readonly expected: Expected;
  readonly fails: boolean;
  /** This band is the first failed request, from the fault. */
  readonly start: Band | null;
  /** This band is the last failed request, from the heal. */
  readonly end: Band | null;
  readonly why: string;
}

/**
 * This function gives the prediction of a candidate in a slow dependency. Each request waits for
 * one command of Redis, thus each request takes `SLOW_DELAY` longer. No check fails, thus no
 * replica leaves the Service, and no candidate learns.
 * - A and B: each connection of HTTP/1.1 carries one request at a time, and each one gets the next
 *   request each turn (160 ms). A request takes longer than a turn, thus the queue of each connection
 *   grows. With S the time of one request, request j waits j × (S − turn) for its start. The first
 *   request whose time is above the timeout fails. After it, each request in the queue is older than
 *   the timeout less one turn at its start, thus each one fails. A timeout ends its connection, and the
 *   next connection goes to a replica that is as slow. The lame duck of B does not fire, thus B is A.
 * - After the heal, a request that starts gets its answer at once. The last failure is the request
 *   that started before the delay was zero: it is one timeout less one turn older than its start.
 * - C and D: each stream of a session waits for Redis on its own, thus no stream waits for another
 *   one. Each stream takes `SLOW_DELAY` and some milliseconds, far below the timeout. No request fails.
 */
export const slowOf = (mode: KubeProxyMode, candidate: Candidate): SlowPrediction => {
  // the mode does not change the prediction: no replica leaves the rules of a node
  void mode;
  const workload = workloadOf(candidate);
  const every = valueIn(workload.every, "s");
  const timeout = valueIn(workload.timeout, "s");
  const delay = valueIn(SLOW_DELAY, "s");
  const total = CLIENTS * (workload.connections ?? 1);
  const slow = `Each packet that Redis sends waits ${say(SLOW_DELAY)} for the hold (${say(SLOW_HOLD)}), thus each request takes ${say(SLOW_DELAY)} longer. Each check of Redis and each probe passes in that time, thus each replica stays ready, and no candidate learns`;
  if (onHttp2(candidate)) {
    const none = { lo: requests(0), hi: requests(0), connections: { lo: connections(0), hi: connections(0), of: connections(total) } };
    const sameAsC = candidate === "in band on HTTP/2 with a session check" ? ` The session check ticks each ${say(SESSION_CHECK.keepalive_time)}, longer than the delay, thus each session hears a frame in each tick. D is the same as C` : "";
    return {
      expected: none,
      fails: false,
      start: null,
      end: null,
      why: `${slow}. Each client sends its streams on one session, and each stream waits for Redis on its own. Each stream takes ${say(SLOW_DELAY)} and some milliseconds, far below the timeout of ${say(workload.timeout)}. Thus no request fails.${sameAsC}`,
    };
  }
  const turn = every * (workload.connections ?? 1);
  if (delay <= turn) throw new Error(`the delay ${say(SLOW_DELAY)} is not longer than the turn of a connection (${turn} s)`);
  const rest = valueIn(SLOW_REST, "s");
  // request j of a connection takes S + j × (S − turn): the first above the timeout fails
  const first = (each: number): number => Math.floor((timeout - each) / (each - turn)) + 1;
  const [early, late] = [first(delay + rest), first(delay)];
  // the request in flight at the fault can wait for the delay too, thus the first failure can come one turn earlier
  const start = { lo: time(Math.max(0, (early - 1) * turn)), hi: time((late + 1) * turn) };
  // the last failure started before the delay was zero, one timeout less one turn before its own start
  const end = { lo: time(-timeout - every), hi: time(-timeout + turn + valueIn(SLOW_HEAL_EFFECT, "s")) };
  const lead = { lo: valueIn(REDIS_HEAL_LEAD.lo, "s"), hi: valueIn(REDIS_HEAL_LEAD.hi, "s") };
  const hold = valueIn(SLOW_HOLD, "s");
  const span = { lo: hold + lead.lo + valueIn(end.lo, "s") - valueIn(start.hi, "s"), hi: hold + lead.hi + valueIn(end.hi, "s") - valueIn(start.lo, "s") };
  // each connection gets one request each turn. The timer fires up to FIRING_LATE late, thus a run can send fewer
  const of = (length: number, gap: number): number => Math.round((length / gap) * 1e6) / 1e6;
  const fired = valueIn(FIRING_LATE, "s") * (workload.connections ?? 1);
  const expected = {
    lo: requests(total * Math.floor(of(span.lo, turn + fired))),
    hi: requests(total * (Math.ceil(of(span.hi, turn)) + 1)),
    connections: { lo: connections(total), hi: connections(total), of: connections(total) },
  };
  const lameDuck = inBand(candidate) ? ". The readiness of the service never fails, thus its lame duck never closes a connection, and B is A" : "";
  return {
    expected,
    fails: true,
    start,
    end,
    why: `${slow}. Each connection of HTTP/1.1 carries one request at a time, and it gets the next request each turn (${say(time(turn))}). A request takes longer than a turn, thus the queue of each connection grows. The first request above the timeout of ${say(workload.timeout)} starts ${say(start.lo)}–${say(start.hi)} after the fault. After it, each request in the queue fails at its timeout. A timeout ends its connection, and the next connection goes to a replica that is as slow. After the heal, each request that starts gets its answer at once. Thus the last failure starts ${say(end.lo)}–${say(end.hi)} after the heal${lameDuck}. Each of the ${total} connections fails each of its requests in that span, thus approximately ${expected.lo.value}–${expected.hi.value} requests fail`,
  };
};

/** These are the bytes of one PING frame of HTTP/2: a frame header of 9 bytes and 8 bytes of opaque data (RFC 9113, sections 4.1 and 6.7). Its ACK has the same size. */
export const PING_FRAME: Quantity = { value: 17, unit: "B" };

/**
 * This band is the count of PINGs that the session checks of the clients send in one counted run, in
 * `{ping}`. It is the sum over the clients, from the start of the run to its end. `why` gives the reason.
 */
export interface PingPrediction {
  readonly lo: Quantity;
  readonly hi: Quantity;
  readonly why: string;
}

const pings = (value: number): Quantity => ({ value, unit: "{ping}" });

/**
 * This function gives the prediction of the PINGs of a candidate in an incident. Only the session
 * check of D sends a PING. Its heartbeat ticks at each `keepalive_time` and sends one PING at a time.
 * A tick sends a PING only when the session heard no frame since the tick before it and has a stream
 * in flight. An ACK is not a frame that the check hears. Thus a busy session sends no PING, and a
 * quiet session sends one PING at each tick at the most.
 * - A pod that cannot serve, and a failed prober: each replica answers each stream at once. No PING.
 * - A partition: each session on the target sends one PING with no ACK, and the check closes it. A
 *   next session on the target does not connect, thus it sends no PING. A lost zone is the same, with
 *   the clients of the kept zone.
 * - A stall: each session on the target sends one PING with no ACK. A next session connects, and it
 *   sends one PING at its first tick, because the blocked loop sends no SETTINGS frame.
 * - A shared dependency: each stream waits for Redis until the latch trips, and the server answers
 *   each PING. Thus each session sends a PING at each tick with an ACK, until the trip.
 * - A slow dependency: each replica answers each stream after the delay of Redis, shorter than a
 *   tick. Thus each session hears a frame in each tick. No PING.
 */
export const pingsOf = (mode: KubeProxyMode, candidate: Candidate, fault: CallerFault): PingPrediction => {
  if (candidate !== "in band on HTTP/2 with a session check")
    return {
      lo: pings(0),
      hi: pings(0),
      why: onHttp2(candidate)
        ? "C has no session check, and node:http2 sends a PING only when its caller asks for one. Thus the clients of C send no PING"
        : "HTTP/1.1 has no PING frame, and the clients of this candidate have no other probe. Thus they send no PING",
    };
  const quiet = valueIn(SESSION_CHECK.keepalive_time, "s");
  const tick = `The check sends a PING only at a tick of ${say(SESSION_CHECK.keepalive_time)} with no frame since the tick before it, and with a stream in flight`;
  if (fault === "cannot serve" || fault === "false failure")
    return { lo: pings(0), hi: pings(0), why: `${tick}. Each replica answers each stream at once, thus each session hears a frame in each tick, and the clients send no PING` };
  if (fault === "slow dependency")
    return {
      lo: pings(0),
      hi: pings(0),
      why: `${tick}. Each replica answers each stream ${say(SLOW_DELAY)} late. A session gets a stream each ${say(MULTIPLEXED.every)}, thus the longest time with no frame is the delay, shorter than a tick. Thus the clients send no PING`,
    };
  if (fault === "partition" || fault === "lost zone") {
    // a lost zone has the arithmetic of a partition, with the clients of the kept zone
    const on = targetConnections(mode, 1, fault === "lost zone" ? ZONE_CLIENTS : CLIENTS);
    return {
      lo: pings(on.lo.value),
      hi: pings(on.hi.value),
      why: `${tick}. Each session on the target sends one PING, and it gets no ACK, thus the check closes the session. A next session on the target does not connect, thus it sends no PING. ${on.lo.value}–${on.hi.value} of the ${on.of.value} sessions are on the target, thus the clients send ${on.lo.value}–${on.hi.value} PINGs`,
    };
  }
  const on = targetConnections(mode, 1);
  if (fault === "stall") {
    const picks = SELECTION[mode] === "random" ? negativeBinomial(CLIENTS, 1 - 1 / REPLICAS) : { lo: on.lo.value, hi: on.hi.value };
    const how =
      SELECTION[mode] === "random"
        ? `The picks of the target are negative binomial: ${picks.lo}–${picks.hi} in ${COVER * 100} % of the runs`
        : `IPVS selects in turn, thus a next session goes to the other replica, and ${picks.lo}–${picks.hi} sessions are on the target`;
    return {
      lo: pings(picks.lo),
      hi: pings(picks.hi),
      why: `${tick}. Each session on the target sends one PING, and it gets no ACK, thus the check closes the session. A next session on the target connects, but the blocked loop sends no SETTINGS frame, thus it also sends one PING. ${how}`,
    };
  }
  const declaration = dependencyDeclarationOf(candidate);
  const latch = latchBand(declaration.readiness, declaration.poll, "silent", declaration.redis!.knobs.request_timeout);
  const workload = workloadOf(candidate);
  const turn = valueIn(workload.every, "s") * (workload.connections ?? 1);
  // one PING at each tick of a client from the fault to the trip, and one more for the tick of the session at the fault
  const each = Math.ceil(Math.round(((valueIn(latch.hi, "s") + turn) / quiet) * 1e6) / 1e6) + 1;
  // a flapping dependency: the same PINGs in each fault. In a rest, each replica answers each stream at once
  const faults = fault === "flapping dependency" ? FLAP_FAULTS : 1;
  const flaps = faults === 1 ? "" : `. The clients send these PINGs in each of the ${faults} faults. In a rest, each replica answers each stream at once, thus no session sends a PING`;
  return {
    lo: pings(faults * CLIENTS),
    hi: pings(faults * CLIENTS * each),
    why: `${tick}. Each stream waits for Redis until the latch trips (${say(latch.lo)}–${say(latch.hi)}), but the server answers each PING. Thus each session sends a PING at each tick, with an ACK. A stream timeout closes the session, and the first tick of the next session hears its SETTINGS. After the trip, each stream gets a 503 at once, and a session on the empty Service does not connect. The PINGs of a client are one tick apart at the least. Each client sends one PING before the trip at the least, and ${each} at the most${flaps}`,
  };
};

/** These are the incidents of a silent target: the words of the name of each cell, and its trigger. */
const SILENT: Readonly<Record<Exclude<CallerFault, "cannot serve" | "false failure" | "shared dependency" | "flapping dependency" | "lost zone" | "slow dependency">, { readonly what: string; readonly trigger: KindCell["trigger"]; readonly predict: typeof partitionOf }>> = {
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

/**
 * This function tells the incident of an S2 cell. A partition has the flag `partition` on its black
 * hole, and a stall is an `app-stall`. A black hole with no `partition` is on Redis: a shared
 * dependency. A false failure has the flag `serves` on its `cannot-serve`. A lost zone is a `zone-loss`,
 * and a slow dependency is a `latency`.
 */
export const callerFaultOf = (cell: KindCell): CallerFault =>
  cell.trigger.kind === "zone-loss"
    ? "lost zone"
    : cell.trigger.kind === "latency"
      ? "slow dependency"
    : cell.trigger.partition === true
    ? "partition"
    : cell.trigger.kind === "app-stall"
      ? "stall"
      : cell.trigger.kind === "blackhole"
        ? (cell.trigger.flaps ?? []).length > 0
          ? "flapping dependency"
          : "shared dependency"
        : cell.trigger.serves === true
          ? "false failure"
          : "cannot serve";

/** This function gives the cell of a candidate in a mode, for an incident. The cells of an incident share each setting but the trigger and the prediction. */
const cellOf = (mode: KubeProxyMode, candidate: Candidate, fault: CallerFault): KindCell => {
  const declaration = declarationOf(candidate);
  const workload = workloadOf(candidate);
  const pod = { ...kubeDefaults(2), readiness: CHART_READINESS };
  if (fault === "false failure") {
    const predicted = falseOf(mode, candidate);
    return {
      id: `S2.T07.${mode}.${SUFFIX[candidate]}.prober`,
      name: `T07 ${mode}, callers learn that a prober fails while the pod can serve: ${candidate}`,
      template: "T07",
      substitutes: null,
      mode,
      workers: WORKERS,
      trigger: { kind: "cannot-serve", hold: CANNOT_SERVE_HOLD, serves: true },
      pod,
      declaration,
      workload,
      prediction: {
        kind: "leaves",
        band: predicted.removal,
        window: {
          kind: "window",
          nodes: "all",
          start: { from: "fault", band: predicted.start },
          end: predicted.end,
          certain: predicted.expected.connections.lo.value > 0,
          outcomes: ["503"],
          why: predicted.why,
        },
        why: `The readiness check fails while the target can serve. The kubelet removes it ${say(predicted.removal.lo)}–${say(predicted.removal.hi)} after the fault: a false removal of each candidate`,
      },
      calibrates: false,
      runs: 3,
    };
  }
  if (fault === "shared dependency") {
    const predicted = dependencyOf(mode, candidate);
    return {
      id: `S2.T07.${mode}.${SUFFIX[candidate]}.dependency`,
      name: `T07 ${mode}, callers learn that a shared dependency is black-holed: ${candidate}`,
      template: "T07",
      substitutes: null,
      mode,
      workers: WORKERS,
      trigger: { kind: "blackhole", hold: DEPENDENCY_HOLD },
      pod,
      declaration: dependencyDeclarationOf(candidate),
      workload,
      prediction: {
        kind: "removal",
        band: predicted.removal,
        window: {
          kind: "window",
          nodes: "all",
          start: { from: "fault", band: predicted.start },
          end: { from: "heal", band: predicted.end },
          certain: true,
          why: predicted.why,
        },
        why: `The round trip of Redis gates the readiness of each replica, thus the Service is empty ${say(predicted.removal.lo)}–${say(predicted.removal.hi)} after the fault, for each candidate`,
      },
      calibrates: false,
      runs: 3,
    };
  }
  if (fault === "flapping dependency") {
    const predicted = flappingOf(mode, candidate);
    return {
      id: `S2.T07.${mode}.${SUFFIX[candidate]}.flapping`,
      name: `T07 ${mode}, callers learn that a shared dependency flaps: ${candidate}`,
      template: "T07",
      substitutes: null,
      mode,
      workers: WORKERS,
      trigger: { kind: "blackhole", hold: FLAP_HOLD, flaps: FLAPS },
      pod,
      declaration: dependencyDeclarationOf(candidate),
      workload,
      prediction: {
        kind: "removal",
        band: predicted.removal,
        flaps: true,
        window: {
          kind: "window",
          nodes: "all",
          start: { from: "fault", band: predicted.start },
          end: { from: "heal", band: predicted.end },
          certain: true,
          flaps: true,
          why: predicted.why,
        },
        why: `The round trip of Redis gates the readiness of each replica, thus the Service is empty ${say(predicted.removal.lo)}–${say(predicted.removal.hi)} after each of the ${FLAP_FAULTS} faults, for each candidate. It has its replicas again before the next fault`,
      },
      calibrates: false,
      runs: 3,
    };
  }
  if (fault === "lost zone") {
    const predicted = lostZoneOf(mode, candidate);
    return {
      id: `S2.T07.${mode}.${SUFFIX[candidate]}.zone`,
      name: `T07 ${mode}, callers learn that a zone is lost: ${candidate}`,
      template: "T07",
      substitutes: null,
      mode,
      workers: WORKERS,
      trigger: { kind: "zone-loss", hold: ZONE_HOLD },
      pod,
      declaration,
      workload,
      prediction: {
        kind: "leaves",
        band: predicted.removal,
        window: {
          kind: "window",
          nodes: "all",
          start: { from: "fault", band: predicted.start },
          end: { from: "fault", band: predicted.end },
          certain: predicted.expected.connections.lo.value > 0,
          ...(predicted.outcomes !== undefined ? { outcomes: predicted.outcomes } : {}),
          why: predicted.why,
        },
        why: `The lease of the lost node expires, thus the node lifecycle controller marks the target not ready. It leaves the rules of each kept node ${say(predicted.removal.lo)}–${say(predicted.removal.hi)} after the fault, for each candidate`,
      },
      calibrates: false,
      runs: 3,
    };
  }
  if (fault === "slow dependency") {
    const predicted = slowOf(mode, candidate);
    const failures =
      predicted.start === null || predicted.end === null
        ? { kind: "none" as const, why: predicted.why }
        : {
            kind: "window" as const,
            nodes: "all" as const,
            start: { from: "fault" as const, band: predicted.start },
            end: { from: "heal" as const, band: predicted.end },
            certain: true,
            outcomes: ["timeout"],
            why: predicted.why,
          };
    return {
      id: `S2.T07.${mode}.${SUFFIX[candidate]}.slow`,
      name: `T07 ${mode}, callers learn that a shared dependency is slow: ${candidate}`,
      template: "T07",
      substitutes: null,
      mode,
      workers: WORKERS,
      trigger: { kind: "latency", hold: SLOW_HOLD, delay: SLOW_DELAY },
      pod,
      declaration: dependencyDeclarationOf(candidate),
      workload,
      prediction: {
        kind: "stays",
        failures,
        why: `The round trip of Redis gates the readiness of each replica, but each check passes in the delay of ${say(SLOW_DELAY)}. Thus no replica leaves the Service, for each candidate`,
      },
      calibrates: false,
      runs: 3,
    };
  }
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
