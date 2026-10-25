import { timerOf } from "@mark1russell7/algebra";
import type { KindCell, Mesh, Prediction, Propagation } from "@mark1russell7/kind";
import { EDS_EVERY, LAST_SLACK } from "@mark1russell7/kind";
import { ENVOY_HTTP2, GRPC_JS, GRPC_GO_SERVER, ZTUNNEL_HBONE } from "@mark1russell7/machines";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { given, seconds } from "../catalog.ts";
import type { Calibration } from "../kind.ts";
import { T07_WORKLOAD, WORKERS, calibrated, kubeDefaults, s, say } from "../kind.ts";
import type { Alias } from "../mongo/cells.ts";
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
  `The release of the pool of ztunnel comes ${say(s(ZTUNNEL_HBONE.knobs["pool_release"]!.default!))} after the last stream ends. The flow of the client is an open stream, thus no release closes its connection (pool.rs, lines 142–146).`,
  `The PING of ztunnel keeps the HBONE connection live, and the keepalive of ztunnel sends a probe after ${say(s(ZTUNNEL_HBONE.knobs["keepidle"]!.default!))} idle. A live peer answers each one.`,
  `The keepalive of grpc-go sends its first PING after ${say(s(GRPC_GO_SERVER.knobs["keepalive_time"]!.default!))} (defaults.go of grpc-go v1.84.0, lines 31–40).`,
  "Thus the first call of each client after the gap goes on the socket of its last call before it.",
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

/**
 * These are the gRPC cells of T15 for the kind lab. They are two calibrations, the deletion, the
 * policy, the reset, the black hole, the gap and the restarts of ztunnel.
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
