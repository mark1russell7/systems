import { describe, expect, it } from "vitest";
import { BORDER_CELLS, SERVICE, latencyOf, rankOf, stable } from "./stability.ts";

describe("the border of a stable system (SYS-69)", () => {
  it("puts one cell on each side of the border of Theorem 2", () => {
    const capacity = 1 / SERVICE;
    expect(capacity).toBe(100);
    expect(stable({ load: 80, capacity, wL: 1, wC: 1 })).toBe(true);
    expect(stable({ load: 120, capacity, wL: 1, wC: 1 })).toBe(false);
    expect(stable({ load: 100, capacity, wL: 1, wC: 1 })).toBe(false);
    // a retry of each arrival doubles the work: the same load of 80 is over the border
    expect(stable({ load: 80, capacity, wL: 2, wC: 1 })).toBe(false);
  });

  it("gives the service time as each latency under the border", () => {
    for (const rank of [0, 1, 800, 1599]) expect(latencyOf(rank, 80, SERVICE)).toBeCloseTo(0.01, 12);
  });

  it("gives a latency that grows with the rank over the border", () => {
    // each arrival waits 10 ms - 1/120 s longer than the arrival before it: 1/600 s
    expect(latencyOf(0, 120, SERVICE)).toBeCloseTo(0.01, 12);
    expect(latencyOf(600, 120, SERVICE)).toBeCloseTo(1.01, 9);
    expect(latencyOf(2399, 120, SERVICE)).toBeCloseTo(0.01 + 2399 / 600, 9);
  });

  it("gives the rank of a quantile", () => {
    expect(rankOf(0.99, 2400)).toBe(2375);
    expect(rankOf(0.5, 2400)).toBe(1199);
    expect(rankOf(1, 2400)).toBe(2399);
  });

  it("gives each cell its request, its rate and its bands", () => {
    const [under, over] = BORDER_CELLS;
    expect(BORDER_CELLS.map((cell) => cell.name.slice(0, cell.name.indexOf(",")))).toEqual(["SB.under", "SB.over"]);
    expect(under?.probe.request).toBe("DEBUG SLEEP 0.01");
    expect(under?.target.command).toEqual(["redis-server", "--enable-debug-command", "yes"]);
    const bands = (cell: (typeof BORDER_CELLS)[number] | undefined) => {
      const prediction = cell?.prediction;
      return prediction !== undefined && "load" in prediction ? prediction.load?.bands : undefined;
    };
    expect(bands(under)).toEqual([
      { quantile: 0.5, low: { value: 0.01, unit: "s" }, high: { value: 0.0206, unit: "s" } },
      { quantile: 0.99, low: { value: 0.01, unit: "s" }, high: { value: 0.0206, unit: "s" } },
    ]);
    const p99 = bands(over)?.[1];
    expect(p99?.low?.value).toBeCloseTo(0.01 + 2375 / 600, 6);
    expect(p99?.high.value).toBeGreaterThan(5);
    expect(p99?.high.value).toBeLessThan(5.5);
  });
});
