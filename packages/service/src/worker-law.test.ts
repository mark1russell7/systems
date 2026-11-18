// Law 8 of the loop core for the worker loop (SYS-138 part 2): on the same seed and the same scripted iterations, the
// worker on the core gives the trace of its old code. The old code is here as it was, as a reference. The law goes with
// the old code, in the same pull request.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { backoffDelay } from "./backoff.ts";
import { realClock } from "./clock.ts";
import type { Lifecycle, ServiceBuilder } from "./index.ts";
import { service } from "./index.ts";
import { boundedMillisecondsOf, countOf, millisecondsOf } from "./knobs.ts";
import type { Scope } from "./scope.ts";
import type { FakeClock } from "./testing.ts";
import { detachedLifecycle, fakeClock, fakeProcess, seeded } from "./testing.ts";
import { boundProblems, closeWork, flights, retryOf, runUnit, settleWithin, sleeper } from "./units.ts";
import type { WorkerKnobs, WorkerLoop, WorkerLoopOptions } from "./worker.ts";
import { workerLoop } from "./worker.ts";

/** The runs of the law. A deeper run sets LOOP_LAW_RUNS. */
const RUNS = Number(process.env["LOOP_LAW_RUNS"] ?? 100);

// ---------------------------------------------------------------------------------------------------------------------
// The old code, as it was before the loop core.

const OWNER = "workerLoop";

