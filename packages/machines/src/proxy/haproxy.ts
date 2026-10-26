import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact below is the stable branch of HAProxy 3.2 at the tag v3.2.25 (commit
// 70469d33ba0e), in git.haproxy.org/git/haproxy-3.2.git. The repository haproxy/haproxy on GitHub
// holds only the branch of development, not this tag. Each line number is a line of that file at the
// tag. The image of T02 is haproxy:3.2 at a pinned digest, which is HAProxy 3.2.25.
const AT = "haproxy-3.2 v3.2.25";
const ST = "src/stream.c";
const SC = "src/stconn.c";

/**
 * This document is one connection of HAProxy 3.2.25 in TCP mode, with the configuration of T02:
 * `mode tcp`, `timeout client`, `timeout server`, `option clitcpka` and `option srvtcpka`. It sets
 * no `timeout tunnel`, `timeout client-fin`, `timeout server-fin` or `option independent-streams`.
 *
 * - Each side has one inactivity timer: `timeout client` toward the client, and `timeout server`
 *   toward the server. It counts from the last read of bytes from that side, or the last send of
 *   bytes to that side.
 * - Thus each byte that goes through resets the two timers. Its read resets the timer of its
 *   source, and its send resets the timer of its destination. A WebSocket ping and its pong reset both.
 * - A TCP keepalive probe carries no byte. It resets no timer.
 * - `timeout server` sends a FIN to the client at once. `timeout client` sends a FIN to the server
 *   first. The client gets its FIN when the server closes its side.
 * - The clock of HAProxy is in whole ms, read at each wake of its loop. Thus a timer can fire one ms
 *   and one step of the loop early or late.
 */
export const HAPROXY_TCP: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "haproxy-tcp",
  title: "HAProxy 3.2.25 in TCP mode: one proxied connection, the inactivity timer of each side, and its close",
  layer: "proxy",
  version: "3.2.25",
  conditions: {
    haproxy: "v3.2.25 (haproxy:3.2 at the digest of T02)",
    configuration: "mode tcp, timeout client, timeout server, option clitcpka and option srvtcpka; no timeout tunnel, client-fin or server-fin, and no option independent-streams",
  },
  sources: [
    { ref: `${AT} src/proxy.c:557-624 the parse of timeout client, server, tunnel, client-fin and server-fin`, rung: "implemented" },
    { ref: `${AT} ${ST}:527 the timer of the client side is timeout client, and ${ST}:986-987 the timer of the server side is timeout server, from the connect`, rung: "implemented" },
    { ref: `${AT} ${SC}:394-398 the attach of the stream starts the timer of the client, and ${ST}:980 the connect starts the timer of the server`, rung: "implemented" },
    { ref: `${AT} include/haproxy/sc_strm.h:401-406 the read timer of a side expires at its last activity plus its timeout, and :408-413 the send timer runs only while a send is blocked`, rung: "implemented" },
    { ref: `${AT} include/haproxy/stconn.h:194-198 an activity is now_ms, and ${SC}:1538-1544 a read of bytes reports one`, rung: "implemented" },
    { ref: `${AT} include/haproxy/stconn.h:206-223 and ${SC}:1801-1803, :1817 a send of bytes reports one, because no option independent-streams sets SC_FL_INDEP_STR (${ST}:485-489, src/proxy.c:2573-2575)`, rung: "implemented" },
    { ref: `${AT} ${ST}:1594-1630 the expiry of the client side aborts the client side (:1609-1614), and the expiry of the server side aborts the server side (:1621-1626)`, rung: "implemented" },
    { ref: `${AT} ${ST}:2417-2429 an abort of the client side shuts the server side: a FIN to the server`, rung: "implemented" },
    { ref: `${AT} ${ST}:2526-2535 an end or an abort of the server side shuts the client side: a FIN to the client`, rung: "implemented" },
    { ref: `${AT} ${SC}:750-772 an abort does no system call while the side is not shut, and ${SC}:782-837 a shut sends a FIN (:807-809), or closes the socket after an abort (:812)`, rung: "implemented" },
    { ref: `${AT} ${ST}:2497-2506 timeout tunnel replaces the two timers in TCP mode when it is set. T02 does not set it`, rung: "implemented" },
    { ref: `${AT} src/session.c:266-267 and src/proto_tcp.c:405-406 option clitcpka and srvtcpka set SO_KEEPALIVE, with the keepalive sysctls of the namespace`, rung: "implemented" },
    { ref: `${AT} src/ev_epoll.c:244-251 the loop waits in epoll_wait, then reads the clock; src/fd.c:1072-1088 the wait is the time to the next timer plus 1 ms; src/clock.c:256 now_ms is that clock in whole ms`, rung: "implemented" },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the accept of the connection of the client" },
    linked: { note: "The two sides are open, and each copies bytes to the other. The two timers run" },
    "upstream-shut": { note: "After timeout client: HAProxy sent a FIN to the server, and it waits for the end of the server side" },
    ended: { final: true, note: "The two sides are closed" },
  },
  events: {
    "local.accept": { kind: "local", note: "The accept of the client, and the attach of its stream" },
    "local.dialed": { kind: "local", note: "The connect to the server completes" },
    "rx.client-data": { kind: "rx", note: "A read of bytes from the client" },
    "tx.client-data": { kind: "tx", note: "A send of bytes to the client" },
    "rx.upstream-data": { kind: "rx", note: "A read of bytes from the server" },
    "tx.upstream-data": { kind: "tx", note: "A send of bytes to the server" },
    "timer.client": { kind: "timer", note: "No activity on the client side for timeout client" },
    "timer.server": { kind: "timer", note: "No activity on the server side for timeout server" },
    "peer.client-fin": { kind: "peer", note: "The client ends its side: an end of file for HAProxy" },
    "peer.upstream-fin": { kind: "peer", note: "The server ends its side: an end of file for HAProxy" },
    "peer.client-rst": { kind: "peer", note: "A reset of the socket toward the client" },
    "peer.upstream-rst": { kind: "peer", note: "A reset of the socket toward the server" },
    "tx.client-fin": { kind: "tx", note: "HAProxy ends its side toward the client: a FIN" },
    "tx.upstream-fin": { kind: "tx", note: "HAProxy ends its side toward the server: a FIN" },
  },
  knobs: {
    timeout_client: { key: "timeout client", scope: "frontend", unit: "s", default: null, off: 0, note: "No default: with no value, or 0, the client side has no timer. T02 sets it" },
    timeout_server: { key: "timeout server", scope: "backend", unit: "s", default: null, off: 0, note: "No default: with no value, or 0, the server side has no timer. T02 sets it" },
    tick: { key: "now_ms, the clock of HAProxy", scope: "process", unit: "s", default: 0.001, note: "clock.c:256: whole ms. fd.c:1083 adds 1 ms to each wait" },
    slack: { key: "the time of HAProxy for one step of its loop", scope: "process", unit: "s", default: 0.01, note: "An assumption of this document, not a value of HAProxy" },
  },
  timers: {
    timeout_client: {
      duration: { knob: "timeout_client", unit: "s" },
      lateness: { expr: "tick + slack", unit: "s" },
      early: { expr: "tick + slack", unit: "s" },
      arms: ["local.accept", "rx.client-data", "tx.client-data"],
      fires: "timer.client",
      note: "From the last read from the client or send to the client. The activity is the clock of the wake, in whole ms: up to one ms and one step before the read or the send",
    },
    timeout_server: {
      duration: { knob: "timeout_server", unit: "s" },
      lateness: { expr: "tick + slack", unit: "s" },
      early: { expr: "tick + slack", unit: "s" },
      arms: ["local.dialed", "rx.upstream-data", "tx.upstream-data"],
      fires: "timer.server",
      note: "From the last read from the server or send to the server, with the same clock",
    },
  },
  realizes: {
    // the earlier of the two timers forgets an idle connection: O03 reads it as the idle timeout of a middlebox
    "systems.mechanism.middlebox-idle": {
      duration: { expr: "min(timeout_client, timeout_server)", unit: "s" },
      lateness: { expr: "tick + slack", unit: "s" },
      early: { expr: "tick + slack", unit: "s" },
      note: "Only bytes reset it. A TCP keepalive probe carries none",
    },
  },
  transitions: [
    { id: "hp.accept", from: "[none]", to: "linked", on: "local.accept", timer: "timeout_client", source: "stconn.c:394-398, stream.c:527" },
    { id: "hp.dialed", from: "linked", to: "linked", on: "local.dialed", timer: "timeout_server", source: "stream.c:980, :986-987" },
    {
      id: "hp.bytes",
      from: "linked",
      to: "linked",
      on: ["rx.client-data", "tx.upstream-data", "rx.upstream-data", "tx.client-data"],
      note: "A read resets the timer of its source, and a send resets the timer of its destination",
      source: "stconn.c:1538-1544, :1801-1803, :1817",
    },
    {
      id: "hp.server-timeout",
      from: "linked",
      to: "ended",
      on: "timer.server",
      timer: "timeout_server",
      emits: ["tx.client-fin"],
      note: "The server side is aborted, and the client side is shut at once: a FIN to the client",
      source: "stream.c:1621-1626, :2526-2535",
    },
    {
      id: "hp.client-timeout",
      from: "linked",
      to: "upstream-shut",
      on: "timer.client",
      timer: "timeout_client",
      emits: ["tx.upstream-fin"],
      note: "The client side is aborted with no system call, and the server side is shut: a FIN to the server",
      source: "stream.c:1609-1614, :2417-2429, stconn.c:750-772",
    },
    {
      id: "hp.upstream-end",
      from: "upstream-shut",
      to: "ended",
      on: ["peer.upstream-fin", "peer.upstream-rst"],
      emits: ["tx.client-fin"],
      note: "The end of the server side shuts the client side. It closes the socket of the client after its abort",
      source: "stream.c:2526-2535, stconn.c:812",
    },
    {
      id: "hp.client-end",
      from: "linked",
      to: "ended",
      on: ["peer.client-fin", "peer.client-rst"],
      emits: ["tx.upstream-fin"],
      source: "stream.c:2417-2429",
    },
    {
      id: "hp.upstream-close",
      from: "linked",
      to: "ended",
      on: ["peer.upstream-fin", "peer.upstream-rst"],
      emits: ["tx.client-fin"],
      source: "stream.c:2526-2535",
    },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { linked: "ESTABLISHED", "upstream-shut": "ESTABLISHED" },
    sets: {},
    ends: "peer.client-rst",
    note: "Each socket of HAProxy, toward the client and toward the server: a Linux TCP socket with SO_KEEPALIVE and the keepalive sysctls of its namespace",
  },
});
