import { timerOf, timerUnder } from "@mark1russell7/algebra";
import type { KindCell, Mesh, Prediction, Propagation } from "@mark1russell7/kind";
import { CHANNEL_USE, EDS_EVERY, LAST_SLACK } from "@mark1russell7/kind";
import { ENVOY_HTTP2, GRPC_JS, GRPC_GO_SERVER, LINUX_TCP, ZTUNNEL_HBONE } from "@mark1russell7/machines";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { count, given, seconds } from "../catalog.ts";
import type { Calibration } from "../kind.ts";
import { T07_WORKLOAD, WORKERS, calibrated, kubeDefaults, s, say } from "../kind.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import { linuxValues } from "../mongo/model.ts";
import type { O03Verdict } from "../topologies.ts";
import { conntrackValues, o03From } from "../topologies.ts";
import { backoffOf, lastWait, synWaitOf } from "./t07.ts";

/**
 * The gRPC cells of T15: the endpoint lifecycle of T07 through an Istio 1.31.3 mesh in the kind lab.
 * The client of grpc-js 1.14.6 and the server grpc-go v1.84.0 are the stack `grpc` of T07. Each pod
 * has an Envoy sidecar, thus each call crosses two mesh hops: the sidecar of the client and the
 * sidecar of the server. The source of each fact is Istio at the tag 1.31.3, its Envoy v1.39.4, and
 * the kubelet of v1.37.0. The documents `istio-sidecar-outbound`, `istio-sidecar-inbound` and
 * `pilot-agent` of `@mark1russell7/machines` hold these facts.
 *
 * The client sidecar balances each call over the replicas from its endpoints (EDS), not each
 * connection. Thus the propagation of a deletion is the push of istiod to each client sidecar, and
 * not a sync of kube-proxy. A policy goes to the server sidecars as an update of LDS.
 *
 * Step 2 of the plan of T15 gave the deletion its band from the calibration of step 1. The policy
 * got a calibration of its LDS update, and a band from the documented debounce until then.
 *
 * Step 3 adds the ambient mesh: ztunnel on each node, and no sidecar. The agent istio-cni redirects
 * the traffic of each pod to ztunnel in the network namespace of the pod. Each ztunnel balances each
 * connection, not each call. Thus a channel stays on one replica, as in T07. The document
 * `ztunnel-hbone` holds the facts of ztunnel 1.31.3.
 *
 * Step 4 adds the end of the socket of each client (the prediction `ends`). In a black hole, the PING
 * of ztunnel ends the connection. In a gap of the calls (the trigger `idle`), nothing ends it.
 *
 * Step 5 adds the restarts of ztunnel: the trigger `ztunnel-restart`. One cell is a control with
 * sidecar pods, and two cells are the two sides of the line of O10. The drain of ztunnel ends at its
 * deadline or at the SIGKILL at the end of the grace, whichever comes first.
 *
 * Step 6 adds the borders of O03, O17 and O02. A stateful middlebox in the namespace of each replica
 * forgets an idle flow on one side of the PING of ztunnel or the other (O03). A sysctl of the
 * namespace of each client pod moves the give-up of TCP to each side of the PING timeout (O17). A
 * new channel at the start of a gap shows the release of the pool of ztunnel (O02).
 */

/** This mesh is the sidecar flavor of Istio 1.31.3 with each pod of the cell in sidecar mode. */
export const SIDECAR: Mesh = { flavor: "sidecar", mode: "sidecar" };

/** This mesh is the ambient flavor of Istio 1.31.3 with each pod of the cell in ambient mode. */
export const AMBIENT: Mesh = { flavor: "ambient", mode: "ambient" };

/** These are the parts of each sidecar cell of T15: the stack `grpc` of T07 in the sidecar mesh, on iptables, with 2 workers. */
const BASE = {
  template: "T15",
  stack: "grpc",
  mesh: SIDECAR,
  substitutes: null,
  mode: "iptables",
  workers: WORKERS,
  declaration: null,
  workload: T07_WORKLOAD,
  runs: 11,
} as const;

/**
 * This calibration is the push of EDS after a deletion, from CAL.T15.sidecar in kind run 40147396211.
 * It counts the first poll of each client sidecar without the pod: 3 nodes in 11 runs.
 */
export const EDS_CALIBRATION: Calibration = { cell: "CAL.T15.sidecar", run: 40147396211, count: 33, min: s(0.128), median: s(0.168), max: s(0.205), poll: EDS_EVERY };

/** This propagation is the push of EDS to each client sidecar after a deletion (`calibrated`). */
export const P_EDS: Propagation = calibrated(EDS_CALIBRATION);

/**
 * This propagation is the LDS update of each server sidecar after a change of a policy, before a
 * calibration. The debounce of istiod pushes a change after 100 ms with no other change, and at
 * most 10 s after the first change (tuning.go of Istio 1.31.3, lines 77–90).
 */
export const P_LDS: Propagation = { lo: s(0.1), hi: s(10), from: "PILOT_DEBOUNCE_AFTER (100 ms) to PILOT_DEBOUNCE_MAX (10 s), not calibrated" };

/**
 * This time is the next call of a client to one replica after a change. A client sends a call each
 * 20 ms, and the client sidecar sends each call to either replica with a chance of 1 in 2. Thus 12
 * calls in sequence miss one replica with a chance of 1 in 4096. It is the slack of the last failure
 * of the judge (`LAST_SLACK`), from the same reason.
 */
export const NEXT_CALL: Quantity = LAST_SLACK;

/** This time is the lateness of one step of the event loop of Envoy (`slack` of `envoy-http2`). */
const STEP: Quantity = s(ENVOY_HTTP2.knobs["slack"]!.default!);

/** This function gives the sum of times in seconds, rounded to the microsecond. */
const sum = (...times: readonly Quantity[]): Quantity => s(Math.round(times.reduce((total, time) => total + valueIn(time, "s"), 0) * 1e6) / 1e6);

/**
 * This function gives the window of a deletion in the sidecar mesh. Each failure starts before the
 * client sidecar of its node drops the pod. It is a reset at the SIGKILL of the Envoy of the pod, or
 * a connect with no answer. Thus the window starts at the deletion and ends one propagation of EDS
 * after it. The timeout of the client ends such a call later, but the judge places a call by its
 * start. A drop after the band agrees with the law, and its cell is `extend`.
 */
export const sidecarDeletion = (propagation: Propagation, why: string): Prediction => ({
  kind: "window",
  nodes: "all",
  start: { from: "deletion", band: { lo: s(0), hi: propagation.hi } },
  end: { from: "deletion", band: { lo: s(0), hi: propagation.hi } },
  certain: false,
  propagation: { lo: propagation.lo, hi: propagation.hi },
  why,
});

/**
 * This function gives the window of a policy that denies the clients for `hold`. Each server sidecar
 * takes the update in `propagation` after the apply. Its open connection keeps the old chain until its
 * next response carries the GOAWAY notice. The next call after it opens a connection on the new chain,
 * and gets a denial. Thus the first denial starts by the update and two next calls.
 *
 * After the delete, the next call on the denying chain is the last denial. The window is certain when
 * the latest first denial comes before the delete.
 */
export const policyWindow = (propagation: Propagation, hold: Quantity, why: string): Prediction => {
  const first = sum(propagation.hi, NEXT_CALL, NEXT_CALL, STEP);
  return {
    kind: "window",
    nodes: "all",
    start: { from: "fault", band: { lo: propagation.lo, hi: first } },
    end: { from: "heal", band: { lo: propagation.lo, hi: sum(propagation.hi, NEXT_CALL, STEP) } },
    certain: valueIn(first, "s") < valueIn(hold, "s"),
    outcomes: ["denied"],
    propagation: { lo: propagation.lo, hi: propagation.hi },
    why,
  };
};

