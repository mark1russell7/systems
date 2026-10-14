import type { StartedTestContainer } from "testcontainers";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RedisKnobs } from "../redis.ts";
import { redisClient, tcpDial } from "../redis.ts";

/**
 * The Redis client against a real Redis 7.4 and the real ioredis 6, opt-in: `REDIS_IT=1`. These tests
 * check what the fake cannot: the options that ioredis really takes, the server's id of the connection,
 * and the replies of a real server. They connect through the port that Docker maps, which is correct for
 * these behaviours. The timing of faults is the work of the F6 cells, which run in the VM of Docker.
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
    redis = await new GenericContainer(REDIS).withExposedPorts(6379).withWaitStrategy(Wait.forLogMessage("Ready to accept connections")).start();
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
});
