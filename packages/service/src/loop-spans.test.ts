// Law 9 of the loop core (SYS-138 part 2): `failSpan` and `recoverSpan` read the schedule of a loop. A loop on the
// schedule feeds a latch on the test clock, and the latch trips and recovers inside the spans of that schedule, for each
// seed of the jitter and of the phase where the signal turns.

import { valueIn } from "@mark1russell7/quantity";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { latch } from "./latch.ts";
import { loop, pollSchedule, type Schedule } from "./loop.ts";
import { ms } from "./loop-rig.ts";
import { fakeClock, seeded } from "./testing.ts";
import { failSpan, recoverSpan, type FailsBy, type Poll, type Timing } from "./timing.ts";

/** The runs of the law. A deeper run sets LOOP_LAW_RUNS. */
const RUNS = Number(process.env["LOOP_LAW_RUNS"] ?? 100);
const EPSILON = 1e-6;

interface SpanCase {
  readonly interval: number;
  readonly jitter: number;
  /** The timeout as a fraction of the shortest interval: the ordering law keeps it below that interval (O12). */
  readonly timeoutShare: number;
  readonly timing: { readonly type: "debounce"; readonly failAfter: number; readonly recoverAfter: number } | {
    readonly type: "window";
    readonly failAfter: number;
    readonly recoverAfter: number | null;
  };
  readonly overlap: "fail" | "allow" | "skip";
  readonly by: FailsBy;
  readonly seed: number;
}

const spanCase: fc.Arbitrary<SpanCase> = fc
  .record({
    interval: fc.integer({ min: 100, max: 2000 }),
    jitter: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 40 }).map((n) => n / 100)),
    timeoutShare: fc.integer({ min: 1, max: 95 }).map((n) => n / 100),
    timing: fc.oneof(
      fc.record({ type: fc.constant("debounce" as const), failAfter: fc.integer({ min: 1, max: 5 }), recoverAfter: fc.integer({ min: 1, max: 3 }) }),
      fc.record({
        type: fc.constant("window" as const),
        failAfter: fc.integer({ min: 0, max: 30 }).map((n) => n / 10),
        recoverAfter: fc.option(fc.integer({ min: 0, max: 20 }).map((n) => n / 10), { nil: null }),
      }),
    ),
    overlap: fc.constantFrom("fail" as const, "allow" as const, "skip" as const),
    by: fc.constantFrom("error" as const, "timeout" as const, "hang" as const),
    seed: fc.integer({ min: 1, max: 1_000_000 }),
  })
  // with the overlap skip, a round that hangs gives one failure only: its span has no bound
  .filter((each) => !(each.overlap === "skip" && each.by === "hang"));

/** The schedule, the poll and the timing of a case. A window is in intervals of the poll. */
const shape = (each: SpanCase): { readonly schedule: Schedule; readonly poll: Poll; readonly timing: Timing } => {
  const timeout = Math.max(1, Math.floor(each.interval * (1 - each.jitter) * each.timeoutShare));
  const poll: Poll = { interval: ms(each.interval), jitter: each.jitter, timeout: ms(timeout) };
  const timing: Timing =
    each.timing.type === "debounce"
      ? { type: "debounce", interval: poll.interval, failAfter: each.timing.failAfter, recoverAfter: each.timing.recoverAfter }
      : {
          type: "window",
          failAfter: ms(each.timing.failAfter * each.interval),
          ...(each.timing.recoverAfter === null ? {} : { recoverAfter: ms(each.timing.recoverAfter * each.interval) }),
        };
  return { schedule: { ...pollSchedule(poll), overlap: each.overlap }, poll, timing };
};

const inMs = (amount: { readonly value: number; readonly unit: string }): number => valueIn(amount, "ms");

/** The time from a planned start to the turn of a signal at an edge, in milliseconds. */
const NUDGE = 0.001;

/**
 * One run of a case: the trip and the recovery, in milliseconds after the signal turned. With no edge, the jitter and the
 * phase come from the seed. The edge `max` makes each interval long, and the signal turns a nudge after a planned start.
 * The edge `min` makes each interval short, and the signal turns a nudge before a planned start. For a call in flight
 * that heals, the turn is at its timeout, not at its start.
 */
