import { readFileSync } from "node:fs";
import { requestBand } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import {
  BACKLOG_BAND_CELLS,
  BACKLOG_CELLS,
  BACKLOG_CONNECTIONS,
  BACKLOG_DRAIN,
  BACKLOG_DRAIN_CELLS,
  BACKLOG_DRAIN_TERM,
  BACKLOG_REQUESTS,
  BACKLOG_SESSIONS,
  BACKLOG_TERM,
  BACKLOG_TERMS_CELLS,
  BACKLOG_TERMS_RUNS,
  BACKLOG_TERMS_SESSIONS,
  BACKLOG_TERMS_TERM,
  BACKLOG_WORKLOAD,
  backlogBandOf,
  backlogCellOf,
  backlogOf,
} from "./backlog.ts";
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

/** SYS-42: the cells of SYS-40 with the backlog band, d = 10–45 ms and the count from the measured period. */
describe("the cells of the backlog band", () => {
  it("are the cells of SYS-40 with new ids and names, thus the records of SYS-40 keep the first band", () => {
    expect(BACKLOG_BAND_CELLS.map((cell) => cell.id)).toEqual(BACKLOG_SESSIONS.map((n) => `S2.T07.cilium.goaway.backlog-band.n${n}`));
    expect(BACKLOG_BAND_CELLS[0]!.name).toBe("T07 cilium, callers learn that a pod is stalled, with 1 session on the target, by the backlog band: in band on HTTP/2 (GOAWAY)");
    const old = new Set([...CALLERS_CELLS, ...BACKLOG_CELLS].flatMap((cell) => [cell.id, cell.name]));
    BACKLOG_BAND_CELLS.forEach((cell, at) => {
      expect(old.has(cell.id)).toBe(false);
      expect(old.has(cell.name)).toBe(false);
      const first = BACKLOG_CELLS[at]!;
      expect({ ...cell, id: first.id, name: first.name, prediction: first.prediction }).toEqual(first);
    });
    // a filter on the words of the names selects these cells and no other
    const all = [...CALLERS_CELLS, ...BACKLOG_CELLS, ...BACKLOG_BAND_CELLS];
    expect(all.filter((cell) => /by the backlog band/.test(cell.name))).toEqual([...BACKLOG_BAND_CELLS]);
  });

  it("carry the term in the window: d = 10–45 ms, r = 0–3, of 6 sessions at the most", () => {
    expect(BACKLOG_TERM).toEqual({ drain: { lo: { value: 10, unit: "ms" }, hi: { value: 45, unit: "ms" } }, requests: { lo: 0, hi: 3 }, most: 6 });
    for (const cell of BACKLOG_BAND_CELLS) {
      expect(cell.prediction.kind).toBe("window");
      if (cell.prediction.kind !== "window") continue;
      expect(cell.prediction.backlog).toEqual(BACKLOG_TERM);
      // the end band without the term: the judge adds n × d, with n from the facts of each run
      expect([sec(cell.prediction.end!.band.lo), sec(cell.prediction.end!.band.hi)]).toEqual([9.98, 10]);
    }
    // the first band stays as committed
    expect([sec(BACKLOG_DRAIN.lo), sec(BACKLOG_DRAIN.hi)]).toEqual([0.04, 0.07]);
    expect(BACKLOG_REQUESTS).toEqual({ lo: 0, hi: 3 });
  });

  it("give the overshoot n × 10–45 ms after the band end and the count at the setting of the period", () => {
    const at = (n: number) => backlogBandOf("cilium", n);
    const over = (n: number) => [sec(at(n).overshoot.lo), sec(at(n).overshoot.hi)];
    expect([over(1), over(2), over(3), over(6)]).toEqual([
      [0.01, 0.045],
      [0.02, 0.09],
      [0.03, 0.135],
      [0.06, 0.27],
    ]);
    expect([sec(at(6).end.lo), sec(at(6).end.hi)]).toEqual([10.04, 10.27]);
    expect(sec(at(1).bandEnd)).toBe(10);
    // at the setting of 10 ms, the count is the count of the first band; the judge counts at the mean period of each run
    expect([at(1).expected.lo.value, at(1).expected.hi.value]).toEqual([499, 504]);
    expect([at(6).expected.lo.value, at(6).expected.hi.value]).toEqual([2994, 3024]);
    expect(() => backlogBandOf("cilium", 7)).toThrow(RangeError);
  });

  it("count at the measured period: a timer of 10.15 ms gives approximately 491–497 requests for one session", () => {
    const span = BACKLOG_BAND_CELLS[0]!.prediction.kind === "window" ? BACKLOG_BAND_CELLS[0]!.prediction.end!.band.hi : null;
    expect(span).toEqual({ value: 10, unit: "s" });
    expect(requestBand(BACKLOG_TERM, span!, { value: 10.15, unit: "ms" }, BACKLOG_CONNECTIONS, 1)).toEqual({ lo: 491, hi: 497 });
    expect(requestBand(BACKLOG_TERM, span!, { value: 10.15, unit: "ms" }, BACKLOG_CONNECTIONS, 6)).toEqual({ lo: 2946, hi: 2982 });
  });
});

