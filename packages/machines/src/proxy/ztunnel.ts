import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The source of each fact below is github.com/istio/ztunnel at the tag 1.31.3, and
// github.com/istio/istio at the tag 1.31.3 for the node agent of istio-cni and the chart. Each line
// number is a line of that file at the tag. A fact of Linux is from v6.6. The SIGKILL at the end of
// the grace is from github.com/kubernetes/kubernetes at the tag v1.37.0.
const Z = "ztunnel 1.31.3";
const I = "istio 1.31.3";
const K = "kubernetes v1.37.0";

/**
 * This document is ztunnel 1.31.3 in the ambient mesh of Istio, in in-pod mode. It is one HBONE
 * connection from the ztunnel of a client pod to the port 15008 of a server pod. The flows of the
 * apps are its streams. The agent istio-cni redirects each connection of an app to the listener
 * 15001 of ztunnel, in the network namespace of the pod. Thus the HBONE socket has the address of the pod.
 *
 * The PING of the connection has a fixed cadence: 10 s of sleep, a PING, then at most 20 s for its
 * PONG. Both are constants, and data does not put a PING off. Thus a link that fails is found 20 s to
 * 30 s later.
 *
 * At the end of a stream or of its connection, ztunnel shuts down the socket of the app. The app then
 * gets a FIN. The release of the pool closes a connection with no stream, 5 min after its last
 * checkout. No timer closes a connection with an open stream, or an old one.
 *
 * At SIGTERM, ztunnel sends GOAWAY, and it ends what is left at its deadline of 25 s. A deadline longer than the grace of 30 s does not
 * come. The kubelet sends SIGKILL to ztunnel at the end of the grace, and the kernel closes each socket.
 */
