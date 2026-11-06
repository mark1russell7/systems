import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ACCEPT_QUEUE_CELLS, synAckFiring, synAckWait, synGiveup, synWait, wheelOf } from "./accept-queue.ts";
import { ALL } from "./all.ts";
import { HZ } from "./catalog.ts";

const seconds = (band: { readonly low: { value: number; unit: string }; readonly high: { value: number; unit: string } }) => [
  valueIn(band.low, "s"),
  valueIn(band.high, "s"),
];

describe("the cells of the accept queue", () => {
  it("joins the catalog, four counted runs and one cell at a time", () => {
    expect(ACCEPT_QUEUE_CELLS).toHaveLength(7);
    for (const cell of ACCEPT_QUEUE_CELLS) {
      expect(ALL.some((each) => each.name === cell.name)).toBe(true);
      expect(cell.name).toMatch(/^AQ[.]\d /);
      expect(cell.runs).toBe(4);
      expect(cell.concurrency).toBe(1);
      expect(cell.fault).toBe("none");
      expect(cell.targetSysctls).toHaveProperty("net.core.somaxconn");
      expect(cell.targetSysctls).toHaveProperty("net.ipv4.tcp_abort_on_overflow");
    }
  });

  it("predicts the limit plus one in each cell of the count", () => {
    for (const cell of ACCEPT_QUEUE_CELLS.slice(0, 3)) {
      const { prediction } = cell;
      if (prediction.detects !== null || prediction.queue === undefined) throw new Error(`${cell.name} has no law`);
      expect(prediction.queue.held).toBe(prediction.queue.max + 1);
      expect(prediction.queue.connected).toBe(prediction.queue.max + 1);
    }
  });

  it("gives the ladder of the SYN from the document of Linux TCP", () => {
    const waits = Array.from({ length: 10 }, (_, k) => valueIn(synWait(k).low, "s"));
    expect(waits.map(Math.round)).toEqual([1, 1, 1, 1, 1, 2, 4, 8, 16, 32]);
    expect(Math.round(valueIn(synGiveup().low, "s"))).toBe(131);
  });

  it("gives the ladder of the SYN-ACK: 1 s doubled, and the expiry after six waits", () => {
    const [firstLow, firstHigh] = seconds(synAckWait(0));
    expect(firstLow).toBeLessThan(1.02);
    expect(firstHigh).toBeGreaterThan(1.02);
    const [low, high] = seconds(synAckWait(4));
    expect(low).toBeLessThan(16);
    expect(high).toBeCloseTo(16 + wheelOf(16) + 0.01, 6);
    const [earliest, latest] = seconds(synAckFiring(6));
    expect(earliest).toBeLessThan(63);
    expect(latest).toBeGreaterThan(63);
    expect(latest).toBeLessThan(HZ === 1000 ? 64.8 : 75);
  });

  it("sends the late segment after the latest expiry", () => {
    const [, latest] = seconds(synAckFiring(6));
    const cell = ACCEPT_QUEUE_CELLS.find((each) => each.name.startsWith("AQ.5"));
    const client = cell?.client;
    if (typeof client !== "object") throw new Error("AQ.5 has no client image");
    const flags = client.command;
    expect(Number(flags[flags.indexOf("--late-ms") + 1]) / 1000).toBeGreaterThan(latest!);
  });
});
