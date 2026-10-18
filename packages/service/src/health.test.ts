import { describe, expect, it } from "vitest";
import type { Check, Coupling, Poll, ServiceBuilder, Timing } from "./index.ts";
import { service } from "./index.ts";
import type { FakeClock, ScriptedCheck } from "./testing.ts";
import { fakeClock, scriptedCheck, seeded } from "./testing.ts";

const s = (value: number) => ({ value, unit: "s" });
const POLL: Poll = { interval: s(5), jitter: 0.2, timeout: s(4) };
const LATCH: Timing = { type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 };
const WEDGE: Timing = { type: "window", failAfter: s(45) };

const check = (name: string, gates: Check["gates"], dependency: string | null = null, poll = POLL): Check => ({
  name,
  dependency,
  step: "round-trip",
  ownConnection: true,
  gates,
  poll,
});

/** a service with a readiness check on db, a liveness check on the process, and the given couplings */
const app = (
  scripts: Record<string, ScriptedCheck>,
  couplings: readonly Coupling[] = [],
): ServiceBuilder => {
  const svc = service("app")
    .dependency("db", { system: null, knobs: {}, operations: {} })
    .dependency("cache", { system: null, knobs: {}, operations: {} })
    .check(check("db.round-trip", "readiness", "db"), scripts["db"]!.run)
    .check(check("cache.round-trip", "readiness", "cache"), scripts["cache"]!.run)
    .check(check("process.progress", "liveness"), scripts["process"]!.run)
    .check(check("weather.round-trip", null, null, { interval: s(30), jitter: 0.2, timeout: s(10) }), scripts["weather"]!.run)
    .readiness(LATCH)
    .liveness(WEDGE)
    .startup(s(60))
    .phase("drain", s(15))
    .onRepeatSignal("ignore")
    .cooperativeWindow(s(5));
  for (const coupling of couplings) svc.couple(coupling);
  svc.controller("api").requires("db");
  svc.controller("admin").requires("cache");
  return svc;
};

const scripts = (): Record<string, ScriptedCheck> => ({
  db: scriptedCheck(),
  cache: scriptedCheck(),
  process: scriptedCheck(),
  weather: scriptedCheck(),
});

const started = async (clock: FakeClock, couplings: readonly Coupling[] = []) => {
  const each = scripts();
  const svc = app(each, couplings);
  const health = await svc.start({ clock, random: seeded(42) });
  return { svc, health, each };
};

describe("the start: one warm-up sweep, then the loops (A2, B8)", () => {
  it("is not started, and fails its startup probe, until the sweep ends", async () => {
    const clock = fakeClock();
    const each = scripts();
    each["db"]!.behavior = "hang";
    const svc = app(each);
    const starting = svc.start({ clock });
    expect(svc.health?.probe("startup").status).toBe(503);
    expect(svc.health?.verdict().started).toBe(false);
    // the sweep is bounded: the hung check fails at its 4 s timeout
    await clock.advance(4000);
    const health = await starting;
    expect(health.verdict().started).toBe(true);
    expect(health.probe("startup").status).toBe(200);
    // and readiness, which starts tripped, waits for its first pass
    expect(health.verdict().ready).toBe(false);
    health.stop();
  });

  it("says when the sweep outlasts the startup budget", async () => {
    const clock = fakeClock();
    const each = scripts();
    each["process"]!.behavior = "hang";
    const svc = service("slow")
      .check(check("process.progress", "liveness", null, { interval: s(5), jitter: 0, timeout: s(4) }), each["process"]!.run)
      .readiness(LATCH)
      .liveness(WEDGE)
      .startup(s(2))
      .phase("drain", s(1))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    const starting = svc.start({ clock });
    await clock.advance(3000);
    expect(svc.health!.verdict().startup).toMatchObject({ overBudget: true, budget: 2000 });
    await clock.advance(1000);
    (await starting).stop();
  });

  it("refuses to start a check without its function, and a zero interval or count", async () => {
    await expect(
      service("bare")
        .check(check("x", "readiness"))
        .readiness(LATCH)
        .liveness(WEDGE)
        .startup(s(1))
        .phase("drain", s(1))
        .onRepeatSignal("ignore")
        .cooperativeWindow(s(1))
        .start(),
    ).rejects.toThrow(/check x has no function: the runtime has no defaults/);
    const zero = service("zero")
      .check(check("x", "readiness", null, { interval: s(0), jitter: 0, timeout: s(1) }), () => "ok")
      .readiness({ type: "debounce", interval: s(0), failAfter: 0, recoverAfter: 1 })
      .liveness(WEDGE)
      .startup(s(1))
      .phase("drain", s(1))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    expect(() => zero.describe()).toThrow(/debounce polls at an interval that is not above zero/);
    expect(() => zero.describe()).toThrow(/fails after 0 polls, not a whole number above zero/);
    expect(() => zero.describe()).toThrow(/check x polls with an interval or a timeout that is not above zero/);
  });

  it("refuses a debounce that counts the polls of a check at another interval", () => {
    const svc = service("mismatch")
      .check(check("x", "readiness", null, { interval: s(2), jitter: 0, timeout: s(1) }), () => "ok")
      .readiness(LATCH)
      .liveness(WEDGE)
      .startup(s(1))
      .phase("drain", s(1))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    expect(() => svc.describe()).toThrow(/check x polls every 2 s, but the readiness debounce counts polls every 5 s/);
  });
});