const legacyWorkerLoop = <S = undefined>(knobs: WorkerKnobs, options: WorkerLoopOptions<S>): WorkerLoop => {
  const sleep = millisecondsOf(knobs, "worker_sleep", OWNER);
  const bound = millisecondsOf(knobs, "unit_processing_time", OWNER);
  const backoff = retryOf(knobs, OWNER);
  const closeBound = boundedMillisecondsOf(knobs, "close_bound", OWNER);
  const lanes = countOf(knobs, "concurrency", OWNER);
  if (!Number.isFinite(lanes)) throw new Error(`${OWNER} needs a concurrency with a bound: each lane is a loop`);
  const clock = options.clock ?? realClock;
  const random = options.random ?? Math.random;
  const running = flights(clock);
  const rests = sleeper(clock);
  const intake = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let started = false;
  let setup: Promise<S | undefined> | null = null;
  let state: S | undefined;
  let tornDown: Promise<void> | null = null;
  let closing: Promise<void> | null = null;

  const report = (error: unknown, failures: number): void => {
    try {
      options.onError?.(error, failures);
    } catch {
      // an error of the hook does not stop the loop
    }
  };
  const teardown = (): Promise<void> => {
    if (tornDown !== null) return tornDown;
    const release = options.teardown;
    const made = setup;
    tornDown =
      made === null || release === undefined
        ? Promise.resolve()
        : made.then(
            (given) => release(given),
            () => release(undefined),
          );
    return tornDown;
  };
  const keep = (work: Promise<unknown>): Promise<unknown> => {
    pending.add(work);
    const forget = (): void => {
      pending.delete(work);
    };
    work.then(forget, forget);
    return work;
  };

  const lane = async (index: number, work: Scope, life: Lifecycle): Promise<void> => {
    let failures = 0;
    let since = rests.wakes;
    await rests.sleep(0, since);
    for (;;) {
      if (intake.signal.aborted) return;
      since = rests.wakes;
      const remove = running.add();
      const end = await runUnit({
        work,
        kind: "round",
        name: `lane ${index}`,
        trace: undefined,
        identity: work.identity,
        facts: { intake: intake.signal, state: state as S, lane: index, failures, life },
        bound,
        life,
        request: options.request,
        unit: index,
        onError: (error) => report(error, 0),
        handle: (scope) => keep((async () => options.iteration(scope))()),
      });
      remove();
      if (end.kind === "cut") return;
      if (end.kind === "done") {
        failures = 0;
        await rests.sleep(end.value === "more" ? 0 : sleep, end.value === "more" ? rests.wakes : since);
        continue;
      }
      failures += 1;
      report(end.kind === "failed" ? end.error : new Error(`the service refused the iteration: ${end.cause}`), failures);
      await rests.backoff(backoffDelay(backoff, failures, random));
    }
  };

  return {
    knobs: { ...knobs },
    async start(signal, life) {
      if (closing !== null) throw new Error(`${OWNER}: a closed loop does not start again`);
      if (started) throw new Error(`${OWNER}: the loop started already`);
      started = true;
      const work = running.open(life.scope, OWNER);
      const make = options.setup;
      setup = make === undefined ? Promise.resolve(undefined) : new Promise<S>((resolve) => resolve(make(signal)));
      try {
        await setup.then((given) => {
          state = given;
        });
      } catch (error) {
        await settleWithin(clock, closeBound, teardown());
        throw error;
      }
      void life.started.then(() => {
        if (intake.signal.aborted || life.state !== "running") return;
        for (let index = 0; index < lanes; index += 1) lane(index, work, life).catch((error: unknown) => report(error, 0));
      });
    },
    stopIntake() {
      if (intake.signal.aborted) return;
      intake.abort(new Error(`${OWNER} stopped its intake`));
      rests.stop();
    },
    drain(deadline, signal) {
      return running.drain(deadline, signal);
    },
    inFlight: () => running.size,
    wake() {
      if (intake.signal.aborted) return false;
      rests.wake();
      return true;
    },
    close() {
      if (closing !== null) return closing;
      if (!intake.signal.aborted) intake.abort(new Error(`${OWNER} closed`));
      rests.stop();
      running.abort(new Error(`${OWNER} closed`));
      running.clear();
      closing = (async () => {
        const began = clock.now();
        const ended = await settleWithin(clock, closeBound, Promise.allSettled([...pending]));
        await closeWork(running, clock, Math.max(0, closeBound - (clock.now() - began)), OWNER, (error) => report(error, 0));
        const down = await settleWithin(clock, Math.max(0, closeBound - (clock.now() - began)), teardown());
        if (ended.kind === "bound")
          throw new Error(`${OWNER}: an iteration did not end in the close_bound of ${closeBound} ms after its abort`);
        if (down.kind === "failed") throw down.error;
        if (down.kind === "bound") throw new Error(`${OWNER}: the teardown did not end in the close_bound of ${closeBound} ms`);
      })();
      return closing;
    },
    problems(description) {
      return boundProblems(OWNER, description);
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// The cases.

const ms = (value: number) => ({ value, unit: "ms" });
const s = (value: number) => ({ value, unit: "s" });
const NONE = { value: "infinite", unit: "s" } as const;

/** The iterations of each lane. A lane with a zero sleep and no delay does them all at one time of the clock. */
const TURNS = 40;

/** A delay of a scripted iteration. Half a millisecond off the grid of the timers, or on it: the law holds for each. */
const delayOf = fc.tuple(fc.integer({ min: 0, max: 2000 }), fc.boolean()).map(([whole, half]) => whole + (half ? 0.5 : 0));

/**
 * The behavior of one iteration. "done", "more" and "throw" end at once or after a delay, and do not stop at the abort.
 * "hang" waits for the abort of its scope, then ends or throws. "stuck" does not end.
 */
type Step =
  | { readonly kind: "done" | "more" | "throw"; readonly delay: number | null }
  | { readonly kind: "hang"; readonly yields: boolean }
  | { readonly kind: "stuck" };

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constantFrom("done" as const, "more" as const, "throw" as const), delay: fc.option(delayOf, { nil: null }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("hang" as const), yields: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ kind: "stuck" as const }) },
);

interface WorkerCase {
  /** "direct" operates the stages of the transport by hand. "service" declares the worker and stops the service. */
  readonly mode: "direct" | "service";
  readonly sleep: number | null;
  readonly bound: number | null;
  readonly base: number;
  readonly cap: number;
  readonly closeBound: number;
  readonly lanes: number;
  readonly seed: number;
  /** The iterations of each lane, in a cycle. Each lane starts at its own place in the list. */
  readonly steps: readonly Step[];
  /** The times of `wake()`. */
  readonly wakes: readonly number[];
  /** The time at which the service refuses each later iteration: a refusal is a failure. Only in the mode "service". */
  readonly refuseAt: number | null;
  /** The time of the stop: the stop of the intake, or the signal of the service. */
  readonly stopAt: number;
  readonly wakeAfterStop: boolean;
  /** The deadline of the drain after the stop, and the time of the cooperative abort, in the mode "direct". */
  readonly drainFor: number;
  readonly abortAfter: number | null;
}

