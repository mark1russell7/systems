import { MONGO_STARTING_KNOBS, MONGO_STARTING_POLL, mongoClient } from "@mark1russell7/service/mongodb";
import { describe, expect, it } from "vitest";
import { STORE_OPERATIONS } from "./mongo-store.ts";
import { referenceService } from "./service.ts";

const SETTINGS = { port: 0, host: "127.0.0.1", tenants: { "token-a": "a" } };

// The client connects only at `run()`, thus a host with no server is enough for the declaration.
const mongo = () =>
  mongoClient("mongo", {
    host: "127.0.0.1",
    port: 1,
    replicaSet: "rs0",
    database: "reference",
    system: "systems.component.mongodb",
    knobs: MONGO_STARTING_KNOBS,
    pool: { max: 10, min: 1 },
    operations: STORE_OPERATIONS,
  });

describe("the declaration of the reference service", () => {
  // The cells of SYS-93 found this: the service stopped at its start, because its debounce counted
  // polls of 1 s and the round-trip check of MongoDB polls each 5 s.
  it("passes the checks of describe() with MongoDB, and its debounce counts the polls of the round-trip check", () => {
    const description = referenceService(SETTINGS, mongo()).describe();
    expect(description.policies.readiness).toMatchObject({ type: "debounce", interval: MONGO_STARTING_POLL.interval });
    const check = description.checks.find((each) => each.name === "mongo.round-trip");
    expect(check).toMatchObject({ gates: "readiness", poll: { interval: MONGO_STARTING_POLL.interval } });
  });

  it("passes the checks of describe() with the store in memory", () => {
    expect(() => referenceService(SETTINGS, undefined).describe()).not.toThrow();
  });
});
