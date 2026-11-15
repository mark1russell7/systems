import { describe, expect, it } from "vitest";
import type { Cell, DeliveryPrediction, ProbeEvent, Run } from "./cell.ts";
import type { DeliveryStream } from "./delivery.ts";
import { deliveryFinding, deliveryOf, streamEnded, streamOf } from "./delivery.ts";

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const IMAGE = `ghcr.io/owner/procedures-subject:0.22.0@sha256:${"ab".repeat(32)}`;

/** a cell of a Socket.IO client: the target sends 50 events, one each 100 ms, into a stall of 7 s */
const STREAM: Cell = {
  name: "SIO.D1",
  target: { image: "node:24.21.0-alpine", subject: { kind: "pinned", image: IMAGE }, port: 8080, ready: '"ev":"listening"', lines: true },
  client: { image: { kind: "pinned", image: IMAGE }, command: ["node", "/opt/subject/client.mjs"] },
  sysctls: {},
  probe: {
    mode: "stream",
    keepalive: false,
    count: 50,
    interval: ms(100),
    sender: "target",
    ws: {
      socket: "global",
      heartbeat: { interval: ms(2000), timeout: ms(1000), misses: 1 },
      reconnect: { initialDelay: ms(500), multiplier: 2, maxDelay: ms(4000), attempts: 10, jitter: 0 },
      requestTimeout: ms(10_000),
      connectionTimeout: ms(10_000),
    },
  },
  fault: "stall",
  stall: s(7),
  prediction: {
    detects: true,
    timer: "pong",
    errno: "DROPPED",
    from: "ping-sent",
    low: s(0.998),
    high: s(3.004),
    delivery: { lost: { low: 0, high: 0 }, duplicates: { low: 0, high: 0 }, recovered: true },
  },
  runs: 11,
  environments: 2,
};

const line = (ev: string, t: number, more: Record<string, unknown> = {}): ProbeEvent => ({ ev, t, ...more });
const numbered = (ev: string, numbers: readonly number[]): ProbeEvent[] => numbers.map((n) => line(ev, n * 1e8, { n }));
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, at) => from + at);

/** a run with the lines of the client and of the target */
const run = (events: readonly ProbeEvent[], server: readonly ProbeEvent[] | undefined): Run => ({
  environment: 0,
  index: 0,
  events,
  fault: null,
  kernel: [],
  netns: 1,
  targetNetns: 2,
  lost: 0,
  ...(server === undefined ? {} : { server }),
});

const connected = (t: number, recovered?: boolean): ProbeEvent =>
  line("status", t, { status: "connected", ...(recovered === undefined ? {} : { recovered }) });

const FROM_TARGET: DeliveryStream = { count: 50, sender: "target" };
const FROM_CLIENT: DeliveryStream = { count: 50, sender: "client" };
const LAW = STREAM.prediction.detects === true ? STREAM.prediction.delivery! : (undefined as never);

describe("streamOf", () => {
  it("gives the count and the sender of a stream cell", () => {
    expect(streamOf(STREAM)).toEqual(FROM_TARGET);
  });

  it("names the client as the sender when the cell names none", () => {
    const { sender: _, ...probe } = STREAM.probe;
    expect(streamOf({ ...STREAM, probe }).sender).toBe("client");
  });

  it("throws for a cell with no stream of events", () => {
    expect(() => streamOf({ ...STREAM, probe: { ...STREAM.probe, mode: "idle" } })).toThrow(RangeError);
    const { count: _, ...uncounted } = STREAM.probe;
    expect(() => streamOf({ ...STREAM, probe: uncounted })).toThrow(/probe.count/);
    expect(() => streamOf({ ...STREAM, probe: { ...STREAM.probe, count: 0 } })).toThrow(RangeError);
  });

  it("throws for a target without its lines", () => {
    const { lines: _, ...target } = STREAM.target;
    expect(() => streamOf({ ...STREAM, target })).toThrow(/target.lines/);
  });
});

