import { describe, expect, it } from "vitest";
import { ALL } from "../all.ts";
import { PG_IMAGE } from "./t01.ts";
import { COMMIT_CELLS, WRITERS, lostOfRate } from "./commit.ts";

const cellOf = (plan: string) => {
  const found = COMMIT_CELLS.find((each) => each.name.startsWith(`${plan} `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

describe("the law of a COMMIT with no reply", () => {
  it("gives the lost writes of a cut standby from the rate of the client", () => {
    expect(lostOfRate()).toEqual({ low: 567, high: 804 });
    expect(lostOfRate(2, 5)).toEqual({ low: 140, high: 202 });
  });

  it("gives a band of lost writes that a synchronous standby closes, if no cancel ends the wait", () => {
    expect(cellOf("T10.commit.1").prediction.group?.lost).toEqual({ low: 0, high: WRITERS });
    expect(cellOf("T10.commit.2").prediction.group?.lost).toEqual({ low: 0, high: 0 });
    expect(cellOf("T10.commit.4").prediction.group?.lost).toEqual({ low: 0, high: 0 });
    expect(cellOf("T10.commit.5").prediction.group?.lost).toEqual({ low: WRITERS, high: 2 * WRITERS });
  });

  it("gives one write with no reply for each writer, and a kept set only if the standby can have it", () => {
    for (const cell of COMMIT_CELLS) expect(cell.prediction.group?.outcomes?.unknown, cell.name).toEqual({ low: WRITERS, high: WRITERS });
    expect(cellOf("T10.commit.3").prediction.group?.outcomes?.kept).toEqual({ low: 0, high: 0 });
    expect(cellOf("T10.commit.4").prediction.group?.outcomes?.absent).toEqual({ low: 0, high: 0 });
    expect(cellOf("T10.commit.5").prediction.group?.outcomes?.warnings).toEqual({ low: 2 * WRITERS, high: 2 * WRITERS });
  });
});

describe("the cells of SYS-61", () => {
  it("are in the joined catalog, each with PostgreSQL 17.11 behind PgBouncer and a pair", () => {
    for (const cell of COMMIT_CELLS) {
      expect(ALL.some((each) => each.name === cell.name), cell.name).toBe(true);
      expect(cell.name).toMatch(/^T10\.commit\.\d+ pg-8\.23 to postgresql, /);
      expect(cell.target.image).toBe(PG_IMAGE);
      expect(PG_IMAGE).toMatch(/^postgres:17\.11@/);
      expect(cell.topology?.hops).toHaveLength(1);
      expect(cell.pair).toBeDefined();
      expect(cell.runs).toBe(4);
      expect(cell.environments).toBe(4);
      expect(cell.fresh).toBe(true);
      expect(cell.concurrency).toBe(1);
    }
  });

  it("holds the fault for less than the timeout of the WAL sender", () => {
    for (const cell of COMMIT_CELLS) expect(cell.hold).toEqual({ value: 10, unit: "s" });
  });

  it("judges each cell by its bands of counts, with no band of time", () => {
    for (const cell of COMMIT_CELLS) {
      expect(cell.prediction.detects).toBeNull();
      expect(cell.prediction).toMatchObject({ from: "fault" });
      expect(cell.prediction.group?.stages).toEqual([]);
      expect(cell.prediction.group?.outcomes?.missing).toEqual({ low: 0, high: 0 });
    }
  });
});
