// The laws of the loop core (SYS-138), on random schedules and random scripted rounds, on the fake clock with a seed:
// 1 the spacing, 2 one round for each lane, 3 the bound, 4 the reset and its proof, 5 the stop, 6 the budget,
// 7 the replay on LOOP_MACHINE and 10 the hold. Laws 8 and 9 come with the five loops on the core (part 2).

import { replay } from "@mark1russell7/algebra/replay";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Backoff } from "./backoff.ts";
import { backoffBand } from "./backoff.ts";
import type { Call, Script } from "./loop-rig.ts";
import { ms, rig } from "./loop-rig.ts";
import type { LoopRecord, RoundEnd, RoundStart, Schedule } from "./loop.ts";
import { LOOP_MACHINE } from "./loop.ts";
import { seeded } from "./testing.ts";

/** The runs of each law. A deeper run sets LOOP_LAW_RUNS. */
const RUNS = Number(process.env["LOOP_LAW_RUNS"] ?? 100);
const HORIZON = 600;
/** The fake clock is exact, but the jitter is a product of floats: each band comparison lets times differ by this much. */
const EPSILON = 1e-6;

interface Case {
  readonly schedule: Schedule;
  readonly scripts: readonly Script[];
  readonly seed: number;
  readonly stopAt: number;
}

const backoffOf: fc.Arbitrary<Backoff> = fc
  .record({
    base: fc.integer({ min: 5, max: 40 }),
    grow: fc.integer({ min: 1, max: 16 }),
    factor: fc.constantFrom(1, 1.5, 2, 3),
    jitter: fc.oneof(
      fc.constant({ kind: "none" as const }),
      fc.double({ min: 0, max: 0.8, noNaN: true }).map((fraction) => ({ kind: "subtract" as const, fraction })),
      fc.integer({ min: 0, max: 30 }).map((amount) => ({ kind: "add" as const, amount })),
    ),
  })
  .map(({ base, grow, factor, jitter }) => ({ base, factor, cap: base * grow, jitter }));

const scriptOf = (stable: boolean): fc.Arbitrary<Script> =>
  fc
    .record({
      duration: fc.oneof(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 400 })),
      outcome: fc.constantFrom<Script["outcome"]>("pass", "pass", "fail", "more"),
      ignores: fc.boolean(),
      proofAt: stable ? fc.option(fc.integer({ min: 0, max: 300 }), { nil: undefined }) : fc.constant(undefined),
    })
    // a round that gives more starts the next at once: a short one at each instant would hold the clock still
    .map(({ proofAt, ...rest }): Script => {
      const duration = rest.outcome === "more" ? Math.max(rest.duration, 5) : rest.duration;
      return proofAt === undefined ? { ...rest, duration } : { ...rest, duration, proofAt };
    });

interface Shape {
  readonly from?: Schedule["from"];
  readonly backoff?: "none" | "some" | "any";
  readonly budget?: boolean;
  readonly more?: boolean;
  readonly ignores?: boolean;
  readonly stable?: boolean;
  readonly timeout?: boolean;
}

/** This arbitrary gives a case: a schedule with no problems, a script for each round, a seed and the time of the stop. */
const caseOf = (shape: Shape = {}): fc.Arbitrary<Case> =>
  fc
    .record({
      from: shape.from === undefined ? fc.constantFrom<Schedule["from"]>("start", "end") : fc.constant(shape.from),
      period: fc.integer({ min: 10, max: 200 }),
      jitter: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 0.5, noNaN: true })),
      first: fc.integer({ min: 0, max: 100 }),
      timeout:
        shape.timeout === true
          ? fc.integer({ min: 1, max: 300 })
          : shape.timeout === false
            ? fc.constant(undefined)
            : fc.option(fc.integer({ min: 1, max: 300 }), { nil: undefined }),
      backoff:
        shape.backoff === "none" ? fc.constant(null) : shape.backoff === "some" ? backoffOf : fc.option(backoffOf, { nil: null }),
      overlap: fc.constantFrom<Schedule["overlap"]>("fail", "skip", "allow"),
      lanes: fc.integer({ min: 1, max: 3 }),
      budget: shape.budget === true ? fc.record({ rounds: fc.integer({ min: 1, max: 4 }), per: fc.integer({ min: 20, max: 500 }) }) : fc.constant(null),
      hold: fc.boolean(),
      stable: shape.stable === true ? fc.integer({ min: 0, max: 200 }) : fc.constant(null),
      scripts: fc.array(scriptOf(shape.stable === true), { minLength: 1, maxLength: 12 }),
      seed: fc.integer(),
      stopAt: fc.integer({ min: 0, max: HORIZON }),
    })
    .map((drawn): Case => {
      const overlap = drawn.from === "start" && drawn.backoff !== null && drawn.overlap === "allow" ? "fail" : drawn.overlap;
      const scripts = drawn.scripts.map(
        (script): Script => ({
          ...script,
          outcome: shape.more === false && script.outcome === "more" ? "pass" : script.outcome,
          ignores: shape.ignores === false ? false : script.ignores === true,
        }),
      );
      return {
        schedule: {
          from: drawn.from,
          period: ms(drawn.period),
          jitter: drawn.jitter,
          first: ms(drawn.first),
          timeout: drawn.timeout === undefined ? { value: "infinite", unit: "s" } : ms(drawn.timeout),
          backoff: drawn.backoff,
          overlap,
          lanes: drawn.lanes,
          budget: drawn.budget === null ? null : { rounds: drawn.budget.rounds, per: ms(drawn.budget.per) },
          hold: drawn.hold,
          stable: drawn.stable === null ? null : ms(drawn.stable),
        },
        scripts,
        seed: drawn.seed,
        stopAt: drawn.stopAt,
      };
    });

