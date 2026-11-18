// Law 8 of the loop core for the poller (SYS-138 part 2): on the same seed and the same scripted checks, the poller on
// the core gives the trace of its old code. The old code is here as it was, as a reference. The law goes with the old
// code, in the same pull request.

import { valueIn } from "@mark1russell7/quantity";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Cancel } from "./clock.ts";
import type { Outcome, Result } from "./latch.ts";
import { ms } from "./loop-rig.ts";
import { poller, type CheckFn, type Poller, type PollerOptions } from "./poller.ts";
import { fakeClock, seeded } from "./testing.ts";

/** The runs of the law. A deeper run sets LOOP_LAW_RUNS. */
const RUNS = Number(process.env["LOOP_LAW_RUNS"] ?? 100);

// ---------------------------------------------------------------------------------------------------------------------
// The old code, as it was before the loop core.

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const legacyPoller = (options: PollerOptions): Poller => {
  const { clock, poll, run } = options;
  const interval = valueIn(poll.interval, "ms");
  const timeout = valueIn(poll.timeout, "ms");
  let last: Result | null = null;
  let next: Cancel | null = null;
  let stopped = false;
  let looping = false;
  // the call that has not ended, and when it started; `late` once the call outlived its timeout
  let pending: { readonly since: number; late: boolean } | null = null;
  // the polls in flight: stop() ends each one, and its timer
  const active = new Set<() => void>();

  /** This function gives the name of the state, as the machine document of the poller names it. */
  const named = (): string =>
    stopped
      ? "stopped"
      : pending !== null
        ? pending.late
          ? "hung"
          : "calling"
        : looping
          ? "waiting"
          : "idle";
  const step = (on: string, change: () => void): void => {
    const from = named();
    change();
    options.trace?.(from, named(), on);
  };

  const result = (
    outcome: Outcome,
    started: number,
    fields: Partial<Pick<Result, "cause" | "timedOut" | "thrown" | "forced">> = {},
  ): Result => ({
    outcome,
    at: clock.now(),
    took: clock.now() - started,
    cause: fields.cause ?? null,
    timedOut: fields.timedOut ?? false,
    thrown: fields.thrown ?? false,
    forced: fields.forced ?? false,
  });

  const once = (): Promise<Result> => {
    const started = clock.now();
    if (options.forced())
      return Promise.resolve(result("error", started, { cause: "the force-fail list names it", forced: true }));
    if (pending !== null) {
      const cause = `its call of ${Math.round(started - pending.since)} ms ago is still pending`;
      return Promise.resolve(result("error", started, { cause }));
    }
    const controller = new AbortController();
    return new Promise<Result>((resolve) => {
      let done = false;
      const finish = (value: Result): void => {
        if (done) return;
        done = true;
        active.delete(abandon);
        cancel();
        resolve(value);
      };
      const abandon = (): void => {
        controller.abort();
        finish(result("error", started, { cause: "the runtime stopped" }));
      };
      active.add(abandon);
      const call = { since: started, late: false };
      pending = call;
      // a caller can await this poll, thus its timeout keeps the process alive (SYS-126)
      const cancel = clock.after(timeout, () => {
        controller.abort();
        // the poll fails at its timeout. The call stays pending until it settles
        step("timeout", () => {
          if (pending === call) call.late = true;
        });
        finish(result("error", started, { cause: `no answer in ${timeout} ms`, timedOut: true }));
      });
      const settled = (): void => {
        if (pending !== call) return;
        step(call.late ? "late-answer" : "answer", () => {
          pending = null;
        });
      };
      let answer: Promise<Outcome | void>;
      try {
        answer = Promise.resolve(run(controller.signal));
      } catch (error) {
        answer = Promise.reject(error);
      }
      answer.then(
        (value) => {
          settled();
          const outcome = value ?? "ok";
          finish(result(outcome, started, outcome === "ok" ? {} : { cause: `the check gave ${outcome}` }));
        },
        (error: unknown) => {
          settled();
          finish(result("error", started, { cause: message(error), thrown: true }));
        },
      );
    });
  };

  const handle = (value: Result): Result => {
    last = value;
    if (!stopped) options.record(value);
    return value;
  };

  const jittered = (): number => interval * (1 + poll.jitter * (2 * options.random() - 1));

  const tick = (): void => {
    next = null;
    if (stopped) return;
    let polled: Promise<Result> | undefined;
    step("tick", () => {
      next = clock.after(jittered(), tick);
      if (options.unrefLoop === true) next.unref?.();
      polled = once();
    });
    void polled!.then(handle);
  };

  return {
    get last() {
      return last;
    },
    pollNow: () => {
      let polled: Promise<Result> | undefined;
      step("sweep", () => {
        polled = once();
      });
      return polled!.then(handle);
    },
    start(delay) {
      if (stopped || next !== null) return;
      step("start", () => {
        looping = true;
        next = clock.after(Math.max(0, delay), tick);
        if (options.unrefLoop === true) next.unref?.();
      });
    },
    jittered,
    stop() {
      if (stopped) return;
      step("stop", () => {
        stopped = true;
        next?.();
        next = null;
      });
      for (const abandon of [...active]) abandon();
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// The cases.

/** A delay of a scripted check. Half a millisecond off the grid of the timers, or on it: the law holds for each. */
const delayOf = fc.tuple(fc.integer({ min: 0, max: 2000 }), fc.boolean()).map(([whole, half]) => whole + (half ? 0.5 : 0));

type Call =
  | { readonly kind: "answer"; readonly value: Outcome | "void"; readonly delay: number | null }
  | { readonly kind: "reject"; readonly delay: number | null }
  | { readonly kind: "throw" }
  | { readonly kind: "hang"; readonly heal: number | null };

const call: fc.Arbitrary<Call> = fc.oneof(
  fc.record({
    kind: fc.constant("answer" as const),
    value: fc.constantFrom("ok" as const, "void" as const, "error" as const, "indeterminate" as const),
    delay: fc.option(delayOf, { nil: null }),
  }),
  fc.record({ kind: fc.constant("reject" as const), delay: fc.option(delayOf, { nil: null }) }),
  fc.constant({ kind: "throw" as const }),
  fc.record({ kind: fc.constant("hang" as const), heal: fc.option(delayOf, { nil: null }) }),
);

interface PollCase {
  readonly interval: number;
  readonly timeout: number;
  readonly jitter: number;
  readonly seed: number;
  /** The force-fail list at each poll, in a cycle. */
  readonly forced: readonly boolean[];
  /** The behavior of each call of the check, in a cycle. */
  readonly calls: readonly Call[];
  /** The times of `pollNow()`. */
  readonly sweeps: readonly number[];
  readonly startAt: number;
  /** The first delay, or `jittered()` of the poller, as the health runtime gives it. */
  readonly delay: number | "jittered";
  readonly startAgain: boolean;
  readonly stopAt: number;
  readonly sweepAfterStop: boolean;
}

const pollCase: fc.Arbitrary<PollCase> = fc.record({
  interval: fc.integer({ min: 50, max: 500 }),
  timeout: fc.integer({ min: 20, max: 1500 }),
  jitter: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 49 }).map((n) => n / 100)),
  seed: fc.integer({ min: 1, max: 1_000_000 }),
  forced: fc.array(fc.integer({ min: 0, max: 4 }).map((n) => n === 0), { minLength: 1, maxLength: 6 }),
  calls: fc.array(call, { minLength: 1, maxLength: 10 }),
  sweeps: fc.array(fc.integer({ min: 0, max: 6000 }), { maxLength: 4 }),
  startAt: fc.integer({ min: 0, max: 1000 }),
  delay: fc.oneof(fc.integer({ min: -100, max: 1500 }), fc.constant("jittered" as const)),
  startAgain: fc.boolean(),
  stopAt: fc.integer({ min: 0, max: 8000 }),
  sweepAfterStop: fc.boolean(),
});

