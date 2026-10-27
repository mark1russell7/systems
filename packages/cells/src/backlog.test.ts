import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { BACKLOG_CELLS, BACKLOG_CONNECTIONS, BACKLOG_SESSIONS, BACKLOG_WORKLOAD, backlogCellOf, backlogOf } from "./backlog.ts";
import { CALLERS_CELLS } from "./callers.ts";
import { T07_WORKLOAD, WORKERS } from "./kind.ts";

const sec = (quantity: { value: number; unit: string }): number => valueIn(quantity, "s");

/** SYS-40: the backlog of a stalled target after its resume, from the sessions on the target. */
describe("the cells of the backlog", () => {
  it("give one cell of C in the stall for each count of the sessions on the target", () => {
    expect(BACKLOG_CELLS.map((cell) => cell.id)).toEqual(["S2.T07.cilium.goaway.backlog.n1", "S2.T07.cilium.goaway.backlog.n2", "S2.T07.cilium.goaway.backlog.n3", "S2.T07.cilium.goaway.backlog.n6"]);
    expect(BACKLOG_CELLS.map((cell) => cell.workload.onTarget)).toEqual([...BACKLOG_SESSIONS]);
    expect(BACKLOG_CELLS[0]!.name).toBe("T07 cilium, callers learn that a pod is stalled, with 1 session on the target: in band on HTTP/2 (GOAWAY)");
    expect(BACKLOG_CELLS[3]!.name).toBe("T07 cilium, callers learn that a pod is stalled, with 6 sessions on the target: in band on HTTP/2 (GOAWAY)");
    // the ids and the names are new: no cell of the stall has them, thus the old records keep their cells
    const old = new Set(CALLERS_CELLS.flatMap((cell) => [cell.id, cell.name]));
    for (const cell of BACKLOG_CELLS) {
      expect(old.has(cell.id)).toBe(false);
      expect(old.has(cell.name)).toBe(false);
    }
    // a filter on the words of the names selects these cells and no other
    expect(CALLERS_CELLS.some((cell) => /sessions? on the target/.test(cell.name))).toBe(false);
  });

  it("are the stall cell of C with the sessions placed", () => {
    const c = CALLERS_CELLS.find((cell) => cell.mode === "cilium" && cell.trigger.kind === "app-stall" && cell.declaration.protocol === "h2c" && cell.name.endsWith("(GOAWAY)"));
    expect(c).toBeDefined();
    for (const cell of BACKLOG_CELLS) {
      expect(cell.trigger).toEqual(c!.trigger);
      expect(cell.declaration).toEqual(c!.declaration);
      expect(cell.pod).toEqual(c!.pod);
      expect(cell.workers).toBe(c!.workers);
      expect(cell.prediction.kind).toBe("window");
    }
    // two sessions for each client and a request each 10 ms: 20 ms between two requests on one session, as in C
    expect(sec(BACKLOG_WORKLOAD.every) * BACKLOG_CONNECTIONS).toBeCloseTo(sec(T07_WORKLOAD.every), 9);
    expect(BACKLOG_WORKLOAD.timeout).toEqual(T07_WORKLOAD.timeout);
    expect((WORKERS + 1) * BACKLOG_CONNECTIONS).toBe(6);
  });

  it("add n × d to the band end and n × r to the failed requests", () => {
    const at = (n: number) => backlogOf("cilium", n);
    expect(sec(at(1).bandEnd)).toBe(10);
    expect([sec(at(1).overshoot.lo), sec(at(1).overshoot.hi)]).toEqual([0.04, 0.07]);
    expect([sec(at(6).overshoot.lo), sec(at(6).overshoot.hi)]).toEqual([0.24, 0.42]);
    expect([sec(at(1).end.lo), sec(at(1).end.hi)]).toEqual([9.98, 10.07]);
    expect(sec(at(6).end.hi)).toBe(10.42);
    expect([sec(at(1).start.lo), sec(at(1).start.hi)]).toEqual([0, 0.02]);
    // 499 to 500 requests of one session in the band, one more at its edge, and r = 0–3 in the drain
    expect([at(1).expected.lo.value, at(1).expected.hi.value]).toEqual([499, 504]);
    expect([at(6).expected.lo.value, at(6).expected.hi.value]).toEqual([2994, 3024]);
    expect(at(3).expected.connections).toEqual({ lo: { value: 3, unit: "{connection}" }, hi: { value: 3, unit: "{connection}" }, of: { value: 6, unit: "{connection}" } });
    // the cell takes its window from the prediction
    const cell = backlogCellOf("cilium", 2);
    expect(cell.prediction.kind === "window" && cell.prediction.end.band).toEqual(at(2).end);
  });

  it("refuse a count that the sessions of the clients cannot hold", () => {
    expect(() => backlogOf("cilium", 0)).toThrow(RangeError);
    expect(() => backlogOf("cilium", 7)).toThrow(RangeError);
    expect(() => backlogOf("cilium", 1.5)).toThrow(RangeError);
  });
});
