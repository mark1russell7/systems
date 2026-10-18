import { machineProblems, machineSchema } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "../index.ts";
import { replay } from "../index.ts";
import type { FakeClock } from "../testing.ts";
import { fakeClock } from "../testing.ts";
import type { RedisClientSpec, RedisConnectionOptions, RedisKnobs } from "../redis.ts";
import {
  REDIS_CLIENT_MACHINE,
  REDIS_OPERATIONS,
  firstDetector,
  heartbeatDetection,
  redisClient,
  specProblems,
  unwatched,
} from "../redis.ts";
import type { FakeRedis } from "./fake.ts";
import { ReplyError, fakeRedis } from "./fake.ts";

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
  client_retry_window: s(10),
  retry_base: ms(50),
  retry_cap: ms(400),
  close_bound: ms(300),
  max_connection_age: never,
  retrans_giveup_time: s(924.6),
};

const spec = (knobs: Partial<RedisKnobs> = {}, more: Partial<RedisClientSpec> = {}): RedisClientSpec => ({
  host: "redis",
  port: 6379,
  system: "systems.component.redis",
  knobs: { ...KNOBS, ...knobs },
  heartbeatMisses: 2,
  ...more,
});

/** a client on a fake ioredis and a fake clock, its events, and the fake of each connection */
const made = (knobs: Partial<RedisKnobs> = {}, more: Partial<RedisClientSpec> = {}, random = () => 0.5) => {
  const clock = fakeClock(1000);
  const events: LifecycleEvent[] = [];
  const fakes: FakeRedis[] = [];
  let given: RedisConnectionOptions | undefined;
  const client = redisClient("cache", spec(knobs, more), {
    clock,
    random,
    record: (event) => events.push(event),
    turn: () => Promise.resolve(),
    dial: async () => {},
    create: (options) => {
      given = options;
      const fake = fakeRedis(options, clock);
      fakes.push(fake);
      return fake;
    },
  });
  return { clock, client, events, fakes, options: () => given!, fake: () => fakes[0]! };
};

const connected = async (knobs: Partial<RedisKnobs> = {}, more: Partial<RedisClientSpec> = {}) => {
  const all = made(knobs, more);
  await all.client.handle.connect(new AbortController().signal);
  await all.clock.advance(0);
  return all;
};

describe("the declaration: knobs by the names of the law, and no default (C1, C2, E3)", () => {
  it("declares each knob as a time, and derives the watchdog's detection time", () => {
    const { client } = made();
    expect(Object.keys(client.declaration.knobs).sort()).toEqual(
      [
        "client_retry_window",
        "close_bound",
        "connect_bound",
        "driver_writeoff_time",
        "heartbeat_detection_time",
        "heartbeat_interval",
        "heartbeat_timeout",
        "keepalive_idle",
        "max_connection_age",
        "request_timeout",
        "retrans_giveup_time",
        "retry_base",
        "retry_cap",
      ].sort(),
    );
    // two misses of a PING each second, the last one at its 400 ms timeout
    expect(client.declaration.knobs["heartbeat_detection_time"]).toEqual(s(2.4));
    expect(heartbeatDetection(never, ms(400), 2)).toEqual(never);
  });

  it("refuses what it cannot do, and says why", () => {
    expect(specProblems("cache", spec({ max_connection_age: s(1800) }))).toEqual([
      'cache cannot replace its connection at an age: max_connection_age must be "infinite"',
    ]);
    expect(specProblems("cache", spec({}, { heartbeatMisses: 0 }))[0]).toMatch(/after 0 misses/);
    expect(specProblems("cache", spec({ request_timeout: ms(0) }))).toContain(
      "cache's request_timeout is not above zero: each command must have a bound",
    );
    expect(() => redisClient("cache", spec({ retry_cap: ms(10) }))).toThrow(/retry_cap is below its retry_base/);
  });

  it("gives ioredis each timer from the declaration, and never lets it send a command again (R5 §8)", () => {
    const { client, options } = made();
    void client.handle.connect(new AbortController().signal);
    expect(options()).toMatchObject({
      lazyConnect: true,
      connectTimeout: 500,
      commandTimeout: 800,
      socketTimeout: 2000,
      keepAlive: 5000,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      connectionName: "cache",
    });
  });

  it("writes a bound that nobody gives as no bound: no socket timeout, and no keepalive", () => {
    const { client, options } = made({ driver_writeoff_time: never, keepalive_idle: never });
    void client.handle.connect(new AbortController().signal);
    expect(options().socketTimeout).toBeUndefined();
    expect(options().keepAlive).toBe(false);
  });

  it("declares its operations with their idempotency, and a declaration can change the table (C8)", () => {
    expect(REDIS_OPERATIONS["GET"]).toEqual({ idempotent: true });
    expect(REDIS_OPERATIONS["INCR"]).toEqual({ idempotent: false });
    expect(REDIS_OPERATIONS["FLUSHALL"]).toBeUndefined();
    const { client } = made({}, { operations: { "EVALSHA": { idempotent: true } } });
    expect(client.declaration.operations["EVALSHA"]).toEqual({ idempotent: true });
    expect(client.declaration.operations["GET"]).toEqual({ idempotent: true });
  });
});

