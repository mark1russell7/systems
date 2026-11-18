import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { poller } from "./poller.ts";
import { fakeClock } from "./testing.ts";
import type { Poll } from "./timing.ts";

/**
 * SYS-126: the loop of a poller that only watches other work does not keep a Node process alive.
 * The timeout of each poll keeps the process alive, because a caller can await the poll.
 */

const s = (value: number) => ({ value, unit: "s" });
const POLL: Poll = { interval: s(300), jitter: 0.2, timeout: s(10) };
const TIMEOUT = 10_000;

/** This clock moves as a fake clock. Each cancel that it gives records the use of its `unref`. */
const recordingClock = () => {
  const fake = fakeClock();
  const timers: { ms: number; unref: boolean }[] = [];
  const clock: Clock = {
    now: () => fake.now(),
    after: (ms, run) => {
      const timer = { ms, unref: false };
      timers.push(timer);
      const cancel = fake.after(ms, run);
      return Object.assign(() => cancel(), {
        unref: () => {
          timer.unref = true;
        },
      });
    },
  };
  return { fake, clock, timers };
};

const loopOf = (clock: Clock, unrefLoop?: boolean) =>
  poller({
    name: "upstream",
    poll: POLL,
    run: () => "ok",
    clock,
    random: () => 0.5,
    forced: () => false,
    record: () => undefined,
    ...(unrefLoop === undefined ? {} : { unrefLoop }),
  });

describe("the timers of a poller (SYS-126)", () => {
  it("keeps each timer referenced by default", async () => {
    const { fake, clock, timers } = recordingClock();
    const loop = loopOf(clock);
    loop.start(0);
    await fake.advance(700_000);
    loop.stop();
    expect(timers.filter((timer) => timer.ms === TIMEOUT).length).toBeGreaterThan(1);
    expect(timers.filter((timer) => timer.unref)).toEqual([]);
  });

  it("with unrefLoop, uses the unref of each timer of the loop, and not of the timeout of a poll", async () => {
    const { fake, clock, timers } = recordingClock();
    const loop = loopOf(clock, true);
    loop.start(0);
    await fake.advance(700_000);
    loop.stop();
    const polls = timers.filter((timer) => timer.ms === TIMEOUT);
    const ticks = timers.filter((timer) => timer.ms !== TIMEOUT);
    expect(polls.length).toBeGreaterThan(1);
    expect(ticks.length).toBeGreaterThan(1);
    expect(polls.filter((timer) => timer.unref)).toEqual([]);
    expect(ticks.filter((timer) => !timer.unref)).toEqual([]);
  });

  it("with unrefLoop, keeps the timeout of pollNow referenced: a caller awaits it", async () => {
    const { clock, timers } = recordingClock();
    const loop = loopOf(clock, true);
    const result = await loop.pollNow();
    expect(result.outcome).toBe("ok");
    expect(timers).toEqual([{ ms: TIMEOUT, unref: false }]);
  });
});
