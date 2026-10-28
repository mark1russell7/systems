import { describe, expect, it } from "vitest";
import { backlogEnd, drainBand, requestBand } from "./bands.ts";
import type { BacklogTerm, KindCell, KindRun, WindowPrediction } from "./cell.ts";
import { cellOf } from "./cells.fixture.ts";
import type { Line } from "./lab.ts";
import { FORMAT, upgradeCell } from "./record.ts";
import { predictionText } from "./report.ts";
import { kindCellRecordSchema } from "./schema.ts";
import { checkRun, factsOf, judgeKind, observationAfter } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const b = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
const TARGET = { pod: "lab-a", node: "w1", ip: "10.244.1.3", version: "h1" };
const OTHER = { pod: "lab-b", node: "w2", ip: "10.244.2.4", version: "h1" };

/** This is the term of SYS-42: d = 10–45 ms and r = 0–3 for each session, of 2 sessions at the most. */
const TERM: BacklogTerm = { drain: { lo: ms(10), hi: ms(45) }, requests: { lo: 0, hi: 3 }, most: 2 };

/** This window is the stall of C. It opens at the fault. It closes in the band of 10 s, from one turn before the band end to the band end. */
const WINDOW: WindowPrediction = {
  kind: "window",
  nodes: "all",
  start: { from: "fault", band: b(0, 0.02) },
  end: { from: "fault", band: b(9.98, 10) },
  certain: true,
  outcomes: ["timeout"],
  backlog: TERM,
  why: "a test",
};

/** This cell is a stall with one client of two sessions, each one request each 20 ms. */
const STALL: KindCell = { ...cellOf("app-stall"), workload: { every: ms(10), timeout: s(2), connections: 2 }, prediction: WINDOW };

const FAULT = 1000;

/**
 * This run has one client with a period of 10.15 ms. It sends on port 3 (the target) and port 4 (the
 * other replica) in turn. Each stream on port 3 from the fault to `last` after it fails at its timeout.
 */
const runOf = (last: number, extra: Line[] = []): KindRun => {
  const lines: Line[] = [];
  for (let k = 0; k * 10.15 < 20_000; k++) {
    const t = Math.round(k * 10.15 * 1000) / 1000;
    const lp = k % 2 === 0 ? 3 : 4;
    const fails = lp === 3 && t >= FAULT && t <= FAULT + last;
    lines.push({ ev: "req", t, d: fails ? 2000 : 1, o: fails ? "timeout" : "ok", p: "client-a", n: "w1", lp, ...(fails ? {} : { b: lp === 3 ? "lab-a" : "lab-b" }) });
  }
  return {
    env: 0,
    index: 0,
    warmup: false,
    start: 0,
    end: 30_000,
    acts: { fault: FAULT, heal: null, resume: null },
    target: TARGET,
    paused: null,
    replicas: [TARGET, OTHER],
    void: null,
    dropped: {},
    lines: [...lines, ...extra].sort((x, y) => x.t - y.t),
  };
};

