import { describe, expect, it } from "vitest";
import type { Cell, DriverBand, Prediction, Run } from "./cell.ts";
import { fieldOf, matches, measureDriver, settled, socketAt } from "./driver.ts";
import { measure } from "./observe.ts";
import { verdictOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const T = 50_000_000_000_000;
const at = (seconds: number) => T + Math.round(seconds * 1e9);
const MONITOR = "10.0.0.8:41000";
const POOL = "10.0.0.8:41002";

/** A write in flight into a black hole: the monitor writes the server off, the pool interrupts the write, and its retry's selection times out. */
const WRITE_OFF: DriverBand = {
  socket: "monitor",
  ends: { ev: "sdam", where: { event: "heartbeat-failed" }, name: "failure.name" },
  then: [
    {
      what: "the pool interrupts the operation in flight",
      name: "PoolClearedOnNetworkError",
      from: "last-received",
      ends: { ev: "command", where: { event: "failed", n: 2 }, name: "failure.name" },
      low: s(39.999),
      high: s(40.021),
    },
    { what: "the retry's selection times out", name: "MongoServerSelectionError", from: "last-received", ends: { ev: "fail", where: { n: 2 } }, low: s(69.999), high: s(70.041) },
  ],
};
const cellOf = (prediction: Prediction, more: Partial<Cell> = {}): Cell => ({
  name: "T01.defaults.1 blackhole, a write in flight",
  target: { image: "mongo:9.0.4", port: 27017, ready: "Waiting for connections", program: "mongod" },
  sysctls: {},
  probe: { mode: "inflight", keepalive: false, driver: { name: "mongodb", set: "rs0" } },
  fault: "blackhole",
  prediction,
  runs: 11,
  environments: 2,
  ...more,
});
const CELL = cellOf({
  detects: true,
  timer: "stream_timeout",
  errno: "MongoNetworkTimeoutError",
  from: "last-received",
  low: s(39.999),
  high: s(40.011),
  driver: WRITE_OFF,
});
const rx = (seconds: number, local: string, cookie: number, len = 100) => ({
  ev: "rx",
  mono: at(seconds),
  netns: 77,
  cookie,
  src: local,
  dst: "10.0.0.2:27017",
  seg: { seq: 1, len: { value: len, unit: "B" } },
});
const run = (more: Partial<Run> = {}): Run => ({
  environment: 0,
  index: 0,
  events: [
    { ev: "connecting", t: at(-12) },
    { ev: "socket", t: at(-12), role: "monitor", server: "10.0.0.2:27017", local: MONITOR },
    { ev: "socket", t: at(-11.9), role: "rtt", server: "10.0.0.2:27017", local: "10.0.0.8:41001" },
    { ev: "socket", t: at(-11.8), role: "pool", server: "10.0.0.2:27017", local: POOL },
    { ev: "connected", t: at(-11.8), local: POOL },
    { ev: "sent", t: at(-11.7), n: 1 },
    { ev: "ack", t: at(-11.69), n: 1 },
    { ev: "ready", t: at(-11.69) },
    { ev: "sent", t: at(0.05), n: 2 },
    { ev: "sdam", t: at(36.004), event: "heartbeat-failed", address: "10.0.0.2:27017", failure: { name: "MongoNetworkTimeoutError" } },
    { ev: "command", t: at(36.012), event: "failed", n: 2, failure: { name: "PoolClearedOnNetworkError" } },
    { ev: "fail", t: at(66.03), n: 2, name: "MongoServerSelectionError" },
    { ev: "error", t: at(66.03), errno: "MongoServerSelectionError" },
  ],
  fault: { t0: at(0), t1: at(0.0003) },
  kernel: [
    rx(-11.69, POOL, 3),
    // the monitor's last data before the fault, then an ACK without data
    rx(-4.0, MONITOR, 1),
    rx(-3.9, MONITOR, 1, 0),
    { ev: "clock", mono: at(70), lost: 0 },
  ],
  netns: 77,
  targetNetns: 1,
  lost: 0,
  ...more,
});

describe("a band of a driver with more than one socket", () => {
  it("reads a field in a field, and matches a line by its ev and its fields", () => {
    const line = { ev: "command", t: 1, event: "failed", n: 2, failure: { name: "PoolClearedOnNetworkError" } };
    expect(fieldOf(line, "failure.name")).toBe("PoolClearedOnNetworkError");
    expect(matches(line, { ev: "command", where: { event: "failed", n: 2 } })).toBe(true);
    expect(matches(line, { ev: "command", where: { n: 3 } })).toBe(false);
  });

  it("finds the socket of each role: the pool's first, and the latest of the others", () => {
    const events = [
      ...run().events,
      { ev: "socket-end", t: at(40), role: "monitor", server: "10.0.0.2:27017", local: MONITOR },
      { ev: "socket", t: at(50), role: "monitor", server: "10.0.0.2:27017", local: "10.0.0.8:41009" },
    ];
    expect(socketAt(events, "pool", at(60))?.local).toBe(POOL);
    expect(socketAt(events, "monitor", at(0))).toMatchObject({ local: MONITOR, ended: at(40) });
    expect(socketAt(events, "monitor", at(60))?.local).toBe("10.0.0.8:41009");
  });

  it("times the write-off from the monitor's last data, and each later band from its own reference", () => {
    const read = measure(CELL, run());
    expect(read).toMatchObject({ outcome: { kind: "error", errno: "MongoNetworkTimeoutError" }, elapsed: s(40.004), void: null, finding: null });
    expect(read.driver?.steps).toEqual([
      { what: "the pool interrupts the operation in flight", name: "PoolClearedOnNetworkError", elapsed: s(40.012) },
      { what: "the retry's selection times out", name: "MongoServerSelectionError", elapsed: s(70.03) },
    ]);
    expect(verdictOf(CELL.prediction, [read]).band).toEqual({ low: s(39.995), high: s(40.015) });
    expect(settled(CELL, run())).toBe(true);
    expect(settled(CELL, run({ events: run().events.slice(0, 10) }))).toBe(false);
  });

  it("finds a later band outside its band, an error of another name, and a quiet line", () => {
    const late = run({
      events: run().events.map((event) => (event.ev === "fail" ? { ...event, t: at(67), name: "MongoNetworkError" } : event)),
    });
    expect(measureDriver(CELL, late).finding).toBe("the retry's selection times out: it ended with MongoNetworkError, not MongoServerSelectionError");
    const quiet = cellOf({ ...CELL.prediction, driver: { ...WRITE_OFF, then: [], quiet: [{ ev: "fail" }] } } as Prediction);
    expect(measureDriver(quiet, run()).finding).toBe("a fail line came 66.03 s after the fault, where none should");
  });

  it("voids a run whose operation went out before the fault held, or whose freeze thawed late", () => {
    const early = run({ fault: { t0: at(0.06), t1: at(0.07) } });
    expect(measureDriver(CELL, early).void).toBe("the operation went out before the fault held");
    const held = { ...CELL, hold: s(41) };
    expect(measureDriver(held, run({ heal: { t0: at(41.01), t1: at(41.011) } })).void).toBe("the lift came 10 ms after its hold: the injector was late, not the client");
  });

  it("ends a band of the kernel at the report on its socket: a keepalive of the idle pool", () => {
    const idle = cellOf(
      { detects: true, timer: "keepalive", errno: "ETIMEDOUT", from: "last-received", low: s(129.999), high: s(134.736), driver: { socket: "pool", quiet: [{ ev: "sdam", where: { event: "heartbeat-failed" } }] } },
      { probe: { mode: "idle", keepalive: false, driver: { name: "mongodb", set: "rs0" } }, fault: "unreachable" },
    );
    const record = run({
      events: run().events.slice(0, 8),
      kernel: [rx(-11.69, POOL, 3), { ev: "error", mono: at(118.4), netns: 77, cookie: 3, src: POOL, err: 110 }, { ev: "clock", mono: at(140), lost: 0 }],
    });
    expect(measure(idle, record)).toMatchObject({ outcome: { kind: "error", errno: "ETIMEDOUT" }, elapsed: s(130.09), void: null, finding: null });
  });

  it("times a selection that starts into a fault from the client's start, and a silent reply from the fault", () => {
    const before = cellOf(
      { detects: true, timer: "selection_timeout", errno: "MongoServerSelectionError", from: "client-start", low: s(30), high: s(30.01), driver: { socket: "monitor", ends: { ev: "fail", where: { why: "connect" } } } },
      { before: true },
    );
    const started = run({
      events: [
        { ev: "connecting", t: at(1) },
        { ev: "fail", t: at(31.004), why: "connect", name: "MongoServerSelectionError" },
      ],
      kernel: [{ ev: "clock", mono: at(32), lost: 0 }],
    });
    expect(measure(before, started)).toMatchObject({ elapsed: s(30.004), void: null, finding: null });
    const thaw = cellOf(
      {
        detects: false,
        window: s(39),
        replies: { low: s(29), high: s(29.112) },
        driver: { socket: "pool", reply: { from: "fault", ends: { ev: "ack", where: { n: 2 } } }, quiet: [{ ev: "fail" }] },
      },
      { fault: "freeze-process", hold: s(29) },
    );
    const thawed = run({
      events: [...run().events.slice(0, 9), { ev: "ack", t: at(29.003), n: 2 }],
      heal: { t0: at(29.0004), t1: at(29.0006) },
    });
    const read = measure(thaw, thawed);
    expect(read).toMatchObject({ outcome: { kind: "answered" }, elapsed: s(29.003), void: null, finding: null });
    expect(verdictOf(thaw.prediction, [read]).band).toEqual({ low: s(28.996), high: s(29.116) });
  });
});
