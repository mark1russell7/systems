import { machineProblems } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "../index.ts";
import { replay, service } from "../index.ts";
import { fakeClock } from "../testing.ts";
import type { MongoClientSpec, MongoConnectOptions, MongoKnobs } from "../mongodb.ts";
import {
  HELLO,
  MONGO_CLIENT_MACHINE,
  MONGO_STARTING_KNOBS,
  MONGO_STARTING_POLL,
  failureOutcome,
  firstDetector,
  helloJudge,
  mongoClient,
  mongoOptions,
  specProblems,
  unwatched,
} from "../mongodb.ts";
import type { FakeMongo } from "./fake.ts";
import { FakeMongoError, fakeMongo } from "./fake.ts";

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const never = { value: "infinite" as const, unit: "s" };

// the write-off of a silent server comes at connect_bound + heartbeat_interval = 1000 ms after its last answer
const KNOBS: MongoKnobs = {
  connect_bound: ms(500),
  request_timeout: ms(800),
  statement_timeout: ms(600),
  heartbeat_interval: ms(500),
  client_retry_window: ms(1200),
  checkout_timeout: ms(500),
  pool_idle_expiry: s(10),
  keepalive_idle: s(5),
  max_connection_age: never,
  close_bound: ms(300),
  retrans_giveup_time: s(924.6),
};

const spec = (knobs: Partial<MongoKnobs> = {}, more: Partial<MongoClientSpec> = {}): MongoClientSpec => ({
  host: "mongo",
  port: 27017,
  database: "app",
  system: "systems.component.mongodb",
  knobs: { ...KNOBS, ...knobs },
  pool: { max: 2, min: 0 },
  operations: { "find user": { idempotent: true }, "add order": { idempotent: false } },
  ...more,
});

/** a client on a fake MongoClient and a fake clock, its events, and the fake */
const made = (knobs: Partial<MongoKnobs> = {}, more: Partial<MongoClientSpec> = {}, mode: FakeMongo["mode"] = "up") => {
  const clock = fakeClock(1000);
  const events: LifecycleEvent[] = [];
  let driver: FakeMongo | undefined;
  let given: MongoConnectOptions | undefined;
  const client = mongoClient("db", spec(knobs, more), {
    clock,
    record: (event) => events.push(event),
    dial: async () => {},
    create: (options) => {
      given = options;
      driver = fakeMongo(options, clock);
      driver.mode = mode;
      return driver;
    },
  });
  return { clock, client, events, driver: () => driver!, options: () => given! };
};

/** a connected client, with one idle connection in its pool from a ping */
const connected = async (knobs: Partial<MongoKnobs> = {}, more: Partial<MongoClientSpec> = {}) => {
  const all = made(knobs, more);
  await all.client.handle.connect(new AbortController().signal);
  await all.client.command("check", { ping: 1 });
  await all.clock.advance(0);
  return all;
};