/**
 * This text is why the deletion of T15.defaults.13 fails in its window. Each fact has its source in
 * Istio 1.31.3, Envoy v1.39.4 or the kubelet of v1.37.0.
 */
const DELETION_WHY = [
  "At the deletion, grpc-go gets SIGTERM, and the preStop hook of the native sidecar starts the drain of pilot-agent at the same time (injection-template.yaml of Istio 1.31.3, lines 225–235, and kuberuntime_container.go at v1.37.0, lines 895–915).",
  "grpc-go closes its listener and sends GOAWAY. A call that reaches the leaving pod then gets a local 503 from its inbound sidecar, thus UNAVAILABLE. The inbound route of a port of gRPC has no retry policy (route.go, lines 1321–1341). The client sidecar retries the call on the other replica (retry.go, lines 35–50).",
  "When grpc-go exits, the kubelet stops the sidecar, and pilot-agent kills Envoy (agent.go, lines 146–164). A call in flight on that connection gets a reset before its headers, and a reset is not on the retry list.",
  "A connect after the address of the pod goes gets no answer until EDS drops the pod (endpoint_builder.go, lines 623–632). The connect timeout of the sidecar is 10 s, longer than the 2 s of the client.",
  `Each such call starts before the client sidecar of its node drops the pod, thus the window ends one push of EDS after the deletion: ${say(P_EDS.hi)} (${P_EDS.from}). The timeout ends such a call later, but the judge places a call by its start.`,
].join(" ");

/** This hold is the time of a policy: longer than the documented debounce and two next calls, thus the policy denies a call in it. */
const POLICY_HOLD = s(15);

/** This text is why the policy of T15.defaults.5 fails only in its window, and only with PERMISSION_DENIED. */
const POLICY_WHY = [
  "The policy denies the principal of the clients on the server pods. Its RBAC filter is in the inbound chain, and a change of it pushes LDS (builder.go of Istio 1.31.3, lines 321–330, and lds.go, lines 46–55).",
  "Envoy updates the chain in place. An open connection keeps the old chain until the headers of its next response carry the GOAWAY notice (conn_manager_impl.cc of Envoy v1.39.4, lines 1959–1968).",
  "A call on a new connection meets the new chain: the local reply 403, thus PERMISSION_DENIED (rbac_filter.cc, lines 234–235, and status.cc, lines 14–15). The client sidecar does not retry it, because retriable-status-codes lists no code.",
  `Each server sidecar takes the update in ${say(P_LDS.lo)} to ${say(P_LDS.hi)} after the apply and after the delete (${P_LDS.from}). Each next call to one replica comes in ${say(NEXT_CALL)}.`,
  "The judge places a call by its start, and a call starts before the handshake of its new connection, thus the band has no handshake.",
].join(" ");

/** This time is the lateness of one step of the runtime of ztunnel (`slack` of `ztunnel-hbone`). */
const ZTUNNEL_STEP: Quantity = s(ZTUNNEL_HBONE.knobs["slack"]!.default!);

/** This hold is the time of the reset of T15.defaults.12. */
const RESET_HOLD = s(10);

/**
 * This time is the most that the heal of a reset comes after its hold. The lab commits the clear
 * 700 ms after the end of the hold (`--at`), and it reads the tables of each replica before it.
 */
const HEAL_LATE = s(2);

/** This function rounds a time in seconds to the microsecond, as a quantity. */
const us = (seconds: number): Quantity => s(Math.round(seconds * 1e6) / 1e6);

/**
 * This function gives the window of a reset of the mesh leg for `hold`, in the ambient mesh. The rule
 * in each replica answers the next segment of each client pod with a reset. A call sends a segment
 * each 20 ms, thus the window starts by one call and one step of ztunnel after the fault.
 *
 * Until the heal, each connect of grpc-js fails in a few milliseconds, and each wait of its backoff
 * follows. After the heal, the next connect comes at the end of the wait in progress. The heal comes
 * at most `hold` and `HEAL_LATE` after the fault. Thus that wait is at most the wait K = `lastWait`
 * of that time, the backoff model of T07.
 */
export const resetWindow = (hold: Quantity, why: string): Prediction => {
  const wait = backoffOf(lastWait(valueIn(hold, "s") + valueIn(HEAL_LATE, "s")));
  return {
    kind: "window",
    nodes: "all",
    start: { from: "fault", band: { lo: s(0), hi: sum(T07_WORKLOAD.every, ZTUNNEL_STEP) } },
    end: { from: "heal", band: { lo: s(0), hi: us(wait.hi) } },
    certain: true,
    outcomes: ["error", "reset", "refused"],
    why,
  };
};

/** This index is the wait of the backoff of grpc-js that the heal of T15.defaults.12 can come in. */
const RESET_WAIT = lastWait(valueIn(RESET_HOLD, "s") + valueIn(HEAL_LATE, "s"));

/**
 * This text is why the reset of T15.defaults.12 fails in its window. Each fact has its source in
 * ztunnel 1.31.3 or grpc-js 1.14.6.
 */
const RESET_WHY = [
  "The rule in each server pod answers the next segment of each client pod with a reset. That segment is on the HBONE connection of the ztunnel of the client, from the address of the client pod to the port 15008.",
  "ztunnel drops the connection, and its copy loop shuts down the socket of the app. grpc-js gets a FIN, and the call in flight fails (h2.rs of ztunnel 1.31.3, lines 229–238, and copy.rs, lines 176–183).",
  "grpc-js connects again, and its local ztunnel accepts. The connect of ztunnel to 15008 gets a reset, and ztunnel closes the socket of the app before any answer. grpc-js counts a failed connect and waits its backoff.",
  "A call in TRANSIENT_FAILURE fails at once (load-balancing-call.ts of grpc-js 1.14.6, lines 338–345). Thus the calls fail until the heal, and no call waits for its timeout.",
  `After the heal, the next connect comes at the end of the wait in progress. The heal comes at most ${say(sum(RESET_HOLD, HEAL_LATE))} after the fault, thus that wait is at most the wait ${RESET_WAIT}: ${say(us(backoffOf(RESET_WAIT).hi))}.`,
].join(" ");

/** These are the knobs of ztunnel 1.31.3 at its defaults, as quantities (`ztunnel-hbone`). */
const ZTUNNEL_DEFAULTS: Readonly<Record<string, Quantity>> = Object.fromEntries(
  Object.entries(ZTUNNEL_HBONE.knobs).flatMap(([name, knob]): Array<[string, Quantity]> =>
    knob.unit === null || knob.default === null || knob.default === undefined ? [] : [[name, { value: knob.default, unit: knob.unit }]],
  ),
);

/** These are the values of the knobs of ztunnel 1.31.3 at its defaults. */
const ZTUNNEL = given(ZTUNNEL_DEFAULTS);

/** A span is the bounds of a time in seconds: the duration of a timer less how early it fires, and plus how late. */
export interface Span {
  readonly lo: number;
  readonly hi: number;
}

/** This function gives the span of a timer of ztunnel, at its defaults or at other values. */
const ztunnelTimer = (timer: string, values: ReturnType<typeof given> = ZTUNNEL): Span => {
  const bounds = timerOf(ZTUNNEL_HBONE, timer, values);
  const duration = seconds(bounds.duration, `the timer ${timer} of ztunnel`);
  return { lo: duration - seconds(bounds.early, "how early it fires"), hi: duration + seconds(bounds.lateness, "how late it fires") };
};

