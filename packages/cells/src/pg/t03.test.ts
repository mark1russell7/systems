import { describe, expect, it } from "vitest";
import { given } from "../catalog.ts";
import { PRESETS } from "../mongo/t03.ts";
import { conntrackValues, o03 } from "../topologies.ts";
import { HIKARICP_PGJDBC } from "@mark1russell7/machines";
import { T01_HIKARI, hikariValues } from "./hikari.ts";
import { PG_RTT_MS, PG_TARGET } from "./t01.ts";
import { LONG_QUERY, T03_HIKARI, T03_HIKARI_ALIASES, T03_HIKARI_SPECS, T03_HIKARI_WAITING } from "./t03.ts";

const cell = (plan: string, cells = T03_HIKARI) => {
  const found = cells.find((each) => each.name.startsWith(`${plan} hikaricp-pgjdbc to postgresql, `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the cells of R3's plan over hikaricp-pgjdbc and postgresql in T03, at the defaults (plan.json). */
const PLAN = [6, 7, 8, 9, 10, 29, 35, 36, 42, 43, 51, 52, 58, 59, 60, 61] as const;

describe("the HikariCP catalog of T03", () => {
  it("gives each cell of the plan over these systems a cell, an alias or a reason to wait, once", () => {
    const named = [...T03_HIKARI_SPECS.map((spec) => spec.plan), ...T03_HIKARI_ALIASES.map((each) => each.plan), ...T03_HIKARI_WAITING.map((each) => each.plan)];
    expect(named.sort()).toEqual(PLAN.map((n) => `T03.defaults.${n}`).sort());
    for (const alias of T03_HIKARI_ALIASES) expect(() => cell(alias.is, T01_HIKARI), alias.plan).not.toThrow();
    for (const each of T03_HIKARI) {
      expect(each.target).toBe(PG_TARGET);
      expect(each.topology?.name, each.name).toBe("T03");
      expect(each.topology?.hops, each.name).toHaveLength(1);
    }
  });

  it("puts a fault at the router toward the client, and gives it the band of the same fault on the direct pair", () => {
    const pairs = [
      ["T03.defaults.6", "T01.defaults.52"],
      ["T03.defaults.9", "T01.defaults.54"],
      ["T03.defaults.43", "T01.defaults.53"],
      ["T03.defaults.52", "T01.defaults.56"],
    ] as const;
    for (const [t03, t01] of pairs) expect(cell(t03).prediction, t03).toEqual(cell(t01, T01_HIKARI).prediction);
    for (const plan of ["T03.defaults.6", "T03.defaults.9", "T03.defaults.52"]) expect(cell(plan).faultAt, plan).toEqual({ hop: "nat", toward: "client" });
    // the router sends the ICMP errors of the unreachable host, at no rate limit
    const unreachable = cell("T03.defaults.9");
    expect(unreachable.topology?.hops[0]).toMatchObject({ form: "silent-drop", sysctls: { "net.ipv4.icmp_ratelimit": "0" } });
    expect(unreachable.targetSysctls).toBeUndefined();
  });

  it("holds a long reply that an MTU black hole at the router stops, with no detector", () => {
    const mtu = cell("T03.defaults.8");
    expect(mtu).toMatchObject({ fault: "mtu-blackhole", mtu: 1200, faultAt: { hop: "nat", toward: "target" } });
    expect(mtu.probe.driver).toEqual({ name: "hikari", inflight: LONG_QUERY });
    expect(mtu.prediction).toMatchObject({ detects: false, window: { value: 60, unit: "s" } });
  });

  it("keeps an idle flow through each preset: the keepalive of the pool refreshes it before the router forgets it (O03)", () => {
    const values = given(hikariValues());
    for (const [plan, router, hold] of [
      ["T03.defaults.42", PRESETS.azureNat, 300],
      ["T03.defaults.51", PRESETS.aws, 400],
    ] as const) {
      expect(o03({ doc: HIKARICP_PGJDBC, values }, conntrackValues(router.idle), PG_RTT_MS / 1000).holds, plan).toBe(true);
      const each = cell(plan);
      // the window is longer than the idle timeout of the router: a forgotten flow would show in it
      expect(each.prediction, plan).toMatchObject({ detects: false, window: { value: hold, unit: "s" } });
      expect(hold).toBeGreaterThan(router.idle);
      expect(each.topology?.hops[0]).toMatchObject({ form: router.form, idle: { value: router.idle, unit: "s" } });
    }
  });
});
