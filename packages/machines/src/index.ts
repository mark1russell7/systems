// @mark1russell7/machines: the machine documents of the systems program, in one place. Each
// document is a `mark1russell7.machine/1` document of @mark1russell7/algebra. It describes one
// system at one version from its source, and each fact names its file and line. The schema of the
// algebra examines each document at load. A document changes only for a reason from its source
// (a citation) or from a measurement (a run).

import type { Machine } from "@mark1russell7/algebra";
import { ETCD_SERVER, GRPC_GO_SERVER } from "./grpc/grpc-go-server.ts";
import { GRPC_JS } from "./grpc/grpc-js.ts";
import { GO_TRANSPORT } from "./http/go-transport.ts";
import { NODE_HTTP_AGENT } from "./http/node-agent.ts";
import { NODE_HTTP_SERVER } from "./http/node-server.ts";
import { UNDICI_CLIENT } from "./http/undici.ts";
import { UNDICI_RETRY } from "./http/undici-retry.ts";
import { IOREDIS_SENTINEL } from "./ioredis-sentinel.ts";
import { IOREDIS_STATUS, LINUX_TCP, NF_CONNTRACK_TCP, REDIS_CLIENT } from "./json.ts";
import { MONGOD_REPL } from "./mongo/mongod-replication.ts";
import { MONGOD_SESSION } from "./mongo/mongod-session.ts";
import { MONGODB_NODE } from "./mongo/mongodb-node.ts";
import { HIKARICP_PGJDBC } from "./pg/hikaricp-pgjdbc.ts";
import { NODE_POSTGRES } from "./pg/node-postgres.ts";
import { PGBOUNCER_CLIENT } from "./pg/pgbouncer.ts";
import { PGBOUNCER_SERVER } from "./pg/pgbouncer-server.ts";
import { PGPOOL_SESSION } from "./pg/pgpool.ts";
import { POSTGRES_SESSION } from "./pg/postgres-session.ts";
import { SUPAVISOR_CLIENT } from "./pg/supavisor-client.ts";
import { SUPAVISOR_SERVER } from "./pg/supavisor-server.ts";
import { PROCEDURES_WS_CLIENT, PROCEDURES_WS_SERVER } from "./procedures-ws.ts";
import { CADDY_HTTP2 } from "./proxy/caddy.ts";
import { ENVOY_HTTP2 } from "./proxy/envoy.ts";
import { ISTIO_SIDECAR_INBOUND, ISTIO_SIDECAR_OUTBOUND, PILOT_AGENT, istioSidecar } from "./proxy/istio.ts";
import { NGINX_GRPC } from "./proxy/nginx.ts";
import { TRAEFIK_HTTP2 } from "./proxy/traefik.ts";
import { DOCKER_PROXY_LINK, TOXIPROXY_LINK } from "./proxy/tcp-proxies.ts";
import { AMQPLIB } from "./rabbit/amqplib.ts";
import { ATEN_DETECTOR } from "./rabbit/aten.ts";
import { RA_MEMBER } from "./rabbit/ra-member.ts";
import { RABBITMQ_CONNECTION } from "./rabbit/rabbitmq-connection.ts";
import { SENTINEL } from "./sentinel.ts";

export {
  AMQPLIB,
  ATEN_DETECTOR,
  CADDY_HTTP2,
  DOCKER_PROXY_LINK,
  ENVOY_HTTP2,
  ETCD_SERVER,
  GO_TRANSPORT,
  GRPC_GO_SERVER,
  GRPC_JS,
  HIKARICP_PGJDBC,
  IOREDIS_SENTINEL,
  IOREDIS_STATUS,
  ISTIO_SIDECAR_INBOUND,
  ISTIO_SIDECAR_OUTBOUND,
  LINUX_TCP,
  MONGOD_REPL,
  MONGOD_SESSION,
  MONGODB_NODE,
  NF_CONNTRACK_TCP,
  NGINX_GRPC,
  NODE_HTTP_AGENT,
  NODE_HTTP_SERVER,
  NODE_POSTGRES,
  PGBOUNCER_CLIENT,
  PGBOUNCER_SERVER,
  PGPOOL_SESSION,
  PILOT_AGENT,
  POSTGRES_SESSION,
  PROCEDURES_WS_CLIENT,
  PROCEDURES_WS_SERVER,
  RA_MEMBER,
  RABBITMQ_CONNECTION,
  REDIS_CLIENT,
  SENTINEL,
  SUPAVISOR_CLIENT,
  SUPAVISOR_SERVER,
  TOXIPROXY_LINK,
  TRAEFIK_HTTP2,
  UNDICI_CLIENT,
  UNDICI_RETRY,
};
export type { SidecarSide } from "./proxy/istio.ts";
export { istioSidecar };
export { MANIFESTATIONS } from "./json.ts";
export {
  NODE_TIMER_EARLY,
  UNDICI_TICK_MS,
  goLateSeconds,
  goTimerLateness,
  nodeEarlySeconds,
  nodeLateSeconds,
  nodeTimerLateness,
  undiciFastEarly,
  undiciFastLateness,
} from "./http/timers.ts";

/** This function gives each document by its identifier. Two documents with one identifier stop the import. */
const byId = (documents: readonly Machine[]): Readonly<Record<string, Machine>> => {
  const out: Record<string, Machine> = {};
  for (const document of documents) {
    if (out[document.id] !== undefined) throw new Error(`two machine documents have the identifier ${document.id}`);
    out[document.id] = document;
  }
  return Object.freeze(out);
};

/**
 * This map holds each document of the package by its identifier, for example `linux-tcp`. A
 * document on another machine names that machine in `over.machine` as `systems.machine.<id>`.
 */
export const MACHINES: Readonly<Record<string, Machine>> = byId([
  LINUX_TCP,
  NF_CONNTRACK_TCP,
  REDIS_CLIENT,
  IOREDIS_STATUS,
  IOREDIS_SENTINEL,
  SENTINEL,
  NODE_HTTP_SERVER,
  NODE_HTTP_AGENT,
  UNDICI_CLIENT,
  UNDICI_RETRY,
  GO_TRANSPORT,
  PROCEDURES_WS_CLIENT,
  PROCEDURES_WS_SERVER,
  MONGODB_NODE,
  MONGOD_REPL,
  MONGOD_SESSION,
  NODE_POSTGRES,
  POSTGRES_SESSION,
  HIKARICP_PGJDBC,
  PGBOUNCER_CLIENT,
  PGBOUNCER_SERVER,
  PGPOOL_SESSION,
  SUPAVISOR_CLIENT,
  SUPAVISOR_SERVER,
  AMQPLIB,
  RABBITMQ_CONNECTION,
  ATEN_DETECTOR,
  RA_MEMBER,
  GRPC_JS,
  GRPC_GO_SERVER,
  ETCD_SERVER,
  TOXIPROXY_LINK,
  DOCKER_PROXY_LINK,
  ENVOY_HTTP2,
  CADDY_HTTP2,
  NGINX_GRPC,
  TRAEFIK_HTTP2,
  ISTIO_SIDECAR_OUTBOUND,
  ISTIO_SIDECAR_INBOUND,
  PILOT_AGENT,
]);
