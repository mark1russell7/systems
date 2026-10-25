import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import type { JobSettle, Lifecycle, QueueKnobs, ServiceBuilder } from "./index.ts";
import { lint, queueDrain, redeliverOnce, service } from "./index.ts";
import type { Rule } from "./law.ts";
import type { ConformanceRecord, FakeClock, HeldWork, TransportSubject } from "./testing.ts";
import { detachedLifecycle, fakeClock, fakeProcess, transportConformance } from "./testing.ts";

/**
 * SYS-14: the queue drain as a transport (S6 A11). Each test uses the fake clock. The drain passes
 * the conformance kit of SYS-4, with the request tracking of a service and without it.
 */

const s = (value: number) => ({ value, unit: "s" });
const count = (value: number) => ({ value, unit: "count" });
const NONE = { value: "infinite", unit: "s" } as const;
const KNOBS: QueueKnobs = {
  queue_poll_interval: s(5),
  unit_processing_time: NONE,
  retry_base: s(1),
  retry_cap: s(8),
  close_bound: s(2),
  concurrency: count(2),
};
const signal = (): AbortSignal => new AbortController().signal;
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};
/** This function collects the garbage after the current job ends: until then, each WeakRef keeps its target. */
const collect = async (): Promise<void> => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
};
const aborted = (given: AbortSignal): Promise<void> =>
  new Promise((resolve) => (given.aborted ? resolve() : given.addEventListener("abort", () => resolve(), { once: true })));

/**
 * This function gives a queue in memory: a take that counts the deliveries of each job, as a broker
 * does, and a settle that writes each end to a log and takes back each requeued job.
 */
const inProcess = <J>(jobs: J[]): { log: string[]; settle: JobSettle<J>; take: () => J | null } => {
  const log: string[] = [];
  const counts = new Map<J, number>();
  return {
    log,
    take: () => {
      const job = jobs.shift();
      if (job === undefined) return null;
      counts.set(job, (counts.get(job) ?? 0) + 1);
      return job;
    },
    settle: {
      ack: (job) => void log.push(`ack ${String(job)}`),
      requeue: (job, cause) => {
        log.push(`requeue ${String(job)} ${cause}`);
        jobs.push(job);
      },
      reject: (job, error) => void log.push(`reject ${String(job)}: ${(error as Error).message}`),
      delivery: (job) => counts.get(job) ?? 1,
    },
  };
};

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

const running = async (svc: ServiceBuilder, clock: FakeClock): Promise<{ life: Lifecycle; process: ReturnType<typeof fakeProcess> }> => {
  const process = fakeProcess({ clock });
  let ended = false;
  const run = svc.run({ clock, process }).finally(() => {
    ended = true;
  });
  for (let step = 0; step < 50 && !ended; step += 1) await clock.advance(0);
  return { life: await run, process };
};

