import type { Cell, HopSignal, HopWrite, Prediction, ProxyHop } from "@mark1russell7/harness";
import { CADDY_HTTP2, DOCKER_PROXY_LINK, ENVOY_HTTP2, GRPC_JS, NGINX_GRPC, TOXIPROXY_LINK, TRAEFIK_HTTP2 } from "@mark1russell7/machines";
import { RUNS, s, sysctlsOf } from "../catalog.ts";
import type { Alias, Waiting } from "../mongo/cells.ts";
import { linuxValues } from "../mongo/model.ts";
import { TOXIPROXY_IMAGE } from "../topologies.ts";
import { GRPC_PORT, GRPC_RTT_MS, grpcTarget } from "./t01.ts";

/**
 * The gRPC catalog of T02: grpc-js 1.14.6, one proxy, and a server of grpc-go v1.84.0. Each band comes
 * from the machine document of the proxy, with the round trip of each hop and one step of each program.
 * - Envoy 1.39.4 answers a reset of its upstream itself, with a local reply: UNAVAILABLE at once.
 * - Toxiproxy 2.12.0 closes both sockets at an end of file of either side, and its stop closes them too.
 * - docker-proxy of Docker 29.1.5 ends each connection when Docker stops it, as at a restart.
 * - Caddy 2.11.7 sends GOAWAY on a connection with no stream for 5 min, and grpc-js drops that transport.
 * - nginx 1.29.6 fires each timer that came due during a stop of its worker at the resume. It does so
 *   before it reads the reply in the socket. Thus grpc_read_timeout gives 504, and grpc-js reads UNAVAILABLE.
 * - Traefik 3.7.15 swaps only its handlers at a reload, thus the client sees nothing. The GOAWAY of its
 *   idle timeout comes 180 s after the last stream.
 */

/** These are the proxies of the catalog. */
export type GrpcProxy = "envoy" | "toxiproxy" | "docker-proxy" | "caddy" | "nginx" | "traefik";

/** A spec of T02 is one cell of the plan through one proxy. */
export interface T02Spec {
  readonly plan: string;
  readonly name: string;
  readonly proxy: GrpcProxy;
  readonly fault: "rst" | "fin" | "hop-event" | "none";
  readonly mode: "idle" | "inflight";
  /**
   * This side is the one that a fault at the proxy faces. A fault there acts on the packets that come
   * from that side: a reset goes back to that side. Without it, the fault is at the server.
   */
  readonly toward?: "target";
  /** This signal is the event of a `hop-event` at the proxy. */
  readonly signal?: HopSignal;
  /** This time is the hold of a STOP, in seconds: the proxy thaws with CONT at its end. */
  readonly hold?: number;
  /** This time is how long the server of the harness holds the call in flight, in seconds. */
  readonly held?: number;
  /** This write is the event of a `hop-event` that changes a file of the proxy: a reload. */
  readonly write?: HopWrite;
}

/** This image is Envoy 1.39.4, pinned by digest. */
export const ENVOY_IMAGE = "envoyproxy/envoy:v1.39.4@sha256:74bd4eb5629708d3fadca1a5e6b85d208f338d7bb54e06b69565905c5294cc01";

/** This image is Caddy 2.11.7, pinned by digest. */
export const CADDY_IMAGE = "caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af";

/** This image is nginx 1.29.6 on Alpine, pinned by digest: the system nginx-pre-1.29.7. */
export const NGINX_IMAGE = "nginx:1.29.6-alpine@sha256:f46cb72c7df02710e693e863a983ac42f6a9579058a59a35f1ae36c9958e4ce0";

/**
 * This configuration is the nginx.conf of the document `nginx-grpc`, in place of the stock one. It has
 * one server of h2c and grpc_pass to the next hop, with each timer at its built-in default. The stock file
 * sets keepalive_timeout 65 and worker_processes auto. The error log at notice gives the ready line.
 */
const NGINX_CONF = `error_log stderr notice;
events {}
http {
  server {
    listen ${GRPC_PORT};
    http2 on;
    location / {
      grpc_pass grpc://{{next}};
    }
  }
}
`;

/** This image is Traefik 3.7.15, pinned by digest. */
export const TRAEFIK_IMAGE = "traefik:v3.7.15@sha256:0f6150202bc1fed72a7bd2107460eaa510e5b8a905f3fdb5b84f2c8619c33368";

