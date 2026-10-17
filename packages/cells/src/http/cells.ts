import { readFileSync } from "node:fs";
import type { Cell, Client, HttpProbe, Prediction, Target } from "@mark1russell7/harness";
import type { Extent } from "@mark1russell7/quantity";
import { HZ, LINUX_66, RUNS, ms, s, sysctlsOf } from "../catalog.ts";
import { router } from "../topologies.ts";
import type { HttpCell, HttpSpec } from "./catalog.ts";
import { HTTP_CAL, HTTP_CELLS } from "./catalog.ts";
import type { HttpClient } from "./race.ts";
import type { AgentSettings, GoSettings, NodeServerSettings, UndiciSettings } from "./settings.ts";

/** This image is the stock Node 24.21.0 of the server, pinned by digest: the Node of the client images of the harness. */
export const NODE_IMAGE = "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1";

/** This text is the script of the server: one file, with no imports but those of Node. */
export const SERVER_SCRIPT = readFileSync(new URL("../../targets/node-http-server.mjs", import.meta.url), "utf8");

/** This port is the port of the server in the target. */
const PORT = 8080;

/** These are the flags of the server script, by the names of the settings of the document. */
const SERVER_FLAGS: Readonly<Record<keyof NodeServerSettings, string>> = {
  keepAliveTimeout: "--keep-alive-timeout-ms",
  keepAliveTimeoutBuffer: "--keep-alive-timeout-buffer-ms",
  headersTimeout: "--headers-timeout-ms",
  requestTimeout: "--request-timeout-ms",
  connectionsCheckingInterval: "--checking-interval-ms",
  maxRequestsPerSocket: "--max-requests-per-socket",
  timeout: "--timeout-ms",
};

/**
 * This function gives the Node HTTP server as a target: the stock image with the script in it.
 * Each setting that the cell gives is a flag. A held server is the child of a shell, thus a `fin`
 * fault can stop it while the container stays up.
 */
export const nodeServer = (settings: NodeServerSettings, held = false): Target => {
  const flags = Object.entries(settings).flatMap(([name, value]) => [SERVER_FLAGS[name as keyof NodeServerSettings], String(value)]);
  const run = ["node", "/srv/server.mjs", "--port", String(PORT), ...flags];
  return {
    image: NODE_IMAGE,
    port: PORT,
    ready: '"ev":"listening"',
    files: { "/srv/server.mjs": SERVER_SCRIPT },
    lines: true,
    command: held ? ["sh", "-c", `${run.join(" ")} & echo $! > /tmp/server.pid; while :; do sleep 3600; done`] : run,
    ...(held ? { kill: ["sh", "-c", 'kill -KILL "$(cat /tmp/server.pid)"'] } : {}),
  };
};

/** These are the clients of the harness for each client of the catalog. */
const CLIENTS: Readonly<Record<HttpClient, Client>> = { go: "go-http", agent: "http-agent", undici: "undici" };

/** These are the flags of each client for the settings of its document. Each has the factor from the unit of the document to the unit of the flag. */
const CLIENT_FLAGS: Readonly<Record<HttpClient, Readonly<Record<string, readonly [string, number]>>>> = {
  go: {
    IdleConnTimeout: ["idle-conn-timeout-ms", 1000],
    MaxIdleConnsPerHost: ["max-idle-per-host", 1],
    DialTimeout: ["dial-timeout-ms", 1000],
    KeepAlive: ["keepalive-ms", 1000],
    KeepAliveInterval: ["keepalive-interval-ms", 1000],
    KeepAliveCount: ["keepalive-count", 1],
    Timeout: ["timeout-ms", 1000],
  } satisfies Readonly<Record<keyof GoSettings, readonly [string, number]>>,
  agent: {
    timeout: ["timeout-ms", 1],
    keepAliveMsecs: ["keepalive-msecs", 1],
    agentKeepAliveTimeoutBuffer: ["buffer-ms", 1],
  } satisfies Readonly<Record<keyof AgentSettings, readonly [string, number]>>,
  undici: {
    keepAliveTimeout: ["keepalive-timeout-ms", 1],
    keepAliveMaxTimeout: ["keepalive-max-timeout-ms", 1],
    keepAliveTimeoutThreshold: ["keepalive-threshold-ms", 1],
    headersTimeout: ["headers-timeout-ms", 1],
    bodyTimeout: ["body-timeout-ms", 1],
    connectTimeout: ["connect-timeout-ms", 1],
    keepAliveInitialDelay: ["keepalive-initial-delay-ms", 1],
  } satisfies Readonly<Record<keyof UndiciSettings, readonly [string, number]>>,
};

