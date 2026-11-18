/**
 * The entry of the reference service: one process, one service of `@mark1russell7/service`, and
 * one listener for HTTP and WebSocket (`service.ts`). Only this file starts `run()`.
 *
 * The environment gives the settings:
 *
 * - `PORT` and `HOST`: the listener. The defaults are 8080 and 0.0.0.0, for a container.
 * - `TENANTS`: the path of a JSON file that maps each token to its tenant.
 * - `MONGO_HOST`, `MONGO_PORT`, `MONGO_REPLICA_SET` and `MONGO_DATABASE`: the replica set. Without
 *   `MONGO_HOST`, the service keeps its documents in memory.
 */
import { readFileSync } from "node:fs";
import { MONGO_STARTING_KNOBS, mongoClient } from "@mark1russell7/service/mongodb";
import { STORE_OPERATIONS } from "./mongo-store.ts";
import { referenceService } from "./service.ts";

const env = process.env;

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

const svc = referenceService({ port: Number(env["PORT"] ?? 8080), host: env["HOST"] ?? "0.0.0.0", tenants }, mongo);
await svc.run();