export const ZTUNNEL_HBONE: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "ztunnel-hbone",
  title: "ztunnel 1.31.3 in in-pod mode: one HBONE connection from a client pod to a server pod, its PING, its drain and the close of each flow of the app",
  layer: "proxy",
  version: "1.31.3",
  conditions: {
    ztunnel: "1.31.3",
    istio: "1.31.3 with the profile ambient: istio-cni and ztunnel on each node",
    mode: "in-pod: istio-cni redirects the traffic of each pod to the listeners of ztunnel in the network namespace of the pod",
    connection: "one HBONE connection to the port 15008 of a server pod, with mTLS and HTTP/2, and its streams",
  },
  sources: [
    {
      ref: `${Z} src/proxy/h2/client.rs:50-58 and src/proxy/outbound.rs:446-452 the key of the pool: the source identity, the destination identities, the destination address and the source IP. In in-pod mode the destination is the server pod at port 15008`,
      rung: "implemented",
    },
    { ref: `${Z} src/config.rs:74, :106, :790 and src/proxy/h2/client.rs:183-190 at most 100 streams on one HBONE connection`, rung: "implemented" },
    {
      ref: `${Z} src/config.rs:75, :105, :795 and src/proxy/pool.rs:142-176, :338-341 POOL_UNUSED_RELEASE_TIMEOUT is 5 min. Each checkout of a connection, new or used again, puts it back in the pool with a new release timer: the timer counts from the last checkout, the start of the last flow. A release does not close the connection: HTTP/2 closes it when no reference and no stream is left`,
      rung: "implemented",
    },
    { ref: `${Z} src/proxy.rs:645, :695 the TCP connect of ztunnel times out at 10 s, a constant`, rung: "implemented" },
    {
      ref: `${Z} src/proxy/h2.rs:31-76 the PING loop: 10 s of sleep, a PING, at most 20 s for its PONG, then again. PING_INTERVAL and PING_TIMEOUT are constants (:36-37)`,
      rung: "implemented",
    },
    { ref: `${Z} src/proxy/h2.rs:222-225 the PING is not data aware: data on the connection does not put a PING off`, rung: "implemented" },
    { ref: `${Z} src/proxy/h2/client.rs:237-238 and src/proxy/h2/server.rs:160-168 at a PING timeout the client drops the connection, and the server calls abrupt_shutdown(NO_ERROR)`, rung: "implemented" },
    { ref: `${Z} src/proxy/h2.rs:229-238 and src/copy.rs:176-183, :198-212 at the end of a stream or of its connection, the copy loop shuts down the socket of the app: a FIN`, rung: "implemented" },
    { ref: "linux v6.6 net/ipv4/tcp.c:2781-2807 the close of a socket with unread bytes in its receive queue sends a reset, and else a FIN", rung: "implemented" },
    {
      ref: `${Z} src/config.rs:44-48, :355-360, :913-931 and src/proxy.rs:109-126 the TCP keepalive: 180 s idle, 180 s between probes and 9 probes, on each socket that ztunnel connects. No TCP_USER_TIMEOUT`,
      rung: "implemented",
    },
    { ref: `${Z} src/proxy, src/copy.rs and src/config.rs: no idle timeout of L4 and no maximum age of a connection, from a search of the tag`, rung: "derived" },
    {
      ref: `${Z} src/proxy/outbound.rs: a connect of the pool that fails ends the flow of the app before its copy starts. The app sees its socket close before any byte of an answer`,
      rung: "derived",
    },
    {
      ref: `${I} cni/pkg/nodeagent/informers.go:316-325, :396-408 and ${Z} src/inpod/statemanager.rs:170-191 and src/drain.rs:58-70 at the deletion of a pod, the node agent sends DelWorkload, and ztunnel drains the proxy of that pod at once`,
      rung: "implemented",
    },
    {
      ref: `${Z} src/config.rs:101, :810-827 and src/app.rs:391-399 the deadline of the drain: CONNECTION_TERMINATION_DEADLINE, else the grace less 5 s. The chart sets the grace to 30 s (${I} manifests/charts/ztunnel/values.yaml:102): 25 s`,
      rung: "implemented",
    },
    { ref: `${Z} src/proxy/h2/server.rs:170-172 and src/proxy/outbound.rs:121 at SIGTERM the accept loops stop, and the HBONE server sends GOAWAY`, rung: "implemented" },
    {
      ref: `${I} manifests/charts/ztunnel/values.yaml:102 and templates/daemonset.yaml:215 the grace of the ztunnel pod is 30 s. ${K} pkg/kubelet/kuberuntime/kuberuntime_container.go:864-915, :1424-1427 the kubelet stops the container with that grace, and staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto:69-72 the runtime kills it at the end of the grace`,
      rung: "implemented",
    },
    {
      ref: `${Z} src/proxy/connection_manager.rs:133, :364-376 and src/proxy/inbound.rs:273-280 a CONNECT that a policy denies gets 401. At a change of a policy, ztunnel checks each open inbound connection again and closes each one that it now denies`,
      rung: "implemented",
    },
    {
      ref: `${Z} proto/workload.proto:148-198 the workload API has only routing preferences and a health policy for load balancing. No field of a DestinationRule reaches ztunnel on an L4 path`,
      rung: "derived",
    },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the first flow of the app that needs the connection" },
    connecting: { note: "The TCP connect and the TLS handshake to the port 15008 of the server pod. The flow of the app waits" },
    ready: { note: "The connection carries the flows of the apps as streams. The PING loop runs" },
    draining: { note: "After SIGTERM: the HBONE server sent GOAWAY, and the open streams go on until the deadline" },
    ended: { final: true, note: "The connection closed. Each flow of the app on it got a FIN" },
  },
  events: {
    "local.accept": { kind: "local", note: "The listener 15001 accepts a connection of the app, and the pool has no connection for its key" },
    "local.connected": { kind: "local", note: "The TCP connect and the TLS handshake to 15008 complete" },
    "local.connect-failed": { kind: "local", note: "The connect to 15008 fails: a reset, a refusal or a failed handshake" },
    "local.checkout": { kind: "local", note: "A new flow of an app takes the connection from the pool: the first flow, or each later flow to the same key" },
    "local.stream-end": { kind: "local", note: "The last stream on the connection ends" },
    "local.policy-denied": { kind: "local", note: "A change of a policy denies the connection: on the side of the server" },
    "local.del-workload": { kind: "local", note: "DelWorkload of the node agent of istio-cni for the pod: its deletion" },
    "rx.pong": { kind: "rx", note: "The PONG of the last PING" },
    "peer.rst": { kind: "peer", note: "A reset of the HBONE socket" },
    "peer.fin": { kind: "peer", note: "An end of file of the HBONE socket, or the end of the HTTP/2 connection" },
    "app.stop": { kind: "app", note: "SIGTERM to ztunnel: a restart or a deletion of its pod" },
    "timer.connect": { kind: "timer", note: "The connect does not complete in 10 s" },
    "timer.ping": { kind: "timer", note: "10 s after the last PONG: the next PING" },
    "timer.pong": { kind: "timer", note: "No PONG for 20 s after a PING" },
    "timer.release": { kind: "timer", note: "No checkout of the connection for the unused release timeout" },
    "timer.deadline": { kind: "timer", note: "The deadline of the drain after SIGTERM" },
    "timer.grace": { kind: "timer", note: "The end of the grace of the pod after SIGTERM: the kubelet kills ztunnel" },
    "tx.ping": { kind: "tx", note: "A PING of HTTP/2" },
    "tx.goaway": { kind: "tx", note: "A GOAWAY of the HBONE server" },
    "tx.close": { kind: "tx", note: "The close of the HBONE connection" },
    "tx.app-fin": { kind: "tx", note: "The shutdown of the socket of each flow of the app on the connection: a FIN, or a reset when bytes are unread" },
    "tx.app-close": { kind: "tx", note: "The close of the socket of the app whose flow waited for the connect, before any byte of an answer" },
  },
  knobs: {
    connect_timeout: { key: "the TCP connect timeout of ztunnel", scope: "build", unit: "s", default: 10, note: "proxy.rs:645: a constant" },
    ping_interval: { key: "PING_INTERVAL", scope: "build", unit: "s", default: 10, note: "h2.rs:36: a constant" },
    ping_timeout: { key: "PING_TIMEOUT", scope: "build", unit: "s", default: 20, note: "h2.rs:37: a constant" },
    pool_release: { key: "POOL_UNUSED_RELEASE_TIMEOUT", scope: "process", unit: "s", default: 300, note: "config.rs:75: 5 min, an environment variable" },
    deadline: { key: "CONNECTION_TERMINATION_DEADLINE", scope: "process", unit: "s", default: 25, note: "config.rs:810-827: unset, thus the grace of 30 s of the chart less 5 s" },
    grace: { key: "terminationGracePeriodSeconds", scope: "pod", unit: "s", default: 30, note: "values.yaml:102 of the chart of ztunnel" },
    keepidle: { key: "the TCP keepalive idle of ztunnel", scope: "process", unit: "s", default: 180, note: "config.rs:44-48" },
    keepintvl: { key: "the TCP keepalive interval of ztunnel", scope: "process", unit: "s", default: 180, note: "config.rs:44-48" },
    keepcnt: { key: "the TCP keepalive count of ztunnel", scope: "process", unit: "count", default: 9, note: "config.rs:44-48" },
    slack: { key: "the lateness of the runtime of tokio for one step", scope: "process", unit: "s", default: 0.01, note: "An assumption of this document, not a value of ztunnel" },
  },
  timers: {
    connect: {
      duration: { knob: "connect_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:connecting"],
      cancels: ["local.connected", "local.connect-failed"],
      fires: "timer.connect",
      note: "proxy.rs:645, :695",
    },
    ping: {
      duration: { knob: "ping_interval", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:ready", "rx.pong"],
      fires: "timer.ping",
      backoff: { resets: ["rx.pong"] },
      note: "h2.rs:39, :56: the sleep before each PING. It starts again after each PONG, thus it detects nothing by itself",
    },
    pong: {
      duration: { expr: "ping_interval + ping_timeout", unit: "s" },
      early: { knob: "ping_interval", unit: "s" },
      lateness: { expr: "2 * slack", unit: "s" },
      arms: ["enter:ready", "rx.pong"],
      cancels: ["peer.rst", "peer.fin"],
      fires: "timer.pong",
      note: "h2.rs:46: the wait of 20 s for the PONG of the PING that comes 10 s after the last PONG. A failure at a time in the cycle is found 20 s to 30 s later, and data does not change it",
    },
    release: {
      duration: { knob: "pool_release", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["local.checkout"],
      fires: "timer.release",
      note: "pool.rs:150-176, :338-341: from the last checkout. Each checkout starts a new timer, and the end of a stream does not start one",
    },
    deadline: {
      duration: { knob: "deadline", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["app.stop"],
      fires: "timer.deadline",
      note: "app.rs:391-399: from SIGTERM",
    },
    grace: {
      duration: { knob: "grace", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["app.stop"],
      fires: "timer.grace",
      note: "kuberuntime_container.go:864-915 and api.proto:69-72: the grace of the pod from SIGTERM, then the kill",
    },
  },
  realizes: {
    "systems.mechanism.heartbeat-interval": { timer: "ping" },
    "systems.mechanism.heartbeat-detection-time": {
      duration: { expr: "ping_interval + ping_timeout", unit: "s" },
      lateness: { expr: "2 * slack", unit: "s" },
      note: "The PING 10 s after the last PONG, and the drop 20 s after the PING",
    },
  },
  transitions: [
    { id: "zt.connect", from: "[none]", to: "connecting", on: "local.accept", timer: "connect", source: "outbound.rs:446-452, client.rs:50-58" },
    { id: "zt.connected", from: "connecting", to: "ready", on: "local.connected", timer: "pong", source: "client.rs:183-190" },
    {
      id: "zt.connect-failed",
      from: "connecting",
      to: "ended",
      on: "local.connect-failed",
      emits: ["tx.app-close"],
      note: "A reset of the SYN to 15008 fails the connect at once. The app sees its socket close before any byte of an answer: a client of gRPC counts a failed connect",
      source: "outbound.rs",
    },
    { id: "zt.connect-timeout", from: "connecting", to: "ended", on: "timer.connect", timer: "connect", emits: ["tx.app-close"], source: "proxy.rs:645, :695" },
    {
      id: "zt.checkout",
      from: "ready",
      to: "ready",
      on: "local.checkout",
      timer: "release",
      note: "A new flow takes the connection as a new stream, and the pool starts a new release timer",
      source: "pool.rs:150-176, :338-341",
    },
    { id: "zt.ping", from: "ready", to: "ready", on: "timer.ping", timer: "ping", emits: ["tx.ping"], source: "h2.rs:39-46" },
    { id: "zt.pong", from: "ready", to: "ready", on: "rx.pong", note: "The PONG starts the sleep and the wait again", source: "h2.rs:46-56" },
    {
      id: "zt.pong-timeout",
      from: "ready",
      to: "ended",
      on: "timer.pong",
      timer: "pong",
      emits: ["tx.close", "tx.app-fin"],
      note: "The client drops the connection, and the server calls abrupt_shutdown(NO_ERROR). Each flow of the app on it gets a FIN",
      source: "client.rs:237-238, server.rs:160-168, copy.rs:176-183",
    },
    {
      id: "zt.reset",
      from: ["ready", "draining"],
      to: "ended",
      on: ["peer.rst", "peer.fin"],
      emits: ["tx.app-fin"],
      note: "A reset or an end of file of the HBONE socket ends each stream. The copy loop shuts down the socket of each app: a FIN, not a reset",
      source: "h2.rs:229-238, copy.rs:198-212",
    },
    {
      id: "zt.policy-denied",
      from: "ready",
      to: "ended",
      on: "local.policy-denied",
      emits: ["tx.close", "tx.app-fin"],
      note: "The server side checks each open inbound connection again at a change of a policy, and closes the ones that it now denies",
      source: "connection_manager.rs:364-376",
    },
    {
      id: "zt.release",
      from: "ready",
      to: "ended",
      on: "timer.release",
      timer: "release",
      guard: "no stream is open and no other flow holds the connection",
      emits: ["tx.close"],
      note: "The pool drops its reference, and HTTP/2 closes the connection when no stream is left. Thus a flow that is open at the timer keeps the connection",
      source: "pool.rs:142-176, :338-341",
    },
    { id: "zt.stop", from: "ready", to: "draining", on: "app.stop", timer: "deadline", emits: ["tx.goaway"], note: "The accept loops stop, and the HBONE server sends GOAWAY", source: "server.rs:170-172, outbound.rs:121" },
    { id: "zt.drained", from: "draining", to: "ended", on: "local.stream-end", emits: ["tx.close"], source: "drain.rs:52-70" },
    {
      id: "zt.deadline",
      from: "draining",
      to: "ended",
      on: "timer.deadline",
      timer: "deadline",
      guard: "deadline < grace",
      emits: ["tx.close", "tx.app-fin"],
      note: "ztunnel ends what is left itself, before the SIGKILL of the kubelet",
      source: "app.rs:391-399, pool.rs:345-347",
    },
    {
      id: "zt.killed",
      from: "draining",
      to: "ended",
      on: "timer.grace",
      timer: "grace",
      guard: "grace <= deadline",
      emits: ["tx.app-fin"],
      note: "The kubelet kills ztunnel at the end of the grace, before its deadline. The kernel closes each socket: a FIN, or a reset when bytes are unread",
      source: "kuberuntime_container.go:864-915, api.proto:69-72, tcp.c:2781-2807",
    },
    {
      id: "zt.del-workload",
      from: ["connecting", "ready", "draining"],
      to: "ended",
      on: "local.del-workload",
      emits: ["tx.close", "tx.app-fin"],
      note: "The proxy of a deleted pod drains at once, with no deadline",
      source: "statemanager.rs:170-191, drain.rs:58-70",
    },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { connecting: "SYN_SENT", ready: "ESTABLISHED", draining: "ESTABLISHED" },
    sets: {
      keepidle: { knob: "keepidle", unit: "s" },
      keepintvl: { knob: "keepintvl", unit: "s" },
      keepcnt: { knob: "keepcnt", unit: "count" },
    },
    ends: "peer.rst",
    note: "The HBONE socket in the network namespace of the client pod: a Linux TCP socket with the keepalive of ztunnel and no TCP_USER_TIMEOUT. A peer that is gone ends it at 180 + 9 × 180 = 1800 s, after the PING",
  },
});