describe("the declaration: knobs by the names of the law, and no default (C1, C2, E3)", () => {
  it("declares each knob as a time, the write-off of the driver, and its keepalive as the refresh of an idle flow", () => {
    const { client } = made();
    expect(Object.keys(client.declaration.knobs).sort()).toEqual(
      [
        "checkout_timeout",
        "client_retry_window",
        "close_bound",
        "connect_bound",
        "driver_writeoff_time",
        "heartbeat_interval",
        "idle_refresh_interval",
        "keepalive_idle",
        "max_connection_age",
        "pool_idle_expiry",
        "request_timeout",
        "retrans_giveup_time",
        "statement_timeout",
      ].sort(),
    );
    expect(client.declaration.knobs["driver_writeoff_time"]).toEqual(s(1));
    expect(client.declaration.knobs["idle_refresh_interval"]).toEqual(s(5));
    expect(client.declaration.operations["find user"]).toEqual({ idempotent: true });
  });

  it("refuses what the driver cannot do, and says why", () => {
    expect(specProblems("db", spec({ request_timeout: ms(0) }))).toContain(
      "db's request_timeout is not a finite time above zero: the driver reads 0 as no bound",
    );
    expect(specProblems("db", spec({ client_retry_window: never as never }))[0]).toMatch(/client_retry_window is not a finite time/);
    expect(specProblems("db", spec({ pool_idle_expiry: s(0) }))).toEqual(['db\'s pool_idle_expiry is zero: give "infinite" for no bound']);
    expect(specProblems("db", spec({ keepalive_idle: ms(1500) }))).toEqual(["db's keepalive_idle is not a whole number of seconds"]);
    expect(specProblems("db", spec({ keepalive_idle: never }))).toEqual([
      "db's keepalive_idle is not a finite time above zero: the driver always turns keepalive on",
    ]);
    expect(specProblems("db", spec({ heartbeat_interval: ms(400) }))).toEqual(["db's heartbeat_interval is below 500 ms, the least that the driver takes"]);
    expect(specProblems("db", spec({ max_connection_age: s(1800) }))).toEqual([
      'db\'s max_connection_age is not "infinite": the driver has no age for a connection',
    ]);
    expect(specProblems("db", spec({ request_timeout: { value: 0.5, unit: "ms" } }))).toEqual([
      "db's request_timeout is not a whole number of milliseconds",
    ]);
    expect(specProblems("db", spec({}, { pool: { max: 2, min: 3 } }))[0]).toMatch(/min of 3/);
    expect(() => mongoClient("db", spec({}, { pool: { max: 0, min: 0 } }))).toThrow(/max of 0/);
  });

  it("gives the driver each timer from the declaration, turns its retries off, and writes a bound that nobody gives as 0", () => {
    const { url, options } = mongoOptions("db", spec({}, { seeds: [{ host: "mongo2", port: 27018 }], replicaSet: "rs0", username: "app", password: "pw" }));
    expect(url).toBe("mongodb://mongo:27017,mongo2:27018/");
    expect(options).toEqual({
      appName: "db",
      replicaSet: "rs0",
      auth: { username: "app", password: "pw" },
      maxPoolSize: 2,
      minPoolSize: 0,
      connectTimeoutMS: 500,
      socketTimeoutMS: 800,
      serverSelectionTimeoutMS: 1200,
      heartbeatFrequencyMS: 500,
      waitQueueTimeoutMS: 500,
      maxIdleTimeMS: 10000,
      keepAliveInitialDelay: 5000,
      serverMonitoringMode: "stream",
      retryReads: false,
      retryWrites: false,
      monitorCommands: true,
    });
    const open = mongoOptions("db", spec({ checkout_timeout: never, pool_idle_expiry: never })).options;
    expect(open).toMatchObject({ waitQueueTimeoutMS: 0, maxIdleTimeMS: 0 });
  });

  it("starts from knobs that the cells of S1 measured, and they hold the borders of the law", () => {
    expect(specProblems("db", spec(MONGO_STARTING_KNOBS))).toEqual([]);
    const { client } = made(MONGO_STARTING_KNOBS);
    expect(client.declaration.knobs["driver_writeoff_time"]).toEqual(s(7));
    const svc = service("app")
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(45) })
      .startup(s(30))
      .phase("tear down dependencies", s(5))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    client.attach(svc, { poll: MONGO_STARTING_POLL, steps: { "round-trip": "readiness" } });
    expect(client.problems(svc.describe())).toEqual([]);
  });
});

