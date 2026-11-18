import { describe, expect, it } from "vitest";
import type { EgressOutcome, EgressPacket } from "./egress.ts";
import {
  fifoDefaultLimit,
  gsoQdiscLength,
  netemPacketTime,
  netemSchedule,
  pschedFactor,
  pschedLengthTime,
  tbfBuckets,
  tbfSchedule,
  udpFrameLength,
} from "./egress.ts";

const MS = 1_000_000;
// 10 Mbit/s and 1 Mbit/s in bytes per second
const TEN_MBIT = 1_250_000;
const ONE_MBIT = 125_000;
// one full frame of a 1500-byte MTU: 1472 bytes of UDP payload
const FRAME = 1514;

const burst = (count: number, length: number, at = 0): EgressPacket[] =>
  Array.from({ length: count }, () => ({ at, length }));

const steady = (count: number, gap: number, length: number): EgressPacket[] =>
  Array.from({ length: count }, (_, index) => ({ at: index * gap, length }));

const sentAt = (outcomes: readonly EgressOutcome[]): (number | string)[] =>
  outcomes.map((outcome) => (outcome.kind === "sent" ? outcome.at : outcome.why));

describe("the qdisc length", () => {
  it("adds the Ethernet, IP and UDP headers", () => {
    expect(udpFrameLength(1472)).toBe(FRAME);
    expect(udpFrameLength(1452, 6)).toBe(FRAME);
    expect(udpFrameLength(0)).toBe(42);
  });

  it("adds the headers of each GSO segment after the first", () => {
    expect(gsoQdiscLength(10_066, 7, 66)).toBe(10_066 + 6 * 66);
    expect(gsoQdiscLength(FRAME, 1, 66)).toBe(FRAME);
  });
});

describe("the time of a packet in netem", () => {
  it("divides the length by the rate and rounds down", () => {
    expect(netemPacketTime(FRAME, { rate: TEN_MBIT })).toBe(1_211_200);
    expect(netemPacketTime(1, { rate: 3 })).toBe(333_333_333);
  });

  it("adds the overhead of each packet", () => {
    expect(netemPacketTime(FRAME, { rate: TEN_MBIT, packetOverhead: 4 })).toBe(1_214_400);
    expect(netemPacketTime(FRAME, { rate: TEN_MBIT, packetOverhead: -14 })).toBe(1_200_000);
  });

  it("rounds the length up to whole cells", () => {
    const atm = { rate: TEN_MBIT, cellSize: 48, cellOverhead: 5 };
    expect(netemPacketTime(100, atm)).toBe(127_200);
    expect(netemPacketTime(96, atm)).toBe(84_800);
  });
});

describe("the queue of netem", () => {
  it("sends a burst at the rate and drops the packets above its limit", () => {
    const outcomes = netemSchedule(burst(5, FRAME), { rate: TEN_MBIT, limit: 3 });
    expect(sentAt(outcomes)).toEqual([1_211_200, 2_422_400, 3_633_600, "limit", "limit"]);
    expect(outcomes[3]).toEqual({ kind: "dropped", why: "limit", ahead: 3, bytes: 3 * FRAME });
  });

  it("adds the delay before the first packet only", () => {
    const outcomes = netemSchedule(burst(3, FRAME), { rate: TEN_MBIT, limit: 10, latency: 10 * MS });
    expect(sentAt(outcomes)).toEqual([11_211_200, 12_422_400, 13_633_600]);
  });

  it("holds no packet when the gap is longer than the time of a packet", () => {
    const outcomes = netemSchedule(steady(5, 2 * MS, FRAME), { rate: TEN_MBIT, limit: 1 });
    expect(sentAt(outcomes)).toEqual([0, 1, 2, 3, 4].map((index) => index * 2 * MS + 1_211_200));
    expect(outcomes.every((outcome) => outcome.ahead === 0)).toBe(true);
  });

  it("builds a queue when packets come faster than the rate", () => {
    const outcomes = netemSchedule(steady(20, MS, FRAME), { rate: TEN_MBIT, limit: 1000 });
    expect(sentAt(outcomes)).toEqual(Array.from({ length: 20 }, (_, index) => (index + 1) * 1_211_200));
    const last = outcomes[19]!;
    // at 19 ms, the packets of index 15 to 18 leave after 19 ms
    expect(last.ahead).toBe(4);
  });

  it("counts the packets of the delay in its limit", () => {
    // 1,000 packets a second for a delay of 100 ms: the limit of 50 fills at 50 ms
    const outcomes = netemSchedule(steady(200, MS, FRAME), { rate: 1_000_000_000, limit: 50, latency: 100 * MS });
    const firstDrop = outcomes.findIndex((outcome) => outcome.kind === "dropped");
    expect(firstDrop).toBe(50);
    const again = outcomes.findIndex((outcome, index) => index > firstDrop && outcome.kind === "sent");
    expect(again).toBe(101);
    expect(outcomes[100]).toEqual({ kind: "dropped", why: "limit", ahead: 50, bytes: 50 * FRAME });
    expect(outcomes[101]).toEqual({ kind: "sent", at: 201 * MS + FRAME, ahead: 49, bytes: 49 * FRAME });
  });

  it("refuses arrivals that go back in time", () => {
    expect(() => netemSchedule([{ at: 5, length: 1 }, { at: 4, length: 1 }], { rate: 1, limit: 1 })).toThrow(
      /back in time/,
    );
  });
});