/** SYS-43: the cells of SYS-42 with the drain failures of each session in the count band. */
describe("the cells of the drain band", () => {
  it("are the cells of SYS-42 with new ids and names, thus the records of SYS-40 and SYS-42 keep their bands", () => {
    expect(BACKLOG_DRAIN_CELLS.map((cell) => cell.id)).toEqual(BACKLOG_SESSIONS.map((n) => `S2.T07.cilium.goaway.backlog-drain.n${n}`));
    expect(BACKLOG_DRAIN_CELLS[3]!.name).toBe("T07 cilium, callers learn that a pod is stalled, with 6 sessions on the target, by the drain band: in band on HTTP/2 (GOAWAY)");
    const old = new Set([...CALLERS_CELLS, ...BACKLOG_CELLS, ...BACKLOG_BAND_CELLS].flatMap((cell) => [cell.id, cell.name]));
    BACKLOG_DRAIN_CELLS.forEach((cell, at) => {
      expect(old.has(cell.id)).toBe(false);
      expect(old.has(cell.name)).toBe(false);
      const second = BACKLOG_BAND_CELLS[at]!;
      // only the term and its reason are new: the window, the workload and the trigger are those of SYS-42
      expect({ ...cell, id: second.id, name: second.name, prediction: { ...cell.prediction, backlog: BACKLOG_TERM, why: "" } }).toEqual({ ...second, prediction: { ...second.prediction, why: "" } });
    });
    // a filter on the words of the names selects these cells and no other
    const all = [...CALLERS_CELLS, ...BACKLOG_CELLS, ...BACKLOG_BAND_CELLS, ...BACKLOG_DRAIN_CELLS];
    expect(all.filter((cell) => /by the drain band/.test(cell.name))).toEqual([...BACKLOG_DRAIN_CELLS]);
    expect(all.filter((cell) => /by the backlog band/.test(cell.name))).toEqual([...BACKLOG_BAND_CELLS]);
  });

  it("carry the term of SYS-42 with drains: d and r are not fitted again", () => {
    expect(BACKLOG_DRAIN_TERM).toEqual({ ...BACKLOG_TERM, drains: true });
    for (const cell of BACKLOG_DRAIN_CELLS) if (cell.prediction.kind === "window") expect(cell.prediction.backlog).toEqual(BACKLOG_DRAIN_TERM);
    // the term of SYS-42 stays as committed
    expect(BACKLOG_TERM.drains).toBeUndefined();
  });

  it("give the count with 0 to ceil(n × 45 ms / turn) drain failures for each session", () => {
    const at = (n: number) => backlogBandOf("cilium", n, BACKLOG_DRAIN_TERM);
    // at the setting, a turn of 20 ms: 3, 5, 7 and 14 drain failures for each session at the most
    expect(BACKLOG_SESSIONS.map((n) => [at(n).expected.lo.value, at(n).expected.hi.value])).toEqual([
      [499, 507],
      [998, 1018],
      [1497, 1533],
      [2994, 3108],
    ]);
    // the window is the window of SYS-42
    expect([sec(at(6).overshoot.lo), sec(at(6).overshoot.hi)]).toEqual([0.06, 0.27]);
    expect(at(6).why).toMatch(/It also fails a request each turn until the window closes: 0–14 more for each session at the setting/);
    expect(backlogBandOf("cilium", 6).why).not.toMatch(/each turn until the window closes/);
    // at a late timer of 10.15 ms
    const span = { value: 10, unit: "s" };
    expect(requestBand(BACKLOG_DRAIN_TERM, span, { value: 10.15, unit: "ms" }, BACKLOG_CONNECTIONS, 1)).toEqual({ lo: 491, hi: 500 });
    expect(requestBand(BACKLOG_DRAIN_TERM, span, { value: 10.15, unit: "ms" }, BACKLOG_CONNECTIONS, 6)).toEqual({ lo: 2946, hi: 3066 });
  });

  // This check is in sample: the term came from the record of SYS-42, thus it is not the test.
  it("contain each count of the record of SYS-42 at the mean period of its run (in sample)", () => {
    interface Copy {
      readonly cells: ReadonlyArray<{ readonly id: string; readonly failures: number[]; readonly sessions: number[]; readonly periods: number[] }>;
    }
    const copy = JSON.parse(readFileSync(new URL("../../site/src/data/s2-backlog-band-cilium-2026-10-27.json", import.meta.url), "utf8")) as Copy;
    const span = { value: 10, unit: "s" };
    const counts = copy.cells.flatMap((cell) => cell.failures.map((failed, run) => ({ id: cell.id, failed, band: requestBand(BACKLOG_DRAIN_TERM, span, { value: cell.periods[run]!, unit: "s" }, BACKLOG_CONNECTIONS, cell.sessions[run]!) })));
    expect(counts).toHaveLength(20);
    expect(counts.filter(({ failed, band }) => failed < band.lo || failed > band.hi)).toEqual([]);
    // for example, 2975 failed requests with 6 sessions at 10.186 ms are in 2934 to 3054
    expect(counts.find(({ id, failed }) => id.endsWith(".n6") && failed === 2975)?.band).toEqual({ lo: 2934, hi: 3054 });
  });
});

