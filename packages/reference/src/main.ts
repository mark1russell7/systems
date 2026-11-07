/**
 * The entry of the reference service: one process, one service of `@mark1russell7/service`, and
 * one listener for HTTP and WebSocket. Only this file starts `run()`.
 *
 * The environment gives the settings:
 *
 * - `PORT` and `HOST`: the listener. The defaults are 8080 and 0.0.0.0, for a container.
 * - `TENANTS`: the path of a JSON file that maps each token to its tenant.
 * - `MONGO_HOST`, `MONGO_PORT`, `MONGO_REPLICA_SET` and `MONGO_DATABASE`: the replica set. Without
 *   `MONGO_HOST`, the service keeps its documents in memory.
 */
import { readFileSync } from "node:fs";
import { daemon, service } from "@mark1russell7/service";
import { MONGO_STARTING_KNOBS, MONGO_STARTING_POLL, mongoClient } from "@mark1russell7/service/mongodb";
import { LOCAL_LISTENER_KNOBS, createProcedureHost } from "@procedures/peer";
import { STORE_OPERATIONS, mongoStore } from "./mongo-store.ts";
import { reference } from "./procedures.ts";
import { memoryStore } from "./store.ts";

const env = process.env;
const s = (value: number) => ({ value, unit: "s" });

const tenantsPath = env["TENANTS"];
if (!tenantsPath) throw new Error("TENANTS names no file of tokens and tenants");
const tenants = JSON.parse(readFileSync(tenantsPath, "utf8")) as Record<string, string>;

const mongo = env["MONGO_HOST"]
  ? mongoClient("mongo", {
      host: env["MONGO_HOST"],
      port: Number(env["MONGO_PORT"] ?? 27017),
      replicaSet: env["MONGO_REPLICA_SET"],
      database: env["MONGO_DATABASE"] ?? "reference",
      system: "systems.component.mongodb",
      knobs: MONGO_STARTING_KNOBS,
      pool: { max: 10, min: 1 },
      operations: STORE_OPERATIONS,
    })
  : undefined;

const parts = reference(mongo ? mongoStore(mongo) : memoryStore(), tenants);
// The listener keeps the knobs of a local host: an idle close of 5 s. The driver holds each
// connection busy through a run, thus the idle close does not cut it.
const host = createProcedureHost({
  registry: parts.registry,
  policy: parts.policy,
  faces: { http: true, ws: true },
  listen: [{ port: Number(env["PORT"] ?? 8080), host: env["HOST"] ?? "0.0.0.0", knobs: LOCAL_LISTENER_KNOBS }],
});

let svc = host
  .declare(service("reference").profile(daemon))
  .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
  .liveness({ type: "window", failAfter: s(30) })
  .startup(s(30));
if (mongo) svc = mongo.attach(svc, { poll: MONGO_STARTING_POLL, steps: { "round-trip": "readiness" } });
await svc.run();