describe("the verdicts and the probes come from the cache (B1, B3, B18)", () => {
  it("answers each probe without a call of a check", async () => {
    const clock = fakeClock();
    const { health, each } = await started(clock);
    const calls = Object.values(each).map((script) => script.calls);
    for (let n = 0; n < 1000; n += 1) {
      health.probe("readiness");
      health.probe("liveness");
      health.probe("readiness", "api");
      health.probe("report");
    }
    expect(Object.values(each).map((script) => script.calls)).toEqual(calls);
    health.stop();
  });

  it("is ready and alive after the sweep, and the report is always 200 with the whole verdict", async () => {
    const clock = fakeClock();
    const { health } = await started(clock);
    expect(health.verdict()).toMatchObject({
      started: true,
      ready: true,
      alive: true,
      controllers: { api: true, admin: true },
      dependencies: { db: true, cache: true },
    });
    expect(health.probe("readiness")).toMatchObject({ status: 200, contentType: "application/health+json", body: { status: "pass" } });
    const report = health.probe("report");
    expect(report.status).toBe(200);
    expect(report.body.verdict?.checks["weather.round-trip"]).toMatchObject({ gates: null, tripped: null });
    expect(() => health.probe("readiness", "nope")).toThrow(/app has no controller nope/);
    health.stop();
  });

  it("fails one controller for its own dependency, and keeps the other (Mark's answer to question 2)", async () => {
    const clock = fakeClock();
    const { health, each } = await started(clock);
    each["cache"]!.behavior = "error";
    await clock.advance(20_000);
    const verdict = health.verdict();
    expect(verdict.controllers).toEqual({ api: true, admin: false });
    expect(verdict.dependencies).toEqual({ db: true, cache: false });
    // the pod's own readiness reads every readiness latch (B1)
    expect(verdict.ready).toBe(false);
    expect(health.probe("readiness", "api").status).toBe(200);
    expect(health.probe("readiness", "admin").status).toBe(503);
    health.stop();
  });

  it("keeps a signed streak and the cause of the last result", async () => {
    const clock = fakeClock();
    const { health, each } = await started(clock);
    each["db"]!.behavior = "throw";
    await clock.advance(20_000);
    const db = health.verdict().checks["db.round-trip"]!;
    expect(db.streak).toBeLessThanOrEqual(-3);
    expect(db.last).toMatchObject({ outcome: "error", thrown: true, cause: "the scripted check threw" });
    each["db"]!.behavior = "indeterminate";
    await clock.advance(20_000);
    // an indeterminate poll measured nothing: it moves no streak, and it does not recover the latch
    expect(health.verdict().checks["db.round-trip"]!.streak).toBe(db.streak);
    expect(health.verdict().checks["db.round-trip"]!.tripped).toBe(true);
    health.stop();
  });
});