describe("the rates of the packet scheduler", () => {
  it("doubles the factor until the quotient fills 32 bits", () => {
    expect(pschedFactor(ONE_MBIT)).toEqual({ mult: 4_194_304_000, shift: 19 });
    expect(pschedFactor(TEN_MBIT)).toEqual({ mult: 3_355_443_200, shift: 22 });
    expect(pschedFactor(3_000_000)).toEqual({ mult: 2_796_202_666, shift: 23 });
  });

  it("gives the time of a length by the factor, which can be 1 ns short", () => {
    expect(pschedLengthTime(1000, { rate: ONE_MBIT })).toBe(8 * MS);
    expect(pschedLengthTime(1500, { rate: 3_000_000 })).toBe(499_999);
  });

  it("adds the overhead, takes the mpu and counts ATM cells", () => {
    expect(pschedLengthTime(1000, { rate: ONE_MBIT, overhead: 24 })).toBe(8_192_000);
    expect(pschedLengthTime(40, { rate: ONE_MBIT, mpu: 64 })).toBe(512_000);
    expect(pschedLengthTime(100, { rate: ONE_MBIT, linklayer: "atm" })).toBe(1_272_000);
  });
});

describe("the token bucket of tbf", () => {
  const plain = { rate: { rate: ONE_MBIT }, burst: 3000, limit: 6000 };
  const peaked = { ...plain, limit: 100_000, peak: { rate: 250_000, burst: 1000 } };

  it("gives the depth of each bucket and the largest packet", () => {
    expect(tbfBuckets(plain)).toEqual({ buffer: 24 * MS, mtu: 0, maxSize: 3000 });
    expect(tbfBuckets(peaked)).toEqual({ buffer: 24 * MS, mtu: 4 * MS, maxSize: 1000 });
  });

  it("sends the burst at once, then one packet for each time of a packet", () => {
    const outcomes = tbfSchedule(burst(10, 1000), plain);
    expect(sentAt(outcomes)).toEqual([0, 0, 0, 8 * MS, 16 * MS, 24 * MS, 32 * MS, 40 * MS, 48 * MS, "limit"]);
    expect(outcomes[9]).toEqual({ kind: "dropped", why: "limit", ahead: 6, bytes: 6000 });
  });

  it("fills the bucket again while it is idle, up to its depth", () => {
    const packets = [...burst(4, 1000), ...burst(4, 1000, 1000 * MS)];
    expect(sentAt(tbfSchedule(packets, plain))).toEqual([0, 0, 0, 8 * MS, 1000 * MS, 1000 * MS, 1000 * MS, 1008 * MS]);
  });

  it("spaces a burst by the peak rate until the bucket of the rate is empty", () => {
    const outcomes = tbfSchedule(burst(6, 1000), peaked);
    expect(sentAt(outcomes)).toEqual([0, 4 * MS, 8 * MS, 12 * MS, 16 * MS, 24 * MS]);
  });

  it("drops a packet longer than its largest size", () => {
    const outcomes = tbfSchedule([{ at: 0, length: 1001 }], peaked);
    expect(outcomes[0]).toEqual({ kind: "dropped", why: "size", ahead: 0, bytes: 0 });
  });

  it("refuses a peak rate that is not above the rate", () => {
    expect(() => tbfBuckets({ ...plain, peak: { rate: ONE_MBIT, burst: 1000 } })).toThrow(/peak rate/);
  });
});

describe("the limits of the FIFO qdiscs", () => {
  it("gives txqueuelen packets, or txqueuelen frames in bytes", () => {
    expect(fifoDefaultLimit("pfifo", 1000, 1500)).toBe(1000);
    expect(fifoDefaultLimit("bfifo", 1000, 1500)).toBe(1000 * FRAME);
    expect(fifoDefaultLimit("bfifo", 1000, 9000, 14)).toBe(9_014_000);
  });
});
