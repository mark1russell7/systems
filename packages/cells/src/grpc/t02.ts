import type { Cell, HopSignal, Prediction, ProxyHop } from "@mark1russell7/harness";
import { DOCKER_PROXY_LINK, ENVOY_HTTP2, GRPC_JS, TOXIPROXY_LINK } from "@mark1russell7/machines";
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
 */

/** These are the proxies of the catalog. */
export type GrpcProxy = "envoy" | "toxiproxy" | "docker-proxy";

/** A spec of T02 is one cell of the plan through one proxy. */
export interface T02Spec {
  readonly plan: string;
  readonly name: string;
  readonly proxy: GrpcProxy;
  readonly fault: "rst" | "fin" | "hop-event";
  readonly mode: "idle" | "inflight";
  /** This side is the one that a fault at the proxy faces. */
  readonly toward?: "target";
  /** This signal is the event of a `hop-event` at the proxy. */
  readonly signal?: HopSignal;
}

/** This image is Envoy 1.39.4, pinned by digest. */
export const ENVOY_IMAGE = "envoyproxy/envoy:v1.39.4@sha256:74bd4eb5629708d3fadca1a5e6b85d208f338d7bb54e06b69565905c5294cc01";

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
const DOCUMENTS = { envoy: ENVOY_HTTP2, toxiproxy: TOXIPROXY_LINK, "docker-proxy": DOCKER_PROXY_LINK } as const;

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
    if (spec.proxy !== "envoy" || spec.toward !== "target" || spec.mode !== "inflight") throw new Error(`${spec.plan}: this catalog resets a call in flight at Envoy toward the target only`);
    // the upstream connection ends with a reset while the call waits: the local reply of Envoy, before any header of a response
    const reply = transition("env.upstream-reset");
    const ends = { ev: "error", name: "errno" } as const;
    return { detects: true, timer: "the local reply of Envoy to the reset of its upstream", errno: reply.errno!, from: "request-sent", low: s(0), high: s(hops + steps), rtt, driver: { socket: "connection", ends } };
  }
  if (spec.fault === "fin") {
    if (spec.proxy !== "toxiproxy") throw new Error(`${spec.plan}: this catalog stops the server behind Toxiproxy only`);
    // the FIN of the killed server ends the link from the upstream, and Toxiproxy closes the client: no half-close
    const close = transition("tl.upstream-end");
    if (!close.emits?.includes("tx.client-fin")) throw new Error(`${spec.plan}: ${doc.id} does not close the client at an end of the upstream`);
    return { detects: true, timer: "the FIN of the killed server, which Toxiproxy passes as a close of the client", errno: "EOF", from: "peer-closed", low: s(0), high: s(hops + steps), rtt, driver: { socket: "connection" } };
  }
  // a stop of the proxy: its process exits, and the kernel closes the socket of the client with a FIN
  const stop = transition(spec.proxy === "toxiproxy" ? "tl.stop" : spec.proxy === "docker-proxy" ? "dp.stop" : "env.stop");
  if (!stop.emits?.includes(spec.proxy === "envoy" ? "tx.fin" : "tx.client-fin")) throw new Error(`${spec.plan}: ${doc.id} does not close the client at its stop`);
  return { detects: true, timer: `the stop of ${spec.proxy}, whose exit closes the connection of the client`, errno: "EOF", from: "fault", low: s(0), high: s(hops + 2 * slackOf(doc) + slackOf(GRPC_JS)), rtt, driver: { socket: "connection" } };
};

/** These are the cells of T02 over grpc-js-1.14 and grpc-go-server that this catalog starts. */
export const T02_GRPC_SPECS: readonly T02Spec[] = [
  { plan: "T02.defaults.31", name: "through Envoy 1.39, rst at Envoy toward the server, a call in flight: Envoy answers UNAVAILABLE", proxy: "envoy", fault: "rst", mode: "inflight", toward: "target" },
  { plan: "T02.defaults.35", name: "through Toxiproxy 2.12, idle: SIGTERM stops Toxiproxy, and its exit closes the connection", proxy: "toxiproxy", fault: "hop-event", mode: "idle", signal: "TERM" },
  { plan: "T02.defaults.36", name: "through docker-proxy 29.1, idle: Docker stops docker-proxy with SIGINT, as at a restart of the container", proxy: "docker-proxy", fault: "hop-event", mode: "idle", signal: "INT" },
  { plan: "T02.defaults.48", name: "through Toxiproxy 2.12, fin, idle: the killed server ends the connection, and Toxiproxy closes both sockets", proxy: "toxiproxy", fault: "fin", mode: "idle" },
];

