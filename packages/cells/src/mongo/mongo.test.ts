import { algebraProblems, machineProblems, overValues, timerOf } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import { HZ, LINUX, given } from "../catalog.ts";
import { MANIFESTATIONS } from "../manifestations.ts";
import { MONGO_IMAGE } from "./cells.ts";
import type { MongoCell } from "./cells.ts";
import {
  MONGOD_REPL,
  MONGOD_SESSION,
  MONGODB_NODE,
  driverTimes,
  driverValues,
  electionOf,
  firstOn,
  interrupts,
  linuxValues,
  lostOf,
  replTimes,
  replValues,
  sessionKeepalive,
  sessionValues,
  syncOf,
  timelineOf,
} from "./model.ts";
import { T01_MONGO, T01_MONGO_ALIASES, T01_MONGO_WAITING, wheelBoundary } from "./t01.ts";
import { T03_MONGO, T03_MONGO_ALIASES, T03_MONGO_WAITING } from "./t03.ts";
import { T11_MONGO, T11_MONGO_ALIASES, T11_MONGO_WAITING } from "./t11.ts";

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const at250 = HZ === 250;
const values = (timer: string, doc = MONGODB_NODE, known = given(driverValues())) => {
  const bounds = timerOf(doc, timer, known);
  return [bounds.duration, bounds.early ?? null, bounds.lateness ?? null].map((each) => (each === null || "unknown" in each ? null : each.value));
};

describe("the machine documents of MongoDB", () => {
  it("parses each document, and each has no problem for the checker or for the algebra", () => {
    for (const doc of [MONGODB_NODE, MONGOD_REPL, MONGOD_SESSION]) {
      expect(machineProblems(doc), doc.id).toEqual([]);
      expect(algebraProblems(doc), doc.id).toEqual([]);
      expect(doc.over === undefined || doc.over.machine === "systems.machine.linux-tcp", doc.id).toBe(true);
    }
  });

  it("gives the timers of the driver 7.7.0 at its defaults", () => {
    // the write-off: connectTimeoutMS + heartbeatFrequencyMS, 1 ms after the socket's timeout
    expect(values("stream_timeout")).toEqual([40000, 1, 11]);
    expect(values("connect_timeout")).toEqual([30000, null, 11]);
    expect(values("handshake_timeout")).toEqual([30000, null, 11]);
    expect(values("check_period")).toEqual([10000, null, 10]);
    expect(values("selection_timeout")).toEqual([30000, null, 10]);
    // socketTimeoutMS 0 and waitQueueTimeoutMS 0 have no timer
    expect(values("socket_timeout")[0]).toBe("infinite");
    expect(values("checkout_timeout")[0]).toBe("infinite");
    // connectTimeoutMS 0 has no write-off either (monitor.ts:353)
    expect(values("stream_timeout", MONGODB_NODE, given(driverValues({ connectTimeoutMS: 0 })))[0]).toBe("infinite");
  });

  it("sets the keepalive of each socket of the driver over the namespace's sysctls: 120 s, then 10 probes 1 s apart", () => {
    const lower = overValues(MONGODB_NODE, given(driverValues()), given(linuxValues()));
    expect(values("keepalive", LINUX, lower)[0]).toBe(130);
    const short = overValues(MONGODB_NODE, given(driverValues({ keepAliveInitialDelay: 27500 })), given(linuxValues()));
    // Node gives libuv the delay in whole seconds
    expect(values("keepalive", LINUX, short)[0]).toBe(37);
  });

  it("gives mongod's keepalive on a client connection: 300 s and probes 1 s apart, not the namespace's 75 s", () => {
    const lower = overValues(MONGOD_SESSION, given(sessionValues()), given(linuxValues()));
    expect(lower("keepidle")).toEqual({ value: 300, unit: "s" });
    expect(lower("keepintvl")).toEqual({ value: 1, unit: "s" });
    expect(lower("keepcnt")).toEqual({ value: 9, unit: "count" });
    expect(sessionKeepalive().lo).toBeCloseTo(309 - 1 / HZ, 9);
    // a lower sysctl is kept: mongod sets only a maximum (socket_utils.cpp:165-196)
    expect(sessionKeepalive({ tcp_keepalive_time: 5 }).lo).toBeCloseTo(14 - 1 / HZ, 9);
  });

  it("gives the timers of mongod 9.0.4's replication at its defaults", () => {
    const known = given(Object.fromEntries(Object.entries(MONGOD_REPL.knobs).flatMap(([name, knob]) => (knob.default === null || knob.unit === null ? [] : [[name, { value: knob.default, unit: knob.unit }]]))));
    expect(values("heartbeat", MONGOD_REPL, known)).toEqual([2000, null, 10]);
    expect(values("heartbeat_fast", MONGOD_REPL, known)).toEqual([500, null, 10]);
    expect(values("heartbeat_window", MONGOD_REPL, known)).toEqual([10000, null, 10]);
    // the offset is less than 0.15 × the election timeout
    expect(values("election", MONGOD_REPL, known)).toEqual([10000, null, 1510]);
    expect(values("liveness", MONGOD_REPL, known)).toEqual([10000, null, 10]);
    expect(values("vote_request", MONGOD_REPL, known)).toEqual([10000, null, null]);
    expect(values("step_down_wait", MONGOD_REPL, known)).toEqual([10, null, 10]);
    expect(replTimes().catchup).toBe(Number.POSITIVE_INFINITY);
    // the oplog fetcher's exhaust read and its new cursor are kernel timers on the wheel, at the level of 10 s
    const set = given(replValues());
    const wheel = (at250 ? 256 : 512) / 1000;
    expect(values("oplog_read", MONGOD_REPL, set)).toEqual([10000, 1 / HZ, wheel]);
    expect(values("oplog_restart", MONGOD_REPL, set)).toEqual([5, null, 10]);
    expect(values("oplog_refind", MONGOD_REPL, set)).toEqual([7000, null, wheel]);
    expect(values("feedback_keepalive", MONGOD_REPL, set)).toEqual([5000, null, 10]);
    expect(values("feedback_update", MONGOD_REPL, set)).toEqual([30, null, 10]);
    // a longer election timeout lengthens the read and the keepalive of the reporter
    const slow = given(replValues({ electionTimeoutMillis: 40000 }));
    expect(values("oplog_read", MONGOD_REPL, slow)[0]).toBe(25000);
    expect(slow("oplog_read_timeout")).toEqual({ value: 25000, unit: "ms" });
    expect(values("feedback_keepalive", MONGOD_REPL, slow)[0]).toBe(20000);
  });

  it("answers an awaitable hello after maxAwaitTimeMS", () => {
    const known = given({ ...sessionValues(), maxAwaitTimeMS: { value: 10000, unit: "ms" } });
    expect(values("hello_await", MONGOD_SESSION, known)).toEqual([10000, null, 20]);
  });
});

