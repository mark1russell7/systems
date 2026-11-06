import { describe, expect, it } from "vitest";
import { ALL } from "../all.ts";
import type { MongoSpec } from "./cells.ts";
import { MONGO_IMAGE } from "./cells.ts";
import { MONGO_CELLS, SET_DEFAULTS } from "./harness.ts";
import { contactAfterCut, lostOf } from "./model.ts";
import { predictT11 } from "./t11.ts";
import { T11_WRITES_CELLS, T11_WRITES_SPECS, WATCH } from "./writes.ts";

/** This time is how long a run continues after its lift with no watch, in seconds. */
const TAIL = 2;

const named =(plan: string) => {
  const found = T11_WRITES_CELLS.find((each) => each.name.startsWith(`${plan} `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

describe("the law of the writes that a rollback takes", () => {
  it("gives each try after a lift inside twice the hold and one RTO", () => {
    expect(contactAfterCut(3, 0.2)).toBe(6.2);
  });

  it("gives the band of T11.border-off.66 to w 1, at each round trip of the set", () => {
    expect(named("T11.writes.1").prediction.group?.lost).toEqual({ low: lostOf({}, {}, 2).lo, high: lostOf({}, {}, 2).hi });
    expect(named("T11.writes.1").prediction.group?.lost).toEqual({ low: 135, high: 202 });
  });

  it("gives no lost write to w majority over the same fault", () => {
    expect(named("T11.writes.2").prediction.group?.lost).toEqual({ low: 0, high: 0 });
  });

  it("gives no lost write and no failover to w 1 over a cut that ends before the election", () => {
    expect(named("T11.writes.3").prediction.group).toMatchObject({ lands: "same", failover: false, stages: [], lost: { low: 0, high: 0 }, quiet: ["elected", "written-off"] });
  });

  it("gives no band to a hold that can end on either side of the election", () => {
    const between: MongoSpec = { ...T11_WRITES_SPECS[0]!, hold: 6 };
    expect(() => predictT11(between)).toThrow(/either side of the election/);
  });
});

describe("the cells of SYS-59", () => {
  it("are in the joined catalog, each with the set of T11 and its write concern", () => {
    for (const cell of T11_WRITES_CELLS) {
      expect(ALL.some((each) => each.name === cell.name), cell.name).toBe(true);
      expect(cell.name).toMatch(/^T11\.writes\.\d+ mongodb-node-7\.7 to mongodb-replset of three, .*writes with w (1|majority)$/);
      expect(cell.replicaSet?.image).toBe(MONGO_IMAGE);
      expect(cell.replicaSet?.settings).toEqual(SET_DEFAULTS);
      expect(cell.fault).toBe("partition");
      expect(cell.faultAt).toEqual({ role: "primary", cuts: "group" });
      expect(cell.runs).toBe(4);
      expect(cell.environments).toBe(2);
      expect(cell.concurrency).toBe(1);
    }
    expect(T11_WRITES_CELLS.map((cell) => cell.writeConcern)).toEqual([1, "majority", 1]);
    expect(T11_WRITES_CELLS.map((cell) => cell.hold?.value)).toEqual([40, 40, 3]);
  });

  it("runs a short cut past the latest win of an election, and a failover for its own time", () => {
    const elected = named("T11.writes.1").prediction.group?.stages.find((stage) => stage.stage === "elected");
    expect(elected).toBeDefined();
    const short = named("T11.writes.3");
    expect(short.watch).toEqual({ value: WATCH, unit: "s" });
    expect(short.hold!.value + TAIL + WATCH).toBeGreaterThan(elected!.high.value);
    expect(named("T11.writes.1").watch).toBeUndefined();
    expect(named("T11.writes.2").watch).toBeUndefined();
  });

  it("judges each cell by the band of lost writes, with no band of time", () => {
    for (const cell of T11_WRITES_CELLS) {
      expect(cell.prediction.detects).toBeNull();
      expect(cell.prediction).toMatchObject({ from: "fault" });
    }
  });

  it("keeps the bands of the stages in the group of a failover", () => {
    for (const plan of ["T11.writes.1", "T11.writes.2"]) {
      const stages = named(plan).prediction.group?.stages.map((stage) => stage.stage);
      expect(stages).toContain("old-primary-steps-down");
      expect(stages).toContain("elected");
    }
  });

  it("leaves the cells of T11 as they were: 58 cells, and no band of lost writes", () => {
    expect(MONGO_CELLS).toHaveLength(58);
    for (const cell of MONGO_CELLS) expect(cell.prediction.group?.lost, cell.name).toBeUndefined();
  });
});
