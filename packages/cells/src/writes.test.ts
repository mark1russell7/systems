import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { VALKEY_IMAGE } from "./t12.ts";
import { BOUNDED_MEMBERS, LOST_OF_FREEZE, WRITES_CELLS, cycleOf, lostOfCut, refusalOf } from "./writes.ts";

const nameOf = (plan: string) => {
  const found = WRITES_CELLS.find((each) => each.name.startsWith(`${plan} `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

describe("the law of the lost writes of a Valkey failover", () => {
  it("gives the first refusal after a cut, from the whole seconds of the lag and the two crons", () => {
    expect(refusalOf(10)).toEqual({ lo: 8.8, hi: 12.1 });
    expect(refusalOf(5)).toEqual({ lo: 3.8, hi: 7.1 });
  });

  it("gives a cycle of 50 ms to 62 ms, and from them 140 to 244 lost writes", () => {
    expect(cycleOf()).toEqual({ lo: 0.05, hi: 0.062 });
    expect(lostOfCut(10)).toEqual({ low: 140, high: 244 });
  });

  it("gives a count that depends on the lag, not on the hold", () => {
    expect(nameOf("T12.writes.1").prediction.group?.lost).toEqual(nameOf("T12.writes.2").prediction.group?.lost);
    expect(lostOfCut(5)).toEqual({ low: 60, high: 144 });
  });
});

describe("the cells of SYS-58", () => {
  it("are in the joined catalog, each with the group of T12 and the setting", () => {
    for (const cell of WRITES_CELLS) {
      expect(ALL.some((each) => each.name === cell.name), cell.name).toBe(true);
      expect(cell.name).toMatch(/^T12\.writes\.\d+ .*min-replicas-to-write 1$/);
      expect(cell.group?.image).toBe(VALKEY_IMAGE);
      expect(cell.group?.memberSettings).toBe(BOUNDED_MEMBERS);
      expect(cell.group?.memberSettings["min-replicas-to-write"]).toBe("1");
      expect(cell.runs).toBe(4);
      expect(cell.concurrency).toBe(1);
    }
  });

  it("judges a partition by the band of lost writes, with no band of time", () => {
    for (const plan of ["T12.writes.1", "T12.writes.2"]) {
      const { prediction } = nameOf(plan);
      expect(prediction.detects).toBeNull();
      expect(prediction.group).toMatchObject({
        lands: "new",
        failover: true,
        lost: { low: 140, high: 244 },
        errors: [{ name: "ReplyError", low: { value: 8.8, unit: "s" }, high: { value: 12.162, unit: "s" } }],
      });
    }
  });

  it("judges a freeze by the band of the conversion, and by the band of lost writes", () => {
    const { prediction } = nameOf("T12.writes.3");
    expect(prediction).toMatchObject({ detects: true, low: { value: 50.05 }, high: { value: 50.403 } });
    expect(prediction.group).toMatchObject({
      lands: "new",
      lost: LOST_OF_FREEZE,
      errors: [{ name: "ReplyError", low: { value: 40, unit: "s" }, high: { value: 40.062, unit: "s" } }],
    });
  });

  it("leaves the settings of the T12 catalog at their defaults", () => {
    const t12 = ALL.filter((each) => /^T12\.(defaults|border-off)\./.test(each.name));
    expect(t12.length).toBeGreaterThan(0);
    for (const cell of t12) expect(cell.group?.memberSettings["min-replicas-to-write"]).toBe("0");
  });
});
