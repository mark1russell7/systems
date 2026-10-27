import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The source of each fact below is github.com/traefik/traefik at the tag v3.7.15 (commit 351a5ab1e884),
// with fsnotify v1.10.1 and paerser v0.2.2 from its go.mod. h2 is src/net/http/h2_bundle.go of go1.26.9,
// the newest Go 1.26 when the tag was built (.go-version says 1.26). Each line number is a line of that
// file at its tag.
const AT = "traefik v3.7.15";
const H2 = "go1.26.9 src/net/http/h2_bundle.go";

/**
 * This document is Traefik 3.7.15 as an HTTP/2 proxy of gRPC, for one connection of a client. Its
 * configuration is the one of the harness. It has one entrypoint of h2c and the file provider over a
 * folder of dynamic files, with one router to one server of h2c. Each other option is at its default.
 *
 * - With no stream open for 180 s (respondingTimeouts.idleTimeout), Go sends GOAWAY NO_ERROR, and it
 *   closes the connection 1 s later. The timer counts from the close of the last stream.
 * - A reload of the dynamic file only swaps the handler of each entrypoint. Thus a reload sends nothing
 *   to the client: no GOAWAY, no reset and no close. A stream that runs keeps its handler, and a new
 *   stream gets the new one. A transport whose configuration is the same is kept, with its upstream
 *   connection.
 * - The file provider watches the file and its folder. The first message goes at once, and a change
 *   within the throttle of 2 s waits for its end. A rewrite with the same content changes nothing.
 * - At SIGTERM, Traefik sends GOAWAY, and it closes each connection after graceTimeOut (10 s).
 */
