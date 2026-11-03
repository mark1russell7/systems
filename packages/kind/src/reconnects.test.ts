import { describe, expect, it } from "vitest";
import type { KindCell, KindRun, ReconnectsPrediction } from "./cell.ts";
import { cellOf } from "./cells.fixture.ts";
import type { Line } from "./observe.ts";
import { PRODUCER_BACKOFF } from "./pulsar.ts";
import { judgeReconnects, latestReturn, triesOf } from "./reconnects.ts";
import { checkRun, observationEnd } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" }) as const;

const PREDICTION: ReconnectsPrediction = {
  kind: "reconnects",
  flip: { lo: s(20.5), hi: s(33) },
  probe: s(1.5),
  disconnect: { lo: s(0), hi: s(1) },
  backoff: PRODUCER_BACKOFF,
  setup: { lo: s(0), hi: s(3) },
  outcomes: ["late", "timeout"],
  why: "a test",
};

const OLD = "pulsar-broker-0.pulsar-broker-headless.pulsar.svc.cluster.local";
const NEW = "pulsar-broker-1.pulsar-broker-headless.pulsar.svc.cluster.local";
const FAULT = 100_000;
const SENDS = { timeout: 1000, every: 200 };

/** This function gives the lookups of a probe: the old owner up to the change, then the new one, each 250 ms. */
const lookups = (flip: number, pod = "producer-a"): Line[] => {
  const lines: Line[] = [];
  for (let t = FAULT - 2000; t < FAULT + 90_000; t += 250) lines.push({ ev: "lookup", t, o: "ok", owner: t < FAULT + flip ? OLD : NEW, p: pod });
  return lines;
};

/**
 * This function gives the lines of one producer: the calls of its backoff with no jitter. Each try
 * fails `latency` ms after it starts, up to the first try at or after the change of the owner. Then
 * the producer is back `setup` ms later. Each send waits for the return. `change` alters one delay.
 */
const producer = (pod: string, flip: number, options: { readonly latency?: number; readonly setup?: number; readonly change?: (index: number, delay: number) => number } = {}): Line[] => {
  const { latency = 5, setup = 300, change = (_: number, delay: number) => delay } = options;
  const lines: Line[] = [];
  let next = 100;
  let call = FAULT + 5;
  const first = call;
  let made = false;
  let back = 0;
  for (let index = 0; index < 20; index += 1) {
    let current = next;
    next = Math.min(2 * next, 60_000);
    if (!made && call - first + current > 29_900) {
      current = Math.max(100, 29_900 - (call - first));
      made = true;
    }
    const delay = change(index, Math.round(current));
    lines.push({ ev: "pulsar", t: call, p: pod, m: `[persistent://public/default/lab, standalone-0-1] Schedule reconnection in ${delay / 1000} s` });
    const at = call + delay;
    if (at >= FAULT + flip) {
      back = at + setup;
      lines.push({ ev: "pulsar", t: back, p: pod, m: `[persistent://public/default/lab, standalone-0-1] Created producer on broker [10.244.1.5:41000 -> 10.244.2.7:6650]` });
      break;
    }
    call = at + latency;
  }
  for (let t = FAULT - 5000; t < FAULT + 90_000; t += 200) {
    const waited = t < FAULT - 50 ? 3 : Math.max(3, back - t + 2);
    const o = t < FAULT - 50 ? "ok" : waited > 30_000 ? "timeout" : waited > 1000 ? "late" : "ok";
    lines.push({ ev: "send", t, d: Math.min(waited, 30_000), o, p: pod });
  }
  return lines;
};

const run = (lines: readonly Line[]) => judgeReconnects(PREDICTION, { fault: FAULT, broker: OLD, lines }, SENDS, 100);

describe("the tries of a producer", () => {
  it("are the backoff of the C++ client: doubled from 100 ms, the stop at 29.9 s, then 51.2 s and 60 s", () => {
    const tries = triesOf(PRODUCER_BACKOFF, 140_000).map((each) => ({ lo: Math.round(each.lo), hi: Math.round(each.hi) }));
    expect(tries.slice(0, 2)).toEqual([
      { lo: 100, hi: 100 },
      { lo: 282, hi: 400 },
    ]);
    // the eighth try is at 25.5 s with no jitter and at most 9 % less of each delay
    expect(tries[7]).toEqual({ lo: 23_214, hi: 26_200 });
    // the ninth try takes the rest to the mandatory stop
    expect(tries[8]).toEqual({ lo: 29_298, hi: 29_900 });
    expect(tries[9]).toEqual({ lo: 75_890, hi: 81_200 });
    expect(tries[10]!.hi - tries[9]!.hi).toBe(60_100);
  });

  it("give the latest return: the latest first delay, the try after the latest change, and the latest setup", () => {
    // the first try with no earlier time than 33 s is the tenth: 81.2 s at its latest
    expect(latestReturn(PREDICTION)).toBe(1000 + 81_200 + 3000);
  });
});