describe("the join at each ready: the server's id of the connection (D1, D2)", () => {
  it("records CLIENT ID and the socket of each generation", async () => {
    const { client, fake, clock } = await connected();
    expect(client.status).toBe("ready");
    expect(client.joins).toEqual([
      { generation: 1, at: 1000, clientId: 7, localAddress: "10.0.0.2", localPort: 40001, remoteAddress: "10.0.0.3", remotePort: 6379 },
    ]);
    fake().breakConnection();
    await clock.advance(1000);
    expect(client.status).toBe("ready");
    expect(client.joins.map((join) => [join.generation, join.clientId])).toEqual([
      [1, 7],
      [2, 8],
    ]);
  });
});

describe("three outcomes, never an empty success (C7, C8, C10)", () => {
  it("tells a reply, an error of the server, and a command that did not leave the client apart", async () => {
    const { client, fake } = await connected();
    expect(await client.send("PING")).toEqual({ outcome: "ok", value: "PONG", attempts: 1 });
    fake().reply = () => new ReplyError("WRONGTYPE Operation against a key holding the wrong kind of value");
    expect(await client.send("INCR", ["k"])).toMatchObject({ outcome: "error", reply: true, attempts: 1 });
    await client.handle.close();
    expect(await client.send("INCR", ["k"])).toMatchObject({ outcome: "error", reply: false });
  });

  it("settles a command in flight as indeterminate at the close of its connection, not at its timeout", async () => {
    const { client, fake, clock } = await connected();
    fake().mode = "silent";
    const pending = client.send("INCR", ["k"]);
    await clock.advance(100);
    fake().breakConnection();
    await clock.advance(0);
    // well before the 800 ms command timeout
    expect(clock.now()).toBe(1100);
    expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 1 });
  });

  it("never sends again an operation that is not idempotent, even after the connection is back", async () => {
    const { client, fake, clock } = await connected();
    fake().mode = "silent";
    const pending = client.send("INCR", ["k"]);
    await clock.advance(10);
    fake().mode = "up";
    fake().breakConnection();
    await clock.advance(1000);
    expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 1 });
    expect(fake().calls.filter(([command]) => command === "INCR")).toHaveLength(1);
  });

  it("sends an idempotent operation again one time, in the bound of the request", async () => {
    const { client, fake, clock } = await connected();
    fake().mode = "silent";
    const pending = client.send("GET", ["k"]);
    await clock.advance(10);
    fake().mode = "up";
    fake().breakConnection();
    await clock.advance(1000);
    expect(await pending).toEqual({ outcome: "ok", value: "OK", attempts: 2 });
  });

  it("sends it again one time only, and the second attempt ends at the bound of the request", async () => {
    const { client, fake, clock } = await connected();
    fake().mode = "silent";
    const start = clock.now();
    const pending = client.send("GET", ["k"]);
    await clock.advance(10);
    // the new connection works, and its server is silent again at once
    fake().mode = "up";
    fake().on("ready", () => {
      fake().mode = "silent";
    });
    fake().breakConnection();
    let settled: number | null = null;
    void pending.then(() => {
      settled = clock.now();
    });
    await clock.advance(5000);
    expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 2 });
    // at the 800 ms bound of the request, not 800 ms after the second attempt started
    expect(settled! - start).toBe(800);
    expect(fake().calls.filter(([command]) => command === "GET")).toHaveLength(2);
  });

  it("does not send a keyed operation again after its key's window", async () => {
    const { client, fake, clock } = await connected({}, { operations: { "SET": { idempotent: { key: "nonce", window: ms(5) } } } });
    fake().mode = "silent";
    const pending = client.send("SET", ["k", "v"]);
    await clock.advance(10);
    fake().mode = "up";
    fake().breakConnection();
    await clock.advance(1000);
    expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 1 });
  });

  it("gives up a sent command that the caller abandons as indeterminate: it cannot cancel it (principle 9)", async () => {
    const { client, fake, clock } = await connected();
    fake().mode = "silent";
    const caller = new AbortController();
    const pending = client.send("INCR", ["k"], { signal: caller.signal });
    await clock.advance(50);
    caller.abort();
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: "the caller abandoned the command after it was sent" });
  });
});

