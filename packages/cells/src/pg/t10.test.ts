import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { T01_HIKARI } from "./hikari.ts";
import { APP_STALL, PG_TARGET } from "./t01.ts";
import { PGBOUNCER_HOP, PGBOUNCER_LATENCY, T10_HIKARI, T10_HIKARI_ALIASES, T10_HIKARI_SPECS, T10_HIKARI_WAITING, T10_PG_WAITING, pgbouncerEarliest } from "./t10.ts";

const cell = (plan: string, cells = T10_HIKARI) => {
  const found = cells.find((each) => each.name.startsWith(`${plan} hikaricp-pgjdbc to postgresql, `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the cells of R3's plan in T10 at the defaults, by their client (plan.json). */
const PLAN = {
  hikari: [1, 2, 3, 11, 12, 13, 14, 15, 16, 17, 18, 45],
  pg: [7, 8, 9, 27, 28, 29, 30, 31, 32, 33, 34],
} as const;

describe("the HikariCP catalog of T10, through PgBouncer", () => {
  it("gives each cell of the plan at the defaults a cell, an alias or a reason to wait, once", () => {
    const named = [...T10_HIKARI_SPECS.map((spec) => spec.plan), ...T10_HIKARI_ALIASES.map((each) => each.plan), ...T10_HIKARI_WAITING.map((each) => each.plan)];
    expect(named.sort()).toEqual(PLAN.hikari.map((n) => `T10.defaults.${n}`).sort());
    expect(T10_PG_WAITING.map((each) => each.plan).sort()).toEqual(PLAN.pg.map((n) => `T10.defaults.${n}`).sort());
    for (const alias of T10_HIKARI_ALIASES) expect(() => cell(alias.is), alias.plan).not.toThrow();
    for (const each of [...T10_HIKARI_WAITING, ...T10_PG_WAITING]) expect(each.why.length, each.plan).toBeGreaterThan(20);
  });

  it("puts PgBouncer in transaction pooling between the client and the server", () => {
    for (const each of T10_HIKARI) {
      expect(each.target, each.name).toBe(PG_TARGET);
      expect(each.topology, each.name).toEqual({ name: "T10", hops: [PGBOUNCER_HOP] });
    }
    expect(PGBOUNCER_HOP.image).toEqual({ kind: "shipped", name: "pgbouncer" });
    const ini = PGBOUNCER_HOP.files?.["/etc/pgbouncer/pgbouncer.ini"] ?? "";
    expect(ini).toContain("pool_mode = transaction");
    expect(ini).toContain("host={{next.host}} port={{next.port}}");
    // pgjdbc sends extra_float_digits at its startup
    expect(ini).toContain("ignore_startup_parameters = extra_float_digits");
  });

  it("finds no timer of PgBouncer at the defaults that ends a query before query_wait_timeout", () => {
    expect(pgbouncerEarliest()).toBe(120);
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
});
