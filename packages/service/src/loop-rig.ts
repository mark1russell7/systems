// The rig of the loop tests (SYS-138): a fake clock that records each timer, and a loop whose rounds follow a script.
// The unit tests in `loop.test.ts` and the law tests in `loop-laws.test.ts` share it.

import type { Transition } from "@mark1russell7/algebra/replay";
import type { Quantity } from "@mark1russell7/quantity";
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
export const rig = (schedule: Schedule, script: (round: number) => Script, options: { readonly random?: () => number } = {}): Rig => {
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
    record: (record) => records.push(record),
    onTransition: (transition) => transitions.push(transition),
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
