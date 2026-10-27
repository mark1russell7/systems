import { machineProblems } from "@mark1russell7/algebra";
import { machineSchema } from "@mark1russell7/algebra/schema";
import { describe, expect, it } from "vitest";
import type { LifecycleEvent } from "../index.ts";
import { replay, service } from "../index.ts";
import { fakeClock } from "../testing.ts";
import type { PgClientSpec, PgKnobs, PgPoolOptions } from "../pg.ts";
import {
  PG_CLIENT_MACHINE,
  PG_STARTING_KNOBS,
  PG_STARTING_POLL,
  firstDetector,
  pgClient,
  poolOptions,
  specProblems,
  unwatched,
} from "../pg.ts";
import type { FakePg } from "./fake.ts";
import { DatabaseError, fakePg } from "./fake.ts";

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const never = { value: "infinite" as const, unit: "s" };

const KNOBS: PgKnobs = {
  connect_bound: ms(500),
  request_timeout: ms(800),
  statement_timeout: ms(600),
  pool_idle_expiry: s(10),
  keepalive_idle: s(5),
  max_connection_age: never,
  close_bound: ms(300),
  retrans_giveup_time: s(924.6),
};

const spec = (knobs: Partial<PgKnobs> = {}, more: Partial<PgClientSpec> = {}): PgClientSpec => ({
  host: "postgres",
  port: 5432,
  database: "app",
  user: "app",
  system: "systems.component.postgresql",
  knobs: { ...KNOBS, ...knobs },
  pool: { max: 2, min: 0 },
  operations: { "read user": { idempotent: true }, "add order": { idempotent: false } },
  ...more,
});

/** a client on a fake pool and a fake clock, its events, and the fake pool */
const made = (knobs: Partial<PgKnobs> = {}, more: Partial<PgClientSpec> = {}, mode: FakePg["mode"] = "up") => {
  const clock = fakeClock(1000);
  const events: LifecycleEvent[] = [];
  let pool: FakePg | undefined;
  let given: PgPoolOptions | undefined;
  const client = pgClient("db", spec(knobs, more), {
    clock,
    record: (event) => events.push(event),
    dial: async () => {},
    create: (options) => {
      given = options;
      pool = fakePg(options, clock);
      pool.mode = mode;
      return pool;
    },
  });
  return { clock, client, events, pool: () => pool!, options: () => given! };
};

const connected = async (knobs: Partial<PgKnobs> = {}, more: Partial<PgClientSpec> = {}) => {
  const all = made(knobs, more);
  await all.client.handle.connect(new AbortController().signal);
  await all.clock.advance(0);
  return all;
};

describe("the declaration: knobs by the names of the law, and no default (C1, C2, E3)", () => {
  it("declares each knob as a time, and its keepalive as the refresh of an idle flow", () => {
    const { client } = made();
    expect(Object.keys(client.declaration.knobs).sort()).toEqual(
      [
        "close_bound",
        "connect_bound",
        "idle_refresh_interval",
        "keepalive_idle",
        "max_connection_age",
        "pool_idle_expiry",
        "request_timeout",
        "retrans_giveup_time",
        "statement_timeout",
      ].sort(),
    );
    expect(client.declaration.knobs["idle_refresh_interval"]).toEqual(s(5));
    expect(client.declaration.operations["read user"]).toEqual({ idempotent: true });
  });

  it("refuses what pg cannot do, and says why", () => {
    expect(specProblems("db", spec({ request_timeout: ms(0) }))).toContain(
      "db's request_timeout is not a finite time above zero: pg reads 0 as no bound",
    );
    expect(specProblems("db", spec({ connect_bound: never as never }))[0]).toMatch(/connect_bound is not a finite time/);
    expect(specProblems("db", spec({ pool_idle_expiry: s(0) }))).toEqual(['db\'s pool_idle_expiry is zero: give "infinite" for no bound']);
    expect(specProblems("db", spec({ keepalive_idle: ms(1500) }))).toEqual(["db's keepalive_idle is not a whole number of seconds"]);
    expect(specProblems("db", spec({ request_timeout: { value: 0.5, unit: "ms" } }))).toEqual([
      "db's request_timeout is not a whole number of milliseconds",
    ]);
    expect(specProblems("db", spec({}, { pool: { max: 2, min: 3 } }))[0]).toMatch(/min of 3/);
    expect(() => pgClient("db", spec({}, { pool: { max: 0, min: 0 } }))).toThrow(/max of 0/);
  });

  it("gives pg each timer from the declaration, and writes a bound that nobody gives as 0, no timer", () => {
    expect(poolOptions("db", spec())).toMatchObject({
      application_name: "db",
      max: 2,
      min: 0,
      connectionTimeoutMillis: 500,
      query_timeout: 800,
      statement_timeout: 600,
      idleTimeoutMillis: 10000,
      maxLifetimeSeconds: 0,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000,
      allowExitOnIdle: true,
    });
    const open = poolOptions("db", spec({ statement_timeout: never, pool_idle_expiry: never, keepalive_idle: never, max_connection_age: s(1800) }));
    expect(open).toMatchObject({ statement_timeout: undefined, idleTimeoutMillis: 0, keepAlive: false, maxLifetimeSeconds: 1800 });
  });

  it("starts from knobs that the cells of S1 measured, and they hold the borders of the law", () => {
    expect(specProblems("db", spec(PG_STARTING_KNOBS))).toEqual([]);
    const { client } = made(PG_STARTING_KNOBS);
    const svc = service("app")
      .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
      .liveness({ type: "window", failAfter: s(45) })
      .startup(s(30))
      .phase("tear down dependencies", s(5))
      .onRepeatSignal("ignore")
      .cooperativeWindow(s(1));
    client.attach(svc, { poll: PG_STARTING_POLL, steps: { "round-trip": "readiness" } });
    expect(client.problems(svc.describe())).toEqual([]);
  });
});

