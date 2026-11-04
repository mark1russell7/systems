import { describe, expect, it } from "vitest";
import recovery from "./recovery-2026-11-04.json";

/** This count is the writes that a restore can lose past the last backup: a write each 50 ms for 10 s, and two in flight. */
const SLICE_BOUND = 202;

const drill = (id: string) => recovery.drills.find((each) => each.id === id)!;
const restores = recovery.drills.filter((each) => each.recovery === "restore" && each.id !== "RD.control");

/** SYS-94: the recovery drills, from the run 41896338150. */
describe("the copy of the recovery drills holds the figures of its run", () => {
  it("has the 6 drills, and each holds with 4 counted runs and no void run", () => {
    expect(recovery.workflow).toBe(41896338150);
    expect(recovery.cells.map((cell) => [cell.name.split(" ")[0], cell.decision, cell.counted, cell.voided])).toEqual([
      ["RD.1", "holds", 4, 0],
      ["RD.100.failover", "holds", 4, 0],
      ["RD.100.restore", "holds", 4, 0],
      ["RD.1000.failover", "holds", 4, 0],
      ["RD.1000.restore", "holds", 4, 0],
      ["RD.control", "holds", 4, 0],
    ]);
  });

  it("holds each rung, and each rung is locked", () => {
    expect(recovery.verdict.held).toBe("1000");
    expect(recovery.verdict.failed).toBe(false);
    expect(recovery.ladder.rungs.map((rung) => rung.locked)).toEqual([true, true, true]);
  });

  it("loses real writes in each restore, and each one comes after the last backup", () => {
    for (const each of restores) {
      for (const run of each.runs) {
        expect(run.lost, each.id).toBeGreaterThan(0);
        expect(run.lost, each.id).toBe(run.afterBackup);
        expect(run.holes, each.id).toBe(0);
        expect(run.sameData, each.id).toBe(true);
      }
    }
    for (const run of [...drill("RD.100.restore").runs, ...drill("RD.1000.restore").runs]) expect(run.lost).toBeLessThanOrEqual(SLICE_BOUND);
  });

  it("loses no write with a copy left", () => {
    for (const id of ["RD.control", "RD.100.failover", "RD.1000.failover"]) expect(drill(id).runs.map((run) => run.lost), id).toEqual([0, 0, 0, 0]);
  });

  it("restores a real dump of each size", () => {
    expect(drill("RD.1000.restore").runs.map((run) => run.dump?.value ?? 0).every((bytes) => bytes > 1_000_000_000)).toBe(true);
    expect(drill("RD.100.restore").runs.map((run) => run.dump?.value ?? 0).every((bytes) => bytes > 100_000_000)).toBe(true);
    expect(drill("RD.1").runs.map((run) => run.dump?.value ?? 0).every((bytes) => bytes > 1_000_000)).toBe(true);
  });

  it("gives the growth of the time with the size: 1.44 times from 100 MB to 1 GB, not 3 to 12", () => {
    const median = (id: string) => recovery.cells.find((cell) => cell.name.startsWith(`${id} `))!.median;
    expect(median("RD.1000.restore") / median("RD.100.restore")).toBeCloseTo(1.438, 3);
  });
});
