// The rig of the loop tests (SYS-138): a fake clock that records each timer, and a loop whose rounds follow a script.
// The unit tests in `loop.test.ts` and the law tests in `loop-laws.test.ts` share it.

import type { Transition } from "@mark1russell7/algebra/replay";
import type { Quantity } from "@mark1russell7/quantity";
import fc from "fast-check";
import type { Backoff } from "./backoff.ts";
import type { Clock } from "./clock.ts";
import type { FakeClock } from "./fakes.ts";
import type { Loop, LoopRecord, Round, RoundEnd, Schedule } from "./loop.ts";
import { loop } from "./loop.ts";
import { fakeClock, seeded } from "./testing.ts";

export const ms = (value: number): Quantity => ({ value, unit: "ms" });
export const s = (value: number): Quantity => ({ value, unit: "s" });

/** One scripted round: it settles after `duration` with its outcome. */
export interface Script {
  readonly duration: number;
  readonly outcome: "pass" | "more" | "fail";
  /** `true`: the round does not stop at the abort of its signal. */
  readonly ignores?: boolean;
  /** The round uses `reset()` at this time after its start. */
  readonly proofAt?: number;
}

/** One timer of a recording clock: its delay, `true` if its `unref` was used, and `true` while it can still fire. */
export interface RecordedTimer {
  readonly ms: number;
  unref: boolean;
  live: boolean;
}

/** A recording clock: the fake clock that moves it, the clock for the code under test, and each timer of that clock. */
export interface RecordingClock {
  readonly fake: FakeClock;
  readonly clock: Clock;
  readonly timers: RecordedTimer[];
}

/** This clock moves as a fake clock. It records each timer: its delay, its `unref` and its state (live or not). */
export const recordingClock = (): RecordingClock => {
  const fake = fakeClock();
  const timers: RecordedTimer[] = [];
  const clock: Clock = {
    now: () => fake.now(),
    after: (delay, run) => {
      const timer: RecordedTimer = { ms: delay, unref: false, live: true };
      timers.push(timer);
      const cancel = fake.after(delay, () => {
        timer.live = false;
        run();
      });
      return Object.assign(
        () => {
          timer.live = false;
          cancel();
        },
        {
          unref: () => {
            timer.unref = true;
          },
        },
      );
    },
  };
  return { fake, clock, timers };
};

/** One use of the round function: its round, lane, start and count of failures, and when its signal aborted and it settled. */
export interface Call {
  readonly round: number;
  readonly lane: number;
  readonly at: number;
  readonly failures: number;
  abortedAt: number | undefined;
  reason: unknown;
  settledAt: number | undefined;
}

/** A loop with scripted rounds on a recording clock, and what it reported. */
export interface Rig {
  readonly fake: FakeClock;
  readonly timers: RecordedTimer[];
  readonly records: LoopRecord[];
  readonly transitions: Transition[];
  readonly calls: Call[];
  readonly handle: Loop;
  /** The end records, in order. */
  ends(): RoundEnd[];
  /** The start time of each round, in order. */
  starts(): number[];
}

/** This function makes a loop of `schedule` whose round `n` follows `script(n)`. The loop is not started. */
/** The options of a rig: the random source of the jitter, and a tap that also gets each record and each transition. */
export interface RigOptions {
  readonly random?: () => number;
  readonly tap?: { readonly record: (record: LoopRecord) => void; readonly onTransition: (transition: Transition) => void };
}

export const rig = (schedule: Schedule, script: (round: number) => Script, options: RigOptions = {}): Rig => {
  const { fake, clock, timers } = recordingClock();
  const records: LoopRecord[] = [];
  const transitions: Transition[] = [];
  const calls: Call[] = [];
  const round: Round = (context) => {
    const call: Call = { round: context.round, lane: context.lane, at: fake.now(), failures: context.failures, abortedAt: undefined, reason: undefined, settledAt: undefined };
    calls.push(call);
    const step = script(context.round);
    return new Promise<void | "more">((resolve, reject) => {
      if (step.proofAt !== undefined)
        fake.after(step.proofAt, () => {
          if (call.settledAt === undefined) context.reset();
        });
      const cancel = fake.after(step.duration, () => {
        call.settledAt = fake.now();
        if (step.outcome === "fail") reject(new Error(`round ${context.round} failed`));
        else resolve(step.outcome === "more" ? "more" : undefined);
      });
      context.signal.addEventListener(
        "abort",
        () => {
          if (call.settledAt !== undefined) return;
          call.abortedAt = fake.now();
          call.reason = context.signal.reason;
          if (step.ignores === true) return;
          cancel();
          call.settledAt = fake.now();
          reject(context.signal.reason);
        },
        { once: true },
      );
    });
  };
  const handle = loop(schedule, round, {
    name: "l",
    clock,
    random: options.random ?? seeded(7),
    record: (record) => {
      records.push(record);
      options.tap?.record(record);
    },
    onTransition: (transition) => {
      transitions.push(transition);
      options.tap?.onTransition(transition);
    },
  });
  const ends = (): RoundEnd[] => records.filter((record): record is RoundEnd => record.kind === "end");
  const starts = (): number[] => calls.map((call) => call.at);
  return { fake, timers, records, transitions, calls, handle, ends, starts };
};

export const base = (patch: Partial<Schedule>): Schedule => ({
  from: "start",
  period: ms(100),
  jitter: 0,
  first: ms(0),
  timeout: { value: "infinite", unit: "s" },
  backoff: null,
  overlap: "fail",
  lanes: 1,
  budget: null,
  hold: true,
  stable: null,
  ...patch,
});

export const pass = (duration = 10): Script => ({ duration, outcome: "pass" });
export const fail = (duration = 10): Script => ({ duration, outcome: "fail" });
export const NO_JITTER: Backoff = { base: 10, factor: 2, cap: 1000 };

/** The last time of a case: its stop comes before this time, and the clock moves this far again after the stop. */
export const HORIZON = 600;

/** A case of the law tests: a schedule with no problems, a script for each round, a seed and the time of the stop. */
export interface Case {
  readonly schedule: Schedule;
  readonly scripts: readonly Script[];
  readonly seed: number;
  readonly stopAt: number;
}

export const backoffOf: fc.Arbitrary<Backoff> = fc
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

export const scriptOf = (stable: boolean): fc.Arbitrary<Script> =>
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

/** The shape of the cases of a law: each field fixes one dimension of the case. */
export interface Shape {
  readonly from?: Schedule["from"];
  readonly backoff?: "none" | "some" | "any";
  readonly budget?: boolean;
  readonly more?: boolean;
  readonly ignores?: boolean;
  readonly stable?: boolean;
  readonly timeout?: boolean;
}

/** This arbitrary gives a case: a schedule with no problems, a script for each round, a seed and the time of the stop. */
export const caseOf = (shape: Shape = {}): fc.Arbitrary<Case> =>
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
