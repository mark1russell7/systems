import { describe, expect, it } from "vitest";
import type { Cell, KernelRecord, ProbeEvent, Run } from "./cell.ts";
import { measure } from "./observe.ts";
import { verdictOf } from "./verdict.ts";

const s = (value: number) => ({ value, unit: "s" });
const NETNS = 4026532583;
const LOCAL = "172.21.0.3:59222";
const KEEPALIVE: Cell = {
  name: "Q1",
  target: { image: "redis:7.4", port: 6379, ready: "Ready to accept connections" },
  sysctls: {},
  probe: { mode: "idle", keepalive: true },
  fault: "blackhole",
  prediction: {
    detects: true,
    timer: "keepalive",
    errno: "ETIMEDOUT",
    from: "last-received",
    low: s(10.996),
    high: s(11.352),
  },
  runs: 11,
  environments: 2,
};
const IN_FLIGHT: Cell = {
  ...KEEPALIVE,
  name: "Q2",
  probe: { mode: "inflight", keepalive: true },
  prediction: {
    ...(KEEPALIVE.prediction as Extract<Cell["prediction"], { detects: true }>),
    timer: "retrans_giveup",
    from: "first-retransmission",
  },
};

/** a kernel record on the run's socket, as the prober writes it */
const k = (ev: string, mono: number, more: Partial<KernelRecord> = {}): KernelRecord => ({
  ev,
  mono,
  cookie: 2747400,
  netns: NETNS,
  src: LOCAL,
  dst: "172.21.0.2:6379",
  err: 0,
  ...more,
});
const retrans = (mono: number, why: "tlp" | "rto", retransmits: number) =>
  k("retrans", mono, {
    why,
    tcp: {
      retransmits,
      pending: why === "tlp" ? 5 : 0,
      backoff: retransmits,
      probes_out: 0,
      rto: { value: 51 * 2 ** retransmits, unit: "jiffy" },
      srtt: { value: 116, unit: "us" },
    },
  });
const run = (
  events: ProbeEvent[],
  kernel: KernelRecord[],
  fault: Run["fault"],
  lost: number | null = 0,
): Run => ({
  environment: 0,
  index: 0,
  events,
  fault,
  kernel,
  netns: NETNS,
  targetNetns: NETNS + 1,
  lost,
});

const T = 321_053_839_197_766; // the reply's arrival, on this machine's clock
const client: ProbeEvent[] = [
  { ev: "connected", t: T - 2_000_000, local: LOCAL },
  { ev: "sent", t: T - 1_500_000 },
  { ev: "ready", t: T, reply: "+PONG\r\n" },
];
const reply = [
  k("rx", T - 1_400_000),
  k("rx", T - 50_000, { seg: { seq: 1, len: { value: 7, unit: "B" } } }),
];