export const TRAEFIK_HTTP2: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "traefik-http2",
  title: "Traefik 3.7.15 as an HTTP/2 proxy of gRPC: one connection of a client, its idle close, a reload of its dynamic file and its stop",
  layer: "proxy",
  version: "3.7.15",
  conditions: {
    traefik: "v3.7.15",
    go: "1.26 (go1.26.9 assumed)",
    configuration: "one entrypoint of h2c, the file provider over a folder of dynamic files, one router to one service with one server of h2c, at the defaults",
  },
  sources: [
    { ref: `${AT} pkg/config/static/static_config.go:47-51, :208-211 the respondingTimeouts of an entrypoint: idleTimeout 180 s, readTimeout 60 s, writeTimeout 0`, rung: "implemented" },
    { ref: `${H2}:4310-4316, :5022-5025, :6120-6122, :5809-5813 the idle timer of HTTP/2: from the serve of the connection, stopped by a new stream, armed again at the close of the last stream`, rung: "implemented" },
    { ref: `${H2}:5081-5083, :5112-5120, :5566 the idle timer sends GOAWAY NO_ERROR, and the connection closes goAwayTimeout (1 s) after it, with no stream open`, rung: "implemented" },
    { ref: `${AT} pkg/provider/file/file.go:81-85, :169-211 the file provider watches its folder with fsnotify. Each event of a file of the folder reads each file again (:201-205)`, rung: "implemented" },
    { ref: `${AT} cmd/configuration.go:26-28 and pkg/provider/aggregator/aggregator.go:44-58 providersThrottleDuration of 2 s: a message goes at once, then the forwarder sleeps 2 s and keeps the newest message`, rung: "implemented" },
    { ref: `${AT} pkg/server/configurationwatcher.go:136-140, :182-184 a configuration equal to the last one is dropped`, rung: "implemented" },
    { ref: `${AT} pkg/server/server_entrypoint_tcp.go:382-407 and pkg/middlewares/handler_switcher.go:21-35 a reload swaps the handler of each entrypoint. The http.Server and each connection stay, and a stream reads the handler when it starts`, rung: "implemented" },
    { ref: `${AT} pkg/server/service/transport.go:54-109 a transport whose configuration is the same is kept with its connections. A changed one is new, and the old one is not closed`, rung: "implemented" },
    { ref: `${AT} pkg/server/service/service.go:484-485 the debug line "Creating server" when the routers are built for a configuration`, rung: "implemented" },
    { ref: `${AT} pkg/server/server_entrypoint_tcp.go:316-380, ${H2}:5545-5570 SIGTERM: Shutdown sends GOAWAY NO_ERROR, and Close comes after graceTimeOut (10 s, static_config.go:43-45)`, rung: "implemented" },
    {
      ref: "the runs 39364790926 (a reload in the gap) and 39370033339 (no reload) of T02.array.77: the GOAWAY of the idle timeout came 180.001 s to 180.086 s after the last write of the stream. Caddy, on the same code of Go, gave 300.006 s",
      rung: "observed",
      note: "Thus the lateness is in the process of Traefik, not in the reload. The source does not give its cause",
    },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the accept of the connection of the client" },
    idle: { note: "The connection of the client, with no stream open. The idle timer runs" },
    active: { note: "A stream of the client is open: its request goes to the upstream" },
    closing: { note: "After a GOAWAY with no stream open, until the close goAwayTimeout later" },
    draining: { note: "After the GOAWAY of a stop, while a stream is open, until graceTimeOut" },
    ended: { final: true, note: "The connection of the client closed" },
  },
  events: {
    "local.accept": { kind: "local", note: "The entrypoint accepts the connection of the client" },
    "rx.headers": { kind: "rx", note: "The headers of a new stream of the client: a call. It reads the handler of the entrypoint" },
    "upstream.end": { kind: "local", note: "The response of the upstream ends: the last stream closes" },
    "local.reload": { kind: "local", note: "The file provider sends a changed dynamic configuration, and the routers are built again" },
    "timer.idle": { kind: "timer", note: "No stream open for idleTimeout" },
    "timer.goaway": { kind: "timer", note: "goAwayTimeout after the GOAWAY, with no stream open" },
    "timer.grace": { kind: "timer", note: "graceTimeOut after the GOAWAY of a stop" },
    "app.stop": { kind: "app", note: "SIGTERM or SIGINT to the process of Traefik" },
    "peer.fin": { kind: "peer", note: "The client ends the connection" },
    "peer.rst": { kind: "peer", note: "A reset of the connection of the client" },
    "tx.goaway": { kind: "tx", note: "A GOAWAY NO_ERROR to the client" },
    "tx.fin": { kind: "tx", note: "The close of the connection of the client: a FIN" },
  },
  knobs: {
    idle_timeout: { key: "entryPoints.<name>.transport.respondingTimeouts.idleTimeout", scope: "server", unit: "s", default: 180, note: "static_config.go:47-48, :208-211" },
    read_timeout: { key: "entryPoints.<name>.transport.respondingTimeouts.readTimeout", scope: "server", unit: "s", default: 60, note: "A timer for each stream on the body of its request" },
    goaway_timeout: { key: "goAwayTimeout of the HTTP/2 server of Go", scope: "server", unit: "s", default: 1, note: "h2_bundle.go: a constant of 1 s" },
    grace_timeout: { key: "entryPoints.<name>.transport.lifeCycle.graceTimeOut", scope: "server", unit: "s", default: 10, note: "static_config.go:43-45" },
    throttle: { key: "providers.providersThrottleDuration", scope: "process", unit: "s", default: 2, note: "cmd/configuration.go:26-28" },
    upstream_idle_timeout: { key: "serversTransport.idleConnTimeout", scope: "server", unit: "s", default: 90, note: "transport.go:312" },
    slack: {
      key: "the lateness of one step of the process of Traefik",
      scope: "process",
      unit: "s",
      default: 0.1,
      note: "An observation, not a value of Traefik: its GOAWAY came up to 86 ms after the idle timeout, from the last write of the stream, in 22 runs. The source gives no cause",
    },
  },
  timers: {
    idle: {
      duration: { knob: "idle_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:idle"],
      cancels: ["rx.headers"],
      fires: "timer.idle",
      note: "h2_bundle.go:5809-5813: from the close of the last stream. A reload does not arm it again",
    },
    goaway: {
      duration: { knob: "goaway_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["tx.goaway"],
      fires: "timer.goaway",
      note: "h2_bundle.go:5112-5120: the close after the GOAWAY, when no stream is open",
    },
    grace: {
      duration: { knob: "grace_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["app.stop"],
      fires: "timer.grace",
      note: "server_entrypoint_tcp.go:327-351: Close after graceTimeOut",
    },
  },
  transitions: [
    { id: "tf.accept", from: "[none]", to: "idle", on: "local.accept", timer: "idle", source: "server_entrypoint_tcp.go:184-234" },
    { id: "tf.stream", from: "idle", to: "active", on: "rx.headers", source: "h2_bundle.go:6120-6122" },
    { id: "tf.replied", from: "active", to: "idle", on: "upstream.end", timer: "idle", source: "h2_bundle.go:5809-5813" },
    { id: "tf.reload-idle", from: "idle", to: "idle", on: "local.reload", note: "A swap of the handler: nothing to the client, and the idle timer goes on", source: "server_entrypoint_tcp.go:382-407" },
    { id: "tf.reload-active", from: "active", to: "active", on: "local.reload", note: "The stream keeps the handler that it started with", source: "handler_switcher.go:21-24" },
    { id: "tf.idle", from: "idle", to: "closing", on: "timer.idle", timer: "idle", emits: ["tx.goaway"], note: "GOAWAY NO_ERROR, with the highest stream of the client", source: "h2_bundle.go:5081-5083" },
    { id: "tf.closed", from: "closing", to: "ended", on: "timer.goaway", timer: "goaway", emits: ["tx.fin"], source: "h2_bundle.go:5112-5120" },
    { id: "tf.stop-idle", from: "idle", to: "closing", on: "app.stop", emits: ["tx.goaway"], source: "server_entrypoint_tcp.go:316-380" },
    { id: "tf.stop-active", from: "active", to: "draining", on: "app.stop", timer: "grace", emits: ["tx.goaway"], source: "server_entrypoint_tcp.go:316-380" },
    { id: "tf.drained", from: "draining", to: "closing", on: "upstream.end", timer: "goaway", source: "h2_bundle.go:5112-5120" },
    { id: "tf.grace", from: "draining", to: "ended", on: "timer.grace", timer: "grace", emits: ["tx.fin"], source: "server_entrypoint_tcp.go:327-351" },
    { id: "tf.client-end", from: ["idle", "active", "closing", "draining"], to: "ended", on: ["peer.fin", "peer.rst"], source: "h2_bundle.go" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { idle: "ESTABLISHED", active: "ESTABLISHED", closing: "ESTABLISHED", draining: "ESTABLISHED" },
    sets: {},
    ends: "peer.rst",
    note: "The socket toward the client: a Linux TCP socket. Its keepalive is the one of the listener of Go, which the source of this document does not name",
  },
});
