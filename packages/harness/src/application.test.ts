import { describe, expect, it } from "vitest";
import { callOf, exitOf, reconnectFinding } from "./application.ts";
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
      socket: "global",
      heartbeat: { interval: ms(2000), timeout: ms(1000), misses: 1 },
      reconnect: { initialDelay: ms(500), multiplier: 2, maxDelay: ms(4000), attempts: 10, jitter: 0 },
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

  it("tells a close frame that leaves the socket ESTABLISHED from a close that takes it out at once", () => {
    const frame: Cell = { ...HEARTBEAT, prediction: { ...HEARTBEAT.prediction, drop: "frame" } as Cell["prediction"] };
    const close: Cell = { ...HEARTBEAT, prediction: { ...HEARTBEAT.prediction, drop: "close" } as Cell["prediction"] };
    // the global WebSocket: a close frame, and the socket stays ESTABLISHED to the end of the run
    expect(measure(frame, run(client, kernel))).toMatchObject({ outcome: { kind: "dropped" }, left: null, finding: null });
    expect(measure(close, run(client, kernel)).finding).toBe(
      "the program did not close its socket after the drop, where a close is at once",
    );
    // the WebSocket of ws: terminate() destroys the socket, a FIN 0.3 ms after the drop line, and no write
    const terminated = [...kernel.filter((record) => record.mono !== D + 30_000), state(D + 300_000, 1, 4)];
    const read = measure(close, run(client, terminated));
    expect(read).toMatchObject({ outcome: { kind: "dropped" }, elapsed: s(1.001775), left: s(0.0003), finding: null });
    expect(measure(frame, run(client, terminated)).finding).toBe("the drop wrote no close frame on its socket");
    expect(verdictOf(close.prediction, [read]).why).toContain("After the drop, the program closed its socket in 1 runs, median 0.3 ms after its drop line.");
    // a peer that answers the close frame and closes its side: a FIN of the peer, not a close by the program
    const answered = [...kernel, state(D + 6_200_000, 1, 8)];
    expect(measure(frame, run(client, answered))).toMatchObject({ left: null, finding: null });
    expect(measure(close, run(client, answered)).finding).toBe("the program did not close its socket after the drop, where a close is at once");
    // a socket that left ESTABLISHED later than the noise did not leave at once
    const late = [...kernel.filter((record) => record.mono !== D + 30_000), state(D + 520_000_000, 1, 4)];
    expect(measure(close, run(client, late)).finding).toBe("the program closed its socket 0.52 s after the drop, not at once");
  });

  it("tells a close by the program from the end of the client process, for a prediction that says the client exits", () => {
    const frame = { ...HEARTBEAT, prediction: { ...HEARTBEAT.prediction, drop: "frame" } } as Cell;
    const close = { ...HEARTBEAT, prediction: { ...HEARTBEAT.prediction, drop: "close" } } as Cell;
    const exits = (cell: Cell): Cell => ({ ...cell, prediction: { ...cell.prediction, exits: true } as Cell["prediction"] });
    // the run ends 20 ms after the try: the process ends, and its kernel closes the new socket and the old one at one instant
    const X = G + 20_000_000;
    const fresh = { src: "172.21.0.3:59240" };
    const ending = [...kernel, k("state", X, { ...fresh, cookie: NEW, old: 1, new: 4 } as Partial<KernelRecord>), state(X + 90_000, 1, 4)];
    expect(exitOf(run(client, ending), OLD)).toBe(X);
    // without the flag, the end of the process is a close by the program, as before
    expect(measure(frame, run(client, ending))).toMatchObject({ left: s(0.52119), finding: null });
    expect(measure(frame, run(client, ending))).not.toHaveProperty("exited");
    // with it, the global WebSocket did not close its socket: the kernel closed it at the end of the process
    const read = measure(exits(frame), run(client, ending));
    expect(read).toMatchObject({ outcome: { kind: "dropped" }, left: null, exited: s(0.52119), finding: null });
    const verdict = verdictOf(exits(frame).prediction, [read]);
    expect(verdict.left).toMatchObject({ spread: null, stayed: 1, exited: { count: 1, median: s(0.52119) } });
    expect(verdict.why).toContain(
      "After the drop, the program closed its socket in 0 runs, median none after its drop line, and it did not close it in 1: in 1 the socket stayed open until the client process ended, median 521.19 ms after the drop line.",
    );
    // a prediction of a close at once finds that the program left the socket to the end of the process
    expect(measure(exits(close), run(client, ending)).finding).toBe(
      "the program did not close its socket after the drop, where a close is at once: it stayed open until the client process ended",
    );
    // the WebSocket of ws: terminate() closes the socket 0.3 ms after the drop, long before the end of the process
    const terminated = [...kernel.filter((record) => record.mono !== D + 30_000), state(D + 300_000, 1, 4), k("state", X, { ...fresh, cookie: NEW, old: 1, new: 4 } as Partial<KernelRecord>)];
    expect(measure(exits(close), run(client, terminated))).toMatchObject({ left: s(0.0003), finding: null });
    expect(measure(exits(close), run(client, terminated))).not.toHaveProperty("exited");
    // a record with no end of the process after the last try keeps the close as it is
    expect(exitOf(run(client, kernel), OLD)).toBeUndefined();
    expect(measure(exits(frame), run(client, [...kernel, state(X + 90_000, 1, 4)]))).toMatchObject({ left: s(0.52119) });
  });

  it("does not take the drop of a try that never opened for the drop of the connection of the run", () => {
    // a failed try: its socket has no local address, and its drop line says null
    const failed = [...client.filter((line) => line.ev !== "drop"), { ev: "drop", t: D, conn: 2, local: null }];
    expect(measure(HEARTBEAT, run(failed, kernel)).outcome).toEqual({ kind: "silent" });
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

  it("names the connection of a server behind a router by the peer of its socket: the address of the router", () => {
    const ROUTER = "172.22.0.2:59222";
    const server: Cell = {
      ...HEARTBEAT,
      name: "W3",
      observer: "server",
      prediction: { detects: true, timer: "heartbeat", errno: "DROPPED", from: "ping-sent", low: s(11.98), high: s(12.02) },
    };
    const at = (ev: string, mono: number, more: Partial<KernelRecord> = {}): KernelRecord =>
      k(ev, mono, { netns: NETNS + 1, cookie: 9184, src: SERVER, dst: ROUTER, ...more });
    // a ping before the forget gets its pong. The router forgets the flow, and the next two pings get nothing
    const B = T + 1_200_000_000;
    const lines: ProbeEvent[] = [
      { ev: "accepted", t: T - 2_100_000, peer: ROUTER },
      { ev: "ping", t: B, peer: ROUTER },
      { ev: "ping", t: B + 6_000_400_000, peer: ROUTER },
      { ev: "ping", t: B + 12_000_900_000, peer: ROUTER },
      { ev: "drop", t: B + 18_001_300_000, peer: ROUTER },
    ];
    const records = [
      ...kernel.slice(0, 1),
      // the socket of the server, ESTABLISHED with the router as its peer
      at("state", T - 2_050_000, { old: 2, new: 1 } as Partial<KernelRecord>),
      at("rx", T - 1_450_000, data(30)),
      at("tx", B + 30_000, data(2)),
      at("rx", B + 400_000, data(6)),
      at("tx", B + 6_000_430_000, data(2)),
      at("tx", B + 12_000_930_000, data(2)),
      at("state", B + 18_001_350_000, { old: 1, new: 4 } as Partial<KernelRecord>),
    ];
    const topology = { targetPeer: "172.22.0.2", hops: { nat: { netns: NETNS + 2, client: "172.21.0.3", target: SERVER } } };
    const read = measure(server, run(client.slice(0, 4), records, { server: lines, topology, fault: null }));
    // the first ping without an answer is the second one, and the drop comes two beats after it
    expect(read).toMatchObject({ outcome: { kind: "dropped" }, elapsed: s(12.00092), socket: s(12.0009), steps: [s(6.0005)], finding: null });
    // a line that names the client's own address does not match the socket of the server behind the router
    const named = lines.map((line) => ("peer" in line ? { ...line, peer: LOCAL } : line));
    expect(measure(server, run(client.slice(0, 4), records, { server: named, topology, fault: null })).outcome).not.toEqual({ kind: "dropped" });
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

  it("times the reconnect of a measurement-only cell after the end of its connection, which has no band", () => {
    // a proxy closes the idle connection at its own timeout: a FIN 5 s after the reply, and the client tries again
    const F = T + 5_000_400_000;
    const closing: Cell = {
      ...HEARTBEAT,
      fault: "proxy-idle",
      prediction: {
        detects: null,
        window: s(10),
        why: "the proxy has no machine document",
        from: "last-received",
        reconnects: { waits: [{ low: s(0.499), high: s(0.5021) }] },
      },
    };
    const lines: ProbeEvent[] = [
      ...client.slice(0, 4),
      { ev: "eof", t: F + 300_000, local: LOCAL },
      { ev: "reconnecting", t: F + 400_000, attempt: 1 },
      { ev: "dial", t: F + 501_300_000, conn: 2 },
    ];
    const records = [k("rx", T - 50_000, data(40)), state(F, 1, 8), state(F + 503_000_000, 7, 2, NEW), state(F + 503_300_000, 2, 1, NEW)];
    const read = measure(closing, run(lines, records, { fault: null }));
    expect(read).toMatchObject({ outcome: { kind: "eof" }, elapsed: s(5.00045), void: null, finding: null });
    expect(read.reconnect).toEqual({ waits: [s(0.5009)], syn: s(0.503), established: s(0.5033), connects: [s(0.0017)] });
    const verdict = verdictOf(closing.prediction, [read]);
    expect(verdict).toMatchObject({ decision: "measured", outside: [] });
    expect(verdict.why).toContain("Reconnect: the waits before each try, median 500.9 ms");
    // a wait outside its band is a finding of its run, and the verdict names that run
    const slow = lines.map((line) => (line.ev === "dial" ? { ...line, t: F + 521_300_000 } : line));
    const late = measure(closing, run(slow, records, { fault: null }));
    expect(late.finding).toBe("its wait before try 1 was 0.5209 s, outside [0.495, 0.5061] s");
    expect(verdictOf(closing.prediction, [late])).toMatchObject({ decision: "measured", outside: [{ why: late.finding }] });
    // without the bands of the reconnect, the cell measures as it did before them
    const plain = { ...closing, prediction: { detects: null, window: s(10), why: "the proxy has no machine document", from: "last-received" } } as Cell;
    expect(measure(plain, run(lines, records, { fault: null }))).not.toHaveProperty("reconnect");
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
