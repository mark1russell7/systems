import type { Machine, Transition } from "@mark1russell7/algebra";
import { algebraProblems, machineProblems, machineSchema, timerOf } from "@mark1russell7/algebra";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { Decision, KeyState, LimiterSpec, LimiterStore, LimitRule } from "./index.ts";
import {
  SLIDING_WINDOW_MACHINE,
  TOKEN_BUCKET_MACHINE,
  decide,
  freeAt,
  keyedLimiter,
  limiterMachine,
  limiterStateOf,
  limitRule,
  memoryStore,
  replay,
} from "./index.ts";
import { fakeClock } from "./testing.ts";

/**
 * SYS-28: the machine of a key of the keyed limiter is a document. The takes of the real runtime
 * replay against it, and its timers, which the algebra evaluates, bound the times of the runtime.
 */

const s = (value: number) => ({ value, unit: "s" });
const count = (value: number) => ({ value, unit: "count" });
const msOf = (amount: unknown): number => valueIn(amount as { value: number; unit: string }, "ms");

const bucket = (rate: number, burst: number, maxKeys = 100): LimiterSpec => ({
  key: "tenant",
  policy: { type: "token-bucket", rate: { value: rate, unit: "count/s" }, burst: count(burst) },
  store: { kind: "local" },
  evict: { maxKeys: count(maxKeys) },
});
const windowed = (limit: number, window: number, maxKeys = 100): LimiterSpec => ({
  key: "tenant",
  policy: { type: "sliding-window", limit: count(limit), window: s(window) },
  store: { kind: "local" },
  evict: { maxKeys: count(maxKeys) },
});

/** A wait is one time of the runtime that a timer of the document bounds, in milliseconds. */
interface Wait {
  readonly timer: string;
  readonly ms: number;
  /** A wait of a new key at the cap is at most the idle span, and it has no lower bound. */
  readonly atMost?: boolean;
}

/**
 * A trace drives one limiter on a fake clock, and it records each transition of each key as its
 * document names it. It keeps a copy of the state of each key through `decide`, the one decision
 * of each store, and it checks that the runtime gave the same decision.
 */