describe("the join at each connect: the process id of the backend (D1, D2)", () => {
  it("records the backend and the socket of each connection", async () => {
    const { client, pool, clock } = await connected();
    expect(client.status).toBe("ready");
    expect(client.joins).toEqual([
      { generation: 1, at: 1000, backendPid: 4000, localAddress: "10.0.0.2", localPort: 50001, remoteAddress: "10.0.0.4", remotePort: 5432 },
    ]);
    pool().breakConnections("fin");
    await clock.advance(0);
    await client.query("read user", "SELECT 1");
    expect(client.joins.map((join) => [join.generation, join.backendPid])).toEqual([
      [1, 4000],
      [2, 4001],
    ]);
  });

  it("does not stop the startup for a server that is down: it fails until a connect succeeds", async () => {
    const { client, pool, events } = made({}, {}, "refuse");
    await client.handle.connect(new AbortController().signal);
    expect(client.status).toBe("failing");
    expect(events.map((event) => event.on)).toEqual(["status.connecting", "connect.failed"]);
    pool().mode = "up";
    expect(await client.query("read user", "SELECT 1")).toMatchObject({ outcome: "ok" });
    expect(client.status).toBe("ready");
  });

  it("fails a connect to a silent server at connect_bound", async () => {
    const { client, clock } = made({}, {}, "silent");
    const connecting = client.handle.connect(new AbortController().signal);
    await clock.advance(500);
    await connecting;
    expect(client.status).toBe("failing");
  });

  it("goes to failing when a connect fails, and back to ready at the next join", async () => {
    const { client, pool, clock, events } = await connected();
    pool().breakConnections("rst");
    pool().mode = "refuse";
    await clock.advance(0);
    expect(await client.query("read user", "SELECT 1")).toMatchObject({ outcome: "error", reply: false });
    expect(client.status).toBe("failing");
    pool().mode = "up";
    expect(await client.query("read user", "SELECT 1")).toMatchObject({ outcome: "ok" });
    expect(client.status).toBe("ready");
    expect(events.map((event) => event.on)).toContain("connect.failed");
  });
});

