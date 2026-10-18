import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { FailsBy, Gate, Poll, Timing } from "./index.ts";
import { failSpan, recoverSpan, service } from "./index.ts";
import { fakeClock, scriptedCheck, seeded } from "./testing.ts";

/**
 * The runtime held to the algebra of its own declaration. For every permutation of policy, timing,
 * poll interval, jitter and the way the step fails, a latch on a fake clock trips inside failSpan
 * and recovers inside recoverSpan, over several seeds of the jitter and of the phase where the
 * signal turns. A failure names its permutation and its seed.
 */

const s = (value: number) => ({ value, unit: "s" });
const ms = (amount: { value: number; unit: string }): number => valueIn(amount, "ms");
const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34];
const EPSILON = 1e-6;

interface Permutation {
  readonly policy: Gate;
  readonly interval: number;
  readonly jitter: number;
  readonly by: FailsBy;
  readonly timing: Timing;
  readonly label: string;
}

const timingsFor = (interval: number): Array<[string, Timing]> => [
  ["debounce 1/1", { type: "debounce", interval: s(interval), failAfter: 1, recoverAfter: 1 }],
  ["debounce 3/1", { type: "debounce", interval: s(interval), failAfter: 3, recoverAfter: 1 }],
  ["debounce 5/2", { type: "debounce", interval: s(interval), failAfter: 5, recoverAfter: 2 }],
  ["window 0 s", { type: "window", failAfter: s(0) }],
  ["window 2 intervals", { type: "window", failAfter: s(2 * interval) }],
  ["window 45 s / 5 s", { type: "window", failAfter: s(45), recoverAfter: s(5) }],
];

const permutations: Permutation[] = [];
for (const policy of ["readiness", "liveness"] as const)
  for (const interval of [1, 5])
    for (const jitter of [0, 0.2])
      for (const by of ["error", "timeout", "hang"] as const)
        for (const [name, timing] of timingsFor(interval))
          permutations.push({
            policy,
            interval,
            jitter,
            by,
            timing,
            label: `${policy}, ${name}, poll ${interval} s ± ${jitter * 100} %, fails by ${by}`,
          });

/** One run of a permutation: the trip and the recovery, in milliseconds after the signal turned. */
const run = async (p: Permutation, seed: number): Promise<{ trip: number; recover: number }> => {
  const clock = fakeClock();
  const random = seeded(seed);
  const phase = seeded(seed * 7919);
  // the timeout stays below the shortest jittered interval, as the ordering law asks (O12)
  const poll: Poll = { interval: s(p.interval), jitter: p.jitter, timeout: s(p.interval * 0.4) };
  const other: Timing = { type: "window", failAfter: s(45) };
  const check = scriptedCheck("ok");
  const svc = service("permutation")
    .check(
      { name: "step", dependency: null, step: "round-trip", ownConnection: true, gates: p.policy, poll },
      check.run,
    )
    .readiness(p.policy === "readiness" ? p.timing : other)
    .liveness(p.policy === "liveness" ? p.timing : other)
    .startup(s(60))
    .phase("drain", s(1))
    .onRepeatSignal("ignore")
    .cooperativeWindow(s(1));
  const health = await svc.start({ clock, random });
  const changes: Array<{ at: number; tripped: boolean }> = [];
  let last = health.verdict().checks["step"]!.tripped;
  health.subscribe((verdict) => {
    const tripped = verdict.checks["step"]!.tripped;
    if (tripped !== last && tripped !== null) changes.push({ at: clock.now(), tripped });
    last = tripped;
  });
  const fail = failSpan(p.timing, poll, p.by);
  const recover = recoverSpan(p.timing, poll);
  const interval = p.interval * 1000;

  // the latch first settles released, and the signal turns at a random phase of the loop
  await clock.advance(ms(recover.max) + 3 * interval);
  expect(health.verdict().checks["step"]!.tripped, "released before the fault").toBe(false);
  await clock.advance(phase() * 2 * interval);
  const bad = clock.now();
  changes.length = 0;
  check.behavior = p.by;
  await clock.advance(ms(fail.max) + 2 * interval);
  const tripped = changes.find((change) => change.tripped);
  expect(tripped, "it trips").toBeDefined();

  await clock.advance(phase() * 2 * interval);
  const good = clock.now();
  changes.length = 0;
  check.behavior = "ok";
  check.heal();
  await clock.advance(ms(recover.max) + 2 * interval);
  const released = changes.find((change) => !change.tripped);
  expect(released, "it recovers").toBeDefined();

  health.stop();
  expect(clock.pending, "no timer outlives stop()").toBe(0);
  return { trip: tripped!.at - bad, recover: released!.at - good };
};