describe("the composition of the driver over Linux TCP", () => {
  const driver = given(driverValues());
  const linux = given(linuxValues());

  it("writes a silent server off at 40 s on the monitor's socket, before the kernel's keepalive at 130 s", () => {
    const first = firstOn({ role: "monitor", inFlight: false, manifestation: MANIFESTATIONS.blackhole }, driver, linux);
    expect(first).toMatchObject({ kind: "timer", timer: "stream_timeout", layer: "driver", name: "MongoNetworkTimeoutError" });
    // a frozen server's kernel answers each probe: the write-off is the same
    expect(firstOn({ role: "monitor", inFlight: false, manifestation: MANIFESTATIONS["freeze-process"] }, driver, linux)).toMatchObject({ timer: "stream_timeout" });
    // the idle pool socket has only the kernel's keepalive, and a write in flight the retransmissions
    expect(firstOn({ role: "pool", inFlight: false, manifestation: MANIFESTATIONS.blackhole }, driver, linux)).toMatchObject({ timer: "keepalive", name: "ETIMEDOUT" });
    expect(firstOn({ role: "pool", inFlight: true, manifestation: MANIFESTATIONS.blackhole }, driver, linux)).toMatchObject({ timer: "retrans_giveup" });
  });

  it("puts the kernel's keepalive first when the driver's keepalive delay is short", () => {
    const short = given(driverValues({ keepAliveInitialDelay: 27000 }));
    const long = given(driverValues({ keepAliveInitialDelay: 31000 }));
    expect(firstOn({ role: "monitor", inFlight: false, manifestation: MANIFESTATIONS.blackhole }, short, linux)).toMatchObject({ timer: "keepalive", layer: "kernel" });
    expect(firstOn({ role: "monitor", inFlight: false, manifestation: MANIFESTATIONS.blackhole }, long, linux)).toMatchObject({ timer: "stream_timeout", layer: "driver" });
    // only a timeout interrupts the operations in flight: the end of a stream by the kernel does not
    expect([interrupts("written-off"), interrupts("connect-timed-out"), interrupts("stream-ended")]).toEqual([true, true, false]);
  });

  it("keeps the monitor while the server's replies come, and ends it at once on a FIN", () => {
    const replies = firstOn({ role: "monitor", inFlight: false, manifestation: { name: "unreachable", passes: ["rx.ack"] }, passes: ["rx.hello"] }, driver, linux);
    expect(replies.kind).toBe("silent");
    expect(firstOn({ role: "monitor", inFlight: false, manifestation: MANIFESTATIONS.fin }, driver, linux)).toEqual({ kind: "delivered", event: "rx.fin", name: "EOF" });
  });
});