describe("the dial: a hello in an OP_MSG, and its reply", () => {
  /** an OP_MSG reply with one document, from BSON elements */
  const reply = (elements: Buffer, opCode = 2013): Buffer => {
    const doc = Buffer.concat([Buffer.alloc(4), elements, Buffer.of(0)]);
    doc.writeInt32LE(doc.length, 0);
    const header = Buffer.alloc(21);
    header.writeInt32LE(21 + doc.length, 0);
    header.writeInt32LE(opCode, 12);
    return Buffer.concat([header, doc]);
  };
  const double = (key: string, value: number): Buffer => {
    const out = Buffer.alloc(1 + key.length + 1 + 8);
    out[0] = 0x01;
    out.write(key, 1, "latin1");
    out.writeDoubleLE(value, key.length + 2);
    return out;
  };
  const string = (key: string, value: string): Buffer => {
    const text = Buffer.from(`${value}\0`, "latin1");
    const out = Buffer.alloc(1 + key.length + 1 + 4);
    out[0] = 0x02;
    out.write(key, 1, "latin1");
    out.writeInt32LE(text.length, key.length + 2);
    return Buffer.concat([out, text]);
  };

  it("sends a hello of 52 bytes to the admin database", () => {
    const hello = Buffer.from(HELLO);
    expect(hello.length).toBe(52);
    expect(hello.readInt32LE(0)).toBe(52);
    expect(hello.readInt32LE(12)).toBe(2013);
    expect(hello.readInt32LE(21)).toBe(31);
    expect(hello.toString("latin1", 26, 31)).toBe("hello");
  });

  it("passes ok 1 after the other fields, waits for the whole message, and refuses a bad answer", () => {
    const good = reply(Buffer.concat([string("setName", "rs0"), double("ok", 1)]));
    expect(helloJudge(good)).toBeNull();
    expect(helloJudge(good.subarray(0, good.length - 3))).toBe("more");
    expect(helloJudge(good.subarray(0, 2))).toBe("more");
    expect(helloJudge(reply(double("ok", 0)))).toEqual(new Error("the hello reply has ok 0"));
    expect(helloJudge(reply(double("ok", 1), 1))).toEqual(new Error("the answer to the hello has the op code 1, not 2013"));
    expect(helloJudge(reply(string("setName", "rs0")))).toEqual(new Error("the hello reply has no ok"));
  });
});

describe("the join at each connection: the connection id of the server (D1, D2)", () => {
  it("records the address and the server's id of each connection of the pool", async () => {
    const { client, driver, clock } = await connected();
    expect(client.status).toBe("ready");
    expect(client.joins).toEqual([
      {
        generation: 1,
        at: 1000,
        address: "mongo:27017",
        serverConnectionId: 100,
        localAddress: null,
        localPort: null,
        remoteAddress: "mongo",
        remotePort: 27017,
      },
    ]);
    driver().breakConnections("fin");
    await clock.advance(0);
    await client.command("find user", { find: "users" });
    expect(client.joins.map((join) => [join.generation, join.serverConnectionId])).toEqual([
      [1, 100],
      [2, 101],
    ]);
  });

  it("does not stop the startup for a server that is down: it fails until a server is writable", async () => {
    const { client, driver, clock, events } = made({}, {}, "refuse");
    const connecting = client.handle.connect(new AbortController().signal);
    await clock.advance(500);
    await connecting;
    expect(client.status).toBe("failing");
    expect(events.map((event) => event.on).filter((on) => on !== "heartbeat.failed")).toEqual(["status.connecting", "connect.failed"]);
    // the connect of the driver goes on, and fails at client_retry_window
    await clock.advance(700);
    expect(events.filter((event) => event.on === "connect.failed")).toHaveLength(2);
    driver().mode = "up";
    await clock.advance(500);
    expect(client.status).toBe("ready");
    expect(await client.command("find user", { find: "users" })).toMatchObject({ outcome: "ok" });
  });

  it("goes to failing when no server is writable, and back to ready when the monitor finds one", async () => {
    const { client, driver, clock, events } = await connected();
    driver().mode = "refuse";
    driver().breakConnections("rst");
    await clock.advance(0);
    expect(client.status).toBe("failing");
    driver().mode = "up";
    await clock.advance(500);
    expect(client.status).toBe("ready");
    expect(events.map((event) => event.on)).toEqual(expect.arrayContaining(["topology.unwritable", "pool.cleared", "topology.writable"]));
  });
});

