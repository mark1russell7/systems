import { fileURLToPath } from "node:url";
import { evaluate, timerOf } from "@mark1russell7/automata";
import type { Cell, QueueBand, QueueConnection, QueuePrediction, Target } from "@mark1russell7/harness";
import { LINUX_TCP } from "@mark1russell7/machines";
import { given, HZ, LINUX_66, ms, seconds, s } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";

/**
 * The cells of the accept queue (SYS-63): one listener that does not accept, one client of many
 * connections, and the real kernel between them. Each term of the law is visible in a record. The
 * sources are Linux v7.0, the kernel of the runners.
 *
 * - The count. A full queue has `sk_ack_backlog > sk_max_ack_backlog` (`include/net/sock.h`, lines
 *   1097-1100). Thus it holds the limit plus one. listen(2) clamps the backlog to `somaxconn`
 *   (`net/socket.c`, lines 1922-1924).
 * - A SYN at a full queue. The kernel drops it with no answer (`net/ipv4/tcp_input.c`, lines
 *   7679-7682). The client meets its SYN ladder (`Documentation/networking/ip-sysctl.rst`, lines 1061-1067).
 * - A final ACK at a full queue. The check is in `net/ipv4/tcp_ipv4.c`, lines 1722-1723. With
 *   `tcp_abort_on_overflow` 0, the target keeps the request and drops the ACK (`net/ipv4/tcp_minisocks.c`,
 *   lines 947-955). The client is ESTABLISHED and the target has no connection. With 1, the target
 *   sends a reset (lines 957-970).
 * - The SYN-ACK ladder. The target sends the SYN-ACK again at 1, 3, 7, 15 and 31 s, and it forgets
 *   the request at 63 s (`net/ipv4/inet_connection_sock.c`, lines 1099-1107 and 1139-1141).
 * - The answer of the client. Each SYN-ACK is outside the window of an ESTABLISHED socket. It gets a
 *   challenge ACK (`net/ipv4/tcp_input.c`, lines 6472-6476). That ACK is a new final ACK. If the
 *   queue has a place, the connection recovers.
 * - After the expiry. A segment of the client meets the listener, and it gets a reset
 *   (`net/ipv4/tcp_ipv4.c`, lines 1907-1915).
 */

/** This image is the stock base of the image of the harness, for the record. */
const BASE = "alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62";
/** This port is the listener of the cell. The control port of the target is the next port. */
const PORT = 6390;
/** This time is one way of the path, on the egress of the target: netem delays each SYN-ACK and each reset. */
const LATENCY = 0.02;
/** This time holds the sample of 5 ms of the target and the 4 ms of noise of the harness. */
const SLACK = 0.01;
/** This time is the longest run of the long cells: past the last end that the law gives. */
const LONG_HOLD = 140;
/** This time is the send of the `quiet` connection: after the expiry at 63 s and its lateness. */
const QUIET_AT = 70;
/** This time is the accept of the recovery cell, between the SYN-ACK at 1 s and the one at 3 s. */
const ACCEPT_AT = 2.5;

const HERTZ = { value: HZ, unit: "Hz" };
const LINUX = given({ ...LINUX_66, hz: HERTZ });

const band = (low: number, high: number): QueueBand => ({
  low: s(Math.round(low * 1e6) / 1e6),
  high: s(Math.round(high * 1e6) / 1e6),
});

/** This function gives how late one timer due after `wait` seconds can fire, from the timer wheel of the kernel. */
export const wheelOf = (wait: number): number =>
  seconds(
    evaluate(LINUX_TCP, { model: "linux.wheel", knobs: ["keepidle", "hz"], unit: "s" }, given({ keepidle: s(wait), hz: HERTZ })),
    `the wheel at ${wait} s`,
  );

/** This function gives the band of the wait `k` of the SYN timer of Linux TCP. */
export const synWait = (k: number): QueueBand => {
  const bounds = timerOf(LINUX_TCP, "syn_retransmit", LINUX, k);
  const wait = seconds(bounds.duration, `the wait ${k} of the SYN`);
  return band(wait - seconds(bounds.early, "how early the SYN timer fires") - SLACK, wait + seconds(bounds.lateness, "how late the SYN timer fires") + SLACK);
};