describe("the judge of the reconnects", () => {
  it("holds when each producer is back at the first try after the change of the owner", () => {
    const judged = run([...lookups(27_000), ...producer("producer-a", 27_000), ...producer("producer-b", 27_000)]);
    expect(judged.why).toMatch(/^another owner/);
    expect(judged.ok).toBe(true);
    expect(judged.flip).toBe(27_000);
    expect(judged.returns.map((each) => each.tries)).toEqual([9, 9]);
    expect(judged.value).toBeCloseTo(29_900 + 5 + 300, 0);
    expect(judged.failures["late"]).toBeGreaterThan(0);
  });

  it("holds in the late mode: the change after the stop gives the tenth try, and the sends from the fault time out", () => {
    const judged = run([...lookups(31_000), ...producer("producer-a", 31_000), ...producer("producer-b", 31_000)]);
    expect(judged.ok).toBe(true);
    expect(judged.returns.map((each) => each.tries)).toEqual([10, 10]);
    expect(judged.failures["timeout"]).toBeGreaterThan(0);
  });

  it("fails when a delay is not the backoff", () => {
    const judged = run([...lookups(27_000), ...producer("producer-a", 27_000, { change: (index, delay) => (index === 3 ? 500 : delay) })]);
    expect(judged.ok).toBe(false);
    expect(judged.why).toMatch(/the delay 4 is 500 ms/);
  });

  it("fails when the owner changes outside its band", () => {
    const judged = run([...lookups(18_000), ...producer("producer-a", 18_000)]);
    expect(judged.ok).toBe(false);
    expect(judged.why).toMatch(/outside the band/);
  });

  it("fails when a try after the change of the owner did not succeed", () => {
    // the producer comes back at the try after the stop, but the eighth try came after the change
    const judged = run([...lookups(24_000), ...producer("producer-a", 27_000)]);
    expect(judged.ok).toBe(false);
    expect(judged.why).toMatch(/comes after the change of the owner/);
  });

  it("fails when the setup is outside its band", () => {
    const judged = run([...lookups(27_000), ...producer("producer-a", 27_000, { setup: 5000 })]);
    expect(judged.ok).toBe(false);
    expect(judged.why).toMatch(/setup takes 5000 ms/);
  });

  it("fails when no lookup names another owner, or a send fails with another outcome", () => {
    expect(run(producer("producer-a", 27_000)).why).toMatch(/no lookup after the fault/);
    const lines = [...lookups(27_000), ...producer("producer-a", 27_000), { ev: "send", t: FAULT + 1000, d: 0, o: "refused-producerqueueisfull", p: "producer-a" }];
    expect(run(lines).why).toMatch(/ended refused-producerqueueisfull/);
  });

  it("fails when a send fails long before the fault", () => {
    const lines = [...lookups(27_000), ...producer("producer-a", 27_000), { ev: "send", t: FAULT - 4000, d: 2000, o: "late", p: "producer-a" }];
    expect(run(lines).why).toMatch(/failed outside the time to its return/);
  });
});

describe("the check of a run of the reconnects", () => {
  const cell = { ...cellOf("crash"), workload: { every: { value: 200, unit: "ms" }, timeout: { value: 1, unit: "s" } }, pulsar: { clients: 2, probe: { value: 250, unit: "ms" } }, prediction: PREDICTION } as KindCell;
  const runOf = (lines: Line[]): KindRun => ({
    env: 0,
    index: 0,
    warmup: false,
    start: FAULT - 5000,
    end: FAULT + 90_000,
    acts: { fault: FAULT, heal: null, resume: null },
    target: null,
    paused: null,
    broker: OLD,
    replicas: [],
    void: null,
    dropped: {},
    lines,
  });
  const lines = [...lookups(27_000), ...producer("producer-a", 27_000), ...producer("producer-b", 27_000)];

  it("holds with the time to the return in seconds, and the facts of each producer", () => {
    const check = checkRun(cell, runOf(lines));
    expect(check.why).toMatch(/^another owner/);
    expect(check.ok).toBe(true);
    expect(check.value).toEqual({ value: 30.205, unit: "s" });
    expect(check.facts.reconnects?.flip).toEqual({ value: 27, unit: "s" });
    expect(check.facts.reconnects?.returns.map((each) => each.tries)).toEqual([9, 9]);
  });

  it("fails with no broker, or a failed request of the control", () => {
    expect(checkRun(cell, { ...runOf(lines), broker: undefined }).why).toMatch(/no broker/);
    const failed: Line = { ev: "req", t: FAULT + 1000, d: 1000, o: "timeout", p: "client-a", n: "w1", lp: 3, b: "lab-a" };
    expect(checkRun(cell, runOf([...lines, failed])).why).toMatch(/requests of the control failed/);
  });

  it("observes up to the latest return after the fault", () => {
    expect(observationEnd(cell, runOf(lines))).toBe(FAULT + latestReturn(PREDICTION) + 1000 + 100);
  });
});
