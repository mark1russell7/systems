import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The sources of the two proxies below. Toxiproxy is github.com/Shopify/toxiproxy at the tag v2.12.0
// (commit 3ccd6a79cbc6), with go.mod at go 1.23.0. docker-proxy is cmd/docker-proxy of github.com/moby/moby
// at the tag docker-v29.1.5 (commit 3b01d641ef33), the proxy of Docker Engine 29.1.5, built with
// go1.25.6. Each line number is a line of that file at the tag. A fact of Linux is from v6.6.
const TOXI = "toxiproxy v2.12.0";
const MOBY = "moby docker-v29.1.5";

/** These are the facts of Go that both proxies share: the TCP keepalive of a socket that the caller does not set. */
const GO_KEEPALIVE = [
  { ref: "go1.23.0 and go1.25.6 src/net/dial.go:19-26 the defaults of the TCP keepalive: 15 s idle, 15 s between probes, 9 probes", rung: "implemented" },
  {
    ref: "go1.23.0 and go1.25.6 src/net/tcpsock_posix.go:121, :158-164 and tcpsock.go:289-305 an accepted and a dialed connection get the KeepAlive of a zero ListenConfig or Dialer: on, with the defaults",
    rung: "implemented",
  },
  { ref: "linux v6.6 net/ipv4/tcp.c:2781-2807 the close of a socket with unread bytes in its receive queue sends a reset, and else a FIN", rung: "implemented" },
] as const;

/** These are the knobs of the TCP keepalive of Go, which each socket of the two proxies gets. */
const GO_KNOBS = {
  keepidle: { key: "the TCP keepalive idle of Go", scope: "process", unit: "s", default: 15, note: "dial.go:23: no caller sets it" },
  keepintvl: { key: "the TCP keepalive interval of Go", scope: "process", unit: "s", default: 15, note: "dial.go:24" },
  keepcnt: { key: "the TCP keepalive count of Go", scope: "process", unit: "count", default: 9, note: "dial.go:26" },
  slack: { key: "the lateness of the scheduler of Go for one copy", scope: "process", unit: "s", default: 0.01, note: "An assumption of this document, not a value of the proxy" },
  hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null, note: "The build option of the kernel" },
} as const;

/** These are the events of a proxied connection: one socket toward the client, and one toward the upstream. */
const EVENTS = {
  "local.accept": { kind: "local", note: "The listener accepts a connection of the client" },
  "local.dialed": { kind: "local", note: "The connect to the upstream completes" },
  "local.dial-failed": { kind: "local", note: "The connect to the upstream fails" },
  "peer.client-fin": { kind: "peer", note: "The client ends its side: an end of file for the proxy" },
  "peer.upstream-fin": { kind: "peer", note: "The upstream ends its side: an end of file for the proxy" },
  "peer.client-rst": { kind: "peer", note: "A reset of the socket toward the client: its read fails with ECONNRESET" },
  "peer.upstream-rst": { kind: "peer", note: "A reset of the socket toward the upstream: its read fails with ECONNRESET" },
  "app.stop": { kind: "app", note: "SIGINT or SIGTERM to the process of the proxy" },
  "tx.client-fin": { kind: "tx", note: "The proxy ends its side toward the client: a FIN, or a reset when bytes are unread" },
  "tx.upstream-fin": { kind: "tx", note: "The proxy ends its side toward the upstream: a FIN, or a reset when bytes are unread" },
} as const;

/** This function gives the TCP socket under each side of a proxied connection: the keepalive of Go, and no other option. */
const overOf = (states: readonly string[]) => ({
  machine: "systems.machine.linux-tcp",
  states: Object.fromEntries(states.map((state) => [state, "ESTABLISHED"])),
  sets: {
    keepidle: { knob: "keepidle", unit: "s" },
    keepintvl: { knob: "keepintvl", unit: "s" },
    keepcnt: { knob: "keepcnt", unit: "count" },
  },
  ends: "peer.client-rst",
  note: "Each socket of the proxy, toward the client and toward the upstream: a Linux TCP socket with the keepalive of Go. A peer that is gone ends it at 15 + 9 × 15 = 150 s",
});

