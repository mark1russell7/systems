import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import type { Heartbeat, HeartbeatOptions } from "./heartbeat.ts";
import { detectionTime, heartbeat } from "./heartbeat.ts";
import { fakeClock, seeded } from "./testing.ts";

/** A peer on a fake clock: it answers each ping after a delay, until it goes silent. */
const peer = (clock: Clock, delay: () => number, silentAt = Number.POSITIVE_INFINITY) => {
  const pings: number[] = [];
  return {
    pings,
    /** a ping as a promise, as a request with its reply */
    request: (signal: AbortSignal): Promise<boolean> => {
      pings.push(clock.now());
      return new Promise((resolve) => {
        const wait = delay();
        if (clock.now() + wait >= silentAt) {
          signal.addEventListener("abort", () => resolve(false), { once: true });
          return;
        }
        const stop = clock.after(wait, () => resolve(true));
        signal.addEventListener("abort", () => {
          stop();
          resolve(false);
        });
      });
    },
    /** a ping as a message: the pong comes later through answer() */
    message: (beat: () => Heartbeat) => (): void => {
      pings.push(clock.now());
      const wait = delay();
      if (clock.now() + wait < silentAt) clock.after(wait, () => beat().answer());
    },
  };
};

const options = (more: Partial<HeartbeatOptions> & Pick<HeartbeatOptions, "ping">): HeartbeatOptions => ({
  interval: 1000,
  timeout: 400,
  misses: 2,
  onDead: () => {},
  ...more,
});