describe("the backlog term of a stall (SYS-42)", () => {
  it("adds n × d to each end of the end band", () => {
    expect(backlogEnd(b(9.98, 10), TERM, 1)).toEqual(b(9.99, 10.045));
    expect(backlogEnd(b(9.98, 10), TERM, 6)).toEqual(b(10.04, 10.27));
    expect(backlogEnd(b(0, 0), TERM, 3)).toEqual(b(0.03, 0.135));
    // with no session on the target, the term adds nothing
    expect(backlogEnd(b(9.98, 10), TERM, 0)).toEqual(b(9.98, 10));
  });

  it("counts the failed requests of the n sessions from the mean period, one less and one more at the edges, and n × r more", () => {
    // at the setting: 500 requests of a session in 10 s, thus the first band of SYS-40
    expect(requestBand(TERM, s(10), ms(10), 2, 1)).toEqual({ lo: 499, hi: 504 });
    expect(requestBand(TERM, s(10), ms(10), 2, 6)).toEqual({ lo: 2994, hi: 3024 });
    // a late timer: 10.15 ms gives a turn of 20.3 ms, thus approximately 492.6 requests of a session in 10 s
    expect(requestBand(TERM, s(10), ms(10.15), 2, 1)).toEqual({ lo: 491, hi: 497 });
    expect(requestBand(TERM, s(10), ms(10.15), 2, 3)).toEqual({ lo: 1473, hi: 1491 });
    expect(() => requestBand(TERM, s(10), ms(0), 2, 1)).toThrow(RangeError);
  });

  it("holds a run whose last failure is n × d after the band end and whose count is in the band of its period", () => {
    const run = runOf(10_026);
    const facts = factsOf(STALL, run);
    expect(facts.sessions?.onTarget).toBe(1);
    expect(facts.period?.mean).toEqual(s(0.01015));
    const check = checkRun(STALL, run);
    expect(check.ok, check.why).toBe(true);
    expect(check.value).toEqual({ value: 494, unit: "{request}" });
    expect(check.why).toMatch(/in the count \[491, 497\] of 1 session on the target at a mean period of 10\.15 ms$/);
    expect(judgeKind({ ...STALL, runs: 1 }, [run]).decision).toBe("holds");
  });

  it("fails a run with a count outside the band of its period", () => {
    // 20 more timeouts on the session of the other replica, in the window
    const extra: Line[] = Array.from({ length: 20 }, (_, k) => ({ ev: "req", t: 2000.5 + k, d: 2000, o: "timeout", p: "client-b", n: "w2" }));
    const check = checkRun(STALL, runOf(10_026, extra));
    expect(check.ok).toBe(false);
    // the requests of client-b also change the mean period, thus the band moves
    expect(check.why).toMatch(/^514 failed requests, outside the count \[\d+, \d+\] of 1 session on the target at a mean period of/);
  });

  it("fails a run with no sessions on the target at the fault, and a window whose end has another reference", () => {
    const unplaced = { ...STALL, workload: { every: ms(10), timeout: s(2) } };
    expect(checkRun(unplaced, runOf(10_026)).why).toBe("the run has no sessions on the target at the fault, thus the backlog term has no n");
    const healed = { ...STALL, prediction: { ...WINDOW, end: { from: "heal" as const, band: b(0, 1) } } };
    expect(checkRun(healed, runOf(10_026)).why).toBe("a window with the backlog term has an end with the reference of its start");
  });

  it("keeps a window without the term as it was: no count", () => {
    const { backlog: _backlog, ...bare } = WINDOW;
    const check = checkRun({ ...STALL, prediction: bare }, runOf(10_026));
    expect(check.ok, check.why).toBe(true);
    expect(check.why).not.toMatch(/count/);
  });

  it("observes the drain of the most sessions on the target after the window", () => {
    // 10 s, then 2 × 45 ms, then the timeout of 2 s and δ
    expect(observationAfter(STALL)).toEqual(s(12.19));
    const { backlog: _backlog, ...bare } = WINDOW;
    expect(observationAfter({ ...STALL, prediction: bare })).toEqual(s(12.1));
  });

  it("is in the text, the schema of /2 and the upgrade of /1", () => {
    expect(predictionText(WINDOW)).toMatch(/the end n × \[0\.01, 0\.045\] s later and 0–3 more failures for each of the n sessions on the target, counted at the measured period$/);
    const record = { format: FORMAT, cell: STALL, runs: [], manifests: [], loads: [], at: "2026-10-27T00:00:00.000Z", verdict: { decision: "void", counted: 0, voided: 0, failed: 0, median: null, why: "a test", checks: [] } };
    const parsed = kindCellRecordSchema.safeParse(record);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    if (parsed.success && parsed.data.cell.prediction.kind === "window") expect(parsed.data.cell.prediction.backlog).toEqual(TERM);
    const old = { ...STALL, prediction: { ...WINDOW, start: { from: "fault", band: { lo: 0, hi: 0.02 } }, end: { from: "fault", band: { lo: 9.98, hi: 10 } }, backlog: { ...TERM, drain: { lo: 0.01, hi: 0.045 } } } };
    const upgraded = upgradeCell(old as unknown as Parameters<typeof upgradeCell>[0]);
    expect(upgraded.prediction.kind === "window" && upgraded.prediction.backlog).toEqual({ ...TERM, drain: b(0.01, 0.045) });
  });
});