/** This function gives the name of a cell of T02. */
export const t02NameOf = (spec: T02Spec): string => `${spec.plan} grpc-js-1.14 to grpc-go-server, ${spec.name}`;

/** This function gives the harness cell of a spec of T02. */
export const t02Cell = (spec: T02Spec): Cell => {
  const hop = proxyHop(spec.proxy);
  return {
    name: t02NameOf(spec),
    target: grpcTarget("grpc-go"),
    sysctls: sysctlsOf(linuxValues()),
    probe: { mode: spec.mode, keepalive: false, driver: { name: "grpc" } },
    fault: spec.fault,
    prediction: t02Prediction(spec),
    topology: { name: "T02", hops: [hop] },
    ...(spec.toward === undefined ? {} : { faultAt: { hop: hop.name, toward: spec.toward } }),
    ...(spec.signal === undefined ? {} : { event: { hop: hop.name, signal: spec.signal } }),
    runs: RUNS,
    // a killed server, and a stopped proxy, cannot serve the next run: each run has its own environment
    environments: spec.fault === "rst" ? 2 : RUNS,
  };
};

/** These are the array cells that are their cells at the defaults: the profile sets no knob that the cell reads. */
export const T02_GRPC_ALIASES: readonly Alias[] = [
  { plan: "T02.array.31", is: "T02.defaults.31", why: "DP17 sets the timers of RDS Proxy: no knob of grpc-js, Envoy or grpc-go" },
  { plan: "T02.array.35", is: "T02.defaults.35", why: "DP20 sets the pool mode and the query timeout of a pooler: no knob of these systems" },
  { plan: "T02.array.36", is: "T02.defaults.36", why: "DP18 sets the timers of PgBouncer: no knob of these systems" },
  { plan: "T02.array.48", is: "T02.defaults.48", why: "DP01 sets the timers of an ALB and of a Node server: no knob of grpc-js, Toxiproxy or grpc-go" },
];

const NEXT = "the machine document of this proxy, from its source, is the next step of T02 (the facts are in, the document is not)";

/** These are the cells of the plan over these systems that this catalog does not start, each with its reason. */
export const T02_GRPC_WAITING: readonly Waiting[] = [
  { plan: "T02.defaults.32", trigger: "event:maxRequestsPerSocket", why: `Traefik 3.7: ${NEXT}. Its keepAliveMaxRequests is 0 (off) at its defaults` },
  { plan: "T02.defaults.33", trigger: "event:idle-gap", why: "the target of this tuple is Caddy 2.11, and Caddy serves no gRPC by itself: the health service of the client gets no reply" },
  { plan: "T02.defaults.34", trigger: "in-process:event-loop", why: "the harness has no injector that blocks the event loop of a worker of nginx" },
  { plan: "T02.defaults.41", trigger: "event:idle-gap", why: `Caddy 2.11: ${NEXT}` },
  { plan: "T02.array.32", trigger: "event:maxRequestsPerSocket", why: "as T02.defaults.32, under DP05: DP05 sets the timers of GCLB, no knob of Traefik" },
  { plan: "T02.array.33", trigger: "event:idle-gap", why: "as T02.defaults.33, under DP19" },
  { plan: "T02.array.34", trigger: "in-process:event-loop", why: "as T02.defaults.34, under DP08" },
  { plan: "T02.array.41", trigger: "event:idle-gap", why: "as T02.defaults.41, under DP07" },
  { plan: "T02.array.77", trigger: "event:proxy-reload", why: `Traefik 3.7: ${NEXT}. DP06 sets the keepalive of a backend of GCLB, no knob of Traefik` },
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