/**
 * This configuration is the static configuration of Traefik for the document `traefik-http2`: one
 * entrypoint, and the file provider over a folder. The log at DEBUG gives the line of each build of
 * the routers (`Creating server`), thus the ready line and the confirm of a reload.
 *
 * The check for a new version and the anonymous usage are off. At their defaults, Traefik calls
 * GitHub and its own collector over the internet during a run. That calls no hop of the cell, but a
 * cell must not depend on the internet.
 */
const TRAEFIK_STATIC = `global:
  checkNewVersion: false
  sendAnonymousUsage: false
entryPoints:
  grpc:
    address: ":${GRPC_PORT}"
providers:
  file:
    directory: /etc/traefik/dynamic
log:
  level: DEBUG
`;

/** This dynamic file is the router to the next hop over h2c, for each path. A reload does not change it. */
const TRAEFIK_MAIN = `http:
  routers:
    grpc:
      entryPoints: [grpc]
      rule: "PathPrefix(\`/\`)"
      service: grpc
  services:
    grpc:
      loadBalancer:
        servers:
          - url: "h2c://{{next}}"
`;

/** This function gives a dynamic file with a spare router for another host: the part of the configuration that a reload changes. */
const traefikSpare = (host: string): string => `http:
  routers:
    spare:
      entryPoints: [grpc]
      rule: "Host(\`${host}\`)"
      service: spare
  services:
    spare:
      loadBalancer:
        servers:
          - url: "h2c://127.0.0.1:9"
`;

/** This path is the dynamic file that a reload writes. */
export const TRAEFIK_SPARE_PATH = "/etc/traefik/dynamic/spare.yml";

/**
 * This write is a reload of Traefik: a change of the spare router, which no call reads. It is a
 * change of the configuration, thus Traefik builds its routers again and logs `Creating server`.
 * The undo writes the first spare router back, thus each run makes the same change.
 */
export const TRAEFIK_RELOAD: HopWrite = {
  path: TRAEFIK_SPARE_PATH,
  content: traefikSpare("reloaded.example"),
  undo: traefikSpare("spare.example"),
  confirm: "Creating server",
};

/** This configuration is the Caddyfile of the document `caddy-http2`: one server of h1 and h2c, and reverse_proxy to the next hop over h2c. */
const CADDYFILE = `{
	servers {
		protocols h1 h2c
	}
}
:${GRPC_PORT} {
	reverse_proxy h2c://{{next}}
}
`;

/**
 * This configuration is the static configuration of Envoy for the document `envoy-http2`. It has one
 * listener with the HTTP connection manager and the router, and one route to one cluster. The cluster
 * speaks HTTP/2 to the next hop. Each other field is at its default: the route has no timeout of its own.
 */
const ENVOY_CONFIG = `static_resources:
  listeners:
  - name: grpc
    address: { socket_address: { address: 0.0.0.0, port_value: ${GRPC_PORT} } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: grpc
          codec_type: AUTO
          route_config:
            virtual_hosts:
            - name: grpc
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: server }
          http_filters:
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
  - name: server
    type: STATIC
    load_assignment:
      cluster_name: server
      endpoints:
      - lb_endpoints:
        - endpoint: { address: { socket_address: { address: "{{next.host}}", port_value: {{next.port}} } } }
    typed_extension_protocol_options:
      envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
        "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
        explicit_http_config:
          http2_protocol_options: {}
`;

/**
 * This script starts docker-proxy as dockerd starts it for a published port. Its status goes to fd 3.
 * In Docker that is the pipe of its parent, and here it is /dev/null. docker-proxy writes nothing when
 * it listens, thus the script tells it.
 */
const DOCKER_PROXY_SCRIPT = `/usr/local/bin/docker-proxy -proto tcp -host-ip 0.0.0.0 -host-port ${GRPC_PORT} -container-ip {{next.host}} -container-port {{next.port}} 3>/dev/null &
until netstat -ltn | grep -q ':${GRPC_PORT} '; do sleep 0.05; done
echo "docker-proxy listens on ${GRPC_PORT}"
wait
`;