describe("connecting again: a jittered, capped backoff in a window, and the watchdog after it (C6, E7)", () => {
  it("doubles each delay to its cap, with a jitter below the base, and stops after the window", async () => {
    const delays: number[] = [];
    const { client, fake, clock, options } = await connected({ client_retry_window: s(2) });
    const strategy = options().retryStrategy;
    fake().mode = "refuse";
    const now = clock.now();
    for (let times = 1; times <= 5; times += 1) delays.push(strategy(times) ?? -1);
    // base 50 ms doubling to the 400 ms cap, each plus half the base (a random of 0.5)
    expect(delays).toEqual([75, 125, 225, 425, 425]);
    await clock.advance(2100);
    expect(strategy(6)).toBeNull();
    expect(clock.now()).toBeGreaterThan(now);
    expect(client.status).not.toBe("ready");
  });

  it("ends after the window, and its watchdog starts it again", async () => {
    const { client, fake, clock, events } = await connected({ client_retry_window: ms(500) });
    fake().mode = "refuse";
    fake().breakConnection();
    await clock.advance(1500);
    expect(events.some((event) => event.on === "retry.window-ended")).toBe(true);
    fake().mode = "up";
    await clock.advance(1000);
    expect(events.some((event) => event.on === "watchdog.revive")).toBe(true);
    expect(client.status).toBe("ready");
  });
});

describe("the watchdog: a PING in the band of the connection (principle 19, CR3)", () => {
  it("finds a silent server in its detection time, and connects again", async () => {
    const { client, fake, clock, events } = await connected({ driver_writeoff_time: never });
    fake().mode = "silent";
    const silent = clock.now();
    for (let step = 0; step < 40 && !events.some((event) => event.on === "watchdog.reconnect"); step += 1) await clock.advance(100);
    const reconnect = events.find((event) => event.on === "watchdog.reconnect")!;
    const bound = client.declaration.knobs["heartbeat_detection_time"]!;
    expect(reconnect.at - silent).toBeLessThanOrEqual((bound.value as number) * 1000);
    // the second of two misses: one interval after the first
    expect(reconnect.at - silent).toBeGreaterThanOrEqual(1000 + 400);
    expect(events.filter((event) => event.on === "watchdog.miss")).toHaveLength(2);
  });

  it("counts an error reply as an answer", async () => {
    const { fake, clock, events } = await connected();
    fake().reply = () => new ReplyError("MISCONF Redis is configured to save RDB snapshots");
    await clock.advance(5000);
    expect(events.filter((event) => event.on === "watchdog.miss")).toHaveLength(0);
  });

  it("acts only on a ready connection: it never closes a connection in the middle of an attempt", async () => {
    const { fake, clock, events } = await connected({ driver_writeoff_time: never, connect_bound: ms(3000), client_retry_window: s(60) });
    fake().mode = "silent";
    fake().breakConnection();
    await clock.advance(8000);
    expect(events.filter((event) => event.on === "watchdog.reconnect")).toHaveLength(0);
  });
});

describe("the close: a QUIT, then a disconnect at its bound (A9, principle 9)", () => {
  it("closes at once when the server answers", async () => {
    const { client, clock } = await connected();
    const start = clock.now();
    await client.handle.close();
    expect(clock.now() - start).toBe(0);
    expect(client.status).toBe("end");
  });

  it("disconnects at its bound when the server is silent, and settles what is in flight", async () => {
    const { client, fake, clock, events } = await connected();
    fake().mode = "silent";
    const pending = client.send("INCR", ["k"]);
    const closing = client.handle.close();
    await clock.advance(300);
    await closing;
    expect(events.some((event) => event.on === "close.bound")).toBe(true);
    // the disconnect only half-closed the socket, and the silent server never closed its half
    expect(events.some((event) => event.on === "close.destroy")).toBe(true);
    expect(clock.now() - 1000).toBeLessThanOrEqual(300);
    expect(client.status).toBe("end");
    expect(await pending).toMatchObject({ outcome: "indeterminate" });
  });

  it("stops a client that is connecting again: it does not connect after the close", async () => {
    const { client, fake, clock } = await connected();
    fake().mode = "refuse";
    fake().breakConnection();
    await clock.advance(10);
    await client.handle.close();
    const attempts = fake().attempts;
    await clock.advance(5000);
    expect(fake().attempts).toBe(attempts);
    expect(client.status).toBe("end");
  });
});