/**
 * This span is the end of a connection of ztunnel after a black hole starts. The PING sleeps 10 s
 * after each PONG, then it waits 20 s for the next PONG. Thus a black hole that starts at a time in
 * that cycle ends the connection 20 s to 30 s later (the timer `pong`).
 */
export const PONG: Span = ztunnelTimer("pong");

/** This span is a connect of ztunnel to the port 15008 with no answer: its timeout of 10 s (the timer `connect`). */
export const ZTUNNEL_CONNECT: Span = ztunnelTimer("connect");

/** This function rounds a time in seconds to the microsecond. */
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * This function gives the longest time from a SYN to the next try of a connect that gets no answer.
 * The connect times out after `connect` seconds. The SYN timer of Linux sends each SYN after its
 * wait: 5 waits of 1 s (the linear timeouts), then waits that double. The last try is the timeout
 * itself, because a new connect sends its SYN at once. The rest of the connect after the last SYN is
 * the longest when each wait before it is the shortest. In a connect of 10.01 s, that rest is the longest time.
 */
export const longestSynGap = (connect: number): number => {
  let at = 0;
  let longest = 0;
  for (let k = 0; ; k += 1) {
    const wait = synWaitOf(k);
    if (at + wait.lo >= connect) return round(Math.max(longest, connect - at));
    longest = Math.max(longest, wait.hi);
    at += wait.lo;
  }
};

/**
 * This function gives the prediction of a black hole of the mesh leg for `hold`, in the ambient mesh.
 * The PING of the ztunnel of the client ends its connection in `PONG` after the fault. The copy loop
 * then shuts down the socket of grpc-js, one step of ztunnel later. That is the band of the close.
 *
 * The window of the failed requests starts by one call and one step after the fault. Until the heal,
 * each connect of ztunnel times out, and grpc-js connects again at once. After the heal, the next try
 * of the connect in progress gets an answer, in `longestSynGap` at the most. A call waits in the
 * queue of the channel until its timeout, thus the last failure starts by one timeout before then.
 */
export const blackholeWindow = (hold: Quantity, why: string, windowWhy: string): Prediction => {
  const fault = valueIn(hold, "s");
  if (PONG.hi + valueIn(ZTUNNEL_STEP, "s") >= fault) throw new Error(`a hold of ${fault} s ends before the PING of ztunnel ends its connection`);
  // the connects of grpc-js from the end of the connection to the heal: each one lasts the connect of ztunnel
  const connects = Math.floor((fault + valueIn(HEAL_LATE, "s") - PONG.lo) / ZTUNNEL_CONNECT.lo);
  for (let k = 0; k <= connects; k += 1)
    if (backoffOf(k).hi >= ZTUNNEL_CONNECT.lo) throw new Error(`the wait ${k} of grpc-js can end after a connect of ztunnel times out`);
  const gap = longestSynGap(ZTUNNEL_CONNECT.hi);
  return {
    kind: "ends",
    from: "fault",
    band: { lo: s(PONG.lo), hi: sum(s(PONG.hi), ZTUNNEL_STEP) },
    window: {
      kind: "window",
      nodes: "all",
      start: { from: "fault", band: { lo: s(0), hi: sum(T07_WORKLOAD.every, ZTUNNEL_STEP) } },
      end: { from: "heal", band: { lo: s(-valueIn(T07_WORKLOAD.timeout, "s")), hi: sum(s(gap), ZTUNNEL_STEP, ZTUNNEL_STEP, ZTUNNEL_STEP) } },
      certain: true,
      outcomes: ["timeout", "error", "reset"],
      why: windowWhy,
    },
    why,
  };
};

/** This hold is the time of the black hole of T15.defaults.2: longer than the PING of ztunnel, and than one connect of ztunnel after it. */
const BLACKHOLE_HOLD = s(45);

/** This text is why the socket of each client of T15.defaults.2 ends in its band. Each fact has its source in ztunnel 1.31.3 or Linux 6.17. */
const BLACKHOLE_WHY = [
  "The rule in each server pod drops each segment from each client pod, and each segment to it. That is the HBONE connection of the ztunnel of the client.",
  "The PING of ztunnel sleeps 10 s after each PONG. Then it waits 20 s for the next PONG, and data does not put a PING off (h2.rs of ztunnel 1.31.3, lines 36–56 and 222–225).",
  `Thus the ztunnel of the client drops the connection ${say(s(PONG.lo))} to ${say(s(PONG.hi))} after the fault (client.rs, lines 237–238).`,
  "Then the copy loop shuts down the socket of grpc-js (copy.rs, lines 176–183). That is the end of the socket of the channel.",
  "TCP does not end the connection before that. The connection has no TCP_USER_TIMEOUT, its retransmissions stop after about 924 s, and the keepalive of ztunnel needs 180 s idle.",
].join(" ");

/** This text is why the calls of T15.defaults.2 fail only in the window. */
const BLACKHOLE_WINDOW_WHY = [
  "From the fault, a call gets no answer, and the client ends it at its timeout of 2 s.",
  `Each new connect of ztunnel to the port 15008 gets no answer, and it times out at ${say(s(ZTUNNEL_CONNECT.lo))} (proxy.rs of ztunnel 1.31.3, line 645).`,
  "Then ztunnel closes the socket of grpc-js, and grpc-js connects again at once. Each wait of its backoff until the heal is shorter than a connect of ztunnel.",
  "After the heal, the next try gets an answer: a SYN of the connect in progress, or a new connect after its timeout.",
  `The SYN timer of Linux 6.17 waits 1 s five times, and then it doubles the wait (tcp_timer.c, lines 671–678). Thus the longest time to the next try is ${say(s(longestSynGap(ZTUNNEL_CONNECT.hi)))}.`,
  "A call waits in the queue of the channel while grpc-js connects, and it fails only at its timeout. Thus the last failure starts at most 2 s before the transport is ready.",
].join(" ");

/** This hold is the gap of T15.defaults.10: longer than the release of the pool of ztunnel and than the idle time of its keepalive. */
const IDLE_HOLD = s(330);

/** This text is why no socket of a client of T15.defaults.10 ends in the gap. */
const IDLE_WHY = [
  `The client of grpc-js sends no call for ${say(IDLE_HOLD)}, and its channel and socket stay open.`,
  `The channel goes IDLE only after ${say(s(GRPC_JS.knobs["client_idle_timeout"]!.default! / 1000))} with no call (internal-channel.ts of grpc-js 1.14.6, lines 74–77 and 324–325).`,
  "The ztunnel of Istio 1.31.3 has no idle timeout of L4 and no maximum age of a connection, from a search of its tag.",
  `The release of the pool of ztunnel comes ${say(s(ZTUNNEL_HBONE.knobs["pool_release"]!.default!))} after the last checkout of the connection, the start of the flow of the client.`,
  "The release only drops the reference of the pool, and HTTP/2 keeps a connection with an open stream. The flow of the client is an open stream, thus no release closes its connection (pool.rs, lines 142–176 and 338–341).",
  `The PING of ztunnel keeps the HBONE connection live, and the keepalive of ztunnel sends a probe after ${say(s(ZTUNNEL_HBONE.knobs["keepidle"]!.default!))} idle. A live peer answers each one.`,
  `The keepalive of grpc-go sends its first PING after ${say(s(GRPC_GO_SERVER.knobs["keepalive_time"]!.default!))} (defaults.go of grpc-go v1.84.0, lines 31–40).`,
  "Thus the first call of each client after the gap goes on the socket of its last call before it.",
].join(" ");

/** This time is the round trip on the mesh leg in kind, in milliseconds: an upper bound, because the nodes are containers of one VM. */
const KIND_RTT_MS = 1;

