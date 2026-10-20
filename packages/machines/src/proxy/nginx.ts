import type { Machine } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra";

// The source of each fact below is github.com/nginx/nginx at the tag release-1.29.6. Each line number is a
// line of that file at that tag. The tag release-1.29.7 has the same src/http/v2, ngx_http_upstream.c,
// src/event and ngx_times.c: its change for gRPC is the keepalive of an explicit upstream {} block, which
// the configuration of this document does not have.
const AT = "nginx release-1.29.6";
const V2 = "src/http/v2/ngx_http_v2.c";
const UP = "src/http/ngx_http_upstream.c";

/**
 * This document is nginx 1.29.6 as an HTTP/2 proxy of gRPC, for one connection of a client. Its
 * configuration is the one of the harness: one worker (the default), one server of h2c, and `grpc_pass`
 * to one address with no `upstream {}` block. Each other directive is at its built-in default, not at the
 * values of the stock nginx.conf (keepalive_timeout 65 and worker_processes auto).
 *
 * - With no stream open for 75 s (keepalive_timeout), nginx sends GOAWAY NO_ERROR, then a FIN, and it
 *   reads and drops the input for at most 30 s (the lingering close). A PING does not reset that timer.
 * - While a stream is open, the connection of the client has no timer. The only timer of a call is
 *   grpc_read_timeout (60 s) on the upstream socket, from the send of the request. When it fires before
 *   the headers of the response, the client gets 504 with no gRPC status, thus UNAVAILABLE. After them,
 *   RST_STREAM INTERNAL_ERROR. nginx does not retry a call that it sent.
 * - Each call has its own upstream connection, which ends with the call.
 * - A stopped worker: the timers that came due during the stop fire at the resume. They read one clock,
 *   which nginx reads after each wait of epoll_wait. After a stop and a continue, that wait fails with
 *   EINTR (signal(7)). Then nginx fires its timers before it reads any I/O. Thus a stop longer than
 *   grpc_read_timeout gives 504, also when the reply of the server waits in the socket.
 * - SIGQUIT and SIGHUP send GOAWAY NO_ERROR, and the worker waits for each stream. SIGTERM exits with
 *   no GOAWAY.
 */