/** This is the term of SYS-43: the term of SYS-42 with the drain failures of each session. */
const DRAINS: BacklogTerm = { ...TERM, drains: true };

describe("the drain failures of the backlog term (SYS-43)", () => {
  it("gives 0 to ceil(n × d.hi / turn) drain failures for each session", () => {
    // a turn of 20 ms: 45 ms / 20 ms = 2.25, thus 3 with 1 session, and 6 × 45 / 20 = 13.5, thus 14 with 6
    expect(drainBand(TERM, ms(10), 2, 1)).toEqual({ lo: 0, hi: 3 });
    expect(drainBand(TERM, ms(10), 2, 6)).toEqual({ lo: 0, hi: 14 });
    // a turn of exactly 22.5 ms: 2 × 45 / 22.5 = 4, not 5
    expect(drainBand(TERM, ms(11.25), 2, 2)).toEqual({ lo: 0, hi: 4 });
    expect(drainBand(TERM, ms(10), 2, 0)).toEqual({ lo: 0, hi: 0 });
    expect(() => drainBand(TERM, ms(0), 2, 1)).toThrow(RangeError);
  });

  it("adds the drain failures of each session to the count band of a term with drains, and nothing without it", () => {
    // at the setting: at most 500 + 1 + 3 + 3 for each session with 1 session, and 500 + 1 + 3 + 14 with 6
    expect(requestBand(DRAINS, s(10), ms(10), 2, 1)).toEqual({ lo: 499, hi: 507 });
    expect(requestBand(DRAINS, s(10), ms(10), 2, 6)).toEqual({ lo: 2994, hi: 3108 });
    // a late timer of 10.186 ms: 490.87 requests of a session in 10 s, and 13.25 in the drain of 6 sessions
    expect(requestBand(DRAINS, s(10), ms(10.186), 2, 6)).toEqual({ lo: 2934, hi: 3054 });
    // the term of SYS-42 stays as it was
    expect(requestBand(TERM, s(10), ms(10), 2, 6)).toEqual({ lo: 2994, hi: 3024 });
    expect(() => requestBand({ requests: TERM.requests, drains: true }, s(10), ms(10), 2, 1)).toThrow(RangeError);
  });

  it("holds a run whose count is above the band of SYS-42 and in the band with the drain", () => {
    // the target session fails until 110 ms after the band end, in the judge noise: 4 more than the run of 26 ms
    const run = runOf(10_110);
    const old = checkRun(STALL, run);
    expect(old.ok).toBe(false);
    expect(old.why).toMatch(/^498 failed requests, outside the count \[491, 497\] of 1 session on the target/);
    const check = checkRun({ ...STALL, prediction: { ...WINDOW, backlog: DRAINS } }, run);
    expect(check.ok, check.why).toBe(true);
    expect(check.value).toEqual({ value: 498, unit: "{request}" });
    expect(check.why).toMatch(/in the count \[491, 500\] of 1 session on the target at a mean period of 10\.15 ms$/);
  });

  it("is in the text and the schema of /2", () => {
    expect(predictionText({ ...WINDOW, backlog: DRAINS })).toMatch(
      /0–3 more failures for each of the n sessions on the target, and its failures each turn in the drain of the n sessions, counted at the measured period$/,
    );
    const cell = { ...STALL, prediction: { ...WINDOW, backlog: DRAINS } };
    const record = { format: FORMAT, cell, runs: [], manifests: [], loads: [], at: "2026-10-28T00:00:00.000Z", verdict: { decision: "void", counted: 0, voided: 0, failed: 0, median: null, why: "a test", checks: [] } };
    const parsed = kindCellRecordSchema.safeParse(record);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    if (parsed.success && parsed.data.cell.prediction.kind === "window") expect(parsed.data.cell.prediction.backlog).toEqual(DRAINS);
  });
});