/** This span is the sleep of ztunnel before each PING, after each PONG (the timer `ping`). */
const PING: Span = ztunnelTimer("ping");

/** This time is the wait of ztunnel for the PONG of a PING, in seconds: PING_TIMEOUT. */
const PING_TIMEOUT = ZTUNNEL_HBONE.knobs["ping_timeout"]!.default!;

/**
 * This time is the most that the signal of the last client comes after the signal of the first. The
 * lab sends the signals at the same time, each through the agent of the node of the client. The fault
 * is the act of the first. It is an assumption of this catalog, and no calibration measures it yet.
 */
export const SIGNAL_LATE: Quantity = s(0.5);

/**
 * This time is the most that a segment of the HBONE connection comes after the last call before a
 * gap. It is the delayed ACK of Linux: at most TCP_DELACK_MAX (include/net/tcp.h of Linux v6.17, line 138).
 */
const DELACK: Quantity = s(0.2);

/** This name is the hop of the research that a stateful middlebox in the namespace of each replica stands in for (O03). */
export const MIDDLEBOX_HOP = "router-netns:azure-lb-240";

/** This idle timeout of the middlebox of T15.border-off.79 is longer than the PING of ztunnel: O03 holds. */
const MIDDLEBOX_INSIDE = s(11);

/** This idle timeout of the middlebox of T15.border-off.80 is shorter than the PING of ztunnel: O03 is violated. */
const MIDDLEBOX_OUTSIDE = s(9);

/** This hold is the gap of T15.border-off.79: twelve PINGs of ztunnel. */
const MIDDLEBOX_HOLD = s(120);

/** This hold is the gap of T15.border-off.80: longer than the latest end of the tunnel. */
const FORGET_HOLD = s(60);

/**
 * This function decides O03 for the PING of ztunnel on a stateful middlebox that forgets an idle flow
 * after `idle` (`o03From`). The refresh is the timer `ping` at its latest.
 */
export const pingOnMiddlebox = (idle: Quantity): O03Verdict => o03From(timerOf(ZTUNNEL_HBONE, "ping", ZTUNNEL), conntrackValues(valueIn(idle, "s")), KIND_RTT_MS / 1000);

/**
 * This function gives the prediction of a gap of the calls through a middlebox. The middlebox forgets
 * an idle flow after `idle`, which is shorter than the PING of ztunnel. The last segment before the
 * gap comes in the last call or in its delayed ACK. The middlebox forgets the flow `idle` after the
 * last segment, and it drops each later segment of it. The PING timeout of ztunnel then ends the
 * tunnel, and the copy loop shuts down the socket of grpc-js one step of ztunnel later.
 * - At the earliest, the first PING comes at the forget: the forget and then the PING timeout.
 * - At the latest, a PING passes immediately before the forget. The next PING comes one sleep after its
 *   PONG, and the middlebox drops it: the forget, a sleep, the PING timeout and their lateness.
 */
export const forgetEnds = (idle: Quantity, why: string): Prediction => {
  const verdict = pingOnMiddlebox(idle);
  if (verdict.holds) throw new Error(`a middlebox that forgets after ${valueIn(idle, "s")} s keeps the PING of ztunnel: O03 holds`);
  const forget = valueIn(idle, "s");
  // a PING that refreshes the flow just before the forget must not reach the next PING
  if (forget + valueIn(DELACK, "s") >= PING.lo) throw new Error(`a forget at ${forget} s with a delayed ACK can come after the next PING`);
  return {
    kind: "ends",
    from: "fault",
    band: { lo: us(forget - valueIn(T07_WORKLOAD.every, "s") + PING_TIMEOUT), hi: sum(idle, SIGNAL_LATE, DELACK, s(PONG.hi), ZTUNNEL_STEP) },
    why,
  };
};

/** This text is the start of why a middlebox of T15.border-off.79 or T15.border-off.80 changes the tunnel of each client, or not. */
const MIDDLEBOX_START = [
  `The lab puts a stateful middlebox in the network namespace of each replica, before the gap: a stand-in for ${MIDDLEBOX_HOP}, because kind has no router between its nodes.`,
  "The middlebox keeps the time of the last segment of each client pod on the port 15008, in a table of the match recent, in each direction (xt_recent.c of Linux v6.17, lines 251–257 and 298–321).",
  "A segment after the idle timeout with no segment is dropped, and the time stays old. Thus the middlebox forgets the flow for good: the silent-drop form.",
  "Conntrack of the namespace stays as it is, because istio-cni sends each answer of the app back to ztunnel through the connmark of its conntrack entry (cni/pkg/iptables/iptables.go of Istio 1.31.3, lines 172–178, 278–284 and 336–347).",
  "The clients send no call in the gap. Each ztunnel of the tunnel sends a PING each 10 s after its PONG, and data does not put a PING off (h2.rs of ztunnel 1.31.3, lines 36–56 and 222–225, and server.rs, lines 126–135).",
  "Both loops start at the connect of the tunnel, thus their PINGs come at almost the same times.",
];

/** This text is why the tunnel of each client of T15.border-off.79 stays open in the gap. */
const MIDDLEBOX_INSIDE_WHY = [
  ...MIDDLEBOX_START,
  `The middlebox forgets an idle flow after ${say(MIDDLEBOX_INSIDE)}, and a PING crosses it at most ${say(s(PING.hi))} after the last PONG. Thus each PING refreshes the flow before the forget, and the law O03 holds.`,
  "The socket of grpc-js stays open, and the first call of each client after the gap goes on the socket of its last call before it.",
].join(" ");

/** This text is why the tunnel of each client of T15.border-off.80 ends at the PING timeout. */
const MIDDLEBOX_OUTSIDE_WHY = [
  ...MIDDLEBOX_START,
  `The middlebox forgets an idle flow after ${say(MIDDLEBOX_OUTSIDE)}, before the next PING. Thus the law O03 is violated, and the middlebox drops the next PING and each later segment of the tunnel.`,
  `The ztunnel of the client gets no PONG, and it drops the tunnel ${PING_TIMEOUT} s after the PING (client.rs, lines 237–238). Then the copy loop shuts down the socket of grpc-js (copy.rs, lines 176–183).`,
  `The last segment before the gap comes at most ${say(DELACK)} after the last call: a delayed ACK. The signal of a client comes at most ${say(SIGNAL_LATE)} after the fault, an assumption.`,
  "Thus the earliest end is the forget and the PING timeout. The latest end is a PING that passes just before the forget, the sleep after its PONG, and the PING timeout of the next PING.",
].join(" ");

/** These are the counts of tcp_retries2 of T15.border-off.87 and T15.border-off.88 in the namespace of each client pod. */
const RETRIES_INSIDE = 6;
const RETRIES_OUTSIDE = 4;

/**
 * This function gives the span of the give-up of Linux TCP on one PING of the HBONE socket behind a
 * black hole, with tcp_retries2 at `retries`. The span is in seconds after that PING. The first
 * retransmission is the probe of the tail loss, one RTO after the PING. Or it is the retransmission of
 * the RTO, one RTO later (tcp_output.c of Linux v6.17, lines 2897–2915). The budget of the give-up
 * starts there (the timer `retrans_giveup` of `linux-tcp`). The RTO is its minimum, because the round
 * trip in kind is far less.
 */