const workerCase: fc.Arbitrary<WorkerCase> = fc.record({
  mode: fc.constantFrom("direct" as const, "service" as const),
  sleep: fc.option(fc.integer({ min: 0, max: 3000 }), { nil: null }),
  bound: fc.option(fc.integer({ min: 20, max: 3000 }), { nil: null }),
  base: fc.integer({ min: 50, max: 1000 }),
  cap: fc.integer({ min: 1, max: 8 }),
  closeBound: fc.integer({ min: 100, max: 2000 }),
  lanes: fc.integer({ min: 1, max: 3 }),
  seed: fc.integer({ min: 1, max: 1_000_000 }),
  steps: fc.array(step, { minLength: 1, maxLength: 8 }),
  wakes: fc.array(fc.integer({ min: 0, max: 6000 }), { maxLength: 4 }),
  refuseAt: fc.option(fc.integer({ min: 0, max: 8000 }), { nil: null }),
  stopAt: fc.integer({ min: 0, max: 8000 }),
  wakeAfterStop: fc.boolean(),
  drainFor: fc.integer({ min: 0, max: 3000 }),
  abortAfter: fc.option(fc.integer({ min: 0, max: 3000 }), { nil: null }),
});

/** A time of the trace, to 1 µs: a planned time of the core and a time of the old timers differ by a rounding error. */
const at = (time: number): number => Math.round(time * 1000) / 1000;

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** This function gives a promise that ends when a signal aborts. */
const aborted = (given: AbortSignal): Promise<void> =>
  new Promise((resolve) => (given.aborted ? resolve() : given.addEventListener("abort", () => resolve(), { once: true })));

/** This function declares a service with the phases of a worker, and no checks. */
const declared = (svc: ServiceBuilder): ServiceBuilder =>
  svc
    .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(5) })
    .startup(s(10))
    .phase("stop intake", s(1))
    .phase("drain", s(10))
    .phase("close transports", s(3))
    .cooperativeWindow(s(5))
    .onRepeatSignal("ignore");

type Make = (knobs: WorkerKnobs, options: WorkerLoopOptions<undefined>) => WorkerLoop;

/** An event of a trace: its time, its lane or -1 for an event of the loop, and its text. */
interface TraceEvent {
  readonly time: number;
  readonly lane: number;
  readonly text: string;
}

/** This function gives the lane that an error names, or -1. */
const laneOf = (text: string): number => {
  const named = /\bL(\d)#|"lane (\d)"/.exec(text);
  return named === null ? -1 : Number(named[1] ?? named[2]);
};

/**
 * This function gives the canonical form of a trace. The lanes are independent: at one time, the order of two lanes is
 * not part of the contract. Thus the events of one time go by lane, each lane in its own order. The events of the loop
 * come first, in the order of their text.
 */
const canonical = (events: readonly TraceEvent[]): string[] =>
  events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        a.event.time - b.event.time ||
        a.event.lane - b.event.lane ||
        (a.event.lane === -1 ? a.event.text.localeCompare(b.event.text) : a.index - b.index),
    )
    .map(({ event }) => `${event.time} ${event.lane === -1 ? "loop" : `L${event.lane}`} ${event.text}`);

