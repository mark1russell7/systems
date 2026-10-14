import { describe, expect, it } from "vitest";
import type { Lifecycle, Poll, Timing } from "../index.ts";
import { service } from "../index.ts";
import { fakeClock, fakeProcess, seeded } from "../testing.ts";
import type { FakeClock } from "../testing.ts";
import type { RedisKnobs } from "../redis.ts";
import { redisClient } from "../redis.ts";
import type { F6Manifestation, F6Posture } from "./f6.ts";
import { F6_MANIFESTATIONS, F6_POSTURES, gateOf, recoverBand, reportBand, tripBand } from "./f6.ts";
import type { FakeRedis } from "./fake.ts";
import { fakeRedis } from "./fake.ts";

/**
 * The F6 matrix on a fake ioredis and a fake clock: each manifestation × the posture of the check ×
 * the timing of the policy × the jitter of the poll. Each case runs the whole lifecycle, injects the
 * manifestation, and holds the trip and the release of the policy to the declaration's own bounds.
 */

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const never = { value: "infinite" as const, unit: "s" };

const KNOBS: RedisKnobs = {
  connect_bound: ms(500),
  request_timeout: ms(800),
  driver_writeoff_time: ms(2000),
  keepalive_idle: s(5),
  heartbeat_interval: ms(1000),
  heartbeat_timeout: ms(400),
  client_retry_window: s(4),
  retry_base: ms(50),
  retry_cap: ms(400),
  close_bound: ms(300),
  max_connection_age: never,
  retrans_giveup_time: s(924.6),
};

const TIMINGS: Readonly<Record<string, Timing>> = {
  "a debounce of 3": { type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 },
  "a window of 3 s": { type: "window", failAfter: s(3) },
};
const OTHER: Timing = { type: "window", failAfter: s(60) };
const STALL = 8000;

interface Case {
  readonly manifestation: F6Manifestation;
  readonly posture: F6Posture;
  readonly timing: string;
  readonly jitter: number;
}

const cases: Case[] = F6_MANIFESTATIONS.flatMap((manifestation) =>
  F6_POSTURES.flatMap((posture) =>
    Object.keys(TIMINGS).flatMap((timing) => [0, 0.2].map((jitter) => ({ manifestation, posture, timing, jitter }))),
  ),
);

const nameOf = (c: Case): string => `${c.manifestation} × ${c.posture} × ${c.timing} × jitter ${c.jitter}`;

/** This function starts a service with one Redis client on a fake ioredis, and moves the clock until it is ready. */
const started = async (c: Case) => {
  const clock = fakeClock(1000);
  const process = fakeProcess();
  const fakes: FakeRedis[] = [];
  const client = redisClient(
    "cache",
    { host: "redis", port: 6379, system: "systems.component.redis", knobs: KNOBS, heartbeatMisses: 2 },
    { clock, random: seeded(3), turn: () => Promise.resolve(), dial: async () => {}, create: (options) => {
      const fake = fakeRedis(options, clock);
      fakes.push(fake);
      return fake;
    } },
  );
  const poll: Poll = { interval: s(1), jitter: c.jitter, timeout: ms(400) };
  const timing = TIMINGS[c.timing]!;
  const svc = service("f6")
    .readiness(c.posture === "readiness" ? timing : OTHER)
    .liveness(c.posture === "liveness" ? timing : OTHER)
    .startup(s(10))
    .phase("stop the poller", s(1))
    .phase("tear down dependencies", s(1))
    .cooperativeWindow(s(0.5));
  client.attach(svc, { poll, steps: { "round-trip": gateOf(c.posture) } });
  let life: Lifecycle | null = null;
  void svc.run({ clock, random: seeded(5), process }).then((value) => {
    life = value;
  });
  await until(clock, () => life !== null && life.health.verdict().ready);
  return { clock, process, client, fake: fakes[0]!, life: life! as Lifecycle, poll, timing };
};

