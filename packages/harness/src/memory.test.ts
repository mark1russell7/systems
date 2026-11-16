import { describe, expect, it } from "vitest";
import type { Cell, KernelRecord, MemoryOomPrediction, MemoryPrediction, MemoryThrottlePrediction, ProbeEvent, Run } from "./cell.ts";
import { stepBand } from "./memory.ts";
import { measure } from "./observe.ts";
import { verdictOf } from "./verdict.ts";

const NS = 1_000_000_000;
const PAGE = 4096;
const s = (value: number) => ({ value, unit: "s" });
const band = (low: number, high: number) => ({ low: s(low), high: s(high) });

const cellOf = (memory: MemoryPrediction): Cell =>
  ({
    name: "MEM.test",
    target: { image: "x", port: 6392, ready: "listening", lines: true },
    sysctls: {},
    client: { image: "x", command: [] },
    probe: { mode: "idle", keepalive: false },
    fault: "none",
    prediction: { detects: null, window: s(360), why: "the law", memory },
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

// a high of 1000 pages, no max, and no swap
const THROTTLE: MemoryThrottlePrediction = {
  kind: "throttle",
  limits: { high: 1000, max: null, swap: 0, page: PAGE },
  hz: 1000,
  batch: 64,
  until: 1344,
  sleepFrom: 1024,
  capFrom: 1344,
  drift: 16,
  quiet: band(0, 0.02),
  steps: [
    { usage: 1024, band: band(0, 0.02), high: 1 },
    { usage: 1088, band: band(0.01, 0.04), high: 17 },
    { usage: 1152, band: band(0.05, 0.08), high: 17 },
    { usage: 1216, band: band(0.15, 0.2), high: 17 },
    { usage: 1280, band: band(0.4, 0.45), high: 17 },
    { usage: 1344, band: band(2, 2.03), high: 17 },
  ],
  read: 0.9,
};

const EVENTS = { low: 0, high: 0, max: 0, oom: 0, oom_kill: 0, oom_group_kill: 0 };
const ready = (fields: Record<string, unknown> = {}) =>
  line("ready", 1 * NS, { high: String(1000 * PAGE), max: "max", swap: "0", current: 832, events: EVENTS, page: PAGE, cpu: 3, locked: true, ...fields });

// each step: its usage after the touch, its time in seconds, and the count of the event high after it
const GROWTH: readonly (readonly [number, number, number])[] = [
  [896, 0.0004, 0],
  [960, 0.0004, 0],
  [1024, 0.001, 1],
  [1088, 0.02, 18],
  [1152, 0.06, 35],
  [1216, 0.17, 52],
  [1280, 0.42, 69],
  [1344, 2.01, 86],
];

const stepsOf = (growth: readonly (readonly [number, number, number])[]): ProbeEvent[] =>
  growth.map(([current, time, high], n) => line("step", (2 + n) * NS, { n, ns: Math.round(time * NS), current, high }));

const ends = (high: number, some: number | null): ProbeEvent[] => [
  line("pressure", 20 * NS, { some, full: some }),
  line("events", 20 * NS, { ...EVENTS, high }),
  line("done", 20 * NS, { touched: 512 }),
];

const growthRun = (growth = GROWTH, some: number | null = 2_700_000, changes: Partial<Run> = {}, first = ready()): Run =>
  runOf([first, ...stepsOf(growth), ...ends(growth.at(-1)?.[2] ?? 0, some)], changes);

describe("the band of a step of growth", () => {
  it("gives the quiet band below memory.high, with no event high", () => {
    expect(stepBand(THROTTLE, 960)).toEqual({ band: THROTTLE.quiet, high: { low: 0, high: 0 } });
  });

  it("spans from the entry at or below the usage to the entry at or above the usage and its drift", () => {
    expect(stepBand(THROTTLE, 1088)).toEqual({ band: band(0.01, 0.08), high: { low: 17, high: 17 } });
    expect(stepBand(THROTTLE, 1100)).toEqual({ band: band(0.01, 0.08), high: { low: 17, high: 17 } });
  });

  it("gives the quiet low and the first entry above, for a step whose drift crosses memory.high", () => {
    expect(stepBand(THROTTLE, 990)).toEqual({ band: band(0, 0.02), high: { low: 0, high: 1 } });
  });

  it("keeps the cap above the last entry", () => {
    expect(stepBand(THROTTLE, 1400)).toEqual({ band: band(2, 2.03), high: { low: 17, high: 17 } });
  });
});

describe("the reading of a throttle cell", () => {
  it("reads each step of a growth that keeps the law", () => {
    const read = measure(cellOf(THROTTLE), growthRun(GROWTH, 2_700_000, { hz: 1000 }));
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(read.memory?.start).toBe(832);
    expect(read.memory?.steps).toHaveLength(8);
    expect(read.memory?.steps.every((step) => step.read)).toBe(true);
    expect(read.memory?.steps.at(-1)).toMatchObject({ usage: 1344, high: 17, time: s(2.01) });
    expect(read.memory?.events["high"]).toBe(86);
    expect(read.memory).toMatchObject({ stall: s(2.7) });
  });

  it("names a step outside its band, and a step with another count of events high", () => {
    const slow = GROWTH.map((step) => (step[0] === 1152 ? ([1152, 0.3, 35] as const) : step));
    expect(measure(cellOf(THROTTLE), growthRun(slow)).finding).toMatch(/1 terms of the steps are outside the law: the step to 1152 pages took 0.3 s, outside \[0.05, 0.2\] s/);
    const more = GROWTH.map((step) => (step[0] >= 1152 ? ([step[0], step[1], step[2] + 4] as const) : step));
    expect(measure(cellOf(THROTTLE), growthRun(more)).finding).toMatch(/the step to 1152 pages added 21 events high, not 17/);
  });

  it("names a pressure that counts less stall than the sleeps", () => {
    expect(measure(cellOf(THROTTLE), growthRun(GROWTH, 1_000_000)).finding).toMatch(/memory.pressure counts a stall of 1 s, less than the 2.61 s of the sleeps/);
    expect(measure(cellOf(THROTTLE), growthRun(GROWTH, null)).finding).toBeNull();
  });

  it("does not read a step whose usage did not rise by one batch", () => {
    // a reclaim freed 40 pages in the step to 1112
    const reclaimed: readonly (readonly [number, number, number])[] = [
      ...GROWTH.slice(0, 4),
      [1112, 0.03, 18],
      [1176, 0.06, 35],
      [1240, 0.17, 52],
      [1304, 0.42, 69],
      [1368, 2.01, 86],
    ];
    const read = measure(cellOf(THROTTLE), growthRun(reclaimed));
    expect(read.memory?.steps[4]?.read).toBe(false);
    expect(read.void).toMatch(/the judge read 6 of the 7 steps above memory.high, less than 90%/);
  });

  it("voids a run that cannot decide", () => {
    const cell = cellOf(THROTTLE);
    const error = runOf([ready(), line("error", 2 * NS, { what: "memory.current: No such file or directory" })]);
    expect(measure(cell, error).void).toBe("the client stopped: memory.current: No such file or directory");
    expect(measure(cell, runOf([line("done", 2 * NS)])).void).toBe("the client wrote no ready line");
    expect(measure(cell, runOf([ready(), ...stepsOf(GROWTH)])).void).toBe("the client did not reach its end");
    const deadline = runOf([ready(), ...stepsOf(GROWTH.slice(0, 3)), line("deadline", 9 * NS, { wait: "growth", current: 1024 })]);
    expect(measure(cell, deadline).void).toBe("the client reached its deadline in the wait for the growth");
    expect(measure(cell, growthRun(GROWTH, 2_700_000, {}, ready({ high: "max" }))).void).toBe("memory.high reads max, not 4096000");
    expect(measure(cell, growthRun(GROWTH, 2_700_000, {}, ready({ swap: "max" }))).void).toBe("memory.swap.max reads max, not 0");
    expect(measure(cell, growthRun(GROWTH, 2_700_000, {}, ready({ page: 16384 }))).void).toBe("the page is 16384 bytes, not 4096");
    expect(measure(cell, growthRun(GROWTH, 2_700_000, {}, ready({ locked: false }))).void).toMatch(/did not lock its pages.*IPC_LOCK/);
    expect(measure(cell, growthRun(GROWTH, 2_700_000, { hz: 250 })).void).toBe("the kernel runs at HZ 250, and the bands are for HZ 1000");
    expect(measure(cell, growthRun(GROWTH.slice(0, 7))).void).toBe("the growth ended at 1280 pages, below 1344");
    expect(measure(cell, growthRun(GROWTH.slice(0, 2))).void).toMatch(/the judge read 0 of the 0 steps above memory.high/);
    expect(measure(cell, { ...growthRun(), missing: "no cgroup" }).void).toBe("the environment cannot do this cell: no cgroup");
  });

  it("gives the verdict of the memory limit", () => {
    const cell = cellOf(THROTTLE);
    const clean = [0, 1, 2, 3].map((index) => measure(cell, growthRun(GROWTH, 2_700_000, { index })));
    const holds = verdictOf(cell.prediction, clean);
    expect(holds.decision).toBe("holds");
    expect(holds.why).toMatch(/4 of 4 runs hold the law of the memory limit/);
    const slow = GROWTH.map((step) => (step[0] === 1344 ? ([1344, 4, 86] as const) : step));
    const off = [...clean.slice(0, 3), measure(cell, growthRun(slow, 2_700_000, { index: 3 }))];
    expect(verdictOf(cell.prediction, off).decision).toBe("fails");
  });
});

// a max of 51,200 pages: the task with the most pages and the highest adj is the victim
const OOM: MemoryOomPrediction = {
  kind: "oom",
  limits: { high: null, max: 51_200, swap: 0, page: PAGE },
  tasks: [
    { name: "a", pages: 20_000, adj: 0, outcome: "held" },
    { name: "b", pages: 20_000, adj: 500, outcome: "killed" },
    { name: "c", pages: 20_000, adj: 0, outcome: "held" },
  ],
  kills: 1,
};

const oomReady = (fields: Record<string, unknown> = {}) =>
  line("ready", 1 * NS, { high: "max", max: String(51_200 * PAGE), swap: "0", current: 300, events: EVENTS, page: PAGE, ...fields });
const task = (name: string, outcome: string, signal: number | null) => line("task", 5 * NS, { name, pid: 100, outcome, signal, code: null });
const oomRun = (tasks: readonly ProbeEvent[], kills = 1, first = oomReady()): Run =>
  runOf([first, ...tasks, line("events", 6 * NS, { ...EVENTS, oom: kills, oom_kill: kills }), line("done", 6 * NS)]);
const KEPT = [task("a", "held", null), task("b", "killed", 9), task("c", "held", null)];

describe("the reading of an OOM cell", () => {
  it("reads the victim of the OOM killer and the count of its kills", () => {
    const read = measure(cellOf(OOM), oomRun(KEPT));
    expect(read.void).toBeNull();
    expect(read.finding).toBeNull();
    expect(read.memory?.tasks).toEqual([
      { name: "a", outcome: "held", signal: null },
      { name: "b", outcome: "killed", signal: 9 },
      { name: "c", outcome: "held", signal: null },
    ]);
    expect(read.memory?.events["oom_kill"]).toBe(1);
  });

  it("names another victim, another signal, a task with no end, and another count of kills", () => {
    const other = [task("a", "killed", 9), task("b", "held", null), task("c", "held", null)];
    expect(measure(cellOf(OOM), oomRun(other)).finding).toBe("the task a was killed, not held. the task b was held, not killed");
    const term = [task("a", "held", null), task("b", "killed", 15), task("c", "held", null)];
    expect(measure(cellOf(OOM), oomRun(term)).finding).toBe("the task b ended by the signal 15, not SIGKILL");
    expect(measure(cellOf(OOM), oomRun(KEPT.slice(0, 2))).finding).toBe("the task c wrote no end");
    expect(measure(cellOf(OOM), oomRun(KEPT, 2)).finding).toBe("the cgroup counts 2 OOM kills, not 1");
  });

  it("voids a run whose cgroup reads another max, and does not ask an OOM run for HZ or a lock", () => {
    expect(measure(cellOf(OOM), oomRun(KEPT, 1, oomReady({ max: "max" }))).void).toBe("memory.max reads max, not 209715200");
    expect(measure(cellOf(OOM), { ...oomRun(KEPT), hz: 250 }).void).toBeNull();
    expect(measure(cellOf(OOM), oomRun(KEPT, 1, oomReady({ locked: false }))).void).toBeNull();
  });
});
