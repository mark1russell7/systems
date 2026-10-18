import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { predict } from "../catalog.ts";
import { SLOW_QUERY, STATEMENT_DEADLINE } from "./server.ts";
import { APP_STALL, PG_TARGET, POOL_IDLE, SLOWEST_POLL, STARTUP_BUDGET, T01_PG, T01_PG_SPECS, T01_PG_WAITING, firstOn, pgValues } from "./t01.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import { given } from "../catalog.ts";
import { linuxValues } from "../mongo/model.ts";

const cell = (plan: string) => {
  const found = T01_PG.find((each) => each.name.startsWith(`${plan} pg-8.23 to postgresql, `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};
const seconds = (q: { value: number; unit: string }) => valueIn(q, "s");

/** These are the cells of R3's plan over pg-8.23 and postgresql in T01, by stage (plan.json). */
const PLAN = {
  defaults: [9, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133],
  border: [157, 158, 159, 160, 171, 172, 179, 180, 191, 192],
} as const;

describe("the PostgreSQL catalog of T01", () => {
  it("names each cell by its cell of the plan, once, on the server of PostgreSQL 17.11", () => {
    expect(T01_PG.map((each) => each.name.split(" ")[0])).toEqual(T01_PG_SPECS.map((spec) => spec.plan));
    for (const each of T01_PG) expect(each.name).toMatch(/^T01\.(defaults|border-off)\.\d+ pg-8\.23 to postgresql, /);
    expect(new Set(T01_PG.map((each) => each.name)).size).toBe(T01_PG.length);
    expect(PG_TARGET.image).toMatch(/^postgres:17\.11@sha256:[0-9a-f]{64}$/);
    expect(T01_PG.every((each) => each.probe.driver?.name === "pg" && each.target.image === PG_TARGET.image)).toBe(true);
    // only a cell with a setting of the server has its own command
    expect(T01_PG.filter((each) => each.target !== PG_TARGET).map((each) => each.name.split(" ")[0])).toEqual(["T01.border-off.171", "T01.border-off.172"]);
  });

  it("gives each cell of the plan over these systems a cell or a reason to wait, once", () => {
    const planned = T01_PG_SPECS.map((spec) => spec.plan);
    const ids = [...PLAN.defaults.map((n) => `T01.defaults.${n}`), ...PLAN.border.map((n) => `T01.border-off.${n}`)];
    for (const id of ids) {
      const count = planned.filter((plan) => plan === id).length + T01_PG_WAITING.filter((each) => each.plan === id).length;
      expect(count, id).toBe(1);
    }
    expect([...planned, ...T01_PG_WAITING.map((each) => each.plan)].sort()).toEqual([...ids].sort());
  });

  it("composes the pool over Linux TCP: an idle client has the idle timer of the pool, and no keepalive", () => {
    const driver = given(pgValues());
    const linux = given(linuxValues());
    const idle = firstOn("pooled", MANIFESTATIONS.blackhole, driver, linux);
    expect(idle).toMatchObject({ kind: "timer", timer: "idle_timeout", layer: "driver" });
    // at the defaults no timer of pg or of the kernel ends a query in a black hole before the give-up of the kernel
    const query = firstOn("querying", MANIFESTATIONS.blackhole, driver, linux);
    expect(query).toMatchObject({ kind: "timer", timer: "retrans_giveup", layer: "kernel", name: "ETIMEDOUT" });
    expect(query.kind === "timer" && query.band.lo).toBeCloseTo(924.6, 1);
    expect(firstOn("querying", MANIFESTATIONS["freeze-process"], driver, linux).kind).toBe("silent");
    // at the defaults the connect has no timer of pg: the kernel gives up on its SYNs at 131 s
    const connect = firstOn("connecting", MANIFESTATIONS.blackhole, driver, linux);
    expect(connect).toMatchObject({ kind: "timer", timer: "syn_giveup", layer: "kernel", name: "ETIMEDOUT" });
    expect(connect.kind === "timer" && connect.band.lo).toBeCloseTo(131, 0);
  });

  it("gives the close of the pool to an idle cell, at the idle timer of 10 s, from the last segment", () => {
    for (const plan of ["T01.defaults.122", "T01.defaults.128"]) {
      const p = cell(plan).prediction;
      expect(p.detects, plan).toBe(true);
      if (p.detects !== true) return;
      expect([p.timer, p.errno, p.from], plan).toEqual(["idle_timeout", "CLOSED", "last-received"]);
      expect([seconds(p.low), seconds(p.high)], plan).toEqual([POOL_IDLE.lo, POOL_IDLE.hi]);
      // the kernel stamps the close of the pool: no driver band, thus no line of the client ends it
      expect(p.driver, plan).toBeUndefined();
    }
    expect(POOL_IDLE.lo).toBe(10);
    expect(cell("T01.defaults.128").fault).toBe("none");
  });

  it("gives a reset and a FIN at once, and an unreachable host at the give-up of the kernel", () => {
    const rst = cell("T01.defaults.123").prediction;
    expect(rst).toMatchObject({ detects: true, errno: "ECONNRESET", from: "request-sent" });
    const fin = cell("T01.defaults.124");
    expect(fin.prediction).toMatchObject({ detects: true, errno: "EOF", from: "peer-closed" });
    expect(fin.environments).toBe(fin.runs);
    const unreachable = cell("T01.defaults.125");
    expect(unreachable.prediction).toMatchObject({ detects: true, timer: "retrans_giveup", errno: "EHOSTUNREACH", from: "first-retransmission" });
    expect(unreachable.targetSysctls).toEqual({ "net.ipv4.icmp_ratelimit": "0" });
    // the same band as the TCP client of the harness on the direct pair
    const tcp = predict({ name: "client in flight, unreachable-host, tcp_retries2 = 3", fault: "unreachable", manifestation: "unreachable-host", observer: "client", mode: "inflight", icmp: "host", linux: { tcp_retries2: { value: 3, unit: "count" } } });
    if (unreachable.prediction.detects !== true || tcp.detects !== true) throw new Error("no band");
    expect([unreachable.prediction.low, unreachable.prediction.high]).toEqual([tcp.low, tcp.high]);
  });

  it("refuses a connect at once when the server resets its SYN", () => {
    const refused = cell("T01.defaults.9");
    expect(refused.before).toBe(true);
    expect(refused.prediction).toMatchObject({ detects: true, errno: "ECONNREFUSED", from: "client-start", driver: { ends: { ev: "fail", where: { n: 1 }, name: "code" } } });
    if (refused.prediction.detects !== true) return;
    expect(seconds(refused.prediction.high)).toBeLessThan(0.03);
  });

  it("holds a frozen server with no detector in 60 s, and recovers a stall as Linux TCP does", () => {
    expect(cell("T01.defaults.126").prediction).toMatchObject({ detects: false, window: { value: 60, unit: "s" } });
    const stall = cell("T01.defaults.127").prediction;
    expect(stall.detects).toBe(false);
    expect(stall.detects === false && stall.recovers !== undefined).toBe(true);
  });

  it("holds the query of an app-stall with no detector, and times its reply at the hold of the server", () => {
    const stall = cell("T01.defaults.130");
    expect(stall.probe.driver).toEqual({ name: "pg", query: `SELECT pg_sleep(${APP_STALL})` });
    const p = stall.prediction;
    expect(p.detects).toBe(false);
    if (p.detects !== false) return;
    expect(seconds(p.replies!.low)).toBe(APP_STALL);
    expect(seconds(p.replies!.high)).toBeLessThan(APP_STALL + 0.05);
    expect(p.driver?.reply).toEqual({ from: "request-sent", ends: { ev: "ack", where: { n: 2 } } });
  });

  it("puts the query timer of the pool on each side of the slowest poll (O13)", () => {
    const [inside, outside] = ["T01.border-off.179", "T01.border-off.180"].map((plan) => cell(plan));
    for (const each of [inside!, outside!]) {
      expect(each.prediction, each.name).toMatchObject({
        detects: true,
        timer: "query_timeout",
        errno: "Query read timeout",
        from: "request-sent",
        driver: { ends: { ev: "fail", where: { n: 2 }, name: "message" } },
      });
    }
    if (inside!.prediction.detects !== true || outside!.prediction.detects !== true) return;
    expect(seconds(inside!.prediction.high)).toBeLessThan(SLOWEST_POLL);
    expect(seconds(outside!.prediction.low)).toBeGreaterThan(SLOWEST_POLL);
    expect(inside!.driverOptions).toEqual({ query_timeout: 9500 });
  });

  it("puts the query timer of the pool on each side of the statement deadline of the server (O07), with a slow query only in flight", () => {
    const [inside, outside] = ["T01.border-off.171", "T01.border-off.172"].map((plan) => cell(plan));
    for (const each of [inside!, outside!]) {
      expect(each.probe.driver, each.name).toEqual({ name: "pg", inflight: SLOW_QUERY });
      expect(each.target.command?.join(" "), each.name).toContain(`docker-entrypoint.sh postgres -c statement_timeout=${STATEMENT_DEADLINE * 1000} &`);
    }
    // inside, the statement timer of the server ends the query first, with its ERROR 57014
    expect(inside!.prediction).toMatchObject({ detects: true, timer: "statement_timeout", errno: "57014", from: "request-sent", driver: { ends: { ev: "fail", where: { n: 2 }, name: "code" } } });
    // outside, the pool gives up first, and the server goes on with the statement
    expect(outside!.prediction).toMatchObject({ detects: true, timer: "query_timeout", errno: "Query read timeout", from: "request-sent", driver: { ends: { ev: "fail", where: { n: 2 }, name: "message" } } });
    if (inside!.prediction.detects !== true || outside!.prediction.detects !== true) return;
    expect(seconds(inside!.prediction.low)).toBe(STATEMENT_DEADLINE);
    expect(seconds(inside!.prediction.high)).toBeLessThan(10.5);
    expect(seconds(outside!.prediction.high)).toBeLessThan(STATEMENT_DEADLINE);
    expect(inside!.driverOptions).toEqual({ query_timeout: 10500 });
  });

  it("puts the connect timer of the pool on each side of the startup budget (O15), before the kernel gives up", () => {
    const [inside, outside] = ["T01.border-off.191", "T01.border-off.192"].map((plan) => cell(plan));
    for (const each of [inside!, outside!]) {
      expect(each.before, each.name).toBe(true);
      expect(each.prediction, each.name).toMatchObject({
        detects: true,
        timer: "connect_timeout",
        errno: "Connection terminated due to connection timeout",
        from: "client-start",
        driver: { ends: { ev: "fail", where: { n: 1 }, name: "message" } },
      });
    }
    if (inside!.prediction.detects !== true || outside!.prediction.detects !== true) return;
    expect(seconds(inside!.prediction.high)).toBeLessThan(STARTUP_BUDGET);
    expect(seconds(outside!.prediction.low)).toBeGreaterThan(STARTUP_BUDGET);
    expect(outside!.driverOptions).toEqual({ connectionTimeoutMillis: 31000 });
  });

  it("gives each waiting cell its reason", () => {
    for (const each of T01_PG_WAITING) expect(each.why.length, each.plan).toBeGreaterThan(20);
    expect(T01_PG_WAITING.find((each) => each.plan === "T01.defaults.133")!.why).toMatch(/TCP_NODELAY/);
  });

  it("refuses an option that is not a knob of node-postgres", () => {
    expect(() => pgValues(1, { idle_timeout: 5 })).toThrow(/no knob/);
  });
});