const until = async (clock: FakeClock, done: () => boolean, most = 60_000): Promise<boolean> => {
  for (let spent = 0; spent < most; spent += 10) {
    if (done()) return true;
    await clock.advance(10);
  }
  return done();
};

/** This function injects a manifestation on the fake server. */
const inject = (manifestation: F6Manifestation, fake: FakeRedis): void => {
  if (manifestation === "rst") fake.mode = "refuse";
  else if (manifestation === "freeze-process" || manifestation === "app-stall") fake.mode = "frozen";
  else fake.mode = "silent";
};

/** This function ends a manifestation: the server is back, and a thawed or stalled one answers late. */
const heal = (manifestation: F6Manifestation, fake: FakeRedis): void => {
  fake.mode = "up";
  if (manifestation === "freeze-process" || manifestation === "app-stall") fake.answerWaiting();
  // a host that is gone comes back without the old connection: its next segment gets a reset
  if (manifestation === "freeze-host") fake.breakConnection();
};

describe("F6 for Redis, on a fake ioredis: each manifestation × posture × timing × jitter", () => {
  for (const c of cases) {
    it(nameOf(c), async () => {
      const { clock, fake, life, poll, timing } = await started(c);
      const flipped = (): boolean => {
        const verdict = life.health.verdict();
        return c.posture === "readiness" ? !verdict.ready : c.posture === "liveness" ? !verdict.alive : false;
      };
      const onset = clock.now();
      inject(c.manifestation, fake);
      if (c.posture === "reports") {
        // the check fails, and nothing that it does not gate moves
        const failing = (): boolean => life.health.verdict().checks["cache.round-trip"]?.last?.outcome === "error";
        expect(await until(clock, failing, 10_000), nameOf(c)).toBe(true);
        const band = reportBand(poll);
        expect(clock.now() - onset, nameOf(c)).toBeLessThanOrEqual(band.high);
        await clock.advance(6000);
        expect(life.health.verdict().ready, nameOf(c)).toBe(true);
        expect(life.health.verdict().alive, nameOf(c)).toBe(true);
        return;
      }
      expect(await until(clock, flipped, 20_000), `${nameOf(c)}: the policy never tripped`).toBe(true);
      const trip = tripBand(timing, poll);
      const tripped = clock.now() - onset;
      // the clock moves in steps of 10 ms: a trip is seen up to one step late
      expect(tripped, `${nameOf(c)}: tripped after ${tripped} ms, outside [${trip.low}, ${trip.high}]`).toBeGreaterThanOrEqual(trip.low);
      expect(tripped, `${nameOf(c)}: tripped after ${tripped} ms, outside [${trip.low}, ${trip.high}]`).toBeLessThanOrEqual(trip.high + 10);
      // the server is back: at once, or at the end of a stall
      if (c.manifestation === "app-stall") await clock.advance(Math.max(0, STALL - (clock.now() - onset)));
      const back = clock.now();
      heal(c.manifestation, fake);
      expect(await until(clock, () => !flipped(), 30_000), `${nameOf(c)}: the policy never released`).toBe(true);
      const recover = recoverBand(timing, poll, KNOBS);
      const released = clock.now() - back;
      expect(released, `${nameOf(c)}: released after ${released} ms, outside [${recover.low}, ${recover.high}]`).toBeLessThanOrEqual(recover.high + 10);
    });
  }
});

describe("F6 for Redis: a shutdown in the middle of each manifestation still exits cleanly (A9, principle 9)", () => {
  for (const manifestation of F6_MANIFESTATIONS) {
    it(`${manifestation}: the bounded close fits its phase, and the exit is 0`, async () => {
      const { clock, process, fake, life, client } = await started({ manifestation, posture: "readiness", timing: "a debounce of 3", jitter: 0.2 });
      inject(manifestation, fake);
      await clock.advance(3000);
      void life.shutdown("F6");
      expect(await until(clock, () => process.exits.length > 0, 10_000), `${manifestation}: no exit`).toBe(true);
      expect(process.exits).toEqual([0]);
      expect(life.errors).toEqual([]);
      expect(client.status).toBe("end");
    });
  }
});