/** This function gives the hop of a proxy. */
export const proxyHop = (proxy: GrpcProxy): ProxyHop => {
  switch (proxy) {
    case "envoy":
      return {
        name: "envoy",
        kind: "proxy",
        image: ENVOY_IMAGE,
        port: GRPC_PORT,
        command: ["-c", "/envoy.yaml"],
        files: { "/envoy.yaml": ENVOY_CONFIG },
        ready: "starting main dispatch loop",
        program: "envoy",
      };
    case "toxiproxy":
      return {
        name: "toxiproxy",
        kind: "proxy",
        image: TOXIPROXY_IMAGE,
        port: GRPC_PORT,
        command: ["-host=0.0.0.0", "-config", "/toxiproxy.json"],
        files: { "/toxiproxy.json": JSON.stringify([{ name: "grpc", listen: `0.0.0.0:${GRPC_PORT}`, upstream: "{{next}}", enabled: true }]) },
        ready: "Starting Toxiproxy HTTP server",
        program: "toxiproxy",
      };
    case "caddy":
      return {
        name: "caddy",
        kind: "proxy",
        image: CADDY_IMAGE,
        port: GRPC_PORT,
        command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
        files: { "/etc/caddy/Caddyfile": CADDYFILE },
        ready: "serving initial configuration",
        program: "caddy",
      };
    case "nginx":
      return {
        name: "nginx",
        kind: "proxy",
        image: NGINX_IMAGE,
        port: GRPC_PORT,
        command: ["nginx", "-g", "daemon off;"],
        files: { "/etc/nginx/nginx.conf": NGINX_CONF },
        ready: "start worker process",
        program: "nginx",
      };
    case "traefik":
      return {
        name: "traefik",
        kind: "proxy",
        image: TRAEFIK_IMAGE,
        port: GRPC_PORT,
        command: ["traefik", "--configFile=/etc/traefik/traefik.yml"],
        files: {
          "/etc/traefik/traefik.yml": TRAEFIK_STATIC,
          "/etc/traefik/dynamic/main.yml": TRAEFIK_MAIN,
          [TRAEFIK_SPARE_PATH]: traefikSpare("spare.example"),
        },
        ready: "Creating server",
        program: "traefik",
      };
    case "docker-proxy":
      return {
        name: "docker-proxy",
        kind: "proxy",
        image: { kind: "shipped", name: "docker-proxy" },
        port: GRPC_PORT,
        command: ["sh", "/proxy.sh"],
        files: { "/proxy.sh": DOCKER_PROXY_SCRIPT },
        ready: `docker-proxy listens on ${GRPC_PORT}`,
        program: "docker-proxy",
      };
  }
};

/** These are the documents of the proxies, by their names. */
const DOCUMENTS = { envoy: ENVOY_HTTP2, toxiproxy: TOXIPROXY_LINK, "docker-proxy": DOCKER_PROXY_LINK, caddy: CADDY_HTTP2, nginx: NGINX_GRPC, traefik: TRAEFIK_HTTP2 } as const;

/** This function gives the slack of one step of a program, from its document: the assumption that each document states. */
const slackOf = (doc: (typeof DOCUMENTS)[GrpcProxy] | typeof GRPC_JS): number => {
  const value = doc.knobs["slack"]?.default;
  if (typeof value !== "number") throw new Error(`${doc.id} gives no slack`);
  return value;
};

/**
 * This function gives the prediction of a cell of T02. Each band holds the round trip of each of the
 * two hops, one step of the proxy and one step of Node for the client. A stop of the proxy also holds
 * the exit of its process: one more step.
 */
