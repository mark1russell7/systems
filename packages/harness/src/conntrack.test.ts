import { describe, expect, it } from "vitest";
import type { Cell, ConntrackPrediction, KernelRecord, ProbeEvent, Run } from "./cell.ts";
import { measure } from "./observe.ts";
import { verdictOf } from "./verdict.ts";

const NS = 1_000_000_000;
const s = (value: number) => ({ value, unit: "s" });
const band = (low: number, high: number) => ({ low: s(low), high: s(high) });
const CLIENT = 11;

const cellOf = (conntrack: ConntrackPrediction): Cell =>
  ({
    name: "CT.test",
    target: { image: "x", port: 6392, ready: "listening", lines: true },
    sysctls: {},
    client: { image: "x", command: [] },
    probe: { mode: "idle", keepalive: false },
    fault: "none",
    prediction: { detects: null, window: s(360), why: "the law", conntrack },
    runs: 4,
    environments: 2,
  }) as Cell;

const line = (ev: string, t: number, fields: Record<string, unknown> = {}): ProbeEvent => ({ ev, t, ...fields });

const runOf = (events: readonly ProbeEvent[], changes: Partial<Run> = {}): Run =>
  ({
    environment: 0,
    index: 0,
    events: [line("ready", 1 * NS), line("settled", 2 * NS, { waited: 0 }), ...events, line("done", 300 * NS)],
    fault: null,
    kernel: [] as KernelRecord[],
    netns: CLIENT,
    targetNetns: 22,
    lost: 0,
    server: [],
    ...changes,
  }) as Run;

const FULL = line("full", 3 * NS, { flows: 1024, count: 1024, errno: null });
const STALL = line("stall", 14 * NS, { errno: "ETIMEDOUT", elapsed: 11.2 * NS, drops: 7, retrans_fail: 6 });
const REFUSED: ConntrackPrediction = {
  max: 1024,
  refused: { within: band(11, 11.498), errno: "ETIMEDOUT", drops: 7, retransFail: 6 },
};

const CLOSING = line("closing", 3.5 * NS);
const drainedAt = (first: number | null, zero: number | null) =>
  line("drained", 70 * NS, { first_fall: first === null ? null : (3.5 + first) * NS, zero: zero === null ? null : (3.5 + zero) * NS, lowest: 0 });

const PRESSURE: ConntrackPrediction = {
  max: 1024,
  pressure: { lowest: 959, after: 960, points: [band(1, 1.1), band(19, 19.6)] },
};
const CLOSED = line("closed", 4 * NS, { count: 1024 });
const GOT = line("stall", 23 * NS, { errno: "none", elapsed: 19.2 * NS, drops: 18, retrans_fail: 7, lowest: 959, after: 960 });