/** This function gives the band of the end of a connect that nothing answers, from the document of Linux TCP. */
export const synGiveup = (): QueueBand => {
  const bounds = timerOf(LINUX_TCP, "syn_giveup", LINUX);
  const end = seconds(bounds.duration, "the end of the SYN");
  return band(end - seconds(bounds.early, "how early the end comes") - SLACK, end + seconds(bounds.lateness, "how late the end comes") + SLACK);
};

/** This function gives the wait `k` of the SYN-ACK timer: 1 s doubled at each firing (`tcp_reqsk_timeout`). */
const synAckTimer = (k: number): number => 2 ** k;

/** This function gives the band of the wait `k` of a SYN-ACK at the client. The first wait counts from the dial, and it holds one way of the path. */
export const synAckWait = (k: number): QueueBand => {
  const wait = synAckTimer(k);
  const path = k === 0 ? LATENCY : 0;
  return band(wait + path - 1 / HZ - SLACK, wait + path + wheelOf(wait) + SLACK);
};

/** This function gives the band of the firing of the SYN-ACK timer after the given count of waits, from the arming of the timer. */
export const synAckFiring = (waits: number): QueueBand => {
  const all = Array.from({ length: waits }, (_, k) => synAckTimer(k));
  const sum = all.reduce((total, wait) => total + wait, 0);
  const late = all.reduce((total, wait) => total + wheelOf(wait), 0);
  return band(sum - waits / HZ - SLACK, sum + late + SLACK);
};

/** This band is the time from a segment or a final ACK of the client to the reset of the target. */
const RESET = band(LATENCY - SLACK, 2 * LATENCY + SLACK);

const TARGET: Target = {
  image: BASE,
  subject: { kind: "shipped", name: "harness" },
  command: ["/opt/harness/queue", "target", String(PORT)],
  port: PORT,
  ready: "listening",
  lines: true,
};

/** These are the settings of a cell: the backlog of listen(2), the steps of the client, and the sysctls of the two sides. */
export interface QueueSpec {
  readonly plan: string;
  readonly name: string;
  readonly backlog: number;
  readonly somaxconn: number;
  readonly abort: 0 | 1;
  readonly flags: readonly string[];
  readonly latency: boolean;
  readonly window: number;
  readonly why: string;
  readonly queue: QueuePrediction;
}

/** This folder is the build context of the target of a declared backlog: its Dockerfile, its lockfile and its scripts. */
const SERVICE_CONTEXT = fileURLToPath(new URL("../targets/service-backlog/", import.meta.url));
/** These are the files of that build context. */
const SERVICE_FILES = ["Dockerfile", "package.json", "npm-lock.json", "server.ts", "control.ts", "proc.ts", "emit.ts"];
/** This is the version of the service in that target. The name of each cell has its MAJOR and MINOR. */
export const BACKLOG_SERVICE = "0.7.3";
const BACKLOG_LABEL = BACKLOG_SERVICE.split(".").slice(0, 2).join(".");

/**
 * This target is a server of the service (SYS-103): `httpTransport` with the knob
 * `server_listen_backlog`, over the http.Server of Node. Its main thread blocks, thus Node accepts
 * nothing. It serves the protocol of the native target, thus the client is the same.
 */
const SERVICE_TARGET: Target = {
  image: NODE_IMAGE,
  subject: { kind: "build", name: "service-backlog", context: SERVICE_CONTEXT, files: SERVICE_FILES },
  command: ["node", "/srv/server.ts", "--port", String(PORT)],
  port: PORT,
  ready: '"ev":"listening"',
  lines: true,
};

const queueCell = (spec: QueueSpec, target: Target = TARGET): Cell => ({
  name: `${spec.plan} ${spec.name}`,
  target,
  sysctls: { "net.ipv4.tcp_syn_retries": "6", "net.ipv4.tcp_syn_linear_timeouts": "4" },
  targetSysctls: {
    "net.core.somaxconn": String(spec.somaxconn),
    "net.ipv4.tcp_abort_on_overflow": String(spec.abort),
    "net.ipv4.tcp_synack_retries": "5",
    "net.ipv4.tcp_syncookies": "1",
  },
  client: {
    image: { kind: "shipped", name: "harness" },
    command: ["/opt/harness/queue", "client", "--backlog", String(spec.backlog), ...spec.flags],
  },
  probe: { mode: "idle", keepalive: false },
  fault: "none",
  ...(spec.latency ? { latency: ms(LATENCY * 1000) } : {}),
  prediction: { detects: null, window: s(spec.window), why: spec.why, queue: spec.queue },
  runs: 4,
  environments: 2,
  concurrency: 1,
});