describe("the timeline of a replica set of three after a fault", () => {
  const repl = replTimes();
  const driver = driverTimes();

  it("detects a silent primary in 10 to 12 s, and elects in 10 to 11.5 s from the last write", () => {
    const e = electionOf(repl, driver, 0.001);
    expect(round(e.down.lo)).toBe(9.999);
    expect(round(e.down.hi)).toBe(12.02);
    // the last write's batch at most one write cycle before the fault, then the timeout and its offset
    expect(round(e.start.lo)).toBe(round(10 - (0.05 + 0.002 + 0.1 + 0.01)));
    expect(round(e.start.hi)).toBe(11.511);
  });

  it("gives two modes to the catch-up: the window to the old primary open at the win, or a new one of 10 s", () => {
    const e = electionOf(repl, driver, 0.001);
    expect(e.modes.length).toBe(2);
    expect(round(e.modes[0]!.hi)).toBe(12.02);
    expect(round(e.modes[1]!.lo)).toBe(19.999);
    expect(round(e.writable.hi)).toBe(21.753);
    // catchUpTimeoutMillis 0 skips it: the new primary writes after the win and its local work
    const skipped = electionOf(replTimes({ catchUpTimeoutMillis: 0 }), driver, 0.001);
    expect(skipped.modes).toEqual([skipped.elected]);
  });

  it("lands the first write at the driver's write-off when the old primary is silent to the client", () => {
    const t = timelineOf({ kind: "silent", alive: false, back: 60 }, {}, {}, 1);
    expect(t.lands).toBe("new");
    expect(round(t.writtenOff!.lo)).toBe(29.999);
    expect(round(t.writtenOff!.hi)).toBe(40.011);
    // the new primary is known long before: the retry finds it at once, on a new connection
    expect(t.discovered!.hi).toBeLessThan(t.writtenOff!.lo);
    expect(round(t.first!.lo)).toBe(round(29.999 + 0.003));
  });

  it("lands the first write at the new primary's writes when the old primary steps down for its clients", () => {
    const t = timelineOf({ kind: "cut-from-group", w: "majority" }, {}, {}, 1);
    expect(round(t.steppedDown!.lo)).toBe(round(10 - 0.162));
    expect(t.first!.lo).toBeGreaterThanOrEqual(t.steppedDown!.lo);
    // chained: the other secondary syncs from the new primary. Direct: it syncs from the old one, and
    // the new primary learns its position at the response to a heartbeat
    const [chained, direct] = t.firstModes;
    expect(chained!.hi).toBeLessThan(22.1);
    expect(direct!.lo).toBeGreaterThan(16.5);
    expect(direct!.hi).toBeLessThan(27);
    // with w 1, no write waits for the other secondary
    expect(timelineOf({ kind: "cut-from-group", w: 1 }, {}, {}, 1).firstModes).toEqual([]);
  });

  it("hands a step-down off in under a second: the other secondary can wait one heartbeat of 500 ms", () => {
    const t = timelineOf({ kind: "step-down" }, {}, {}, 1);
    const [chained, direct] = t.firstModes;
    expect(chained!.hi).toBeLessThan(0.7);
    expect(direct!.hi - chained!.hi).toBeGreaterThan(0.45);
    expect(t.first!.hi).toBeLessThan(1.2);
    expect(t.down).toBeNull();
  });

  it("drops the old primary as a sync source after the fetcher's read and its new cursor time out, and holds the reporter for 30 s", () => {
    const e = electionOf(repl, driver, 0.001);
    const sync = syncOf(repl, driver, 0.001, e.writable);
    // the last batch at most one write cycle before the fault, 10 s on the wheel, 5 ms, then 7 s
    const wheel = at250 ? 0.256 : 0.512;
    expect(round(repl.oplogRead.hi)).toBe(round(10 + wheel));
    expect(round(repl.refind.lo)).toBe(7.005);
    // the new primary can write before or after the drop: then the member takes it at a heartbeat of 500 ms
    expect(round(sync.takes.lo)).toBe(round(-0.162 + 10 - 1 / HZ + 7.005));
    expect(round(sync.takes.hi)).toBe(round(e.writable.hi + 0.5 + 0.001 + 0.01));
    expect(round(sync.released.lo)).toBe(round(30 - 0.162));
    expect(round(sync.released.hi)).toBe(35.02);
    // an old primary that is back answers the command at once
    expect(round(syncOf(repl, driver, 0.001, e.writable, 13).released.hi)).toBe(13.011);
  });

  it("fails the retry when the election comes after its selection timeout", () => {
    const t = timelineOf({ kind: "silent", alive: false, back: 90 }, { electionTimeoutMillis: 40000 }, { heartbeatFrequencyMS: 2000, connectTimeoutMS: 5000 }, 1);
    expect(t.fails!.hi).toBeLessThan(t.discovered!.lo);
    expect(round(t.fails!.lo)).toBe(34.999);
  });

  it("counts the writes that a cut primary acknowledges with w 1 before it steps down", () => {
    const lost = lostOf({}, {}, 1);
    expect(lost.lo).toBeGreaterThan(100);
    expect(lost.hi).toBeLessThanOrEqual(202);
  });
});

