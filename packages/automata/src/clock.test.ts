import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fakeClock, platformClock, realClock } from "./clock.ts";

describe("the clock entry: a client in a browser can import it", () => {
  it("imports nothing: no node: module, no zod and no other package", () => {
    const source = readFileSync(new URL("./clock.ts", import.meta.url), "utf8");
    expect(source.match(/^\s*(import|export)\b[^;]*\bfrom\s/gm)).toBeNull();
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});

describe("the fake clock", () => {
  it("starts the timers that come due, in the order of their times, then of their starts", async () => {
    const clock = fakeClock(100);
    const runs: string[] = [];
    clock.after(20, () => runs.push("b"));
    clock.after(10, () => runs.push("a"));
    clock.after(20, () => runs.push("c"));
    const stopped = clock.after(5, () => runs.push("stopped"));
    stopped();
    expect(clock.pending).toBe(3);
    await clock.advance(15);
    expect(runs).toEqual(["a"]);
    expect(clock.now()).toBe(115);
    await clock.advance(5);
    expect(runs).toEqual(["a", "b", "c"]);
    expect(clock.pending).toBe(0);
  });

  it("starts a timer that came due during a block late, at the time of the clock", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    clock.after(10, () => seen.push(clock.now()));
    clock.block(50);
    expect(seen).toEqual([]);
    await clock.advance(0);
    expect(seen).toEqual([50]);
  });

  it("starts a timer that a timer starts, in the same advance, and does not go back", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    clock.after(10, () => clock.after(5, () => seen.push(clock.now())));
    await clock.advance(-5);
    expect(clock.now()).toBe(0);
    await clock.advance(20);
    expect(seen).toEqual([15]);
    expect(clock.now()).toBe(20);
  });
});

describe("the clock of the platform", () => {
  it("starts a timer, and its cancel stops the timer and has unref", async () => {
    for (const clock of [platformClock(), platformClock({ unref: true }), realClock]) {
      const runs: string[] = [];
      const kept = clock.after(0, () => runs.push("kept"));
      const stopped = clock.after(0, () => runs.push("stopped"));
      stopped();
      stopped();
      expect(typeof kept.unref).toBe("function");
      kept.unref?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runs).toEqual(["kept"]);
    }
  });

  it("waits a delay longer than setTimeout takes in steps, and its cancel stops the next step", () => {
    // setTimeout starts a function after 1 ms for a delay above 2^31 - 1 ms, and the fake timers do the same
    vi.useFakeTimers();
    try {
      const runs: string[] = [];
      const clock = platformClock({ unref: true });
      const long = 2 ** 31 + 1000;
      clock.after(long, () => runs.push("long"));
      const stopped = clock.after(long, () => runs.push("stopped"));
      vi.advanceTimersByTime(2 ** 31 - 1);
      expect(runs).toEqual([]);
      stopped();
      vi.advanceTimersByTime(1000);
      expect(runs).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(runs).toEqual(["long"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a monotonic time", () => {
    const first = realClock.now();
    expect(platformClock().now()).toBeGreaterThanOrEqual(first);
  });
});