/**
 * This document is one proxied connection of Toxiproxy 2.12.0, with no toxic. Toxiproxy copies TCP, and it
 * knows no protocol above it. It has no timer on a link. Each socket gets the TCP keepalive of Go. It has
 * no half-close: an end of file or an error on either side closes both sockets. A stop of the process
 * shuts down only the HTTP API, and the exit of the process then closes each socket.
 */
export const TOXIPROXY_LINK: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "toxiproxy-link",
  title: "Toxiproxy 2.12.0 with no toxic: one proxied TCP connection, its two links and its close",
  layer: "proxy",
  version: "2.12.0",
  conditions: { toxiproxy: "v2.12.0", go: "1.23.0 or later", proxy: "one proxy from the configuration file, with no toxic" },
  sources: [
    { ref: `${TOXI} proxy.go:113, :183, :206, :221-222 the listener, the accept, the dial of the upstream in the loop of the accepts, and the two links`, rung: "implemented" },
    { ref: `${TOXI} proxy.go:182-214 the dial has no timeout of its own. While it waits, the loop accepts no other client. A failed dial closes the client`, rung: "implemented" },
    { ref: `${TOXI} toxic_collection.go:30-44 and toxics/noop.go:6-18 each direction starts with the noop toxic, which copies each chunk and closes its output when its input closes`, rung: "implemented" },
    { ref: `${TOXI} link.go:116-168 a link copies with io.Copy and no deadline. At an end of file or an error of its source, it closes its input. Its writer then calls Close on its destination: a full close, with no CloseWrite`, rung: "implemented" },
    { ref: `${TOXI} link.go:95-107 only the toxic reset_peer sets SO_LINGER(0), thus with no toxic the proxy sends no reset on purpose`, rung: "implemented" },
    { ref: `${TOXI} cmd/server/server.go:53-60, :101-109 and api.go:75-88 SIGINT and SIGTERM shut down the HTTP API, and the process exits. The proxies and their links do not close first`, rung: "implemented" },
    ...GO_KEEPALIVE,
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the accept of the client" },
    dialing: { note: "The accepted client, while the proxy dials the upstream in its loop of accepts" },
    linked: { note: "Both links copy: the client to the upstream, and the upstream to the client" },
    ended: { final: true, note: "Both sockets closed" },
  },
  events: EVENTS,
  knobs: GO_KNOBS,
  timers: {},
  transitions: [
    { id: "tl.accept", from: "[none]", to: "dialing", on: "local.accept", source: "proxy.go:183-206" },
    { id: "tl.dialed", from: "dialing", to: "linked", on: "local.dialed", source: "proxy.go:206, :221-222" },
    { id: "tl.dial-failed", from: "dialing", to: "ended", on: "local.dial-failed", emits: ["tx.client-fin"], note: "The client is closed. Its unread preface makes that close a reset", source: "proxy.go:206-214" },
    {
      id: "tl.upstream-end",
      from: "linked",
      to: "ended",
      on: ["peer.upstream-fin", "peer.upstream-rst"],
      emits: ["tx.client-fin", "tx.upstream-fin"],
      note: "The link from the upstream ends. Its writer closes the client after the bytes it holds. The read of the other link then fails, and it closes the upstream: no half-close",
      source: "link.go:122-133, :152-163, toxics/noop.go:11-14",
    },
    {
      id: "tl.client-end",
      from: "linked",
      to: "ended",
      on: ["peer.client-fin", "peer.client-rst"],
      emits: ["tx.upstream-fin", "tx.client-fin"],
      note: "The same close from the side of the client: the upstream gets a full close",
      source: "link.go:122-133, :152-163",
    },
    {
      id: "tl.stop",
      from: ["dialing", "linked"],
      to: "ended",
      on: "app.stop",
      emits: ["tx.client-fin", "tx.upstream-fin"],
      note: "The process exits after the shutdown of its HTTP API, and the kernel closes each socket: a FIN, or a reset when bytes are unread",
      source: "cmd/server/server.go:101-109, api.go:75-88",
    },
  ],
  over: overOf(["linked"]),
});

