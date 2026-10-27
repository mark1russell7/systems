import { describe, expect, it } from "vitest";
import type { KindRun } from "./cell.ts";
import { cellOf } from "./cells.fixture.ts";
import type { Line } from "./lab.ts";
import { periodOf } from "./observe.ts";
import { FORMAT } from "./record.ts";
import { kindCellRecordSchema } from "./schema.ts";
import { factsOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });

/** a request of a client that starts at `t`, in milliseconds */
const request = (t: number, p: string): Line => ({ ev: "req", t, d: 1, o: "ok", p, n: "w1", lp: 3, b: "lab-a" });

/** the requests of a client from `from`, one each `period` milliseconds */
const loop = (p: string, from: number, period: number, count: number): Line[] => Array.from({ length: count }, (_, at) => request(from + at * period, p));

const runWith = (lines: Line[], start = 0, end = 60_000): KindRun => ({
  env: 0,
  index: 0,
  warmup: false,
  start,
  end,
  acts: { fault: 1000, heal: null, resume: null },
  target: { pod: "lab-a", node: "w1", ip: "10.244.1.3", version: "h1" },
  paused: null,
  replicas: [],
  void: null,
  dropped: {},
  lines,
});

describe("the measured period of the clients", () => {
  it("gives the interval between two requests in sequence of one client, not of two clients", () => {
    // two clients, each late by a different amount, with their lines mixed
    const lines = [...loop("client-a", 0, 10.1, 11), ...loop("client-b", 3, 10.2, 11)].sort((a, b) => a.t - b.t);
    const period = periodOf(lines, 0, 60_000)!;
    expect(period.intervals).toBe(20);
    expect(period.median).toBeCloseTo(10.15, 9);
    expect(period.mean).toBeCloseTo(10.15, 9);
    expect(period.low).toBeCloseTo(10.1, 9);
    expect(period.high).toBeCloseTo(10.2, 9);
    expect(Object.keys(period.byClient)).toEqual(["client-a", "client-b"]);
    expect(period.byClient["client-a"]).toBeCloseTo(10.1, 9);
    expect(period.byClient["client-b"]).toBeCloseTo(10.2, 9);
  });

  it("keeps the median at the period of the timer if one tick of a client is late, and the mean counts the late tick", () => {
    const starts = [0, 10, 20, 30, 140, 150, 160];
    const period = periodOf(starts.map((t) => request(t, "client-a")), 0, 60_000)!;
    expect(period.median).toBe(10);
    expect(period.mean).toBe(160 / 6);
    expect(period.high).toBe(110);
  });

  it("reads only the requests of the span, and gives null with no interval", () => {
    const lines = [...loop("client-a", 0, 10, 5), ...loop("client-a", 1000, 20, 5)];
    expect(periodOf(lines, 1000, 2000)).toEqual({ median: 20, mean: 20, low: 20, high: 20, intervals: 4, byClient: { "client-a": 20 } });
    expect(periodOf([], 0, 60_000)).toBeNull();
    // one request of each client gives no interval
    expect(periodOf([request(0, "client-a"), request(5, "client-b")], 0, 60_000)).toBeNull();
    // a line that is not a request is not a start
    expect(periodOf([request(0, "client-a"), { ev: "pings", t: 10, p: "client-a", sent: 0, acked: 0 }], 0, 60_000)).toBeNull();
  });

  it("is a fact of each run with requests, in seconds to the microsecond, and the cell does not change", () => {
    const lines = [...loop("client-a", 0, 10.1534, 101), ...loop("client-b", 2, 10.2218, 101)];
    for (const cell of [cellOf("pod-deletion"), cellOf("app-stall")]) {
      const period = factsOf(cell, runWith(lines)).period;
      expect(period, cell.trigger.kind).toEqual({
        median: s(0.010188),
        mean: s(0.010188),
        low: s(0.010153),
        high: s(0.010222),
        intervals: 200,
        byClient: { "client-a": s(0.010153), "client-b": s(0.010222) },
      });
    }
    // the span of the run limits the requests, as it limits the failures
    expect(factsOf(cellOf("pod-deletion"), runWith(lines, 0, 500)).period?.intervals).toBe(97);
    expect(factsOf(cellOf("pod-deletion"), runWith([])).period).toBeUndefined();
  });

  it("is in the schema of a record of /2, and a record without it stays valid", () => {
    const cell = cellOf("pod-deletion");
    const facts = factsOf(cell, runWith(loop("client-a", 0, 10.1, 3)));
    const record = {
      format: FORMAT,
      cell,
      runs: [],
      manifests: [],
      loads: [],
      at: "2026-10-27T00:00:00.000Z",
      verdict: { decision: "holds", counted: 1, voided: 0, failed: 0, median: null, why: "a test", checks: [{ ok: true, why: "a test", value: null, facts }] },
    };
    const parsed = kindCellRecordSchema.safeParse(record);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    if (parsed.success) expect(parsed.data.verdict.checks[0]!.facts.period).toEqual({ median: s(0.0101), mean: s(0.0101), low: s(0.0101), high: s(0.0101), intervals: 2, byClient: { "client-a": s(0.0101) } });
    const { period: _period, ...before } = facts;
    const old = { ...record, verdict: { ...record.verdict, checks: [{ ok: true, why: "a test", value: null, facts: before }] } };
    expect(kindCellRecordSchema.safeParse(old).success).toBe(true);
  });
});