describe("deliveryOf", () => {
  it("reads a stream from the target that the client got in full, on a recovered connection", () => {
    const client = [connected(0), ...numbered("got", range(1, 50)), connected(9e9, true)];
    const read = deliveryOf(run(client, numbered("emitted", range(1, 50))), FROM_TARGET);
    expect(read).toEqual({ emitted: 50, got: 50, lost: 0, duplicates: 0, unknown: 0, recovered: true, ended: true });
    expect(deliveryFinding(LAW, FROM_TARGET, read)).toBeNull();
  });

  it("counts the lost events, the copies and the unknown events of a stream from the client", () => {
    const client = [connected(0), ...numbered("emitted", range(1, 50)), connected(9e9, false)];
    const target = numbered("got", [...range(1, 20), 19, 20, ...range(31, 50), 77]);
    const read = deliveryOf(run(client, target), FROM_CLIENT);
    expect(read).toEqual({ emitted: 50, got: 41, lost: 10, duplicates: 2, unknown: 1, recovered: false, ended: true });
  });

  it("gives null for recovered without a second connection, and no lines without the target's lines", () => {
    const read = deliveryOf(run([connected(0), ...numbered("emitted", range(1, 50))], undefined), FROM_CLIENT);
    expect(read).toEqual({ emitted: 50, got: 0, lost: 50, duplicates: 0, unknown: 0, recovered: null, ended: false });
  });

  it("reads a second connection without the field recovered as false", () => {
    const read = deliveryOf(run([connected(0), connected(9e9)], []), FROM_TARGET);
    expect(read.recovered).toBe(false);
  });

  it("skips lines without a number", () => {
    const read = deliveryOf(run([line("got", 1), line("got", 2, { n: "3" })], [line("emitted", 1)]), FROM_TARGET);
    expect(read.got).toBe(0);
    expect(read.emitted).toBe(0);
  });
});

describe("streamEnded", () => {
  it("tells that the receiver got the last event", () => {
    expect(streamEnded(run(numbered("got", range(1, 49)), []), FROM_TARGET)).toBe(false);
    expect(streamEnded(run(numbered("got", [50]), []), FROM_TARGET)).toBe(true);
    expect(streamEnded(run([], numbered("got", [50])), FROM_CLIENT)).toBe(true);
  });
});

describe("deliveryFinding", () => {
  const held = { emitted: 50, got: 50, lost: 0, duplicates: 0, unknown: 0, recovered: true, ended: true } as const;

  it("names each part of the law that a run broke", () => {
    const broke = { emitted: 48, got: 40, lost: 8, duplicates: 3, unknown: 2, recovered: false, ended: false };
    expect(deliveryFinding(LAW, FROM_TARGET, broke)).toBe(
      [
        "the target emitted 48 of the 50 events of the stream",
        "the client did not get event 50, the last of the stream",
        "the client got 2 events that the target did not emit",
        "the client lost 8 events, outside 0",
        "the client got 3 extra copies, outside 0",
        "the second connection of the client has recovered false, not true",
      ].join(". "),
    );
  });

  it("names the target as the receiver of a stream from the client, and a band in words", () => {
    const law: DeliveryPrediction = { lost: { low: 0, high: 5 }, duplicates: { low: 0, high: 0 } };
    expect(deliveryFinding(law, FROM_CLIENT, { ...held, lost: 6, recovered: null })).toBe("the target lost 6 events, outside 0 to 5");
  });

  it("names a run without a second connection when the law says recovered", () => {
    expect(deliveryFinding(LAW, FROM_TARGET, { ...held, recovered: null })).toBe(
      "the client made no second connection, thus it gave no value of recovered",
    );
  });

  it("gives null for a run that holds the law", () => {
    expect(deliveryFinding(LAW, FROM_TARGET, held)).toBeNull();
  });
});