/**
 * This document is one proxied connection of docker-proxy, the userland proxy of Docker Engine 29.1.5. It
 * copies TCP with two goroutines and knows no protocol above it. It has no timer. Each socket gets the
 * TCP keepalive of Go. An end of file of one side passes as a half-close. A reset of one side becomes a
 * FIN toward the other side. A stop of the process, which Docker sends at a stop or a restart of the
 * container, closes each connection fully.
 */
export const DOCKER_PROXY_LINK: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "docker-proxy-link",
  title: "docker-proxy of Docker Engine 29.1.5: one proxied TCP connection, its two copies and its close",
  layer: "proxy",
  version: "29.1.5",
  conditions: { docker: "Engine 29.1.5", go: "1.25.6", proxy: "one TCP port binding, as dockerd starts it for a published port" },
  sources: [
    { ref: `${MOBY} cmd/docker-proxy/tcp_proxy_linux.go:27-77 the whole TCP path: the accept, net.DialTCP to the container, and two io.Copy goroutines. No deadline and no timer`, rung: "implemented" },
    {
      ref: `${MOBY} cmd/docker-proxy/tcp_proxy_linux.go:36-41 at the end of one copy, CloseRead of its source and CloseWrite of its destination: a FIN passes as a half-close, and a reset of the source becomes a FIN`,
      rung: "implemented",
    },
    { ref: `${MOBY} cmd/docker-proxy/tcp_proxy_linux.go:28-33 a failed dial closes the client at once`, rung: "implemented" },
    { ref: `${MOBY} cmd/docker-proxy/main_linux.go:188-197 SIGINT and SIGTERM close the listener, and the process exits`, rung: "implemented" },
    { ref: `${MOBY} daemon/libnetwork/portmapper/proxy_linux.go:133-143 dockerd stops a proxy with SIGINT when it removes its port binding: at a stop or a restart of the container`, rung: "implemented" },
    { ref: `${MOBY} daemon/command/config_unix.go:39 the userland proxy is on at the defaults, for the traffic to a published port on the loopback of the host`, rung: "implemented" },
    ...GO_KEEPALIVE,
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the accept of the client" },
    dialing: { note: "The accepted client, while its goroutine dials the container" },
    linked: { note: "Both copies run" },
    "half-closed": { note: "One copy ended at an end of file or a reset. The other copy goes on" },
    ended: { final: true, note: "Both sockets closed" },
  },
  events: EVENTS,
  knobs: GO_KNOBS,
  timers: {},
  transitions: [
    { id: "dp.accept", from: "[none]", to: "dialing", on: "local.accept", source: "tcp_proxy_linux.go:63-73" },
    { id: "dp.dialed", from: "dialing", to: "linked", on: "local.dialed", source: "tcp_proxy_linux.go:28-35" },
    { id: "dp.dial-failed", from: "dialing", to: "ended", on: "local.dial-failed", emits: ["tx.client-fin"], source: "tcp_proxy_linux.go:28-33" },
    {
      id: "dp.upstream-end",
      from: "linked",
      to: "half-closed",
      on: ["peer.upstream-fin", "peer.upstream-rst"],
      emits: ["tx.client-fin"],
      note: "The copy from the upstream ends, and CloseWrite sends a FIN to the client. A reset of the upstream also gives the client a FIN, not a reset",
      source: "tcp_proxy_linux.go:36-41",
    },
    { id: "dp.client-end", from: "linked", to: "half-closed", on: ["peer.client-fin", "peer.client-rst"], emits: ["tx.upstream-fin"], source: "tcp_proxy_linux.go:36-41" },
    {
      id: "dp.both-ended",
      from: "half-closed",
      to: "ended",
      on: ["peer.client-fin", "peer.client-rst", "peer.upstream-fin", "peer.upstream-rst"],
      note: "The other copy ends, and both sockets close",
      source: "tcp_proxy_linux.go:53-58",
    },
    {
      id: "dp.stop",
      from: ["dialing", "linked", "half-closed"],
      to: "ended",
      on: "app.stop",
      emits: ["tx.client-fin", "tx.upstream-fin"],
      note: "The process exits at once, and the kernel closes each socket fully: a FIN, or a reset when bytes are unread",
      source: "main_linux.go:188-197",
    },
  ],
  over: overOf(["linked", "half-closed"]),
});