describe("three outcomes, never an empty success (C7, C8, C10)", () => {
  it("tells a reply, an error of the server, and a command that did not leave the client apart", async () => {
    const { client, driver } = await connected();
    driver().reply = () => ({ ok: 1, n: 1 });
    expect(await client.command("find user", { find: "users" })).toEqual({ outcome: "ok", value: { ok: 1, n: 1 }, attempts: 1 });
    driver().reply = () => new FakeMongoError("MongoServerError", "E11000 duplicate key error", { code: 11000 });
    // an error of the server is certain: the client does not send it again, also when the operation is idempotent
    expect(await client.command("find user", { find: "users" })).toMatchObject({
      outcome: "error",
      reply: true,
      attempts: 1,
      error: expect.stringMatching(/^11000/),
    });
    await client.handle.close();
    expect(await client.command("find user", { find: "users" })).toMatchObject({ outcome: "error", reply: false });
  });

  it("calls an interruption of the server and a write concern error not certain", async () => {
    const { client, driver } = await connected();
    driver().reply = () => new FakeMongoError("MongoServerError", "operation was interrupted", { code: 11602 });
    expect(await client.command("add order", { insert: "orders" })).toMatchObject({ outcome: "indeterminate", attempts: 1 });
    driver().reply = () => ({ ok: 1, n: 1, writeConcernError: { code: 64, errmsg: "waiting for replication timed out" } });
    expect(await client.command("add order", { insert: "orders" })).toMatchObject({
      outcome: "indeterminate",
      error: "write concern 64 waiting for replication timed out",
    });
  });

  it("reads the name of each error of the driver, and depends on no class of it", () => {
    const named = (name: string, extra = {}) => failureOutcome(new FakeMongoError(name, "x", extra));
    for (const name of ["MongoServerSelectionError", "MongoWaitQueueTimeoutError", "MongoPoolClearedError", "MongoNotConnectedError"])
      expect(named(name), name).toEqual({ outcome: "error", error: "x", reply: false });
    expect(named("MongoNetworkError", { beforeHandshake: true })).toMatchObject({ outcome: "error", reply: false });
    expect(named("MongoNetworkError")).toMatchObject({ outcome: "indeterminate" });
    expect(named("PoolClearedOnNetworkError")).toMatchObject({ outcome: "indeterminate" });
    expect(named("MongoNetworkTimeoutError")).toMatchObject({ outcome: "indeterminate" });
    expect(named("MongoServerError", { code: 10107 })).toEqual({ outcome: "error", error: "10107 x", reply: true });
    expect(named("MongoServerError", { code: 91 })).toMatchObject({ outcome: "indeterminate" });
  });

  it("settles a command in flight as indeterminate at the reset of its connection", async () => {
    const { client, driver, clock } = await connected();
    driver().mode = "silent";
    const pending = client.command("add order", { insert: "orders" });
    await clock.advance(100);
    driver().breakConnections("rst");
    await clock.advance(0);
    expect(clock.now()).toBe(1100);
    expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 1, error: "read ECONNRESET" });
  });

  it("ends a command in a black hole at request_timeout, and the driver closes its connection", async () => {
    const { client, driver, clock } = await connected();
    driver().mode = "silent";
    const pending = client.command("add order", { insert: "orders" });
    await clock.advance(800);
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: expect.stringMatching(/timed out/) });
    expect(driver().connections).toHaveLength(0);
    driver().mode = "up";
    expect(await client.command("find user", { find: "users" })).toMatchObject({ outcome: "ok" });
    expect(client.joins).toHaveLength(2);
  });

  it("writes the deadline in each command, and lets the server end a slow command first, with a certain error (O07)", async () => {
    const { client, driver, clock } = await connected();
    expect(driver().calls[0]).toEqual(["app", { ping: 1, maxTimeMS: 600 }]);
    driver().mode = "stall";
    const pending = client.command("add order", { insert: "orders" });
    await clock.advance(600);
    expect(await pending).toMatchObject({ outcome: "error", reply: true, error: expect.stringMatching(/^50 /) });
    // the connection stays: it went back to the pool
    expect(driver().connections).toHaveLength(1);
  });

  it("gives up a command that the caller abandons as indeterminate: it cannot cancel it (principle 9)", async () => {
    const { client, driver, clock } = await connected();
    driver().mode = "silent";
    const caller = new AbortController();
    const pending = client.command("add order", { insert: "orders" }, { signal: caller.signal });
    await clock.advance(50);
    caller.abort();
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: "the caller abandoned the command after it went to the driver" });
  });

  it("waits for a writable server in client_retry_window, and then the command did not leave the client", async () => {
    const { client, driver, clock } = await connected();
    driver().mode = "refuse";
    driver().breakConnections("rst");
    await clock.advance(0);
    const pending = client.command("add order", { insert: "orders" });
    await clock.advance(1200);
    expect(await pending).toMatchObject({ outcome: "error", reply: false, error: "Server selection timed out after 1200 ms" });
  });

  it("rides through a failover in client_retry_window: the command waits for the new primary", async () => {
    const { client, driver, clock } = await connected();
    driver().mode = "refuse";
    driver().breakConnections("rst");
    await clock.advance(0);
    const pending = client.command("add order", { insert: "orders" });
    await clock.advance(400);
    driver().mode = "up";
    await clock.advance(500);
    expect(await pending).toMatchObject({ outcome: "ok", attempts: 1 });
  });

  it("fails a checkout of a full pool at checkout_timeout, and the command did not leave the client", async () => {
    const { client, driver, clock } = await connected({}, { pool: { max: 1, min: 0 } });
    driver().mode = "silent";
    const first = client.command("add order", { insert: "orders" });
    const second = client.command("add order", { insert: "orders" });
    await clock.advance(500);
    expect(await second).toMatchObject({
      outcome: "error",
      reply: false,
      error: "Timed out while checking out a connection from connection pool",
    });
    // a full pool is not a server that is not writable
    expect(client.status).toBe("ready");
    await clock.advance(300);
    await first;
  });
});