export const giveUpAfterPing = (retries: number): Span => {
  const lower = given(linuxValues({ tcp_retries2: count(retries) }, KIND_RTT_MS));
  const wait = timerUnder(LINUX_TCP, "retransmit", lower, MANIFESTATIONS.blackhole, 0);
  const giveUp = timerUnder(LINUX_TCP, "retrans_giveup", lower, MANIFESTATIONS.blackhole);
  const first = { lo: seconds(wait.duration, "the RTO") - seconds(wait.early, "how early the RTO fires"), hi: 2 * (seconds(wait.duration, "the RTO") + seconds(wait.lateness, "how late the RTO fires")) };
  const budget = seconds(giveUp.duration, "the budget of the give-up");
  return { lo: round(first.lo + budget - seconds(giveUp.early, "how early the give-up fires")), hi: round(first.hi + budget + seconds(giveUp.lateness, "how late the give-up fires")) };
};

/**
 * This function gives the prediction of a black hole of the mesh leg with quiet clients. The
 * namespace of each client pod has tcp_retries2 at `retries`. It is the side of O17 where the PING of
 * ztunnel finds the black hole first. The PING timeout then ends the tunnel, as in T15.defaults.2.
 */
export const pingFirstEnds = (retries: number, why: string): Prediction => {
  const giveUp = giveUpAfterPing(retries);
  if (giveUp.lo <= PING_TIMEOUT + valueIn(ZTUNNEL_STEP, "s")) throw new Error(`TCP with tcp_retries2 ${retries} can give up ${giveUp.lo} s after the PING, before its timeout`);
  return { kind: "ends", from: "fault", band: { lo: s(PONG.lo), hi: sum(s(PONG.hi), ZTUNNEL_STEP) }, why };
};

/**
 * This function gives the prediction of a black hole of the mesh leg with quiet clients. The
 * namespace of each client pod has tcp_retries2 at `retries`. It is the side of O17 where TCP gives up
 * first, with ETIMEDOUT. The first PING comes in one sleep after the fault, and TCP gives up on it.
 * Then ztunnel ends the tunnel, and the copy loop shuts down the socket of grpc-js one step later.
 */
export const giveUpFirstEnds = (retries: number, why: string): Prediction => {
  const giveUp = giveUpAfterPing(retries);
  if (giveUp.hi >= PING_TIMEOUT) throw new Error(`TCP with tcp_retries2 ${retries} can give up ${giveUp.hi} s after the PING, after its timeout`);
  return { kind: "ends", from: "fault", band: { lo: s(giveUp.lo), hi: sum(s(PING.hi), s(giveUp.hi), ZTUNNEL_STEP) }, why };
};

/** This text is the start of why a quiet black hole of T15.border-off.87 or T15.border-off.88 ends the tunnel of each client. */
const QUIET_START = [
  "The clients stop their calls 1 s before the fault. Then the rule in each server pod drops each segment from each client pod, and each segment to it.",
  "The lab sets tcp_retries2 in the namespace of each client pod: the HBONE socket of its ztunnel is there. A new namespace has TCP_RETR2, 15 (tcp_ipv4.c of Linux v6.17, line 3604).",
  "The first PING of the ztunnel of the client after the fault comes in one sleep of 10 s, and it is the only data that gets no answer (h2.rs of ztunnel 1.31.3, lines 36–56).",
];

/** This text is why the PING timeout ends the tunnel of each client of T15.border-off.87 before TCP gives up. */
const PING_FIRST_WHY = [
  ...QUIET_START,
  `With tcp_retries2 ${RETRIES_INSIDE}, TCP gives up ${giveUpAfterPing(RETRIES_INSIDE).lo} s after the PING at the earliest: later than the PING timeout of ${PING_TIMEOUT} s. Thus the law O17 holds.`,
  `The ztunnel of the client drops the tunnel ${say(s(PONG.lo))} to ${say(s(PONG.hi))} after the fault (client.rs, lines 237–238). Then the copy loop shuts down the socket of grpc-js (copy.rs, lines 176–183).`,
].join(" ");

/** This text is why TCP gives up on the tunnel of each client of T15.border-off.88 before the PING timeout. */
const GIVE_UP_FIRST_WHY = [
  ...QUIET_START,
  `With tcp_retries2 ${RETRIES_OUTSIDE}, TCP gives up ${giveUpAfterPing(RETRIES_OUTSIDE).lo} s to ${giveUpAfterPing(RETRIES_OUTSIDE).hi} s after the PING, with ETIMEDOUT: before the PING timeout of ${PING_TIMEOUT} s. Thus the law O17 is violated.`,
  "The budget counts from the first retransmission, and the give-up comes at the next RTO after the budget (tcp_timer.c, lines 213–223).",
  "The error ends each stream of the tunnel, and the copy loop shuts down the socket of grpc-js (h2.rs, lines 229–238, and copy.rs, lines 176–183).",
].join(" ");

/** This span is the release of the pool of ztunnel after the last checkout of a connection (the timer `release`). */
export const RELEASE: Span = ztunnelTimer("release");

/**
 * This time is the most that the first call of a new channel takes to get a connection of the pool of
 * ztunnel. It is the next call of the loop, and the connect. It is an assumption of this catalog. The
 * first connect of T01 took 26 ms to 42 ms (run 39275010409).
 */
const NEW_CHANNEL: Quantity = s(0.1);

/**
 * This function gives the prediction of a new channel of each client at the fault, in a gap of
 * `hold`. The client closes the channel `CHANNEL_USE` later. The checkout of the tunnel at the fault
 * is its last use, thus the pool releases it one release later. The side of the client closes it: the
 * peer has no idle close. The release counts from the checkout, not from the end of the stream. Thus
 * the band ends before the end of the stream and a release.
 *
 * The peer can answer the close, and its FIN can come first (`answer`). The client sends GOAWAY when
 * its connection has no reference and no stream (proto/connection.rs of h2 0.4.19, lines 261–265).
 * The server records that GOAWAY (lines 563–570). With no stream, it sends its own GOAWAY and shuts
 * down the socket at once (lines 309–316 and 325–329). Thus the answer starts at the release. It ends
 * one round trip and one step of ztunnel after the band.
 */
export const releaseEnds = (hold: Quantity, why: string): Prediction => {
  const band = { lo: s(RELEASE.lo), hi: sum(s(RELEASE.hi), SIGNAL_LATE, NEW_CHANNEL, ZTUNNEL_STEP) };
  if (valueIn(band.hi, "s") >= valueIn(hold, "s")) throw new Error(`a gap of ${valueIn(hold, "s")} s ends before the release of the pool`);
  if (valueIn(band.hi, "s") >= RELEASE.lo + valueIn(CHANNEL_USE, "s")) throw new Error("the band does not tell the checkout from the end of the stream");
  const answer = { lo: s(RELEASE.lo), hi: sum(band.hi, s(KIND_RTT_MS / 1000), ZTUNNEL_STEP) };
  return { kind: "ends", from: "fault", of: "tunnel", band, answer, why };
};

/** This text is why the pool of ztunnel releases the tunnel of each client of T15.border-off.77 at its band. */
const RELEASE_WHY = [
  `Before the fault, each client closes its channel. At the fault it opens a new channel and calls on it for ${say(CHANNEL_USE)}, then it closes it. Thus the tunnel of the client carries no stream in the gap.`,
  "grpc-js shuts down the transport of a channel that it closes (internal-channel.ts of grpc-js 1.14.6, lines 839–861, and subchannel.ts, lines 396–410).",
  `The pool of ztunnel puts the tunnel back at each checkout, with a new release timer of ${say(s(RELEASE.lo))} (pool.rs of ztunnel 1.31.3, lines 150–176 and 338–341). Thus the release counts from the checkout at the fault, not from the end of the stream.`,
  "The release drops the reference of the pool, and HTTP/2 closes a connection with no reference and no stream (pool.rs, lines 142–146). The side of the client sends the FIN: ESTABLISHED to FIN_WAIT1 in the records of the prober.",
  "The ztunnel of the server has no idle close, thus the peer does not close on its own. The law O02 holds.",
  "The server answers the GOAWAY of the client at once, and its FIN can come first (proto/connection.rs of h2 0.4.19, lines 309–316, 325–329 and 563–570).",
  `Thus a change from ESTABLISHED to CLOSE_WAIT also agrees, from the release to the end of the band, one round trip of ${say(s(KIND_RTT_MS / 1000))} and one step of ztunnel.`,
  `The first call of the new channel comes at most ${say(sum(SIGNAL_LATE, NEW_CHANNEL))} after the fault, an assumption. After the heal, a new channel gets a new tunnel, and its first call succeeds.`,
].join(" ");

