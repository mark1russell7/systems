import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { ENVOY_HTTP2 } from "./envoy.ts";

// The source of each fact of Istio below is github.com/istio/istio at the tag 1.31.3. The proxy of
// that tag pins istio/proxy 3b372ff1, whose Envoy is one commit after v1.39.4 ("repo: Dev v1.39.5").
// Thus each fact of Envoy cites the tag v1.39.4, as ENVOY_HTTP2 does. The short names: route.go is
// pilot/pkg/networking/core/route/route.go, retry.go is its retry/retry.go, lm.cc is
// source/common/listener_manager/listener_manager_impl.cc, cm.cc is source/common/http/conn_manager_impl.cc,
// rs.cc is source/common/router/retry_state_impl.cc.
const IS = "istio 1.31.3";
const AT = "envoy v1.39.4";

/** A side of a sidecar is the listener of the connection: outbound from the app, or inbound to the app. */
export type SidecarSide = "outbound" | "inbound";

/** These sources hold for both sides of a sidecar of Istio 1.31.3. */
const SHARED_SOURCES = [
  { ref: `${IS} istio.deps:7 and istio/proxy WORKSPACE:26 the proxy pins Envoy 68eef0a0, one commit after v1.39.4 with the same code`, rung: "implemented" },
  { ref: `${IS} pilot/pkg/networking/core/listener_builder.go:434-445 the HTTP connection manager of each side: stream_idle_timeout 0, no request timeout and no PING of HTTP/2`, rung: "implemented" },
  { ref: `${IS} route.go:1361-1384 and :1321-1330 the timeout of each route is 0 unless a VirtualService sets one, and max_grpc_timeout is 0`, rung: "implemented" },
  { ref: `${IS} pkg/config/mesh/mesh.go:94 and pilot/pkg/networking/core/cluster_traffic_policy.go:302-303 the connect timeout of each cluster: 10 s`, rung: "implemented" },
  { ref: `${IS} pilot/pkg/networking/core/cluster.go:971-984 no TCP keepalive on a socket of the data plane`, rung: "implemented" },
  { ref: `${IS} pkg/envoy/proxy.go:136-139 Envoy starts with --drain-time-s 45 and --drain-strategy immediate. mesh.go:44 the drainDuration: 45 s`, rung: "implemented" },
  {
    ref: `${AT} lm.cc:635-644, :929-984 and source/common/listener_manager/listener_impl.cc:1146-1175 a change of filter chains only is an update in place. It counts listener_in_place_updated and listener_modified (lm.cc:644, :692), and only the changed chains drain`,
    rung: "implemented",
  },
  {
    ref: `${AT} cm.cc:1959-1968 the drain of a filter chain sets drainClose. The HTTP connection manager reads it when it encodes the headers of a response, and then sends the GOAWAY notice`,
    rung: "implemented",
  },
  { ref: `${AT} listener_impl.cc:1197-1210 each connection left on a drained chain closes with NoFlush at the end of the drain time`, rung: "implemented" },
  { ref: `${IS} pkg/envoy/agent.go:158-164 and proxy.go:237-243 at the stop of the pod, pilot-agent kills Envoy (SIGKILL). The kernel closes each socket of Envoy`, rung: "implemented" },
] as const;

/** These sources hold for the outbound side only. */
const OUTBOUND_SOURCES = [
  {
    ref: `${IS} retry.go:35-50 the default retry policy of an outbound route: 2 retries on connect-failure, refused-stream, unavailable, cancelled and retriable-status-codes with no codes, to a host that is not a previous host, with up to 5 picks. route.go:1386-1390 gives it to each outbound route`,
    rung: "implemented",
  },
  {
    ref: `${AT} rs.cc:431-489 a reset gives a retry for a failed connect or a connect timeout (connect-failure) and for a refused stream. The termination of an open connection gives no retry with this list`,
    rung: "implemented",
  },
  { ref: `${AT} rs.cc:351-430 a response gives a retry for grpc-status 1 (cancelled) or 14 (unavailable). A grpc-status 7 (PERMISSION_DENIED) gives none`, rung: "implemented" },
  {
    ref: `${AT} rs.cc:87-101 and source/common/common/backoff_strategy.cc:13-19 the backoff of a retry: a random wait below 25 ms, then below 50 ms, each wait at most 250 ms`,
    rung: "implemented",
  },
  { ref: `${IS} cluster_traffic_policy.go:377, :386-388 the load balancer is LEAST_REQUEST. Envoy breaks a tie at random`, rung: "implemented" },
] as const;