export const NGINX_GRPC: Machine = machineSchema.parse({
  format: "mark1russell7.machine/1",
  id: "nginx-grpc",
  title: "nginx 1.29.6 as an HTTP/2 proxy of gRPC: one connection of a client, its idle close, the read timer of a call, and a stopped worker",
  layer: "proxy",
  version: "1.29.6",
  conditions: {
    nginx: "release-1.29.6 (the system nginx-pre-1.29.7)",
    configuration: "one worker, listen with http2 on, grpc_pass to one address with no upstream {} block, each directive at its built-in default",
  },
  sources: [
    { ref: `${AT} src/http/ngx_http_core_module.c:3540-3541, :3844-3845, :3885, :3894-3909 the defaults: client_header_timeout, client_body_timeout and send_timeout 60 s, keepalive_timeout 75 s, keepalive_time 1 h, lingering_time 30 s, lingering_timeout 5 s`, rung: "implemented" },
    { ref: `${AT} src/http/modules/ngx_http_grpc_module.c:4462-4469 grpc_connect_timeout, grpc_send_timeout and grpc_read_timeout: 60 s each`, rung: "implemented" },
    { ref: `${AT} ${V2}:3102-3104 a new stream deletes the read timer of the connection, and :668-670 the end of the last stream arms keepalive_timeout`, rung: "implemented" },
    { ref: `${AT} ${V2}:4694-4697, :4764-4769, :703-775 the idle timer sends GOAWAY NO_ERROR, then the lingering close: a FIN, and the input is dropped`, rung: "implemented" },
    { ref: `${AT} ${V2}:2325-2336 a PING of the client gets its ACK, and no timer moves`, rung: "implemented" },
    { ref: `${AT} ${UP}:2242-2249 the read timer arms when the request has gone to the upstream, and :4046-4051 it arms again after each read of the response`, rung: "implemented" },
    { ref: `${AT} ${UP}:2452-2454, :4606-4621, :4668-4672, :4879-4884 a read timeout before the headers of the response: no retry, then 504 (src/http/ngx_http_special_response.c:316-321), with no grpc-status`, rung: "implemented" },
    { ref: `${AT} ${UP}:3912-3915 and ${V2}:4521-4531 a read timeout after the headers: RST_STREAM INTERNAL_ERROR`, rung: "implemented" },
    { ref: `${AT} src/http/modules/ngx_http_grpc_module.c:4859 and ${UP}:6806-6816 grpc_pass to an address is an implicit upstream with no keepalive: each call has its own upstream connection, and ${UP}:4793-4822 it ends with the call`, rung: "implemented" },
    { ref: `${AT} src/core/nginx.c:1148 worker_processes is 1, and src/event/ngx_event.c:649-656 with :1369 no accept mutex: the handlers of I/O run in the processing of epoll_wait`, rung: "implemented" },
    { ref: `${AT} src/event/modules/ngx_epoll_module.c:804-823 the clock updates after epoll_wait, and an error of it (EINTR) returns before any event; src/event/ngx_event.c:248-263 then the timers fire; src/event/ngx_event_timer.c:53-96 each overdue timer, the earliest first`, rung: "implemented" },
    { ref: "signal(7): epoll_wait fails with EINTR after a stop signal and SIGCONT, also with no handler", rung: "documented" },
    { ref: `${AT} src/os/unix/ngx_process_cycle.c:203-244, :712-740 and src/core/ngx_connection.c:1433-1450 SIGQUIT and SIGHUP: GOAWAY NO_ERROR, and the worker waits for each stream; :723-726 SIGTERM: no GOAWAY`, rung: "implemented" },
  ],
  states: {
    "[none]": { initial: true, pseudo: true, note: "Before the accept of the connection of the client" },
    idle: { note: "The connection of the client, with no stream open. keepalive_timeout runs, or client_header_timeout before the first stream" },
    active: { note: "A stream is open. The connection has no timer, and the call has the read timer of its upstream socket" },
    stopped: { note: "The worker is stopped while a call is open. The kernel keeps each socket, and the reply of the server waits in its queue" },
    lingering: { note: "After the GOAWAY and the FIN: nginx drops the input until the lingering close ends" },
    ended: { final: true, note: "The connection of the client closed" },
  },
  events: {
    "local.accept": { kind: "local", note: "The worker accepts the connection of the client" },
    "rx.headers": { kind: "rx", note: "The headers of a new stream: a call. Its request goes to the upstream on a new connection" },
    "upstream.end": { kind: "local", note: "The response of the upstream ends with its trailers: the stream closes" },
    "timer.idle": { kind: "timer", note: "No stream open for keepalive_timeout" },
    "timer.upstream-read": { kind: "timer", note: "No read of the upstream socket for grpc_read_timeout" },
    "timer.lingering": { kind: "timer", note: "lingering_timeout with no input, or lingering_time in all" },
    "app.stop": { kind: "app", note: "SIGSTOP to the processes of nginx" },
    "app.cont": { kind: "app", note: "SIGCONT: the worker runs again" },
    "app.quit": { kind: "app", note: "SIGQUIT, or SIGHUP to the master, which sends SIGQUIT to the old worker" },
    "peer.fin": { kind: "peer", note: "The client ends the connection" },
    "peer.rst": { kind: "peer", note: "A reset of the connection of the client" },
    "tx.status": { kind: "tx", note: "504 with an HTML body and no grpc-status, before the headers of a response" },
    "tx.rst-stream": { kind: "tx", note: "RST_STREAM INTERNAL_ERROR of a stream whose response headers went out" },
    "tx.goaway": { kind: "tx", note: "A GOAWAY NO_ERROR to the client" },
    "tx.fin": { kind: "tx", note: "The FIN of the lingering close" },
  },
  knobs: {
    keepalive_timeout: { key: "keepalive_timeout", scope: "server", unit: "s", default: 75, note: "ngx_http_core_module.c:3896-3897. The stock nginx.conf sets 65" },
    client_header_timeout: { key: "client_header_timeout", scope: "server", unit: "s", default: 60, note: "ngx_http_core_module.c:3540-3541: the timer of a connection before its first stream" },
    grpc_read_timeout: { key: "grpc_read_timeout", scope: "location", unit: "s", default: 60, note: "ngx_http_grpc_module.c:4468-4469" },
    lingering_timeout: { key: "lingering_timeout", scope: "server", unit: "s", default: 5, note: "ngx_http_core_module.c:3908-3909" },
    lingering_time: { key: "lingering_time", scope: "server", unit: "s", default: 30, note: "ngx_http_core_module.c:3906-3907" },
    slack: { key: "the time of nginx for one step of its loop", scope: "process", unit: "s", default: 0.01, note: "An assumption of this document, not a value of nginx" },
  },
  timers: {
    idle: {
      duration: { knob: "keepalive_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["enter:idle"],
      cancels: ["rx.headers"],
      fires: "timer.idle",
      note: "From the end of the last stream (ngx_http_v2.c:668-670). A PING does not arm it again",
    },
    upstream_read: {
      duration: { knob: "grpc_read_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["rx.headers"],
      cancels: ["upstream.end"],
      fires: "timer.upstream-read",
      note: "From the send of the request to the upstream, and again after each read of the response (ngx_http_upstream.c:2242-2249, :4046-4051). In a stopped worker it comes due on the clock, and it fires at the resume",
    },
    lingering: {
      duration: { knob: "lingering_timeout", unit: "s" },
      lateness: { knob: "slack", unit: "s" },
      arms: ["tx.fin"],
      fires: "timer.lingering",
      note: "The close of the socket when no input comes for lingering_timeout. lingering_time bounds the whole close",
    },
  },
  transitions: [
    { id: "ng.accept", from: "[none]", to: "idle", on: "local.accept", timer: "idle", source: "src/http/ngx_http_request.c:356" },
    { id: "ng.stream", from: "idle", to: "active", on: "rx.headers", timer: "upstream_read", source: "ngx_http_v2.c:3102-3104" },
    { id: "ng.replied", from: "active", to: "idle", on: "upstream.end", timer: "idle", note: "The status of the upstream passes to the client in its trailers", source: "ngx_http_v2.c:4594-4603, :668-670" },
    {
      id: "ng.read-timeout",
      from: "active",
      to: "idle",
      on: "timer.upstream-read",
      timer: "upstream_read",
      guard: "no headers of the response went to the client",
      errno: "UNAVAILABLE",
      emits: ["tx.status"],
      note: "504 with no grpc-status, thus UNAVAILABLE Received HTTP status code 504. No retry",
      source: "ngx_http_upstream.c:2452-2454, :4606-4621, :4668-4672",
    },
    {
      id: "ng.read-timeout-streaming",
      from: "active",
      to: "idle",
      on: "timer.upstream-read",
      timer: "upstream_read",
      guard: "the headers of the response went to the client",
      errno: "INTERNAL",
      emits: ["tx.rst-stream"],
      source: "ngx_http_upstream.c:3912-3915, ngx_http_v2.c:4521-4531",
    },
    { id: "ng.stop", from: "active", to: "stopped", on: "app.stop", note: "The kernel keeps the sockets: ACKs go on, and the reply of the server waits in the queue of the upstream socket" },
    {
      id: "ng.resume-timeout",
      from: "stopped",
      to: "idle",
      on: "app.cont",
      guard: "the read timer came due during the stop, and no headers of the response went out",
      errno: "UNAVAILABLE",
      emits: ["tx.status"],
      note: "epoll_wait gives EINTR at the resume, thus each overdue timer fires before nginx reads the reply in the socket: 504, and the reply is dropped",
      source: "ngx_epoll_module.c:804-823, ngx_event.c:248-263, ngx_event_timer.c:53-96",
    },
    { id: "ng.resume", from: "stopped", to: "active", on: "app.cont", guard: "the read timer did not come due during the stop", note: "The reply in the socket goes to the client, late by the stop" },
    { id: "ng.idle", from: "idle", to: "lingering", on: "timer.idle", timer: "idle", emits: ["tx.goaway", "tx.fin"], note: "GOAWAY NO_ERROR with the last stream, then shutdown(SHUT_WR)", source: "ngx_http_v2.c:4694-4697, :4764-4769, :760-765" },
    { id: "ng.quit-idle", from: "idle", to: "lingering", on: "app.quit", emits: ["tx.goaway", "tx.fin"], source: "ngx_connection.c:1433-1450, ngx_http_v2.c:4694-4697" },
    { id: "ng.quit-active", from: "active", to: "active", on: "app.quit", emits: ["tx.goaway"], note: "The stream goes on, and later HEADERS are dropped. The worker waits for it, with no limit at the defaults", source: "ngx_http_v2.c:358-390, :1204-1208" },
    { id: "ng.lingered", from: "lingering", to: "ended", on: ["timer.lingering", "peer.fin", "peer.rst"], timer: "lingering", source: "ngx_http_v2.c:794-817" },
    { id: "ng.client-end", from: ["idle", "active"], to: "ended", on: ["peer.fin", "peer.rst"], source: "ngx_http_v2.c:4786-4815" },
  ],
  over: {
    machine: "systems.machine.linux-tcp",
    states: { idle: "ESTABLISHED", active: "ESTABLISHED", stopped: "ESTABLISHED", lingering: "FIN_WAIT2" },
    sets: {},
    ends: "peer.rst",
    note: "The socket toward the client: a Linux TCP socket with no keepalive (so_keepalive is off at the defaults). The lingering close sends a FIN with shutdown(SHUT_WR)",
  },
});