/**
 * This mesh is the ambient flavor of Istio 1.31.3 with each pod of the cell in sidecar mode. Thus
 * ztunnel is on each node, but it is on no path of the cell.
 */
export const SIDECAR_IN_AMBIENT: Mesh = { flavor: "ambient", mode: "sidecar" };

/**
 * This time is the most that the SIGTERM of each ztunnel comes after the reference `restart`. One
 * kubectl deletes the pods one after the other. The kubelet of each node gets the deletion from its
 * watch, and its pod worker stops the container through the runtime. It is an assumption of this
 * catalog, not a value of the kubelet. No calibration measures it yet.
 */
export const TERM_LATE: Quantity = s(0.5);

/** An end of a drain is the timer of `ztunnel-hbone` that ends the drain of ztunnel first, and its span after SIGTERM. */
export interface DrainEnd {
  readonly by: "deadline" | "grace";
  readonly span: Span;
}

/**
 * This function gives the end of the drain of ztunnel with the deadline `deadline`. Both timers start
 * at SIGTERM. Then ztunnel ends each open flow at its deadline, or the kubelet sends SIGKILL at the
 * end of the grace of the pod. The first of the two ends the drain.
 */
export const drainEnd = (deadline: Quantity): DrainEnd => {
  const values = given({ ...ZTUNNEL_DEFAULTS, deadline });
  const own = ztunnelTimer("deadline", values);
  const kill = ztunnelTimer("grace", values);
  return own.lo < kill.lo ? { by: "deadline", span: own } : { by: "grace", span: kill };
};

/**
 * This function gives the prediction of a restart of ztunnel on each node, with the deadline
 * `deadline`. The drain of each ztunnel ends at the first of its two timers (`drainEnd`). Then the copy
 * loop or the kernel shuts down the socket of grpc-js, one step of ztunnel later. The SIGTERM comes
 * `TERM_LATE` after the reference at the most. That is the band of the close.
 *
 * The DaemonSet makes each new pod at the deletion, thus a new ztunnel takes each new connection.
 * Only a call in flight at the close fails. A call started one interval before the close can be in flight.
 */
export const restartEnds = (deadline: Quantity, why: string, windowWhy: string): Prediction => {
  const { span } = drainEnd(deadline);
  const band = { lo: s(span.lo), hi: sum(s(span.hi), TERM_LATE, ZTUNNEL_STEP) };
  const failures = { lo: us(span.lo - valueIn(T07_WORKLOAD.every, "s")), hi: band.hi };
  return {
    kind: "ends",
    from: "restart",
    band,
    window: {
      kind: "window",
      nodes: "all",
      start: { from: "restart", band: failures },
      end: { from: "restart", band: failures },
      certain: false,
      outcomes: ["error", "reset"],
      why: windowWhy,
    },
    why,
  };
};

/** This deadline is inside the grace of 30 s: ztunnel ends the open flows itself (T15.border-off.85). */
const DEADLINE_INSIDE = s(29);

/** This deadline is past the grace of 30 s: the SIGKILL at the end of the grace ends the open flows (T15.border-off.86). */
const DEADLINE_OUTSIDE = s(31);

/**
 * This function gives the ambient mesh with the deadline `deadline` of ztunnel: the variable
 * CONNECTION_TERMINATION_DEADLINE of its DaemonSet, a duration in seconds (`deadline` of `ztunnel-hbone`).
 */
export const deadlineMesh = (deadline: Quantity): Mesh => ({
  ...AMBIENT,
  ztunnel: { [ZTUNNEL_HBONE.knobs["deadline"]!.key]: `${valueIn(deadline, "s")}s` },
});

/** This text is the start of why each restart of ztunnel ends the socket of each client. */
const RESTART_START = [
  "One kubectl deletes the ztunnel pod of each node. The flow of each client crosses the ztunnel of its own node and the ztunnel of the node of its replica.",
  "At SIGTERM each ztunnel stops its accept loops and sends GOAWAY, and the open flows go on (server.rs of ztunnel 1.31.3, lines 170–172, and outbound.rs, line 121).",
];

/** This text is the end of why each restart of ztunnel ends the socket of each client. */
const RESTART_END = `The kubelet sends SIGTERM at most ${say(TERM_LATE)} after the deletion. That is an assumption, and no calibration measures it yet.`;

/** This text is why ztunnel ends the socket of each client of T15.border-off.85 at its own deadline. */
const INSIDE_WHY = [
  ...RESTART_START,
  `The cell sets CONNECTION_TERMINATION_DEADLINE to ${say(DEADLINE_INSIDE)}, inside the grace of ${say(s(ZTUNNEL_HBONE.knobs["grace"]!.default!))} of the chart (config.rs, lines 810–827, and values.yaml of Istio 1.31.3, line 102).`,
  "Thus ztunnel ends each flow itself at its deadline after SIGTERM, and the copy loop shuts down the socket of grpc-js with a FIN (app.rs, lines 391–399, and copy.rs, lines 176–183).",
  RESTART_END,
  "The law O10 holds: the drain ends inside the grace.",
].join(" ");

/** This text is why the SIGKILL at the end of the grace ends the socket of each client of T15.border-off.86. */
const OUTSIDE_WHY = [
  ...RESTART_START,
  `The cell sets CONNECTION_TERMINATION_DEADLINE to ${say(DEADLINE_OUTSIDE)}, past the grace of ${say(s(ZTUNNEL_HBONE.knobs["grace"]!.default!))} of the chart.`,
  "The kubelet stops the container with the grace of the pod (kuberuntime_container.go of Kubernetes v1.37.0, lines 864–915).",
  "The runtime kills it at the end of the grace (api.proto of the CRI, lines 69–72).",
  "Then the kernel closes each socket of ztunnel: a FIN, or a reset when bytes are unread (tcp.c of Linux v6.6, lines 2781–2807).",
  "Thus the socket of grpc-js ends at the end of the grace, 1 s after the band of T15.border-off.85.",
  RESTART_END,
  "The law O10 is violated: the drain does not end inside the grace.",
].join(" ");

/** This text is why only the calls in flight at the close fail in a restart of ztunnel. */
const RESTART_WINDOW_WHY = [
  "The DaemonSet of ztunnel surges, with maxSurge 1 and maxUnavailable 0 (values.yaml of Istio 1.31.3, lines 143–147).",
  "Thus its controller lets the DaemonSet surge (daemonset_util.go of Kubernetes v1.37.0, lines 126–128).",
  "It skips a pod with a deletion timestamp, and it makes a new pod on that node at once (daemon_controller.go, lines 863–924).",
  "The new ztunnel shares the ports in the namespace of each pod (config.rs of ztunnel 1.31.3, line 892). It is ready long before the end of the drain.",
  "Thus grpc-js connects again at once through the new ztunnel, and only a call in flight at the close fails.",
].join(" ");