describe("three outcomes, never an empty success (C7, C8, C10)", () => {
  it("tells a reply, an error of the server, and a query that did not leave the client apart", async () => {
    const { client, pool } = await connected();
    pool().reply = () => ({ rows: [{ id: 1 }] as never[], rowCount: 1 });
    expect(await client.query("read user", "SELECT id FROM users WHERE id = $1", [1])).toEqual({
      outcome: "ok",
      value: { rows: [{ id: 1 }], rowCount: 1 },
      attempts: 1,
    });
    pool().reply = () => new DatabaseError("duplicate key value violates unique constraint", "23505");
    // an ERROR is certain: the client does not send it again, also when the operation is idempotent
    expect(await client.query("read user", "SELECT 1")).toMatchObject({ outcome: "error", reply: true, attempts: 1, error: expect.stringMatching(/^23505/) });
    await client.handle.close();
    expect(await client.query("read user", "SELECT 1")).toMatchObject({ outcome: "error", reply: false });
  });

  it("calls a FATAL of the server not certain: the session ended, and a commit can have occurred", async () => {
    const { client, pool } = await connected();
    pool().reply = () => new DatabaseError("terminating connection due to administrator command", "57P01", "FATAL");
    expect(await client.query("add order", "INSERT INTO orders VALUES (1)")).toMatchObject({ outcome: "indeterminate", attempts: 1 });
  });

  it("settles a query in flight as indeterminate at the reset of its connection", async () => {
    const { client, pool, clock } = await connected();
    pool().mode = "silent";
    const pending = client.query("add order", "INSERT INTO orders VALUES (1)");
    await clock.advance(100);
    pool().breakConnections("rst");
    await clock.advance(0);
    expect(clock.now()).toBe(1100);
    expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 1, error: "read ECONNRESET" });
  });

  it("ends a query in a black hole at request_timeout, and the pool ends its client: the orphan holds no checkout", async () => {
    const { client, pool, clock } = await connected();
    pool().mode = "silent";
    const pending = client.query("add order", "INSERT INTO orders VALUES (1)");
    await clock.advance(800);
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: "Query read timeout" });
    // the client went back with an error: its query was active, thus the end destroyed the socket
    expect(pool().clients).toHaveLength(0);
    pool().mode = "up";
    expect(await client.query("read user", "SELECT 1")).toMatchObject({ outcome: "ok" });
    expect(client.joins).toHaveLength(2);
  });

  it("lets the server end a slow statement first, with a certain error (O07)", async () => {
    const { client, pool, clock } = await connected();
    pool().mode = "stall";
    const pending = client.query("add order", "INSERT INTO orders VALUES (1)");
    await clock.advance(600);
    expect(await pending).toMatchObject({ outcome: "error", reply: true, error: expect.stringMatching(/^57014/) });
    // the session stays: the client went back to the pool
    expect(pool().idleCount).toBe(1);
  });

  it("gives up a sent query that the caller abandons as indeterminate: it cannot cancel it (principle 9)", async () => {
    const { client, pool, clock } = await connected();
    pool().mode = "silent";
    const caller = new AbortController();
    const pending = client.query("add order", "INSERT INTO orders VALUES (1)", [], { signal: caller.signal });
    await clock.advance(50);
    caller.abort();
    expect(await pending).toMatchObject({ outcome: "indeterminate", error: "the caller abandoned the query after it was sent" });
  });

  it("fails a checkout of a full pool at connect_bound, and the query did not leave the client", async () => {
    const { client, pool, clock, events } = await connected({}, { pool: { max: 1, min: 0 } });
    pool().mode = "silent";
    const first = client.query("add order", "INSERT INTO orders VALUES (1)");
    const second = client.query("add order", "INSERT INTO orders VALUES (2)");
    await clock.advance(500);
    expect(await second).toMatchObject({ outcome: "error", reply: false, error: "timeout exceeded when trying to connect" });
    expect(events.some((event) => event.on === "checkout.timeout")).toBe(true);
    // a full pool is not a failed connect
    expect(client.status).toBe("ready");
    await clock.advance(300);
    await first;
  });
});

describe("a second try: only a named, idempotent operation, one time, in the bound of the request (C8)", () => {
  it("sends an idempotent operation again after a reset, on a new connection", async () => {
    const { client, pool, clock, events } = await connected();
    pool().mode = "silent";
    const pending = client.query("read user", "SELECT 1");
    await clock.advance(10);
    pool().mode = "up";
    pool().breakConnections("rst");
    await clock.advance(0);
    expect(await pending).toMatchObject({ outcome: "ok", attempts: 2 });
    expect(events.filter((event) => event.on === "command.reissue").map((event) => event.detail)).toEqual(["read user"]);
  });

  it("never sends again an operation that is not idempotent, or that the table does not name", async () => {
    const { client, pool, clock } = await connected();
    for (const operation of ["add order", "an unnamed query"]) {
      // a query that the server answers opens a connection: a silent server opens none
      await client.query("read user", "SELECT 1");
      pool().mode = "silent";
      const pending = client.query(operation, "UPDATE t SET n = n + 1");
      await clock.advance(10);
      pool().mode = "up";
      pool().breakConnections("rst");
      await clock.advance(0);
      expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 1 });
    }
    expect(pool().calls.filter(([text]) => text.startsWith("UPDATE"))).toHaveLength(2);
  });

  it("ends the second try at the bound of the request, not one bound after its own start", async () => {
    const { client, pool, clock } = await connected();
    pool().mode = "silent";
    const start = clock.now();
    const pending = client.query("read user", "SELECT 1");
    await clock.advance(100);
    // the new connection works, and the server is silent again at once
    pool().mode = "up";
    pool().breakConnections("rst");
    pool().on("connect", () => {
      pool().mode = "silent";
    });
    let settled: number | null = null;
    void pending.then(() => {
      settled = clock.now();
    });
    await clock.advance(5000);
    expect(await pending).toMatchObject({ outcome: "indeterminate", attempts: 2 });
    expect(settled! - start).toBe(800);
  });
});

