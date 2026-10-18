import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { given, predict } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import { linuxValues } from "../mongo/model.ts";
import { T01_HIKARI, T01_HIKARI_SPECS, T01_HIKARI_WAITING, hikariFirstOn, hikariValues } from "./hikari.ts";
import { PG_TARGET } from "./t01.ts";

const cell = (plan: string) => {
  const found = T01_HIKARI.find((each) => each.name.startsWith(`${plan} hikaricp-pgjdbc to postgresql, `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the cells of R3's plan over hikaricp-pgjdbc and postgresql in T01, by stage (plan.json). */
const PLAN = {
  defaults: [2, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63],
  border: [151, 152, 173, 174, 187, 188, 197, 198, 237, 238],
} as const;

describe("the HikariCP catalog of T01", () => {
  it("names each cell by its cell of the plan, once, with the client hikari against PostgreSQL 17.11", () => {
    expect(T01_HIKARI.map((each) => each.name.split(" ")[0])).toEqual(T01_HIKARI_SPECS.map((spec) => spec.plan));
    for (const each of T01_HIKARI) expect(each.name).toMatch(/^T01\.(defaults|border-off)\.\d+ hikaricp-pgjdbc to postgresql, /);
    expect(new Set(T01_HIKARI.map((each) => each.name)).size).toBe(T01_HIKARI.length);
    expect(T01_HIKARI.every((each) => each.probe.driver?.name === "hikari" && each.target === PG_TARGET)).toBe(true);
  });

  it("gives each cell of the plan over these systems a cell or a reason to wait, once", () => {
    const planned = T01_HIKARI_SPECS.map((spec) => spec.plan);
    const ids = [...PLAN.defaults.map((n) => `T01.defaults.${n}`), ...PLAN.border.map((n) => `T01.border-off.${n}`)];
    expect([...planned, ...T01_HIKARI_WAITING.map((each) => each.plan)].sort()).toEqual([...ids].sort());
    for (const each of T01_HIKARI_WAITING) expect(each.why.length, each.plan).toBeGreaterThan(20);
  });

  it("composes the pool over pgjdbc over Linux TCP: at the defaults only the kernel ends a query, and nothing ends an idle connection", () => {
    const driver = given(hikariValues());
    const linux = given(linuxValues());
    const query = hikariFirstOn("querying", MANIFESTATIONS.blackhole, driver, linux);
    expect(query).toMatchObject({ kind: "timer", timer: "retrans_giveup", layer: "kernel", name: "ETIMEDOUT" });
    expect(query.kind === "timer" && query.band.lo).toBeCloseTo(924.6, 1);
    // the idle timer has no effect in a pool of a fixed size, and the keepalive comes at a phase from the creation
    expect(hikariFirstOn("pooled", MANIFESTATIONS.blackhole, driver, linux).kind).toBe("silent");
    expect(hikariFirstOn("querying", MANIFESTATIONS["freeze-process"], driver, linux).kind).toBe("silent");
  });

  it("gives a reset of a query and the FIN of a killed server at once", () => {
    expect(cell("T01.defaults.2").prediction).toMatchObject({ detects: true, errno: "ECONNRESET", from: "request-sent" });
    const fin = cell("T01.defaults.53");
    expect(fin.prediction).toMatchObject({ detects: true, errno: "EOF", from: "peer-closed" });
    expect(fin.environments).toBe(fin.runs);
  });

  it("gives an unreachable host the band of the TCP client, and holds a freeze and an idle pool with no detector in 60 s", () => {
    const unreachable = cell("T01.defaults.54");
    const tcp = predict({ name: "client in flight, unreachable-host, tcp_retries2 = 3", fault: "unreachable", manifestation: "unreachable-host", observer: "client", mode: "inflight", icmp: "host", linux: { tcp_retries2: { value: 3, unit: "count" } } });
    if (unreachable.prediction.detects !== true || tcp.detects !== true) throw new Error("no band");
    expect(unreachable.prediction).toMatchObject({ timer: "retrans_giveup", errno: "EHOSTUNREACH", from: "first-retransmission" });
    expect([unreachable.prediction.low, unreachable.prediction.high]).toEqual([tcp.low, tcp.high]);
    for (const plan of ["T01.defaults.55", "T01.defaults.57"]) {
      const p = cell(plan).prediction;
      expect(p, plan).toMatchObject({ detects: false });
      expect(p.detects === false && valueIn(p.window, "s"), plan).toBe(60);
    }
    const stall = cell("T01.defaults.56").prediction;
    expect(stall.detects === false && stall.recovers !== undefined).toBe(true);
  });
});
