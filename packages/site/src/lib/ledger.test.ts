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
    // faults: "Of the 47 cells, 39 hold ... The other 8 cells are measurements only"
    expect(tally("faults")).toEqual([47, 39, 0, 8, 0]);
    // topologies: "Of the 46 cells, 39 hold against the prediction of the algebra, and 7 are measurements only"
    expect(tally("topologies")).toEqual([46, 39, 0, 7, 0]);
    expect(entryOf("topologies").heldOnRerun).toBe(0);
    expect(tally("sentinel")).toEqual([13, 9, 0, 4, 0]);
    // http: "Of the 39 cells, 38 hold against the prediction of the algebra, and 1 is a measurement only"
    expect(tally("http")).toEqual([39, 38, 0, 1, 0]);
    // mongodb: "Each of the 58 cells holds against the prediction of the algebra"
    expect(tally("mongodb")).toEqual([58, 58, 0, 0, 0]);
    // pg: "Each of the 75 cells holds against the prediction of the algebra"
    expect(tally("pg")).toEqual([75, 75, 0, 0, 0]);
    // rabbitmq: "Each of the 21 cells holds against the prediction of the algebra"
    expect(tally("rabbitmq")).toEqual([21, 21, 0, 0, 0]);
    // grpc: "Each of the 48 cells holds or is a measurement. 47 cells hold, and the race of two deadlines is a measurement"
    expect(tally("grpc")).toEqual([48, 47, 0, 1, 0]);
    expect(tally("kind")).toEqual([31, 26, 0, 2, 3]);
    // r3: "Of the 115 cells of the queue, 114 hold and 1 is a measurement only", the 9 that failed first
    // held on a re-run, and 6 canonical cells: 1 holds and 5 measure
    expect(tally("r3")).toEqual([121, 115, 0, 6, 0]);
    expect(entryOf("r3").heldOnRerun).toBe(9);
  });

  it("counts the runs of each page as the text of the page gives them", () => {
    // mongodb: "The cells have 638 counted runs, and no run is void"
    expect([entryOf("mongodb").counted, entryOf("mongodb").voided]).toEqual([638, 0]);
    // pg: "The cells have 825 counted runs, and no run is void"
    expect([entryOf("pg").counted, entryOf("pg").voided]).toEqual([825, 0]);
    // rabbitmq: "The cells have 231 counted runs, and no run is void"
    expect([entryOf("rabbitmq").counted, entryOf("rabbitmq").voided]).toEqual([231, 0]);
    // grpc: "The cells counted 539 runs, and no run was void"
    expect([entryOf("grpc").counted, entryOf("grpc").voided]).toEqual([539, 0]);
    // http: "No run of the 429 is void"
    expect([entryOf("http").counted + entryOf("http").voided, entryOf("http").voided]).toEqual([429, 0]);
    // faults: "No run of the 517 is void", and topologies: "no run of the 506 is void"
    expect([entryOf("faults").counted, entryOf("faults").voided]).toEqual([517, 0]);
    expect([entryOf("topologies").counted, entryOf("topologies").voided]).toEqual([506, 0]);
    // kind: "No run of the 341 is void"
    expect([entryOf("kind").counted, entryOf("kind").voided]).toEqual([341, 0]);
  });

  it("gives the kernel, the clock and the catalogs of each page", () => {
    // the gRPC page: its T03 run met the rollout of Linux 7.0 on the runners
    expect(LEDGER.map((entry) => `${entry.kernel} ${entry.hz}`)).toEqual(["6.6 250", "6.6 250", "6.17 1000", "6.17 1000", "6.17 1000", "6.17 1000", "6.17 1000", "6.17 1000", "6.17 1000", "6.17 and 7.0 1000", "6.17 1000", "6.17 1000"]);
    expect(entryOf("pg").tags).toEqual(["T01", "T03", "T10"]);
    expect(entryOf("rabbitmq").tags).toEqual(["T01", "T11"]);
    expect(entryOf("grpc").tags).toEqual(["T01", "T03", "T02"]);
    expect(entryOf("r3").tags).toEqual(["T01", "T03"]);
    expect(entryOf("topologies").tags).toEqual(["T03", "T02", "TOX"]);
    expect(entryOf("sentinel").tags).toEqual(["T12"]);
    expect(entryOf("kind").tags).toEqual(["T07", "T18"]);
  });

  it("adds the pages into one total", () => {
    expect([TOTAL.pages, TOTAL.cells]).toEqual([12, 517]);
    expect(TOTAL.tally).toEqual({ holds: 485, fails: 0, measured: 29, calibration: 3 });
    expect(TOTAL.tally.holds + TOTAL.tally.fails + TOTAL.tally.measured + TOTAL.tally.calibration).toBe(TOTAL.cells);
    expect([TOTAL.first, TOTAL.last]).toEqual(["2026-10-13", "2026-10-20"]);
  });
});