/** This function gives the settings of the client of a spec as the flags of its program. */
export const optionsOf = (spec: HttpSpec): Record<string, number> => {
  const settings: object = (spec.client === "go" ? spec.go : spec.client === "agent" ? spec.agent : spec.undici) ?? {};
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(settings)) {
    const flag = CLIENT_FLAGS[spec.client][name];
    if (flag === undefined) throw new Error(`${spec.name}: ${spec.client} has no flag for ${name}`);
    out[flag[0]] = Math.round(Number(value) * flag[1] * 1000) / 1000;
  }
  return out;
};

/** This function gives the HTTP workload of a spec for the harness. */
const probeOf = (spec: HttpSpec): HttpProbe => {
  const { workload } = spec;
  const options = optionsOf(spec);
  const common = Object.keys(options).length === 0 ? {} : { options };
  if (workload.mode === "gap") return { method: workload.method, gap: s(workload.gap), ...common };
  if (workload.mode === "idle") return { method: "GET", ...common };
  return {
    method: workload.method,
    ...(workload.hold === undefined ? {} : { hold: ms(workload.hold) }),
    ...(workload.bytes === undefined ? {} : { bytes: workload.bytes }),
    ...common,
  };
};

/** This function gives the values of Linux TCP for the sysctls of the namespace of the observer of a spec. */
const namespaceOf = (spec: HttpSpec): Record<string, Extent> => ({
  ...LINUX_66,
  ...spec.linux,
  hz: { value: HZ, unit: "Hz" },
  rtt: ms(1),
});

/**
 * This function gives the cell of the harness for a cell of the HTTP catalog:
 * - The target is the Node server with the settings of the spec. A client `fin` holds it under a
 *   shell, and each run then has its own environment.
 * - The namespace of the observer gets the knobs of Linux TCP as sysctls. The client of a cell on
 *   the server side gets only the ICMP rate limit, as in T01.
 * - A T03 cell has the router of its form, and its fault faces the client from the router. An MTU
 *   drop faces the target, where the long segments come from.
 */
export const harnessCellOf = (http: HttpCell): Cell => {
  const { spec } = http;
  const server = spec.observer === "server";
  const killsServer = spec.fault === "fin" && !server;
  const namespace = sysctlsOf(namespaceOf(spec));
  const icmp = spec.fault === "unreachable" ? { "net.ipv4.icmp_ratelimit": "0" } : {};
  const atRouter = spec.router !== undefined && spec.fault !== "middlebox-forget";
  const sysctls = server ? (atRouter ? {} : icmp) : namespace;
  const targetSysctls = server
    ? { ...namespace, ...(spec.fault === "mtu-blackhole" ? { "net.ipv4.tcp_mtu_probing": "0" } : {}) }
    : atRouter
      ? {}
      : icmp;
  const prediction: Prediction = http.request === null ? http.prediction : { ...http.prediction, request: http.request };
  const hop = spec.router === undefined ? undefined : router(spec.router.form, spec.router.idle);
  return {
    name: http.name,
    target: nodeServer(spec.server, killsServer),
    sysctls,
    client: CLIENTS[spec.client],
    probe: { mode: spec.workload.mode, keepalive: false, http: probeOf(spec) },
    fault: spec.fault,
    prediction,
    ...(server ? { observer: "server" as const } : {}),
    ...(Object.keys(targetSysctls).length === 0 ? {} : { targetSysctls }),
    ...(spec.stall === undefined ? {} : { stall: s(spec.stall) }),
    ...(spec.icmp === undefined ? {} : { icmp: spec.icmp }),
    ...(spec.drops === undefined ? {} : { drops: spec.drops }),
    ...(spec.mtu === undefined ? {} : { mtu: spec.mtu }),
    ...(spec.latency === undefined ? {} : { latency: ms(spec.latency) }),
    ...(hop === undefined
      ? {}
      : {
          // the router sends each ICMP error of a fault at it: its rate limit is 0, thus each retransmission draws one
          topology: {
            name: "T03",
            hops: [spec.fault === "unreachable" ? { ...hop, sysctls: { "net.ipv4.icmp_ratelimit": "0" } } : hop],
          },
          ...(atRouter ? { faultAt: { hop: hop.name, toward: spec.fault === "mtu-blackhole" ? ("target" as const) : ("client" as const) } } : {}),
          // the listing of a router reaps the expired flows of each namespace: the cells of T03 go one at a time
          concurrency: 1,
        }),
    runs: RUNS,
    environments: killsServer ? RUNS : 2,
  };
};

/** These are the cells of the HTTP catalog for the harness: T01, then T03. */
export const HTTP_HARNESS_CELLS: readonly Cell[] = HTTP_CELLS.map(harnessCellOf);

/** These are the calibration cells of the handling time of the Node clients, for the harness. */
export const HTTP_CAL_CELLS: readonly Cell[] = HTTP_CAL.map(harnessCellOf);
