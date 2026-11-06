import { describe, expect, it } from "vitest";
import type { Cell, KernelRecord, ProbeEvent, QueuePrediction, Run } from "./cell.ts";
import { measure } from "./observe.ts";
import { verdictOf } from "./verdict.ts";

const NS = 1_000_000_000;
const s = (value: number) => ({ value, unit: "s" });
const band = (low: number, high: number) => ({ low: s(low), high: s(high) });
const CLIENT = 11;
const counters = { overflows: 0, drops: 0, cookies: 0, timeouts: 0, resets: 0 };

const cellOf = (queue: QueuePrediction): Cell =>
  ({
    name: "AQ.test",
    target: { image: "x", port: 6390, ready: "listening", lines: true },
    sysctls: {},
    client: { image: "x", command: [] },
    probe: { mode: "idle", keepalive: false },
    fault: "none",
    prediction: { detects: null, window: s(10), why: "the law", queue },
    runs: 4,
    environments: 2,
  }) as Cell;

const record = (ev: string, mono: number, fields: Partial<KernelRecord> = {}): KernelRecord =>
  ({ ev, mono, cookie: 5, netns: CLIENT, src: "10.0.0.3:4000", ...fields }) as KernelRecord;

const line = (ev: string, t: number, fields: Record<string, unknown> = {}): ProbeEvent => ({ ev, t, ...fields });

const LOCAL = { local: "10.0.0.3:4000" };

/** This run has a client that connected, a queue of 1, and two SYN-ACKs at the connection. */
const runOf = (changes: Partial<Run> = {}): Run =>
  ({
    environment: 0,
    index: 0,
    events: [
      line("opened", 1 * NS, { count: 0, max: 1, ...counters }),
      line("ready", 1 * NS),
      line("dial", 2 * NS, { name: "in", ...LOCAL }),
      line("connected", 2 * NS + 1000, { name: "in", ...LOCAL }),
      line("state", 9 * NS, { name: "in", state: 1, unacked: 0 }),
      line("stats", 9 * NS, { count: 1, max: 1, ...counters, overflows: 2, drops: 2 }),
      line("done", 9 * NS),
    ],
    fault: null,
    kernel: [
      record("rx", 3 * NS, { seg: { seq: 1, flags: 18, len: { value: 0, unit: "B" } } }),
      record("rx", 5 * NS, { seg: { seq: 1, flags: 18, len: { value: 0, unit: "B" } } }),
      record("rx", 5.5 * NS, { seg: { seq: 2, flags: 16, len: { value: 1, unit: "B" } } }),
    ],
    netns: CLIENT,
    targetNetns: 22,
    lost: 0,
    server: [line("queue", 1.1 * NS, { count: 0 }), line("queue", 2.1 * NS, { count: 1 })],
    ...changes,
  }) as Run;

const LAW: QueuePrediction = {
  max: 1,
  held: 1,
  connected: 1,
  overflows: { low: 2, high: 2 },
  resets: 0,
  connections: [{ name: "in", connects: true, synAcks: [band(0.9, 1.1), band(1.9, 2.1)], ends: null, unacked: 0 }],
};

describe("the measure of an accept queue", () => {
  it("reads the limit, the count, the counters and the waits of a connection", () => {
    const read = measure(cellOf(LAW), runOf());
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(read.queue).toMatchObject({ max: 1, held: 1, connected: 1, overflows: 2, drops: 2, cookies: 0 });
    expect(read.queue?.connections[0]?.synAcks).toEqual([s(1), s(2)]);
  });

  it("gives a finding for each term outside the law", () => {
    const read = measure(cellOf({ ...LAW, max: 2, held: 3, overflows: { low: 5, high: 5 } }), runOf());
    expect(read.finding).toContain("the limit is 1, not 2");
    expect(read.finding).toContain("the queue held 1, not 3");
    expect(read.finding).toContain("2 overflows");
  });

  it("gives a finding for a SYN cookie, because the law has none", () => {
    const events = runOf().events.map((each) => (each.ev === "stats" ? { ...each, cookies: 1 } : each));
    const read = measure(cellOf({ ...LAW }), runOf({ events }));
    expect(read.finding).toContain("1 SYN cookies");
  });

  it("gives a void for a run with lost records, and for a client that did not end", () => {
    expect(measure(cellOf(LAW), runOf({ lost: 3 })).void).toContain("dropped 3");
    const events = runOf().events.filter((each) => each.ev !== "done");
    expect(measure(cellOf(LAW), runOf({ events })).void).toContain("did not reach its end");
  });

  it("gives a void when the connection of the last place did not get its ACK", () => {
    const events = runOf().events.map((each) => (each.ev === "state" ? { ...each, unacked: 1 } : each));
    expect(measure(cellOf({ ...LAW, admitted: "in" }), runOf({ events })).void).toContain("did not take the last place");
  });

  it("reads an end against its band, and the last two retransmissions against the expiry", () => {
    const law: QueuePrediction = {
      ...LAW,
      expiry: { timeouts: 2, within: band(3, 4) },
      connections: [
        {
          name: "in",
          connects: true,
          ends: { errno: "ECONNRESET", from: "dial", within: band(5, 7), retransmitted: band(0.05, 0.2) },
        },
      ],
    };
    const events = [
      ...runOf().events.filter((each) => each.ev !== "state"),
      line("failed", 8 * NS, { name: "in", errno: "ECONNRESET" }),
    ];
    const kernel = [record("retrans", 3 * NS), record("retrans", 7.9 * NS)];
    const server = [line("queue", 1.1 * NS, { count: 1, timeouts: 0 }), line("queue", 5.5 * NS, { count: 1, timeouts: 2 })];
    const read = measure(cellOf(law), runOf({ events, kernel, server }));
    expect(read.queue?.expiry).toEqual(s(3.5));
    expect(read.queue?.connections[0]?.ended).toEqual(s(6));
    expect(read.finding).toBeNull();
    const early = [record("retrans", 6 * NS), record("retrans", 7.9 * NS)];
    expect(measure(cellOf(law), runOf({ events, kernel: early, server })).finding).toContain("do not span the expiry");
  });

  it("times the rise of the count from the first count below it", () => {
    const law: QueuePrediction = { ...LAW, connections: [], rise: { count: 4, within: band(2.9, 3.1) } };
    const events = [...runOf().events, line("accepted", 4 * NS, { peers: [1, 2, 3] })];
    const server = [
      line("queue", 3.9 * NS, { count: 5 }),
      line("queue", 4 * NS, { count: 5 }),
      line("queue", 4.1 * NS, { count: 2 }),
      line("queue", 5 * NS, { count: 4 }),
    ];
    const read = measure(cellOf({ ...law, held: 5 }), runOf({ events, server }));
    expect(read.queue?.rise).toEqual(s(3));
    expect(read.queue?.drained).toBe(3);
    expect(read.finding).toBeNull();
  });
});

describe("the verdict of an accept queue", () => {
  it("holds when each run holds the law, and fails on one run outside it", () => {
    const cell = cellOf(LAW);
    const good = [measure(cell, runOf()), measure(cell, runOf({ index: 1 }))];
    expect(verdictOf(cell.prediction, good).decision).toBe("holds");
    const bad = measure(cellOf({ ...LAW, max: 2 }), runOf({ index: 2 }));
    expect(verdictOf(cell.prediction, [...good, bad]).decision).toBe("fails");
  });
});