/** SYS-45: the cells of SYS-43 with two terms of the window band, the slow session and the early start. */
describe("the cells of the terms band", () => {
  it("are new cells with 1 and 2 sessions on the target and 10 runs, thus the old records keep their bands", () => {
    expect(BACKLOG_TERMS_CELLS.map((cell) => cell.id)).toEqual(["S2.T07.cilium.goaway.backlog-terms.n1", "S2.T07.cilium.goaway.backlog-terms.n2"]);
    expect(BACKLOG_TERMS_CELLS[0]!.name).toBe("T07 cilium, callers learn that a pod is stalled, with 1 session on the target, by the terms band: in band on HTTP/2 (GOAWAY)");
    const old = new Set([...CALLERS_CELLS, ...BACKLOG_CELLS, ...BACKLOG_BAND_CELLS, ...BACKLOG_DRAIN_CELLS].flatMap((cell) => [cell.id, cell.name]));
    BACKLOG_TERMS_CELLS.forEach((cell, at) => {
      expect(old.has(cell.id)).toBe(false);
      expect(old.has(cell.name)).toBe(false);
      expect(cell.runs).toBe(BACKLOG_TERMS_RUNS);
      const third = BACKLOG_DRAIN_CELLS[BACKLOG_SESSIONS.indexOf(BACKLOG_TERMS_SESSIONS[at]!)]!;
      // only the term, its reason and the runs are new: the window, the workload and the trigger are those of SYS-43
      expect({ ...cell, id: third.id, name: third.name, runs: third.runs, prediction: { ...cell.prediction, backlog: BACKLOG_DRAIN_TERM, why: "" } }).toEqual({ ...third, prediction: { ...third.prediction, why: "" } });
    });
    const all = [...CALLERS_CELLS, ...BACKLOG_CELLS, ...BACKLOG_BAND_CELLS, ...BACKLOG_DRAIN_CELLS, ...BACKLOG_TERMS_CELLS];
    expect(all.filter((cell) => /by the terms band/.test(cell.name))).toEqual([...BACKLOG_TERMS_CELLS]);
    expect(all.filter((cell) => /by the drain band/.test(cell.name))).toEqual([...BACKLOG_DRAIN_CELLS]);
  });

  it("carry the term of SYS-43 with a slowest drain of 100 ms and the early start: d and r are not fitted again", () => {
    expect(BACKLOG_TERMS_TERM).toEqual({ ...BACKLOG_DRAIN_TERM, slowest: { value: 100, unit: "ms" }, early: true });
    for (const cell of BACKLOG_TERMS_CELLS) if (cell.prediction.kind === "window") expect(cell.prediction.backlog).toEqual(BACKLOG_TERMS_TERM);
    // the terms of SYS-42 and SYS-43 stay as committed
    expect(BACKLOG_DRAIN_TERM.slowest).toBeUndefined();
    expect(BACKLOG_DRAIN_TERM.early).toBeUndefined();
  });

  it("give the overshoot band n × 10 ms − 20 ms to (n − 1) × 45 ms + 100 ms, and the count with the drain of the slow session", () => {
    const at = (n: number) => backlogBandOf("cilium", n, BACKLOG_TERMS_TERM);
    const over = (n: number) => [sec(at(n).overshoot.lo), sec(at(n).overshoot.hi)];
    expect(BACKLOG_SESSIONS.map(over)).toEqual([
      [-0.01, 0.1],
      [0, 0.145],
      [0.01, 0.19],
      [0.04, 0.325],
    ]);
    // the window closes n × 10 ms to (n − 1) × 45 ms + 100 ms after the band end
    expect([sec(at(1).end.lo), sec(at(1).end.hi)]).toEqual([9.99, 10.1]);
    // at the setting, a turn of 20 ms: 5 and 8 drain failures for each session at the most
    expect(BACKLOG_TERMS_SESSIONS.map((n) => [at(n).expected.lo.value, at(n).expected.hi.value])).toEqual([
      [499, 509],
      [998, 1024],
    ]);
    expect(at(1).why).toMatch(/10 ms–45 ms for each one, and one slow session up to 100 ms\. Thus the window closes 0\.01 s–0\.1 s after the band end\. The last failed request can start up to one turn before the window closes, thus it starts -0\.01 s–0\.1 s after the band end\./);
    expect(at(2).why).toMatch(/0–8 more for each session at the setting, with \(n − 1\) × 45 ms \+ 100 ms over a turn of 0\.02 s/);
    // the band of SYS-43 stays as committed
    expect(backlogBandOf("cilium", 1, BACKLOG_DRAIN_TERM).why).not.toMatch(/slow session|one turn before/);
    const span = { value: 10, unit: "s" };
    expect(requestBand(BACKLOG_TERMS_TERM, span, { value: 10.2, unit: "ms" }, BACKLOG_CONNECTIONS, 1)).toEqual({ lo: 489, hi: 500 });
  });

  // This check is in sample: the terms came from these records, thus it is not the test.
  it("contain each overshoot and each count of the records of SYS-42 and SYS-43 (in sample)", () => {
    interface Copy {
      readonly cells: ReadonlyArray<{ readonly lasts: number[]; readonly bandEnd: number; readonly failures: number[]; readonly sessions: number[]; readonly periods: number[] }>;
    }
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../../site/src/data/${name}`, import.meta.url), "utf8")) as Copy;
    const runs = [read("s2-backlog-band-cilium-2026-10-27.json"), read("s2-backlog-drain-cilium-2026-10-28.json")].flatMap((copy) =>
      copy.cells.flatMap((cell) => cell.lasts.map((last, run) => ({ over: last - cell.bandEnd, n: cell.sessions[run]!, failed: cell.failures[run]!, period: cell.periods[run]! }))),
    );
    expect(runs).toHaveLength(39);
    const outside = (term: typeof BACKLOG_TERM) =>
      runs.filter(({ over, n }) => {
        const band = backlogBandOf("cilium", n, term).overshoot;
        return over < sec(band.lo) || over > sec(band.hi);
      });
    // the band of SYS-43 misses 4 runs, each with 1 session: 1 below and 3 above
    expect(outside(BACKLOG_DRAIN_TERM).map(({ n, over }) => [n, Math.round(over * 1000)])).toEqual([
      [1, 90],
      [1, 58],
      [1, 9],
      [1, 50],
    ]);
    expect(outside(BACKLOG_TERMS_TERM)).toEqual([]);
    const span = { value: 10, unit: "s" };
    expect(runs.filter(({ n, failed, period }) => {
      const band = requestBand(BACKLOG_TERMS_TERM, span, { value: period, unit: "s" }, BACKLOG_CONNECTIONS, n);
      return failed < band.lo || failed > band.hi;
    })).toEqual([]);
  });
});
