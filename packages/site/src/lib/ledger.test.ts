import { describe, expect, it } from "vitest";
import { LEDGER, TOTAL, entryOf } from "./ledger.ts";

const tally = (key: string) => {
  const { holds, fails, measured, calibration } = entryOf(key).tally;
  return [entryOf(key).cells, holds, fails, measured, calibration];
};

describe("the ledger of the results", () => {
  it("counts the cells of each page as the text of the page gives them", () => {
    expect(tally("calibration")).toEqual([6, 6, 0, 0, 0]);
    expect(tally("cells")).toEqual([12, 12, 0, 0, 0]);
    // faults: "Of the 45 cells, 39 hold ... The other 6 cells are measurements only"
    expect(tally("faults")).toEqual([45, 39, 0, 6, 0]);
    // topologies: "Of 42 cells, 29 hold, 8 are measurements only, and 5 fail", and three held on a re-run
    expect(tally("topologies")).toEqual([42, 29, 5, 8, 0]);
    expect(entryOf("topologies").heldOnRerun).toBe(3);
    expect(tally("sentinel")).toEqual([13, 9, 0, 4, 0]);
    expect(tally("http")).toEqual([39, 34, 4, 1, 0]);
    expect(tally("mongodb")).toEqual([58, 51, 7, 0, 0]);
    expect(tally("kind")).toEqual([31, 22, 4, 2, 3]);
  });

  it("counts the runs of each page as the text of the page gives them", () => {
    // mongodb: "The cells have 617 counted runs and 21 void runs"
    expect([entryOf("mongodb").counted, entryOf("mongodb").voided]).toEqual([617, 21]);
    // http: "Of the 429 runs, 7 are void"
    expect([entryOf("http").counted + entryOf("http").voided, entryOf("http").voided]).toEqual([429, 7]);
    // kind: "No run of the 341 is void"
    expect([entryOf("kind").counted, entryOf("kind").voided]).toEqual([341, 0]);
  });

  it("gives the kernel, the clock and the catalogs of each page", () => {
    expect(LEDGER.map((entry) => `${entry.kernel} ${entry.hz}`)).toEqual(["6.6 250", "6.6 250", "6.6 250", "6.6 250", "6.17 1000", "6.17 1000", "6.17 1000", "6.17 1000"]);
    expect(entryOf("topologies").tags).toEqual(["T01", "T03", "T02", "TOX"]);
    expect(entryOf("sentinel").tags).toEqual(["T12"]);
    expect(entryOf("kind").tags).toEqual(["T07", "T18"]);
  });

  it("adds the pages into one total", () => {
    expect([TOTAL.pages, TOTAL.cells]).toEqual([8, 246]);
    expect(TOTAL.tally).toEqual({ holds: 202, fails: 20, measured: 21, calibration: 3 });
    expect(TOTAL.tally.holds + TOTAL.tally.fails + TOTAL.tally.measured + TOTAL.tally.calibration).toBe(TOTAL.cells);
    expect([TOTAL.first, TOTAL.last]).toEqual(["2026-10-13", "2026-10-17"]);
  });
});