describe("the latch trips inside failSpan and recovers inside recoverSpan, for every permutation", () => {
  for (const p of permutations) {
    it(p.label, async () => {
      const poll: Poll = { interval: s(p.interval), jitter: p.jitter, timeout: s(p.interval * 0.4) };
      const fail = failSpan(p.timing, poll, p.by);
      const recover = recoverSpan(p.timing, poll);
      for (const seed of SEEDS) {
        const { trip, recover: back } = await run(p, seed);
        const where = `${p.label}, seed ${seed}`;
        expect(trip, `${where}: tripped ${trip} ms after the fault, outside ${ms(fail.min)}–${ms(fail.max)} ms`).toBeGreaterThanOrEqual(ms(fail.min) - EPSILON);
        expect(trip, `${where}: tripped ${trip} ms after the fault, outside ${ms(fail.min)}–${ms(fail.max)} ms`).toBeLessThanOrEqual(ms(fail.max) + EPSILON);
        expect(back, `${where}: recovered ${back} ms after the fix, outside ${ms(recover.min)}–${ms(recover.max)} ms`).toBeGreaterThanOrEqual(ms(recover.min) - EPSILON);
        expect(back, `${where}: recovered ${back} ms after the fix, outside ${ms(recover.min)}–${ms(recover.max)} ms`).toBeLessThanOrEqual(ms(recover.max) + EPSILON);
      }
    });
  }
});

describe("the bounds are reached, thus the algebra is tight", () => {
  /** a debounce of 3 polls of 5 s ± 20 %: the fault turns just after a poll, or just before one */
  const extreme = async (random: number, turn: "after" | "before"): Promise<number> => {
    const clock = fakeClock();
    const poll: Poll = { interval: s(5), jitter: 0.2, timeout: s(2) };
    const timing: Timing = { type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 };
    const check = scriptedCheck("ok");
    const starts: number[] = [];
    const run = check.run;
    const svc = service("extreme")
      .check(
        { name: "step", dependency: null, step: "round-trip", ownConnection: true, gates: "liveness", poll },
        (signal) => {
          starts.push(clock.now());
          return run(signal);
        },
      )
      .readiness({ type: "window", failAfter: s(45) })
      .liveness(timing)
      .startup(s(60))
      .phase("drain", s(1))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    const health = await svc.start({ clock, random: () => random });
    let trippedAt: number | null = null;
    health.subscribe((verdict) => {
      if (!verdict.alive && trippedAt === null) trippedAt = clock.now();
    });
    await clock.advance(20_000);
    const gap = 5000 * (1 + 0.2 * (2 * random - 1));
    const next = starts.at(-1)! + gap;
    const turnAt = turn === "after" ? next + 1e-3 : next - 1e-3;
    await clock.advance(turnAt - clock.now());
    check.behavior = "error";
    const bad = clock.now();
    await clock.advance(30_000);
    health.stop();
    return trippedAt! - bad;
  };

  it("reaches the longest bound: long gaps, and the fault just after a poll", async () => {
    const span = failSpan({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 }, { interval: s(5), jitter: 0.2, timeout: s(2) });
    expect(await extreme(1 - 1e-12, "after")).toBeCloseTo(ms(span.max) - 1e-3, 3);
  });

  it("reaches the shortest bound: short gaps, and the fault just before a poll", async () => {
    const span = failSpan({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 }, { interval: s(5), jitter: 0.2, timeout: s(2) });
    expect(await extreme(0, "before")).toBeCloseTo(ms(span.min) + 1e-3, 3);
  });
});