describe("heartbeat: a ping each interval, a timeout for each ping, and a count of misses", () => {
  it("sends a ping each interval, from the start of the one before, while the peer answers", async () => {
    const clock = fakeClock();
    const p = peer(clock, () => 50);
    const beat = heartbeat(options({ clock, ping: p.request }));
    await clock.advance(3500);
    expect(p.pings).toEqual([1000, 2000, 3000]);
    expect(beat.misses).toBe(0);
    beat.stop();
    expect(clock.pending).toBe(0);
  });

  it("counts a miss at the timeout of each ping, and the last miss starts onDead with the count at zero", async () => {
    const clock = fakeClock();
    const events: string[] = [];
    const p = peer(clock, () => 50, 0);
    const beat = heartbeat(
      options({
        clock,
        misses: 3,
        ping: p.request,
        onMiss: (misses) => events.push(`${clock.now()} miss ${misses}`),
        onDead: () => events.push(`${clock.now()} dead`),
      }),
    );
    await clock.advance(3400);
    expect(events).toEqual(["1400 miss 1", "2400 miss 2", "3400 miss 3", "3400 dead"]);
    expect(beat.misses).toBe(0);
    beat.stop();
  });

  it("sets the misses to zero at an answer", async () => {
    const clock = fakeClock();
    let silent = true;
    const beat = heartbeat(options({ clock, misses: 3, ping: async () => !silent }));
    await clock.advance(2000);
    expect(beat.misses).toBe(2);
    silent = false;
    await clock.advance(1000);
    expect(beat.misses).toBe(0);
    beat.stop();
  });

  it("takes a ping without a value as a message: answer() is its pong, and the timeout is its miss", async () => {
    const clock = fakeClock();
    let beat: Heartbeat | null = null;
    const p = peer(clock, () => 100);
    const misses: number[] = [];
    beat = heartbeat(options({ clock, ping: p.message(() => beat!), onMiss: (count) => misses.push(count) }));
    await clock.advance(5200);
    expect(misses).toEqual([]);
    expect(beat.waiting).toBe(0);
    beat.stop();
  });

  it("answers each ping that waits at answer(), also a late pong", async () => {
    const clock = fakeClock();
    const beat = heartbeat(options({ clock, misses: 5, ping: () => {} }));
    await clock.advance(2400);
    expect(beat.misses).toBe(2);
    await clock.advance(100);
    expect(beat.waiting).toBe(0);
    beat.answer();
    expect(beat.misses).toBe(0);
    await clock.advance(600);
    expect(beat.waiting).toBe(1);
    beat.answer();
    expect(beat.waiting).toBe(0);
    beat.stop();
  });

  it("sends one ping at a time without overlap, and one at each tick with it", async () => {
    for (const overlap of [false, true]) {
      const clock = fakeClock();
      const p = peer(clock, () => 50, 0);
      const beat = heartbeat(options({ clock, timeout: 2500, misses: 9, overlap, ping: p.request }));
      await clock.advance(6000);
      expect(p.pings, `overlap ${overlap}`).toEqual(overlap ? [1000, 2000, 3000, 4000, 5000, 6000] : [1000, 4000]);
      beat.stop();
    }
  });

  it("counts a throw and a rejection as a miss", async () => {
    const clock = fakeClock();
    let calls = 0;
    const beat = heartbeat(
      options({
        clock,
        misses: 9,
        ping: () => {
          calls += 1;
          if (calls === 1) throw new Error("the socket is closed");
          return Promise.reject(new Error("no route"));
        },
      }),
    );
    await clock.advance(2000);
    expect(beat.misses).toBe(2);
    beat.stop();
  });

  it("sends a ping only at a tick that is due, and counts a miss only while the connection is live", async () => {
    const clock = fakeClock();
    let due = false;
    let live = false;
    let pings = 0;
    const beat = heartbeat(
      options({
        clock,
        misses: 9,
        due: () => due,
        live: () => live,
        ping: async () => {
          pings += 1;
          return false;
        },
      }),
    );
    await clock.advance(3000);
    expect(pings).toBe(0);
    due = true;
    await clock.advance(2000);
    expect([pings, beat.misses]).toEqual([2, 0]);
    live = true;
    await clock.advance(1000);
    expect([pings, beat.misses]).toEqual([3, 1]);
    beat.stop();
  });

  it("waits one turn before it counts, and counts nothing after stop()", async () => {
    const clock = fakeClock();
    const turns: Array<() => void> = [];
    const beat = heartbeat(
      options({
        clock,
        misses: 9,
        ping: async () => false,
        turn: () => new Promise<void>((resolve) => turns.push(resolve)),
      }),
    );
    await clock.advance(1000);
    expect([turns.length, beat.misses]).toEqual([1, 0]);
    turns.shift()!();
    await clock.advance(0);
    expect(beat.misses).toBe(1);
    await clock.advance(1000);
    beat.stop();
    turns.shift()!();
    await clock.advance(0);
    expect(beat.misses).toBe(1);
  });

  it("stops its ticks and its timeouts, and aborts each ping that waits", async () => {
    const clock = fakeClock();
    const signals: AbortSignal[] = [];
    const beat = heartbeat(
      options({
        clock,
        ping: (signal) => {
          signals.push(signal);
          return new Promise<boolean>(() => {});
        },
      }),
    );
    await clock.advance(1000);
    expect(beat.waiting).toBe(1);
    beat.stop();
    beat.stop();
    expect([beat.stopped, beat.waiting, clock.pending, signals[0]!.aborted]).toEqual([true, 0, 0, true]);
    beat.answer();
    await clock.advance(5000);
    expect(signals).toHaveLength(1);
  });

  it("starts no tick for an interval that is not finite, and no timeout for a timeout that is not finite", async () => {
    const clock = fakeClock();
    const off = heartbeat(options({ clock, interval: Number.POSITIVE_INFINITY, ping: async () => true }));
    expect(clock.pending).toBe(0);
    off.stop();
    const patient = heartbeat(options({ clock, timeout: Number.POSITIVE_INFINITY, ping: () => new Promise<boolean>(() => {}) }));
    await clock.advance(1000);
    expect([patient.waiting, clock.pending]).toEqual([1, 1]);
    patient.stop();
  });

  it("refuses a count of misses that is not a whole number above zero", () => {
    for (const misses of [0, -1, 1.5, Number.NaN]) expect(() => heartbeat(options({ misses, ping: () => {} }))).toThrow(RangeError);
  });
});

