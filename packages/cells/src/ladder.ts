import { fileURLToPath } from "node:url";
import type { BuildImage, Cell, LoadStream, ProxyHop } from "@mark1russell7/harness";
import { constant } from "@mark1russell7/rigor-chaos";
import { RUNS, ms, q } from "./catalog.ts";
import { INITIATE, MONGO_ONE } from "./mongo/harness.ts";
import { SET_NAME } from "./mongo/cells.ts";

/**
 * The cells of the scale ladder (SYS-93). The reference service of `packages/reference` is a hop
 * between the client and a MongoDB replica set of one member. The client `load` holds one
 * connection for each active tenant, and it sends the requests of that tenant on an open-loop
 * schedule. Thus a slow reply does not delay the next send, and each latency counts from its
 * planned time.
 *
 * A rung names its count of tenants. Ten percent of them are active, and at least one is. Each
 * active tenant sends 10 requests each second. The rung holds when the share of failed arrivals is
 * under its limit: 1 minus the availability of the rung. The verdict reads the Wilson interval at
 * 0.95, thus each rung has enough arrivals to decide. This slice measures the latency, and the first
 * records set its budgets. The other tenants, as data at rest, are a later slice.
 */

/** This folder is the build context of the hop: the package of the reference service. */
const CONTEXT = fileURLToPath(new URL("../../reference/", import.meta.url));

/** These are the files of the context that the Dockerfile reads, by their path in the context. */
export const REFERENCE_FILES: readonly string[] = [
  "image/Dockerfile",
  "image/package.json",
  "image/npm-lock.json",
  "src/main.ts",
  "src/service.ts",
  "src/procedures.ts",
  "src/store.ts",
  "src/mongo-store.ts",
];

/** This build is the image of the reference service: Node, the sources, and the packages of its lockfile. */
export const REFERENCE_BUILD: BuildImage = { kind: "build", name: "reference", context: CONTEXT, dockerfile: "image/Dockerfile", files: REFERENCE_FILES };

/** This port is the port of the listener of the reference service, for HTTP and WebSocket. */
const PORT = 8080;

/** This path is the file of the tokens and the tenants in the hop. */
const TENANTS_PATH = "/srv/tenants.json";

/** This path is the file of the address of the replica set in the hop. The lab writes the address of the next hop into it. */
const MONGO_ENV = "/srv/mongo.env";

/** A rung is one step of the ladder: its count of tenants and its availability, as a share. */
export interface Rung {
  readonly tenants: number;
  readonly availability: number;
}

/** These are the rungs of SYS-93: 1, 10, 100 and 1,000 tenants. */
export const RUNGS: readonly Rung[] = [
  { tenants: 1, availability: 0.99 },
  { tenants: 10, availability: 0.995 },
  { tenants: 100, availability: 0.999 },
  { tenants: 1_000, availability: 0.999 },
];

/** This rate is the requests of one active tenant each second. */
export const TENANT_RATE = 10;

/** This function gives the count of active tenants of a rung: ten percent, and at least one. */
export const activeOf = (rung: Rung): number => Math.max(1, Math.floor(rung.tenants / 10));

/** This function gives the name of tenant `index`, with four digits: `t0001` is the first. */
export const tenantName = (index: number): string => `t${String(index + 1).padStart(4, "0")}`;

/** This function gives the token of a tenant. The tokens are not secret: the service holds no data but the data of the cell. */
export const tokenOf = (tenant: string): string => `token-${tenant}`;

/**
 * This function gives the count of arrivals that decides the limit of a rung with no failure. For
 * 0 failures in n arrivals, the upper end of the Wilson interval at 0.95 is z² / (n + z²). The count
 * is the least n that puts that end under the limit. Thus a limit of 1 % needs 381 arrivals.
 */
export const decidingCount = (limit: number): number => {
  const z = 1.959963984540054;
  return Math.floor((z * z * (1 - limit)) / limit) + 1;
};

/** This time is the shortest schedule of a run, in ms. A short run gives more weight to the start of a connection. */
const SHORTEST = 5_000;

/**
 * This function gives the time of the schedule of each run of a rung, in ms. The counted runs
 * together hold at least the deciding count of arrivals, and each run takes 5 s at least.
 */
export const durationOf = (rung: Rung): number => {
  const rate = activeOf(rung) * TENANT_RATE;
  const each = Math.ceil(decidingCount(1 - rung.availability) / RUNS);
  return Math.max(SHORTEST, Math.ceil(each / rate) * 1000);
};

