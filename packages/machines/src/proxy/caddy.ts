import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";

// The source of each fact below is github.com/caddyserver/caddy at the tag v2.11.7 (commit 72dd0fb067f6),
// with go.mod at go 1.26.0. Its HTTP/2 server and client are golang.org/x/net v0.59.0 http2 (commit
// 540d04cfe502): xs is http2/server.go, xt is http2/transport.go. Each line number is a line of that file at
// its tag. A fact of Go is from go1.26.8, the release builder of Caddy.
const AT = "caddy v2.11.7";
const XNET = "x/net v0.59.0";

/**
 * This document is Caddy 2.11.7 as an HTTP/2 proxy of gRPC, for one connection of a client. Its
 * configuration is the one of the harness: one server of h1 and h2c, and `reverse_proxy` to one upstream
 * of h2c. Each other option is at its default.
 *
 * With no stream open for 5 min, Caddy sends GOAWAY NO_ERROR, and it closes the connection 1 s later. A
 * PING of the client does not reset that timer. Before the headers of a response, a failure of the
 * upstream gives 502, thus UNAVAILABLE. After them, Caddy resets the stream with INTERNAL_ERROR. Caddy
 * sends no PING. At SIGTERM it sends GOAWAY at once, and it waits for each stream at its defaults.
 */