const valueOf = (amount: Schedule["period"]): number => (amount.value === "infinite" ? Number.POSITIVE_INFINITY : (amount.value as number));

/** This function operates a case to its stop, then past it, and gives the rig. */
const operate = async (each: Case) => {
  const r = rig(each.schedule, (round) => each.scripts[(round - 1) % each.scripts.length]!, { random: seeded(each.seed) });
  r.handle.start();
  await r.fake.advance(each.stopAt);
  const stopAt = r.fake.now();
  const recordsAtStop = r.records.length;
  const callsAtStop = r.calls.length;
  const stopping = r.handle.stop();
  const again = r.handle.stop();
  await stopping.catch(() => undefined);
  // the count before the clock moves on: a timer that the stop keeps would fire and be gone after the advance
  const liveAtStop = r.timers.filter((timer) => timer.live).length;
  await r.fake.advance(HORIZON);
  return { ...r, stopAt, recordsAtStop, callsAtStop, stopping, again, liveAtStop };
};

type Operated = Awaited<ReturnType<typeof operate>>;

const startsOf = (records: readonly LoopRecord[], lane: number): RoundStart[] =>
  records.filter((record): record is RoundStart => record.kind === "start" && record.lane === lane);
const endsOf = (records: readonly LoopRecord[]): RoundEnd[] => records.filter((record): record is RoundEnd => record.kind === "end");
const callsOf = (calls: readonly Call[], lane: number): Call[] => calls.filter((call) => call.lane === lane);

const inBand = (gap: number, low: number, high: number): boolean => gap >= low - EPSILON && gap <= high + EPSILON;
const periodBand = (schedule: Schedule): { low: number; high: number } => {
  const period = valueOf(schedule.period);
  return { low: period * (1 - schedule.jitter), high: period * (1 + schedule.jitter) };
};

/** The planned time of each round that came due on a lane: a start, a round that failed at once, and a skip. */
const dueOf = (records: readonly LoopRecord[], lane: number): Array<{ planned: number; record: LoopRecord }> =>
  records.flatMap((record): Array<{ planned: number; record: LoopRecord }> => {
    if (record.lane !== lane) return [];
    if (record.kind === "start" || record.kind === "skip") return [{ planned: record.planned, record }];
    if (record.kind === "end" && record.blocked) return [{ planned: record.planned, record }];
    return [];
  });

const lanesOf = (schedule: Schedule): number[] => Array.from({ length: schedule.lanes }, (_, index) => index);

const property = (shape: Shape, check: (each: Case, r: Operated) => void) =>
  fc.assert(
    fc.asyncProperty(caseOf(shape), async (each) => {
      const r = await operate(each);
      check(each, r);
    }),
    { numRuns: RUNS },
  );