describe("a run measured against its cell, from the kernel's own records", () => {
  it("times keepalive from the last segment received, and keeps each probe as a step", () => {
    const kernel = [
      ...reply,
      k("probe", T + 5_013_000_000, { what: "keepalive" }),
      k("probe", T + 7_029_000_000, { what: "keepalive" }),
      k("probe", T + 9_045_000_000, { what: "keepalive" }),
      k("rst_tx", T + 11_060_900_000, { active: true }),
      k("error", T + 11_061_000_000, { err: 110 }),
    ];
    const events = [...client, { ev: "error", t: T + 11_061_100_000, errno: "ETIMEDOUT" }];
    const read = measure(KEEPALIVE, run(events, kernel, { t0: T + 125e6, t1: T + 129e6 }));
    expect(read).toMatchObject({
      outcome: { kind: "error", errno: "ETIMEDOUT" },
      // from the reply's arrival in the kernel, 50 µs before the client read it
      elapsed: s(11.06105),
      socket: s(11.0611),
      noticed: s(0.0001),
      probes: 3,
      void: null,
      finding: null,
    });
    expect(read.steps).toEqual([s(5.01305), s(7.02905), s(9.04505)]);
  });

  it("voids a run whose own timer the VM delayed behind its wheel slot", () => {
    const timer = (mono: number, behind: number, what: "keepalive" | "retransmit" = "keepalive") =>
      k("timer", mono, {
        what,
        behind: { value: behind, unit: "jiffy" },
        late: { value: 6 + behind, unit: "jiffy" },
      });
    const kernel = (behind: number) => [
      ...reply,
      // the retransmit timer's idle firing after the reply moves no keepalive, however late
      timer(T + 204_000_000, 9, "retransmit"),
      timer(T + 5_012_990_000, 0),
      k("probe", T + 5_013_000_000, { what: "keepalive" }),
      timer(T + 7_028_990_000, behind),
      k("probe", T + 7_029_000_000, { what: "keepalive" }),
      k("error", T + 11_061_000_000, { err: 110 }),
    ];
    const events = [...client, { ev: "error", t: T + 11_061_100_000, errno: "ETIMEDOUT" }];
    const fault = { t0: T + 125e6, t1: T + 129e6 };
    // on its slot: the kernel's own timing, rounding and all; a tick that turned while the wheel
    // ran is within the pipeline's noise
    expect(measure(KEEPALIVE, run(events, kernel(0), fault)).void).toBeNull();
    expect(measure(KEEPALIVE, run(events, kernel(1), fault)).void).toBeNull();
    expect(measure(KEEPALIVE, run(events, kernel(2), fault)).void).toBe(
      "its keepalive timer ran 2 jiffies behind its wheel slot: the VM delayed it, not the kernel",
    );
    // on its slot, but with its socket in its owner's hands: it put itself off by HZ/20
    const held = kernel(0).map((record) =>
      record.ev === "timer" && record.what === "keepalive" && record.mono > T + 7e9
        ? { ...record, owned: true }
        : record,
    );
    expect(measure(KEEPALIVE, run(events, held, fault)).void).toBe(
      "its keepalive timer found the socket held by its owner and put itself off by HZ/20: the run measured the owner, not the timer",
    );
  });

  it("times the give-up from the RTO timer's first retransmission, never the tail loss probe", () => {
    const sent = T + 300_000_000;
    const kernel = [
      ...reply,
      retrans(sent + 205_600_000, "tlp", 0),
      retrans(sent + 414_400_000, "rto", 1),
      retrans(sent + 850_600_000, "rto", 2),
      retrans(sent + 1_681_800_000, "rto", 3),
      retrans(sent + 3_346_300_000, "rto", 4),
      k("error", sent + 6_833_500_000, { err: 113 }),
    ];
    const events = [...client, { ev: "sent", t: sent }];
    const read = measure(IN_FLIGHT, run(events, kernel, { t0: T + 100e6, t1: T + 104e6 }));
    expect(read.elapsed).toEqual(s(6.4191));
    expect(read.steps).toEqual([s(0.4362), s(1.2674), s(2.9319)]);
    expect(read.retransmissions).toBe(5);
    expect(read.finding).toBe("it ended with EHOSTUNREACH, not ETIMEDOUT");
    // a fault that held only after the request went out cannot count
    expect(measure(IN_FLIGHT, run(events, kernel, { t0: sent + 1e6, t1: sent + 5e6 })).void).toBe(
      "the request went out before the fault held",
    );
    // a retransmission of the RTO timer before the fault held, the SYN of a connect, is not the reference
    const syn = measure(IN_FLIGHT, run(events, [retrans(T - 2_400_000, "rto", 0), ...kernel], { t0: T + 100e6, t1: T + 104e6 }));
    expect(syn.elapsed).toEqual(s(6.4191));
    expect(syn.steps).toEqual([s(0.4362), s(1.2674), s(2.9319)]);
  });

  it("times a stall's recovery from the send to the first segment back after it ended", () => {
    const stall: Cell = {
      ...IN_FLIGHT,
      name: "Q4",
      fault: "stall",
      stall: s(1),
      prediction: {
        detects: false,
        window: s(20),
        recovers: {
          firing: 3,
          low: s(1.617),
          high: s(1.705),
          heal: { low: s(0.856), high: s(1.616) },
        },
      },
    };
    const sent = T + 300_000_000;
    const kernel = [
      ...reply,
      retrans(sent + 208_000_000, "tlp", 0),
      retrans(sent + 416_000_000, "rto", 1),
      retrans(sent + 832_000_000, "rto", 2),
      retrans(sent + 1_664_000_000, "rto", 3),
      // the server's answer to the retransmission that got through, a round trip later
      k("rx", sent + 1_664_300_000, { seg: { seq: 8, len: { value: 7, unit: "B" } } }),
    ];
    const events = [
      ...client,
      { ev: "sent", t: sent },
      { ev: "data", t: sent + 1_664_500_000, n: 7 },
    ];
    const healed = (at: number): Run => ({
      ...run(events, kernel, { t0: T + 100e6, t1: T + 104e6 }),
      heal: { t0: sent + at, t1: sent + at + 2_500_000 },
    });
    expect(measure(stall, healed(1_000_000_000))).toMatchObject({
      outcome: { kind: "answered" },
      elapsed: s(1.6643),
      socket: s(1.6645),
      noticed: s(0.0002),
      steps: [s(0.208), s(0.416), s(0.832), s(1.664)],
      void: null,
      finding: null,
    });
    // a stall that ended where an earlier firing could have met it does not test this one
    expect(measure(stall, healed(800_000_000)).void).toBe(
      "the stall ended 0.8–0.8025 s after the send, outside the 0.856–1.616 s its prediction assumed",
    );
    // and a connection that never moved again is a finding
    const lost = { ...healed(1_000_000_000), kernel: kernel.slice(0, -1) };
    expect(measure(stall, lost).finding).toBe(
      "it never moved again: nothing came back after the stall ended",
    );
  });

  it("calls a run silent when nothing ended the wait, and counts the ACKs a frozen kernel sent", () => {
    const frozen: Cell = {
      ...IN_FLIGHT,
      fault: "freeze-process",
      prediction: { detects: false, window: s(20) },
    };
    const sent = T + 400_000_000;
    const kernel = [
      ...reply,
      k("rx", sent + 48_000_000),
      k("probe", sent + 5_050_000_000, { what: "keepalive" }),
      k("rx", sent + 5_052_000_000),
      k("rx", sent + 10_164_000_000),
    ];
    const events = [...client, { ev: "sent", t: sent }, { ev: "data", t: sent + 20_047_000_000 }];
    expect(measure(frozen, run(events, kernel, null))).toMatchObject({
      outcome: { kind: "silent" },
      elapsed: null,
      acks: 3,
      finding: null,
    });
    const reset = [...kernel, k("error", sent + 9_000_000_000, { err: 104 })];
    expect(measure(frozen, run(events, reset, null))).toMatchObject({
      outcome: { kind: "error", errno: "ECONNRESET" },
      finding: "detected after 9 s, where nothing should",
    });
  });

  it("voids a run the prober lost records of, or saw nothing of, or whose fault landed too late", () => {
    const kernel = [
      ...reply,
      k("probe", T + 5e9, { what: "keepalive" }),
      k("error", T + 11e9, { err: 110 }),
    ];
    expect(measure(KEEPALIVE, run(client, kernel, null, 3)).void).toBe(
      "the prober dropped 3 records",
    );
    // and when no clock line came after the run, nothing says whether it dropped any
    expect(measure(KEEPALIVE, run(client, kernel, null, null)).void).toBe(
      "the prober wrote no clock line after the run, so nothing says what it dropped",
    );
    const elsewhere = kernel.map((record) => ({ ...record, src: "172.21.0.3:40000" }));
    expect(measure(KEEPALIVE, run(client, elsewhere, null)).void).toBe(
      "the prober saw nothing of this connection",
    );
    expect(measure(KEEPALIVE, run(client, kernel, { t0: T + 6e9, t1: T + 6e9 + 4e6 })).void).toBe(
      "a keepalive probe went out before the fault held",
    );
    expect(measure(KEEPALIVE, run(client.slice(0, 2), kernel, null)).void).toBe(
      "the client never had its reply",
    );
  });

  it("finds a detector that never fired", () => {
    expect(measure(KEEPALIVE, run(client, reply, null)).finding).toBe(
      "nothing detected it: keepalive never fired",
    );
  });

  it("times the server's own keepalive on its socket for the client's connection, in its namespace", () => {
    // Redis at tcp-keepalive 5: the client's PING is the last segment its socket received, then 3
    // probes a second apart, and the server's kernel gives up
    const SERVER: Cell = { ...KEEPALIVE, name: "server Q1", observer: "server" };
    const at = (ev: string, mono: number, more: Partial<KernelRecord> = {}): KernelRecord =>
      k(ev, mono, {
        netns: NETNS + 1,
        cookie: 9182,
        src: "172.21.0.2:6379",
        dst: LOCAL,
        ...more,
      });
    const kernel = [
      ...reply,
      at("rx", T - 1_450_000),
      at("probe", T + 5_013_000_000, { what: "keepalive" }),
      at("probe", T + 6_029_000_000, { what: "keepalive" }),
      at("probe", T + 7_045_000_000, { what: "keepalive" }),
      at("error", T + 8_061_000_000, { err: 110 }),
    ];
    const read = measure(SERVER, run(client, kernel, { t0: T + 125e6, t1: T + 129e6 }));
    expect(read).toMatchObject({
      outcome: { kind: "error", errno: "ETIMEDOUT" },
      elapsed: s(8.06245),
      socket: null,
      noticed: null,
      probes: 3,
      void: null,
    });
    // the client's own socket, in its own namespace, is not the server's
    expect(measure(KEEPALIVE, run(client, kernel, null)).probes).toBe(0);
  });

  it("times the server's give-up on a reply in flight, from its RTO's first retransmission", () => {
    // the client's BLPOP reaches Redis, the fault lands, and Redis's reply goes into it
    const SERVER: Cell = { ...IN_FLIGHT, name: "server Q2", observer: "server" };
    const sent = T + 2e9;
    // the server's socket for the connection, in the target's namespace
    const server = { netns: NETNS + 1, cookie: 9183, src: "172.21.0.2:6379", dst: LOCAL };
    const at = (ev: string, mono: number, more: Partial<KernelRecord> = {}): KernelRecord =>
      k(ev, mono, { ...server, ...more });
    const kernel = [
      ...reply,
      at("rx", sent + 150_000),
      { ...retrans(sent + 2_205_000_000, "tlp", 0), ...server },
      { ...retrans(sent + 2_414_000_000, "rto", 1), ...server },
      { ...retrans(sent + 2_830_000_000, "rto", 2), ...server },
      at("error", sent + 8_700_000_000, { err: 110 }),
    ];
    const events: ProbeEvent[] = [...client, { ev: "sent", t: sent }];
    const fault = { t0: sent + 300e6, t1: sent + 304e6 };
    const read = measure(SERVER, run(events, kernel, fault));
    expect(read).toMatchObject({
      outcome: { kind: "error", errno: "ETIMEDOUT" },
      elapsed: s(6.286),
      retransmissions: 3,
      void: null,
    });
    // the request has to reach the server before the fault, and its reply must not arrive first
    expect(measure(SERVER, run(events, kernel, { t0: sent - 5e6, t1: sent - 1e6 })).void).toBe(
      "the request went out into the fault, so the server never had it",
    );
    const answered = [...events, { ev: "data", t: sent + 200_000_000 }];
    expect(measure(SERVER, run(answered, kernel, fault)).void).toBe(
      "the server's reply arrived before the fault held",
    );
  });

  it("times a reset from the client's own send, which no kernel record marks", () => {
    // stage 0's reference cell: the request meets a reset one round trip later
    const RESET: Cell = {
      ...IN_FLIGHT,
      name: "reset on the next send",
      fault: "rst",
      prediction: {
        detects: true,
        timer: "rx.rst",
        errno: "ECONNRESET",
        from: "request-sent",
        low: s(0),
        high: s(0.001),
      },
    };
    const sent = T + 2e9;
    const events: ProbeEvent[] = [
      ...client,
      { ev: "sent", t: sent },
      { ev: "error", t: sent + 412_000, errno: "ECONNRESET" },
    ];
    const kernel = [
      ...reply,
      k("rst_rx", sent + 171_000),
      k("error", sent + 183_000, { err: 104 }),
    ];
    const read = measure(RESET, run(events, kernel, { t0: T + 1e9, t1: T + 1e9 + 3e6 }));
    expect(read).toMatchObject({
      outcome: { kind: "error", errno: "ECONNRESET" },
      elapsed: s(0.000183),
      socket: s(0.000412),
      noticed: s(0.000229),
      steps: [],
      void: null,
      finding: null,
    });
  });

  /** a change of state of a socket, as the prober writes it: TCP_ESTABLISHED is 1 */
  const state = (mono: number, old: number, next: number, more: Partial<KernelRecord> = {}) =>
    k("state", mono, { ...more, ...({ old, new: next } as unknown as Partial<KernelRecord>) });

  it("times a FIN from the close of the peer's socket to the CLOSE_WAIT of the observer's", () => {
    const FIN: Cell = {
      ...KEEPALIVE,
      name: "fin",
      fault: "fin",
      prediction: {
        detects: true,
        timer: "rx.fin",
        errno: "EOF",
        from: "peer-closed",
        low: s(0),
        high: s(0.001),
      },
    };
    const killed = T + 1e9;
    const kernel = [
      ...reply,
      // the server's socket, in the target's namespace: its process dies, and it sends its FIN
      state(killed, 1, 4, { netns: NETNS + 1, cookie: 99, src: "172.21.0.2:6379", dst: LOCAL }),
      state(killed + 61_000, 1, 8),
    ];
    const events: ProbeEvent[] = [...client, { ev: "eof", t: killed + 300_000 }];
    const read = measure(FIN, run(events, kernel, null));
    expect(read).toMatchObject({
      outcome: { kind: "eof" },
      elapsed: s(0.000061),
      void: null,
      finding: null,
    });
    // an error where an end of file was predicted is a finding
    const reset = measure(FIN, run(events, [...kernel.slice(0, -1), k("error", killed + 70_000, { err: 104 })], null));
    expect(reset.finding).toBe("it ended with ECONNRESET, not EOF");
  });

  it("records the reply time of each request of a stream, and judges none of them", () => {
    const STREAM: Cell = {
      ...KEEPALIVE,
      name: "stream",
      fault: "netem",
      probe: { mode: "stream", keepalive: true, count: 3, interval: { value: 10, unit: "ms" } },
      prediction: { detects: null, window: s(30), why: "a distribution: the simulator predicts it" },
    };
    const go = T + 1e9;
    const events: ProbeEvent[] = [
      ...client,
      { ev: "sent", t: go },
      { ev: "data", t: go + 120_000 },
      { ev: "sent", t: go + 10_200_000 },
      // a lost segment: the reply waits for the retransmission, an RTO later
      { ev: "data", t: go + 214_300_000 },
      { ev: "sent", t: go + 224_400_000 },
      { ev: "data", t: go + 224_520_000 },
      { ev: "done", t: go + 224_600_000 },
    ];
    const kernel = [...reply, retrans(go + 214_000_000, "rto", 1)];
    const read = measure(STREAM, run(events, kernel, { t0: go - 2e6, t1: go - 1e6 }));
    expect(read).toMatchObject({ outcome: { kind: "answered" }, void: null, finding: null, retransmissions: 1 });
    expect(read.samples).toEqual([s(0.00012), s(0.2041), s(0.00012)]);
    const verdict = verdictOf(STREAM.prediction, [read, { ...read, index: 1 }]);
    expect(verdict).toMatchObject({ decision: "measured", band: null, outside: [] });
    expect(verdict.why).toMatch(/^2 runs, 6 replies: median 0\.00012 s, p99 0\.2041 s, slowest 0\.2041 s, 2 retransmissions, 0 connections ended\. a distribution/);
  });

  it("times a long reply to its last byte, and counts what reordering did at the two ends", () => {
    const BULK: Cell = {
      ...KEEPALIVE,
      name: "bulk",
      fault: "netem",
      probe: { mode: "stream", keepalive: false, request: "GET big", count: 1 },
      prediction: { detects: null, window: s(30), why: "a distribution" },
    };
    const go = T + 1e9;
    const events: ProbeEvent[] = [
      ...client,
      { ev: "sent", t: go },
      { ev: "data", t: go + 2_000_000, n: 1448 },
      { ev: "data", t: go + 30_000_000, n: 2896 },
      { ev: "replied", t: go + 30_000_000, n: { value: 4344, unit: "B" } },
      { ev: "done", t: go + 30_100_000 },
    ];
    // the server's socket for the connection: the sender of the reply
    const server = { netns: NETNS + 1, cookie: 9184, src: "172.21.0.2:6379", dst: LOCAL };
    const tcp = (rcv_nxt: number, more: Partial<NonNullable<KernelRecord["tcp"]>> = {}) => ({
      retransmits: 0,
      pending: 0,
      backoff: 0,
      probes_out: 0,
      rto: { value: 54, unit: "jiffy" },
      srtt: { value: 10_400, unit: "us" },
      rcv_nxt,
      ...more,
    });
    const seg = (seq: number) => ({ seq, len: { value: 1448, unit: "B" } });
    const kernel = [
      ...reply,
      k("rx", go - 1_000_000, { netns: NETNS + 1, cookie: 9184, src: "172.21.0.2:6379", dst: LOCAL }),
      // the second segment overtook the first, and the first came twice
      k("rx", go + 2_000_000, { seg: seg(2448), tcp: tcp(1000, { rcv_ooopack: 0 }) }),
      k("rx", go + 12_000_000, { seg: seg(1000), tcp: tcp(1000, { rcv_ooopack: 1 }) }),
      k("rx", go + 22_000_000, { seg: seg(1000), tcp: tcp(3896, { rcv_ooopack: 1 }) }),
      k("rx", go + 3_000_000, { ...server, tcp: tcp(7, { sacked: 1, reordering: 3, dsack_dups: 0, reord_seen: 0 }) }),
      k("rx", go + 23_000_000, { ...server, tcp: tcp(7, { sacked: 0, reordering: 5, dsack_dups: 1, reord_seen: 1 }) }),
      { ...retrans(go + 13_000_000, "rto", 0), ...server, why: "fast" as const },
    ];
    const read = measure(BULK, run(events, kernel, { t0: go - 2e6, t1: go - 1e6 }));
    // the last byte of the reply, not its first data
    expect(read.samples).toEqual([s(0.03)]);
    expect(read.reordering).toEqual({
      outOfOrder: 1,
      duplicates: 1,
      ooo: 1,
      sacked: 1,
      lost: null,
      dsacks: 1,
      fast: 1,
      degree: 5,
      seen: 1,
    });
    const verdict = verdictOf(BULK.prediction, [read, { ...read, index: 1 }]);
    expect(verdict.reordering).toMatchObject({ outOfOrder: 2, duplicates: 2, dsacks: 2, degree: 5, seen: 2 });
    expect(verdict.why).toContain(
      "Reordering: 2 arrivals out of order and 2 duplicate arrivals at the client, its kernel counted 2 segments out of order, the server held up to 1 segments SACKed, got 2 DSACKs, sent 2 fast retransmissions, saw 2 reorderings, and its reordering degree went to 5.",
    );
  });

  it("voids a run whose first round trip is above the range that its band assumes", () => {
    const stall: Cell = {
      ...IN_FLIGHT,
      name: "a 1 s stall",
      fault: "stall",
      stall: s(1),
      prediction: {
        detects: false,
        window: s(20),
        recovers: { firing: 3, low: s(1.616), high: s(1.705), heal: { low: s(0.856), high: s(1.616) } },
        rtt: { low: { value: 0, unit: "ms" }, high: { value: 4, unit: "ms" } },
      },
    };
    const sent = T + 300_000_000;
    const first = (srtt: number) =>
      k("rx", T - 1_400_000, { tcp: { retransmits: 0, pending: 0, backoff: 0, probes_out: 0, rto: { value: 52, unit: "jiffy" }, srtt: { value: srtt, unit: "us" } } });
    const kernel = (srtt: number) => [
      first(srtt),
      reply[1]!,
      retrans(sent + 1_736_000_000, "rto", 3),
      k("rx", sent + 1_736_300_000, { seg: { seq: 8, len: { value: 7, unit: "B" } } }),
    ];
    const events = [...client, { ev: "sent", t: sent }, { ev: "data", t: sent + 1_736_500_000, n: 7 }];
    const healed = (srtt: number): Run => ({
      ...run(events, kernel(srtt), { t0: T + 100e6, t1: T + 104e6 }),
      heal: { t0: sent + 1e9, t1: sent + 1e9 + 2_500_000 },
    });
    // the step 3 outlier: a handshake of 4.826 ms made its RTO 52 jiffies, not 51
    expect(measure(stall, healed(4826))).toMatchObject({
      rtt: { value: 4.826, unit: "ms" },
      void: "rtt-over-assumption: its first round trip was 4.826 ms, above the 4 ms that the prediction assumes",
    });
    expect(measure(stall, healed(762))).toMatchObject({ rtt: { value: 0.762, unit: "ms" }, void: null });
  });
});
