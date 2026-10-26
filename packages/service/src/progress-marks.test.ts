import { describe, expect, it } from "vitest";
import type { Check, Finding, Poll, ServiceBuilder, ServiceDescription, WorkerKnobs } from "./index.ts";
import { PROGRESS_RULE, lint, service, workerLoop } from "./index.ts";
import type { Result } from "./latch.ts";
import { poller } from "./poller.ts";
import { detachedLifecycle, fakeClock } from "./testing.ts";

/**
 * SYS-24: a check of the step `progress` names the loops that mark it (`marks`), and `lint()`
 * compares its stall time with the longest gap between two marks of its slowest loop. The fake
 * clock runs a poller and a worker loop at their worst jitter, and the longest gap that they show
 * is the gap that the rule reads.
 */

const s = (value: number) => ({ value, unit: "s" });
const count = (value: number) => ({ value, unit: "count" });
const SCENARIO = { platform: {}, probes: { readiness: s(10), liveness: s(30) } };
/** This random number is the top of the jitter: the poller and the backoff take it as close to 1. */
const TOP = () => 1 - 1e-9;

const WEATHER_POLL: Poll = { interval: s(300), jitter: 0.2, timeout: s(10) };
const SYNC: WorkerKnobs = {
  worker_sleep: s(60),
  unit_processing_time: s(10),
  retry_base: s(5),
  retry_cap: s(120),
  close_bound: s(2),
  concurrency: count(1),
};

const weather: Check = {
  name: "weather.round-trip",
  dependency: null,
  step: "round-trip",
  ownConnection: true,
  gates: null,
  poll: WEATHER_POLL,
};
const progress = (marks?: Check["marks"]): Check => ({
  name: "process.progress",
  dependency: null,
  step: "progress",
  ownConnection: true,
  gates: "liveness",
  poll: { interval: s(5), jitter: 0, timeout: s(1) },
  ...(marks === undefined ? {} : { marks }),
});

/** This function declares a service with a report-only poll, a worker and a progress check. */
const declared = (marks?: Check["marks"], knobs: WorkerKnobs = SYNC): ServiceBuilder =>
  service("app")
    .check(weather)
    .worker("sync", knobs)
    .consumer("jobs", { queue_poll_interval: s(2), unit_processing_time: s(10) })
    .check(progress(marks))
    .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(45) })
    .startup(s(60))
    .phase("stop intake", s(1))
    .phase("drain", s(10))
    .phase("close transports", s(3))
    .cooperativeWindow(s(5))
    .onRepeatSignal("ignore");

const progressOf = (description: ServiceDescription): Finding[] =>
  lint(description, SCENARIO, []).filter((finding) => finding.rule === PROGRESS_RULE);

