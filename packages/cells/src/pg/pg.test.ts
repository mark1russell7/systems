import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { predict } from "../catalog.ts";
import { PG_TARGET, POOL_IDLE, T01_PG, T01_PG_SPECS, firstOn, pgValues } from "./t01.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import { given } from "../catalog.ts";
import { linuxValues } from "../mongo/model.ts";

const cell = (plan: string) => {
  const found = T01_PG.find((each) => each.name.startsWith(`${plan} pg-8.23 to postgresql, `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};
const seconds = (q: { value: number; unit: string }) => valueIn(q, "s");

describe("the PostgreSQL catalog of T01", () => {
  it("names each cell by its cell of the plan, once, on the server of PostgreSQL 17.11", () => {
    expect(T01_PG.map((each) => each.name.split(" ")[0])).toEqual(T01_PG_SPECS.map((spec) => spec.plan));
    for (const each of T01_PG) expect(each.name).toMatch(/^T01\.defaults\.\d+ pg-8\.23 to postgresql, /);
    expect(new Set(T01_PG.map((each) => each.name)).size).toBe(T01_PG.length);
    expect(PG_TARGET.image).toMatch(/^postgres:17\.11@sha256:[0-9a-f]{64}$/);
    expect(T01_PG.every((each) => each.probe.driver?.name === "pg" && each.target === PG_TARGET)).toBe(true);
  });

  it("composes the pool over Linux TCP: an idle client has the idle timer of the pool, and no keepalive", () => {
    const driver = given(pgValues());
    const linux = given(linuxValues());
    const idle = firstOn(false, MANIFESTATIONS.blackhole, driver, linux);
    expect(idle).toMatchObject({ kind: "timer", timer: "idle_timeout", layer: "driver" });
    // at the defaults no timer of pg or of the kernel ends a query in a black hole before the give-up of the kernel
    const query = firstOn(true, MANIFESTATIONS.blackhole, driver, linux);
    expect(query).toMatchObject({ kind: "timer", timer: "retrans_giveup", layer: "kernel", name: "ETIMEDOUT" });
    expect(query.kind === "timer" && query.band.lo).toBeCloseTo(924.6, 1);
    expect(firstOn(true, MANIFESTATIONS["freeze-process"], driver, linux).kind).toBe("silent");
  });

  it("gives the close of the pool to an idle cell, at the idle timer of 10 s, from the last segment", () => {
    const p = cell("T01.defaults.122").prediction;
    expect(p.detects).toBe(true);
    if (p.detects !== true) return;
    expect([p.timer, p.errno, p.from]).toEqual(["idle_timeout", "CLOSED", "last-received"]);
    expect([seconds(p.low), seconds(p.high)]).toEqual([POOL_IDLE.lo, POOL_IDLE.hi]);
    expect(POOL_IDLE.lo).toBe(10);
    expect(p.driver?.ends).toEqual({ ev: "pool", where: { event: "remove" } });
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

  it("holds a frozen server with no detector in 60 s, and recovers a stall as Linux TCP does", () => {
    expect(cell("T01.defaults.126").prediction).toMatchObject({ detects: false, window: { value: 60, unit: "s" } });
    const stall = cell("T01.defaults.127").prediction;
    expect(stall.detects).toBe(false);
    expect(stall.detects === false && stall.recovers !== undefined).toBe(true);
  });
});