/** These sources hold for the inbound side only. */
const INBOUND_SOURCES = [
  {
    ref: `${IS} route.go:1321-1341 the inbound route has no timeout and no max stream duration. Only a port that is not of gRPC gets a retry policy: 2 retries on reset-before-request`,
    rung: "implemented",
  },
  {
    ref: `${IS} pilot/pkg/networking/core/httproute.go:140 and pkg/config/protocol/instance.go:156-163 the route gets the protocol of the port, and a port named grpc is of gRPC. Thus the inbound route of the lab has no retry policy`,
    rung: "implemented",
  },
  {
    ref: `${IS} pilot/pkg/security/authz/builder/builder.go:321-330 and pilot/pkg/xds/lds.go:46-55 the RBAC filter of an AuthorizationPolicy is in the HTTP connection manager of the inbound chain. A change of a policy pushes LDS`,
    rung: "implemented",
  },
  {
    ref: `${AT} source/extensions/filters/http/rbac/rbac_filter.cc:234-235 a denied request gets the local reply 403 "RBAC: access denied". source/common/http/utility.cc:746-753 and source/common/grpc/status.cc:14-15 give it to a gRPC request as trailers only with grpc-status 7 (PERMISSION_DENIED)`,
    rung: "implemented",
  },
  {
    ref: `${IS} pkg/envoy/admin.go:29-38 and proxy.go:112-115 the drain of a sidecar is drain_listeners?inboundonly&graceful: only the inbound listeners drain`,
    rung: "implemented",
  },
] as const;

/** This function gives the events of ENVOY_HTTP2 without the SIGTERM of Envoy: pilot-agent gets that signal, and Envoy gets SIGKILL. */
const envoyEvents = () => Object.fromEntries(Object.entries(ENVOY_HTTP2.events).filter(([name]) => name !== "app.stop"));

/**
 * This function gives a document of a sidecar of Istio 1.31.3 for one side, from ENVOY_HTTP2. The
 * Envoy of the sidecar is the code of that document. Istio changes its configuration and its stop:
 * - The route and the stream have no timeout, and the connect timeout of a cluster is 10 s.
 * - The outbound side retries a failed connect, a refused stream, and UNAVAILABLE or CANCELLED: 2 times, each on another host.
 * - The inbound side retries nothing, because the port of the lab is of gRPC.
 * - An update of LDS drains the changed filter chain. Its next response sends the GOAWAY notice.
 * - pilot-agent stops Envoy with SIGKILL at the stop of the pod. Envoy sends no GOAWAY then.
 */
