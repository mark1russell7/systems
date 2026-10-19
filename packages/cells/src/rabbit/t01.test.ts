import { describe, expect, it } from "vitest";
import { AMQPLIB, RABBITMQ_CONNECTION } from "@mark1russell7/machines";
import { RUNS } from "../catalog.ts";
import { T01_PG } from "../pg/t01.ts";
import {
  O17_RETRIES,
  RABBIT_LATENCY,
  RABBIT_ROUTER,
  RABBIT_TARGET,
  T01_AMQP,
  T01_AMQP_ARRAY_ALIASES,
  T01_AMQP_ARRAY_WAITING,
  T01_AMQP_BORDER_SPECS,
  T01_AMQP_SPECS,
  T01_AMQP_WAITING,
} from "./t01.ts";

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

  it("gives each cell of the array stage the cell at the defaults with its number, as an alias or as a cell that waits", () => {
    const named = [...T01_AMQP_ARRAY_ALIASES.map((each) => each.plan), ...T01_AMQP_ARRAY_WAITING.map((each) => each.plan)];
    expect(named.sort()).toEqual(PLAN.map((n) => `T01.array.${n}`).sort());
    for (const alias of T01_AMQP_ARRAY_ALIASES) {
      expect(alias.is, alias.plan).toBe(alias.plan.replace(".array.", ".defaults."));
      expect(() => cell(alias.is), alias.plan).not.toThrow();
    }
    // an array cell waits only when its cell at the defaults waits, with the same trigger
    for (const each of T01_AMQP_ARRAY_WAITING) {
      const defaults = T01_AMQP_WAITING.find((wait) => wait.plan === each.plan.replace(".array.", ".defaults."));
      expect(defaults?.trigger, each.plan).toBe(each.trigger);
      expect(each.why, each.plan).toContain(defaults!.why);
    }
  });

  it("ends a silent fault at the heartbeat of amqplib, 2 to 3 heartbeats after the last bytes of the broker", () => {
    // 60 s from the broker: the second receive check with nothing comes 120 s to 180 s after the last bytes
    expect(AMQPLIB.knobs["heartbeat"]?.default).toBe(60);
    for (const plan of ["T01.defaults.134", "T01.defaults.138"]) {
      expect(cell(plan).prediction, plan).toMatchObject({
        detects: true,
        timer: "heartbeat",
        errno: "CLOSED",
        from: "last-data",
        low: { value: 120, unit: "s" },
        high: { value: 180.03, unit: "s" },
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
    expect(stall.recovers.high.value).toBeGreaterThan(pg.recovers.high.value + RABBIT_LATENCY);
    // the RTO counts from the smoothed round trip, and each sample of amqplib holds the reply time of the broker.
    // The 3rd firing comes 8 RTOs after the send, and each RTO can be RABBIT_LATENCY over TCP_RTO_MIN (200 ms).
    // In run 39202821328 an RTO of 209 ms gave the reply at 1.716 s
    expect(stall.recovers.high.value).toBeGreaterThan(8 * (0.2 + RABBIT_LATENCY) + RABBIT_LATENCY);
  });

  it("keeps an idle connection with no fault: the broker sends a heartbeat frame each 30 s", () => {
    expect(cell("T01.defaults.140").prediction).toMatchObject({ detects: false, window: { value: 300, unit: "s" } });
    // amqplib sets no TCP_NODELAY at the defaults: Nagle is on
    expect(AMQPLIB.knobs["noDelay"]?.default).toBe(0);
  });

  it("places O03 and O17 each with a setting inside and one outside", () => {
    expect(T01_AMQP_BORDER_SPECS.map((spec) => spec.plan)).toEqual(["T01.border-off.161", "T01.border-off.162", "T01.border-off.205", "T01.border-off.206"]);
    // O03: the broker sends a frame each heartbeat / 2. At 40 s, each 20 s keeps the flow through the router at 30 s
    const inside = cell("T01.border-off.161");
    expect(inside.prediction).toMatchObject({ detects: false, window: { value: 150, unit: "s" } });
    expect(inside.topology?.hops[0]).toMatchObject({ kind: "router", form: "silent-drop", idle: { value: RABBIT_ROUTER.idle, unit: "s" } });
    // at 80 s, each 40 s: the router forgets the flow, and the heartbeat of amqplib ends it 160 s to 240 s after the last data
    expect(cell("T01.border-off.162").prediction).toMatchObject({ detects: true, timer: "heartbeat", from: "last-data", low: { value: 160, unit: "s" }, high: { value: 240.03, unit: "s" } });
    // O17: the heartbeat against the give-up of the kernel, with tcp_retries2 = 7
    const early = cell("T01.border-off.205").prediction;
    const late = cell("T01.border-off.206").prediction;
    if (early.detects !== true || late.detects !== true) throw new Error("detecting cells");
    expect([early.timer, late.timer, late.errno]).toEqual(["heartbeat", "retrans_giveup", "ETIMEDOUT"]);
    expect(cell("T01.border-off.206").sysctls).toMatchObject({ "net.ipv4.tcp_retries2": String(O17_RETRIES) });
    // the reply to operation 1 is the last data, 0.3 s before the RPC, and the first retransmission comes after it:
    // the heartbeat of 15 s ends before the kernel can, and the one of 60 s after the kernel must
    expect(early.high.value).toBeLessThan(late.low.value);
    expect(2 * 60 - 0.3).toBeGreaterThan(late.high.value + 0.21);
  });
});
