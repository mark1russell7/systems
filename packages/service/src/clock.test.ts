import { describe, expect, it } from "vitest";
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

  it("reads a monotonic time", () => {
    const first = realClock.now();
    expect(platformClock().now()).toBeGreaterThanOrEqual(first);
  });
});