describe("a second try: only a named, idempotent operation, one time, in the bound of the call (C8)", () => {
  it("sends an idempotent operation again after a reset, on a new connection", async () => {
    const { client, driver, clock, events } = await connected();
    driver().mode = "silent";
    const pending = client.command("find user", { find: "users" });
    await clock.advance(10);
    driver().mode = "up";
    driver().breakConnections("rst");
    await clock.advance(0);
    expect(await pending).toMatchObject({ outcome: "ok", attempts: 2 });
    expect(events.filter((event) => event.on === "command.reissue").map((event) => event.detail)).toEqual(["find user"]);
  });

  it("never sends again an operation that is not idempotent, or that the table does not name", async () => {
    const { client, driver, clock } = await connected();
    for (const operation of ["add order", "an unnamed command"]) {
      // a command that the server answers opens a connection: a silent server opens none
      await client.command("find user", { find: "users" });
      driver().mode = "silent";
      const pending = client.command(operation, { update: "counters" });
      await clock.advance(10);
      driver().mode = "up";
      driver().breakConnections("rst");
      await clock.advance(0);
      expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 1 });
    }
    expect(driver().calls.filter(([, document]) => "update" in document)).toHaveLength(2);
  });

  it("ends the second try at the bound of the call, client_retry_window + request_timeout from its start", async () => {
    const { client, driver, clock } = await connected();
    driver().mode = "silent";
    const start = clock.now();
    const pending = client.command("find user", { find: "users" });
    let settled: number | null = null;
    void pending.then(() => {
      settled = clock.now();
    });
    await clock.advance(400);
    // the reset finds no writable server: the second try waits in the selection
    driver().breakConnections("rst");
    await clock.advance(900);
    // the monitor finds the server at its next check, and the server is silent again at the command
    driver().mode = "up";
    driver().on("commandStarted", () => {
      driver().mode = "silent";
    });
    await clock.advance(5000);
    expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 2 });
    expect(settled! - start).toBe(2000);
  });
});