describe("queueDrain: the jobs of a source (S6 A11)", () => {
  it("takes a job while a slot is free, acks each success, and polls when the source has no job", async () => {
    const clock = fakeClock();
    const jobs = ["a", "b", "c"];
    const { log, settle, take } = inProcess(jobs);
    const holds = new Map<string, () => void>();
    const drain = queueDrain(KNOBS, {
      clock,
      source: take,
      settle,
      redelivery: redeliverOnce("reject"),
      handle: (job, { signal: given }) =>
        new Promise<void>((resolve) => {
          holds.set(job, resolve);
          void aborted(given).then(resolve);
        }),
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect([...holds.keys()]).toEqual(["a", "b"]);
    expect(drain.inFlight()).toBe(2);
    holds.get("a")!();
    await clock.advance(0);
    expect([...holds.keys()]).toEqual(["a", "b", "c"]);
    expect(drain.inFlight()).toBe(2);
    holds.get("b")!();
    holds.get("c")!();
    await clock.advance(0);
    expect(drain.inFlight()).toBe(0);
    expect(log).toEqual(["ack a", "ack b", "ack c"]);
    // the source has no job: the next take comes after the poll interval, or at wake()
    jobs.push("d", "e");
    await clock.advance(4999);
    expect(holds.has("d")).toBe(false);
    await clock.advance(1);
    expect(holds.has("d")).toBe(true);
    holds.get("d")!();
    holds.get("e")!();
    await clock.advance(0);
    jobs.push("f");
    expect(drain.wake()).toBe(true);
    await clock.advance(0);
    expect(holds.has("f")).toBe(true);
    await drain.stopIntake();
    expect(drain.wake()).toBe(false);
    await drain.close();
    expect(log).toEqual(["ack a", "ack b", "ack c", "ack d", "ack e", "ack f"]);
  });

  it("puts a first failure back one time, then applies the policy of the queue, and acks a poison message", async () => {
    const clock = fakeClock();
    const jobs = ["bad", "poison"];
    const { log, settle, take } = inProcess(jobs);
    const deliveries: string[] = [];
    const errors: string[] = [];
    const drain = queueDrain({ ...KNOBS, concurrency: count(1) }, {
      clock,
      source: take,
      settle,
      redelivery: redeliverOnce("reject", (error) => (error as Error).message === "poison"),
      onError: (error, job) => void errors.push(`${String(job)}: ${(error as Error).message}`),
      handle: (job, { delivery }) => {
        deliveries.push(`${job} ${delivery}`);
        throw new Error(job === "poison" ? "poison" : "the job failed");
      },
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect(deliveries).toEqual(["bad 1", "poison 1", "bad 2"]);
    expect(log).toEqual(["requeue bad failed", "ack poison", "reject bad: the job failed"]);
    expect(errors).toEqual(["bad: the job failed", "poison: poison", "bad: the job failed"]);
    await drain.stopIntake();
    await drain.close();
  });

  it("uses the count of deliveries of the queue: a broker gives a new object at each delivery", async () => {
    const clock = fakeClock();
    // a broker: each delivery is a new object, and the broker counts the deliveries of each message
    const counts = new Map<string, number>();
    const pending = ["m1"];
    const log: string[] = [];
    const seen: number[] = [];
    const drain = queueDrain({ ...KNOBS, concurrency: count(1) }, {
      clock,
      source: () => {
        const id = pending.shift();
        if (id === undefined) return null;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        return { id, receiveCount: counts.get(id)! };
      },
      settle: {
        ack: (message) => void log.push(`ack ${message.id}`),
        requeue: (message, cause) => {
          log.push(`requeue ${message.id} ${cause}`);
          pending.push(message.id);
        },
        reject: (message) => void log.push(`reject ${message.id}`),
        delivery: (message) => message.receiveCount,
      },
      redelivery: redeliverOnce("reject"),
      handle: (_message, { delivery }) => {
        seen.push(delivery);
        throw new Error("the job failed");
      },
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    // the first failure goes back one time, and the second one gets the policy of the queue
    expect(seen).toEqual([1, 2]);
    expect(log).toEqual(["requeue m1 failed", "reject m1"]);
    await drain.close();
  });

  it("gives a job whose count the queue cannot give no requeue for free", async () => {
    const clock = fakeClock();
    const jobs = ["lost"];
    const { log, settle, take } = inProcess(jobs);
    const errors: string[] = [];
    const seen: number[] = [];
    const drain = queueDrain(KNOBS, {
      clock,
      source: take,
      settle: {
        ...settle,
        delivery: () => {
          throw new Error("the broker gave no count");
        },
      },
      redelivery: redeliverOnce("reject"),
      onError: (error) => void errors.push((error as Error).message),
      handle: (_job, { delivery }) => {
        seen.push(delivery);
        throw new Error("the job failed");
      },
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect(seen).toEqual([Number.POSITIVE_INFINITY]);
    expect(log).toEqual(["reject lost: the job failed"]);
    expect(errors).toEqual(["the broker gave no count", "the job failed"]);
    await drain.close();
  });

  it("rejects a job when the policy throws or gives no action", async () => {
    const clock = fakeClock();
    const jobs = ["one", "two"];
    const { log, settle, take } = inProcess(jobs);
    const errors: string[] = [];
    const drain = queueDrain(KNOBS, {
      clock,
      source: take,
      settle,
      redelivery: ({ job }) => {
        if (job === "one") throw new Error("the policy failed");
        return "later" as never;
      },
      onError: (error) => void errors.push((error as Error).message),
      handle: () => {
        throw new Error("the job failed");
      },
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect(log).toEqual(["reject one: the job failed", "reject two: the job failed"]);
    expect(errors).toContain("the policy failed");
    expect(errors).toContain("the redelivery policy gave later, not requeue, reject or ack");
    await drain.close();
  });

  it("hands back a job that a take gives after the stop of the intake", async () => {
    const clock = fakeClock();
    const { log, settle } = inProcess<string>([]);
    let late: (job: string) => void = () => {};
    const seen: { intake?: AbortSignal } = {};
    const drain = queueDrain(KNOBS, {
      clock,
      // a long poll that ignores its signal
      source: (intake) => {
        seen.intake = intake;
        return new Promise<string>((resolve) => {
          late = resolve;
        });
      },
      settle,
      redelivery: redeliverOnce("reject"),
      handle: () => {},
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    await drain.stopIntake();
    expect(seen.intake?.aborted).toBe(true);
    late("late");
    await clock.advance(0);
    expect(log).toEqual(["requeue late unstarted"]);
    await drain.close();
  });

  it("ends an iterable source through return() at the stop, and hands back a job that comes after it", async () => {
    const clock = fakeClock();
    const { log, settle } = inProcess<string>([]);
    const nexts: Array<(job: IteratorResult<string>) => void> = [];
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>((resolve) => nexts.push(resolve)),
        return: () => {
          log.push("return");
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
    const holds = new Map<string, () => void>();
    const drain = queueDrain(KNOBS, {
      clock,
      source,
      settle,
      redelivery: redeliverOnce("reject"),
      handle: (job) => new Promise<void>((resolve) => holds.set(job, resolve)),
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    nexts.shift()!({ value: "a", done: false });
    await clock.advance(0);
    expect(drain.inFlight()).toBe(1);
    await drain.stopIntake();
    expect(log).toEqual(["return"]);
    // the next that waited at the stop gives a job: it goes back, and the job in flight ends in the drain
    nexts.shift()!({ value: "b", done: false });
    const drained = Promise.resolve(drain.drain(clock.now() + 5000, signal()));
    holds.get("a")!();
    await drained;
    expect(log[0]).toBe("return");
    expect(log.slice(1).sort()).toEqual(["ack a", "requeue b unstarted"]);
    await drain.close();
  });

  it("stops at the end of an iterable source while its intake is open, and reports it", async () => {
    const clock = fakeClock();
    const { log, settle } = inProcess<string>([]);
    const errors: Array<[string, unknown]> = [];
    async function* two(): AsyncGenerator<string> {
      yield "a";
      yield "b";
    }
    const drain = queueDrain(KNOBS, {
      clock,
      source: two(),
      settle,
      redelivery: redeliverOnce("reject"),
      onError: (error, job) => void errors.push([(error as Error).message, job]),
      handle: () => {},
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect(log).toEqual(["ack a", "ack b"]);
    expect(errors).toEqual([["the source of queueDrain ended while its intake was open: it takes no more jobs", undefined]]);
    expect(clock.pending).toBe(0);
    await drain.close();
    // a source that ends after the stop of the intake is not a failure
    expect(errors).toHaveLength(1);
  });

  it("reports an async generator that throws, and then its end", async () => {
    const clock = fakeClock();
    const { log, settle } = inProcess<string>([]);
    const errors: string[] = [];
    async function* broken(): AsyncGenerator<string> {
      yield "a";
      throw new Error("the stream broke");
    }
    const drain = queueDrain(KNOBS, {
      clock,
      random: () => 0,
      source: broken(),
      settle,
      redelivery: redeliverOnce("reject"),
      onError: (error) => void errors.push((error as Error).message),
      handle: () => {},
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    expect(log).toEqual(["ack a"]);
    expect(errors).toEqual(["the stream broke"]);
    // after the backoff, the next take finds the generator at its end
    await clock.advance(1000);
    expect(errors).toEqual(["the stream broke", "the source of queueDrain ended while its intake was open: it takes no more jobs"]);
    await drain.close();
  });

  it("backs off after a failed take, two times longer each time", async () => {
    const clock = fakeClock();
    const takes: number[] = [];
    const errors: Array<[string, unknown]> = [];
    const drain = queueDrain(KNOBS, {
      clock,
      random: () => 0,
      source: () => {
        takes.push(clock.now());
        if (takes.length <= 2) throw new Error("the broker is down");
        return null;
      },
      settle: inProcess<string>([]).settle,
      redelivery: redeliverOnce("reject"),
      onError: (error, job) => void errors.push([(error as Error).message, job]),
      handle: () => {},
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(3000);
    // the failures at 0 and 1 s, then a take with no job, and the next poll at 8 s
    expect(takes).toEqual([0, 1000, 3000]);
    expect(errors).toEqual([
      ["the broker is down", undefined],
      ["the broker is down", undefined],
    ]);
    await clock.advance(5000);
    expect(takes).toEqual([0, 1000, 3000, 8000]);
    await drain.close();
  });

  it("drains the jobs in flight with the cooperative abort, and a cut job that cannot go again gets reject", async () => {
    const clock = fakeClock();
    const jobs = ["a"];
    const { log, settle, take } = inProcess(jobs);
    const errors: unknown[] = [];
    const drain = queueDrain(KNOBS, {
      clock,
      source: take,
      settle,
      redelivery: redeliverOnce("requeue"),
      onError: (error) => void errors.push(error),
      handle: async (_job, { signal: given }) => {
        await aborted(given);
        throw new Error("the job stopped at its abort");
      },
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    await drain.stopIntake();
    const cooperative = new AbortController();
    let drained = false;
    void Promise.resolve(drain.drain(clock.now() + 5000, cooperative.signal)).then(() => {
      drained = true;
    });
    await clock.advance(1000);
    expect(drained).toBe(false);
    cooperative.abort(new Error("the cooperative abort"));
    await clock.advance(0);
    expect(drained).toBe(true);
    expect(log).toEqual(["reject a: the cooperative abort"]);
    expect(errors).toEqual([]);
    await drain.close();
  });

  it("holds the close to its close_bound, rejects a job that does not end, and closes the source", async () => {
    const clock = fakeClock();
    const jobs = ["stuck"];
    const { log, settle, take } = inProcess(jobs);
    const drain = queueDrain(KNOBS, {
      clock,
      source: take,
      settle,
      redelivery: redeliverOnce("reject"),
      // the job ignores its abort
      handle: () => new Promise<void>(() => {}),
      close: () => void log.push("close the source"),
    });
    await drain.start(signal(), detachedLifecycle());
    await clock.advance(0);
    let failure: unknown = null;
    void Promise.resolve(drain.close()).catch((error: unknown) => {
      failure = error;
    });
    expect(drain.inFlight()).toBe(0);
    await clock.advance(1999);
    expect(failure).toBeNull();
    await clock.advance(1);
    expect(String(failure)).toMatch(/a job did not end in the close_bound of 2000 ms after its abort/);
    expect(log).toEqual(["reject stuck: queueDrain closed with the job in flight", "close the source"]);
  });

  it("takes each job that comes with a concurrency without a bound", async () => {
    const clock = fakeClock();
    const jobs = Array.from({ length: 12 }, (_, at) => `job ${at}`);
    const { settle, take } = inProcess(jobs);
    const drain = queueDrain({ ...KNOBS, concurrency: { value: "infinite", unit: "count" } }, {
      clock,
      source: take,
      settle,
      redelivery: redeliverOnce("reject"),
      handle: (_job, { signal: given }) => aborted(given),
    });
    await drain.start(signal(), detachedLifecycle());
    for (let step = 0; step < 4; step += 1) await clock.advance(0);
    expect(drain.inFlight()).toBe(12);
    await drain.close();
    expect(drain.inFlight()).toBe(0);
  });

  it("keeps no job that it took while its intake stays open", async () => {
    const clock = fakeClock();
    const taken: Array<WeakRef<object>> = [];
    const drain = queueDrain<object>(KNOBS, {
      clock,
      source: () => {
        if (taken.length === 50) return null;
        const job = { pad: new Array(256).fill(taken.length) };
        taken.push(new WeakRef(job));
        return job;
      },
      settle: { ack: () => {}, requeue: () => {}, reject: () => {}, delivery: () => 1 },
      redelivery: redeliverOnce("reject"),
      handle: () => {},
    });
    await drain.start(signal(), detachedLifecycle());
    for (let step = 0; step < 200 && taken.length < 50; step += 1) await clock.advance(0);
    for (let step = 0; step < 5; step += 1) await clock.advance(0);
    expect(taken).toHaveLength(50);
    await collect();
    // a race against the stop of the intake kept each job until the stop
    expect(taken.filter((job) => job.deref() !== undefined).length).toBeLessThanOrEqual(1);
    await drain.close();
  });

  it("refuses knobs that it cannot use: the drain has no defaults", () => {
    const options = { source: () => null, settle: inProcess<string>([]).settle, redelivery: redeliverOnce<string>("reject"), handle: () => {} };
    const without = Object.fromEntries(Object.entries(KNOBS).filter(([name]) => name !== "queue_poll_interval")) as unknown as QueueKnobs;
    expect(() => queueDrain(without, options)).toThrow("queueDrain needs the knob queue_poll_interval: it has no defaults");
    expect(() => queueDrain({ ...KNOBS, concurrency: count(0) }, options)).toThrow("the knob concurrency is 0, not a whole number above zero");
    expect(() => queueDrain({ ...KNOBS, unit_processing_time: { value: -1, unit: "s" } }, options)).toThrow("the knob unit_processing_time is less than zero");
  });
});

describe("queueDrain in a service: the declaration, the law and the request tracking", () => {
  it("gives its knobs to describe(), lint() applies O20 to each consumer, and problems() reads the caps", () => {
    const O20: Rule = {
      id: "O20",
      rule: "Progress-liveness and lease windows exceed the legitimate processing time of one unit, with margin",
      expr: {
        lhs: { terms: [{ knob: "lease_duration", coef: 1, at: "broker" }] },
        op: ">",
        rhs: { terms: [{ knob: "unit_processing_time", coef: 1, at: "consumer" }] },
      },
    };
    const drain = queueDrain({ ...KNOBS, unit_processing_time: s(20) }, {
      source: () => null,
      settle: inProcess<string>([]).settle,
      redelivery: redeliverOnce("reject"),
      handle: () => {},
    });
    const svc = declared(service("app")).consumer("jobs", drain.knobs, drain);
    const description = svc.describe();
    expect(description.transports).toEqual([{ name: "jobs", kind: "consumer", knobs: { ...KNOBS, unit_processing_time: s(20) } }]);
    // the visibility timeout of SQS at its default, 30 s, against a job of 20 s
    const findings = lint(description, { platform: {}, probes: { readiness: s(10), liveness: s(30) }, transports: { jobs: { "lease_duration@broker": s(30) } } }, [O20]);
    expect(findings.map((finding) => [finding.rule, finding.scope, finding.verdict])).toEqual([["O20", "jobs", "holds"]]);
    // a job of 20 s does not fit in a drain of 10 s
    expect(drain.problems(description)).toEqual(['the unit_processing_time of queueDrain, 20000 ms, does not fit in the cap of "drain", 10000 ms']);
  });

  it("puts each job through life.request: a cut job of an idempotent route goes back, and another gets reject", async () => {
    const clock = fakeClock();
    const jobs = ["safe", "unsafe"];
    const { log, settle, take } = inProcess(jobs);
    const drain = queueDrain(KNOBS, {
      clock,
      source: take,
      settle,
      redelivery: redeliverOnce("reject"),
      request: { controller: "jobs", route: (job) => `RUN ${job}` },
      handle: async (_job, { signal: given }) => {
        await aborted(given);
        throw new Error("the job stopped at its abort");
      },
    });
    const svc = declared(service("app")).consumer("jobs", drain.knobs, drain);
    svc.controller("jobs").route("RUN safe", { idempotent: true }).route("RUN unsafe", { idempotent: false });
    const { life, process } = await running(svc, clock);
    await clock.advance(0);
    expect(life.inFlight("jobs")).toBe(2);
    process.signal("SIGTERM");
    let code: number | null = null;
    void life.done.then((given) => {
      code = given;
    });
    for (let step = 0; step < 100 && code === null; step += 1) await clock.advance(500);
    expect([...log].sort()).toEqual(["reject unsafe: the shutdown aborted it, and it failed", "requeue safe cut"]);
    expect(code).toBe(0);
  });

  it("pauses its takes while the service refuses its jobs, and hands each refused job back", async () => {
    const clock = fakeClock();
    const jobs: string[] = [];
    const { log, settle } = inProcess(jobs);
    const takes: number[] = [];
    const drain = queueDrain({ ...KNOBS, concurrency: count(1) }, {
      clock,
      random: () => 0,
      source: () => {
        if (jobs.length > 0) takes.push(clock.now());
        return jobs.shift() ?? null;
      },
      settle,
      redelivery: redeliverOnce("reject"),
      request: { controller: "jobs", route: "RUN" },
      handle: () => {},
    });
    const svc = declared(service("app")).consumer("jobs", drain.knobs, drain);
    svc.controller("jobs").route("RUN", { idempotent: true });
    const { life } = await running(svc, clock);
    await clock.advance(0);
    life.health.drain();
    jobs.push("a");
    drain.wake();
    await clock.advance(7000);
    // 1, 2 and 4 s between the takes, and no take of the job in a loop
    expect(takes).toEqual([0, 1000, 3000, 7000]);
    expect(new Set(log)).toEqual(new Set(["requeue a unstarted"]));
    await drain.stopIntake();
    await drain.close();
  });
});

/** The subject of the kit: the source is a list of tasks, and `wake()` offers each task. */
const queueSubject =
  (tracked: boolean) =>
  async (clock: Clock): Promise<TransportSubject> => {
    interface Task {
      run(signal: AbortSignal): Promise<void>;
    }
    const tasks: Task[] = [];
    let life: Lifecycle | undefined;
    if (tracked) {
      const svc = declared(service("kit"));
      svc.controller("jobs").route("RUN", { idempotent: true });
      const run = svc.run({ clock, process: fakeProcess() });
      if ("advance" in clock) for (let step = 0; step < 10; step += 1) await (clock as FakeClock).advance(0);
      life = await run;
    }
    const drain = queueDrain(
      { ...KNOBS, queue_poll_interval: NONE, concurrency: count(3) },
      {
        clock,
        source: () => tasks.shift() ?? null,
        settle: { ack: () => {}, requeue: () => {}, reject: () => {}, delivery: () => 1 },
        redelivery: redeliverOnce("reject"),
        ...(tracked ? { request: { controller: "jobs", route: "RUN" } } : {}),
        handle: (task, { signal: given }) => task.run(given),
      },
    );
    return {
      impl: drain,
      life,
      async offer() {
        const done = gate();
        const task: Task = {
          run: async () => {
            done.open();
          },
        };
        tasks.push(task);
        if (!drain.wake()) {
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
        drain.wake();
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

describe("queueDrain passes the conformance kit (SYS-4)", () => {
  for (const tracked of [false, true]) {
    const cases = transportConformance(queueSubject(tracked), { name: `queue${tracked ? " through life.request" : ""}` });
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
  writeFileSync(join(folder, `queue-${process.version}.ndjson`), `${lines.join("\n")}\n`);
});

describe.skipIf(!REAL)("queueDrain passes the conformance kit on the real clock", () => {
  for (const tracked of [false, true]) {
    const cases = transportConformance(queueSubject(tracked), {
      name: `queue${tracked ? " through life.request" : ""}`,
      clock: "real",
      record: (each) => void records.push(each),
    });
    it.each(cases.map((each) => [each.name, each] as const))("%s", async (_name, each) => {
      await each.run();
    });
  }
});