export const istioSidecar = (side: SidecarSide): Machine => {
  const outbound = side === "outbound";
  const transitions = ENVOY_HTTP2.transitions
    .filter((t) => t.id !== "env.stop")
    .map((t) => {
      if (t.id === "env.upstream-reset" && outbound)
        return { ...t, note: `${t.note ?? ""}. A reset of an open connection is not on the list of the retries of Istio, thus the app gets UNAVAILABLE` };
      if (t.id === "env.connect-timeout" && outbound)
        return { ...t, guard: "num_retries retries of this call are spent", note: "503 with the reset reason connection timeout. A connect timeout is a connect-failure, thus Envoy retries it first" };
      if (t.id === "env.drained") return { ...t, note: "The final GOAWAY after drain_timeout, from the GOAWAY notice of an idle connection or of a drained chain" };
      return t;
    });
  return machineSchema.parse({
    format: "mark1russell7.machine/1",
    id: `istio-sidecar-${side}`,
    title: outbound
      ? "The client sidecar of Istio 1.31.3: Envoy 1.39.4 between the app and the mesh, one connection of the app, its streams, its retries, an update of LDS and the kill"
      : "The server sidecar of Istio 1.31.3: Envoy 1.39.4 between the mesh and the app, one connection of a client sidecar, its streams, the policy, an update of LDS and the kill",
    layer: "proxy",
    version: "1.31.3",
    conditions: {
      ...ENVOY_HTTP2.conditions,
      istio: "1.31.3",
      sidecar: "native: each kubelet is at least 1.33, thus ENABLE_NATIVE_SIDECARS (auto) is on",
      configuration: outbound
        ? "the outbound listener of the client pod, one route of the Service with the default retry policy, and one EDS cluster of h2 with mTLS"
        : "the inbound listener 15006 of the server pod, one filter chain of the port grpc with the RBAC filter, and one inbound cluster of h2c to the app",
    },
    sources: [...ENVOY_HTTP2.sources, ...SHARED_SOURCES, ...(outbound ? OUTBOUND_SOURCES : INBOUND_SOURCES)],
    states: {
      ...ENVOY_HTTP2.states,
      marked: { note: "LDS drained the filter chain of the connection. Its next response carries the GOAWAY notice" },
    },
    events: {
      ...envoyEvents(),
      "upstream.connect-failure": { kind: "local", note: outbound ? "The connect to the chosen host fails: a reset to the SYN, or no host" : "The app refuses the connect: its listener is closed" },
      "local.chain-drain": { kind: "local", note: "An update of LDS in place drains the filter chain of this connection: its drainClose becomes true" },
      "timer.chain-drain": { kind: "timer", note: "The drain time of Envoy (--drain-time-s) after the drain of the chain" },
      "app.kill": { kind: "app", note: "pilot-agent kills Envoy (SIGKILL)" },
      ...(outbound
        ? {
            "upstream.retriable": { kind: "local", note: "The upstream answers with grpc-status 14 or 1 before any data, or resets the stream with REFUSED_STREAM" },
            "timer.retry": { kind: "timer", note: "The backoff of a retry ends" },
            "tx.request": { kind: "tx", note: "The request goes to another host of the cluster" },
          }
        : {
            "local.rbac-deny": { kind: "local", note: "The RBAC filter of the chain of this connection denies the request: a DENY policy matches the principal of the peer" },
          }),
    },
    knobs: {
      ...ENVOY_HTTP2.knobs,
      route_timeout: { ...ENVOY_HTTP2.knobs["route_timeout"]!, default: 0, note: "route.go:1361-1367 (outbound) and :1324 (inbound): 0 unless a VirtualService sets it" },
      stream_idle_timeout: { ...ENVOY_HTTP2.knobs["stream_idle_timeout"]!, default: 0, note: "listener_builder.go:440: 0, the timer is off" },
      connect_timeout: { ...ENVOY_HTTP2.knobs["connect_timeout"]!, key: "MeshConfig.connectTimeout", default: 10, note: "mesh.go:94: 10 s" },
      drain_time: { key: "ProxyConfig.drainDuration (--drain-time-s)", scope: "process", unit: "s", default: 45, note: "mesh.go:44, proxy.go:138: 45 s" },
      ...(outbound
        ? {
            num_retries: { key: "VirtualService.http.retries.attempts", scope: "server", unit: "count", default: 2, note: "retry.go:36: 2" },
            base_retry_backoff: { key: "upstream.base_retry_backoff_ms", scope: "process", unit: "ms", default: 25, note: "rs.cc:87-88: 25 ms. The cap is 10 times it (rs.cc:95)" },
          }
        : {}),
    },
    timers: {
      ...ENVOY_HTTP2.timers,
      drain: { ...ENVOY_HTTP2.timers["drain"]!, arms: ["enter:draining"], note: "cm.cc:1699-1705: from the GOAWAY notice, of an idle connection or of a drained chain" },
      chain_drain: {
        duration: { knob: "drain_time", unit: "s" },
        lateness: { knob: "slack", unit: "s" },
        arms: ["local.chain-drain"],
        fires: "timer.chain-drain",
        note: "listener_impl.cc:1197-1210: the drain sequence of the chain, with the strategy immediate",
      },
      ...(outbound
        ? {
            retry_backoff: {
              duration: { expr: "min(base_retry_backoff * pow(2, fired), 10 * base_retry_backoff)", unit: "ms" },
              lateness: { knob: "slack", unit: "s" },
              early: { expr: "min(base_retry_backoff * pow(2, fired), 10 * base_retry_backoff)", unit: "ms" },
              arms: ["upstream.connect-failure", "upstream.connect-timeout", "upstream.retriable"],
              cancels: ["peer.rst", "peer.fin"],
              fires: "timer.retry",
              backoff: { resets: ["rx.headers"] },
              note: "backoff_strategy.cc:13-19: a random wait from 0 to the interval, thus as early as the whole interval",
            },
          }
        : {}),
    },
    transitions: [
      ...transitions,
      ...(outbound
        ? [
            {
              id: "isc.retry",
              from: "active",
              to: "active",
              on: ["upstream.connect-failure", "upstream.connect-timeout", "upstream.retriable"],
              guard: "fewer than num_retries retries of this call",
              timer: "retry_backoff",
              note: "The retry waits its backoff. A response of PERMISSION_DENIED is not retriable: retriable-status-codes lists no code",
              source: "retry.go:35-50, rs.cc:351-430, :431-489",
            },
            { id: "isc.retry-send", from: "active", to: "active", on: "timer.retry", timer: "retry_backoff", emits: ["tx.request"], note: "The predicate previous_hosts picks another host", source: "retry.go:40-48" },
            {
              id: "isc.retries-spent",
              from: "active",
              to: "idle",
              on: ["upstream.connect-failure", "upstream.retriable"],
              guard: "num_retries retries of this call are spent",
              errno: "UNAVAILABLE",
              emits: ["tx.local-reply"],
              note: "A failed connect gives the local reply 503. A response of the upstream passes to the app",
              source: "router.cc:1681-1712",
            },
          ]
        : [
            {
              id: "isi.inbound-refused",
              from: "active",
              to: "idle",
              on: "upstream.connect-failure",
              errno: "UNAVAILABLE",
              emits: ["tx.local-reply"],
              note: "503 with the reset reason remote connection failure. The inbound route has no retry policy, thus the client sidecar gets UNAVAILABLE and retries it on another host",
              source: "route.go:1321-1341, router.cc:1681-1712",
            },
            {
              id: "isi.rbac-deny",
              from: "active",
              to: "idle",
              on: "local.rbac-deny",
              errno: "PERMISSION_DENIED",
              emits: ["tx.local-reply"],
              note: "403 RBAC: access denied, as trailers only with grpc-status 7. The chain of the connection decides, thus a connection on a drained chain keeps the old policy",
              source: "rbac_filter.cc:234-235, utility.cc:746-753, status.cc:14-15",
            },
          ]),
      {
        id: "isc.chain-drain",
        from: ["idle", "active"],
        to: "marked",
        on: "local.chain-drain",
        timer: "chain_drain",
        note: "An open connection keeps the old chain and its policy. A new connection gets the new chain",
        source: "lm.cc:635-644, listener_impl.cc:1146-1175",
      },
      {
        id: "isc.chain-goaway",
        from: "marked",
        to: "draining",
        on: ["upstream.headers", "upstream.end"],
        emits: ["tx.goaway"],
        note: "The headers of the next response, a local reply too, carry the GOAWAY notice",
        source: "cm.cc:1959-1968",
      },
      { id: "isc.chain-closed", from: ["marked", "draining"], to: "ended", on: "timer.chain-drain", timer: "chain_drain", emits: ["tx.fin"], note: "NoFlush: a call in flight ends with the close", source: "listener_impl.cc:1197-1210" },
      {
        id: "isc.killed",
        from: ["idle", "active", "draining", "marked"],
        to: "ended",
        on: "app.kill",
        emits: ["tx.fin"],
        note: "No GOAWAY: the kernel closes each socket, with a reset when data is unread. A call in flight ends before the headers of its response",
        source: "agent.go:158-164, proxy.go:237-243",
      },
      { id: "isc.client-end-marked", from: "marked", to: "ended", on: ["peer.fin", "peer.rst"], source: "source/common/network/connection_impl.cc:804-819" },
    ],
    over: {
      ...ENVOY_HTTP2.over!,
      states: { ...ENVOY_HTTP2.over!.states, marked: "ESTABLISHED" },
      note: outbound
        ? "The socket of the app is on loopback. The socket of the mesh leg is a Linux TCP socket with TCP_NODELAY and no keepalive"
        : "The socket of the mesh leg is a Linux TCP socket with TCP_NODELAY and no keepalive. The socket to the app is on loopback",
    },
  });
};

