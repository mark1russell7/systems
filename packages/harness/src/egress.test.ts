import { describe, expect, it } from "vitest";
import type { Cell, EgressPrediction, KernelRecord, ProbeEvent, Run } from "./cell.ts";
import { measure } from "./observe.ts";
import { verdictOf } from "./verdict.ts";

const NS = 1_000_000_000;
const MS = 1_000_000;
const s = (value: number) => ({ value, unit: "s" });
const band = (low: number, high: number) => ({ low: s(low), high: s(high) });

// a token bucket of 3000 bytes at 1 Mbit/s with a queue of one frame: the first burst sends three at
// once, queues one, and drops one, and the second burst sends one from a bucket of 1000 bytes
const TBF: EgressPrediction = {
  qdisc: "tbf rate 1mbit burst 3000 limit 1042",
  kind: "tbf",
  bursts: [
    { at: s(0), count: 5, payload: 958 },
    { at: s(0.03), count: 1, payload: 958 },
  ],
  packets: [
    { kind: "sent", left: band(0, 0.001) },
    { kind: "sent", left: band(0, 0.001) },
    { kind: "sent", left: band(0, 0.001) },
    { kind: "sent", left: band(0.007, 0.01) },
    { kind: "dropped", why: "limit" },
    { kind: "sent", left: band(0, 0.001) },
  ],
  spread: s(0.0005),
  jitter: s(0.002),
  read: 0.9,
};

const cellOf = (egress: EgressPrediction): Cell =>
  ({
    name: "EQ.test",
    target: { image: "x", port: 6393, ready: "listening", lines: true },
    sysctls: {},
    client: { image: "x", command: [] },
    probe: { mode: "idle", keepalive: false },
    fault: "none",
    prediction: { detects: null, window: s(60), why: "the law", egress },
    runs: 4,
    environments: 2,
  }) as Cell;

const line = (ev: string, t: number, fields: Record<string, unknown> = {}): ProbeEvent => ({ ev, t, ...fields });

const runOf = (events: readonly ProbeEvent[], changes: Partial<Run> = {}): Run =>
  ({
    environment: 0,
    index: 0,
    events,
    fault: null,
    kernel: [] as KernelRecord[],
    netns: 11,
    targetNetns: 22,
    lost: 0,
    server: [],
    ...changes,
  }) as Run;

const START = 10 * NS;

const ready = (fields: Record<string, unknown> = {}) =>
  line("ready", START - 20 * MS, {
    mtu: 1500,
    qdisc: { kind: "tbf", root: true, packets: 40, drops: 0 },
    neighbour: { lladdr: "02:42:0a:00:00:02", state: ["PERMANENT"] },
    ...fields,
  });

/** Each datagram: its burst, its arrival after the start in ms, its departure in ms or null, and its errno. */
type Datagram = readonly [number, number, number | null, string | null];

const CLEAN: readonly Datagram[] = [
  [0, 0, 0.01, null],
  [0, 0.02, 0.03, null],
  [0, 0.04, 0.05, null],
  [0, 0.06, 8.1, null],
  [0, 0.08, null, "ENOBUFS"],
  [1, 30.2, 30.21, null],
];

const linesOf = (datagrams: readonly Datagram[]): ProbeEvent[] =>
  datagrams.map(([burst, at, left, errno], key) =>
    line("packet", START + at * MS + 1000, {
      key,
      burst,
      payload: 958,
      errno,
      sched: START + at * MS,
      left: left === null ? null : START + left * MS,
    }),
  );

const ends = (packets: number, drops: number, step = 0): ProbeEvent[] => [
  line("stats", START + NS, { before: { packets: 40, drops: 0 }, after: { packets: 40 + packets, drops }, kind: "tbf" }),
  line("clock", START + NS, { step }),
  line("done", START + NS, { sends: 6, dropped: drops }),
];

const egressRun = (datagrams = CLEAN, changes: Partial<Run> = {}, first = ready(), step = 0): Run => {
  const drops = datagrams.filter((each) => each[3] === "ENOBUFS").length;
  return runOf([first, ...linesOf(datagrams), ...ends(datagrams.length - drops, drops, step)], changes);
};