export const t02Prediction = (spec: T02Spec): Prediction => {
  const doc = DOCUMENTS[spec.proxy];
  const hops = (2 * GRPC_RTT_MS) / 1000;
  const steps = slackOf(doc) + slackOf(GRPC_JS);
  const rtt = { low: { value: 0, unit: "ms" }, high: { value: GRPC_RTT_MS, unit: "ms" } } as const;
  const transition = (id: string) => {
    const found = doc.transitions.find((each) => each.id === id);
    if (found === undefined) throw new Error(`${spec.plan}: ${doc.id} has no transition ${id}`);
    return found;
  };
  if (spec.fault === "rst") {
    if (spec.proxy !== "envoy" || spec.toward !== undefined || spec.mode !== "inflight") throw new Error(`${spec.plan}: this catalog resets a call in flight at the server behind Envoy only`);
    // the server answers the request of Envoy with a reset: the upstream connection ends while the call
    // waits, and Envoy sends its local reply, before any header of a response. A reset at the hop toward
    // the target would reset the server instead, and Envoy would wait for the timeout of its route
    const reply = transition("env.upstream-reset");
    const ends = { ev: "error", name: "errno" } as const;
    return { detects: true, timer: "the local reply of Envoy to the reset of its upstream", errno: reply.errno!, from: "request-sent", low: s(0), high: s(hops + steps), rtt, driver: { socket: "connection", ends } };
  }
  if (spec.fault === "none") {
    if (spec.proxy !== "caddy" || spec.mode !== "idle") throw new Error(`${spec.plan}: this catalog keeps an idle connection through Caddy only`);
    // an idle gap longer than the idle timeout of Caddy: its timer starts at the close of the last stream,
    // just before the last data of the client, and its GOAWAY makes grpc-js drop the transport
    const idle = transition("cd.idle");
    if (!idle.emits?.includes("tx.goaway")) throw new Error(`${spec.plan}: ${doc.id} sends no GOAWAY at its idle timeout`);
    const timeout = doc.knobs["idle_timeout"]?.default;
    if (typeof timeout !== "number") throw new Error(`${spec.plan}: ${doc.id} gives no idle timeout`);
    const ends = { ev: "state", where: { to: "IDLE" }, name: "to" } as const;
    return { detects: true, timer: "the idle timeout of Caddy, and its GOAWAY", errno: "IDLE", from: "last-data", low: s(timeout - hops / 2), high: s(timeout + hops / 2 + steps), rtt, driver: { socket: "connection", ends } };
  }
  if (spec.fault === "fin") {
    if (spec.proxy !== "toxiproxy") throw new Error(`${spec.plan}: this catalog stops the server behind Toxiproxy only`);
    // the FIN of the killed server ends the link from the upstream, and Toxiproxy closes the client: no half-close
    const close = transition("tl.upstream-end");
    if (!close.emits?.includes("tx.client-fin")) throw new Error(`${spec.plan}: ${doc.id} does not close the client at an end of the upstream`);
    return { detects: true, timer: "the FIN of the killed server, which Toxiproxy passes as a close of the client", errno: "EOF", from: "peer-closed", low: s(0), high: s(hops + steps), rtt, driver: { socket: "connection" } };
  }
  if (spec.fault === "hop-event" && spec.write !== undefined) {
    if (spec.proxy !== "traefik" || spec.mode !== "idle") throw new Error(`${spec.plan}: this catalog reloads Traefik in an idle gap only`);
    // the reload swaps the handlers and sends nothing: the idle timer of the connection goes on from the
    // close of the last stream, and its GOAWAY makes grpc-js drop the transport
    const reload = transition("tf.reload-idle");
    if ((reload.emits ?? []).length > 0) throw new Error(`${spec.plan}: ${doc.id} sends a frame at a reload`);
    const idle = transition("tf.idle");
    if (!idle.emits?.includes("tx.goaway")) throw new Error(`${spec.plan}: ${doc.id} sends no GOAWAY at its idle timeout`);
    const timeout = doc.knobs["idle_timeout"]?.default;
    if (typeof timeout !== "number") throw new Error(`${spec.plan}: ${doc.id} gives no idle timeout`);
    const ends = { ev: "state", where: { to: "IDLE" }, name: "to" } as const;
    return {
      detects: true,
      timer: "the idle timeout of Traefik, and its GOAWAY: the reload sends nothing",
      errno: "IDLE",
      from: "last-data",
      low: s(Math.round((timeout - hops / 2) * 1e6) / 1e6),
      high: s(Math.round((timeout + hops / 2 + steps) * 1e6) / 1e6),
      rtt,
      driver: { socket: "connection", ends },
    };
  }
  if (spec.fault === "hop-event" && spec.signal === "STOP") {
    if (spec.proxy !== "nginx" || spec.mode !== "inflight" || spec.hold === undefined || spec.held === undefined)
      throw new Error(`${spec.plan}: this catalog stops nginx for a hold, with a held call in flight, only`);
    // the call reaches the server before the STOP, and the server holds it. Its read timer comes due in the
    // stop, and its reply waits in the socket. At the CONT, epoll_wait gives EINTR and nginx fires the timer
    // before it reads the reply: 504, one round trip after the end of the hold
    const read = doc.knobs["grpc_read_timeout"]?.default;
    if (typeof read !== "number") throw new Error(`${spec.plan}: ${doc.id} gives no grpc_read_timeout`);
    if (spec.hold <= read + 1 || spec.held >= read) throw new Error(`${spec.plan}: the hold must pass grpc_read_timeout (${read} s), and the reply must come before it`);
    const resume = transition("ng.resume-timeout");
    const ends = { ev: "error", name: "errno" } as const;
    return {
      detects: true,
      timer: "grpc_read_timeout of nginx: due in the stop of its worker, it fires at the resume, before nginx reads the reply in the socket",
      errno: resume.errno!,
      from: "fault",
      low: s(spec.hold),
      high: s(spec.hold + hops + steps),
      rtt,
      driver: { socket: "connection", ends },
    };
  }
  // a stop of the proxy: its process exits, and the kernel closes the socket of the client with a FIN
  const stop = transition(spec.proxy === "toxiproxy" ? "tl.stop" : spec.proxy === "docker-proxy" ? "dp.stop" : "env.stop");
  if (!stop.emits?.includes(spec.proxy === "envoy" ? "tx.fin" : "tx.client-fin")) throw new Error(`${spec.plan}: ${doc.id} does not close the client at its stop`);
  return { detects: true, timer: `the stop of ${spec.proxy}, whose exit closes the connection of the client`, errno: "EOF", from: "fault", low: s(0), high: s(hops + 2 * slackOf(doc) + slackOf(GRPC_JS)), rtt, driver: { socket: "connection" } };
};

