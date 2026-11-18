// The loop core (SYS-138) by example, on the fake clock: the machine document, the schedule and its three settings,
// each way of a lane from start and from end, the budget, the stop, the hold and the proof of a stream. Each case also
// replays its transitions on LOOP_MACHINE (law 7). The laws on random schedules are in `loop-laws.test.ts`.

import { algebraProblems, machineProblems } from "@mark1russell7/algebra";
import type { Transition } from "@mark1russell7/algebra/replay";
import { replay } from "@mark1russell7/algebra/replay";
import { machineSchema } from "@mark1russell7/algebra/schema";
import type { Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { backoffBand, doublingBackoff } from "./backoff.ts";
import { NO_JITTER, base, fail, ms, pass, rig, s } from "./loop-rig.ts";
import type { LoopRecord, RoundEnd } from "./loop.ts";
import { LOOP_MACHINE, loop, pollSchedule, scheduleProblems, streamSchedule, workerSchedule } from "./loop.ts";
import { rootScope } from "./scope.ts";
import { fakeClock, seeded } from "./testing.ts";
import type { WorkerKnobs } from "./worker.ts";

const count = (value: number): Quantity => ({ value, unit: "count" });

const replays = (transitions: readonly Transition[]): void => {
  expect(transitions.length).toBeGreaterThan(0);
  expect(replay(LOOP_MACHINE, transitions)).toEqual([]);
};

describe("the loop machine document", () => {
  it("is valid and consistent, and the algebra reads each timer", () => {
    expect(machineSchema.safeParse(LOOP_MACHINE).success).toBe(true);
    expect(machineProblems(LOOP_MACHINE)).toEqual([]);
    expect(algebraProblems(LOOP_MACHINE)).toEqual([]);
    expect(Object.keys(LOOP_MACHINE.states).sort()).toEqual(["backoff", "calling", "deferred", "hung", "idle", "stopped", "waiting"]);
  });
});

describe("the schedule and its three settings", () => {
  const knobs: WorkerKnobs = { worker_sleep: s(60), unit_processing_time: s(10), retry_base: s(5), retry_cap: s(120), close_bound: s(2), concurrency: count(3) };

  it("gives the poller, the worker loop and the stream as schedules with no problems", () => {
    const poll = pollSchedule({ interval: s(300), jitter: 0.2, timeout: s(10) });
    expect(poll).toMatchObject({ from: "start", period: s(300), jitter: 0.2, timeout: s(10), backoff: null, overlap: "fail", lanes: 1, stable: null, hold: true });
    const worker = workerSchedule(knobs, { hold: false });
    expect(worker).toMatchObject({ from: "end", period: s(60), jitter: 0, timeout: s(10), lanes: 3, stable: null, hold: false });
    expect(worker.backoff).toEqual(doublingBackoff(5000, 120_000));
    const stream = streamSchedule(doublingBackoff(1000, 30_000));
    expect(stream).toMatchObject({ from: "end", period: s(0), stable: s(30), timeout: { value: "infinite", unit: "s" } });
    for (const schedule of [poll, worker, stream]) expect(scheduleProblems(schedule)).toEqual([]);
  });

  it("refuses a concurrency with no bound for a worker schedule", () => {
    expect(() => workerSchedule({ ...knobs, concurrency: { value: "infinite", unit: "count" } as never })).toThrow(/concurrency with a bound/);
  });

  it("names each value that a loop cannot use", () => {
    const bad = base({
      from: "start",
      period: ms(0),
      jitter: 1,
      first: { value: 5, unit: "m" },
      timeout: ms(0),
      backoff: { base: 10, factor: 0.5 },
      overlap: "allow",
      lanes: 1.5,
      budget: { rounds: 0, per: { value: "infinite", unit: "s" } as never },
      stable: ms(-1),
    });
    const problems = scheduleProblems(bad);
    expect(problems).toEqual([
      "a schedule from start needs a period above zero: each next round of a zero period is already late",
      "the first delay in m is not a time",
      "the timeout of 0 ms is not above zero",
      "the jitter 1 is not a fraction from 0 and below 1",
      "the lanes 1.5 are not a whole number from 1",
      "the backoff: the factor 0.5 is not a number of 1 or more",
      "a backoff spaces the rounds of a lane, and the overlap allow starts a round at each due time: give one of the two",
      "the rounds 0 of the budget are not a whole number from 1",
      "the window of the budget is not a time above zero with a bound",
      "the stable time of -1 ms is less than zero",
    ]);
    expect(() => loop(bad, () => undefined, { name: "bad" })).toThrow(/the schedule of the loop "bad" has problems/);
  });

  it("refuses a scope of the rank of a round, and a clock that is not the clock of the scope", () => {
    const clock = fakeClock();
    const root = rootScope({ name: "root", clock });
    const request = root.entry("request", "r", { trace: undefined, identity: undefined });
    expect(() => loop(base({}), () => undefined, { name: "x", scope: request })).toThrow(/needs a process, service or phase scope/);
    expect(() => loop(base({}), () => undefined, { name: "x", scope: root, clock: fakeClock() })).toThrow(/clock of its scope/);
  });
});

describe("a schedule from start", () => {
  it("starts each round one period after the planned start of the last round, with no lateness", async () => {
    const r = rig(base({ first: ms(50) }), () => pass());
    r.handle.start();
    await r.fake.advance(400);
    expect(r.starts()).toEqual([50, 150, 250, 350]);
    for (const record of r.records) if (record.kind === "start") expect(record.start).toBe(record.planned);
    await r.handle.stop();
    replays(r.transitions);
  });

  it("skips the rounds that a blocked event loop missed, with one skip record, and does not burst", async () => {
    const r = rig(base({}), () => pass());
    r.handle.start();
    await r.fake.advance(0);
    r.fake.block(350);
    await r.fake.advance(10);
    // the round of 100 runs late at 350, and the rounds of 200 and 300 do not occur
    expect(r.starts()).toEqual([0, 350]);
    expect(r.records.find((record) => record.kind === "skip")).toEqual({ kind: "skip", loop: "l", lane: 0, planned: 200, at: 350, count: 2 });
    await r.fake.advance(100);
    expect(r.starts()).toEqual([0, 350, 400]);
    await r.handle.stop();
    replays(r.transitions);
  });

  it("skips a long gap in bulk steps, and still gives one record", async () => {
    const r = rig(base({ period: ms(10) }), () => pass(1));
    r.handle.start();
    await r.fake.advance(0);
    r.fake.block(1_000_000);
    await r.fake.advance(1);
    const skip = r.records.find((record) => record.kind === "skip");
    expect(skip).toMatchObject({ kind: "skip", planned: 20, count: 99_999 });
    await r.handle.stop();
  });

  it("with fail, keeps a round past its timeout hung, and each round due in that time fails at once", async () => {
    const r = rig(base({ timeout: ms(150) }), (round) => (round === 1 ? { duration: 250, outcome: "pass", ignores: true } : pass()));
    r.handle.start();
    await r.fake.advance(100);
    expect(r.handle.states()).toEqual(["calling"]);
    await r.fake.advance(50);
    expect(r.calls[0]!.abortedAt).toBe(150);
    expect((r.calls[0]!.reason as Error).name).toBe("TimeoutError");
    expect(r.handle.states()).toEqual(["hung"]);
    await r.fake.advance(160);
    const ends = r.ends();
    expect(ends.map((end) => [end.round, end.start, end.end, end.outcome, end.timedOut, end.blocked])).toEqual([
      [2, 100, 100, "fail", false, true],
      [1, 0, 150, "fail", true, false],
      [3, 200, 200, "fail", false, true],
      [4, 300, 310, "pass", false, false],
    ]);
    // the late answer of round 1 at 250 gives no second end record
    expect(r.starts()).toEqual([0, 300]);
    expect(r.calls[1]!.failures).toBe(3);
    await r.handle.stop();
    replays(r.transitions);
  });

  it("with skip, gives a skip record for each round due while the lane is busy", async () => {
    const r = rig(base({ overlap: "skip" }), (round) => (round === 1 ? pass(250) : pass()));
    r.handle.start();
    await r.fake.advance(310);
    expect(r.starts()).toEqual([0, 300]);
    expect(r.records.filter((record) => record.kind === "skip").map((record) => record.planned)).toEqual([100, 200]);
    await r.handle.stop();
    replays(r.transitions);
  });

  it("with allow, starts a round beside the round in flight", async () => {
    const r = rig(base({ overlap: "allow" }), (round) => (round === 1 ? pass(250) : pass()));
    r.handle.start();
    await r.fake.advance(310);
    expect(r.starts()).toEqual([0, 100, 200, 300]);
    await r.handle.stop();
    replays(r.transitions);
  });

  it("starts the next round at once after a round that gives more, and plans the period from it", async () => {
    const r = rig(base({}), (round) => (round === 1 ? { duration: 30, outcome: "more" } : pass()));
    r.handle.start();
    await r.fake.advance(250);
    expect(r.starts()).toEqual([0, 30, 130, 230]);
    await r.handle.stop();
    replays(r.transitions);
  });

  it("with a backoff, waits for the backoff after a failure instead of the period", async () => {
    const r = rig(base({ backoff: NO_JITTER, period: ms(1000) }), (round) => (round <= 3 ? fail() : pass()));
    r.handle.start();
    await r.fake.advance(1200);
    // the failures end at 10, 30 and 60, and their backoffs are 10, 20 and 40: the pass of round 4 plans 1100
    expect(r.starts()).toEqual([0, 20, 50, 100, 1100]);
    await r.handle.stop();
    replays(r.transitions);
  });
});

describe("a schedule from end", () => {
  it("starts each round one period after the end of the last round", async () => {
    const r = rig(base({ from: "end", first: ms(0) }), () => pass(30));
    r.handle.start();
    await r.fake.advance(400);
    expect(r.starts()).toEqual([0, 130, 260, 390]);
    await r.handle.stop();
    replays(r.transitions);
  });

  it("backs off after each failure in sequence, and a pass sets the count to zero (laws 1 and 4)", async () => {
    const script = [fail(), fail(), fail(), pass(), fail(), pass()];
    const r = rig(base({ from: "end", backoff: NO_JITTER }), (round) => script[round - 1] ?? pass());
    r.handle.start();
    await r.fake.advance(500);
    const gaps = r.calls.slice(1, 6).map((call, index) => call.at - r.calls[index]!.settledAt!);
    expect(gaps).toEqual([10, 20, 40, 100, 10]);
    expect(r.calls.slice(0, 6).map((call) => call.failures)).toEqual([0, 1, 2, 3, 0, 1]);
    await r.handle.stop();
    replays(r.transitions);
  });

  it("keeps each delay of a jittered backoff in its band", async () => {
    const policy = doublingBackoff(20, 200);
    const r = rig(base({ from: "end", backoff: policy, period: ms(1000) }), () => fail(5), { random: seeded(11) });
    r.handle.start();
    await r.fake.advance(3000);
    const calls = r.calls;
    for (let k = 1; k < calls.length; k += 1) {
      const gap = calls[k]!.at - calls[k - 1]!.settledAt!;
      const band = backoffBand(policy, k);
      expect(gap).toBeGreaterThanOrEqual(band.low);
      expect(gap).toBeLessThanOrEqual(band.high);
    }
    expect(calls.length).toBeGreaterThan(8);
    await r.handle.stop();
  });

  it("gives each lane its own rounds and its own count of failures", async () => {
    const r = rig(base({ from: "end", lanes: 2, backoff: NO_JITTER }), (round) => (round === 1 ? fail() : pass()));
    r.handle.start();
    await r.fake.advance(150);
    expect(r.calls.map((call) => [call.lane, call.at, call.failures])).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 20, 1],
      [1, 110, 0],
      [0, 130, 0],
    ]);
    await r.handle.stop();
    replays(r.transitions);
  });

  it("wakes a waiting lane at once, runs a round at once after a round in flight, and does not end a backoff", async () => {
    const r = rig(base({ from: "end", period: { value: "infinite", unit: "s" }, first: { value: "infinite", unit: "s" }, backoff: NO_JITTER }), (round) =>
      round === 3 ? fail() : pass(20),
    );
    r.handle.start();
    expect(r.handle.wake()).toBe(true);
    await r.fake.advance(10);
    expect(r.handle.wake()).toBe(true);
    await r.fake.advance(20);
    // round 1 ends at 20, and round 2 starts at once
    expect(r.starts()).toEqual([0, 20]);
    await r.fake.advance(10);
    // round 2 ends at 40, and the lane waits with no timer for its period with no bound
    expect(r.handle.states()).toEqual(["waiting"]);
    expect(r.handle.wake()).toBe(true);
    await r.fake.advance(10);
    // round 3 fails at 50: the lane waits 10 for its backoff, and a wake does not end it
    expect(r.handle.states()).toEqual(["backoff"]);
    expect(r.handle.wake()).toBe(false);
    await r.fake.advance(10);
    expect(r.starts()).toEqual([0, 20, 40, 60]);
    await r.handle.stop();
    replays(r.transitions);
  });
});