describe("no error of the driver ends the process (A5)", () => {
  it("listens to the error event of the driver", async () => {
    const { driver, events } = await connected();
    expect(() => driver().emitError(new Error("wire version mismatch"))).not.toThrow();
    expect(events.filter((event) => event.on === "client.error").map((event) => event.detail)).toEqual(["wire version mismatch"]);
  });

  it("the fake throws as Node does when nobody listens: the negative control", () => {
    const driver = fakeMongo(mongoOptions("db", spec()), fakeClock(0));
    expect(() => driver.emitError(new Error("wire version mismatch"))).toThrow("wire version mismatch");
  });
});

describe("the write-off of a silent server: the monitor finds it, in flight and idle", () => {
  it("fails a command in flight at connect_bound + heartbeat_interval after the last answer, and goes to failing", async () => {
    const { client, driver, clock, events } = await connected({ request_timeout: s(5) });
    driver().mode = "silent";
    const start = clock.now();
    const pending = client.command("add order", { insert: "orders" });
    let settled: number | null = null;
    void pending.then(() => {
      settled = clock.now();
    });
    await clock.advance(1000);
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: expect.stringMatching(/interrupted due to server monitor timeout/) });
    expect(settled! - start).toBe(1000);
    expect(client.status).toBe("failing");
    expect(events.map((event) => event.on)).toEqual(expect.arrayContaining(["heartbeat.failed", "topology.unwritable", "pool.cleared"]));
  });

  it("ends an idle connection older than pool_idle_expiry at the next checkout, and opens a new one", async () => {
    const { client, driver, clock } = await connected();
    await clock.advance(10_001);
    expect(driver().connections).toHaveLength(1);
    await client.command("find user", { find: "users" });
    expect(client.joins).toHaveLength(2);
    expect(driver().connections).toHaveLength(1);
  });
});

describe("the close: the close of the driver in its bound (A9, A14, principle 9)", () => {
  it("closes at once when the server answers", async () => {
    const { client, clock } = await connected();
    const start = clock.now();
    await client.handle.close();
    expect(clock.now() - start).toBe(0);
    expect(client.status).toBe("end");
  });

  it("stops its wait at the bound when the server is silent, and settles what is in flight", async () => {
    const { client, driver, clock, events } = await connected({ request_timeout: s(5) });
    driver().mode = "silent";
    const pending = client.command("add order", { insert: "orders" });
    await clock.advance(10);
    const closing = client.handle.close();
    await clock.advance(300);
    await closing;
    // the driver gives no socket, thus the close records no destroy
    expect(events.map((event) => event.on).filter((on) => on.startsWith("close"))).toEqual(["close.request", "close.bound"]);
    expect(clock.now() - 1000).toBeLessThanOrEqual(310);
    expect(client.status).toBe("end");
    expect(await pending).toMatchObject({ outcome: "indeterminate" });
  });
});

describe("the checks of each step of the connection (B7, B14)", () => {
  const poll = { interval: s(1), jitter: 0.2, timeout: ms(400) };

  it("gives a check for each step asked, with its policy, and whether it uses the application's pool", () => {
    const { client } = made();
    const checks = client.checks({ poll, steps: { "round-trip": "readiness", dial: null, "local-state": "liveness" } });
    expect(checks.map(([check]) => [check.name, check.step, check.gates, check.ownConnection])).toEqual([
      ["db.local-state", "local-state", "liveness", true],
      ["db.round-trip", "round-trip", "readiness", true],
      ["db.dial", "dial", null, false],
    ]);
  });

  it("passes a ping, and fails when no server is writable", async () => {
    const { client, driver, clock } = await connected();
    const [, roundTrip] = client.checks({ poll, steps: { "round-trip": "readiness" } })[0]!;
    expect(await roundTrip(new AbortController().signal)).toBe("ok");
    expect(driver().calls.at(-1)).toEqual(["app", { ping: 1, maxTimeMS: 600 }]);
    driver().mode = "refuse";
    driver().breakConnections("rst");
    await clock.advance(0);
    const result = roundTrip(new AbortController().signal);
    await clock.advance(1200);
    expect(await result).toBe("error");
  });

  it("says when its close does not fit in its phase, its request outlives a poll (O13), or the server cannot end a command first (O07)", () => {
    const { client } = made({ request_timeout: s(5), statement_timeout: s(6), close_bound: s(3) });
    const svc = service("app")
      .readiness({ type: "debounce", interval: s(1), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(6) })
      .startup(s(10))
      .phase("tear down dependencies", s(2))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    client.attach(svc, { poll, steps: { "round-trip": "readiness" } });
    expect(client.problems(svc.describe())).toEqual([
      'db\'s close_bound of 3000 ms does not fit in the cap of "tear down dependencies"',
      "db's request_timeout outlives one jittered poll of db.round-trip (B7, O13)",
      "db's request_timeout is not above its statement_timeout: the server goes on with a command that the client gave up (O07)",
    ]);
  });
});