/** This function operates one worker loop on a case, and gives each event with its time. */
const workerTrace = async (each: WorkerCase, make: Make): Promise<string[]> => {
  const clock: FakeClock = fakeClock();
  const events: TraceEvent[] = [];
  const log = (text: string, lane = -1): void => {
    events.push({ time: at(clock.now()), lane, text });
  };
  const counts = Array.from({ length: each.lanes }, () => 0);
  const knobs: WorkerKnobs = {
    worker_sleep: each.sleep === null ? NONE : ms(each.sleep),
    unit_processing_time: each.bound === null ? NONE : ms(each.bound),
    retry_base: ms(each.base),
    retry_cap: ms(each.base * each.cap),
    close_bound: ms(each.closeBound),
    concurrency: { value: each.lanes, unit: "count" },
  };
  const declare = each.mode === "service";
  const loop = make(knobs, {
    clock,
    // with one lane, the seeded random also counts the draws. With more lanes, two lanes can fail at one time, in either
    // order: each draw then gives the same number
    random: each.lanes === 1 ? seeded(each.seed) : () => (each.seed % 1000) / 1000,
    ...(declare ? { request: { controller: "work", route: "RUN" } } : {}),
    onError: (error, failures) => log(`error failures=${failures} ${describeError(error)}`, laneOf(describeError(error))),
    iteration: async ({ signal, lane, failures }) => {
      const turn = counts[lane]!++;
      const name = `L${lane}#${turn}`;
      // a lane with a zero sleep or "more" does each later iteration at the same time: after its last turn it waits for its abort
      const behavior: Step = turn < TURNS ? each.steps[(lane * 3 + turn) % each.steps.length]! : { kind: "hang", yields: true };
      log(`start ${name} failures=${failures}`, lane);
      signal.addEventListener("abort", () => log(`abort ${name} ${describeError(signal.reason)}`, lane), { once: true });
      if (behavior.kind === "stuck") return new Promise<never>(() => {});
      if (behavior.kind === "hang") {
        await aborted(signal);
        log(`end ${name} at its abort`, lane);
        if (behavior.yields) return undefined;
        throw new Error(`${name} stopped at its abort`);
      }
      if (behavior.delay !== null) {
        const delay = behavior.delay;
        await new Promise<void>((resolve) => clock.after(delay, resolve));
      }
      log(`end ${name} ${behavior.kind}`, lane);
      if (behavior.kind === "throw") throw new Error(`${name} threw`);
      return behavior.kind === "more" ? "more" : undefined;
    },
  });
  if (declare) {
    const svc = declared(service("law")).worker("work", loop.knobs, loop);
    svc.controller("work").route("RUN", { idempotent: true });
    const process = fakeProcess({ clock });
    let started = false;
    const run = svc.run({ clock, process }).finally(() => {
      started = true;
    });
    for (let turn = 0; turn < 50 && !started; turn += 1) await clock.advance(0);
    const life = await run;
    for (const time of each.wakes) clock.after(time, () => log(`wake ${loop.wake()}`));
    if (each.refuseAt !== null)
      clock.after(each.refuseAt, () => {
        log("refuse");
        life.health.drain();
      });
    await clock.advance(each.stopAt);
    log(`stop inFlight=${loop.inFlight()}`);
    process.signal("SIGTERM");
    if (each.wakeAfterStop) clock.after(0, () => log(`wake after stop ${loop.wake()}`));
    let code: number | null = null;
    void life.done.then((given) => {
      code = given;
    });
    for (let turn = 0; turn < 100 && code === null; turn += 1) await clock.advance(500);
    log(`done code=${code} exits=${process.exits.join(",")}`);
  } else {
    for (const time of each.wakes) clock.after(time, () => log(`wake ${loop.wake()}`));
    await loop.start(new AbortController().signal, detachedLifecycle(clock));
    await clock.advance(each.stopAt);
    log(`stop inFlight=${loop.inFlight()}`);
    await loop.stopIntake();
    if (each.wakeAfterStop) log(`wake after stop ${loop.wake()}`);
    const cooperative = new AbortController();
    void Promise.resolve(loop.drain(clock.now() + each.drainFor, cooperative.signal)).then(() =>
      log(`drained inFlight=${loop.inFlight()}`),
    );
    if (each.abortAfter !== null)
      clock.after(each.abortAfter, () => {
        log("cooperative abort");
        cooperative.abort(new Error("the cooperative abort"));
      });
    await clock.advance(each.drainFor + 1);
    log(`close inFlight=${loop.inFlight()}`);
    const closed = loop.close().then(
      () => log("closed"),
      (error: unknown) => log(`close failed ${describeError(error)}`),
    );
    await clock.advance(each.closeBound + 1);
    await closed;
  }
  await clock.advance(6000);
  // the timers of the scripted iterations are the same in the two runs. A loop that did not stop keeps one more
  log(`end inFlight=${loop.inFlight()} timers=${clock.pending}`);
  return canonical(events);
};

describe("law 8: the worker loop on the core gives the trace of its old code", () => {
  it("gives the same iterations, aborts, failures, wakes, drains and closes for each script, each knob and each stop", async () => {
    await fc.assert(
      fc.asyncProperty(workerCase, async (each) => {
        const old = await workerTrace(each, legacyWorkerLoop);
        const core = await workerTrace(each, workerLoop);
        expect(core).toEqual(old);
      }),
      { numRuns: RUNS, seed: 9 },
    );
  });
});
