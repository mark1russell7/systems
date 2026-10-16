import { describe, expect, it } from "vitest";
import { callOf, reconnectFinding } from "./application.ts";
import type { Cell, KernelRecord, ProbeEvent, Run } from "./cell.ts";
import { measure } from "./observe.ts";
import { verdictOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const ms = (value: number) => ({ value, unit: "ms" });
const NETNS = 4026532583;
const LOCAL = "172.21.0.3:59222";
const SERVER = "172.21.0.2:8080";
const OLD = 2747400;
const NEW = 2747512;

/** a cell of the WebSocket client: its heartbeat drops a silent connection 1 s after a ping, and it reconnects 0.5 s later */
const HEARTBEAT: Cell = {
  name: "W1",
  target: { image: "node:24.21.0-alpine", harness: "procedures", port: 8080, ready: '"ev":"listening"' },
  client: "procedures-ws",
  sysctls: {},
  probe: {
    mode: "idle",
    keepalive: false,
    ws: {
      heartbeat: { interval: ms(2000), timeout: ms(1000) },
      reconnect: { initialDelay: ms(500), multiplier: 2, maxDelay: ms(4000), attempts: 10 },
      requestTimeout: ms(60_000),
      connectionTimeout: ms(10_000),
    },
  },
  fault: "blackhole",
  prediction: {
    detects: true,
    timer: "pong",
    errno: "DROPPED",
    from: "ping-sent",
    low: s(0.998),
    high: s(1.004),
    reconnects: { waits: [{ low: s(0.499), high: s(0.5021) }] },
  },
  runs: 11,
  environments: 2,
};

/** a kernel record on a socket of the client, as the prober writes it */
const k = (ev: string, mono: number, more: Partial<KernelRecord> = {}): KernelRecord => ({
  ev,
  mono,
  cookie: OLD,
  netns: NETNS,
  src: LOCAL,
  dst: SERVER,
  err: 0,
  ...more,
});
const data = (bytes: number) => ({ seg: { seq: 1, len: { value: bytes, unit: "B" } } });
const state = (mono: number, from: number, to: number, cookie = OLD): KernelRecord =>
  k("state", mono, { cookie, old: from, new: to } as Partial<KernelRecord>);
const timer = (mono: number, behind: number): KernelRecord =>
  k("timer", mono, { what: "retransmit", behind: { value: behind, unit: "jiffy" }, late: { value: behind, unit: "jiffy" } });
const run = (events: ProbeEvent[], kernel: KernelRecord[], more: Partial<Run> = {}): Run => ({
  environment: 0,
  index: 0,
  events,
  fault: { t0: T + 300e6, t1: T + 304e6 },
  kernel,
  netns: NETNS,
  targetNetns: NETNS + 1,
  lost: 0,
  ...more,
});

const T = 321_053_839_197_766; // the reply of the first call, on this machine's clock
const P = T + 2_000_000_000; // the first ping after the fault: the heartbeat's interval after the open
const D = P + 1_001_500_000; // the drop: the pong timeout, 1.5 ms late
const R = D + 200_000; // the start of the reconnect timer
const G = R + 500_900_000; // the try: the reconnect delay, 0.9 ms late
const client: ProbeEvent[] = [
  { ev: "dial", t: T - 3_000_000, conn: 1 },
  { ev: "connected", t: T - 2_000_000, conn: 1, local: LOCAL },
  { ev: "sent", t: T - 1_500_000 },
  { ev: "ready", t: T, reply: '{"ok":true}' },
  // a ping before the fault, and its pong
  { ev: "ping", t: T + 100_000_000, conn: 1, local: LOCAL },
  { ev: "ping", t: P, conn: 1, local: LOCAL },
  { ev: "drop", t: D, conn: 1, local: LOCAL },
  { ev: "status", t: D + 100_000, status: "disconnected", reason: "Heartbeat timeout" },
  { ev: "reconnecting", t: R, attempt: 1 },
  { ev: "dial", t: G, conn: 2 },
  { ev: "connected", t: G + 3_000_000, conn: 2, local: "172.21.0.3:59240" },
];
const kernel: KernelRecord[] = [
  k("rx", T - 50_000, data(40)),
  k("tx", T + 100_020_000, data(47)),
  k("rx", T + 100_150_000, data(40)),
  // the ping into the black hole: its write, its loss probe, its retransmissions
  k("tx", P + 25_000, data(47)),
  timer(P + 204_100_000, 0),
  k("retrans", P + 204_200_000, { why: "tlp" }),
  timer(P + 408_100_000, 0),
  k("retrans", P + 408_200_000, { why: "rto" }),
  timer(P + 816_100_000, 0),
  k("retrans", P + 816_200_000, { why: "rto" }),
  // the close frame of the drop
  k("tx", D + 30_000, data(6)),
  // the new socket of the reconnect
  state(G + 2_000_000, 7, 2, NEW),
  state(G + 2_300_000, 2, 1, NEW),
];

describe("a detection by the program of the observer, from its lines and the kernel's records", () => {
  it("times a heartbeat from the write of its first ping without an answer to the write of its close frame", () => {
    const read = measure(HEARTBEAT, run(client, kernel));
    expect(read).toMatchObject({
      outcome: { kind: "dropped" },
      // the kernel's stamps: the write of the ping and the write of the close frame
      elapsed: s(1.001505),
      // the program's own stamps: its ping line and its drop line
      socket: s(1.0015),
      noticed: null,
      steps: [],
      void: null,
      finding: null,
    });
    // the wait of the reconnect timer, and the kernel's view from the detection
    expect(read.reconnect).toEqual({
      waits: [s(0.5009)],
      syn: s(0.50307),
      established: s(0.50337),
      connects: [s(0.002)],
    });
    const verdict = verdictOf(HEARTBEAT.prediction, [read]);
    expect(verdict).toMatchObject({ decision: "holds", outside: [] });
    expect(verdict.reconnect?.waits[0]?.median).toEqual(s(0.5009));
    expect(verdict.why).toContain("Reconnect: the waits before each try, median 500.9 ms; the first SYN median 503.07 ms");
  });

  it("lets the kernel win when its report comes before the drop, and the drop win when it comes first", () => {
    // the give-up of the kernel 0.9 s after the ping: the transport never dropped the socket
    const giveUp = [...kernel.filter((record) => record.mono < D), k("error", P + 900_000_000, { err: 110 })];
    const early = client.filter((line) => line.t < D);
    const read = measure(HEARTBEAT, run([...early, { ev: "error", t: P + 900_300_000, errno: "ETIMEDOUT", local: LOCAL }], giveUp));
    expect(read).toMatchObject({ outcome: { kind: "error", errno: "ETIMEDOUT" }, elapsed: s(0.899975), socket: s(0.9003) });
    expect(read.finding).toBe("it ended with ETIMEDOUT, not DROPPED. the client made no try 1 after the detection");
    // a report of the kernel after the drop is the end of an abandoned socket, not the detection
    const later = measure(HEARTBEAT, run(client, [...kernel, k("error", D + 90e9, { err: 110 })]));
    expect(later).toMatchObject({ outcome: { kind: "dropped" }, elapsed: s(1.001505), finding: null });
  });

  it("takes the first ping that got no answer, wherever the fault fell", () => {
    // the pong of the ping before the fault never came: that ping started the wait that fired
    const lost = kernel.filter((record) => record.mono !== T + 100_150_000);
    const read = measure({ ...HEARTBEAT, prediction: { ...HEARTBEAT.prediction, low: s(2.9), high: s(3.1) } as Cell["prediction"] }, run(client, lost));
    expect(read.elapsed).toEqual(s(2.90151));
    expect(read.steps).toEqual([s(1.900005)]);
  });

  it("finds a drop where nothing should detect the fault, and a wait of the reconnect outside its band", () => {
    const silent: Cell = { ...HEARTBEAT, prediction: { detects: false, window: s(20) } };
    expect(measure(silent, run(client, kernel)).finding).toMatch(/^detected after 3\.0015\d* s, where nothing should$/);
    const slow = client.map((line) => (line.ev === "dial" && line["conn"] === 2 ? { ...line, t: G + 20_000_000 } : line));
    expect(measure(HEARTBEAT, run(slow, kernel)).finding).toBe("its wait before try 1 was 0.5209 s, outside [0.495, 0.5061] s");
    expect(reconnectFinding({ waits: [{ low: s(0.5), high: s(0.5) }, { low: s(1), high: s(1) }] }, { waits: [s(0.5)], syn: null, established: null, connects: [] })).toBe(
      "the client made no try 2 after the detection",
    );
  });

  it("voids a heartbeat whose ping's retransmit timer ran behind its wheel slot: the VM stopped", () => {
    const stalled = kernel.map((record) => (record.ev === "timer" && record.mono === P + 408_100_000 ? timer(record.mono, 3) : record));
    expect(measure(HEARTBEAT, run(client, stalled)).void).toBe(
      "its retransmit timer ran 3 jiffies behind its wheel slot: the VM delayed it, not the kernel",
    );
  });

  it("times the heartbeat of a server from its lines and its socket: a terminate is a close", () => {
    const server: Cell = {
      ...HEARTBEAT,
      name: "W2",
      observer: "server",
      prediction: { detects: true, timer: "heartbeat", errno: "DROPPED", from: "ping-sent", low: s(1.99), high: s(2.01) },
    };
    const at = (ev: string, mono: number, more: Partial<KernelRecord> = {}): KernelRecord =>
      k(ev, mono, { netns: NETNS + 1, cookie: 9183, src: SERVER, dst: LOCAL, ...more });
    const lines: ProbeEvent[] = [
      { ev: "accepted", t: T - 2_100_000, peer: LOCAL },
      { ev: "ping", t: P, peer: LOCAL },
      { ev: "ping", t: P + 1_000_400_000, peer: LOCAL },
      { ev: "drop", t: P + 2_000_900_000, peer: LOCAL },
    ];
    const records = [
      ...kernel.slice(0, 1),
      at("rx", T - 1_450_000, data(30)),
      at("tx", P + 30_000, data(2)),
      at("tx", P + 1_000_430_000, data(2)),
      { ...state(P + 2_000_950_000, 1, 4), netns: NETNS + 1, cookie: 9183, src: SERVER, dst: LOCAL },
    ];
    const read = measure(server, run(client.slice(0, 4), records, { server: lines }));
    expect(read).toMatchObject({ outcome: { kind: "dropped" }, elapsed: s(2.00092), socket: s(2.0009), steps: [s(1.0004)], finding: null });
  });

  it("times the stall of an idle client from its first ping into it, and finds a drop before the recovery", () => {
    const stall: Cell = {
      ...HEARTBEAT,
      fault: "stall",
      stall: s(1),
      prediction: { detects: false, window: s(5), recovers: { firing: 3, low: s(1.616), high: s(1.706), heal: { low: s(0.856), high: s(1.616) } } },
    };
    const records = [
      ...kernel.filter((record) => record.mono <= P + 25_000),
      k("retrans", P + 204_200_000, { why: "tlp" }),
      k("retrans", P + 408_200_000, { why: "rto" }),
      k("retrans", P + 816_200_000, { why: "rto" }),
      k("retrans", P + 1_632_200_000, { why: "rto" }),
      // the pong, a round trip after the retransmission that got through
      k("rx", P + 1_632_300_000, data(40)),
    ];
    const lines = client.filter((line) => line.t <= P);
    const healed = run(lines, records, { heal: { t0: P + 1_000_000_000, t1: P + 1_002_500_000 } });
    expect(measure(stall, healed)).toMatchObject({
      outcome: { kind: "answered" },
      elapsed: s(1.6323),
      steps: [s(0.2042), s(0.4082), s(0.8162), s(1.6322)],
      void: null,
      finding: null,
    });
    // the heartbeat that dropped the connection before the pong came back is a finding
    const dropped = run([...lines, { ev: "drop", t: P + 1_500_000_000, conn: 1, local: LOCAL }], [...records, k("tx", P + 1_500_030_000, data(6))], {
      heal: { t0: P + 1_000_000_000, t1: P + 1_002_500_000 },
    });
    expect(measure(stall, dropped)).toMatchObject({ outcome: { kind: "dropped" }, finding: "detected after 1.50003 s, where it should recover" });
  });

  it("reads the call in flight: its error, and its time from the detection", () => {
    const request = { ev: "sent", t: T + 400_000_000 };
    const lines = [request, { ev: "call-error", t: D + 150_000, code: "Error", message: "WebSocket connection closed" }];
    expect(callOf(lines, request, D)).toEqual({ outcome: "WebSocket connection closed", after: s(0.00015) });
    expect(callOf([request], request, D)).toEqual({ outcome: "pending", after: null });
    const inflight: Cell = { ...HEARTBEAT, probe: { ...HEARTBEAT.probe, mode: "inflight" } };
    const read = measure(inflight, run([...client.slice(0, 4), request, ...client.slice(4), lines[1]!], kernel));
    expect(read.call).toEqual({ outcome: "WebSocket connection closed", after: s(0.00012) });
    expect(verdictOf(inflight.prediction, [read]).why).toContain("Calls in flight: 1 WebSocket connection closed.");
  });
});
