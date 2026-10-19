import { describe, expect, it } from "vitest";
import { ATEN_DETECTOR, RA_MEMBER } from "@mark1russell7/machines";
import { RUNS } from "../catalog.ts";
import {
  HOLD,
  PARTS,
  RABBIT_CLUSTER,
  T11_RABBIT,
  T11_RABBIT_ARRAY_ALIASES,
  T11_RABBIT_ARRAY_WAITING,
  T11_RABBIT_SPECS,
  T11_RABBIT_WAITING,
  firstConfirm,
  silentLeader,
  transfer,
} from "./t11.ts";

const cell = (plan: string) => {
  const found = T11_RABBIT.find((each) => each.name.startsWith(`${plan} amqplib-2.2 to rabbitmq-4.3 cluster, `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the cells of R3's plan over amqplib-2.2 and rabbitmq-4.3 in T11 (plan.json): the same numbers at the defaults and in the array stage. */
const PLAN = [7, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84] as const;

describe("the RabbitMQ catalog of T11", () => {
  it("gives each cell of the plan a cell, an alias or a reason to wait, once", () => {
    const defaults = [...T11_RABBIT_SPECS.map((spec) => spec.plan), ...T11_RABBIT_WAITING.map((each) => each.plan)];
    expect(defaults.sort()).toEqual(PLAN.map((n) => `T11.defaults.${n}`).sort());
    const array = [...T11_RABBIT_ARRAY_ALIASES.map((each) => each.plan), ...T11_RABBIT_ARRAY_WAITING.map((each) => each.plan)];
    expect(array.sort()).toEqual(PLAN.map((n) => `T11.array.${n}`).sort());
    for (const alias of T11_RABBIT_ARRAY_ALIASES) expect(() => cell(alias.is), alias.plan).not.toThrow();
    for (const each of T11_RABBIT) {
      expect(each.cluster, each.name).toBe(RABBIT_CLUSTER);
      expect(each.runs, each.name).toBe(RUNS);
      expect(each.concurrency, each.name).toBe(1);
    }
    expect(RABBIT_CLUSTER.members).toHaveLength(3);
  });

  it("finds a silent node of the leader by aten, then elects after the long timeout of Ra", () => {
    // aten: 150 ms after the last heartbeat, and up to one poll of 1 s later
    expect(ATEN_DETECTOR.knobs["poll_interval"]?.default).toBe(1000);
    expect(PARTS.detect.lo).toBeCloseTo(0.15, 9);
    expect(PARTS.detect.hi).toBeCloseTo(1.175, 9);
    // the long election timeout: the poll interval and a random part up to 10 × broadcast_time
    expect(RA_MEMBER.knobs["broadcast_time"]?.default).toBe(100);
    expect(PARTS.long.lo).toBeCloseTo(1.001, 9);
    expect(PARTS.long.hi).toBeCloseTo(2.01, 9);
    // a new leader 1.05 s after the fault at the earliest; one split vote adds a short timeout
    const leader = silentLeader();
    expect(leader.lo).toBeCloseTo(1.051, 9);
    expect(leader.hi).toBeCloseTo(1.175 + 2.01 + 0.024 + 0.61 + 0.024, 9);
    for (const plan of ["T11.defaults.74", "T11.defaults.75", "T11.defaults.76"]) {
      const p = cell(plan).prediction;
      expect(p, plan).toMatchObject({ detects: true, errno: "OK", from: "fault", group: { lands: "same", failover: true } });
      if (p.detects !== true) throw new Error("a band");
      expect(p.high.value, plan).toBeCloseTo(firstConfirm(leader).hi, 9);
      expect(p.group?.stages.map((stage) => stage.stage), plan).toEqual(["elected", "first-write"]);
      // each band ends long before the fault lifts
      expect(p.high.value, plan).toBeLessThan(HOLD / 4);
    }
  });

  it("confirms again within two commits and one wait of the client after the new leader", () => {
    const leader = silentLeader();
    expect(firstConfirm(leader).lo).toBe(leader.lo);
    expect(firstConfirm(leader).hi).toBeCloseTo(leader.hi + 0.05 + 0.06 + 0.05, 9);
  });

  it("moves the leadership in three rounds after the NOTICE of the old leader, for a step-down and for a drain", () => {
    expect(transfer()).toEqual({ lo: 0, hi: 3 * 0.012 });
    for (const plan of ["T11.defaults.7", "T11.defaults.79"]) {
      const p = cell(plan).prediction;
      if (p.detects !== true) throw new Error("a band");
      expect(p.high.value, plan).toBeCloseTo(firstConfirm(transfer()).hi, 9);
      expect(p.group?.failover, plan).toBe(true);
    }
    expect(cell("T11.defaults.79").fault).toBe("drain");
  });

  it("keeps the leader when one follower is cut from it, and lets no new leader come", () => {
    for (const plan of ["T11.defaults.77", "T11.defaults.78"]) {
      const p = cell(plan).prediction;
      expect(p, plan).toMatchObject({ detects: true, group: { failover: false, quiet: ["elected"] } });
      if (p.detects !== true) throw new Error("a band");
      expect(p.low.value, plan).toBe(0);
      expect(p.high.value, plan).toBeCloseTo(0.16, 9);
    }
    expect(cell("T11.defaults.78").faultAt).toEqual({ role: "primary", cuts: "one-way" });
  });
});
