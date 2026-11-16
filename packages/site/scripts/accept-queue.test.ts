/**
 * The copy of the accept queue cells agrees with the catalog. Each cell of the catalog has its place in the
 * copy, in the sequence of the catalog. Each band of a term is the band of the prediction at the HZ of the
 * runner. Each median is the median of the values of its trials, and each median of a cell that holds is
 * inside its band.
 */
import { describe, expect, it } from "vitest";
import type { QueueCopy, QueueTerm } from "../src/components/QueueResults.tsx";
import data from "../src/data/accept-queue-2026-11-06.json";
import { middle, secondsOf } from "./records.ts";

const copy = data as unknown as QueueCopy;

// the catalog reads the HZ of the kernel when it loads, thus it loads at the HZ of the copy
const before = process.env["CELLS_HZ"];
process.env["CELLS_HZ"] = String(copy.hz);
const { ACCEPT_QUEUE_CELLS, SERVICE_QUEUE_CELLS } = await import("../../cells/src/accept-queue.ts");
if (before === undefined) delete process.env["CELLS_HZ"];
else process.env["CELLS_HZ"] = before;
const CATALOG = [...ACCEPT_QUEUE_CELLS, ...SERVICE_QUEUE_CELLS];

type Band = readonly [unit: QueueTerm["unit"], low: number, high: number];

/** This function gives the bands of the law of one cell of the catalog, in the sequence of the exporter. */
const bandsOf = (name: string): Band[] => {
  const cell = CATALOG.find((each) => each.name === name);
  if (cell === undefined || cell.prediction.detects !== null || cell.prediction.queue === undefined) throw new Error(`no queue law for ${name}`);
  const queue = cell.prediction.queue;
  const time = (band: { readonly low: { readonly value: number; readonly unit: string }; readonly high: { readonly value: number; readonly unit: string } }): Band => [
    "s",
    secondsOf(band.low)!,
    secondsOf(band.high)!,
  ];
  return [
    ["count", queue.max, queue.max],
    ["count", queue.held, queue.held],
    ["count", queue.connected, queue.connected],
    ["count", queue.overflows.low, queue.overflows.high],
    ["count", queue.resets, queue.resets],
    ...(queue.drained === undefined ? [] : [["count", queue.drained, queue.drained] as const]),
    ...(queue.expiry === undefined ? [] : [time(queue.expiry.within)]),
    ...(queue.rise === undefined ? [] : [time(queue.rise.within)]),
    ...queue.connections.flatMap((connection) => (connection.ends === null ? [] : [time(connection.ends.within)])),
  ];
};

const judged = copy.cells.flatMap((cell) => (cell.result === null ? [] : [{ cell, result: cell.result }]));

describe("the copy of the accept queue cells agrees with the catalog", () => {
  it("has the ten cells of the catalog in their sequence, from one run on Linux 7.0.0 at HZ 1000", () => {
    expect(copy.cells.map((cell) => `${cell.id} ${cell.name}`)).toEqual(CATALOG.map((cell) => cell.name));
    expect([copy.kernel, copy.hz, copy.workflows]).toEqual(["7.0.0", 1000, [42146602190]]);
    expect(copy.commit?.slice(0, 7)).toBe("6866a97");
  });

  it("holds AQ.1 to AQ.7 with four counted trials each, and AQ.8 to AQ.10 have no record yet", () => {
    expect(judged.map(({ cell, result }) => [cell.id, result.decision, result.counted, result.voided])).toEqual(
      ["AQ.1", "AQ.2", "AQ.3", "AQ.4", "AQ.5", "AQ.6", "AQ.7"].map((id) => [id, "holds", 4, 0]),
    );
    expect(copy.cells.filter((cell) => cell.result === null).map((cell) => cell.id)).toEqual(["AQ.8", "AQ.9", "AQ.10"]);
  });

  it("gives each band of a term from the prediction of the catalog at the HZ of the runner", () => {
    for (const { cell, result } of judged)
      expect(
        result.terms.map((term) => [term.unit, term.low, term.high]),
        cell.id,
      ).toEqual(bandsOf(`${cell.id} ${cell.name}`));
  });

  it("gives each median as the median of the values of its trials, and each median of a held cell is inside its band", () => {
    for (const { cell, result } of judged)
      for (const term of result.terms) {
        const values = term.values.filter((value): value is number => value !== null);
        expect(term.values, `${cell.id} ${term.term}`).toHaveLength(result.counted);
        expect(term.median, `${cell.id} ${term.term}`).toBe(middle(values));
        expect(term.inside, `${cell.id} ${term.term}`).toBe(result.decision === "holds" ? true : term.inside);
        if (term.median !== null) expect(term.inside).toBe(term.median >= term.low && term.median <= term.high);
      }
  });

  it("measures the law of the count: a full queue holds the limit plus one", () => {
    for (const { cell, result } of judged) {
      const [limit, most] = result.terms;
      expect([limit?.term, most?.term]).toEqual(["the limit of the queue", "the most in the queue"]);
      expect(most?.median, cell.id).toBe((limit?.median ?? Number.NaN) + 1);
    }
  });
});