describe("the reading of an egress cell", () => {
  it("reads the arrival and the departure of each datagram from the first arrival of its burst", () => {
    const read = measure(cellOf(TBF), egressRun());
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(read.egress?.kind).toBe("tbf");
    expect(read.egress?.counts).toEqual({ packets: 5, drops: 1 });
    expect(read.egress?.packets.map((packet) => packet.outcome)).toEqual(["sent", "sent", "sent", "sent", "dropped", "sent"]);
    expect(read.egress?.packets[3]).toMatchObject({ arrived: s(0.00006), left: s(0.0081) });
    expect(read.egress?.packets[5]).toMatchObject({ arrived: s(0), left: s(0.00001) });
    expect(read.egress?.starts).toEqual([s(0), s(0.0302)]);
    expect(read.egress?.spreads).toEqual([s(0.00008), s(0)]);
  });

  it("names a datagram that leaves outside its band, a drop that the law sends, and a send that the law drops", () => {
    const late = CLEAN.map((each, key): Datagram => (key === 3 ? [0, 0.06, 12, null] : each));
    expect(measure(cellOf(TBF), egressRun(late)).finding).toMatch(
      /1 of the 6 datagrams are outside the law: the datagram 3 left at 0.012 s, outside \[0.007, 0.01\] s/,
    );
    const swapped = CLEAN.map((each, key): Datagram => (key === 3 ? [0, 0.06, null, "ENOBUFS"] : key === 4 ? [0, 0.08, 8.1, null] : each));
    const found = measure(cellOf(TBF), egressRun(swapped)).finding;
    expect(found).toMatch(/the qdisc dropped the datagram 3, and the law leaves in \[0.007, 0.01\] s/);
    expect(found).toMatch(/the datagram 4 left at 0.0081 s, and the law drops it at the limit/);
  });

  it("does not judge a datagram that the qdisc took with no stamp of its departure", () => {
    const unread = CLEAN.map((each, key): Datagram => (key === 0 ? [0, 0, null, null] : each));
    const read = measure(cellOf({ ...TBF, read: 0.5 }), egressRun(unread));
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(read.egress?.packets[0]?.outcome).toBe("unread");
    expect(measure(cellOf(TBF), egressRun(unread)).void).toMatch(/the judge read the departure of 4 of the 5 datagrams that the qdisc took, less than 90%/);
  });

  it("voids a run with an error, no end, another qdisc or a neighbour that is not permanent", () => {
    const cell = cellOf(TBF);
    expect(measure(cell, runOf([line("error", 1, { what: "tc qdisc replace: Operation not permitted" })])).void).toBe(
      "the client stopped: tc qdisc replace: Operation not permitted",
    );
    expect(measure(cell, runOf([ready(), ...linesOf(CLEAN)])).void).toBe("the client did not reach its end");
    expect(measure(cell, egressRun(CLEAN, {}, ready({ qdisc: { kind: "netem", root: true } }))).void).toBe(
      "tc reads a root qdisc of the kind netem, not tbf",
    );
    expect(measure(cell, egressRun(CLEAN, {}, ready({ neighbour: { lladdr: "02:42:0a:00:00:02", state: ["REACHABLE"] } }))).void).toMatch(
      /the neighbour of the target is \["REACHABLE"\], not PERMANENT/,
    );
  });

  it("voids a run whose sends, stamps, counts or clock the law cannot judge", () => {
    const cell = cellOf(TBF);
    expect(measure(cell, egressRun(CLEAN.slice(0, 5))).void).toBe("the client sent 5 datagrams, and the law has 6");
    const refused = CLEAN.map((each, key): Datagram => (key === 2 ? [0, 0.04, null, "EPERM"] : each));
    expect(measure(cell, egressRun(refused)).void).toBe("the send of the datagram 2 failed with EPERM");
    const unstamped = [ready(), ...linesOf(CLEAN).map((each) => (each["key"] === 1 ? { ...each, sched: null } : each)), ...ends(5, 1)];
    expect(measure(cell, runOf(unstamped)).void).toBe("the datagram 1 has no stamp of its arrival in the qdisc");
    const other = [ready(), ...linesOf(CLEAN), ...ends(6, 1)];
    expect(measure(cell, runOf(other)).void).toMatch(/the qdisc counts 6 packets and 1 drops, and the client counts 5 sends and 1 drops: other traffic/);
    expect(measure(cell, egressRun(CLEAN, {}, ready(), 250_000)).void).toBe("CLOCK_REALTIME stepped 250 µs in the run, more than 100 µs");
  });

  it("voids a run whose burst spreads wider than the law, or starts off its time", () => {
    const cell = cellOf(TBF);
    const wide = CLEAN.map((each, key): Datagram => (key === 4 ? [0, 0.9, null, "ENOBUFS"] : each));
    expect(measure(cell, egressRun(wide)).void).toBe("the arrivals of the burst 0 spread 0.0009 s, more than 0.0005 s");
    const late = CLEAN.map((each, key): Datagram => (key === 5 ? [1, 33, 33.01, null] : each));
    expect(measure(cell, egressRun(late)).void).toBe("the burst 1 started 0.033 s after the first, more than 0.002 s off 0.03 s");
  });

  it("gives the verdict of the egress qdisc", () => {
    const cell = cellOf(TBF);
    const clean = [0, 1, 2, 3].map((index) => measure(cell, egressRun(CLEAN, { index })));
    const holds = verdictOf(cell.prediction, clean);
    expect(holds.decision).toBe("holds");
    expect(holds.why).toMatch(/4 of 4 runs hold the law of the egress qdisc/);
    const late = CLEAN.map((each, key): Datagram => (key === 3 ? [0, 0.06, 12, null] : each));
    const off = [...clean.slice(0, 3), measure(cell, egressRun(late, { index: 3 }))];
    expect(verdictOf(cell.prediction, off).decision).toBe("fails");
  });
});
