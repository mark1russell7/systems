import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { HZ } from "./catalog.ts";
import { PORT_RANGE_CELLS, PORT_RANGE_SPECS, searchShares } from "./port-range.ts";

const lawOf = (plan: string) => {
  const cell = PORT_RANGE_CELLS.find((each) => each.name.startsWith(plan));
  if (cell === undefined || cell.prediction.detects !== null || cell.prediction.ports === undefined)
    throw new Error(`${plan} has no law`);
  return cell.prediction.ports;
};

describe("the exact law of the search for a port", () => {
  it("gives an even range its size in each round", () => {
    for (const size of [2, 4, 6, 16]) expect([...searchShares(size)]).toEqual([[size, 1]]);
  });

  it("gives a range of 3 two connects in each round", () => {
    expect([...searchShares(3)]).toEqual([[2, 1]]);
  });

  it("gives an odd range one port less in some rounds, with the chance of the chain", () => {
    // a seeded simulation of the kernel code gave 35447 rounds of 4 in 200000 rounds of a range of 5
    expect(searchShares(5).get(4)).toBeCloseTo(45 / 256, 9);
    expect(searchShares(5).get(5)).toBeCloseTo(211 / 256, 9);
    expect(searchShares(7).get(6)).toBeCloseTo(0.0612, 3);
    expect(searchShares(9).get(8)).toBeCloseTo(0.0968, 3);
  });
});

describe("the cells of the port range", () => {
  it("joins the catalog, four counted runs and one cell at a time", () => {
    expect(PORT_RANGE_CELLS).toHaveLength(7);
    for (const cell of PORT_RANGE_CELLS) {
      expect(ALL.some((each) => each.name === cell.name)).toBe(true);
      expect(cell.name).toMatch(/^PR[.]\d /);
      expect(cell.runs).toBe(4);
      expect(cell.concurrency).toBe(1);
      expect(cell.fault).toBe("none");
      expect(cell.sysctls).toHaveProperty("net.ipv4.ip_local_port_range");
    }
  });

  it("sets a range of the size of its law", () => {
    for (const [at, spec] of PORT_RANGE_SPECS.entries())
      expect(PORT_RANGE_CELLS[at]?.sysctls["net.ipv4.ip_local_port_range"]).toBe(`40000 ${40000 + spec.size - 1}`);
  });

  it("gives the count of an even range and the count of a range of 3", () => {
    expect(lawOf("PR.1").counts).toEqual([16]);
    expect(lawOf("PR.2").counts).toEqual([2]);
    expect(lawOf("PR.2").seen).toEqual([0, 1]);
  });

  it("puts the share of a range of 5 inside a band that neither naive count reaches", () => {
    const { share, counts } = lawOf("PR.3");
    expect(counts).toEqual([4, 5]);
    expect(share?.count).toBe(5);
    expect(share?.low).toBeGreaterThan(0.7);
    expect(share?.high).toBeLessThan(0.95);
  });

  it("gives the count for each destination", () => {
    expect(lawOf("PR.4")).toMatchObject({ destinations: 2, counts: [16] });
  });

  it("holds a port for 60 s, or for 1 s with reuse, from the FIN of the target", () => {
    const held = lawOf("PR.5").freed;
    const reused = lawOf("PR.6").freed;
    if (held === undefined || reused === undefined) throw new Error("no band");
    expect(valueIn(held.low, "s")).toBeCloseTo(60 - 1 / HZ, 6);
    expect(valueIn(held.high, "s")).toBeGreaterThan(60);
    expect(valueIn(held.high, "s")).toBeLessThan(70);
    expect(valueIn(reused.low, "s")).toBeCloseTo(1 - 1 / HZ, 6);
    expect(valueIn(reused.high, "s")).toBeCloseTo(1.061, 6);
  });

  it("holds no port and sends no SYN again if the target closes first", () => {
    expect(lawOf("PR.7")).toMatchObject({ counts: [4], retransmissions: 0 });
  });
});