/** A time of the trace, to 1 µs: a planned time of the core and a time of the old timers differ by a rounding error. */
const at = (time: number): number => Math.round(time * 1000) / 1000;

const show = (result: Result | null): string =>
  result === null
    ? "none"
    : `${result.outcome} at=${at(result.at)} took=${at(result.took)} cause=${result.cause} timedOut=${result.timedOut} thrown=${result.thrown} forced=${result.forced}`;

/** This function operates one poller on a case, and gives each event with its time. */
const pollTrace = async (each: PollCase, make: (options: PollerOptions) => Poller): Promise<string[]> => {
  const clock = fakeClock();
  const events: string[] = [];
  const log = (event: string): void => {
    events.push(`${at(clock.now())} ${event}`);
  };
  let polls = 0;
  let calls = 0;
  const run: CheckFn = (signal) => {
    const index = calls++;
    const behavior = each.calls[index % each.calls.length]!;
    log(`call ${index}`);
    signal.addEventListener("abort", () => log(`abort ${index}`), { once: true });
    if (behavior.kind === "throw") throw new Error(`call ${index} threw`);
    if (behavior.kind === "hang")
      return new Promise<Outcome | void>((resolve) => {
        if (behavior.heal !== null) clock.after(behavior.heal, () => resolve("ok"));
      });
    if (behavior.delay === null) {
      if (behavior.kind === "reject") return Promise.reject(new Error(`call ${index} failed`));
      return behavior.value === "void" ? undefined : behavior.value;
    }
    const delay = behavior.delay;
    return new Promise<Outcome | void>((resolve, reject) => {
      clock.after(delay, () => {
        if (behavior.kind === "reject") reject(new Error(`call ${index} failed`));
        else resolve(behavior.value === "void" ? undefined : behavior.value);
      });
    });
  };
  const made = make({
    name: "law",
    poll: { interval: ms(each.interval), jitter: each.jitter, timeout: ms(each.timeout) },
    run,
    clock,
    random: seeded(each.seed),
    forced: () => each.forced[polls++ % each.forced.length]!,
    record: (result) => log(`record ${show(result)}`),
    trace: (from, to, on) => log(`${from} -${on}-> ${to}`),
  });
  for (const time of each.sweeps)
    clock.after(time, () => {
      log("sweep");
      void made.pollNow().then((result) => log(`swept ${show(result)}`));
    });
  clock.after(each.startAt, () => {
    made.start(each.delay === "jittered" ? made.jittered() : each.delay);
    if (each.startAgain) made.start(0);
  });
  await clock.advance(each.stopAt);
  log(`last ${show(made.last)}`);
  made.stop();
  if (each.sweepAfterStop) void made.pollNow().then((result) => log(`swept after stop ${show(result)}`));
  await clock.advance(5000);
  // the timers of the scripted check are the same in the two runs. A loop that did not stop keeps one more
  log(`end last=${show(made.last)} timers=${clock.pending}`);
  return events;
};

describe("law 8: the poller on the core gives the trace of its old code", () => {
  it("gives the same calls, aborts, transitions, records and sweeps for each check, each force-fail list and each start", async () => {
    await fc.assert(
      fc.asyncProperty(pollCase, async (each) => {
        const old = await pollTrace(each, legacyPoller);
        const core = await pollTrace(each, poller);
        expect(core).toEqual(old);
      }),
      { numRuns: RUNS, seed: 9 },
    );
  });
});
