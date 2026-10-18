import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { T01_HIKARI } from "./hikari.ts";
import { SUPAVISOR_IMAGE, SUPAVISOR_READY, SUPAVISOR_TOKEN, supavisorStart } from "./supavisor.ts";
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
  PGPOOL_HOP,
  PGPOOL_LATENCY,
  POOLER_IDLE,
  SUPAVISOR_LATENCY,
  pgbouncerEarliest,
  pgbouncerFirst,
  pgbouncerHop,
  pgpoolHop,
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

  it("puts PgBouncer in transaction pooling, Pgpool-II or Supavisor between the client and the server, with the settings of each cell", () => {
    for (const each of [...T10_HIKARI, ...T10_PG]) {
      expect(each.target.image, each.name).toBe(PG_TARGET.image);
      expect(each.topology?.name, each.name).toBe("T10");
      const [hop] = each.topology?.hops ?? [];
      const pooler = each.name.includes("behind Pgpool-II") ? "pgpool" : each.name.includes("behind Supavisor") ? "supavisor" : "pgbouncer";
      expect(hop?.name, each.name).toBe(pooler);
      // Supavisor is the image of Supabase, pinned by the digest of its index; the harness ships the two others
      expect(hop !== undefined && "image" in hop ? hop.image : null, each.name).toEqual(pooler === "supavisor" ? SUPAVISOR_IMAGE : { kind: "shipped", name: pooler });
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

  it("places the read timeout on each side of the give-up of the kernel of PgBouncer, on its server socket", () => {
    const [inside, outside] = [cell("T10.border-off.43"), cell("T10.border-off.44")];
    for (const each of [inside, outside]) {
      expect(each.observer, each.name).toEqual({ hop: "pgbouncer", toward: "target" });
      // each run has a fresh environment: the judge finds the server socket that PgBouncer opens in the run
      expect(each.environments, each.name).toBe(each.runs);
      const [hop] = each.topology?.hops ?? [];
      expect(hop !== undefined && "sysctls" in hop ? hop.sysctls?.["net.ipv4.tcp_retries2"] : null, each.name).toBe("4");
    }
    // inside: the read timeout of 5 s closes the client, and PgBouncer closes the server that was not ready
    expect(inside.prediction).toMatchObject({ detects: true, timer: "socket_timeout", errno: "CLOSED", from: "request-sent", low: { value: 5, unit: "s" } });
    // outside: at tcp_retries2 = 4 the kernel of PgBouncer gives up 6.2 s after its first retransmission, before 15 s
    expect(outside.prediction).toMatchObject({ detects: true, timer: "retrans_giveup", errno: "ETIMEDOUT", from: "first-retransmission", low: { value: 6.2, unit: "s" } });
    // the other cells observe the client
    expect(cell("T10.border-off.45").observer).toBeUndefined();
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

  it("puts Pgpool-II with one backend at its defaults between the client and the server", () => {
    const conf = PGPOOL_HOP.files?.["/etc/pgpool/pgpool.conf"] ?? "";
    expect(conf).toContain("backend_hostname0 = '{{next.host}}'");
    expect(conf).toContain("backend_port0 = {{next.port}}");
    // the check of streaming replication finds the primary with this user, and no other setting moves a timer
    expect(conf).toContain("sr_check_user = 'postgres'");
    expect(PGPOOL_HOP.ready).toBe("pgpool-II successfully started");
    expect(() => pgpoolHop({ probe: 10 })).toThrow(/no setting with a unit for probe/);
    expect(pgpoolHop({ client_idle_limit: 12 }).files?.["/etc/pgpool/pgpool.conf"]).toMatch(/client_idle_limit = 12\n$/);
  });

  it("times each cell through Pgpool-II as on the direct pair: Pgpool-II adds no timer, and one step to a reply", () => {
    // a frozen server: Pgpool-II waits on it with no bound, and its probe of each 30 s ends nothing
    expect(cell("T10.defaults.2").prediction).toEqual(cell("T01.defaults.55", T01_HIKARI).prediction);
    // the keepalive sends its empty query through Pgpool-II, which forwards it: the read timeout of the check
    expect(cell("T10.defaults.11").prediction).toEqual(cell("T01.defaults.52", T01_HIKARI).prediction);
    // behind the black hole Pgpool-II can detach its only server: each run has its own environment, with a dry warm-up
    expect([cell("T10.defaults.11").fresh, cell("T10.defaults.11").environments]).toEqual([true, cell("T10.defaults.11").runs]);
    expect(cell("T10.defaults.2").fresh).toBeUndefined();
    // O07: the error of the server crosses one more hop, and the read timeout of the client is the same
    const inside = cell("T10.border-off.97").prediction;
    const direct = cell("T01.border-off.173", T01_HIKARI).prediction;
    if (inside.detects !== true || direct.detects !== true) throw new Error("detecting cells");
    expect(valueIn(inside.high, "s")).toBeCloseTo(valueIn(direct.high, "s") + PGPOOL_LATENCY, 9);
    expect(cell("T10.border-off.98").prediction).toEqual(cell("T01.border-off.174", T01_HIKARI).prediction);
    expect(PGPOOL_LATENCY).toBeCloseTo(0.012, 9);
  });

  it("ends an idle client of node-postgres through Pgpool-II at the FIN of the server, one step of Pgpool-II later", () => {
    const pg = (plan: string) => {
      const found = [...T10_PG, ...T01_PG].find((each) => each.name.startsWith(`${plan} pg-8.23 to postgresql, `));
      if (found === undefined) throw new Error(`no cell ${plan}`);
      return found;
    };
    const through = pg("T10.defaults.29");
    const direct = pg("T01.defaults.124").prediction;
    if (through.prediction.detects !== true || direct.detects !== true) throw new Error("detecting cells");
    expect([through.prediction.errno, through.prediction.from, through.prediction.low]).toEqual(["EOF", "peer-closed", direct.low]);
    expect(valueIn(through.prediction.high, "s")).toBeCloseTo(valueIn(direct.high, "s") + PGPOOL_LATENCY, 9);
    // a killed server cannot serve the next run: each run of a fin has its own environment
    expect(through.environments).toBe(through.runs);
  });

  it("starts Supavisor with one tenant in transaction mode, and connects each client as the user of the tenant", () => {
    const script = supavisorStart();
    // the migrations need the schema _supavisor, and the tenant comes through the API, signed by the token of the lab
    expect(script).toContain("create schema if not exists _supavisor");
    expect(script).toContain("/app/bin/migrate");
    expect(script).toContain(`Bearer ${SUPAVISOR_TOKEN}`);
    expect(script).toContain('"mode_type":"transaction"');
    expect(script).toContain('"db_port":{{next.port}}');
    expect(script).toContain(`echo '${SUPAVISOR_READY}'`);
    const claims = JSON.parse(Buffer.from(SUPAVISOR_TOKEN.split(".")[1]!, "base64url").toString());
    expect(claims).toEqual({ role: "service_role", exp: 4102444800 });
    expect(SUPAVISOR_IMAGE).toMatch(/^supabase\/supavisor:2\.9\.13@sha256:[0-9a-f]{64}$/);
    const hikari = T10_HIKARI.find((each) => each.name.startsWith("T10.defaults.3 "));
    expect(hikari?.driverOptions).toMatchObject({ username: "postgres.harness", password: "postgres" });
    const pg = T10_PG.find((each) => each.name.startsWith("T10.defaults.31 "));
    expect(pg?.driverOptions).toMatchObject({ user: "postgres.harness", password: "postgres" });
  });

  it("times the cells of node-postgres through Supavisor as a frozen server, and an idle client by the pool", () => {
    const pg = (plan: string) => {
      const found = [...T10_PG, ...T01_PG].find((each) => each.name.startsWith(`${plan} pg-8.23 to postgresql, `));
      if (found === undefined) throw new Error(`no cell ${plan}`);
      return found.prediction;
    };
    // a query in flight into a black hole of the server: Supavisor acknowledges it, as a frozen server's kernel does
    expect(pg("T10.defaults.30")).toEqual(pg("T01.defaults.126"));
    expect(pg("T10.defaults.28")).toEqual(pg("T01.defaults.126"));
    // the idle timer of the pool ends an idle client, and Supavisor closes it at its Terminate: an end of file
    const idle = pg("T10.defaults.27");
    const direct = pg("T01.defaults.128");
    if (idle.detects !== true || direct.detects !== true) throw new Error("detecting cells");
    expect([idle.timer, idle.errno, idle.from, idle.low]).toEqual(["idle_timeout", "EOF", "last-received", direct.low]);
    expect(valueIn(idle.high, "s")).toBeCloseTo(valueIn(direct.high, "s") + SUPAVISOR_LATENCY, 9);
    // the reply of a held query comes one step of Supavisor later
    const held = pg("T10.defaults.31");
    const heldDirect = pg("T01.defaults.130");
    if (held.detects !== false || heldDirect.detects !== false || held.replies === undefined || heldDirect.replies === undefined) throw new Error("replying cells");
    expect(valueIn(held.replies.high, "s")).toBeCloseTo(valueIn(heldDirect.replies.high, "s") + SUPAVISOR_LATENCY, 9);
  });

  it("ends the check of HikariCP through Supavisor after the server stopped at the failed connect of the pool: FATAL 08006, then the FIN", () => {
    const fin = T10_HIKARI.find((each) => each.name.startsWith("T10.defaults.3 "));
    expect(fin?.prediction).toMatchObject({ detects: true, errno: "EOF", from: "first-sent", low: { value: 0, unit: "s" } });
    // the rest of the cooldown of 2.5 s and one connect of 5 s, each up to 10 ms late, and one step of Supavisor
    if (fin?.prediction.detects !== true) throw new Error("a detecting cell");
    expect(valueIn(fin.prediction.high, "s")).toBeCloseTo(7.52 + SUPAVISOR_LATENCY, 9);
    expect(fin.environments).toBe(fin.runs);
  });
});