describe("law 1: the spacing", () => {
  it("from start with no backoff, two planned starts of a lane are apart by a time in the band of the period, and no round starts late", async () => {
    await property({ from: "start", backoff: "none", budget: false, more: false }, (each, r) => {
      const band = periodBand(each.schedule);
      for (const lane of lanesOf(each.schedule)) {
        const due = dueOf(r.records, lane);
        for (let k = 1; k < due.length; k += 1) {
          const gap = due[k]!.planned - due[k - 1]!.planned;
          expect(inBand(gap, band.low, band.high), `lane ${lane}, due ${k}: ${gap} not in ${band.low}..${band.high}`).toBe(true);
        }
        for (const start of startsOf(r.records, lane)) expect(start.start).toBe(start.planned);
      }
    });
  });

  it("from start with a backoff, the next round after the k-th failure in sequence comes due after a delay in backoffBand(policy, k)", async () => {
    await property({ from: "start", backoff: "some", budget: false }, (each, r) => {
      const policy = each.schedule.backoff!;
      for (const lane of lanesOf(each.schedule)) {
        let failures = 0;
        const mine = r.records.filter((record) => record.lane === lane);
        for (let index = 0; index < mine.length; index += 1) {
          const record = mine[index]!;
          if (record.kind !== "end") continue;
          failures = record.outcome === "fail" ? failures + 1 : 0;
          if (record.outcome !== "fail") continue;
          // a later failure or more arms the timer again, and a pass from start keeps the timer of the backoff
          const next = mine.slice(index + 1).find((later) => later.kind !== "end" || later.blocked || later.outcome !== "pass");
          if (next === undefined || (next.kind === "end" && !next.blocked)) continue;
          const band = backoffBand(policy, failures);
          const gap = next.planned - record.end;
          expect(inBand(gap, band.low, band.high), `lane ${lane}: failure ${failures}, gap ${gap} not in ${band.low}..${band.high}`).toBe(true);
        }
      }
    });
  });

  it("from end, the gap from the settle of a round to the next start is the period, the backoff of the k-th failure, or zero after more", async () => {
    await property({ from: "end", budget: false }, (each, r) => {
      const band = periodBand(each.schedule);
      const ends = new Map(endsOf(r.records).map((end) => [end.round, end]));
      for (const lane of lanesOf(each.schedule)) {
        const calls = callsOf(r.calls, lane);
        for (let k = 1; k < calls.length; k += 1) {
          const last = calls[k - 1]!;
          const next = calls[k]!;
          const end = ends.get(last.round)!;
          const gap = next.at - last.settledAt!;
          if (end.outcome === "more") expect(gap).toBe(0);
          else if (end.outcome === "fail" && each.schedule.backoff !== null) {
            const policy = backoffBand(each.schedule.backoff, next.failures);
            expect(inBand(gap, policy.low, policy.high), `lane ${lane}: failure ${next.failures}, gap ${gap}`).toBe(true);
          } else expect(inBand(gap, band.low, band.high), `lane ${lane}: gap ${gap} not in ${band.low}..${band.high}`).toBe(true);
        }
      }
    });
  });
});

describe("law 2: one round for each lane", () => {
  it("with fail or skip, no two rounds of one lane are in flight at one time", async () => {
    await property({}, (each, r) => {
      if (each.schedule.from === "start" && each.schedule.overlap === "allow") return;
      for (const lane of lanesOf(each.schedule)) {
        const calls = callsOf(r.calls, lane);
        for (let k = 1; k < calls.length; k += 1) {
          const settled = calls[k - 1]!.settledAt;
          expect(settled, `lane ${lane}: round ${calls[k]!.round} started over a round in flight`).toBeDefined();
          expect(calls[k]!.at).toBeGreaterThanOrEqual(settled!);
        }
      }
    });
  });
});

describe("law 3: the bound", () => {
  it("aborts each round at its start plus the timeout, at the latest, and each round that fails at once falls in a round in flight", async () => {
    await property({ timeout: true }, (each, r) => {
      const timeout = valueOf(each.schedule.timeout);
      for (const call of r.calls) {
        const deadline = call.at + timeout;
        if (call.abortedAt === undefined) expect(call.settledAt! - EPSILON, `round ${call.round} outlived its deadline with no abort`).toBeLessThanOrEqual(deadline);
        else if ((call.reason as Error).name === "TimeoutError") expect(call.abortedAt).toBeCloseTo(deadline, 9);
        else {
          // the stop aborted the round before its deadline
          expect(call.abortedAt).toBe(r.stopAt);
          expect(r.stopAt).toBeLessThan(deadline);
        }
      }
      const timedOut = endsOf(r.records).filter((end) => end.timedOut);
      for (const end of timedOut) expect(end.end - end.start).toBeCloseTo(timeout, 9);
      for (const end of endsOf(r.records).filter((each) => each.blocked)) {
        const busy = callsOf(r.calls, end.lane).some((call) => call.at <= end.end && (call.settledAt === undefined || call.settledAt >= end.end));
        expect(busy, `round ${end.round} failed at once on a lane with no round in flight`).toBe(true);
      }
    });
  });
});

