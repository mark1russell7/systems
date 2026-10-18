import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { T01_HIKARI } from "./hikari.ts";
import { APP_STALL, PG_TARGET, T01_PG } from "./t01.ts";
import {
  PGBOUNCER_HOP,
  PGBOUNCER_LATENCY,
  T10_HIKARI,
  T10_HIKARI_ALIASES,
  T10_HIKARI_SPECS,
  T10_HIKARI_WAITING,
  T10_PG,
  T10_PG_SPECS,
  T10_PG_WAITING,
  POOLER_IDLE,
  pgbouncerEarliest,
  pgbouncerFirst,
  pgbouncerHop,
} from "./t10.ts";

const cell = (plan: string, cells = T10_HIKARI) => {
  const found = cells.find((each) => each.name.startsWith(`${plan} hikaricp-pgjdbc to postgresql, `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the cells of R3's plan in T10, by their client and their stage (plan.json). The cells of border-on are not counted. */
const PLAN = {
  hikari: {
    defaults: [1, 2, 3, 11, 12, 13, 14, 15, 16, 17, 18, 45],
    border: [...Array.from({ length: 88 }, (_, at) => at + 1), 97, 98, 101, 102, 103, 104],
  },
  pg: { defaults: [7, 8, 9, 27, 28, 29, 30, 31, 32, 33, 34], border: [91, 92] },
} as const;

const ids = (stages: { readonly defaults: readonly number[]; readonly border: readonly number[] }): string[] =>
  [...stages.defaults.map((n) => `T10.defaults.${n}`), ...stages.border.map((n) => `T10.border-off.${n}`)].sort();

describe("the HikariCP catalog of T10, through PgBouncer", () => {
  it("gives each cell of the plan a cell, an alias or a reason to wait, once", () => {
    const named = [...T10_HIKARI_SPECS.map((spec) => spec.plan), ...T10_HIKARI_ALIASES.map((each) => each.plan), ...T10_HIKARI_WAITING.map((each) => each.plan)];
    expect(named.sort()).toEqual(ids(PLAN.hikari));
    expect([...T10_PG_SPECS.map((spec) => spec.plan), ...T10_PG_WAITING.map((each) => each.plan)].sort()).toEqual(ids(PLAN.pg));
    for (const alias of T10_HIKARI_ALIASES) expect(() => cell(alias.is), alias.plan).not.toThrow();
    for (const each of [...T10_HIKARI_WAITING, ...T10_PG_WAITING]) expect(each.why.length, each.plan).toBeGreaterThan(20);
  });

  it("puts PgBouncer in transaction pooling between the client and the server, with the settings of each cell", () => {
    for (const each of [...T10_HIKARI, ...T10_PG]) {
      expect(each.target.image, each.name).toBe(PG_TARGET.image);
      expect(each.topology?.name, each.name).toBe("T10");
      const [hop] = each.topology?.hops ?? [];
      expect(hop?.name, each.name).toBe("pgbouncer");
      expect(hop !== undefined && "image" in hop ? hop.image : null, each.name).toEqual({ kind: "shipped", name: "pgbouncer" });
    }
    const ini = PGBOUNCER_HOP.files?.["/etc/pgbouncer/pgbouncer.ini"] ?? "";
    expect(ini).toContain("pool_mode = transaction");
    expect(ini).toContain("host={{next.host}} port={{next.port}}");
    // pgjdbc sends extra_float_digits at its startup
    expect(ini).toContain("ignore_startup_parameters = extra_float_digits");
    // a setting of a cell is the last line of the section of PgBouncer, and the manifest names it
    const timed = pgbouncerHop({ query_timeout: 4 });
    expect(timed.files?.["/etc/pgbouncer/pgbouncer.ini"]).toMatch(/ignore_startup_parameters = extra_float_digits\nquery_timeout = 4\n$/);
    expect(timed.settings?.["query_timeout"]).toBe("4");
    expect(() => pgbouncerHop({ query_timout: 4 })).toThrow(/no document of PgBouncer has a knob/);
  });

  it("finds no timer of PgBouncer at the defaults that ends a query before query_wait_timeout", () => {
    expect(pgbouncerEarliest()).toBe(120);
    expect(pgbouncerFirst("linked")).toBeNull();
    expect(pgbouncerFirst("idle")).toBeNull();
  });

  it("times the keepalive behind a black hole of the server as on the direct pair, and holds an idle connection with no keepalive", () => {
    // the check of HikariCP gets no reply through PgBouncer: its read timeout closes the socket, as in T01.defaults.52
    expect(cell("T10.defaults.1").prediction).toEqual(cell("T01.defaults.52", T01_HIKARI).prediction);
    // HikariCP before 6.2.1 had no keepalive: nothing reads the idle connection, and nothing checks it
    const quiet = cell("T10.defaults.45");
    expect(quiet.driverOptions).toEqual({ keepaliveTime: 0 });
    expect(quiet.prediction).toMatchObject({ detects: false, window: { value: 60, unit: "s" } });
  });

  it("holds the query of an app-stall through PgBouncer, and times its reply with one more hop", () => {
    const stall = cell("T10.defaults.12");
    expect(stall.probe.driver).toEqual({ name: "hikari", inflight: `SELECT pg_sleep(${APP_STALL})` });
    const p = stall.prediction;
    if (p.detects !== false) throw new Error("a silent cell");
    expect(valueIn(p.replies!.low, "s")).toBe(APP_STALL);
    const direct = cell("T01.defaults.60", T01_HIKARI).prediction;
    if (direct.detects !== false) throw new Error("a silent cell");
    expect(valueIn(p.replies!.high, "s")).toBeCloseTo(valueIn(direct.replies!.high, "s") + PGBOUNCER_LATENCY, 9);
    expect(PGBOUNCER_LATENCY).toBeCloseTo(0.012, 9);
  });

  it("places the border of query_timeout of PgBouncer on each side of the time of the query", () => {
    // inside: the reply at 5 s comes before the timer, and the reply cancels the timer
    expect(cell("T10.border-off.7").prediction).toEqual(cell("T10.defaults.12").prediction);
    // outside: a pass of the janitor finds the query older than 4 s, and PgBouncer closes the client with a FATAL
    const ended = cell("T10.border-off.8").prediction;
    if (ended.detects !== true) throw new Error("a detecting cell");
    expect([ended.timer, ended.errno, ended.from, valueIn(ended.low, "s")]).toEqual(["query_timeout", "08P01", "request-sent", 4]);
    // one pass of the janitor (333.333 ms) and the slack of its loop, then one round trip and one step of the JVM
    expect(valueIn(ended.high, "s")).toBeCloseTo(4 + 0.333333 + 0.01 + 0.002 + 0.01, 6);
    expect(ended.driver).toEqual({ socket: "pool", ends: { ev: "fail", where: { n: 2 }, name: "sqlState" } });
    expect(pgbouncerFirst("linked", { query_timeout: 4 })).toMatchObject({ timer: "query_timeout", errno: "08P01" });
  });

  it("places the read timeout on each side of a frozen server whose kernel acknowledges the query", () => {
    const inside = cell("T10.border-off.45").prediction;
    if (inside.detects !== false) throw new Error("a silent cell");
    expect(valueIn(inside.replies!.low, "s")).toBe(9);
    const outside = cell("T10.border-off.46").prediction;
    expect(outside).toMatchObject({ detects: true, timer: "socket_timeout", errno: "CLOSED", from: "request-sent", low: { value: 10, unit: "s" } });
  });

  it("places the read timeout on each side of the statement deadline of the server, through PgBouncer", () => {
    // the error of the server crosses one more hop: its band is the band of T01.border-off.173, one hop later
    const inside = cell("T10.border-off.47").prediction;
    const direct = cell("T01.border-off.173", T01_HIKARI).prediction;
    if (inside.detects !== true || direct.detects !== true) throw new Error("detecting cells");
    expect([inside.timer, inside.errno, valueIn(inside.low, "s")]).toEqual(["statement_timeout", "57014", 10]);
    expect(valueIn(inside.high, "s")).toBeCloseTo(valueIn(direct.high, "s") + PGBOUNCER_LATENCY, 9);
    // the read timeout of the client is the same on each tier
    expect(cell("T10.border-off.48").prediction).toEqual(cell("T01.border-off.174", T01_HIKARI).prediction);
  });

  it("places the borders of O01 for node-postgres: the idle timer of the pool against client_idle_timeout of PgBouncer", () => {
    const pg = (plan: string) => {
      const found = [...T10_PG, ...T01_PG].find((each) => each.name.startsWith(`${plan} pg-8.23 to postgresql, `));
      if (found === undefined) throw new Error(`no cell ${plan}`);
      return found;
    };
    // inside: the idle timer of the pool at 10 s comes first, as on the direct pair, before PgBouncer at 12 s.
    // The Terminate of the pool makes PgBouncer close the client, and its FIN comes before the pool ends
    // its socket: the end is the end of the file, up to one step of PgBouncer later
    const inside = pg("T10.border-off.91").prediction;
    const direct = pg("T01.defaults.128").prediction;
    if (inside.detects !== true || direct.detects !== true) throw new Error("detecting cells");
    expect([inside.timer, inside.errno, inside.from, inside.low]).toEqual(["idle_timeout", "EOF", "last-received", direct.low]);
    expect(direct.errno).toBe("CLOSED");
    expect(valueIn(inside.high, "s")).toBeCloseTo(valueIn(direct.high, "s") + PGBOUNCER_LATENCY, 9);
    // outside: a pass of the janitor finds the client idle for longer than 12 s, and PgBouncer closes it
    const closed = pg("T10.border-off.92").prediction;
    if (closed.detects !== true) throw new Error("a detecting cell");
    expect([closed.timer, closed.errno, closed.from]).toEqual(["client_idle_timeout", "EOF", "last-received"]);
    expect(valueIn(closed.low, "s")).toBeCloseTo(POOLER_IDLE - PGBOUNCER_LATENCY, 9);
    expect(valueIn(closed.high, "s")).toBeCloseTo(POOLER_IDLE + 0.333333 + 0.01 + 0.002, 6);
    expect(pg("T10.border-off.92").driverOptions).toEqual({ idleTimeoutMillis: 14000 });
    expect(pgbouncerFirst("idle", { client_idle_timeout: POOLER_IDLE })).toMatchObject({ timer: "client_idle_timeout", errno: "08P01" });
  });
});