/** This function gives a cell of the count: a client that connects one at a time until `attempts`, with no accept. */
const countSpec = (plan: string, name: string, backlog: number, somaxconn: number, attempts: number, limit: number): QueueSpec => ({
  plan,
  name,
  backlog,
  somaxconn,
  abort: 0,
  flags: ["--fill", String(attempts)],
  latency: false,
  window: 5,
  why: "listen(2) clamps the backlog to somaxconn, and the queue holds the limit plus one. Each later SYN is one overflow.",
  queue: {
    max: limit,
    held: limit + 1,
    connected: limit + 1,
    overflows: { low: attempts - limit - 1, high: attempts - limit - 1 },
    resets: 0,
    connections: [],
  },
});

const CONNECTED: QueueConnection = { name: "in", connects: true, ends: null, unacked: 0 };
/** The waits of the two connections whose final ACK overflowed: five SYN-ACKs, until the target forgets them. */
const FIVE_SYN_ACKS: readonly QueueBand[] = [0, 1, 2, 3, 4].map(synAckWait);
/** The burst fills the queue from the fourth place: `in` takes the last place, and the other two overflow. */
const BURST_FLAGS = ["--fill", "4", "--burst", "3"];

/** These are the laws that the cells check, one cell for each. */
export const ACCEPT_QUEUE_SPECS: readonly QueueSpec[] = [
  countSpec("AQ.1", "the count: a backlog of 4 under a somaxconn of 4096 holds 5", 4, 4096, 7, 4),
  countSpec("AQ.2", "the count: somaxconn 8 clamps a backlog of 511, and the queue holds 9", 511, 8, 11, 8),
  countSpec("AQ.3", "the count: a backlog of 0 holds 1", 0, 4096, 3, 0),
  {
    plan: "AQ.4",
    name: "a SYN at a full queue meets the SYN ladder of the client, and ETIMEDOUT",
    backlog: 1,
    somaxconn: 4096,
    abort: 0,
    flags: ["--fill", "2", "--blocked", "--hold-ms", String(LONG_HOLD * 1000)],
    latency: false,
    window: LONG_HOLD + 10,
    why: "The kernel drops each SYN at a full queue with no answer. Each of the 11 SYNs is one overflow, and the connect ends on the timer of the client.",
    queue: {
      max: 1,
      held: 2,
      connected: 2,
      overflows: { low: 11, high: 11 },
      resets: 0,
      connections: [
        {
          name: "blocked",
          connects: false,
          syns: Array.from({ length: 10 }, (_, k) => synWait(k)),
          ends: { errno: "ETIMEDOUT", from: "dial", within: synGiveup() },
        },
      ],
    },
  },
  {
    plan: "AQ.5",
    name: "a final ACK at a full queue: the client connects, the target forgets it at 63 s, and the next segment meets a reset",
    backlog: 4,
    somaxconn: 4096,
    abort: 0,
    flags: [...BURST_FLAGS, "--late-ms", String(QUIET_AT * 1000), "--hold-ms", String(LONG_HOLD * 1000)],
    latency: true,
    window: LONG_HOLD + 10,
    why: "tcp_abort_on_overflow 0 keeps the request and drops the final ACK. The client is ESTABLISHED, and only a later segment tells it the truth. The count of overflows depends on the retransmissions of the client, thus it has a floor and no band.",
    queue: {
      max: 4,
      held: 5,
      connected: 7,
      overflows: { low: 2, high: 1000 },
      resets: 0,
      admitted: "in",
      expiry: { timeouts: 12, within: synAckFiring(6) },
      connections: [
        CONNECTED,
        {
          name: "busy",
          connects: true,
          synAcks: FIVE_SYN_ACKS,
          ends: { errno: "ECONNRESET", from: "dial", within: band(110, 125), retransmitted: RESET },
        },
        { name: "quiet", connects: true, synAcks: FIVE_SYN_ACKS, ends: { errno: "ECONNRESET", from: "sent", within: RESET } },
      ],
    },
  },
  {
    plan: "AQ.6",
    name: "a final ACK at a full queue with tcp_abort_on_overflow 1: connected, then ECONNRESET one round trip later",
    backlog: 4,
    somaxconn: 4096,
    abort: 1,
    flags: [...BURST_FLAGS, "--blocked", "--hold-ms", "600"],
    latency: true,
    window: 5,
    why: "tcp_abort_on_overflow 1 answers an overflow of a final ACK with a reset. A SYN at a full queue stays silent, because the sysctl does not change that path.",
    queue: {
      max: 4,
      held: 5,
      connected: 7,
      overflows: { low: 3, high: 3 },
      resets: 2,
      admitted: "in",
      connections: [
        CONNECTED,
        { name: "busy", connects: true, ends: { errno: "ECONNRESET", from: "connected", within: RESET } },
        { name: "quiet", connects: true, ends: { errno: "ECONNRESET", from: "connected", within: RESET } },
        { name: "blocked", connects: false, syns: [], ends: null },
      ],
    },
  },
  {
    plan: "AQ.7",
    name: "the queue drains before the expiry: the next SYN-ACK brings a challenge ACK, and no connection fails",
    backlog: 4,
    somaxconn: 4096,
    abort: 0,
    flags: [...BURST_FLAGS, "--blocked", "--accept", "3", "--accept-at-ms", String(ACCEPT_AT * 1000), "--hold-ms", "5000", "--drain"],
    latency: true,
    window: 10,
    why: "The request stays until its expiry. The SYN-ACK at 3 s gets a challenge ACK, and that ACK finds a place. The blocked SYN finds a place at its next firing. The count of overflows depends on the retransmissions before the accept, thus its band is wide.",
    queue: {
      max: 4,
      held: 5,
      connected: 8,
      overflows: { low: 9, high: 15 },
      resets: 0,
      admitted: "in",
      rise: { count: 4, within: band(3 + LATENCY - 2 / HZ - SLACK, 3 + LATENCY + wheelOf(1) + wheelOf(2) + SLACK) },
      drained: 8,
      connections: [
        CONNECTED,
        { name: "busy", connects: true, synAcks: FIVE_SYN_ACKS.slice(0, 2), ends: null, unacked: 0 },
        { name: "quiet", connects: true, synAcks: FIVE_SYN_ACKS.slice(0, 2), ends: null, unacked: 0 },
        { name: "blocked", connects: true, syns: [0, 1, 2].map(synWait), ends: null, unacked: 0 },
      ],
    },
  },
];