describe("the checks of each step of the connection (B7, B14)", () => {
  it("gives a check for each step asked, with its policy, and whether it uses the application's connection", () => {
    const { client } = made();
    const poll = { interval: s(1), jitter: 0.2, timeout: ms(400) };
    const checks = client.checks({ poll, steps: { "round-trip": "readiness", "dial": null, "local-state": "liveness" } });
    expect(checks.map(([check]) => [check.name, check.step, check.gates, check.ownConnection])).toEqual([
      ["cache.local-state", "local-state", "liveness", true],
      ["cache.round-trip", "round-trip", "readiness", true],
      ["cache.dial", "dial", null, false],
    ]);
  });

  it("passes on a PING, and fails on a client that is not ready", async () => {
    const { client, fake } = await connected();
    const poll = { interval: s(1), jitter: 0.2, timeout: ms(400) };
    const [, roundTrip] = client.checks({ poll, steps: { "round-trip": "readiness" } })[0]!;
    expect(await roundTrip(new AbortController().signal)).toBe("ok");
    fake().mode = "refuse";
    fake().breakConnection();
    expect(await roundTrip(new AbortController().signal)).toBe("error");
  });

  it("says when its close does not fit in its phase, or its request outlives a poll (O13)", async () => {
    const { service } = await import("../index.ts");
    const { client } = made({ request_timeout: s(5), close_bound: s(3) });
    const svc = service("app")
      .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(6) })
      .startup(s(10))
      .phase("tear down dependencies", s(2))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    client.attach(svc, { poll: { interval: s(1), jitter: 0.2, timeout: ms(400) }, steps: { "round-trip": "readiness" } });
    expect(client.problems(svc.describe())).toEqual([
      "cache's close_bound of 3000 ms does not fit in the cap of \"tear down dependencies\"",
      "cache's request_timeout outlives one jittered poll of cache.round-trip (B7, O13)",
    ]);
  });
});

describe("the manifestations that the client meets, and their detectors (E9, C3)", () => {
  it("finds each manifestation in each situation with the declaration's timers", () => {
    const { client } = made();
    const blackhole = client.meets.find((meeting) => meeting.manifestation === "blackhole")!;
    expect(firstDetector(blackhole, "in flight")).toMatchObject({ by: "request_timeout", within: ms(800) });
    expect(firstDetector(blackhole, "idle")).toMatchObject({ by: "heartbeat_detection_time", within: s(2.4) });
    expect(unwatched(client.meets)).toEqual([]);
  });

  it("names what nothing finds once the watchdog is off: a frozen server stays hidden while idle", () => {
    const { client } = made({ heartbeat_interval: never });
    expect(unwatched(client.meets)).toEqual([
      { manifestation: "freeze-process", situation: "idle" },
      { manifestation: "app-stall", situation: "idle" },
    ]);
  });
});

describe("the client as a document (D4, E8)", () => {
  it("is a valid, consistent machine document", () => {
    expect(machineSchema.safeParse(REDIS_CLIENT_MACHINE).success).toBe(true);
    expect(machineProblems(REDIS_CLIENT_MACHINE)).toEqual([]);
  });

  const scenarios: Record<string, (all: Awaited<ReturnType<typeof connected>>) => Promise<void>> = {
    "a reset, and a new connection": async ({ fake, clock }) => {
      fake().breakConnection();
      await clock.advance(1000);
    },
    "a refused server, the end of the window, and the watchdog": async ({ fake, clock }) => {
      fake().mode = "refuse";
      fake().breakConnection();
      await clock.advance(12000);
      fake().mode = "up";
      await clock.advance(2000);
    },
    "a silent server that the watchdog finds": async ({ fake, clock }) => {
      fake().mode = "silent";
      await clock.advance(3000);
      fake().mode = "up";
      await clock.advance(2000);
    },
    "a bounded close of a silent server": async ({ client, fake, clock }) => {
      fake().mode = "silent";
      const closing = client.handle.close();
      await clock.advance(300);
      await closing;
    },
    "a command sent again": async ({ client, fake, clock }) => {
      fake().mode = "silent";
      const pending = client.send("GET", ["k"]);
      await clock.advance(10);
      fake().mode = "up";
      fake().breakConnection();
      await clock.advance(1000);
      await pending;
    },
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`replays ${name} against the document`, async () => {
      const all = await connected({ driver_writeoff_time: never });
      await scenario(all);
      expect(all.events.length).toBeGreaterThan(2);
      expect(replay(REDIS_CLIENT_MACHINE, all.events)).toEqual([]);
    });
  }
});

/** the clock of a test, moved in steps, until a condition holds or the steps run out */
export const until = async (clock: FakeClock, done: () => boolean, step = 50, most = 30_000): Promise<number> => {
  for (let spent = 0; spent < most && !done(); spent += step) await clock.advance(step);
  return clock.now();
};
