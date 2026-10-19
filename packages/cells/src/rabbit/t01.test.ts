import { describe, expect, it } from "vitest";
import { AMQPLIB, RABBITMQ_CONNECTION } from "@mark1russell7/machines";
import { RUNS } from "../catalog.ts";
import { T01_PG } from "../pg/t01.ts";
import { RABBIT_LATENCY, RABBIT_TARGET, T01_AMQP, T01_AMQP_SPECS, T01_AMQP_WAITING } from "./t01.ts";

const cell = (plan: string) => {
  const found = T01_AMQP.find((each) => each.name.startsWith(`${plan} amqplib-2.2 to rabbitmq-4.3, `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};

/** These are the cells of R3's plan over amqplib-2.2 and rabbitmq-4.3 in T01, at the defaults (plan.json). */
const PLAN = [10, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145] as const;

describe("the RabbitMQ catalog of T01", () => {
  it("gives each cell of the plan at the defaults a cell or a reason to wait, once", () => {
    const named = [...T01_AMQP_SPECS.map((spec) => spec.plan), ...T01_AMQP_WAITING.map((each) => each.plan)];
    expect(named.sort()).toEqual(PLAN.map((n) => `T01.defaults.${n}`).sort());
    for (const each of T01_AMQP) {
      expect(each.target, each.name).toBe(RABBIT_TARGET);
      expect(each.probe.driver, each.name).toEqual({ name: "amqp" });
      expect(each.runs, each.name).toBe(RUNS);
    }
    expect(RABBIT_TARGET.image).toMatch(/^rabbitmq:4\.3\.6@sha256:[0-9a-f]{64}$/);
  });

  it("ends a silent fault at the heartbeat of amqplib, 2 to 3 heartbeats after the last bytes of the broker", () => {
    // 60 s from the broker: the second receive check with nothing comes 120 s to 180 s after the last bytes
    expect(AMQPLIB.knobs["heartbeat"]?.default).toBe(60);
    for (const plan of ["T01.defaults.134", "T01.defaults.138"]) {
      expect(cell(plan).prediction, plan).toMatchObject({
        detects: true,
        timer: "heartbeat",
        errno: "CLOSED",
        from: "last-received",
        low: { value: 120, unit: "s" },
        high: { value: 180.01, unit: "s" },
      });
    }
  });

  it("resets the connection at once for a reset and for a killed broker, whose sockets have linger 0", () => {
    expect(cell("T01.defaults.135").prediction).toMatchObject({ detects: true, errno: "ECONNRESET", from: "request-sent" });
    const killed = cell("T01.defaults.136");
    expect(killed.prediction).toMatchObject({ detects: true, errno: "ECONNRESET", from: "peer-closed" });
    // each run of a fin has its own broker
    expect(killed.environments).toBe(RUNS);
    // the document of the broker: each close is a reset
    expect(RABBITMQ_CONNECTION.transitions.filter((each) => each.to === "ended" && [each.on].flat().some((on) => on.startsWith("timer."))).every((each) => (each.emits ?? []).includes("tx.rst"))).toBe(true);
    expect(cell("T01.defaults.142").prediction).toMatchObject({ detects: true, errno: "ECONNREFUSED", from: "client-start" });
  });

  it("gives up in the kernel on an unreachable host, and recovers a stall as Linux TCP does", () => {
    expect(cell("T01.defaults.137").prediction).toMatchObject({ detects: true, timer: "retrans_giveup", errno: "EHOSTUNREACH", from: "first-retransmission" });
    const stall = cell("T01.defaults.139").prediction;
    // the first segment back can be the reply of the broker: one step of the BEAM later than the stall of pg
    const pg = T01_PG.find((each) => each.name.startsWith("T01.defaults.127 "))?.prediction;
    if (stall.detects !== false || stall.recovers === undefined || pg?.detects !== false || pg.recovers === undefined) throw new Error("two stalls");
    expect(stall.recovers.low).toEqual(pg.recovers.low);
    expect(stall.recovers.high.value).toBeCloseTo(pg.recovers.high.value + RABBIT_LATENCY, 9);
  });

  it("keeps an idle connection with no fault: the broker sends a heartbeat frame each 30 s", () => {
    expect(cell("T01.defaults.140").prediction).toMatchObject({ detects: false, window: { value: 300, unit: "s" } });
    // amqplib sets no TCP_NODELAY at the defaults: Nagle is on
    expect(AMQPLIB.knobs["noDelay"]?.default).toBe(0);
  });
});