const trace = (spec: LimiterSpec, options: { shared?: boolean } = {}) => {
  const clock = fakeClock();
  const memory = memoryStore(clock);
  let failing = false;
  // a shared store over the memory of this process, which can fail
  const store: LimiterStore = options.shared
    ? {
        kind: "shared",
        take: (request) => {
          if (failing) throw new Error("the store is down");
          return memory.take(request);
        },
      }
    : memory;
  const limiterSpec: LimiterSpec = options.shared
    ? { ...spec, store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" } }
    : spec;
  const limiter = keyedLimiter("calls", limiterSpec, store);
  const rule: LimitRule = limitRule(spec.policy);
  const states = new Map<string, KeyState>();
  const limitedSince = new Map<string, number>();
  const lastTake = new Map<string, number>();
  const transitions: Transition[] = [];
  const waits: Wait[] = [];
  const decisions: Decision[] = [];
  const doc = limiterMachine(spec.policy);
  const [back, idle] = spec.policy.type === "token-bucket" ? ["token", "full"] : ["oldest", "last"];

  const stateOf = (key: string, now: number) => limiterStateOf(rule, states.get(key), now);
  // the state of each key after its last transition: a key that the trace has not seen is new
  const current = new Map<string, string>();
  const move = (key: string, from: string, on: string, to: string, at: number) => {
    transitions.push({ at, machine: doc.id, instance: key, from, on, to });
    current.set(key, to);
    if (to === "limited" && from !== "limited") limitedSince.set(key, at);
    if (from === "limited" && to !== "limited") waits.push({ timer: back, ms: at - limitedSince.get(key)! });
    if (on === "idle") waits.push({ timer: idle, ms: at - lastTake.get(key)! });
    if (to === "new") states.delete(key);
  };

  /** This function gives the next time at which the state of a key changes with no take, or undefined. */
  const changeAt = (key: string, now: number): number | undefined => {
    const state = states.get(key);
    if (state === undefined) return undefined;
    const step = decide(rule, state, now);
    return step.decision.allowed ? freeAt(rule, state) : now + msOf(step.decision.retryAfter);
  };

  return {
    doc,
    transitions,
    waits,
    decisions,
    fail(on: boolean) {
      failing = on;
    },
    /** This method moves the clock to a time, and it records each change of state of a key on the way, in sequence. */
    async to(at: number) {
      for (;;) {
        const now = clock.now();
        const next = [...states.keys()]
          .map((key) => ({ key, at: changeAt(key, now) }))
          .filter((change): change is { key: string; at: number } => change.at !== undefined && change.at <= at)
          .sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        await clock.advance(next.at - now);
        const from = current.get(next.key) ?? "new";
        const to = stateOf(next.key, next.at);
        expect(to, `${next.key} at ${next.at}`).not.toBe(from);
        move(next.key, from, to === "new" ? "idle" : "unit.back", to, next.at);
      }
      await clock.advance(at - clock.now());
    },
    /** This method takes one unit for a key, and records its transition. */
    async take(key: string): Promise<Decision> {
      const now = clock.now();
      const from = current.get(key) ?? "new";
      // the state that the store holds now is the state after the last transition of the key
      expect(stateOf(key, now), `${key} at ${now}`).toBe(from);
      const decision = await limiter.take(key);
      decisions.push(decision);
      if ("failure" in decision && decision.failure !== undefined) {
        move(key, from, "store.fail", from, now);
        return decision;
      }
      if (!decision.allowed && decision.cause === "cap") {
        expect(from).toBe("new");
        waits.push({ timer: idle, ms: msOf(decision.retryAfter), atMost: true });
        move(key, from, "take", "new", now);
        return decision;
      }
      const held = from === "new" ? undefined : states.get(key);
      const step = decide(rule, held, now);
      // the runtime and the arithmetic of its store give one decision
      expect(decision).toEqual(step.decision);
      states.set(key, step.state);
      if (decision.allowed) lastTake.set(key, now);
      else waits.push({ timer: back, ms: msOf(decision.retryAfter) });
      move(key, from, "take", stateOf(key, now), now);
      return decision;
    },
  };
};

/** These scenarios move each document through each of its transitions. */
const scenarios = async () => {
  const out: Array<ReturnType<typeof trace>> = [];
  // a bucket of 3 at one token each second: a burst, refusals, a token back, and the idle span
  {
    const run = trace(bucket(1, 3));
    for (let n = 0; n < 4; n += 1) await run.take("a");
    await run.to(1000);
    await run.take("a");
    await run.take("a");
    await run.to(1500);
    await run.take("a");
    await run.to(20_000);
    out.push(run);
  }
  // a bucket of 1: the token is back when the bucket is full
  {
    const run = trace(bucket(2, 1));
    await run.take("a");
    await run.take("a");
    await run.to(5000);
    out.push(run);
  }
  // a window of 3 takes in 60 s: the oldest take leaves, then the last one
  {
    const run = trace(windowed(3, 60));
    await run.take("a");
    await run.to(10_000);
    await run.take("a");
    await run.to(20_000);
    await run.take("a");
    await run.to(30_000);
    await run.take("a");
    await run.to(200_000);
    out.push(run);
  }
  // a window whose takes came at once, and a window of 1
  {
    const run = trace(windowed(2, 60));
    await run.take("a");
    await run.take("a");
    await run.take("a");
    await run.to(100_000);
    out.push(run);
    const one = trace(windowed(1, 10));
    await one.take("b");
    await one.take("b");
    await one.to(20_000);
    out.push(one);
  }
  // the cap of keys: two held keys, and a new key that waits for the earliest of them
  for (const spec of [bucket(1, 2, 2), windowed(2, 30, 2)]) {
    const run = trace(spec);
    await run.take("a");
    await run.to(500);
    await run.take("b");
    await run.take("c");
    await run.to(100_000);
    await run.take("c");
    await run.to(200_000);
    out.push(run);
  }
  // a shared store that fails, in each state of a key
  for (const spec of [bucket(1, 2), windowed(2, 30)]) {
    const run = trace(spec, { shared: true });
    run.fail(true);
    await run.take("a");
    run.fail(false);
    await run.take("a");
    run.fail(true);
    await run.take("a");
    run.fail(false);
    await run.take("a");
    run.fail(true);
    await run.take("a");
    run.fail(false);
    await run.to(100_000);
    out.push(run);
  }
  return out;
};

/** This function gives the steps of a document: each from state, event and to state of its transitions. */
const stepsOf = (doc: Machine): string[] =>
  doc.transitions.flatMap((each) =>
    [each.from].flat().flatMap((from) => [each.on].flat().map((on) => `${from} ${on} ${each.to}`)),
  );

describe("the machine of a key of the keyed limiter is a document (SYS-28)", () => {
  it.each([
    ["token bucket", TOKEN_BUCKET_MACHINE],
    ["sliding window", SLIDING_WINDOW_MACHINE],
  ])("the %s document is valid, consistent, and the algebra reads each timer", (_name, doc) => {
    expect(machineSchema.safeParse(doc).success).toBe(true);
    expect(machineProblems(doc)).toEqual([]);
    expect(algebraProblems(doc)).toEqual([]);
  });

  it("gives the document of each policy, and the state of a key as the document names it", () => {
    expect(limiterMachine(bucket(1, 3).policy)).toBe(TOKEN_BUCKET_MACHINE);
    expect(limiterMachine(windowed(3, 60).policy)).toBe(SLIDING_WINDOW_MACHINE);
    const rule = limitRule(bucket(1, 3).policy);
    expect(limiterStateOf(rule, undefined, 0)).toBe("new");
    expect(limiterStateOf(rule, { type: "token-bucket", full: 1000 }, 0)).toBe("open");
    expect(limiterStateOf(rule, { type: "token-bucket", full: 3000 }, 0)).toBe("limited");
    expect(limiterStateOf(rule, { type: "token-bucket", full: 3000 }, 3000)).toBe("new");
  });

  it("replays each take and each change of state of the runtime against its document, and reaches each transition", async () => {
    const runs = await scenarios();
    const seen = new Map<string, Set<string>>();
    for (const run of runs) {
      expect(replay(run.doc, run.transitions), run.doc.id).toEqual([]);
      const steps = seen.get(run.doc.id) ?? new Set<string>();
      for (const each of run.transitions) steps.add(`${each.from} ${each.on} ${each.to}`);
      seen.set(run.doc.id, steps);
    }
    for (const doc of [TOKEN_BUCKET_MACHINE, SLIDING_WINDOW_MACHINE])
      expect([...(seen.get(doc.id) ?? [])].sort(), doc.id).toEqual([...new Set(stepsOf(doc))].sort());
  });

  it("refuses a trace that its document does not allow (the replay is not vacuous)", () => {
    const step = (from: string, on: string, to: string): Transition => ({ at: 0, machine: TOKEN_BUCKET_MACHINE.id, instance: "a", from, on, to });
    expect(replay(TOKEN_BUCKET_MACHINE, [step("limited", "take", "open")])).toEqual([
      "a: service.machine.limiter.token-bucket has no transition from limited on take to open",
    ]);
  });
});

describe("the timers of the limiter documents bound the times of the runtime (the algebra)", () => {
  /** This function gives the knob values of a spec, by the names of its document. */
  const valuesOf = (spec: LimiterSpec) => (name: string) => {
    const policy = spec.policy as unknown as Record<string, { value: number; unit: string }>;
    return name === "max_keys" ? spec.evict.maxKeys : policy[name];
  };

  it("each wait of each scenario is inside the bounds of its timer: a Retry-After, a unit back, an idle key", async () => {
    const runs = await scenarios();
    let checked = 0;
    // these are the specs of the scenarios, in their sequence
    const specs: LimiterSpec[] = [bucket(1, 3), bucket(2, 1), windowed(3, 60), windowed(2, 60), windowed(1, 10), bucket(1, 2, 2), windowed(2, 30, 2), bucket(1, 2), windowed(2, 30)];
    expect(runs.length).toBe(specs.length);
    runs.forEach((run, index) => {
      const spec = specs[index]!;
      expect(run.doc).toBe(limiterMachine(spec.policy));
      for (const wait of run.waits) {
        const bounds = timerOf(run.doc, wait.timer, valuesOf(spec));
        const longest = msOf(bounds.duration);
        const shortest = wait.atMost === true ? 0 : longest - (bounds.early === undefined ? 0 : msOf(bounds.early));
        expect(wait.ms, `${run.doc.id} ${wait.timer}`).toBeLessThanOrEqual(longest + 1e-6);
        expect(wait.ms, `${run.doc.id} ${wait.timer}`).toBeGreaterThanOrEqual(shortest - 1e-6);
        expect(wait.ms).toBeGreaterThan(0);
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThan(20);
  });

  it("gives the longest Retry-After of each policy from its timer: one interval of the bucket, one window", () => {
    expect(msOf(timerOf(TOKEN_BUCKET_MACHINE, "token", valuesOf(bucket(4, 10))).duration)).toBe(250);
    expect(msOf(timerOf(TOKEN_BUCKET_MACHINE, "full", valuesOf(bucket(4, 10))).duration)).toBe(2500);
    expect(msOf(timerOf(SLIDING_WINDOW_MACHINE, "oldest", valuesOf(windowed(120, 60))).duration)).toBe(60_000);
  });
});
