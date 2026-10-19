import { describe, expect, it } from "vitest";
import rabbitmq from "./rabbitmq-2026-10-19.json";

type Cell = (typeof rabbitmq.cells)[number];

const cell = (plan: string): Cell => {
  const found = rabbitmq.cells.find((each) => each.plan === plan);
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};
/** This function gives the times of the counted runs of a cell outside its band. */
const outside = (each: Cell): number[] =>
  each.runs.flat().flatMap((t) => (t === null || each.band === null || (t >= each.band.low && t <= each.band.high) ? [] : [t])).sort((a, b) => a - b);

describe("the copy of the RabbitMQ cells holds the figures of their CI run", () => {
  it("has 12 cells on Linux 6.17 at HZ 1000, each holds, with 132 counted runs and no void run", () => {
    expect([rabbitmq.kernel, rabbitmq.hz, rabbitmq.target]).toEqual(["6.17.0", 1000, "rabbitmq:4.3.6"]);
    expect(rabbitmq.clients).toEqual({ amqplib: "amqplib 2.2.0 on Node 24.21.0" });
    expect(rabbitmq.cells).toHaveLength(12);
    expect(rabbitmq.cells.every((each) => each.decision === "holds")).toBe(true);
    expect(rabbitmq.cells.reduce((sum, each) => sum + each.counted, 0)).toBe(132);
    expect(rabbitmq.cells.reduce((sum, each) => sum + each.voided, 0)).toBe(0);
    const count = (stage: string) => rabbitmq.cells.filter((each) => each.group === "T01" && each.stage === stage).length;
    expect([count("defaults"), count("border")]).toEqual([8, 4]);
    for (const each of rabbitmq.cells) expect(outside(each), each.plan ?? each.name).toEqual([]);
  });

  it("ends a silent connection at the heartbeat of amqplib, 2 to 3 heartbeats after the last data", () => {
    for (const plan of ["T01.defaults.134", "T01.defaults.138"]) {
      const each = cell(plan);
      expect(each.band, plan).toEqual({ low: 119.999, high: 180.031 });
      expect(each.median, plan).toBeGreaterThan(120);
      expect(each.median, plan).toBeLessThan(180.031);
      expect(each.prediction.text, plan).toMatch(/^The algebra predicts that the heartbeat of amqplib ends the connection after two receive checks with no bytes of the broker, and the kernel stamps its FIN\./);
    }
  });

  it("resets at once: a reset of an RPC, a stopped broker with linger 0, and a refused connect", () => {
    expect(cell("T01.defaults.135").median).toBeLessThan(0.002);
    expect(cell("T01.defaults.136").median).toBeLessThan(0.001);
    expect(cell("T01.defaults.136").prediction.text).toMatch(/the stopped broker resets the idle connection with ECONNRESET/);
    expect(cell("T01.defaults.142").median).toBeLessThan(0.022);
  });

  it("places O03 and O17 each with a setting inside and one outside", () => {
    // O03: the heartbeat of 40 s keeps the flow through the router at 30 s, and 80 s lets the router forget it
    expect(cell("T01.border-off.161").band).toBeNull();
    expect(cell("T01.border-off.161").runs.flat().every((t) => t === null)).toBe(true);
    expect(cell("T01.border-off.162").median).toBeGreaterThan(160);
    // O17: a heartbeat of 15 s ends the connection before the kernel gives up at 51 s, and 60 s after it
    expect(cell("T01.border-off.205").median).toBeLessThan(51);
    expect(cell("T01.border-off.206").median).toBeGreaterThan(51);
    expect(cell("T01.border-off.206").prediction.text).toMatch(/the retransmissions of the kernel give up with ETIMEDOUT/);
  });

  it("gives the return after a stall at the third firing of the RTO timer, in a band that holds the reply time of the broker", () => {
    const stall = cell("T01.defaults.139");
    expect(stall.band).toEqual({ low: 1.603, high: 1.797 });
    expect(stall.prediction.text).toMatch(/at the third firing of the RTO timer/);
  });
});