/** These are the cells of the plan over mongodb-node-7.7 and mongodb-replset, by template and stage. */
const PLAN = {
  T01: {
    defaults: [1, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 210, 211],
    border: [...Array.from({ length: 120 }, (_, at) => at + 1), 141, 142, 149, 150, 175, 176, 183, 184, 193, 194, 207, 208, 215, 216, 217, 218, 221, 222, 235, 236, 241, 242],
  },
  T03: { defaults: [1, 2, 3, 4, 5, 28, 38, 39, 40, 41, 66], border: Array.from({ length: 118 }, (_, at) => at + 1) },
  T11: { defaults: [1, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18], border: Array.from({ length: 78 }, (_, at) => at + 1) },
} as const;

describe("the MongoDB catalogs", () => {
  const cells: readonly MongoCell[] = [...T01_MONGO, ...T03_MONGO, ...T11_MONGO];
  const aliases = [...T01_MONGO_ALIASES, ...T03_MONGO_ALIASES, ...T11_MONGO_ALIASES];
  const waiting = [...T01_MONGO_WAITING, ...T03_MONGO_WAITING, ...T11_MONGO_WAITING];

  it("names each cell once, by the cell of the plan that it stands for, and pins the image", () => {
    expect(new Set(cells.map((each) => each.name)).size).toBe(cells.length);
    for (const cell of cells) expect(cell.name).toMatch(/^T(01|03|11)\.(defaults|border-off)\.\d+ mongodb-node-7\.7 to mongodb-replset/);
    expect(MONGO_IMAGE).toMatch(/^mongo:9\.0\.4@sha256:[0-9a-f]{64}$/);
  });

  it("gives each cell of the plan over these systems a cell, an alias or a reason to wait, once", () => {
    const planned = new Set(cells.map((each) => each.spec.plan));
    for (const [template, stages] of Object.entries(PLAN)) {
      const ids = [...stages.defaults.map((n) => `${template}.defaults.${n}`), ...stages.border.map((n) => `${template}.border-off.${n}`)];
      for (const id of ids) {
        const count = (planned.has(id) ? 1 : 0) + aliases.filter((each) => each.plan === id).length + waiting.filter((each) => each.plan === id).length;
        expect(count, id).toBe(1);
      }
    }
    for (const alias of aliases) expect(planned.has(alias.is), `${alias.plan} is ${alias.is}`).toBe(true);
  });

  it("gives each cell a band from its documents, or silence in its window", () => {
    for (const cell of cells) {
      const p = cell.prediction;
      expect(p.detects, cell.name).not.toBeNull();
      for (const band of p.bands) {
        expect(band.low.value, `${cell.name}: ${band.what}`).toBeLessThanOrEqual(band.high.value);
        expect(band.high.value, `${cell.name}: ${band.what}`).toBeLessThanOrEqual(p.window.value);
      }
      if (p.detects === true) expect(p.bands.length, cell.name).toBeGreaterThan(0);
      if (p.detects === false) expect(p.quiet.length, cell.name).toBeGreaterThan(0);
      expect(p.rtt, cell.name).toBeDefined();
    }
  });

  it("puts the in-flight write's interruption on each side of the keepalive delay of 29 s", () => {
    const named = (plan: string) => T01_MONGO.find((each) => each.spec.plan === plan)!.prediction;
    const short = named("T01.border-off.21");
    const long = named("T01.border-off.22");
    expect(short.bands[0]!.name).toBe("ETIMEDOUT");
    expect(long.bands[0]!.name).toBe("MongoNetworkTimeoutError");
    // a short keepalive ends the stream without a timeout: the in-flight write waits a heartbeat and a connect timeout more
    expect(short.bands[1]!.low.value).toBeGreaterThan(long.bands[1]!.high.value + 30);
    // the level of the timer wheel above 120 s, at the HZ of the kernel
    expect(wheelBoundary()).toBe(at250 ? 129.024 : 258.048);
  });

  it("writes the server off one reply after an ICMP unreachable: the stream stops behind the reply that has no ACK", () => {
    for (const plan of ["T01.defaults.42", "T03.defaults.3"]) {
      const p = [...T01_MONGO, ...T03_MONGO].find((each) => each.spec.plan === plan)!.prediction;
      expect(p.quiet, plan).toEqual([]);
      const [pool, monitor] = p.bands;
      expect(pool, plan).toMatchObject({ name: "ETIMEDOUT", from: { socket: "pool", event: "last-received" } });
      // one reply 10 s after the request, then the write-off 40 s after that reply
      expect(monitor, plan).toMatchObject({ name: "MongoNetworkTimeoutError", from: { socket: "monitor", event: "last-received" }, low: { value: 49.999 } });
      expect(monitor!.high.value, plan).toBeLessThan(50.04);
    }
  });

  it("counts a forgotten flow from the client's delayed ACK of the last reply", () => {
    const both = T03_MONGO.find((each) => each.spec.plan === "T03.border-off.8")!.prediction;
    expect(both.bands[0]).toMatchObject({ name: "ECONNRESET", low: { value: 12 } });
    // 12 s, the listing of the router, and an ACK at most 40 ms and a jiffy late
    expect(both.bands[0]!.high.value).toBeCloseTo(12.09 + 0.04 + 1 / HZ, 6);
  });

  it("gives the group cells of T11 their stages, and no failover to a cut that keeps the majority", () => {
    for (const cell of T11_MONGO) expect(cell.prediction.group, cell.name).toBeDefined();
    const partial = T11_MONGO.find((each) => each.spec.plan === "T11.defaults.11" && each.spec.at?.cuts === "one")!.prediction;
    expect(partial.group).toMatchObject({ lands: "same", failover: false });
    const loss = T11_MONGO.find((each) => each.spec.plan === "T11.defaults.9")!.prediction;
    expect(loss.group!.stages.map((s) => s.stage)).toEqual([
      "member-down",
      "election-start",
      "elected",
      "caught-up",
      "writable",
      "old-primary-steps-down",
      "discovered",
      "written-off",
      "first-write",
    ]);
    const w1 = T11_MONGO.find((each) => each.spec.plan === "T11.border-off.66")!.prediction;
    expect(w1.group!.lost.low).toBeGreaterThan(0);
  });
});
