import { describe, expect, it } from "vitest";
import type { Cell, DriverBand, KernelRecord, Prediction, Run } from "./cell.ts";
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

  it("starts the idle timer of a Node socket again at a write of data, as at a read", () => {
    // the monitor's awaited hello, 0.5 s after its first check: the write-off counts from that write
    const hello = { ...rx(-3.0, MONITOR, 1, 232), ev: "tx", dst: "10.0.0.2:27017" };
    const read = measure(CELL, run({ kernel: [...run().kernel.slice(0, 3), hello, { ev: "clock", mono: at(70), lost: 0 }] }));
    expect(read.elapsed).toEqual(s(39.004));
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

  it("voids a run whose event at a hop came before the operation, when the event must come while it is in flight", () => {
    const reload: Cell = { ...CELL, fault: "hop-event", event: { hop: "pgbouncer", signal: "HUP", inFlight: true } };
    // the operation goes at 0.05 s: an event 200 ms after it holds, and an event before it is void
    expect(measureDriver(reload, run({ fault: { t0: at(0.25), t1: at(0.2501) } })).void).toBeNull();
    expect(measureDriver(reload, run()).void).toBe("the event came before the operation");
    // without inFlight, the event comes first, as a fault does
    const pause: Cell = { ...CELL, fault: "hop-event", event: { hop: "pgbouncer", console: { port: 6432, user: "postgres", database: "pgbouncer", query: "PAUSE", undo: "RESUME" } } };
    expect(measureDriver(pause, run()).void).toBeNull();
    expect(measureDriver(pause, run({ fault: { t0: at(0.25), t1: at(0.2501) } })).void).toBe("the operation went out before the fault held");
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

  it("times the FIN of a target behind a pooler from the close of its socket toward the pooler, which the run did not open", () => {
    const fin = cellOf(
      { detects: true, timer: "the server ends the connection", errno: "EOF", from: "peer-closed", low: s(0), high: s(0.024), driver: { socket: "pool" } },
      { probe: { mode: "idle", keepalive: false, driver: { name: "pg" } }, fault: "fin" },
    );
    // the pooler at 10.0.1.5 keeps its connections to the target across its clients: each has its own
    // port, and one is older than the run. The death of the target closes each of them at once
    const state = (seconds: number, cookie: number, dst: string, old: number, now: number) => ({ ev: "state", mono: at(seconds), netns: 1, cookie, src: "10.0.1.2:5432", dst, old, new: now });
    const record = run({
      events: run().events.slice(0, 8),
      topology: { targetPeer: "10.0.1.5", hops: {} },
      kernel: [
        rx(-11.69, POOL, 3),
        state(-30, 9, "10.0.1.5:51000", 2, 1),
        state(0.0005, 9, "10.0.1.5:51000", 1, 4),
        state(0.0006, 10, "10.0.1.5:51002", 1, 4),
        // the FIN of the pooler reaches the client: its socket goes to CLOSE_WAIT
        { ev: "state", mono: at(0.003), netns: 77, cookie: 3, src: POOL, dst: "10.0.1.5:9999", old: 1, new: 8 },
        { ev: "clock", mono: at(10), lost: 0 },
      ],
    });
    expect(measure(fin, record)).toMatchObject({ outcome: { kind: "eof" }, elapsed: s(0.0025), void: null, finding: null });
  });

  it("times the connect of a pooler into a black hole from its SYN, to its own close in SYN_SENT or to the give-up of its kernel", () => {
    const connect = (errno: string, low: number, high: number) =>
      cellOf(
        { detects: true, timer: "server_connect_timeout", errno, from: "syn-sent", low: s(low), high: s(high), driver: { socket: "upstream" } },
        { probe: { mode: "idle", keepalive: false, driver: { name: "hikari" } }, before: true },
      );
    // the client starts into the fault. PgBouncer, at 10.0.1.5, connects to the server by itself: no line of the client names that socket
    const hop = (records: readonly KernelRecord[]): Run =>
      run({
        events: [{ ev: "connecting", t: at(0.5) }],
        topology: { targetPeer: "10.0.1.5", hops: { pgbouncer: { netns: 5, client: "10.0.0.8", target: "10.0.1.2:5432" } } },
        kernel: [...records, { ev: "clock", mono: at(200), lost: 0 }],
      });
    const syn = { ev: "state", mono: at(0.6), netns: 5, cookie: 21, src: "10.0.1.5:40000", dst: "10.0.1.2:5432", old: 7, new: 2 } as KernelRecord;
    // inside: the connect timer of PgBouncer closes its socket in SYN_SENT, with no error and no FIN
    const given = hop([syn, { ...syn, mono: at(125.6), old: 2, new: 7 } as KernelRecord]);
    expect(measure(connect("CLOSED", 125, 125.4), given)).toMatchObject({ outcome: { kind: "closed" }, elapsed: s(125), void: null, finding: null });
    expect(settled(connect("CLOSED", 125, 125.4), given)).toBe(true);
    // outside: the kernel of PgBouncer gives up on the SYNs first, and it reports ETIMEDOUT before the close
    const gaveUp = hop([syn, { ev: "error", mono: at(131.6), netns: 5, cookie: 21, src: "10.0.1.5:40000", err: 110 } as KernelRecord, { ...syn, mono: at(131.6), old: 2, new: 7 } as KernelRecord]);
    expect(measure(connect("ETIMEDOUT", 130.9, 131.1), gaveUp)).toMatchObject({ outcome: { kind: "error", errno: "ETIMEDOUT" }, elapsed: s(131), void: null, finding: null });
    // a pooler that opened no connect in the run: the prober saw nothing of the socket
    expect(measure(connect("CLOSED", 125, 125.4), hop([])).void).toBe("the prober saw nothing of the upstream socket");
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

  it("times the forget of the flow of the socket of the driver from its last segment, when a silent prediction gives it", () => {
    // the server aborts its socket and resets it: the router keeps the entry in CLOSE, then forgets it
    const forgets = cellOf(
      { detects: false, window: s(60), middlebox: { forgets: { low: s(40), high: s(41) } }, driver: { socket: "pool" } },
      { probe: { mode: "idle", keepalive: false, driver: { name: "grpc" } } },
    );
    const destroy = (seconds: number, local: string) => ({ ev: "ct", t: at(seconds), type: "DESTROY", state: "CLOSE", orig: `${local}>10.0.0.2:27017`, hop: "nat" });
    const idle = (middlebox: NonNullable<Run["middlebox"]>) => run({ events: run().events.slice(0, 8), kernel: [rx(-11.69, POOL, 3), { ev: "clock", mono: at(70), lost: 0 }], middlebox });
    // the last segment of the pool is at -11.69 s: a forget at 29 s is 40.69 s after it
    expect(measure(forgets, idle([destroy(29, POOL)]))).toMatchObject({ outcome: { kind: "silent" }, void: null, finding: null });
    expect(measure(forgets, idle([destroy(31, POOL)])).finding).toMatch(/^a router forgot the flow of the pool socket 42\.69 s after its last segment, outside \[/);
    expect(measure(forgets, idle([])).finding).toBe("no router forgot the flow of the pool socket in the window, where it should forget it");
    // the band is for the socket of the driver: a forget of another socket is still a finding
    expect(measure(forgets, idle([destroy(29, POOL), destroy(20, MONITOR)])).finding).toBe(
      "a router forgot the flow of the monitor socket 20 s after the fault, where it should keep it",
    );
  });
});
