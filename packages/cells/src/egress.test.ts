import type { Cell, ClientImage, EgressPacketLaw, EgressPrediction } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { EGRESS_CELLS, EGRESS_SPECS, lawsOf, qdiscWords, rateWords } from "./egress.ts";

const MS = 1_000_000;
const s = (value: number) => ({ value, unit: "s" });
/** This function gives a band from two times in nanoseconds. */
const band = (low: number, high: number) => ({ low: s(low / 1e9), high: s(high / 1e9) });

const imageOf = (cell: Cell): ClientImage => {
  if (typeof cell.client !== "object") throw new Error(`${cell.name} has no client image`);
  return cell.client;
};

const cellOf = (plan: string): { cell: Cell; law: EgressPrediction } => {
  const cell = EGRESS_CELLS.find((each) => each.name.startsWith(`${plan} `));
  if (cell === undefined || cell.prediction.detects !== null || cell.prediction.egress === undefined) throw new Error(`${plan} has no law`);
  return { cell, law: cell.prediction.egress };
};

const outcomes = (packets: readonly EgressPacketLaw[]): string[] =>
  packets.map((packet) => (packet.kind === "sent" ? "sent" : `dropped at the ${packet.why}`));

describe("the cells of the egress qdisc", () => {
  it("joins the end of the catalog, four counted runs and one cell at a time, on an idle client with NET_ADMIN", () => {
    expect(EGRESS_CELLS).toHaveLength(7);
    expect(ALL.slice(-EGRESS_CELLS.length)).toEqual(EGRESS_CELLS);
    for (const cell of EGRESS_CELLS) {
      expect(cell.runs).toBe(4);
      expect(cell.concurrency).toBe(1);
      expect(cell.probe).toEqual({ mode: "idle", keepalive: false });
      expect(cell.fault).toBe("none");
      expect(imageOf(cell).capabilities).toEqual(["NET_ADMIN"]);
      expect(cell.target.command).toEqual(["/opt/harness/egress", "sink", "6393"]);
    }
  });

  it("gives the client the words of its qdisc and its bursts", () => {
    expect(imageOf(cellOf("EQ.1").cell).command).toEqual(["/opt/harness/egress", "send", "--qdisc", "netem rate 1mbit limit 1000", "--burst", "0:10:1472"]);
    expect(imageOf(cellOf("EQ.3").cell).command).toEqual([
      "/opt/harness/egress",
      "send",
      "--qdisc",
      "netem delay 100ms rate 10mbit limit 12",
      "--burst",
      "0:8:1472",
      "--burst",
      "30:8:1472",
    ]);
    expect(cellOf("EQ.3").law).toMatchObject({ qdisc: "netem delay 100ms rate 10mbit limit 12", kind: "netem", spread: s(0.002), jitter: s(0.002), read: 0.9 });
    expect(cellOf("EQ.3").law.bursts).toEqual([
      { at: s(0), count: 8, payload: 1472 },
      { at: s(0.03), count: 8, payload: 1472 },
    ]);
    expect(cellOf("EQ.5").law).toMatchObject({ qdisc: "tbf rate 1mbit burst 3000 limit 30000", kind: "tbf" });
    expect([rateWords(125_000), rateWords(1250), rateWords(1)]).toEqual(["1mbit", "10kbit", "8bit"]);
    expect(() => qdiscWords({ kind: "netem", netem: { rate: 125_000, limit: 10, packetOverhead: 4 } })).toThrow(/no overhead/);
  });
});

describe("the law of each datagram", () => {
  it("sends one full frame each 12.112 ms through netem at 1 Mbit/s, late by at most 2 ms", () => {
    const { packets } = cellOf("EQ.1").law;
    expect(packets).toEqual(Array.from({ length: 10 }, (_, n) => ({ kind: "sent", left: band(12_112_000 * (n + 1), 12_112_000 * (n + 1) + 2 * MS) })));
  });

  it("drops each frame after the tenth at a netem limit of 10", () => {
    expect(outcomes(cellOf("EQ.2").law.packets)).toEqual([...Array(10).fill("sent"), ...Array(10).fill("dropped at the limit")]);
  });

  it("counts the delay of netem in its limit, and the control with no delay drops no frame", () => {
    const delayed = cellOf("EQ.3").law.packets;
    expect(outcomes(delayed)).toEqual([...Array(12).fill("sent"), ...Array(4).fill("dropped at the limit")]);
    // the first frame of the second burst leaves 100 ms and one frame time after its own arrival
    expect(delayed[8]).toEqual({ kind: "sent", left: band(101_211_200, 101_211_200 + 2 * MS) });
    const control = cellOf("EQ.4").law.packets;
    expect(outcomes(control)).toEqual(Array(16).fill("sent"));
    expect(control[8]).toEqual({ kind: "sent", left: band(1_211_200, 1_211_200 + 2 * MS) });
  });

  it("sends the tokens of the bucket of tbf at once, then one frame each 8 ms", () => {
    const { packets } = cellOf("EQ.5").law;
    expect(packets.slice(0, 3)).toEqual([
      { kind: "sent", left: band(0, 2 * MS) },
      { kind: "sent", left: band(0, 4 * MS) },
      { kind: "sent", left: band(0, 4 * MS) },
    ]);
    expect(packets.slice(3)).toEqual(Array.from({ length: 7 }, (_, n) => ({ kind: "sent", left: band(8 * MS * (n + 1), 8 * MS * (n + 1) + 2 * MS) })));
  });

  it("drops at the bytes of the bfifo of tbf, and at its burst before its queue", () => {
    expect(outcomes(cellOf("EQ.6").law.packets)).toEqual([...Array(8).fill("sent"), ...Array(12).fill("dropped at the limit")]);
    expect(cellOf("EQ.7").law.packets).toEqual([
      { kind: "sent", left: band(0, 2 * MS) },
      { kind: "dropped", why: "size" },
      { kind: "sent", left: band(0, 2 * MS) },
    ]);
  });

  it("refuses a law whose outcome depends on the times of the arrivals, and bursts whose corners overlap", () => {
    // at 10 Mbit/s a frame leaves in 1.2 ms: a second frame 2 ms later finds the queue empty, and at once it finds it full
    expect(() => lawsOf({ queue: { kind: "netem", netem: { rate: 1_250_000, limit: 1 } }, bursts: [{ at: 0, count: 2, payload: 1472 }] })).toThrow(
      /the datagram 1 of the burst 0 is dropped at the limit or sent by the times of its arrivals/,
    );
    expect(() =>
      lawsOf({
        queue: { kind: "netem", netem: { rate: 125_000, limit: 100 } },
        bursts: [
          { at: 0, count: 1, payload: 100 },
          { at: 5, count: 1, payload: 100 },
        ],
      }),
    ).toThrow(/the burst 1 starts less than 6 ms after the burst before it/);
  });

  it("has a law for each datagram of each cell, and a payload that fits the MTU in one frame", () => {
    for (const spec of EGRESS_SPECS) {
      const law = cellOf(spec.plan).law;
      expect(law.packets).toHaveLength(spec.bursts.reduce((sum, burst) => sum + burst.count, 0));
      for (const burst of spec.bursts) expect(burst.payload + 28).toBeLessThanOrEqual(1500);
    }
  });
});