describe("no error of pg ends the process (A5)", () => {
  it("listens to an idle client that fails, and to a client that it holds", async () => {
    const { client, pool, clock, events } = await connected();
    expect(() => pool().breakConnections("fin")).not.toThrow();
    await client.query("read user", "SELECT 1");
    pool().mode = "silent";
    const pending = client.query("add order", "INSERT INTO orders VALUES (1)");
    await clock.advance(10);
    expect(() => pool().breakConnections("rst")).not.toThrow();
    await pending;
    expect(events.filter((event) => event.on === "client.error")).toHaveLength(2);
  });

  it("the fake throws as Node does when nobody listens: the negative control", () => {
    const clock = fakeClock(0);
    const pool = fakePg(poolOptions("db", spec()), clock);
    return pool.connect().then((held) => {
      held.release();
      expect(() => pool.breakConnections("fin")).toThrow("Connection terminated unexpectedly");
    });
  });
});

describe("the idle time of the pool: no test of an idle client, an end at pool_idle_expiry", () => {
  it("ends an idle client at its idle timer, and the next checkout opens a new connection", async () => {
    const { client, pool, clock, events } = await connected();
    expect(pool().idleCount).toBe(1);
    await clock.advance(10_000);
    expect(pool().totalCount).toBe(0);
    expect(events.some((event) => event.on === "client.removed")).toBe(true);
    await client.query("read user", "SELECT 1");
    expect(client.joins).toHaveLength(2);
  });
});

describe("the close: the end of the pool, then a destroy at its bound (A9, A14, principle 9)", () => {
  it("closes at once when the server answers", async () => {
    const { client, clock } = await connected();
    const start = clock.now();
    await client.handle.close();
    expect(clock.now() - start).toBe(0);
    expect(client.status).toBe("end");
  });

  it("destroys each socket at its bound when the server is silent, and settles what is in flight", async () => {
    const { client, pool, clock, events } = await connected({ request_timeout: s(5) });
    pool().mode = "silent";
    const pending = client.query("add order", "INSERT INTO orders VALUES (1)");
    await clock.advance(10);
    const closing = client.handle.close();
    await clock.advance(300);
    await closing;
    expect(events.map((event) => event.on).filter((on) => on.startsWith("close"))).toEqual(["close.request", "close.bound", "close.destroy"]);
    expect(clock.now() - 1000).toBeLessThanOrEqual(310);
    expect(client.status).toBe("end");
    expect(await pending).toMatchObject({ outcome: "indeterminate" });
    expect(pool().totalCount).toBe(0);
  });
});

