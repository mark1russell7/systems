// The grid after a block (SYS-138 part 2). The heartbeat and the watchdog are loops of the loop core, from `start`.
// After a block of the event loop, the late tick comes at once, and the next tick comes at its planned time. The old
// timers of the two loops started again from the late tick, thus their ticks moved by the block.

import { describe, expect, it } from "vitest";
import { heartbeat } from "./heartbeat.ts";
import { ms } from "./loop-rig.ts";
import { fakeClock } from "./testing.ts";
import { watchdog, type WatchdogSpec } from "./watchdog.ts";

describe("the grid after a block", () => {
  it("the watchdog ticks on its grid after a late tick", async () => {
    const clock = fakeClock();
    const ticks: number[] = [];
    let free: number | undefined;
    const dog = watchdog(clock, { name: "dog", tick: ms(100), threshold: ms(50), gates: null } as unknown as WatchdogSpec, (from, to, on) => {
      if (on !== "tick") return;
      ticks.push(clock.now());
      if (from === "blocked" && to === "watching") free ??= clock.now();
    });
    await clock.advance(50);
    // the tick due at 100 starts at 450, late by 350 ms
    clock.block(400);
    await clock.advance(0);
    expect(dog.blocked).toBe(true);
    expect(dog.worst).toBe(350);
    await clock.advance(200);
    dog.stop();
    expect({ ticks, free }).toEqual({ ticks: [450, 500, 600], free: 500 });
  });

  it("the heartbeat pings on its grid after a late tick", async () => {
    const clock = fakeClock();
    const pings: number[] = [];
    const beat = heartbeat({
      interval: 100,
      timeout: 50,
      misses: 9,
      clock,
      onDead: () => {},
      ping: () => {
        pings.push(clock.now());
        return Promise.resolve(true);
      },
    });
    await clock.advance(50);
    clock.block(400);
    await clock.advance(0);
    await clock.advance(200);
    beat.stop();
    expect(pings).toEqual([450, 500, 600]);
  });
});
