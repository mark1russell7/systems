import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import type { Lifecycle, ServiceBuilder, WorkerKnobs } from "./index.ts";
import { lint, service, workerLoop } from "./index.ts";
import type { Rule } from "./law.ts";
import type { ConformanceRecord, FakeClock, HeldWork, TransportSubject } from "./testing.ts";
import { detachedLifecycle, fakeClock, fakeProcess, transportConformance } from "./testing.ts";

/**
 * SYS-14: the worker loop as a transport (S6 A10). Each test uses the fake clock. The loop passes
 * the conformance kit of SYS-4 with one lane and with three lanes, with the request tracking of a
 * service and without it. The real clock runs in CI only (HTTP_IT=1, src/units-it.test.ts).
 */

const s = (value: number) => ({ value, unit: "s" });
const count = (value: number) => ({ value, unit: "count" });
const NONE = { value: "infinite", unit: "s" } as const;
const KNOBS: WorkerKnobs = {
  worker_sleep: s(10),
  unit_processing_time: NONE,
  retry_base: s(1),
  retry_cap: s(8),
  close_bound: s(2),
  concurrency: count(1),
};
const signal = (): AbortSignal => new AbortController().signal;
/** This function gives a promise and the function that ends it. */
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
/** This function gives a promise that ends when a signal aborts. */
const aborted = (given: AbortSignal): Promise<void> =>
  new Promise((resolve) => (given.aborted ? resolve() : given.addEventListener("abort", () => resolve(), { once: true })));
/** This function waits on the clock, or until the abort of a cooperative work. */
const pause = (clock: Clock, ms: number, given: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    clock.after(ms, resolve);
    void aborted(given).then(resolve);
  });

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

/** This function runs a declaration on a fake clock, and gives the lifecycle when its startup ends. */
const running = async (svc: ServiceBuilder, clock: FakeClock): Promise<{ life: Lifecycle; process: ReturnType<typeof fakeProcess> }> => {
  const process = fakeProcess({ clock });
  let ended = false;
  const run = svc.run({ clock, process }).finally(() => {
    ended = true;
  });
  for (let step = 0; step < 50 && !ended; step += 1) await clock.advance(0);
  return { life: await run, process };
};