/** This name is the `Host` of each request. The listener checks it only on a loopback socket, and the socket of a hop is not one. */
export const REFERENCE_HOST = "reference";

/** This function gives one HTTP/1.1 request of the procedure wire: a POST of a JSON body to `/api/<service>/<operation>`. */
export const procedureRequest = (path: string, token: string, input: unknown, host: string = REFERENCE_HOST): string => {
  const body = JSON.stringify(input);
  return [
    `POST /api/${path} HTTP/1.1`,
    `Host: ${host}`,
    "Content-Type: application/json",
    `Authorization: Bearer ${token}`,
    "Procedures-Protocol: 1",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
};

/** This function gives the requests of a tenant: a put of its document, then a get of it. The stream sends them in turn. */
export const tenantRequests = (tenant: string, host: string = REFERENCE_HOST): readonly string[] => {
  const token = tokenOf(tenant);
  return [procedureRequest("doc/put", token, { id: "d0", body: { tenant } }, host), procedureRequest("doc/get", token, { id: "d0" }, host)];
};

/** This function gives the streams of a rung: one connection for each active tenant, each on its own Poisson schedule. */
export const ladderStreams = (rung: Rung): readonly LoadStream[] =>
  Array.from({ length: activeOf(rung) }, (_, index) => {
    const tenant = tenantName(index);
    return {
      key: tenant,
      plan: { profile: constant(TENANT_RATE, durationOf(rung)), options: { arrivals: "poisson", seed: `LADDER.${rung.tenants}.${tenant}` } },
      requests: tenantRequests(tenant),
    };
  });

/**
 * This function gives the hop of the reference service for a rung. The service reads the address of
 * the replica set from a file, because the lab writes the address of the next hop only into files.
 * The file of the tenants names each tenant of the rung.
 */
export const referenceHop = (rung: Rung): ProxyHop => ({
  name: "reference",
  kind: "proxy",
  image: REFERENCE_BUILD,
  port: PORT,
  command: ["sh", "-c", `set -a; . ${MONGO_ENV}; exec node /srv/src/main.ts`],
  environment: { PORT: String(PORT), HOST: "0.0.0.0", TENANTS: TENANTS_PATH, MONGO_REPLICA_SET: SET_NAME, MONGO_DATABASE: "reference" },
  files: {
    [MONGO_ENV]: "MONGO_HOST={{next.host}}\nMONGO_PORT={{next.port}}\n",
    [TENANTS_PATH]: JSON.stringify(Object.fromEntries(Array.from({ length: rung.tenants }, (_, index) => [tokenOf(tenantName(index)), tenantName(index)]))),
  },
  ready: "WebSocket server listening",
  program: "node",
});

/** This time is the longest lag of a send behind its time on a hosted runner. A later send is a finding of its run. */
const LAG = ms(50);

/** This function gives the cell of a rung. */
export const ladderCell = (rung: Rung): Cell => {
  const active = activeOf(rung);
  const rate = active * TENANT_RATE;
  const seconds = durationOf(rung) / 1000;
  const limit = Math.round((1 - rung.availability) * 1e6) / 1e6;
  const tenants = rung.tenants === 1 ? "1 tenant" : `${rung.tenants.toLocaleString("en-US")} tenants`;
  return {
    name: `LADDER.${rung.tenants}, ${tenants} and ${active} active, ${rate.toLocaleString("en-US")} requests each second for ${seconds} s through the reference service to MongoDB, nothing injected`,
    target: MONGO_ONE,
    targetSetup: [INITIATE],
    sysctls: {},
    client: "load",
    probe: { mode: "schedule", keepalive: false, streams: ladderStreams(rung) },
    fault: "none",
    topology: { name: "LADDER", hops: [referenceHop(rung)] },
    prediction: {
      detects: null,
      window: q(seconds * 2 + 20),
      why: `the rung of ${tenants} at an availability of ${rung.availability * 100} %: ${RUNS} runs give ${(RUNS * rate * seconds).toLocaleString("en-US")} arrivals, and ${decidingCount(limit).toLocaleString("en-US")} with no failure decide it`,
      load: { lag: LAG, bands: [], failures: limit },
    },
    runs: RUNS,
    environments: 2,
    concurrency: 1,
  };
};

/** These are the cells of the ladder, one for each rung. */
export const LADDER_CELLS: readonly Cell[] = RUNGS.map(ladderCell);