describe("the checks of each step of the connection (B7, B14)", () => {
  const poll = { interval: s(1), jitter: 0.2, timeout: ms(400) };

  it("gives a check for each step asked, with its policy, and whether it uses the application's pool", () => {
    const { client } = made();
    const checks = client.checks({ poll, steps: { "round-trip": "readiness", dial: null, "local-state": "liveness", checkout: null } });
    expect(checks.map(([check]) => [check.name, check.step, check.gates, check.ownConnection])).toEqual([
      ["db.local-state", "local-state", "liveness", true],
      ["db.checkout", "checkout", null, true],
      ["db.round-trip", "round-trip", "readiness", true],
      ["db.dial", "dial", null, false],
    ]);
  });

  it("passes a SELECT 1, and fails on a pool that cannot connect", async () => {
    const { client, pool, clock } = await connected();
    const [, roundTrip] = client.checks({ poll, steps: { "round-trip": "readiness" } })[0]!;
    expect(await roundTrip(new AbortController().signal)).toBe("ok");
    expect(pool().calls.at(-1)).toEqual(["SELECT 1", []]);
    pool().mode = "refuse";
    pool().breakConnections("rst");
    await clock.advance(0);
    expect(await roundTrip(new AbortController().signal)).toBe("error");
  });

  it("finds a full pool with the checkout check, and not a dead idle client", async () => {
    const { client, pool, clock } = await connected({}, { pool: { max: 1, min: 0 } });
    const [, checkout] = client.checks({ poll, steps: { checkout: "readiness" } })[0]!;
    expect(await checkout(new AbortController().signal)).toBe("ok");
    pool().mode = "silent";
    const held = client.query("add order", "INSERT INTO orders VALUES (1)");
    const check = new AbortController();
    const result = checkout(check.signal);
    await clock.advance(400);
    check.abort();
    expect(await result).toBe("error");
    await clock.advance(400);
    await held;
  });

  it("says when its close does not fit in its phase, its request outlives a poll (O13), or the server cannot end a statement first (O07)", () => {
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
      "db's request_timeout is not above its statement_timeout: the server goes on with a statement that the client gave up (O07)",
    ]);
  });
});

describe("the manifestations that the client meets, and their detectors (E9, C3)", () => {
  it("finds each manifestation in each situation with the starting knobs", () => {
    const { client } = made(PG_STARTING_KNOBS);
    const meet = (name: string) => client.meets.find((meeting) => meeting.manifestation === name)!;
    expect(firstDetector(meet("blackhole"), "in flight")).toMatchObject({ by: "request_timeout", within: s(9.5) });
    expect(firstDetector(meet("blackhole"), "idle")).toMatchObject({ by: "pool_idle_expiry", within: s(10) });
    expect(firstDetector(meet("app-stall"), "in flight")).toMatchObject({ by: "statement_timeout", within: s(9) });
    expect(unwatched(client.meets)).toEqual([]);
  });

  it("names what nothing finds at the defaults of pg: no idle timer and no keepalive", () => {
    const { client } = made({ pool_idle_expiry: never, keepalive_idle: never });
    expect(unwatched(client.meets)).toEqual([
      { manifestation: "rst", situation: "idle" },
      { manifestation: "blackhole", situation: "idle" },
      { manifestation: "freeze-host", situation: "idle" },
      { manifestation: "freeze-process", situation: "idle" },
      { manifestation: "app-stall", situation: "idle" },
    ]);
  });
});

describe("the client as a document (D4, E8)", () => {
  it("is a valid, consistent machine document", () => {
    expect(machineSchema.safeParse(PG_CLIENT_MACHINE).success).toBe(true);
    expect(machineProblems(PG_CLIENT_MACHINE)).toEqual([]);
  });

  const scenarios: Record<string, (all: Awaited<ReturnType<typeof connected>>) => Promise<void>> = {
    "a reset, and a new connection": async ({ client, pool, clock }) => {
      pool().breakConnections("rst");
      await clock.advance(0);
      await client.query("read user", "SELECT 1");
    },
    "a refused server, then a server that is back": async ({ client, pool, clock }) => {
      pool().breakConnections("rst");
      pool().mode = "refuse";
      await clock.advance(0);
      await client.query("read user", "SELECT 1");
      pool().mode = "up";
      await client.query("read user", "SELECT 1");
    },
    "an idle client at its idle timer": async ({ clock }) => {
      await clock.advance(11_000);
    },
    "a bounded close of a silent server": async ({ client, pool, clock }) => {
      pool().mode = "silent";
      const pending = client.query("add order", "INSERT INTO orders VALUES (1)");
      await clock.advance(10);
      const closing = client.handle.close();
      await clock.advance(300);
      await closing;
      await pending;
    },
    "a query sent again": async ({ client, pool, clock }) => {
      pool().mode = "silent";
      const pending = client.query("read user", "SELECT 1");
      await clock.advance(10);
      pool().mode = "up";
      pool().breakConnections("rst");
      await clock.advance(0);
      await pending;
    },
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`replays ${name} against the document`, async () => {
      const all = await connected();
      await scenario(all);
      expect(all.events.length).toBeGreaterThan(2);
      expect(replay(PG_CLIENT_MACHINE, all.events)).toEqual([]);
    });
  }
});
