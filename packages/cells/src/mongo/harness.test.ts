import type { Cell } from "@mark1russell7/harness";
import { REPLICA_SET_STAGES } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import { ALL } from "../all.ts";
import { T01_HIKARI } from "../pg/hikari.ts";
import { T01_PG } from "../pg/t01.ts";
import { T03_HIKARI } from "../pg/t03.ts";
import { T10_HIKARI, T10_PG } from "../pg/t10.ts";
import { T01_AMQP } from "../rabbit/t01.ts";
import { T11_RABBIT } from "../rabbit/t11.ts";
import { MONGO_CELLS, MONGO_ONE, MEMBER_STAMPS, SET_DEFAULTS, longestWait } from "./harness.ts";

const named = (prefix: string): Cell => {
  const found = MONGO_CELLS.find((cell) => cell.name.startsWith(`${prefix} `));
  if (found === undefined) throw new Error(`no cell ${prefix}`);
  return found;
};

describe("the MongoDB cells, for the harness", () => {
  it("gives each cell of the three catalogs once, with a name of its own, before the PostgreSQL and RabbitMQ cells at the end of the catalogs", () => {
    expect(MONGO_CELLS).toHaveLength(58);
    expect(new Set(ALL.map((cell) => cell.name)).size).toBe(ALL.length);
    const after = [...T01_PG, ...T01_HIKARI, ...T03_HIKARI, ...T10_HIKARI, ...T10_PG, ...T01_AMQP, ...T11_RABBIT];
    expect(ALL.slice(-(MONGO_CELLS.length + after.length), -after.length)).toEqual(MONGO_CELLS);
    expect(ALL.slice(-after.length)).toEqual(after);
  });

  it("names the socket and the line of each band of a driver against one member", () => {
    // a write in flight into a black hole: the write-off, then the interruption and the retry's selection
    const hole = named("T01.defaults.1").prediction;
    expect(hole).toMatchObject({ detects: true, errno: "MongoNetworkTimeoutError", from: "last-received" });
    if (hole.detects !== true) throw new Error("a detection");
    expect(hole.driver).toMatchObject({ socket: "monitor", ends: { ev: "sdam", where: { event: "heartbeat-failed" } } });
    expect(hole.driver?.then?.map((step) => [step.name, step.ends.ev])).toEqual([
      ["PoolClearedOnNetworkError", "command"],
      ["MongoServerSelectionError", "fail"],
    ]);
    // the kernel ends the band of an idle pool. An ICMP unreachable stops the monitor's stream after one reply: its write-off is a later band
    const idle = named("T01.defaults.42").prediction;
    expect(idle).toMatchObject({ errno: "ETIMEDOUT", driver: { socket: "pool" } });
    if (idle.detects !== true) throw new Error("a detection");
    expect(idle.driver?.ends).toBeUndefined();
    expect(idle.driver?.quiet).toBeUndefined();
    expect(idle.driver?.then?.map((step) => [step.name, step.socket, step.from, step.low.value])).toEqual([["MongoNetworkTimeoutError", "monitor", "last-received", 49.999]]);
    // a fault before the client: the first selection counts from the start of the client
    expect(named("T01.defaults.47")).toMatchObject({ before: true, prediction: { from: "client-start", driver: { ends: { ev: "fail", where: { why: "connect" } } } } });
    // mongod's own socket of the pool connection, behind the router
    expect(named("T03.defaults.28")).toMatchObject({ observer: "server", prediction: { driver: { socket: "server" } }, faultAt: { hop: "nat", toward: "client" } });
  });

  it("times a stall with the recovery of Linux TCP, and a reply after a thaw from the fault", () => {
    const stall = named("T01.defaults.44");
    expect(stall.prediction).toMatchObject({ detects: false, recovers: { firing: expect.any(Number) } });
    expect(stall.stall).toEqual({ value: 1, unit: "s" });
    const thaw = named("T01.border-off.59");
    expect(thaw).toMatchObject({ hold: { value: 29, unit: "s" }, target: MONGO_ONE });
    expect(thaw.prediction).toMatchObject({ detects: false, replies: { low: { value: 29 } }, driver: { reply: { from: "fault", ends: { ev: "ack", where: { n: 2 } } } } });
  });

  it("starts each set of one member, freezes mongod by its process, and reads a long document from the setup", () => {
    for (const cell of MONGO_CELLS.filter((each) => each.replicaSet === undefined)) {
      expect(cell.target.program, cell.name).toBe("mongod");
      expect(cell.targetSetup?.[0]?.join(" "), cell.name).toContain("rs.initiate");
    }
    expect(named("T03.defaults.4").targetSetup).toHaveLength(2);
    expect(named("T03.defaults.4").probe.driver).toEqual({ name: "mongodb", set: "rs0", op: "read-long" });
    // a fin ends its environment: each run has its own
    expect(named("T01.defaults.41").environments).toBe(11);
  });

  it("gives each cell of T11 a replica set of three, its stages with the stamps of the members, and its quiet stages", () => {
    const sets = MONGO_CELLS.filter((cell) => cell.replicaSet !== undefined);
    expect(sets).toHaveLength(17);
    for (const cell of sets) {
      expect(cell.replicaSet?.members, cell.name).toEqual(["m1", "m2", "m3"]);
      expect(cell.prediction.group?.stamps, cell.name).toEqual(MEMBER_STAMPS);
      for (const band of cell.prediction.group?.stages ?? []) expect(REPLICA_SET_STAGES, cell.name).toContain(band.stage);
    }
    expect(named("T11.border-off.48").replicaSet?.settings).toEqual({ ...SET_DEFAULTS, electionTimeoutMillis: 40000 });
    const partial = sets.find((cell) => cell.faultAt !== undefined && "cuts" in cell.faultAt && cell.faultAt.cuts === "one")!;
    expect(partial.prediction.group).toMatchObject({ lands: "same", failover: false, quiet: ["elected", "written-off"] });
    expect(partial.hold).toEqual({ value: 40, unit: "s" });
    const cut = sets.find((cell) => cell.stall !== undefined)!;
    expect(cut.prediction).toMatchObject({ detects: false, recovers: { firing: expect.any(Number) }, group: { lands: "same" } });
    expect(named("T11.border-off.66").writeConcern).toBe(1);
    expect(named("T11.defaults.1").fault).toBe("step-down");
  });

  it("waits no longer than the longest band or hold of a cell", () => {
    expect(longestWait(named("T01.border-off.21"))).toBeGreaterThan(100);
    expect(longestWait(named("T03.defaults.1"))).toBe(400);
  });
});