/** This text is why a restart of ztunnel fails no call of T15.defaults.14, a control. */
const CONTROL_WHY = [
  "The pods of the cell have sidecars, in a namespace with the label istio-injection. The node agent of istio-cni enrolls only the pods of the ambient mesh (informers.go of Istio 1.31.3, line 132).",
  "The traffic of each pod goes to its own Envoy, thus no ztunnel is on the path of a call. A restart of ztunnel on each node fails no call.",
  "The lines of the ztunnel pods show the restart.",
].join(" ");

/** This lifetime is the workload certificate of T15.border-off.92: SECRET_TTL of ztunnel, in place of its default of 24 h. */
export const CERT_LIFETIME: Quantity = s(600);

/** This time is how far the CA of istiod backdates a certificate: ClockSkewGracePeriod. */
const CLOCK_SKEW: Quantity = s(120);

/**
 * This time is from the issue of a certificate to its renewal by ztunnel. The renewal comes at the
 * middle of the validity, and the validity starts at the backdate.
 */
export const RENEWAL: Quantity = s((valueIn(CERT_LIFETIME, "s") + valueIn(CLOCK_SKEW, "s")) / 2 - valueIn(CLOCK_SKEW, "s"));

/** This hold is past the lifetime of each certificate in use at the fault: 30 s more than the lifetime. */
export const EXPIRY_HOLD: Quantity = sum(CERT_LIFETIME, s(30));

/** This function gives the ambient mesh in which each workload certificate of ztunnel has the lifetime `lifetime`. */
export const certificateMesh = (lifetime: Quantity): Mesh => ({ ...AMBIENT, ztunnel: { SECRET_TTL: `${valueIn(lifetime, "s")}s` } });

/** This text is why no socket of a client of T15.border-off.92 ends when the certificates of its tunnel expire. */
const EXPIRY_WHY = [
  `The cell sets SECRET_TTL of ztunnel to ${say(CERT_LIFETIME)}. Each CSR of ztunnel asks for that lifetime (config.rs of ztunnel 1.31.3, lines 59, 104 and 868, and caclient.rs, line 148).`,
  "The CA of istiod signs the lifetime of the request. Only a lifetime above 90 days fails, and no minimum exists (server.go of Istio 1.31.3, lines 113–118, and ca.go, lines 460–469).",
  `The CA backdates each certificate by ${say(CLOCK_SKEW)} (generate_cert.go, lines 285 and 339–351).`,
  `The renewal of ztunnel comes at the middle of the validity, ${say(RENEWAL)} after the issue (certificate.rs, lines 402–408).`,
  `Thus the certificate of each tunnel expires at most ${say(CERT_LIFETIME)} after the start of the tunnel. Each tunnel starts before the fault.`,
  "A new connection of the pool takes the current certificate, and the peer reads it only at the handshake (pool.rs, line 86, and inbound.rs, lines 768–774).",
  "A renewal changes the certificate only for new connections, and it touches no open one (manager.rs, lines 408–431).",
  "Only a revocation in the CRL ends an open tunnel for its certificate (pool.rs, lines 102–112, h2/client.rs, lines 238–250, and h2/server.rs, lines 175–185).",
  "The release of the pool only drops its reference, and HTTP/2 keeps a connection with an open stream (pool.rs, lines 142–146).",
  "The flow of each client is an open stream on its tunnel, thus no release closes the tunnel.",
  `The hold is ${say(EXPIRY_HOLD)}, thus each certificate in use at the fault expires in the hold.`,
  "Thus no socket of a client ends, and the first call after the heal goes on the socket of its last call before the fault.",
  "The law O22 is violated: the tunnel outlives its certificate. The lines certificates show the validity of each leaf at the fault and at the heal.",
].join(" ");

/**
 * These are the gRPC cells of T15 for the kind lab. They are two calibrations, the deletion, the
 * policy, the reset, the black hole, the gap and the restarts of ztunnel. The borders of O03, O17,
 * O02 and O22 are cells too.
 */