describe("the budget (law 6)", () => {
  it("defers a round over the budget to the window, with a record, and drops no round", async () => {
    const r = rig(base({ from: "end", period: ms(10), budget: { rounds: 2, per: ms(100) } }), () => pass(1));
    r.handle.start();
    await r.fake.advance(250);
    expect(r.starts()).toEqual([0, 11, 100, 111, 200, 211]);
    const defers = r.records.filter((record) => record.kind === "defer");
    expect(defers[0]).toEqual({ kind: "defer", loop: "l", lane: 0, planned: 22, at: 22, until: 100 });
    expect(r.handle.states()).toEqual(["deferred"]);
    await r.handle.stop();
    replays(r.transitions);
  });
});

describe("the stop (law 5)", () => {
  it("aborts the round in flight, leaves no timer, gives no record after it, and a second stop gives the same promise", async () => {
    const r = rig(base({ timeout: ms(500) }), () => pass(300));
    r.handle.start();
    await r.fake.advance(100);
    const recordsBefore = r.records.length;
    const stopping = r.handle.stop();
    expect(r.handle.stop()).toBe(stopping);
    await stopping;
    expect((r.calls[0]!.reason as Error).name).toBe("AbortError");
    expect(r.timers.filter((timer) => timer.live)).toEqual([]);
    expect(r.handle.states()).toEqual(["stopped"]);
    await r.fake.advance(1000);
    expect(r.records.length).toBe(recordsBefore);
    expect(r.calls.length).toBe(1);
    r.handle.start();
    expect(r.handle.wake()).toBe(false);
    expect(r.transitions.at(-1)).toMatchObject({ from: "calling", on: "stop", to: "stopped" });
    replays(r.transitions);
  });

  it("stops when its parent scope closes, and its rounds are children of that scope", async () => {
    const clock = fakeClock();
    const root = rootScope({ name: "svc", clock });
    const transitions: Transition[] = [];
    let scopeKind: string | undefined;
    const handle = loop(
      base({}),
      (context) => {
        scopeKind = context.scope.kind;
      },
      { name: "child", scope: root, onTransition: (transition) => transitions.push(transition) },
    );
    handle.start();
    await clock.advance(150);
    expect(scopeKind).toBe("round");
    await root.close();
    expect(handle.states()).toEqual(["stopped"]);
    expect(clock.pending).toBe(0);
    replays(transitions);
  });

  it("rejects the stop with the errors of the closes of its rounds", async () => {
    const clock = fakeClock();
    const root = rootScope({ name: "svc", clock });
    const handle = loop(
      base({}),
      (context) => {
        context.scope.defer(() => {
          throw new Error("the cleanup failed");
        });
        return new Promise<void>(() => undefined);
      },
      { name: "child", scope: root },
    );
    handle.start();
    await clock.advance(0);
    await expect(handle.stop()).rejects.toThrow(AggregateError);
  });

  it("makes an error of the close of a round a failure of that round", async () => {
    const clock = fakeClock();
    const records: LoopRecord[] = [];
    const handle = loop(
      base({}),
      (context) => {
        context.scope.defer(() => {
          throw new Error("the cleanup failed");
        });
      },
      { name: "l", clock, record: (record) => records.push(record) },
    );
    handle.start();
    await clock.advance(0);
    const end = records.find((record): record is RoundEnd => record.kind === "end");
    expect(end).toMatchObject({ outcome: "fail", blocked: false, timedOut: false });
    expect(end!.error).toBeInstanceOf(Error);
    await handle.stop();
  });
});