/** This document is the client sidecar of Istio 1.31.3 (`istioSidecar("outbound")`). */
export const ISTIO_SIDECAR_OUTBOUND: Machine = istioSidecar("outbound");

/** This document is the server sidecar of Istio 1.31.3 (`istioSidecar("inbound")`). */
export const ISTIO_SIDECAR_INBOUND: Machine = istioSidecar("inbound");

/**
 * This document is pilot-agent of Istio 1.31.3: the lifecycle of the Envoy of a sidecar at the stop
 * of its pod. With a native sidecar, the preStop hook drains the inbound listeners at the deletion.
 * The kubelet sends SIGTERM after each container of the app exited. Then pilot-agent stops Envoy with
 * SIGKILL at once, because the drain is done. Without a native sidecar, SIGTERM starts the drain, and
 * the SIGKILL comes terminationDrainDuration later (5 s). With EXIT_ON_ZERO_ACTIVE_CONNECTIONS, it waits the
 * minimum drain, then polls the active connections each 1 s.
 */
export const PILOT_AGENT: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "pilot-agent",
  title: "pilot-agent of Istio 1.31.3: the drain and the kill of the Envoy of a sidecar at the stop of its pod",
  layer: "proxy",
  version: "1.31.3",
  conditions: { istio: "1.31.3", kubelet: "v1.37.0", sidecar: "native when each kubelet is at least 1.33 (ENABLE_NATIVE_SIDECARS auto)" },
  sources: [
    { ref: `${IS} pilot/pkg/features/pilot.go:346 and pkg/kube/inject/webhook.go:1332-1381 ENABLE_NATIVE_SIDECARS is auto: on when each kubelet is at least 1.33`, rung: "implemented" },
    {
      ref: `${IS} manifests/charts/istio-control/istio-discovery/files/injection-template.yaml:225-235 a native sidecar gets the preStop hook pilot-agent request POST drain`,
      rung: "implemented",
    },
    { ref: `${IS} pilot/cmd/pilot-agent/status/server.go:439, :1069-1081 and pilot/cmd/pilot-agent/options/statusserver.go:37-41 the request drain calls DrainNow`, rung: "implemented" },
    {
      ref: `${IS} pkg/envoy/agent.go:146-155, pkg/envoy/proxy.go:112-115 and pkg/envoy/admin.go:29-38 DrainNow posts drain_listeners?inboundonly&graceful&skip_exit, and turns the later drain off`,
      rung: "implemented",
    },
    { ref: `${IS} pilot/cmd/pilot-agent/app/cmd.go:153-154 SIGTERM cancels the context of the agent`, rung: "implemented" },
    { ref: `${IS} agent.go:158-164 at the stop, with the drain already done, the agent aborts at once`, rung: "implemented" },
    { ref: `${IS} agent.go:165-168, :217-228 without the drain done, the agent drains, and aborts terminationDrainDuration later`, rung: "implemented" },
    { ref: `${IS} agent.go:37, :169-216, :238-245 with EXIT_ON_ZERO_ACTIVE_CONNECTIONS, it waits the minimum drain, then polls downstream_cx_active each 1 s, and aborts at zero`, rung: "implemented" },
    { ref: `${IS} proxy.go:237-243 the abort kills Envoy: cmd.Process.Kill(), thus SIGKILL`, rung: "implemented" },
    { ref: `${IS} pkg/config/mesh/mesh.go:44-45 drainDuration 45 s and terminationDrainDuration 5 s`, rung: "implemented" },
    { ref: `${IS} pilot/cmd/pilot-agent/options/options.go:171-178 MINIMUM_DRAIN_DURATION 5 s, EXIT_ON_ZERO_ACTIVE_CONNECTIONS false`, rung: "implemented" },
    {
      ref: "kubernetes v1.37.0 pkg/kubelet/kuberuntime/kuberuntime_container.go:895-915 and kuberuntime_termination_order.go:28-99 the kubelet runs the preStop hook of a sidecar at the deletion, and sends SIGTERM to it after each main container exited",
      rung: "implemented",
    },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the start of Envoy" },
    running: { note: "Envoy runs, and its listeners take connections" },
    drained: { note: "The preStop drain ran: each inbound connection sends the GOAWAY notice with its next response. The later drain is off" },
    draining: { note: "The drain at SIGTERM, for terminationDrainDuration" },
    "minimum-drain": { note: "The drain at SIGTERM, for the minimum drain, with EXIT_ON_ZERO_ACTIVE_CONNECTIONS" },
    polling: { note: "The agent polls the active connections of Envoy each 1 s" },
    ended: { final: true, note: "Envoy is gone" },
  },
  events: {
    "local.start": { kind: "local", note: "The agent starts Envoy" },
    "app.prestop": { kind: "app", note: "The kubelet runs the preStop hook of the sidecar: pilot-agent request POST drain" },
    "app.sigterm": { kind: "app", note: "The kubelet sends SIGTERM to pilot-agent" },
    "timer.termination-drain": { kind: "timer", note: "terminationDrainDuration after the drain at SIGTERM" },
    "timer.minimum-drain": { kind: "timer", note: "The minimum drain after the drain at SIGTERM" },
    "timer.active-check": { kind: "timer", note: "The poll of downstream_cx_active" },
    "local.envoy-exit": { kind: "local", note: "Envoy exits by itself" },
    "tx.drain-listeners": { kind: "tx", note: "A POST to the admin of Envoy: drain_listeners?inboundonly&graceful, with skip_exit from the preStop hook" },
    "tx.kill": { kind: "tx", note: "SIGKILL to Envoy" },
  },
  knobs: {
    termination_drain: { key: "ProxyConfig.terminationDrainDuration", scope: "pod", unit: "s", default: 5, note: "mesh.go:45: 5 s" },
    minimum_drain: { key: "MINIMUM_DRAIN_DURATION", scope: "pod", unit: "s", default: 5, note: "options.go:171-174: 5 s" },
    exit_on_zero: { key: "EXIT_ON_ZERO_ACTIVE_CONNECTIONS", scope: "pod", unit: null, default: 0, note: "options.go:176-178: false (0)" },
    active_check: { key: "activeConnectionCheckDelay", scope: "build", unit: "s", default: 1, note: "agent.go:37: 1 s, a constant" },
    slack: { key: "the lateness of a timer of Go in the agent", scope: "process", unit: "s", default: 0.01, note: "An assumption of this document, not a value of Istio" },
  },
  timers: {
    termination_drain: {
      duration: { knob: "termination_drain", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:draining"],
      cancels: ["local.envoy-exit"],
      fires: "timer.termination-drain",
      note: "agent.go:217-228: time.After(terminationDrainDuration)",
    },
    minimum_drain: {
      duration: { knob: "minimum_drain", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:minimum-drain"],
      fires: "timer.minimum-drain",
      note: "agent.go:172-174: time.Sleep, thus an exit of Envoy does not end it",
    },
    active_check: {
      duration: { knob: "active_check", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:polling"],
      cancels: ["local.envoy-exit"],
      fires: "timer.active-check",
      backoff: { resets: ["enter:polling"] },
      note: "agent.go:176-181: a ticker of 1 s, thus it starts again at each poll",
    },
  },
  transitions: [
    { id: "pa.start", from: "[none]", to: "running", on: "local.start", source: "proxy.go:229-235" },
    {
      id: "pa.prestop-drain",
      from: "running",
      to: "drained",
      on: "app.prestop",
      emits: ["tx.drain-listeners"],
      note: "DrainNow with skip_exit: the drain starts at the deletion, beside the SIGTERM of the app",
      source: "injection-template.yaml:225-235, server.go:1069-1081, agent.go:146-155",
    },
    { id: "pa.kill-drained", from: "drained", to: "ended", on: "app.sigterm", emits: ["tx.kill"], note: "skipDrain: no wait. The kubelet sends SIGTERM once the app exited", source: "agent.go:158-164, proxy.go:237-243" },
    {
      id: "pa.sigterm-drain",
      from: "running",
      to: "draining",
      on: "app.sigterm",
      guard: "exit_on_zero is 0",
      timer: "termination_drain",
      emits: ["tx.drain-listeners"],
      note: "A sidecar that is not native: the drain at SIGTERM",
      source: "agent.go:165-168, :217-228",
    },
    { id: "pa.drain-done", from: "draining", to: "ended", on: "timer.termination-drain", timer: "termination_drain", emits: ["tx.kill"], source: "agent.go:224-226, proxy.go:237-243" },
    {
      id: "pa.sigterm-wait",
      from: "running",
      to: "minimum-drain",
      on: "app.sigterm",
      guard: "exit_on_zero is 1",
      timer: "minimum_drain",
      emits: ["tx.drain-listeners"],
      source: "agent.go:165-174",
    },
    { id: "pa.poll-start", from: "minimum-drain", to: "polling", on: "timer.minimum-drain", timer: "minimum_drain", source: "agent.go:175-178" },
    { id: "pa.poll", from: "polling", to: "polling", on: "timer.active-check", guard: "downstream_cx_active is above 0 on a listener that is not of the agent", timer: "active_check", source: "agent.go:207-214" },
    {
      id: "pa.zero",
      from: "polling",
      to: "ended",
      on: "timer.active-check",
      guard: "downstream_cx_active is 0, or the stat is not there",
      timer: "active_check",
      emits: ["tx.kill"],
      source: "agent.go:201-211, proxy.go:237-243",
    },
    { id: "pa.envoy-exit", from: ["running", "drained", "draining", "minimum-drain", "polling"], to: "ended", on: "local.envoy-exit", source: "agent.go:184-187, :219-222" },
  ],
});