describe("the edges", () => {
  it("does not trip on a flapping signal, and does not recover on one (debounce 3 to fail, 2 to recover)", async () => {
    const clock = fakeClock();
    const flapping = scriptedCheck("ok");
    let polls = 0;
    const svc = service("flap")
      .check(check("x", "liveness", null, { interval: s(5), jitter: 0, timeout: s(4) }), (signal) => {
        polls += 1;
        flapping.behavior = polls % 2 === 0 ? "error" : "ok";
        return flapping.run(signal);
      })
      .check(check("y", "readiness", null, { interval: s(5), jitter: 0, timeout: s(4) }), (signal) => {
        flapping.behavior = polls % 2 === 0 ? "ok" : "error";
        return flapping.run(signal);
      })
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 2 })
      .liveness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 2 })
      .startup(s(60))
      .phase("drain", s(1))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    const health = await svc.start({ clock });
    await clock.advance(600_000);
    // liveness starts released and never sees 3 failures in a row; readiness starts tripped and never sees 2 passes
    expect(health.verdict().alive).toBe(true);
    expect(health.verdict().checks["y"]!.tripped).toBe(true);
    health.stop();
  });

  it("fails a check that never answers by its timeout, and calls it again only after it ends (B5)", async () => {
    const clock = fakeClock();
    const { health, each } = await started(clock);
    each["db"]!.behavior = "hang";
    await clock.advance(60_000);
    expect(each["db"]!.hung).toBe(1);
    const db = health.verdict().checks["db.round-trip"]!;
    expect(db.tripped).toBe(true);
    expect(db.last?.cause).toMatch(/its call of \d+ ms ago is still pending/);
    const calls = each["db"]!.calls;
    await clock.advance(60_000);
    expect(each["db"]!.calls).toBe(calls);
    each["db"]!.behavior = "ok";
    each["db"]!.heal();
    await clock.advance(10_000);
    expect(health.verdict().checks["db.round-trip"]!.tripped).toBe(false);
    expect(each["db"]!.calls).toBeGreaterThan(calls);
    health.stop();
  });

  it("trips liveness after its window on a check that never answers, from the first failure (B9)", async () => {
    const clock = fakeClock();
    const { health, each } = await started(clock);
    each["process"]!.behavior = "hang";
    await clock.advance(44_000);
    expect(health.verdict().alive).toBe(true);
    await clock.advance(15_000);
    expect(health.verdict().alive).toBe(false);
    expect(health.probe("liveness").status).toBe(503);
    health.stop();
  });

  it("pulls readiness when a check joins late, until its first pass (B8)", async () => {
    const clock = fakeClock();
    const { svc, health } = await started(clock);
    const late = scriptedCheck("error");
    svc.check(check("db.checkout", "readiness", "db"), late.run);
    expect(svc.describe().partial).toBe(true);
    await clock.advance(1);
    expect(health.verdict().ready).toBe(false);
    late.behavior = "ok";
    await clock.advance(10_000);
    expect(health.verdict().ready).toBe(true);
    // a check that joins late needs its function: there is no default
    expect(() => svc.check(check("db.other", "readiness", "db"))).toThrow(/joins after the start, thus it needs its function/);
    health.stop();
  });

  it("starts a late dependency tripped, until a check on it passes", async () => {
    const clock = fakeClock();
    const { svc, health } = await started(clock);
    svc.dependency("queue", { system: null, knobs: {}, operations: {} });
    expect(health.verdict().dependencies["queue"]).toBe(false);
    expect(health.verdict().ready).toBe(false);
    const queue = scriptedCheck("ok");
    svc.check(check("queue.round-trip", null, "queue", { interval: s(30), jitter: 0, timeout: s(10) }), queue.run);
    await clock.advance(1);
    expect(health.verdict().dependencies["queue"]).toBe(true);
    expect(health.verdict().ready).toBe(true);
    health.stop();
  });

  it("fails readiness through a declared coupling when liveness fails, and not without it (B10)", async () => {
    for (const coupled of [true, false]) {
      const clock = fakeClock();
      const couplings: Coupling[] = coupled ? [{ from: "liveness", to: "readiness", effect: "fails" }] : [];
      const { health, each } = await started(clock, couplings);
      each["process"]!.behavior = "error";
      await clock.advance(60_000);
      const verdict = health.verdict();
      expect(verdict.alive).toBe(false);
      expect(verdict.ready).toBe(!coupled);
      expect(verdict.controllers["api"]).toBe(!coupled);
      health.stop();
    }
  });

  it("fails a named component on the force-fail list, and recovers when it leaves the list (F2)", async () => {
    const clock = fakeClock();
    const { health, each } = await started(clock);
    health.forceFail("db", true);
    const calls = each["db"]!.calls;
    await clock.advance(20_000);
    expect(health.verdict().checks["db.round-trip"]!.last).toMatchObject({ outcome: "error", forced: true });
    expect(health.verdict().controllers["api"]).toBe(false);
    // a forced poll does not call the check
    expect(each["db"]!.calls).toBe(calls);
    health.forceFail("db", false);
    await clock.advance(10_000);
    expect(health.verdict().controllers["api"]).toBe(true);
    health.stop();
  });

  it("fails readiness for good when it drains", async () => {
    const clock = fakeClock();
    const { health } = await started(clock);
    health.drain();
    await clock.advance(60_000);
    expect(health.verdict()).toMatchObject({ draining: true, ready: false, alive: true });
    expect(health.verdict().controllers).toEqual({ api: false, admin: false });
    health.stop();
  });

  it("leaves no timer after stop, and calls no check after it (A14)", async () => {
    const clock = fakeClock();
    const { health, each } = await started(clock);
    each["process"]!.behavior = "error";
    await clock.advance(7_000);
    health.stop();
    expect(clock.pending).toBe(0);
    const calls = Object.values(each).map((script) => script.calls);
    await clock.advance(600_000);
    expect(Object.values(each).map((script) => script.calls)).toEqual(calls);
  });

  it("polls on a jittered fixed delay from the start of each poll", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const svc = service("loop")
      .check(check("x", "liveness", null, { interval: s(5), jitter: 0.2, timeout: s(4) }), () => {
        starts.push(clock.now());
        // a slow check does not move the next poll
        return new Promise<"ok">((resolve) => clock.after(3000, () => resolve("ok")));
      })
      .readiness(LATCH)
      .liveness(WEDGE)
      .startup(s(60))
      .phase("drain", s(1))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    // the sweep waits for the slow check, which ends when the fake clock moves
    const starting = svc.start({ clock, random: seeded(7) });
    await clock.advance(3000);
    const health = await starting;
    await clock.advance(120_000);
    const gaps = starts.slice(1).map((at, n) => at - starts[n]!);
    expect(gaps.length).toBeGreaterThan(15);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(4000 - 1e-6);
      expect(gap).toBeLessThanOrEqual(6000 + 1e-6);
    }
    // the jitter moves the gaps: they are not all the same
    expect(new Set(gaps.map((gap) => Math.round(gap))).size).toBeGreaterThan(5);
    health.stop();
  });
});
