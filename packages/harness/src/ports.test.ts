import { describe, expect, it } from "vitest";
import type { Cell, KernelRecord, PortsPrediction, ProbeEvent, Run } from "./cell.ts";
import { measure } from "./observe.ts";
import { verdictOf } from "./verdict.ts";

const NS = 1_000_000_000;
const s = (value: number) => ({ value, unit: "s" });
const CLIENT = 11;

const cellOf = (ports: PortsPrediction): Cell =>
  ({
    name: "PR.test",
    target: { image: "x", port: 6392, ready: "listening", lines: true },
    sysctls: {},
    client: { image: "x", command: [] },
    probe: { mode: "idle", keepalive: false },
    fault: "none",
    prediction: { detects: null, window: s(10), why: "the law", ports },
    runs: 4,
    environments: 2,
  }) as Cell;

const line = (ev: string, t: number, fields: Record<string, unknown> = {}): ProbeEvent => ({ ev, t, ...fields });

const round = (index: number, ports: readonly number[], errno = "EADDRNOTAVAIL", refusal = 20_000): ProbeEvent =>
  line("round", (2 + index) * NS, { index, destination: 6392, ports, errno, refusal });

const runOf = (events: readonly ProbeEvent[], changes: Partial<Run> = {}): Run =>
  ({
    environment: 0,
    index: 0,
    events: [line("ready", 1 * NS), ...events, line("done", 90 * NS)],
    fault: null,
    kernel: [] as KernelRecord[],
    netns: CLIENT,
    targetNetns: 22,
    lost: 0,
    server: [],
    ...changes,
  }) as Run;

const LAW: PortsPrediction = {
  low: 40000,
  size: 4,
  rounds: 2,
  destinations: 1,
  counts: [4],
  seen: [0, 1, 2, 3],
  refusedWithin: s(0.1),
};

const CLEAN = [round(0, [40000, 40002, 40001, 40003]), round(1, [40002, 40000, 40003, 40001])];

describe("the reading of a port cell", () => {
  it("reads each search of a run that holds the law", () => {
    const read = measure(cellOf(LAW), runOf(CLEAN));
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(read.ports).toMatchObject({ rounds: 2, counts: { "4": 2 }, seen: [0, 1, 2, 3], errnos: ["EADDRNOTAVAIL"] });
  });

  it("voids a run with no end or with a dropped record", () => {
    const run = runOf(CLEAN);
    expect(measure(cellOf(LAW), { ...run, events: CLEAN }).void).toMatch(/end/);
    expect(measure(cellOf(LAW), { ...run, lost: 2 }).void).toMatch(/dropped 2/);
    expect(measure(cellOf(LAW), { ...run, lost: null }).void).toMatch(/clock line/);
  });

  it("finds a count outside the law, a port outside it, another errno and a slow refusal", () => {
    expect(measure(cellOf(LAW), runOf([round(0, [40000, 40002, 40001]), CLEAN[1]!])).finding).toMatch(/gave 3 connects/);
    expect(measure(cellOf({ ...LAW, seen: [0, 1, 2] }), runOf(CLEAN)).finding).toMatch(/offsets 0 1 2 3/);
    expect(measure(cellOf(LAW), runOf([round(0, [40000, 40002, 40001, 40003], "ETIMEDOUT"), CLEAN[1]!])).finding).toMatch(/ETIMEDOUT/);
    expect(measure(cellOf(LAW), runOf([round(0, [40000, 40002, 40001, 40003], "EADDRNOTAVAIL", 2 * NS), CLEAN[1]!])).finding).toMatch(/took 2 s/);
    expect(measure(cellOf(LAW), runOf(CLEAN.slice(0, 1))).finding).toMatch(/1 searches, not 2/);
  });

  it("reads the share of a count against its band", () => {
    const law = { ...LAW, counts: [3, 4], share: { count: 4, low: 0.4, high: 0.6 } };
    const half = [round(0, [40000, 40002, 40001]), CLEAN[1]!];
    expect(measure(cellOf(law), runOf(half)).finding).toBeNull();
    expect(measure(cellOf(law), runOf(CLEAN)).finding).toMatch(/share of 4 connects is 1/);
  });

  it("reads the parity of each search, for a law that names it", () => {
    const law = { ...LAW, lowFirst: true };
    expect(measure(cellOf(law), runOf(CLEAN)).finding).toBeNull();
    expect(measure(cellOf(law), runOf([round(0, [40000, 40001, 40002, 40003]), CLEAN[1]!])).finding).toMatch(/other parity/);
  });

  it("counts the retransmissions of the client only", () => {
    const law = { ...LAW, retransmissions: 0 };
    const sent = [
      { ev: "retrans", mono: 1, netns: CLIENT },
      { ev: "retrans", mono: 2, netns: 22 },
    ] as KernelRecord[];
    expect(measure(cellOf(law), runOf(CLEAN, { kernel: sent })).finding).toMatch(/1 retransmissions, not 0/);
  });

  describe("when each held port comes back", () => {
    const law = { ...LAW, rounds: 1, freed: { low: s(60), high: s(64) } };
    const closing = [round(0, [40000, 40002, 40001, 40003]), line("closing", 3 * NS)];
    const freed = (at: number, tries: number) => line("freed", (3 + at) * NS, { port: 40000, tries });

    it("holds with each port inside the band, after a refused connect", () => {
      const read = measure(cellOf(law), runOf([...closing, freed(61, 6000), freed(61, 6000), freed(62, 6100), freed(62, 6100)]));
      expect(read.finding).toBeNull();
      expect(read.ports).toMatchObject({ firstFreed: s(61), lastFreed: s(62), freed: 4, tries: 6100 });
    });

    it("finds a port that came back outside the band", () => {
      const early = measure(cellOf(law), runOf([...closing, freed(1, 100), freed(61, 6000), freed(61, 6000), freed(61, 6000)]));
      expect(early.finding).toMatch(/first port came back at 1 s/);
    });

    it("finds a run with a port that did not come back", () => {
      expect(measure(cellOf(law), runOf([...closing, freed(61, 6000)])).finding).toMatch(/1 ports came back, not 4/);
    });

    it("finds a run with no refused connect", () => {
      const read = measure(cellOf(law), runOf([...closing, freed(61, 0), freed(61, 0), freed(61, 0), freed(61, 0)]));
      expect(read.finding).toMatch(/no connect was refused/);
    });
  });
});

describe("the decision of a port cell", () => {
  const cell = cellOf(LAW);
  const runs = (count: number) => Array.from({ length: count }, (_, index) => measure(cell, runOf(CLEAN, { index })));

  it("holds if each counted run holds", () => {
    const verdict = verdictOf(cell.prediction, runs(4));
    expect(verdict.decision).toBe("holds");
    expect(verdict.why).toMatch(/4 of 4 runs hold the law of the port range/);
  });

  it("fails if one run is outside", () => {
    const off = [...runs(3), measure(cell, runOf([round(0, [40000]), CLEAN[1]!], { index: 3 }))];
    expect(verdictOf(cell.prediction, off).decision).toBe("fails");
  });
});