describe("the reading of a conntrack cell", () => {
  it("reads a full table and the connect that finds no entry", () => {
    const read = measure(cellOf(REFUSED), runOf([FULL, STALL]));
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(read.conntrack).toMatchObject({ flows: 1024, count: 1024, stall: { errno: "ETIMEDOUT", drops: 7, retransFail: 6 } });
  });

  it("voids a run with no end, a dropped record, no fill, a table that did not empty, or an environment that cannot do the cell", () => {
    const run = runOf([FULL, STALL]);
    expect(measure(cellOf(REFUSED), { ...run, events: [FULL] }).void).toMatch(/end/);
    expect(measure(cellOf(REFUSED), { ...run, lost: 2 }).void).toMatch(/dropped 2/);
    expect(measure(cellOf(REFUSED), { ...run, lost: null }).void).toMatch(/clock line/);
    expect(measure(cellOf(REFUSED), runOf([STALL])).void).toMatch(/fill/);
    expect(measure(cellOf(REFUSED), { ...run, events: [line("unsettled", 2 * NS, { count: 12, waited: 90 * NS })] }).void).toMatch(/12 entries/);
    expect(measure(cellOf(REFUSED), { ...run, missing: "nf_conntrack_max of the host reads 0" }).void).toMatch(/cannot do this cell: nf_conntrack_max/);
  });

  it("finds a short fill, a failed fill, another end of the connect and each counter outside the law", () => {
    const fill = (fields: Record<string, unknown>) => line("full", 3 * NS, { flows: 1024, count: 1024, errno: null, ...fields });
    const stall = (fields: Record<string, unknown>) => line("stall", 14 * NS, { errno: "ETIMEDOUT", elapsed: 11.2 * NS, drops: 7, retrans_fail: 6, ...fields });
    const finding = (events: readonly ProbeEvent[]) => measure(cellOf(REFUSED), runOf(events)).finding;
    expect(finding([fill({ flows: 1000 }), STALL])).toMatch(/held 1000 flows/);
    expect(finding([fill({ count: 1000 }), STALL])).toMatch(/count read 1000/);
    expect(finding([fill({ flows: 3, errno: "ETIMEDOUT" }), STALL])).toMatch(/failed with ETIMEDOUT/);
    expect(finding([FULL])).toMatch(/no connect/);
    expect(finding([FULL, stall({ errno: "ECONNREFUSED" })])).toMatch(/ended with ECONNREFUSED/);
    expect(finding([FULL, stall({ elapsed: 7 * NS })])).toMatch(/took 7 s, outside \[11, 11.498\] s/);
    expect(finding([FULL, stall({ drops: 4 })])).toMatch(/rose by 4/);
    expect(finding([FULL, stall({ retrans_fail: 5 })])).toMatch(/TCPRetransFail rose by 5/);
  });

  it("reads the namespace of the target while the client holds its flows", () => {
    const law = { ...REFUSED, neighbor: 1024 };
    const count = (at: number, value: number) => line("count", at * NS, { count: value, flows: value });
    expect(measure(cellOf(law), runOf([FULL, STALL], { server: [count(2, 7), count(5, 1024), count(15, 3)] })).finding).toBeNull();
    expect(measure(cellOf(law), runOf([FULL, STALL], { server: [count(5, 1000)] })).finding).toMatch(/target read 1000/);
    expect(measure(cellOf(law), runOf([FULL, STALL], { server: [count(2, 1024)] })).finding).toMatch(/target read nothing/);
  });

  it("reads a band of a slot that comes back after a reset", () => {
    const law: ConntrackPrediction = { max: 1024, drained: band(10, 61) };
    const finding = (first: number | null, zero: number | null) => measure(cellOf(law), runOf([FULL, CLOSING, drainedAt(first, zero)])).finding;
    expect(finding(10.5, 10.5)).toBeNull();
    expect(finding(0.2, 10.5)).toMatch(/first fall of the count came at 0.2 s/);
    expect(finding(10.5, 70)).toMatch(/zero of the count came at 70 s/);
    expect(finding(null, null)).toMatch(/first fall of the count came at no time/);
  });

  it("reads the floor of a scan under pressure and the point of the schedule", () => {
    const got = (fields: Record<string, unknown>) => line("stall", 23 * NS, { errno: "none", elapsed: 19.2 * NS, drops: 18, retrans_fail: 7, lowest: 959, after: 960, ...fields });
    const finding = (events: readonly ProbeEvent[]) => measure(cellOf(PRESSURE), runOf(events)).finding;
    expect(finding([FULL, CLOSED, GOT])).toBeNull();
    expect(finding([FULL, CLOSED, got({ lowest: 949 })])).toMatch(/lowest count was 949/);
    expect(finding([FULL, CLOSED, got({ after: 950 })])).toMatch(/read 950 after the connect/);
    expect(finding([FULL, CLOSED, got({ errno: "ETIMEDOUT" })])).toMatch(/ended with ETIMEDOUT/);
    expect(finding([FULL, CLOSED, got({ elapsed: 5 * NS })])).toMatch(/on no point of the schedule/);
    expect(finding([FULL, line("closed", 4 * NS, { count: 800 }), GOT])).toMatch(/read 800 after each side closed/);
    expect(finding([FULL, CLOSED])).toMatch(/no connect after the close/);
  });

  it("gives a verdict on the law, and names the table in it", () => {
    const cell = cellOf(REFUSED);
    const clean = [0, 1, 2, 3].map((index) => measure(cell, runOf([FULL, STALL], { index })));
    const holds = verdictOf(cell.prediction, clean);
    expect(holds.decision).toBe("holds");
    expect(holds.why).toMatch(/4 of 4 runs hold the law of the conntrack table/);
    const off = [...clean.slice(0, 3), measure(cell, runOf([FULL], { index: 3 }))];
    expect(verdictOf(cell.prediction, off).decision).toBe("fails");
  });
});
