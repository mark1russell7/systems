import { conntrackFloor } from "@mark1russell7/algebra";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { HZ } from "./catalog.ts";
import { CONNTRACK_CELLS, giveUpBand, schedulePoints } from "./conntrack.ts";

const lawOf = (plan: string) => {
  const cell = CONNTRACK_CELLS.find((each) => each.name.startsWith(plan));
  if (cell === undefined || cell.prediction.detects !== null || cell.prediction.conntrack === undefined)
    throw new Error(`${plan} has no law`);
  return cell.prediction.conntrack;
};

describe("the cells of the conntrack table", () => {
  it("joins the catalog, four counted runs and one cell at a time", () => {
    expect(CONNTRACK_CELLS).toHaveLength(5);
    for (const cell of CONNTRACK_CELLS) {
      expect(ALL.some((each) => each.name === cell.name)).toBe(true);
      expect(cell.runs).toBe(4);
      expect(cell.concurrency).toBe(1);
    }
  });

  it("sets the limit of the host for each cell, under a guard of half of it, and starts conntrack in the namespaces", () => {
    for (const cell of CONNTRACK_CELLS) {
      const max = cell.prediction.detects === null ? cell.prediction.conntrack?.max : undefined;
      expect(cell.hostSysctls).toEqual([
        { name: "net.netfilter.nf_conntrack_max", value: String(max), guard: { name: "net.netfilter.nf_conntrack_count", atMost: Math.floor(max! / 2) } },
      ]);
      expect(cell.namespaceSetup?.[0]).toContain("conntrack");
    }
  });

  it("gives a connect that finds no entry the end of the time test: 6 SYNs in 7 s, not the 7 SYNs in 11 s of the count", () => {
    const within = giveUpBand();
    expect(valueIn(within.low, "s")).toBeCloseTo(7, 6);
    // six waits of 1 s and 2 s, each up to 8 jiffies late at HZ 250 and 64 at HZ 1000, and the slack of the
    // client. At HZ 1000, cells run 42397236518 read 7.157 to 7.201 s
    expect(valueIn(within.high, "s")).toBeCloseTo(7 + (6 * (HZ === 1000 ? 64 : 8)) / HZ + 0.05, 6);
    expect(lawOf("CT.1").refused).toMatchObject({ errno: "ETIMEDOUT", drops: 6, retransFail: 5 });
    expect(lawOf("CT.2").refused).toEqual(lawOf("CT.1").refused);
  });

  it("gives each SYN after the first its point, and the points do not overlap below 19 s", () => {
    const points = schedulePoints();
    const whole = points.map((point) => Math.round(valueIn(point.low, "s")));
    expect(whole).toEqual([1, 2, 3, 4, 5, 7, 11, 19, 35, 67]);
    for (const [at, point] of points.entries()) {
      const next = points[at + 1];
      if (next !== undefined) expect(valueIn(point.high, "s")).toBeLessThan(valueIn(next.low, "s"));
    }
  });

  it("reads the neighbor only in the cell that has one", () => {
    expect(lawOf("CT.2").neighbor).toBe(1024);
    expect(lawOf("CT.1").neighbor).toBeUndefined();
  });

  it("reads the slots of a reset from 10 s, less one tick, up to one gap of the scans", () => {
    const { drained } = lawOf("CT.3");
    expect(valueIn(drained!.low, "s")).toBeCloseTo(10 - 1 / HZ, 6);
    expect(valueIn(drained!.high, "s")).toBe(61);
  });

  it("takes the floor of a scan under pressure from the algebra, at the value of HZ of the run", () => {
    expect(lawOf("CT.4").pressure).toMatchObject({ lowest: conntrackFloor(1024, HZ), after: conntrackFloor(1024, HZ) + 1 });
    expect(lawOf("CT.5").pressure).toMatchObject({ lowest: conntrackFloor(1000, HZ), after: conntrackFloor(1000, HZ) + 1 });
    expect(lawOf("CT.5").pressure?.lowest).toBe(949);
  });

  it("gives the floor at the cap a band for the expired entries of other namespaces, and keeps the floor of 95 hundredths exact", () => {
    // at HZ 1000 the band is 959 to 973: cells run 42397236518 read 964, 961, 963 and 962 at CT.4, and 949 in each run of CT.5
    expect(lawOf("CT.4").pressure).toMatchObject({ lowest: conntrackFloor(1024, HZ), highest: conntrackFloor(1024, HZ, 14) });
    expect(lawOf("CT.5").pressure).toMatchObject({ lowest: 949, highest: 949 });
    expect([conntrackFloor(1024, 1000), conntrackFloor(1024, 1000, 14)]).toEqual([959, 973]);
  });
});
