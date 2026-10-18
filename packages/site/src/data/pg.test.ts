import { describe, expect, it } from "vitest";
import pg from "./pg-2026-10-18.json";

type Cell = (typeof pg.cells)[number];

const cell = (plan: string): Cell => {
  const found = pg.cells.find((each) => each.plan === plan);
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};
/** This function gives the times of the counted runs of a cell outside its band. */
const outside = (each: Cell): number[] =>
  each.runs.flat().flatMap((t) => (t === null || each.band === null || (t >= each.band.low && t <= each.band.high) ? [] : [t])).sort((a, b) => a - b);

describe("the copy of the PostgreSQL cells holds the figures of their CI run", () => {
  it("has 13 cells on Linux 6.17 at HZ 1000, each holds, with 143 counted runs and no void run", () => {
    expect([pg.kernel, pg.hz, pg.target, pg.client]).toEqual(["6.17.0", 1000, "postgres:17.11", "pg 8.23.1 with pg-pool 3.14.0 on Node 24.21.0"]);
    expect(pg.cells).toHaveLength(13);
    expect(pg.cells.every((each) => each.decision === "holds")).toBe(true);
    expect(pg.cells.reduce((sum, each) => sum + each.counted, 0)).toBe(143);
    expect(pg.cells.reduce((sum, each) => sum + each.voided, 0)).toBe(0);
    const count = (stage: string) => pg.cells.filter((each) => each.group === "T01" && each.stage === stage).length;
    expect([count("defaults"), count("border")]).toEqual([9, 4]);
  });

  it("gives the idle timer of the pool at 10 s, with and without a fault, each run in its band", () => {
    for (const plan of ["T01.defaults.122", "T01.defaults.128"]) {
      const each = cell(plan);
      expect(each.median, plan).toBeGreaterThan(10);
      expect(each.median, plan).toBeLessThan(10.01);
      expect(outside(each), plan).toEqual([]);
      expect(each.prediction.text, plan).toMatch(/the pool closes its idle client at its idle timer, and the kernel stamps its FIN\. The band is 10 s to 10\.01 s after the last segment on the socket\.$/);
    }
  });

  it("places the borders of O13 and O15 on each side of the slowest poll and of the startup budget", () => {
    const [in13, out13, in15, out15] = ["T01.border-off.179", "T01.border-off.180", "T01.border-off.191", "T01.border-off.192"].map(cell);
    expect(in13!.median).toBeLessThan(10);
    expect(out13!.median).toBeGreaterThan(10);
    expect(in15!.median).toBeLessThan(30);
    expect(out15!.median).toBeGreaterThan(30);
    expect(in15!.prediction.text).toMatch(/after the start of the first connect\.$/);
  });
});