/** These are the cells of T02 over grpc-js-1.14 and grpc-go-server that this catalog starts. */
export const T02_GRPC_SPECS: readonly T02Spec[] = [
  { plan: "T02.defaults.31", name: "through Envoy 1.39, rst at the server, a call in flight: Envoy answers UNAVAILABLE", proxy: "envoy", fault: "rst", mode: "inflight" },
  { plan: "T02.defaults.35", name: "through Toxiproxy 2.12, idle: SIGTERM stops Toxiproxy, and its exit closes the connection", proxy: "toxiproxy", fault: "hop-event", mode: "idle", signal: "TERM" },
  { plan: "T02.defaults.36", name: "through docker-proxy 29.1, idle: Docker stops docker-proxy with SIGINT, as at a restart of the container", proxy: "docker-proxy", fault: "hop-event", mode: "idle", signal: "INT" },
  { plan: "T02.defaults.48", name: "through Toxiproxy 2.12, fin, idle: the killed server ends the connection, and Toxiproxy closes both sockets", proxy: "toxiproxy", fault: "fin", mode: "idle" },
  { plan: "T02.defaults.41", name: "through Caddy 2.11, an idle gap of 5 min: Caddy sends GOAWAY, and grpc-js drops the transport", proxy: "caddy", fault: "none", mode: "idle" },
  {
    plan: "T02.defaults.34",
    name: "through nginx 1.29.6, a call in flight: its worker stops 90 s, and at the resume nginx answers 504 before it reads the reply",
    proxy: "nginx",
    fault: "hop-event",
    mode: "inflight",
    signal: "STOP",
    hold: 90,
    held: 5,
  },
  {
    plan: "T02.array.77",
    name: "through Traefik 3.7, a reload in an idle gap: the reload sends nothing, and the GOAWAY of the idle timeout comes 180 s after the last stream",
    proxy: "traefik",
    fault: "hop-event",
    mode: "idle",
    write: TRAEFIK_RELOAD,
  },
];

/** This function gives the name of a cell of T02. */
export const t02NameOf = (spec: T02Spec): string => `${spec.plan} grpc-js-1.14 to grpc-go-server, ${spec.name}`;