describe("the hold (law 10)", () => {
  it("keeps each timer referenced with hold", async () => {
    const r = rig(base({ timeout: ms(50), backoff: NO_JITTER }), (round) => (round % 2 === 0 ? fail() : pass()));
    r.handle.start();
    await r.fake.advance(500);
    await r.handle.stop();
    expect(r.timers.filter((timer) => timer.unref)).toEqual([]);
  });

  it("without hold, uses the unref of each timer of the schedule, and keeps the deadline of each round referenced", async () => {
    const r = rig(base({ timeout: ms(50), backoff: NO_JITTER, hold: false }), (round) => (round % 2 === 0 ? fail() : pass()));
    r.handle.start();
    await r.fake.advance(500);
    await r.handle.stop();
    const referenced = r.timers.filter((timer) => !timer.unref);
    expect(referenced.length).toBe(r.calls.length);
    for (const timer of referenced) expect(timer.ms).toBe(50);
    expect(r.timers.filter((timer) => timer.unref).length).toBeGreaterThan(r.calls.length - 1);
  });
});

describe("a stream: one round is one long connection, and its proof sets the count to zero", () => {
  const policy = doublingBackoff(1000, 30_000);

  it("backs off up to the cap for a feed that drops 100 ms after each open", async () => {
    for (const outcome of ["fail", "pass"] as const) {
      const r = rig(streamSchedule(policy), () => ({ duration: 100, outcome }), { random: seeded(3) });
      r.handle.start();
      await r.fake.advance(240_000);
      const calls = r.calls;
      expect(calls.length).toBeGreaterThan(9);
      for (let k = 1; k < calls.length; k += 1) {
        const gap = calls[k]!.at - calls[k - 1]!.settledAt!;
        const band = backoffBand(policy, k);
        expect(gap, `${outcome} gap ${k}`).toBeGreaterThanOrEqual(band.low);
        expect(gap, `${outcome} gap ${k}`).toBeLessThanOrEqual(band.high);
      }
      // the last gaps are at the cap
      expect(calls.at(-1)!.at - calls.at(-2)!.settledAt!).toBeGreaterThanOrEqual(30_000);
      if (outcome === "pass") expect((r.ends()[0]!.error as Error).name).toBe("UnprovedRoundError");
      await r.handle.stop();
      replays(r.transitions);
    }
  });

  it("opens again after the first backoff when the round proves the feed with reset() at its first useful message", async () => {
    const r = rig(streamSchedule(policy), () => ({ duration: 100, outcome: "fail", proofAt: 50 }), { random: seeded(3) });
    r.handle.start();
    await r.fake.advance(60_000);
    const band = backoffBand(policy, 1);
    for (let k = 1; k < r.calls.length; k += 1) {
      const gap = r.calls[k]!.at - r.calls[k - 1]!.settledAt!;
      expect(gap).toBeGreaterThanOrEqual(band.low);
      expect(gap).toBeLessThanOrEqual(band.high);
    }
    expect(r.calls.length).toBeGreaterThan(20);
    await r.handle.stop();
  });

  it("takes a connection that stays up for the stable time as the proof, and a clean close after it as a pass", async () => {
    const script = [fail(100), fail(100), { duration: 31_000, outcome: "fail" as const }, { duration: 40_000, outcome: "pass" as const }];
    const r = rig(streamSchedule(policy), (round) => script[round - 1] ?? fail(100), { random: () => 0 });
    r.handle.start();
    await r.fake.advance(200_000);
    // round 3 stays up past the stable time: its failure counts as the first, with the backoff of the base
    expect(r.calls.slice(0, 5).map((call) => call.failures)).toEqual([0, 1, 2, 1, 0]);
    expect(r.calls[3]!.at - r.calls[2]!.settledAt!).toBe(1000);
    expect(r.ends().slice(0, 4).map((end) => end.outcome)).toEqual(["fail", "fail", "fail", "pass"]);
    // after the pass of round 4 the period is zero: round 5 opens at once
    expect(r.calls[4]!.at).toBe(r.calls[3]!.settledAt);
    await r.handle.stop();
    replays(r.transitions);
  });
});