/** These are the cells of the accept queue, for the harness. */
export const ACCEPT_QUEUE_CELLS: readonly Cell[] = ACCEPT_QUEUE_SPECS.map((spec) => queueCell(spec));

/**
 * These are the laws of `AQ.1` to `AQ.3` with a server of the service as the listener (SYS-103). The
 * service gives the declared backlog to Node, and Node gives it to listen(2). Node calls listen(2)
 * with `backlog || 511` (`lib/net.js` of Node 24.21.0, line 2325). Thus a declared backlog of 0
 * gives 511 in service 0.7.3, and the queue holds 512.
 */
export const SERVICE_QUEUE_SPECS: readonly QueueSpec[] = [
  countSpec("AQ.8", `the count of service ${BACKLOG_LABEL}: a declared backlog of 4 under a somaxconn of 4096 holds 5`, 4, 4096, 7, 4),
  countSpec("AQ.9", `the count of service ${BACKLOG_LABEL}: somaxconn 8 clamps a declared backlog of 511, and the queue holds 9`, 511, 8, 11, 8),
  {
    ...countSpec("AQ.10", `the count of service ${BACKLOG_LABEL}: Node gives listen(2) 511 for a declared backlog of 0, and the queue holds 512`, 0, 4096, 514, 511),
    why: "Node gives listen(2) 511 for a backlog of 0, thus the declared 0 of service 0.7.3 is a limit of 511. The queue holds the limit plus one, and each later SYN is one overflow.",
  },
];

/** These are the cells of a declared backlog, for the harness. */
export const SERVICE_QUEUE_CELLS: readonly Cell[] = SERVICE_QUEUE_SPECS.map((spec) => queueCell(spec, SERVICE_TARGET));