/** This function gives the harness cell of a spec of T02. */
export const t02Cell = (spec: T02Spec): Cell => {
  const hop = proxyHop(spec.proxy);
  // a TERM or an INT ends the proxy. A STOP freezes it and its CONT thaws it, and a write changes its
  // configuration: the proxy serves the next run
  const exits = spec.fault === "hop-event" && (spec.signal === "TERM" || spec.signal === "INT");
  return {
    name: t02NameOf(spec),
    target: grpcTarget("grpc-go"),
    sysctls: sysctlsOf(linuxValues()),
    probe: { mode: spec.mode, keepalive: false, driver: { name: "grpc", ...(spec.held === undefined ? {} : { hold: s(spec.held) }) } },
    fault: spec.fault,
    prediction: t02Prediction(spec),
    topology: { name: "T02", hops: [hop] },
    ...(spec.toward === undefined ? {} : { faultAt: { hop: hop.name, toward: spec.toward } }),
    ...(spec.signal === undefined ? {} : { event: { hop: hop.name, signal: spec.signal, ...(spec.mode === "inflight" ? { inFlight: true as const } : {}) } }),
    ...(spec.write === undefined ? {} : { event: { hop: hop.name, write: spec.write } }),
    ...(spec.hold === undefined ? {} : { hold: s(spec.hold) }),
    // a stopped proxy ends its environment: the warm-up is a dry run, as for the kill of a server
    ...(exits ? { fresh: true } : {}),
    runs: RUNS,
    // a killed server, and a proxy that exits, cannot serve the next run: each run has its own environment
    environments: spec.fault === "rst" || (spec.fault === "hop-event" && !exits) ? 2 : RUNS,
  };
};

/** These are the array cells that are their cells at the defaults: the profile sets no knob that the cell reads. */
export const T02_GRPC_ALIASES: readonly Alias[] = [
  { plan: "T02.array.31", is: "T02.defaults.31", why: "DP17 sets the timers of RDS Proxy: no knob of grpc-js, Envoy or grpc-go" },
  { plan: "T02.array.35", is: "T02.defaults.35", why: "DP20 sets the pool mode and the query timeout of a pooler: no knob of these systems" },
  { plan: "T02.array.36", is: "T02.defaults.36", why: "DP18 sets the timers of PgBouncer: no knob of these systems" },
  { plan: "T02.array.48", is: "T02.defaults.48", why: "DP01 sets the timers of an ALB and of a Node server: no knob of grpc-js, Toxiproxy or grpc-go" },
  { plan: "T02.array.41", is: "T02.defaults.41", why: "DP07 sets the timeouts of ingress-nginx: no knob of Caddy" },
];

/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T02_GRPC_WAITING: readonly Waiting[] = [
  {
    plan: "T02.defaults.32",
    trigger: "event:maxRequestsPerSocket",
    why: "keepAliveMaxRequests of Traefik 3.7 is 0 (off) at its defaults (pkg/config/static/entrypoints.go:203-217): no event comes",
  },
  { plan: "T02.defaults.33", trigger: "event:idle-gap", why: "the target of this tuple is Caddy 2.11, and Caddy serves no gRPC by itself: the health service of the client gets no reply" },
  { plan: "T02.array.32", trigger: "event:maxRequestsPerSocket", why: "as T02.defaults.32, under DP05: DP05 sets the timers of GCLB, no knob of Traefik" },
  { plan: "T02.array.33", trigger: "event:idle-gap", why: "as T02.defaults.33, under DP19" },
  {
    plan: "T02.array.34",
    trigger: "in-process:event-loop",
    why: "DP08 sets a keepalive of the upstream, thus an upstream {} block, where nginx 1.29.6 and 1.29.7 differ, and worker_shutdown_timeout. Its workload is busy (λ·S ≫ 1), and the client of the harness holds one call in flight",
  },
  ...(["74", "75", "76", "78"] as const).map((n) => ({
    plan: `T02.array.${n}`,
    trigger: "event:maxRequestsPerSocket",
    why: "docker-proxy copies TCP and counts no request (cmd/docker-proxy/tcp_proxy_linux.go:27-77): the trigger does not apply to it",
  })),
  {
    plan: "T02.array.79",
    trigger: "event:maxRequestsPerSocket",
    why: "max_requests_per_connection of Envoy is off at its defaults (protocol.proto:405-409), and DP19 sets no knob of Envoy: no event comes",
  },
];

/** These are the gRPC cells of T02 for the harness. */
export const T02_GRPC: readonly Cell[] = T02_GRPC_SPECS.map(t02Cell);