describe("detectionTime: the most time to find a silent peer", () => {
  it("is misses intervals plus a timeout, and infinite without an interval", () => {
    expect(detectionTime(1000, 400, 2)).toBe(2400);
    expect(detectionTime(Number.POSITIVE_INFINITY, 400, 2)).toBe(Number.POSITIVE_INFINITY);
  });

  it("bounds the death of a peer that goes silent at any time (a property, 300 seeded cases)", async () => {
    const random = seeded(17);
    const pick = (low: number, high: number) => Math.floor(low + random() * (high - low + 1));
    for (let run = 0; run < 300; run += 1) {
      const interval = pick(100, 2000);
      const overlap = random() < 0.5;
      // without overlap, the time holds only for a timeout below the interval
      const timeout = overlap ? pick(10, 3 * interval) : pick(10, interval - 1);
      const misses = pick(1, 5);
      const silentAt = pick(0, 10_000) + 0.5;
      const clock = fakeClock();
      const p = peer(clock, () => pick(0, timeout - 1) + 0.25, silentAt);
      let dead: number | null = null;
      const beat = heartbeat({ interval, timeout, misses, overlap, clock, ping: p.request, onDead: () => (dead ??= clock.now()) });
      await clock.advance(silentAt + detectionTime(interval, timeout, misses) + interval);
      beat.stop();
      const label = JSON.stringify({ interval, timeout, misses, overlap, silentAt });
      expect(dead, label).not.toBeNull();
      expect(dead! - silentAt, label).toBeLessThanOrEqual(detectionTime(interval, timeout, misses));
      // the first ping that fails starts less than a timeout before the silence, and the last one
      // fails misses - 1 intervals and a timeout after it
      expect(dead! - silentAt, label).toBeGreaterThanOrEqual((misses - 1) * interval);
    }
  });
});

/**
 * The heartbeat of a WebSocket client that this function replaces, copied as it is, as a
 * reference: one ping at a time, a miss at the timeout of a ping, a drop at the last miss, and the
 * misses at zero at a pong.
 */
const websocketReference = (
  clock: Clock,
  config: { interval: number; timeout: number; misses: number },
  send: () => void,
  record: (event: string) => void,
) => {
  let heartbeatTimer: (() => void) | undefined;
  let heartbeatTimeout: (() => void) | undefined;
  let heartbeatMisses = 0;
  let dropped = false;
  const stopHeartbeat = (): void => {
    heartbeatMisses = 0;
    heartbeatTimer?.();
    heartbeatTimer = undefined;
    heartbeatTimeout?.();
    heartbeatTimeout = undefined;
  };
  const tick = (): void => {
    heartbeatTimer = clock.after(config.interval, tick);
    if (!dropped && !heartbeatTimeout) {
      send();
      heartbeatTimeout = clock.after(config.timeout, () => {
        heartbeatTimeout = undefined;
        heartbeatMisses += 1;
        record(`${clock.now()} miss ${heartbeatMisses}`);
        if (heartbeatMisses < config.misses) return;
        record(`${clock.now()} dead`);
        dropped = true;
        stopHeartbeat();
      });
    }
  };
  heartbeatTimer = clock.after(config.interval, tick);
  return {
    pong(): void {
      heartbeatMisses = 0;
      heartbeatTimeout?.();
      heartbeatTimeout = undefined;
    },
  };
};

describe("heartbeat against the WebSocket heartbeat that it replaces (a property, 300 seeded cases)", () => {
  it("gives the same pings, misses and death for each schedule of pongs", async () => {
    const random = seeded(29);
    const pick = (low: number, high: number) => Math.floor(low + random() * (high - low + 1));
    for (let run = 0; run < 300; run += 1) {
      const config = { interval: pick(100, 1000), timeout: pick(50, 1500), misses: pick(1, 4) };
      // each pong comes after a delay that is never equal to a timer, or it does not come
      const delays = Array.from({ length: 40 }, () => (random() < 0.4 ? null : pick(0, 2000) + 0.5));
      const run1 = async (make: (clock: Clock, send: () => void, record: (event: string) => void) => () => void): Promise<string[]> => {
        const clock = fakeClock();
        const events: string[] = [];
        let sent = 0;
        let pong: () => void = () => {};
        const send = (): void => {
          events.push(`${clock.now()} ping`);
          const delay = delays[sent++ % delays.length];
          if (delay !== null && delay !== undefined) clock.after(delay, () => pong());
        };
        pong = make(clock, send, (event) => events.push(event));
        await clock.advance(30_000);
        return events;
      };
      const reference = await run1((clock, send, record) => websocketReference(clock, config, send, record).pong);
      const general = await run1((clock, send, record) => {
        const beat: Heartbeat = heartbeat({
          ...config,
          clock,
          ping: () => send(),
          onMiss: (misses) => record(`${clock.now()} miss ${misses}`),
          onDead: () => {
            record(`${clock.now()} dead`);
            beat.stop();
          },
        });
        return () => beat.answer();
      });
      expect(general, JSON.stringify({ config, delays })).toEqual(reference);
    }
  });
});