export const CADDY_HTTP2: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "caddy-http2",
  title: "Caddy 2.11.7 as an HTTP/2 proxy of gRPC: one connection of a client, its idle close, its replies to a failure of the upstream and its stop",
  layer: "proxy",
  version: "2.11.7",
  conditions: {
    caddy: "v2.11.7",
    http2: "golang.org/x/net v0.59.0",
    go: "1.26.8",
    configuration: "one server with the protocols h1 and h2c, and reverse_proxy to one upstream of h2c, at the defaults",
  },
  sources: [
    { ref: `${AT} modules/caddyhttp/app.go:404-418, :925-940 the defaults of a server: idle_timeout 5 min, read_header_timeout 1 min, read_idle_timeout 1 min, write_idle_timeout 1 min`, rung: "implemented" },
    { ref: `${AT} modules/caddyhttp/app.go:520-533 the protocol h2c: http2.ConfigureServer with a zero http2.Server of ${XNET}`, rung: "implemented" },
    { ref: `${XNET} xs:166-171 the idle timeout of HTTP/2 is the IdleTimeout of the http.Server`, rung: "implemented" },
    {
      ref: `${XNET} xs:812-815, :872-874, :1274-1281, :1578-1581, :1906 the idle timer runs only with no stream open. Its end sends GOAWAY NO_ERROR, and with no stream open the connection closes goAwayTimeout (1 s) later`,
      rung: "implemented",
    },
    { ref: `${XNET} xs:1336 a PING of the client gets an ACK only: it does not reset the idle timer`, rung: "implemented" },
    { ref: `${XNET} xs:817-820 the server sends no PING: Caddy sets no SendPingTimeout`, rung: "implemented" },
    {
      ref: `${AT} modules/caddyhttp/reverseproxy/reverseproxy.go:1086, :1107-1112, :1393-1397, :1667-1697 a failure of the upstream before the headers of a response: no retry at the defaults, and statusError gives 502`,
      rung: "implemented",
    },
    { ref: `${AT} modules/caddyhttp/reverseproxy/reverseproxy.go:1331-1352 and ${XNET} xs:2296-2310 after the headers, a failed copy panics with http.ErrAbortHandler, and the stream gets RST_STREAM INTERNAL_ERROR`, rung: "implemented" },
    { ref: `${AT} modules/caddyhttp/reverseproxy/httptransport.go:212-226 the defaults of the transport: a dial timeout of 3 s, and an idle upstream connection closes after 2 min`, rung: "implemented" },
    { ref: `${XNET} xt:550-554, :786-802 an idle connection of the client of HTTP/2 closes with no GOAWAY`, rung: "implemented" },
    {
      ref: `${AT} modules/caddyhttp/app.go:136-142, :753-799, :862-876 a stop calls Shutdown on each server: a GOAWAY at once, and the grace period is eternal at the defaults. Caddy closes no connection by itself`,
      rung: "implemented",
    },
    { ref: `${AT} modules/caddyhttp/app.go:570-577 and go1.26.8 src/net/tcpsock.go:291-296 each accepted socket gets the TCP keepalive of Go: 15 s, 15 s and 9 probes`, rung: "implemented" },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the accept of the connection of the client" },
    idle: { note: "The connection of the client, with no stream open. The idle timer runs" },
    active: { note: "A stream of the client is open: its request goes to the upstream" },
    closing: { note: "After a GOAWAY with no stream open, until the close goAwayTimeout later" },
    draining: { note: "After the GOAWAY of a stop, while a stream is open" },
    ended: { final: true, note: "The connection of the client closed" },
  },
  events: {
    "local.accept": { kind: "local", note: "The listener accepts the connection of the client, with the TCP keepalive of Go" },
    "rx.headers": { kind: "rx", note: "The headers of a new stream of the client: a call" },
    "upstream.end": { kind: "local", note: "The response of the upstream ends with its status: the last stream closes" },
    "upstream.reset": { kind: "local", note: "The upstream connection ends with a reset or an end of file while the stream waits" },
    "timer.idle": { kind: "timer", note: "No stream open for idle_timeout" },
    "timer.goaway": { kind: "timer", note: "goAwayTimeout after the GOAWAY, with no stream open" },
    "app.stop": { kind: "app", note: "SIGTERM or SIGINT to the process of Caddy" },
    "peer.fin": { kind: "peer", note: "The client ends the connection" },
    "peer.rst": { kind: "peer", note: "A reset of the connection of the client" },
    "tx.status": { kind: "tx", note: "An HTTP status with no gRPC status, before the headers of a response: 502" },
    "tx.rst-stream": { kind: "tx", note: "RST_STREAM INTERNAL_ERROR of a stream whose response headers went out" },
    "tx.goaway": { kind: "tx", note: "A GOAWAY NO_ERROR to the client" },
    "tx.fin": { kind: "tx", note: "The close of the connection of the client: a FIN" },
  },
  knobs: {
    idle_timeout: { key: "servers.idle_timeout", scope: "server", unit: "s", default: 300, note: "app.go:404-406, :925: 5 min. A negative value turns it off" },
    goaway_timeout: { key: "goAwayTimeout of x/net http2", scope: "server", unit: "s", default: 1, note: "xs: a constant of 1 s" },
    upstream_idle_timeout: { key: "reverse_proxy transport http keepalive", scope: "server", unit: "s", default: 120, note: "httptransport.go:215-217: 2 min" },
    keepidle: { key: "the TCP keepalive idle of an accepted connection", scope: "server", unit: "s", default: 15, note: "go1.26.8 dial.go: the default of Go" },
    keepintvl: { key: "the TCP keepalive interval of an accepted connection", scope: "server", unit: "s", default: 15, note: "go1.26.8 dial.go" },
    keepcnt: { key: "the TCP keepalive count of an accepted connection", scope: "server", unit: "count", default: 9, note: "go1.26.8 dial.go" },
    slack: { key: "the lateness of the scheduler of Go for one step", scope: "process", unit: "s", default: 0.01, note: "An assumption of this document, not a value of Caddy" },
    hz: { key: "CONFIG_HZ", scope: "global", unit: "Hz", default: null, note: "The build option of the kernel" },
  },
  timers: {
    idle: {
      duration: { knob: "idle_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:idle"],
      cancels: ["rx.headers"],
      fires: "timer.idle",
      note: "xs:812-815, :1906: from the close of the last stream. A PING does not arm it again",
    },
    goaway: {
      duration: { knob: "goaway_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["tx.goaway"],
      fires: "timer.goaway",
      note: "xs:1274-1281: the close after the GOAWAY, when no stream is open",
    },
  },
  transitions: [
    { id: "cd.accept", from: "[none]", to: "idle", on: "local.accept", timer: "idle", source: "app.go:570-577" },
    { id: "cd.stream", from: "idle", to: "active", on: "rx.headers", source: "xs:1578-1581" },
    { id: "cd.replied", from: "active", to: "idle", on: "upstream.end", timer: "idle", note: "The status of the upstream passes to the client unchanged", source: "xs:1906" },
    {
      id: "cd.upstream-reset",
      from: "active",
      to: "idle",
      on: "upstream.reset",
      guard: "no headers of the response went to the client",
      errno: "UNAVAILABLE",
      emits: ["tx.status"],
      note: "502 with no gRPC status, thus UNAVAILABLE Received HTTP status code 502. No retry",
      source: "reverseproxy.go:1393-1397, :1667-1697",
    },
    { id: "cd.upstream-reset-streaming", from: "active", to: "idle", on: "upstream.reset", guard: "the headers of the response went to the client", errno: "INTERNAL", emits: ["tx.rst-stream"], source: "reverseproxy.go:1331-1352" },
    { id: "cd.idle", from: "idle", to: "closing", on: "timer.idle", timer: "idle", emits: ["tx.goaway"], note: "GOAWAY NO_ERROR, with the highest stream of the client", source: "xs:872-874" },
    { id: "cd.closed", from: "closing", to: "ended", on: "timer.goaway", timer: "goaway", emits: ["tx.fin"], source: "xs:1274-1281" },
    { id: "cd.stop-idle", from: "idle", to: "closing", on: "app.stop", emits: ["tx.goaway"], source: "app.go:782-799, xs:1315-1340" },
    { id: "cd.stop-active", from: "active", to: "draining", on: "app.stop", emits: ["tx.goaway"], note: "The open stream goes on: the grace period is eternal at the defaults", source: "app.go:136-142, :862-876" },
    { id: "cd.drained", from: "draining", to: "closing", on: "upstream.end", timer: "goaway", source: "xs:1274-1281" },
    { id: "cd.client-end", from: ["idle", "active", "closing", "draining"], to: "ended", on: ["peer.fin", "peer.rst"], source: "xs" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { idle: "ESTABLISHED", active: "ESTABLISHED", closing: "ESTABLISHED", draining: "ESTABLISHED" },
    sets: {
      keepidle: { knob: "keepidle", unit: "s" },
      keepintvl: { knob: "keepintvl", unit: "s" },
      keepcnt: { knob: "keepcnt", unit: "count" },
    },
    ends: "peer.rst",
    note: "The socket toward the client: a Linux TCP socket with the keepalive of Go. The socket toward the upstream has 15 s, 30 s and 9 probes",
  },
});