const run = async (each: SpanCase, edge?: "min" | "max"): Promise<{ trip: number | undefined; recover: number | undefined }> => {
  const { schedule, timing, poll } = shape(each);
  const timeout = inMs(poll.timeout);
  const clock = fakeClock();
  const phase = seeded(each.seed * 7919);
  const draw = edge === "max" ? 1 - 1e-12 : 0;
  // the planned start of the latest round, also a blocked round
  let last = Number.NEGATIVE_INFINITY;
  /** This function moves the clock to the turn of the signal, and gives its time. */
  const turn = async (healing: boolean): Promise<number> => {
    if (edge === undefined) await clock.advance(phase() * 2 * each.interval);
    else {
      const step = each.interval * (1 + each.jitter * (2 * draw - 1));
      // a call in flight that heals answers at once: the edges of its recovery are at its timeout, not at its start
      const offset = healing && each.overlap === "allow" && each.by === "hang" ? timeout : 0;
      // a nudge on each side of the planned time: the planned times of the core and of this sum differ by a rounding error
      const at = (start: number): number => start + offset + (edge === "min" ? -NUDGE : NUDGE);
      let next = last + step;
      while (at(next) <= clock.now()) next += step;
      await clock.advance(at(next) - clock.now());
    }
    return clock.now();
  };
  let bad: FailsBy | null = null;
  const hung = new Set<() => void>();
  const turns: Array<{ readonly at: number; readonly tripped: boolean }> = [];
  // a window trips by its own timer, thus each turn comes from the latch, not from a record
  const made = latch(timing, clock, false, () => turns.push({ at: clock.now(), tripped: made.tripped }));
  const ticks = loop(
    schedule,
    (context) => {
      if (bad === null) return;
      if (bad === "error") throw new Error("the step refused");
      if (bad === "timeout")
        // a black hole: the step answers only when the timeout of the round aborts it
        return new Promise<void>((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      // a hang ignores the abort, until the step heals
      return new Promise<void>((resolve) => hung.add(resolve));
    },
    {
      name: "spans",
      clock,
      random: edge === undefined ? seeded(each.seed) : () => draw,
      record: (record) => {
        if (record.kind === "start" || (record.kind === "end" && record.blocked)) last = Math.max(last, record.planned);
        if (record.kind !== "end") return;
        made.record({
          outcome: record.outcome === "fail" ? "error" : "ok",
          at: record.end,
          took: record.end - record.start,
          cause: null,
          timedOut: record.timedOut,
          thrown: false,
          forced: false,
        });
      },
    },
  );
  const fail = failSpan(timing, schedule, each.by);
  const recover = recoverSpan(timing, schedule, each.by);
  ticks.start();
  // the latch first settles released, and the signal turns at a phase of the loop
  await clock.advance(inMs(recover.max) + 3 * each.interval);
  const badAt = await turn(false);
  bad = each.by;
  turns.length = 0;
  await clock.advance(inMs(fail.max) + 2 * each.interval);
  const trip = turns.find((seen) => seen.tripped);
  const goodAt = await turn(true);
  bad = null;
  for (const heal of [...hung]) heal();
  hung.clear();
  turns.length = 0;
  await clock.advance(inMs(recover.max) + 2 * each.interval);
  const released = turns.find((seen) => !seen.tripped);
  await ticks.stop();
  made.stop();
  return { trip: trip === undefined ? undefined : trip.at - badAt, recover: released === undefined ? undefined : released.at - goodAt };
};

describe("law 9: a latch on a loop trips and recovers inside the spans of its schedule", () => {
  it("holds for each timing, each overlap, each way to fail and each seed", async () => {
    await fc.assert(
      fc.asyncProperty(spanCase, async (each) => {
        const { schedule, timing } = shape(each);
        const fail = failSpan(timing, schedule, each.by);
        const recover = recoverSpan(timing, schedule, each.by);
        const { trip, recover: back } = await run(each);
        expect(trip, "it trips").toBeDefined();
        expect(trip!).toBeGreaterThanOrEqual(inMs(fail.min) - EPSILON);
        expect(trip!).toBeLessThanOrEqual(inMs(fail.max) + EPSILON);
        expect(back, "it recovers").toBeDefined();
        expect(back!).toBeGreaterThanOrEqual(inMs(recover.min) - EPSILON);
        expect(back!).toBeLessThanOrEqual(inMs(recover.max) + EPSILON);
      }),
      { numRuns: RUNS, seed: 9 },
    );
  });

  it("reaches each end of each span: short intervals at the edge min, long intervals at the edge max", async () => {
    await fc.assert(
      fc.asyncProperty(spanCase, async (each) => {
        const { schedule, timing } = shape(each);
        const fail = failSpan(timing, schedule, each.by);
        const recover = recoverSpan(timing, schedule, each.by);
        const low = await run(each, "min");
        const high = await run(each, "max");
        expect([low.trip, low.recover]).toEqual([
          expect.closeTo(inMs(fail.min), 2),
          expect.closeTo(inMs(recover.min), 2),
        ]);
        expect([high.trip, high.recover]).toEqual([
          expect.closeTo(inMs(fail.max), 2),
          expect.closeTo(inMs(recover.max), 2),
        ]);
      }),
      { numRuns: Math.max(10, RUNS / 2), seed: 9 },
    );
  });
});

describe("the spans of a schedule", () => {
  const poll: Poll = { interval: { value: 5, unit: "s" }, jitter: 0.2, timeout: { value: 2, unit: "s" } };
  const timing: Timing = { type: "debounce", interval: poll.interval, failAfter: 3, recoverAfter: 1 };

  it("are the spans of its poll for the schedule of the poller", () => {
    for (const by of ["error", "timeout", "hang"] as const) expect(failSpan(timing, pollSchedule(poll), by)).toEqual(failSpan(timing, poll, by));
    expect(recoverSpan(timing, pollSchedule(poll))).toEqual(recoverSpan(timing, poll));
  });

  it("count a hang as a timeout with the overlap allow: each due round is a new call", () => {
    const window: Timing = { type: "window", failAfter: { value: 10, unit: "s" } };
    expect(failSpan(window, { ...pollSchedule(poll), overlap: "allow" }, "hang")).toEqual(failSpan(window, poll, "timeout"));
    expect(failSpan(timing, { ...pollSchedule(poll), overlap: "allow" }, "hang")).toEqual(failSpan(timing, poll, "timeout"));
  });

  it("recover one timeout sooner from a hang with the overlap allow: the call in flight answers at the heal", () => {
    const twice: Timing = { ...timing, recoverAfter: 2 };
    // 2 polls of 5 s ± 20 % with a timeout of 2 s: from 4 s to 12 s on the poller, and 2 s sooner at each end on the overlap allow
    expect(recoverSpan(twice, pollSchedule(poll), "hang")).toEqual({ min: { value: 4, unit: "s" }, max: { value: 12, unit: "s" } });
    expect(recoverSpan(twice, { ...pollSchedule(poll), overlap: "allow" }, "hang")).toEqual({ min: { value: 2, unit: "s" }, max: { value: 10, unit: "s" } });
    // a debounce of one pass cannot recover before the heal, and a window waits its duration from the first pass
    expect(recoverSpan(timing, { ...pollSchedule(poll), overlap: "allow" }, "hang")).toEqual({ min: { value: 0, unit: "s" }, max: { value: 4, unit: "s" } });
    const window: Timing = { type: "window", failAfter: { value: 10, unit: "s" }, recoverAfter: { value: 3, unit: "s" } };
    expect(recoverSpan(window, { ...pollSchedule(poll), overlap: "allow" }, "hang")).toEqual({ min: { value: 3, unit: "s" }, max: { value: 7, unit: "s" } });
  });

  it("throw for a schedule that the model of the span does not hold, and name each reason", () => {
    const base = pollSchedule(poll);
    const cases: Array<[Schedule, FailsBy, RegExp]> = [
      [{ ...base, from: "end" }, "error", /from end/],
      [{ ...base, period: { value: "infinite", unit: "s" } }, "error", /need a bound/],
      [{ ...base, timeout: { value: "infinite", unit: "s" } }, "error", /need a bound/],
      [{ ...base, backoff: { base: 1000, cap: 30_000 } }, "error", /backoff/],
      [{ ...base, lanes: 2 }, "error", /one lane/],
      [{ ...base, budget: { rounds: 1, per: { value: 1, unit: "min" } } }, "error", /budget/],
      [{ ...base, stable: { value: 30, unit: "s" } }, "error", /stable time/],
      [{ ...base, overlap: "skip" }, "hang", /overlap skip/],
    ];
    for (const [schedule, by, reason] of cases) {
      expect(() => failSpan(timing, schedule, by)).toThrow(RangeError);
      expect(() => failSpan(timing, schedule, by)).toThrow(reason);
    }
    expect(() => recoverSpan(timing, { ...base, lanes: 2 })).toThrow(/one lane/);
    // with the overlap skip, a step that fails by an error or a timeout keeps its span
    expect(failSpan(timing, { ...base, overlap: "skip" }, "error")).toEqual(failSpan(timing, poll, "error"));
  });
});
