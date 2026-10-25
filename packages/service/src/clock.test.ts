import { describe, expect, it, vi } from "vitest";
import { platformClock, realClock } from "./clock.ts";

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