describe("lint() compares the stall time of a progress check with its loops (SYS-24)", () => {
  it("finds a stall time below the gap of a poll: 300 s ± 20 % and a 10 s timeout give 370 s", () => {
    const [short, ...rest] = progressOf(declared({ loops: ["weather.round-trip"], stall: s(369) }).describe());
    expect(rest).toEqual([]);
    expect(short).toMatchObject({ rule: "progress", scope: "process.progress", verdict: "violated", unbound: [] });
    expect(short!.evaluated).toEqual([{ lhs: 369, rhs: 370, margin: 0, holds: false }]);
    expect(short!.statement).toContain("(weather.round-trip)");
  });

  it("finds no fault in a stall time that is the gap of the poll, or longer", () => {
    for (const stall of [370, 400]) {
      const findings = progressOf(declared({ loops: ["weather.round-trip"], stall: s(stall) }).describe());
      expect(findings.map((finding) => finding.verdict)).toEqual(["holds"]);
    }
  });

  it("reads a worker: its longest backoff, 120 s plus a jitter up to 5 s, then a 10 s iteration", () => {
    const short = progressOf(declared({ loops: ["sync"], stall: s(134) }).describe());
    expect(short.map((finding) => [finding.verdict, finding.evaluated])).toEqual([
      ["violated", [{ lhs: 134, rhs: 135, margin: 0, holds: false }]],
    ]);
    expect(progressOf(declared({ loops: ["sync"], stall: s(135) }).describe()).map((finding) => finding.verdict)).toEqual(["holds"]);
    // a sleep longer than the backoff is the longer wait
    const sleepy = progressOf(declared({ loops: ["sync"], stall: s(135) }, { ...SYNC, worker_sleep: s(600) }).describe());
    expect(sleepy[0]!.evaluated[0]).toMatchObject({ rhs: 610, holds: false });
  });

  it("uses the slowest loop that the check names", () => {
    const [finding] = progressOf(declared({ loops: ["sync", "weather.round-trip"], stall: s(200) }).describe());
    expect(finding).toMatchObject({ verdict: "violated", evaluated: [{ lhs: 200, rhs: 370, holds: false }] });
    expect(finding!.statement).toContain("(weather.round-trip)");
  });

  it("finds a worker that waits for wake() without a bound: no stall time is long enough", () => {
    const [finding] = progressOf(declared({ loops: ["sync"], stall: s(3600) }, { ...SYNC, worker_sleep: { value: "infinite", unit: "s" } }).describe());
    expect(finding).toMatchObject({ verdict: "violated", evaluated: [{ lhs: 3600, rhs: Infinity, holds: false }] });
  });

  it("finds a name that is not a check or a worker of the service, and still compares the others", () => {
    const findings = progressOf(declared({ loops: ["weather.round-trip", "nightly"], stall: s(400) }).describe());
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ rule: "progress", scope: "process.progress", verdict: "depends", evaluated: [], unbound: ["nightly"] });
    expect(findings[0]!.window).toContain("nightly");
    expect(findings[1]).toMatchObject({ verdict: "holds" });
    // a consumer is not a loop with a cadence
    const only = progressOf(declared({ loops: ["jobs"], stall: s(400) }).describe());
    expect(only.map((finding) => finding.unbound)).toEqual([["jobs"]]);
  });

  it("names the knobs of a worker that a description does not give", () => {
    const description = declared({ loops: ["sync"], stall: s(400) }).describe();
    const old: ServiceDescription = {
      ...description,
      transports: description.transports.map((transport) => ({ ...transport, knobs: { worker_sleep: s(60) } })),
    };
    const [finding] = progressOf(old);
    expect(finding).toMatchObject({ verdict: "depends", unbound: ["sync.unit_processing_time", "sync.retry_base", "sync.retry_cap"] });
  });

  it("gives no new finding without marks, as before", () => {
    const description = declared().describe();
    expect(description.checks.find((check) => check.name === "process.progress")).not.toHaveProperty("marks");
    expect(progressOf(description)).toEqual([]);
    expect(lint(description, SCENARIO, [])).toEqual([]);
  });

  it("exports the marks as data, and describe() refuses marks that cannot apply", () => {
    const marks = { loops: ["sync"], stall: s(135) };
    const description = declared(marks).describe();
    expect(description.checks.find((check) => check.name === "process.progress")?.marks).toEqual(marks);
    expect(description.checks.find((check) => check.name === "process.progress")?.marks).not.toBe(marks);
    expect(() => declared({ loops: [], stall: s(135) }).describe()).toThrow("check process.progress names no loop that marks it");
    expect(() => declared({ loops: ["sync"], stall: s(0) }).describe()).toThrow("not a time above zero");
    const wrongStep = service("app").check({ ...weather, marks }).readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 });
    expect(() =>
      wrongStep
        .liveness({ type: "window", failAfter: s(45) })
        .startup(s(60))
        .phase("drain", s(10))
        .cooperativeWindow(s(5))
        .onRepeatSignal("ignore")
        .describe(),
    ).toThrow("its step is round-trip, not progress");
  });
});

describe("the gap that the rule reads is the longest gap of the runtime, on the fake clock", () => {
  /** This function gives the longest time between two marks. */
  const longest = (marks: readonly number[]): number =>
    marks.slice(1).reduce((worst, at, index) => Math.max(worst, at - marks[index]!), 0);

  it("a poller at its top jitter: a poll that answers at once, then one that ends at its timeout", async () => {
    const clock = fakeClock();
    const marks: number[] = [];
    let calls = 0;
    const loop = poller({
      name: "weather.round-trip",
      poll: WEATHER_POLL,
      // each second call answers after its timeout: the poll ends at the timeout, and the call ends before the next poll
      run: () => (calls++ % 2 === 0 ? "ok" : new Promise<"ok">((resolve) => clock.after(10_001, () => resolve("ok")))),
      clock,
      random: TOP,
      forced: () => false,
      // the loop marks at the end of each turn, also a turn that fails
      record: (result: Result) => marks.push(result.at),
    });
    loop.start(0);
    for (let step = 0; step < 8; step += 1) await clock.advance(400_000);
    loop.stop();
    const [finding] = progressOf(declared({ loops: ["weather.round-trip"], stall: s(370) }).describe());
    const rule = finding!.evaluated[0]!.rhs! * 1000;
    expect(marks.length).toBeGreaterThan(6);
    expect(longest(marks)).toBeLessThanOrEqual(rule);
    expect(longest(marks)).toBeGreaterThan(rule - 1);
  });

  it("a worker lane at its top jitter: each iteration fails at its bound, and the backoff grows to its cap", async () => {
    const clock = fakeClock();
    const marks: number[] = [];
    const loop = workerLoop(SYNC, {
      clock,
      random: TOP,
      iteration: async ({ signal }) => {
        try {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("stuck");
        } finally {
          marks.push(clock.now());
        }
      },
    });
    await loop.start(new AbortController().signal, detachedLifecycle());
    for (let step = 0; step < 40; step += 1) await clock.advance(60_000);
    loop.stopIntake();
    await loop.close();
    const [finding] = progressOf(declared({ loops: ["sync"], stall: s(135) }).describe());
    const rule = finding!.evaluated[0]!.rhs! * 1000;
    expect(marks.length).toBeGreaterThan(10);
    expect(longest(marks)).toBeLessThanOrEqual(rule);
    expect(longest(marks)).toBeGreaterThan(rule - 1);
  });
});