describe("workerLoop: the iterations on the clock (S6 A10)", () => {
  it("starts the first iteration after the startup, and sleeps from the end of each iteration", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const loop = workerLoop(KNOBS, {
      clock,
      iteration: ({ signal: given }) => {
        starts.push(clock.now());
        return pause(clock, 3000, given);
      },
    });
    await loop.start(signal(), detachedLifecycle());
    expect(loop.inFlight()).toBe(0);
    await clock.advance(0);
    expect(starts).toEqual([0]);
    expect(loop.inFlight()).toBe(1);
    await clock.advance(3000);
    expect(loop.inFlight()).toBe(0);
    await clock.advance(9999);
    expect(starts).toEqual([0]);
    await clock.advance(1);
    expect(starts).toEqual([0, 13_000]);
    await loop.close();
  });

  it("starts the next iteration at once after an iteration that gives \"more\"", async () => {
    const clock = fakeClock();
    let calls = 0;
    const loop = workerLoop(KNOBS, {
      clock,
      iteration: () => {
        calls += 1;
        return calls < 3 ? "more" : undefined;
      },
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect(calls).toBe(3);
    await clock.advance(9999);
    expect(calls).toBe(3);
    await clock.advance(1);
    expect(calls).toBe(4);
    await loop.close();
  });

  it("backs off after each failure, two times longer up to the cap, and a success ends the sequence", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const seen: number[] = [];
    const errors: Array<[string, number]> = [];
    const loop = workerLoop(KNOBS, {
      clock,
      // no jitter: each delay is the backoff
      random: () => 0,
      onError: (error, failures) => void errors.push([(error as Error).message, failures]),
      iteration: ({ failures }) => {
        starts.push(clock.now());
        seen.push(failures);
        if (starts.length <= 5) throw new Error(`failure ${starts.length}`);
      },
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(40_000);
    // 1, 2, 4, 8 and 8 s (the cap), then a success and a sleep of 10 s
    expect(starts).toEqual([0, 1000, 3000, 7000, 15_000, 23_000, 33_000]);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 0]);
    expect(errors).toEqual([1, 2, 3, 4, 5].map((at) => [`failure ${at}`, at]));
    await loop.close();
  });

  it("adds a jitter up to retry_base to each backoff", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const loop = workerLoop(KNOBS, {
      clock,
      random: () => 0.5,
      iteration: () => {
        starts.push(clock.now());
        if (starts.length <= 2) throw new Error("failure");
      },
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(5000);
    // 1 s + 0.5 s, then 2 s + 0.5 s
    expect(starts).toEqual([0, 1500, 4000]);
    await loop.close();
  });

  it("ends a sleep at wake(), also a wake during the iteration, but not a backoff", async () => {
    const clock = fakeClock();
    let calls = 0;
    const hold = gate();
    const loop = workerLoop({ ...KNOBS, worker_sleep: NONE }, {
      clock,
      random: () => 0,
      iteration: async () => {
        calls += 1;
        if (calls === 2) await hold.promise;
        if (calls === 4) throw new Error("failure");
      },
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect(calls).toBe(1);
    // a sleep without a bound waits for wake()
    await clock.advance(1_000_000);
    expect(calls).toBe(1);
    expect(loop.wake()).toBe(true);
    await clock.advance(0);
    expect(calls).toBe(2);
    // a wake during the iteration ends the sleep after it
    loop.wake();
    hold.open();
    await clock.advance(0);
    expect(calls).toBe(3);
    loop.wake();
    await clock.advance(0);
    expect(calls).toBe(4);
    // the fourth failed: the backoff of 1 s does not end at wake()
    loop.wake();
    await clock.advance(0);
    expect(calls).toBe(4);
    await clock.advance(1000);
    expect(calls).toBe(5);
    await loop.close();
  });

  it("starts no new iteration after stopIntake, ends each sleep and leaves no timer", async () => {
    const clock = fakeClock();
    let calls = 0;
    const loop = workerLoop(KNOBS, {
      clock,
      iteration: () => {
        calls += 1;
      },
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect(calls).toBe(1);
    expect(clock.pending).toBe(1);
    await loop.stopIntake();
    expect(clock.pending).toBe(0);
    expect(loop.wake()).toBe(false);
    await clock.advance(100_000);
    expect(calls).toBe(1);
    await loop.close();
    expect(clock.pending).toBe(0);
  });

  it("drains the iteration in flight, gives it the cooperative abort, and does not count its throw as a failure", async () => {
    const clock = fakeClock();
    const errors: unknown[] = [];
    const loop = workerLoop(KNOBS, {
      clock,
      onError: (error) => void errors.push(error),
      iteration: async ({ signal: given }) => {
        await aborted(given);
        throw new Error("the iteration stopped at its abort");
      },
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(0);
    await loop.stopIntake();
    const cooperative = new AbortController();
    let drained = false;
    void Promise.resolve(loop.drain(clock.now() + 5000, cooperative.signal)).then(() => {
      drained = true;
    });
    await clock.advance(2000);
    expect(drained).toBe(false);
    expect(loop.inFlight()).toBe(1);
    cooperative.abort(new Error("the cooperative abort"));
    await clock.advance(0);
    expect(drained).toBe(true);
    expect(loop.inFlight()).toBe(0);
    expect(errors).toEqual([]);
    await loop.close();
  });

  it("aborts an iteration at unit_processing_time, and counts a throw after it as a failure", async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const errors: Array<[string, number]> = [];
    const loop = workerLoop({ ...KNOBS, unit_processing_time: s(2) }, {
      clock,
      random: () => 0,
      onError: (error, failures) => void errors.push([(error as Error).message, failures]),
      iteration: async ({ signal: given }) => {
        starts.push(clock.now());
        await aborted(given);
        throw new Error("aborted");
      },
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(0);
    await clock.advance(2000);
    expect(errors).toEqual([["the unit did not end in its unit_processing_time of 2000 ms", 1]]);
    // the backoff of 1 s after the failure
    await clock.advance(1000);
    expect(starts).toEqual([0, 3000]);
    await loop.close();
  });

  it("does not overlap two iterations of a lane: an iteration that ignores its abort holds its lane", async () => {
    const clock = fakeClock();
    const hold = gate();
    let calls = 0;
    const loop = workerLoop({ ...KNOBS, unit_processing_time: s(1) }, {
      clock,
      iteration: async () => {
        calls += 1;
        if (calls === 1) await hold.promise;
      },
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(0);
    await clock.advance(60_000);
    expect(calls).toBe(1);
    expect(loop.inFlight()).toBe(1);
    hold.open();
    await clock.advance(0);
    expect(loop.inFlight()).toBe(0);
    expect(calls).toBe(1);
    // the sleep starts at the end of the first iteration
    await clock.advance(10_000);
    expect(calls).toBe(2);
    await loop.stopIntake();
    await loop.close();
  });

  it("runs each lane one iteration at a time, and the count is the iterations in flight", async () => {
    const clock = fakeClock();
    const holds: Array<() => void> = [];
    const lanes: number[] = [];
    const loop = workerLoop({ ...KNOBS, concurrency: count(3) }, {
      clock,
      iteration: ({ lane, signal: given }) => {
        lanes.push(lane);
        return new Promise<void>((resolve) => {
          holds.push(resolve);
          void aborted(given).then(resolve);
        });
      },
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect(lanes).toEqual([0, 1, 2]);
    expect(loop.inFlight()).toBe(3);
    holds[1]!();
    await clock.advance(0);
    expect(loop.inFlight()).toBe(2);
    await loop.stopIntake();
    await loop.close();
    expect(loop.inFlight()).toBe(0);
  });
});

describe("workerLoop: the setup, the close and the teardown", () => {
  it("gives the state of the setup to each iteration, and the close aborts, waits and then tears down", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const loop = workerLoop(KNOBS, {
      clock,
      setup: (given) => {
        log.push(`setup ${given.aborted ? "aborted" : "live"}`);
        return { connection: "c1" };
      },
      iteration: async ({ state, signal: given }) => {
        log.push(`iteration on ${state.connection}`);
        await aborted(given);
        log.push("iteration ends");
      },
      teardown: (state) => void log.push(`teardown of ${state?.connection ?? "nothing"}`),
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(0);
    await loop.close();
    expect(log).toEqual(["setup live", "iteration on c1", "iteration ends", "teardown of c1"]);
    // a second close gives the same promise, and the teardown occurs one time
    expect(loop.close()).toBe(loop.close());
    await loop.close();
    expect(log.filter((line) => line.startsWith("teardown"))).toHaveLength(1);
  });

  it("tears down after a failed setup, and the start throws", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const loop = workerLoop(KNOBS, {
      clock,
      setup: () => {
        throw new Error("the connection failed");
      },
      iteration: () => void log.push("iteration"),
      teardown: (state) => void log.push(`teardown of ${String(state)}`),
    });
    await expect(loop.start(signal(), detachedLifecycle())).rejects.toThrow("the connection failed");
    await loop.close();
    await clock.advance(100_000);
    expect(log).toEqual(["teardown of undefined"]);
  });

  it("tears down at the close also without a setup, and not without a start", async () => {
    const log: string[] = [];
    const teardown = (): void => void log.push("teardown");
    const started = workerLoop(KNOBS, { clock: fakeClock(), iteration: () => {}, teardown });
    await started.start(signal(), detachedLifecycle());
    await started.close();
    await workerLoop(KNOBS, { clock: fakeClock(), iteration: () => {}, teardown }).close();
    expect(log).toEqual(["teardown"]);
  });

  it("holds the close to its close_bound, and the teardown still occurs", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const loop = workerLoop(KNOBS, {
      clock,
      // the iteration ignores its abort
      iteration: () => new Promise<void>(() => {}),
      teardown: () => void log.push("teardown"),
    });
    await loop.start(signal(), detachedLifecycle());
    await clock.advance(0);
    let failure: unknown = null;
    void Promise.resolve(loop.close()).catch((error: unknown) => {
      failure = error;
    });
    await clock.advance(1999);
    expect(failure).toBeNull();
    expect(loop.inFlight()).toBe(0);
    await clock.advance(1);
    expect(String(failure)).toMatch(/an iteration did not end in the close_bound of 2000 ms after its abort/);
    expect(log).toEqual(["teardown"]);
  });

  it("refuses knobs that it cannot use: the loop has no defaults", () => {
    const iteration = (): void => {};
    const without = Object.fromEntries(Object.entries(KNOBS).filter(([name]) => name !== "worker_sleep")) as unknown as WorkerKnobs;
    expect(() => workerLoop(without, { iteration })).toThrow("workerLoop needs the knob worker_sleep: it has no defaults");
    expect(() => workerLoop({ ...KNOBS, concurrency: { value: "infinite", unit: "count" } as never }, { iteration })).toThrow(/needs a concurrency with a bound/);
    expect(() => workerLoop({ ...KNOBS, concurrency: count(1.5) }, { iteration })).toThrow(/not a whole number above zero/);
    expect(() => workerLoop({ ...KNOBS, concurrency: s(1) }, { iteration })).toThrow("the knob concurrency is not a count");
    expect(() => workerLoop({ ...KNOBS, retry_cap: { value: 0.5, unit: "s" } }, { iteration })).toThrow(/the cap 500 is below the base 1000/);
    expect(() => workerLoop({ ...KNOBS, close_bound: NONE as never }, { iteration })).toThrow(/close_bound of workerLoop has no bound/);
    expect(() => workerLoop({ ...KNOBS, worker_sleep: count(3) }, { iteration })).toThrow("the knob worker_sleep is not a time");
  });
});

describe("workerLoop in a service: the declaration, the law and the request tracking", () => {
  it("gives its knobs to describe(), and lint() applies O20 to each worker", () => {
    const O20: Rule = {
      id: "O20",
      rule: "Progress-liveness and lease windows exceed the legitimate processing time of one unit, with margin",
      expr: {
        lhs: { terms: [{ knob: "lease_duration", coef: 1, at: "broker" }] },
        op: ">",
        rhs: { terms: [{ knob: "unit_processing_time", coef: 1, at: "consumer" }] },
      },
      expr_more: [
        {
          lhs: { terms: [{ knob: "lease_duration", coef: 1, at: "broker" }] },
          op: ">=",
          rhs: { terms: [{ knob: "unit_processing_time", coef: 10, at: "consumer" }] },
        },
      ],
    };
    const bounded = workerLoop({ ...KNOBS, unit_processing_time: s(60), "lease_duration@broker": s(600) }, { iteration: () => {} });
    const short = workerLoop({ ...KNOBS, unit_processing_time: s(60) }, { iteration: () => {} });
    const open = workerLoop(KNOBS, { iteration: () => {} });
    const svc = declared(service("app"))
      .worker("staleness", bounded.knobs, bounded)
      .worker("lease", short.knobs, short)
      .worker("open", open.knobs, open)
      .server("http", { server_idle_close: s(5) });
    const description = svc.describe();
    expect(description.transports.find((each) => each.name === "staleness")).toEqual({
      name: "staleness",
      kind: "worker",
      knobs: { ...KNOBS, unit_processing_time: s(60), "lease_duration@broker": s(600) },
    });
    const scenario = {
      platform: {},
      probes: { readiness: s(10), liveness: s(30) },
      transports: { lease: { "lease_duration@broker": s(300) }, open: { "lease_duration@broker": s(300) } },
    };
    const findings = lint(description, scenario, [O20]);
    // one finding for each worker, and none for the server
    expect(findings.map((finding) => [finding.scope, finding.verdict])).toEqual([
      ["staleness", "holds"],
      ["lease", "violated"],
      ["open", "violated"],
    ]);
    expect(lint(declared(service("lone")).worker("w", open.knobs, open).describe(), scenario, [O20])[0]).toMatchObject({
      verdict: "depends",
      unbound: ["lease_duration@broker"],
    });
  });

  it("gives the problems of its bounds against the caps of the declaration", () => {
    const open = workerLoop(KNOBS, { iteration: () => {} });
    const fits = workerLoop({ ...KNOBS, unit_processing_time: s(5) }, { iteration: () => {} });
    const description = declared(service("app")).describe();
    expect(open.problems(description)).toEqual([
      "the unit_processing_time of workerLoop has no bound, thus the drain can cut a unit at its cap of 10000 ms",
    ]);
    expect(fits.problems(description)).toEqual([]);
    const long = workerLoop({ ...KNOBS, unit_processing_time: s(10), close_bound: s(3) }, { iteration: () => {} });
    expect(long.problems(description)).toEqual([
      'the close_bound of workerLoop, 3000 ms, does not fit in the cap of "close transports", 3000 ms',
      'the unit_processing_time of workerLoop, 10000 ms, does not fit in the cap of "drain", 10000 ms',
    ]);
  });

  it("puts each iteration through life.request, and the shutdown drains it, cuts no failure and tears down", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const errors: unknown[] = [];
    const loop = workerLoop({ ...KNOBS, worker_sleep: s(5) }, {
      clock,
      request: { controller: "beat", route: "BEAT" },
      onError: (error) => void errors.push(error),
      iteration: async ({ signal: given, life }) => {
        log.push(`iteration at ${clock.now()}, ${life.inFlight("beat")} in flight`);
        if (log.length < 2) return;
        await aborted(given);
        log.push(`abort at ${clock.now()}`);
        throw new Error("the iteration stopped at its abort");
      },
      teardown: () => void log.push(`teardown at ${clock.now()}`),
    });
    const svc = declared(service("app")).worker("beat", loop.knobs, loop);
    svc.controller("beat").route("BEAT", { idempotent: true });
    const ran = await running(svc, clock);
    await clock.advance(5000);
    expect(log).toEqual(["iteration at 0, 1 in flight", "iteration at 5000, 1 in flight"]);
    ran.process.signal("SIGTERM");
    let code: number | null = null;
    void ran.life.done.then((given) => {
      code = given;
    });
    for (let step = 0; step < 100 && code === null; step += 1) await clock.advance(500);
    // the drain of 10 s gives the cooperative abort at 5 s, the iteration ends at it, and the close tears down
    expect(log.slice(2)).toEqual(["abort at 10000", "teardown at 10000"]);
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(ran.process.exits).toEqual([0]);
  });

  it("backs off while the service refuses its iterations", async () => {
    const clock = fakeClock();
    const errors: string[] = [];
    let calls = 0;
    const loop = workerLoop(KNOBS, {
      clock,
      random: () => 0,
      request: { controller: "beat", route: "BEAT" },
      onError: (error) => void errors.push((error as Error).message),
      iteration: () => {
        calls += 1;
      },
    });
    const svc = declared(service("app")).worker("beat", loop.knobs, loop);
    svc.controller("beat").route("BEAT", { idempotent: true });
    const { life } = await running(svc, clock);
    await clock.advance(0);
    expect(calls).toBe(1);
    // the drain fails readiness for good: each later iteration gets a refusal
    life.health.drain();
    // the sleep ends at 10 s, and the backoff after the first refusal is 1 s
    await clock.advance(10_000);
    await clock.advance(2999);
    expect(calls).toBe(1);
    expect(errors).toEqual([
      "the service refused the iteration: controller beat is not ready",
      "the service refused the iteration: controller beat is not ready",
    ]);
    await loop.stopIntake();
    await loop.close();
  });
});

/** The subject of the kit: each lane takes a task from a list, and `wake()` offers the task. */
const workerSubject =
  (lanes: number, tracked: boolean) =>
  async (clock: Clock): Promise<TransportSubject> => {
    interface Task {
      run(signal: AbortSignal): Promise<void>;
    }
    const tasks: Task[] = [];
    let life: Lifecycle | undefined;
    if (tracked) {
      const svc = declared(service("kit"));
      svc.controller("work").route("RUN", { idempotent: true });
      const process = fakeProcess();
      const run = svc.run({ clock, process });
      // the kit gives a fake clock or the real clock: the startup of a service with no checks ends at once
      if ("advance" in clock) for (let step = 0; step < 10; step += 1) await (clock as FakeClock).advance(0);
      life = await run;
    }
    const loop = workerLoop(
      { ...KNOBS, worker_sleep: NONE, concurrency: count(lanes) },
      {
        clock,
        ...(tracked ? { request: { controller: "work", route: "RUN" } } : {}),
        iteration: async ({ signal: given }) => {
          await tasks.shift()?.run(given);
        },
      },
    );
    return {
      impl: loop,
      life,
      async offer() {
        const done = gate();
        const task: Task = {
          run: async () => {
            done.open();
          },
        };
        tasks.push(task);
        if (!loop.wake()) {
          tasks.splice(tasks.indexOf(task), 1);
          return false;
        }
        await done.promise;
        return true;
      },
      async hold(): Promise<HeldWork> {
        const entered = gate();
        const released = gate();
        const ended = gate();
        let abort = false;
        tasks.push({
          // the work stops at its abort, as a cooperative work does
          run: async (given) => {
            entered.open();
            void aborted(given).then(() => {
              abort = true;
              released.open();
            });
            await released.promise;
            ended.open();
          },
        });
        loop.wake();
        await entered.promise;
        return {
          release: async () => {
            released.open();
            await ended.promise;
          },
          get aborted() {
            return abort;
          },
        };
      },
    };
  };

describe("workerLoop passes the conformance kit (SYS-4)", () => {
  for (const [lanes, tracked] of [
    [3, false],
    [3, true],
    [1, false],
  ] as const) {
    // one lane holds one work at a time: the case of the stages holds two, thus it needs two lanes
    const cases = transportConformance(workerSubject(lanes, tracked), {
      name: `worker of ${lanes} lanes${tracked ? " through life.request" : ""}`,
      holds: lanes,
    }).filter((each) => lanes > 1 || !each.name.includes("the stages in their sequence"));
    it.each(cases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
      await each.run();
    });
  }
});

// the kit on the real clock measures time, thus only CI starts it (WORKERS_IT=1, .github/workflows/http.yml)
const REAL = process.env["WORKERS_IT"] === "1";
const records: ConformanceRecord[] = [];
afterAll(() => {
  const folder = process.env["WORKERS_RECORDS"];
  if (!REAL || folder === undefined) return;
  mkdirSync(folder, { recursive: true });
  const lines = records.map((each) => JSON.stringify({ node: process.version, platform: process.platform, ...each }));
  writeFileSync(join(folder, `worker-${process.version}.ndjson`), `${lines.join("\n")}\n`);
});

describe.skipIf(!REAL)("workerLoop passes the conformance kit on the real clock", () => {
  for (const tracked of [false, true]) {
    const cases = transportConformance(workerSubject(3, tracked), {
      name: `worker of 3 lanes${tracked ? " through life.request" : ""}`,
      holds: 3,
      clock: "real",
      record: (each) => void records.push(each),
    });
    it.each(cases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
      await each.run();
    });
  }
});
