import type { StartedTestContainer } from "testcontainers";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KeyState, LimiterSpec } from "../index.ts";
import { decide, freeAt, keyedLimiter, limitRule } from "../index.ts";
import type { RedisKnobs } from "../redis.ts";
import { redisClient, redisLimiterStore, tcpDial } from "../redis.ts";
import { fakeClock, seeded } from "../testing.ts";

/**
 * These tests run the Redis client against a real Redis 7.4 and the real ioredis 6, opt-in: `REDIS_IT=1`.
 * They check what the fake cannot: the options that ioredis really takes, the server's id of the
 * connection, and the replies of a real server. They connect through the port that Docker maps, which is
 * correct for these behaviours. The timing of faults is the work of the F6 cells, which run in the VM of
 * Docker. One fault is here: a server that holds a write unread, from `DEBUG SLEEP` (SYS-62).
 */

const RUN = process.env["REDIS_IT"] === "1";
const REDIS = "redis:7.4@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f";
const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const KNOBS: RedisKnobs = {
  connect_bound: ms(2000),
  request_timeout: ms(2000),
  driver_writeoff_time: ms(4000),
  keepalive_idle: s(30),
  heartbeat_interval: s(5),
  heartbeat_timeout: ms(1000),
  client_retry_window: s(10),
  retry_base: ms(50),
  retry_cap: ms(500),
  close_bound: ms(500),
  max_connection_age: { value: "infinite", unit: "s" },
  retrans_giveup_time: s(924.6),
};