export const T15_GRPC: readonly KindCell[] = [
  {
    ...BASE,
    id: "CAL.T15.sidecar",
    name: "T15 sidecar, gRPC, the propagation of a deletion to each client sidecar, preStop 10 s",
    trigger: { kind: "pod-deletion" },
    pod: { ...kubeDefaults(2), preStop: s(10), grace: s(40) },
    prediction: {
      kind: "none",
      why: "grpc-go gets SIGTERM after a preStop sleep of 10 s. EDS drops the terminating endpoint before that (endpoint_builder.go of Istio 1.31.3, lines 623–632), thus each call goes to the other replica",
    },
    calibrates: true,
  },
  {
    ...BASE,
    id: "T15.defaults.13",
    name: "T15 sidecar, gRPC, pod deletion: the retries of the client sidecar, no preStop",
    trigger: { kind: "pod-deletion" },
    pod: kubeDefaults(2),
    prediction: sidecarDeletion(P_EDS, DELETION_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    id: "CAL.T15.policy",
    name: "T15 sidecar, gRPC, the propagation of a policy to each server sidecar, an account that no pod has",
    trigger: { kind: "authorization-policy", hold: POLICY_HOLD, account: "lab-absent" },
    pod: kubeDefaults(2),
    prediction: {
      kind: "none",
      why: "The policy denies the account lab-absent, and no pod has it. The chain of each server sidecar changes in place, and its open connection drains with a GOAWAY notice, thus no call fails (conn_manager_impl.cc of Envoy v1.39.4, lines 1959–1968)",
    },
    calibrates: true,
  },
  {
    ...BASE,
    id: "T15.defaults.5",
    name: "T15 sidecar, gRPC, an AuthorizationPolicy that denies the clients for 15 s",
    trigger: { kind: "authorization-policy", hold: POLICY_HOLD },
    pod: kubeDefaults(2),
    prediction: policyWindow(P_LDS, POLICY_HOLD, POLICY_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: AMBIENT,
    id: "T15.defaults.12",
    name: "T15 ambient, gRPC, a reset of the HBONE leg for 10 s: the backoff of grpc-js through ztunnel",
    trigger: { kind: "rst", hold: RESET_HOLD },
    pod: kubeDefaults(2),
    prediction: resetWindow(RESET_HOLD, RESET_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: AMBIENT,
    id: "T15.defaults.2",
    name: "T15 ambient, gRPC, a black hole on the HBONE leg for 45 s: the PING of ztunnel ends the connection",
    trigger: { kind: "blackhole", hold: BLACKHOLE_HOLD },
    pod: kubeDefaults(2),
    prediction: blackholeWindow(BLACKHOLE_HOLD, BLACKHOLE_WHY, BLACKHOLE_WINDOW_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: AMBIENT,
    id: "T15.defaults.10",
    name: "T15 ambient, gRPC, the clients send no call for 330 s: nothing in the mesh ends the connection",
    trigger: { kind: "idle", hold: IDLE_HOLD },
    pod: kubeDefaults(2),
    prediction: { kind: "ends", from: "fault", band: null, why: IDLE_WHY },
    calibrates: false,
  },
  {
    ...BASE,
    mesh: AMBIENT,
    substitutes: MIDDLEBOX_HOP,
    id: "T15.border-off.79",
    name: "T15 ambient, gRPC, a gap of 120 s through a stateful middlebox that forgets an idle flow at 11 s: the PING of ztunnel keeps the tunnel",
    trigger: { kind: "idle", hold: MIDDLEBOX_HOLD, middlebox: MIDDLEBOX_INSIDE },
    pod: kubeDefaults(2),
    prediction: { kind: "ends", from: "fault", band: null, why: MIDDLEBOX_INSIDE_WHY },
    calibrates: false,
  },
  {
    ...BASE,
    mesh: AMBIENT,
    substitutes: MIDDLEBOX_HOP,
    id: "T15.border-off.80",
    name: "T15 ambient, gRPC, a gap of 60 s through a stateful middlebox that forgets an idle flow at 9 s: the PING timeout ends the tunnel",
    trigger: { kind: "idle", hold: FORGET_HOLD, middlebox: MIDDLEBOX_OUTSIDE },
    pod: kubeDefaults(2),
    prediction: forgetEnds(MIDDLEBOX_OUTSIDE, MIDDLEBOX_OUTSIDE_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: AMBIENT,
    id: "T15.border-off.87",
    name: "T15 ambient, gRPC, quiet clients behind a black hole for 45 s with tcp_retries2 6: the PING of ztunnel ends the tunnel before TCP gives up",
    trigger: { kind: "blackhole", hold: BLACKHOLE_HOLD, quiet: true, retries: RETRIES_INSIDE },
    pod: kubeDefaults(2),
    prediction: pingFirstEnds(RETRIES_INSIDE, PING_FIRST_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: AMBIENT,
    id: "T15.border-off.88",
    name: "T15 ambient, gRPC, quiet clients behind a black hole for 45 s with tcp_retries2 4: TCP gives up before the PING timeout of ztunnel",
    trigger: { kind: "blackhole", hold: BLACKHOLE_HOLD, quiet: true, retries: RETRIES_OUTSIDE },
    pod: kubeDefaults(2),
    prediction: giveUpFirstEnds(RETRIES_OUTSIDE, GIVE_UP_FIRST_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: SIDECAR_IN_AMBIENT,
    id: "T15.defaults.14",
    name: "T15 sidecar in the ambient flavor, gRPC, a restart of ztunnel on each node: a control, ztunnel is on no path",
    trigger: { kind: "ztunnel-restart" },
    pod: kubeDefaults(2),
    prediction: { kind: "none", why: CONTROL_WHY },
    calibrates: false,
  },
  {
    ...BASE,
    mesh: deadlineMesh(DEADLINE_INSIDE),
    id: "T15.border-off.85",
    name: "T15 ambient, gRPC, a restart of ztunnel with a deadline of 29 s in a grace of 30 s: ztunnel ends the connection",
    trigger: { kind: "ztunnel-restart" },
    pod: kubeDefaults(2),
    prediction: restartEnds(DEADLINE_INSIDE, INSIDE_WHY, RESTART_WINDOW_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: deadlineMesh(DEADLINE_OUTSIDE),
    id: "T15.border-off.86",
    name: "T15 ambient, gRPC, a restart of ztunnel with a deadline of 31 s in a grace of 30 s: the kill at the grace ends the connection",
    trigger: { kind: "ztunnel-restart" },
    pod: kubeDefaults(2),
    prediction: restartEnds(DEADLINE_OUTSIDE, OUTSIDE_WHY, RESTART_WINDOW_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: AMBIENT,
    id: "T15.border-off.77",
    name: "T15 ambient, gRPC, a new channel for 5 s at the start of a gap of 330 s: the pool of ztunnel releases the tunnel 300 s after its last checkout",
    trigger: { kind: "idle", hold: IDLE_HOLD, close: true },
    pod: kubeDefaults(2),
    prediction: releaseEnds(IDLE_HOLD, RELEASE_WHY),
    calibrates: false,
  },
  {
    ...BASE,
    mesh: certificateMesh(CERT_LIFETIME),
    id: "T15.border-off.92",
    name: "T15 ambient, gRPC, busy clients for 630 s with certificates of 600 s: the tunnel outlives its certificate",
    trigger: { kind: "certificate-expiry", hold: EXPIRY_HOLD },
    pod: kubeDefaults(2),
    prediction: { kind: "ends", from: "fault", band: null, why: EXPIRY_WHY },
    calibrates: false,
  },
];

/** These are the cells of the plan over grpc-go in T15 that wait, each with the reason from the source of ztunnel 1.31.3. */
export const T15_GRPC_WAITING: readonly Waiting[] = [
  {
    plan: "T15.border-off.78",
    trigger: "border",
    why: [
      "outside O02 needs a release of the pool at or past an idle close of the peer, and the peer ztunnel has no idle close.",
      "Its HBONE server ends a connection only at the close of the client, a failed PING, a drain or a revocation (h2/server.rs, lines 140–186).",
      "Its builder sets no idle timeout (lines 110–124). The release only drops the reference of the pool, and it closes nothing (pool.rs, lines 142–146).",
      "Thus no value of POOL_UNUSED_RELEASE_TIMEOUT puts the pair outside the boundary",
    ].join(" "),
  },
  {
    plan: "T15.border-off.91",
    trigger: "border",
    why: [
      "inside O22 needs a maximum age of an HBONE connection below the lifetime of its certificate, and ztunnel has no maximum age.",
      "Its pool has only POOL_MAX_STREAMS_PER_CONNECTION and POOL_UNUSED_RELEASE_TIMEOUT (config.rs, lines 74–75 and 790–797).",
      "The count of streams is of open streams, and the end of each stream gives one back (h2/client.rs, lines 82–90 and 111–122).",
      "Thus no knob of ztunnel ends a busy tunnel before its certificate expires.",
      "A maximum age of grpc-go is a knob of the server, not of ztunnel: that is another pair",
    ].join(" "),
  },
];

/** These are the cells of the plan over grpc-go in T15 that are cells of this catalog under other names. */
export const T15_GRPC_ALIASES: readonly Alias[] = [
  {
    plan: "T15.array.13",
    is: "T15.defaults.13",
    why: "DP51 is the sidecar at the defaults of Istio 1.31: a terminationDrainDuration of 5 s, native sidecars on, and no DestinationRule, thus no pool settings and no outlier detection. Each one is a default of the install of the lab, as in T15.defaults.13",
  },
  {
    plan: "T15.array.5",
    is: "T15.defaults.5",
    why: "DP51 sets no knob on the path of a policy: the debounce of istiod, the drain of a filter chain and the retry policy are at the defaults of Istio 1.31, as in T15.defaults.5",
  },
  {
    plan: "T15.array.12",
    is: "T15.defaults.12",
    why: "DP36 sets the locality load balancing and the outlier detection of a DestinationRule. ztunnel reads neither of them on an L4 path: its workload API has only routing preferences and a health policy (workload.proto of ztunnel 1.31.3, lines 148–198). Thus the reset is the one of T15.defaults.12",
  },
  {
    plan: "T15.array.2",
    is: "T15.defaults.2",
    why: "DP51 is the sidecar at the defaults of Istio 1.31, and it has no knob of ztunnel. The PING, the connect timeout and the keepalive of ztunnel are constants or variables of its process (h2.rs and proxy.rs of ztunnel 1.31.3). Thus the black hole is the one of T15.defaults.2",
  },
  {
    plan: "T15.array.10",
    is: "T15.defaults.10",
    why: "DP52 sets lifecycle knobs of the sidecar and a DestinationRule. A pod of the ambient mesh has no sidecar, and ztunnel reads no field of a DestinationRule on an L4 path (workload.proto of ztunnel 1.31.3, lines 148–198). Thus the gap is the one of T15.defaults.10",
  },
  {
    plan: "T15.array.14",
    is: "T15.defaults.14",
    why: "DP51 is the sidecar at the defaults of Istio 1.31, and it sets no knob of ztunnel. The pods have sidecars, thus ztunnel is on no path, as in T15.defaults.14",
  },
];
