import type { ServiceBuilder } from "@mark1russell7/service";
import { daemon, service } from "@mark1russell7/service";
import type { MongoClient } from "@mark1russell7/service/mongodb";
import { MONGO_STARTING_POLL } from "@mark1russell7/service/mongodb";
import { LOCAL_LISTENER_KNOBS, createProcedureHost } from "@procedures/peer";
import { mongoStore } from "./mongo-store.ts";
import { reference } from "./procedures.ts";
import { memoryStore } from "./store.ts";

const s = (value: number) => ({ value, unit: "s" });

/** These settings are the listener and the tenants of the reference service. */
export interface ReferenceSettings {
  readonly port: number;
  readonly host: string;
  /** This map gives the tenant of each token. */
  readonly tenants: Readonly<Record<string, string>>;
}

/**
 * This function declares the reference service: one service of `@mark1russell7/service`, and one
 * listener for HTTP and WebSocket. Nothing starts until `run()`. With a MongoDB client, the service
 * keeps its documents in the replica set, and its round-trip check gates readiness. Without it, the
 * service keeps its documents in memory.
 *
 * The readiness debounce counts the polls of the checks that it gates. Thus its interval is the
 * interval of their poll, `MONGO_STARTING_POLL`.
 */
export const referenceService = (settings: ReferenceSettings, mongo: MongoClient | undefined): ServiceBuilder => {
  const parts = reference(mongo ? mongoStore(mongo) : memoryStore(), settings.tenants);
  // The listener keeps the knobs of a local host: an idle close of 5 s. The driver holds each
  // connection busy through a run, thus the idle close does not cut it.
  const host = createProcedureHost({
    registry: parts.registry,
    policy: parts.policy,
    faces: { http: true, ws: true },
    listen: [{ port: settings.port, host: settings.host, knobs: LOCAL_LISTENER_KNOBS }],
  });
  const svc = host
    .declare(service("reference").profile(daemon))
    .readiness({ type: "debounce", interval: MONGO_STARTING_POLL.interval, failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(30) })
    .startup(s(30));
  return mongo ? mongo.attach(svc, { poll: MONGO_STARTING_POLL, steps: { "round-trip": "readiness" } }) : svc;
};
