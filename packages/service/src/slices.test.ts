import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { runSlices, SLICE_MS } from "./slices.ts";

/** A clock that moves only when a step moves it. */
const stepClock = () => {
  let time = 0;
  const clock: Clock = { now: () => time, after: () => () => undefined };
  return { clock, move: (ms: number) => (time += ms) };
};

/** A work of `count` steps. Each step moves the clock by `stepMs`. The result is the sum of the steps. */
function* work(count: number, move: (ms: number) => void, stepMs: number, log?: string[]): Generator<undefined, number, undefined> {
  let sum = 0;
  try {
    for (let step = 1; step <= count; step += 1) {
      move(stepMs);
      sum += step;
      if (step < count) yield;
    }
    return sum;
  } finally {
    log?.push("closed");
  }
}

describe("runSlices", () => {
  it("does the steps in slices of the slice time, with one turn between two slices", async () => {
    const { clock, move } = stepClock();
    let turns = 0;
    const report = await runSlices(work(10, move, 3), { sliceMs: 8, clock, turn: () => Promise.resolve(void (turns += 1)) });
    expect(report.value).toBe(55);
    expect(report.steps).toBe(9);
    expect(report.slices).toBe(4);
    expect(turns).toBe(3);
    expect(report.longestMs).toBe(9);
  });

  it("does one step in each slice when the slice time is 0", async () => {
    const { clock, move } = stepClock();
    let turns = 0;
    const report = await runSlices(work(5, move, 1), { sliceMs: 0, clock, turn: () => Promise.resolve(void (turns += 1)) });
    expect(report.value).toBe(15);
    expect(turns).toBe(4);
    expect(report.slices).toBe(5);
  });

  it("gives the same result for each slice time", async () => {
    for (const sliceMs of [0, 1, 2, 5, 100]) {
      const { clock, move } = stepClock();
      const report = await runSlices(work(7, move, 1), { sliceMs, clock, turn: () => Promise.resolve() });
      expect(report.value).toBe(28);
    }
  });

  it("gives the timers of the event loop their turns during the work", async () => {
    const order: string[] = [];
    setTimeout(() => order.push("timer"), 0);
    const steps = (function* (): Generator<undefined, string, undefined> {
      const until = Date.now() + 30;
      while (Date.now() < until) yield;
      order.push("work");
      return "done";
    })();
    const report = await runSlices(steps, { sliceMs: 1 });
    expect(report.value).toBe("done");
    expect(order).toEqual(["timer", "work"]);
  });

  it("stops between two slices at an abort, closes the steps and rejects with the reason", async () => {
    const { clock, move } = stepClock();
    const log: string[] = [];
    const controller = new AbortController();
    const reason = new Error("stop");
    const running = runSlices(work(100, move, 1), {
      sliceMs: 2,
      clock,
      signal: controller.signal,
      turn: () => {
        controller.abort(reason);
        return Promise.resolve();
      },
    });
    await expect(running).rejects.toBe(reason);
    expect(log).toEqual([]);
    const closing = runSlices(work(100, move, 1, log), { sliceMs: 2, clock, signal: AbortSignal.abort(reason) });
    await expect(closing).rejects.toBe(reason);
  });

  it("closes a started work at an abort", async () => {
    const { clock, move } = stepClock();
    const log: string[] = [];
    const controller = new AbortController();
    const running = runSlices(work(100, move, 1, log), {
      sliceMs: 2,
      clock,
      signal: controller.signal,
      turn: () => {
        controller.abort(new Error("stop"));
        return Promise.resolve();
      },
    });
    await expect(running).rejects.toThrow("stop");
    expect(log).toEqual(["closed"]);
  });

  it("rejects with the error of a step", async () => {
    const steps = (function* (): Generator<undefined, number, undefined> {
      yield;
      throw new Error("bad step");
    })();
    await expect(runSlices(steps, { sliceMs: 0, turn: () => Promise.resolve() })).rejects.toThrow("bad step");
  });

  it("refuses a slice time that is not a finite number of 0 or more", async () => {
    for (const sliceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runSlices(work(1, () => undefined, 0), { sliceMs })).rejects.toBeInstanceOf(RangeError);
    }
    expect(SLICE_MS).toBeGreaterThan(0);
  });
});