describe.skipIf(!RUN)("the Redis client against a real Redis 7.4 (REDIS_IT=1)", () => {
  let redis: StartedTestContainer;
  let host: string;
  let port: number;

  beforeAll(async () => {
    // DEBUG SLEEP holds the server for the test of the resend (SYS-62)
    redis = await new GenericContainer(REDIS)
      .withCommand(["redis-server", "--enable-debug-command", "yes"])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();
    host = redis.getHost();
    port = redis.getMappedPort(6379);
  }, 120_000);
  afterAll(async () => {
    await redis?.stop({ timeout: 0 });
  });

  const client = (name = "cache") =>
    redisClient(name, { host, port, system: "systems.component.redis", knobs: KNOBS, heartbeatMisses: 2 });

  it("connects, and its join holds the id that the server gives the connection (D1)", async () => {
    const cache = client("cache-join");
    await cache.handle.connect(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const join = cache.joins.at(-1)!;
    expect(join.generation).toBe(1);
    expect(join.clientId).toBeGreaterThan(0);
    const list = await cache.send<string>("CLIENT", ["LIST", "ID", String(join.clientId)]);
    expect(list.outcome).toBe("ok");
    expect(list.outcome === "ok" ? list.value : "").toMatch(/name=cache-join/);
    await cache.handle.close();
  });

  it("tells a reply, an error of the server, and counts a write once", async () => {
    const cache = client();
    await cache.handle.connect(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await cache.send("SET", ["text", "a"])).toMatchObject({ outcome: "ok", value: "OK" });
    expect(await cache.send("INCR", ["text"])).toMatchObject({ outcome: "error", reply: true });
    expect(await cache.send("INCR", ["counter"])).toMatchObject({ outcome: "ok", value: 1 });
    expect(await cache.send("GET", ["counter"])).toMatchObject({ outcome: "ok", value: "1" });
    await cache.handle.close();
    expect(cache.status).toBe("end");
    expect(await cache.send("GET", ["counter"])).toMatchObject({ outcome: "error", reply: false });
  });

  const count = (value: number) => ({ value, unit: "count" });
  const BUCKET: LimiterSpec = {
    key: "tenant",
    policy: { type: "token-bucket", rate: { value: 1, unit: "count/s" }, burst: count(3) },
    store: { kind: "shared", dependency: "cache", onStoreFailure: "closed" },
    evict: { maxKeys: count(8) },
  };
  const WINDOW: LimiterSpec = { ...BUCKET, policy: { type: "sliding-window", limit: count(3), window: { value: 60, unit: "s" } } };

  it("decides each take of a keyed limiter as decide() does, at the cap too, in one script (SYS-28)", async () => {
    const cache = client("cache-limiter");
    await cache.handle.connect(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [name, spec] of [["bucket", BUCKET], ["window", WINDOW]] as const) {
      const clock = fakeClock();
      const limiter = keyedLimiter(name, spec, redisLimiterStore(cache, { prefix: "it:", clock }));
      const rule = limitRule(spec.policy);
      const states = new Map<string, KeyState>();
      const random = seeded(7);
      let caps = 0;
      for (let take = 0; take < 1500; take += 1) {
        const key = `k${Math.floor(random() * 24)}`;
        const now = clock.now();
        const decision = await limiter.take(key);
        const busy = [...states.values()].map((state) => freeAt(rule, state)).filter((free) => free > now);
        if (!decision.allowed && decision.cause === "cap") {
          caps += 1;
          expect(busy).toHaveLength(8);
          // the index of Redis gives the exact time until the earliest busy key is free
          expect(decision.retryAfter.value).toBeCloseTo(Math.min(...busy) - now, 3);
        } else {
          const step = decide(rule, states.get(key), now);
          expect(decision, `${name}: take ${take} of ${key}`).toEqual(step.decision);
          states.set(key, step.state);
        }
        await clock.advance(Math.floor(random() * (spec === BUCKET ? 300 : 3000)));
      }
      expect(caps).toBeGreaterThan(20);
      // the index holds at most the cap of busy keys
      const held = await cache.send<number>("ZCARD", [`it:{${name}}:keys`]);
      expect(held.outcome === "ok" ? held.value : -1).toBeLessThanOrEqual(8);
    }
    await cache.handle.close();
  }, 120_000);

  it("holds one limit for two replicas on the clock of the server, and expires the state when the key is free", async () => {
    const one = client("cache-replica-1");
    const two = client("cache-replica-2");
    for (const each of [one, two]) await each.handle.connect(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const replicas = [keyedLimiter("shared", BUCKET, redisLimiterStore(one, { prefix: "it:" })), keyedLimiter("shared", BUCKET, redisLimiterStore(two, { prefix: "it:" }))];
    const decisions = [];
    for (let take = 0; take < 5; take += 1) decisions.push(await replicas[take % 2]!.take("acme"));
    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false, false]);
    const refused = decisions[4]!;
    // one token each second: the refusal waits less than one second on TIME of the server
    expect(refused.allowed === false && refused.retryAfter.value > 0 && refused.retryAfter.value <= 1000).toBe(true);
    // the bucket is full again in about 3 s, and the state expires then
    const ttl = await one.send<number>("PTTL", ["it:{shared}:key:acme"]);
    expect(ttl.outcome === "ok" ? ttl.value : -1).toBeGreaterThan(2000);
    expect(ttl.outcome === "ok" ? ttl.value : -1).toBeLessThanOrEqual(3000);
    for (const each of [one, two]) await each.handle.close();
  });

  it("dials a new connection for its dial check", async () => {
    await tcpDial(host, port, new AbortController().signal);
  });

  it("gives ioredis the declaration's timers: a command that the server holds fails at the request timeout", async () => {
    const cache = client("cache-timeout");
    await cache.handle.connect(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const start = performance.now();
    // a blocking pop holds the reply for 5 s, longer than the 2 s request timeout
    const result = await cache.send("BLPOP", ["nothing", "5"]);
    const took = performance.now() - start;
    expect(result).toMatchObject({ outcome: "indeterminate" });
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(3500);
    await cache.handle.close();
  }, 20_000);

  /** This client is raw ioredis, for the server commands of a test and for the control at the defaults of ioredis. */
  const raw = async (options: Record<string, unknown> = {}) => {
    const { default: Redis } = (await import("ioredis")) as unknown as {
      readonly default: new (options: Record<string, unknown>) => { call(...args: Array<string | number>): Promise<unknown>; disconnect(): void };
    };
    return new Redis({ host, port, ...options });
  };
  const sleep = (time: number) => new Promise((resolve) => setTimeout(resolve, time));
  // the socket timer closes the connection at 500 ms, while DEBUG SLEEP holds the server for 2 s with the write unread
  const HELD: RedisKnobs = { ...KNOBS, driver_writeoff_time: ms(500), request_timeout: ms(4000) };
  // the promise is in a record: an async function that gave it bare would wait for the end of the sleep
  const hold = async (admin: { call(...args: Array<string | number>): Promise<unknown> }) => {
    const held = admin.call("DEBUG", "SLEEP", "2");
    await sleep(200);
    return { held };
  };

  // The cells T12.resend of SYS-62: with autoResendUnfulfilledCommands at its default, ioredis sends a
  // write again at the next ready, and the server runs the first copy too. The client of the service turns
  // the resend off, and it does not send again a command that is not idempotent
  it("writes one copy of an RPUSH that a socket timer closes while the server holds it unread, and raw ioredis writes two (SYS-62)", async () => {
    const admin = await raw();
    const control = await raw({ socketTimeout: 500 });
    await control.call("PING");
    let { held } = await hold(admin);
    const resent = control.call("RPUSH", "it:resend:control", "1");
    await held;
    await Promise.race([resent, sleep(10_000)]);
    expect(await admin.call("LLEN", "it:resend:control")).toBe(2);
    control.disconnect();

    const cache = redisClient("cache-resend", { host, port, system: "systems.component.redis", knobs: HELD, heartbeatMisses: 2 });
    await cache.handle.connect(new AbortController().signal);
    await sleep(100);
    ({ held } = await hold(admin));
    const result = await cache.send("RPUSH", ["it:resend:service", "1"]);
    expect(result).toMatchObject({ outcome: "indeterminate", attempts: 1 });
    await held;
    await sleep(1000);
    expect(await admin.call("LLEN", "it:resend:service")).toBe(1);
    expect(await cache.send("LLEN", ["it:resend:service"])).toMatchObject({ outcome: "ok", value: 1 });
    await cache.handle.close();
    admin.disconnect();
  }, 30_000);
});
