import { describe, expect, it } from "vitest";
import { ALL, needsContainerlab, SCHEDULED_CELLS } from "./all.ts";
import { FABRIC_CELLS } from "./fabric.ts";
import { needsOf } from "./needs.ts";

const none = (): string => {
  throw new Error("no file");
};

describe("the needs of a shard of the workflow Cells", () => {
  it("gives containerlab to each cell on a fabric, and to no other cell", () => {
    expect(ALL.filter(needsContainerlab).map((each) => each.name)).toEqual(FABRIC_CELLS.map((each) => each.name));
  });

  it("installs containerlab for a run of '.', not only for a run whose only names E3", () => {
    const all = needsOf({ CELLS_ONLY: "." }, none);
    expect(all.containerlab).toBe(true);
    expect(all.cells).toEqual(FABRIC_CELLS.map((each) => each.name));
    expect(needsOf({ CELLS_ONLY: "^E3[.]" }, none).containerlab).toBe(true);
    expect(needsOf({ CELLS_ONLY: "^WS" }, none)).toEqual({ containerlab: false, cells: [], disk: { value: 0, unit: "B" } });
  });

  it("gives the shards of a run their own needs, and together they hold each cell on a fabric", () => {
    const shards = [0, 1, 2].map((shard) => needsOf({ CELLS_ONLY: ".", CELLS_SHARD: `${shard}/3` }, none));
    expect(shards.flatMap((each) => each.cells).sort()).toEqual(FABRIC_CELLS.map((each) => each.name).sort());
    for (const each of shards) expect(each.containerlab).toBe(each.cells.length > 0);
  });

  it("reads a scheduled selection as the runner does", () => {
    for (const selection of Object.keys(SCHEDULED_CELLS)) {
      const scheduled = SCHEDULED_CELLS[selection] ?? /^$/;
      const expected = FABRIC_CELLS.filter((each) => scheduled.test(each.name)).map((each) => each.name);
      expect(needsOf({ CELLS_SELECTION: selection }, none).cells, selection).toEqual(expected);
    }
    expect(() => needsOf({ CELLS_SELECTION: "refresh-0", CELLS_ONLY: "^E3" }, none)).toThrow("takes no CELLS_ONLY");
  });

  it("gives a shard the most disk of its drills: the data on each member, the dump and an oplog of the whole data on each member", () => {
    const gb = 8_000 * 1_048_576;
    expect(needsOf({ CELLS_ONLY: "^RD[.]8000[.]" }, none).disk).toEqual({ value: 7 * gb, unit: "B" });
    // the Sunday run holds the drills of 1 GB at most, and the drill of 8 GB waits for its first measured time
    expect(needsOf({ CELLS_SELECTION: "drills" }, none).disk).toEqual({ value: 7 * 1_000 * 1_048_576, unit: "B" });
    expect(needsOf({ CELLS_ONLY: "^RD[.]" }, none).disk).toEqual({ value: 7 * gb, unit: "B" });
  });

  it("reads the cells of a file in place of the catalogs, and gives no need to a limiter pair", () => {
    const file = JSON.stringify([FABRIC_CELLS[0]]);
    expect(needsOf({ CELLS_FILE: "cells.json" }, () => file).cells).toEqual([FABRIC_CELLS[0]?.name]);
    expect(needsOf({ CELLS_PAIR: "0.5.6,0.6.0", CELLS_ONLY: "." }, none)).toEqual({ containerlab: false, cells: [], disk: { value: 0, unit: "B" } });
  });
});