describe("the manifestations that the client meets, and their detectors (E9, C3)", () => {
  it("finds each manifestation in each situation with the starting knobs, the write-off first", () => {
    const { client } = made(MONGO_STARTING_KNOBS);
    const meet = (name: string) => client.meets.find((meeting) => meeting.manifestation === name)!;
    expect(firstDetector(meet("blackhole"), "in flight")).toMatchObject({ by: "driver_writeoff_time", within: s(7) });
    expect(firstDetector(meet("blackhole"), "idle")).toMatchObject({ by: "driver_writeoff_time", within: s(7) });
    expect(firstDetector(meet("rst"), "idle")).toMatchObject({ by: "heartbeat_interval", within: s(2) });
    expect(firstDetector(meet("app-stall"), "in flight")).toMatchObject({ by: "statement_timeout", within: s(9) });
    expect(unwatched(client.meets)).toEqual([]);
  });

  it("names what nothing finds with no idle expiry: an idle connection to a server that stalls", () => {
    const { client } = made({ pool_idle_expiry: never });
    expect(unwatched(client.meets)).toEqual([{ manifestation: "app-stall", situation: "idle" }]);
  });
});

describe("the client as a document (D4, E8)", () => {
  it("is a valid, consistent machine document", () => {
    expect(machineSchema.safeParse(MONGO_CLIENT_MACHINE).success).toBe(true);
    expect(machineProblems(MONGO_CLIENT_MACHINE)).toEqual([]);
  });

  const scenarios: Record<string, (all: Awaited<ReturnType<typeof connected>>) => Promise<void>> = {
    "a reset, and a new connection": async ({ client, driver, clock }) => {
      driver().breakConnections("rst");
      await clock.advance(0);
      await client.command("find user", { find: "users" });
    },
    "a refused server, then a server that is back": async ({ client, driver, clock }) => {
      driver().mode = "refuse";
      driver().breakConnections("rst");
      await clock.advance(0);
      // an operation that is not idempotent: the core sends no second try after the selection times out
      const pending = client.command("add order", { insert: "orders" });
      await clock.advance(1200);
      await pending;
      driver().mode = "up";
      await clock.advance(500);
      await client.command("find user", { find: "users" });
    },
    "a write-off of a silent server": async ({ client, driver, clock }) => {
      driver().mode = "silent";
      const pending = client.command("add order", { insert: "orders" });
      await clock.advance(1000);
      await pending;
    },
    "a bounded close of a silent server": async ({ client, driver, clock }) => {
      driver().mode = "silent";
      const pending = client.command("add order", { insert: "orders" });
      await clock.advance(10);
      const closing = client.handle.close();
      await clock.advance(300);
      await closing;
      await pending;
    },
    "a command sent again": async ({ client, driver, clock }) => {
      driver().mode = "silent";
      const pending = client.command("find user", { find: "users" });
      await clock.advance(10);
      driver().mode = "up";
      driver().breakConnections("rst");
      await clock.advance(0);
      await pending;
    },
    "an error event of the driver": async ({ driver }) => {
      driver().emitError(new Error("wire version mismatch"));
    },
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`replays ${name} against the document`, async () => {
      const all = await connected();
      await scenario(all);
      expect(all.events.length).toBeGreaterThan(2);
      expect(replay(MONGO_CLIENT_MACHINE, all.events)).toEqual([]);
    });
  }
});