describe("law 4: the reset", () => {
  it("each round sees the count of failures in sequence on its lane, and a pass sets it to zero", async () => {
    await property({}, (_each, r) => {
      const calls = new Map(r.calls.map((call) => [call.round, call]));
      const failures = new Map<number, number>();
      for (const record of r.records) {
        if (record.kind === "start") expect(calls.get(record.round)!.failures, `round ${record.round}`).toBe(failures.get(record.lane) ?? 0);
        if (record.kind === "end") failures.set(record.lane, record.outcome === "fail" ? (failures.get(record.lane) ?? 0) + 1 : 0);
      }
    });
  });

  it("with a stable time, a round with no proof is a failure, and a round with its proof counts from zero", async () => {
    await property({ from: "end", stable: true, budget: false }, (each, r) => {
      const stable = valueOf(each.schedule.stable!);
      const calls = new Map(r.calls.map((call) => [call.round, call]));
      const failures = new Map<number, number>();
      for (const record of r.records) {
        if (record.kind === "start") expect(calls.get(record.round)!.failures, `round ${record.round}`).toBe(failures.get(record.lane) ?? 0);
        if (record.kind !== "end") continue;
        const script = each.scripts[(record.round - 1) % each.scripts.length]!;
        // the deadline of a round starts before its script: at one instant, the deadline comes first and the proof after the
        // abort counts for nothing. The proof of the script starts before its settle: at one instant, the proof comes first
        const proofAt = script.proofAt;
        const lasted = record.end - record.start;
        const proved =
          lasted >= stable || (proofAt !== undefined && (record.timedOut ? proofAt < lasted - EPSILON : proofAt <= lasted + EPSILON));
        if (record.outcome !== "fail") expect(proved, `round ${record.round} passed with no proof`).toBe(true);
        if (!record.blocked && !record.timedOut && script.outcome !== "fail" && proved) expect(record.outcome, `round ${record.round} had its proof`).toBe(script.outcome);
        if (!record.blocked && !record.timedOut && script.outcome !== "fail" && !proved) expect((record.error as Error).name).toBe("UnprovedRoundError");
        const before = proved ? 0 : (failures.get(record.lane) ?? 0);
        failures.set(record.lane, record.outcome === "fail" ? before + 1 : 0);
      }
    });
  });
});

describe("law 5: the stop", () => {
  it("starts no round after the stop, leaves no timer of the loop, gives no record after it, and a second stop does nothing", async () => {
    await property({}, (each, r) => {
      expect(r.again).toBe(r.stopping);
      expect(r.calls.length).toBe(r.callsAtStop);
      expect(r.records.length).toBe(r.recordsAtStop);
      expect(r.liveAtStop).toBe(0);
      expect(r.timers.filter((timer) => timer.live)).toEqual([]);
      expect(r.handle.states()).toEqual(lanesOf(each.schedule).map(() => "stopped"));
      const stops = r.transitions.filter((transition) => transition.on === "stop");
      expect(stops.length).toBe(each.schedule.lanes);
      expect(r.transitions.slice(-each.schedule.lanes)).toEqual(stops);
    });
  });
});

describe("law 6: the budget", () => {
  it("starts at most `rounds` rounds in each window, and a deferred round waits for the end of its window", async () => {
    await property({ budget: true }, (each, r) => {
      const { rounds, per } = each.schedule.budget!;
      const window = valueOf(per);
      const starts = r.records.filter((record): record is RoundStart => record.kind === "start").map((start) => start.start);
      for (const first of starts) expect(starts.filter((at) => at >= first && at < first + window).length).toBeLessThanOrEqual(rounds);
      for (const record of r.records) if (record.kind === "defer") expect(record.until).toBeGreaterThan(record.at);
    });
  });
});

describe("law 7: the replay", () => {
  it("replays the transitions of each case on LOOP_MACHINE with no unknown transition", async () => {
    await property({}, (_each, r) => {
      expect(replay(LOOP_MACHINE, r.transitions)).toEqual([]);
    });
    await property({ budget: true }, (_each, r) => {
      expect(replay(LOOP_MACHINE, r.transitions)).toEqual([]);
    });
    await property({ stable: true }, (_each, r) => {
      expect(replay(LOOP_MACHINE, r.transitions)).toEqual([]);
    });
  });
});

describe("law 10: the hold", () => {
  it("with hold, keeps each timer referenced, and without it, keeps only the deadline of each round referenced", async () => {
    await property({ budget: true }, (each, r) => {
      const referenced = r.timers.filter((timer) => !timer.unref);
      if (each.schedule.hold) expect(referenced.length).toBe(r.timers.length);
      else {
        const deadlines = Number.isFinite(valueOf(each.schedule.timeout)) ? r.calls.length : 0;
        expect(referenced.length).toBe(deadlines);
      }
    });
  });
});
