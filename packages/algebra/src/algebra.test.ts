import type { Extent, Unknown } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { Manifestation } from "./algebra.ts";
import {
  algebraProblems,
  detection,
  errnoOf,
  evaluate,
  modelSource,
  overValues,
  parseExpr,
  realizationKnobs,
  realizationOf,
  recovery,
  stackedDetection,
  timerOf,
  timerUnder,
  transitionOn,
} from "./algebra.ts";
import type { Expr, Machine } from "./machine.ts";
import { machineProblems } from "./machine.ts";

// The algebra on small machines that this file writes: a socket with the knobs of a kernel's TCP
// and its timers over the models of the algebra, a server over the socket, and a driver with a
// backoff. The real documents, and the algebra on them, are in @mark1russell7/machines.

const model = (name: string, knobs: string[]): Expr => ({ model: name, knobs, unit: "s" });
const WAIT = ["fired", "tcp_rto_min", "tcp_rto_max", "rtt", "hz"];
const STEP = ["tcp_retries2", "tcp_rto_min", "tcp_rto_max", "rtt", "hz"];
const JIFFY = model("linux.jiffy", ["hz"]);
const knob = (unit: string | null, value: number | null) => ({ key: "a knob", scope: "socket", unit, default: value });

/** a socket: the states, events, knobs and timers of a kernel's TCP that the algebra reads, and no more */
const SOCKET: Machine = {
  format: "mark1russell7.machine/1",
  id: "test.machine.socket",
  title: "A socket",
  layer: "kernel",
  version: "1",
  sources: [{ ref: "this test", rung: "derived" }],
  states: { CLOSED: { initial: true }, SYN_SENT: {}, ESTABLISHED: {}, CLOSE_WAIT: {}, GONE: { final: true } },
  events: {
    "app.connect": { kind: "app" },
    "rx.synack": { kind: "rx" },
    "rx.ack": { kind: "rx" },
    "rx.fin": { kind: "rx" },
    "tx.data": { kind: "tx" },
    "tx.retransmit.first": { kind: "tx" },
    "timer.syn.exhausted": { kind: "timer" },
    "timer.rto": { kind: "timer" },
    "timer.rto.exhausted": { kind: "timer" },
    "timer.keepalive.exhausted": { kind: "timer" },
    "timer.user-timeout": { kind: "timer" },
  },
  knobs: {
    tcp_syn_retries: knob("count", 6),
    tcp_syn_linear_timeouts: knob("count", 4),
    tcp_retries2: knob("count", 15),
    tcp_rto_min: knob("ms", 200),
    tcp_rto_max: knob("ms", 120_000),
    keepidle: knob("s", 7200),
    keepintvl: knob("s", 75),
    keepcnt: knob("count", 9),
    tcp_user_timeout: knob("ms", 0),
    rtt: knob("ms", null),
    hz: knob("Hz", null),
  },
  timers: {
    syn_giveup: {
      duration: model("linux.syn-giveup", ["tcp_syn_retries", "tcp_syn_linear_timeouts"]),
      arms: ["enter:SYN_SENT"],
      cancels: ["rx.synack"],
      fires: "timer.syn.exhausted",
    },
    retransmit: {
      duration: model("linux.rto-wait", WAIT),
      lateness: model("linux.rto-wait-lateness", WAIT),
      early: JIFFY,
      arms: ["tx.data"],
      cancels: ["rx.ack"],
      fires: "timer.rto",
      backoff: { resets: ["rx.ack"] },
    },
    retrans_giveup: {
      duration: model("linux.retrans-budget", ["tcp_retries2", "tcp_rto_min", "tcp_rto_max"]),
      lateness: model("linux.retrans-step", STEP),
      arms: ["tx.retransmit.first"],
      cancels: ["rx.ack"],
      fires: "timer.rto.exhausted",
    },
    keepalive: {
      duration: { expr: "keepidle + keepintvl * keepcnt", unit: "s" },
      lateness: model("linux.keepalive-lateness", ["keepidle", "keepintvl", "keepcnt", "hz"]),
      early: JIFFY,
      arms: ["enter:ESTABLISHED", "rx.ack"],
      cancels: ["tx.retransmit.first"],
      fires: "timer.keepalive.exhausted",
    },
    user_timeout: {
      duration: { knob: "tcp_user_timeout", unit: "ms" },
      arms: ["tx.retransmit.first"],
      cancels: ["rx.ack"],
      fires: "timer.user-timeout",
    },
  },
  realizes: {
    "test.mechanism.idle-refresh": { duration: { knob: "keepidle", unit: "s" }, lateness: model("linux.wheel", ["keepidle", "hz"]), early: JIFFY },
    "test.mechanism.keepalive-window": { timer: "keepalive" },
  },
  transitions: [
    { id: "connect", from: "CLOSED", on: "app.connect", to: "SYN_SENT" },
    { id: "established", from: "SYN_SENT", on: "rx.synack", to: "ESTABLISHED" },
    { id: "syn-giveup", from: "SYN_SENT", on: "timer.syn.exhausted", to: "GONE", errno: "ETIMEDOUT", timer: "syn_giveup" },
    { id: "send", from: "ESTABLISHED", on: ["tx.data", "rx.ack", "timer.rto"], to: "ESTABLISHED" },
    { id: "passive-close", from: "ESTABLISHED", on: "rx.fin", to: "CLOSE_WAIT" },
    {
      id: "giveup",
      from: ["ESTABLISHED", "CLOSE_WAIT"],
      on: ["timer.rto.exhausted", "timer.user-timeout", "timer.keepalive.exhausted"],
      to: "GONE",
      errno: "ETIMEDOUT",
    },
  ],
};

/** a server over the socket: it sets the keepalive of the socket from one knob of its own, as Redis does */
const SERVER: Machine = {
  format: "mark1russell7.machine/1",
  id: "test.machine.server",
  title: "A server",
  layer: "server",
  version: "1",
  sources: [{ ref: "this test", rung: "derived" }],
  states: { ABSENT: { initial: true }, CONNECTED: {}, GONE: { final: true } },
  events: { accept: { kind: "local" }, "timer.idle": { kind: "timer" }, "socket.error": { kind: "local" } },
  knobs: { tcp_keepalive: knob("s", 300), timeout: knob("s", 0), hz: knob("Hz", null) },
  timers: { idle: { duration: { knob: "timeout", unit: "s" }, arms: ["enter:CONNECTED"], fires: "timer.idle" } },
  realizes: {
    "test.mechanism.idle-refresh": {
      duration: { knob: "tcp_keepalive", unit: "s" },
      lateness: model("linux.wheel", ["tcp_keepalive", "hz"]),
      early: JIFFY,
    },
    "test.mechanism.server-idle-close": { timer: "idle" },
    // a timer of the socket below: only a reader of the two documents examines it
    "test.mechanism.keepalive-window": { timer: "keepalive" },
  },
  over: {
    machine: SOCKET.id,
    states: { CONNECTED: "ESTABLISHED" },
    sets: {
      keepidle: { knob: "tcp_keepalive", unit: "s" },
      keepintvl: { expr: "max(1, floor(tcp_keepalive / 3))", unit: "s" },
      keepcnt: { const: 3, unit: "count" },
    },
    ends: "socket.error",
  },
  transitions: [
    { id: "accept", from: "ABSENT", on: "accept", to: "CONNECTED" },
    { id: "close", from: "CONNECTED", on: ["timer.idle", "socket.error"], to: "GONE" },
  ],
};

/** a driver with a backoff: it waits min(2^fired × 50, 5000) ms between its tries, as ioredis 6 does */
const DRIVER: Machine = {
  format: "mark1russell7.machine/1",
  id: "test.machine.driver",
  title: "A driver",
  layer: "driver",
  version: "1",
  sources: [{ ref: "this test", rung: "derived" }],
  states: { waiting: { initial: true }, reconnecting: {}, ready: {} },
  events: { "timer.retry": { kind: "timer" }, "handshake.ready": { kind: "local" } },
  knobs: {},
  timers: {
    retry_delay: {
      duration: model("ioredis.retry-base", ["fired"]),
      lateness: { const: 0.2, unit: "s" },
      arms: ["enter:reconnecting"],
      fires: "timer.retry",
      backoff: { resets: ["handshake.ready"] },
    },
  },
  transitions: [
    { id: "retry", from: "reconnecting", on: "timer.retry", to: "reconnecting" },
    { id: "ready", from: "reconnecting", on: "handshake.ready", to: "ready" },
  ],
};

/** the defaults of Linux 6.6, as the kernel's code at v6.6 sets them */
const LINUX_66: Readonly<Record<string, Extent | Unknown>> = {
  keepidle: { value: 7200, unit: "s" },
  keepintvl: { value: 75, unit: "s" },
  keepcnt: { value: 9, unit: "count" },
  tcp_retries2: { value: 15, unit: "count" },
  tcp_rto_min: { value: 200, unit: "ms" },
  tcp_rto_max: { value: 120, unit: "s" },
  tcp_syn_retries: { value: 6, unit: "count" },
  tcp_syn_linear_timeouts: { value: 4, unit: "count" },
};
const given = (values: Readonly<Record<string, Extent | Unknown>>) => (name: string) => values[name];
/** and a build's HZ, and a round trip well under a jiffy */
const HERE = { ...LINUX_66, hz: { value: 250, unit: "Hz" }, rtt: { value: 0.1, unit: "ms" } };
const BLACKHOLE: Manifestation = { name: "blackhole", passes: [] };
const FROZEN: Manifestation = { name: "freeze-process", passes: ["rx.ack"] };
const s = (value: number) => ({ value, unit: "s" });

describe("the small machines of this file", () => {
  it("are consistent, and the algebra reads each of their durations", () => {
    for (const doc of [SOCKET, SERVER, DRIVER]) {
      expect(machineProblems(doc), doc.id).toEqual([]);
      expect(algebraProblems(doc), doc.id).toEqual([]);
    }
  });
});

describe("the closed forms of the models", () => {
  it("computes the times worked out by hand from the defaults of Linux 6.6", () => {
    // a dead peer on an idle connection: 7200 s idle, then 9 probes 75 s apart
    expect(timerOf(SOCKET, "keepalive", given(LINUX_66)).duration).toEqual(s(7875));
    // a black hole with data in flight: the hypothetical timeout of tcp_retries2,
    // 0.2 s × (2^10 − 1) + 6 × 120 s
    expect(timerOf(SOCKET, "retrans_giveup", given(LINUX_66)).duration).toEqual(s(924.6));
    // a SYN into a black hole: five 1 s waits, then 2, 4, 8, 16, 32 and 64 s
    expect(timerOf(SOCKET, "syn_giveup", given(LINUX_66)).duration).toEqual(s(131));
    // with linear timeouts off, the classic doubling from 1 s: 127 s
    const linear = given({ ...LINUX_66, tcp_syn_linear_timeouts: { value: 0, unit: "count" } });
    expect(timerOf(SOCKET, "syn_giveup", linear).duration).toEqual(s(127));
    // a constant and a knob, each in the unit of its expression
    expect(evaluate(SOCKET, { const: 60, unit: "s" }, given({}))).toEqual(s(60));
    expect(evaluate(SOCKET, { knob: "tcp_rto_max", unit: "ms" }, given(LINUX_66))).toEqual({ value: 120_000, unit: "ms" });
    expect(() => timerOf(SOCKET, "nonesuch", given({}))).toThrow("A socket has no timer nonesuch");
  });

  it("bounds how late a timer fires by the wheel it waits on, which needs the build's HZ", () => {
    // the defaults do not say HZ, a build option, so how late is unknown and says why
    expect(timerOf(SOCKET, "keepalive", given(LINUX_66)).lateness).toEqual({ unknown: "nothing gives hz's value", unit: "s" });
    // at HZ 250 a 7200 s timer files at the wheel's level of 131.072 s, and each 75 s probe
    // interval at 2.048 s: up to 149.504 s late in all
    expect(timerOf(SOCKET, "keepalive", given(HERE))).toEqual({
      duration: s(7875),
      lateness: s(149.504),
      early: s(0.004),
    });
    // the give-up lands at most one capped 120 s step past its budget, plus the rounding of the
    // sixteen RTO firings before it: 21.344 s more at HZ 250
    expect(timerOf(SOCKET, "retrans_giveup", given(HERE))).toEqual({ duration: s(924.6), lateness: s(141.344) });
  });

  it("predicts scaled timers, where the RTO is the round trip plus 200 ms, in jiffies", () => {
    const scaled = {
      ...HERE,
      keepidle: s(5),
      keepintvl: s(2),
      keepcnt: { value: 3, unit: "count" },
    };
    // 5 s idle waits on the 256 ms level, each 2 s interval on the 32 ms one
    expect(timerOf(SOCKET, "keepalive", given(scaled))).toEqual({ duration: s(11), lateness: s(0.352), early: s(0.004) });
    // tcp_retries2 = 3: the RTO starts at 204 ms (51 jiffies), so its firings fall at 0.408,
    // 1.224 and 2.856 s, just short of the 3 s budget, and the next is a 3.264 s step later
    const three = given({ ...scaled, tcp_retries2: { value: 3, unit: "count" } });
    expect(timerOf(SOCKET, "retrans_giveup", three)).toEqual({ duration: s(3), lateness: s(3.616) });
    // a round trip of 20 ms moves the RTO to 220 ms, and so the steps
    const far = given({ ...scaled, tcp_retries2: { value: 5, unit: "count" }, rtt: { value: 20, unit: "ms" } });
    expect(timerOf(SOCKET, "retrans_giveup", far).lateness).toEqual(s(14.944));
  });

  it("bounds the delayed ACK by the round trip, from HZ/25 to HZ/5, and rounds it on the wheel", () => {
    const delack = (rtt: number, hz: number) => {
      const values = given({ rtt: { value: rtt, unit: "ms" }, hz: { value: hz, unit: "Hz" } });
      return {
        wait: evaluate(SOCKET, model("linux.delack", ["rtt", "hz"]), values),
        late: evaluate(SOCKET, model("linux.delack-lateness", ["rtt", "hz"]), values),
      };
    };
    // a fast path: TCP_DELACK_MIN, 40 ms at each HZ, at most one jiffy late on the wheel's level 0
    expect(delack(0.1, 1000)).toEqual({ wait: s(0.04), late: s(0.001) });
    expect(delack(0.1, 250)).toEqual({ wait: s(0.04), late: s(0.004) });
    // a round trip of 100 ms bounds it at 100 ms, which waits on the 8 ms level at HZ 1000
    expect(delack(100, 1000)).toEqual({ wait: s(0.1), late: s(0.008) });
    // TCP_DELACK_MAX caps it at 200 ms
    expect(delack(350, 1000)).toEqual({ wait: s(0.2), late: s(0.008) });
    // the round trip counts in whole jiffies, rounded up: 41.5 ms is 11 jiffies at HZ 250
    expect(delack(41.5, 250).wait).toEqual(s(0.044));
  });

  it("reads a server's own arithmetic in its own units, over the socket below it", () => {
    // the server's keepalive is the socket's: idle is tcp_keepalive, the interval a third of it in
    // whole seconds, and three probes, so 300 + 3 × 100 = 600 s
    const keepalive = (values: Readonly<Record<string, Extent | Unknown>>) =>
      timerOf(SOCKET, "keepalive", overValues(SERVER, given(values), given(values)));
    expect(SERVER.timers["keepalive"]).toBeUndefined();
    expect(keepalive({ tcp_keepalive: s(300) }).duration).toEqual(s(600));
    // a third of 301 s is 100 whole seconds, as the server divides it
    expect(keepalive({ tcp_keepalive: s(301) }).duration).toEqual(s(601));
    // the wheel rounds it: at 300 s the idle timer files at 16.384 s granularity and each 100 s
    // interval at 2.048 s
    expect(keepalive({ tcp_keepalive: s(300), hz: { value: 250, unit: "Hz" } })).toMatchObject({
      lateness: s(22.528),
      early: s(0.004),
    });
    // at 5 s: an interval of 1 s, the least that the server sets
    expect(keepalive({ tcp_keepalive: s(5), hz: { value: 250, unit: "Hz" } })).toMatchObject({ duration: s(8), lateness: s(0.352) });
    // a knob that the server does not set comes from the values of the socket
    expect(overValues(SERVER, given({}), given({ tcp_retries2: { value: 3, unit: "count" } }))("tcp_retries2")).toEqual({
      value: 3,
      unit: "count",
    });
  });

  it("gives the waits of a client's backoff from its formula, by how many times it has fired", () => {
    // min(2^(times − 1) × 50, 5000) ms, where times is one more than the firings since the reset
    const delay = (fired: number) => timerOf(DRIVER, "retry_delay", given({}), fired).duration;
    expect(delay(0)).toEqual(s(0.05));
    expect(delay(2)).toEqual(s(0.2));
    expect(delay(98)).toEqual(s(5));
  });

  it("gives a backoff timer's waits one at a time, by how many times it has fired", () => {
    const wait = (fired: number) => timerOf(SOCKET, "retransmit", given(HERE), fired);
    // the first wait is one RTO, 51 jiffies at HZ 250
    const jiffy = s(0.004);
    expect(wait(0)).toEqual({ duration: s(0.204), lateness: jiffy, early: jiffy });
    expect(wait(1).duration).toEqual(s(0.204));
    // then each wait doubles, and files on the wheel at its own level: 102 jiffies at 8 of them
    expect(wait(2)).toEqual({ duration: s(0.408), lateness: s(0.032), early: jiffy });
    expect(wait(4).duration).toEqual(s(1.632));
    expect(wait(5).lateness).toEqual(s(0.256));
    // up to tcp_rto_max: 0.204 s × 2^11 would be 417.792 s
    expect(wait(12).duration).toEqual(s(120));
    // which wait it is has to be said
    expect(timerOf(SOCKET, "retransmit", given(HERE)).duration).toEqual({
      unknown: "one wait of a timer with a backoff: say which, by how many times it has fired",
      unit: "s",
    });
    // a timer that runs again gives up on nothing by firing, so it never detects a failure
    const lost = detection(SOCKET, { state: "ESTABLISHED", inFlight: true }, BLACKHOLE, given(HERE));
    expect(lost.detectors.map((d) => d.timer)).not.toContain("retransmit");
  });

  it("names the source of each model's formula", () => {
    expect(modelSource("linux.retrans-budget")).toContain("tcp_model_timeout");
    expect(modelSource("ioredis.retry-base")).toContain("ioredis 6.0.0");
    expect(modelSource("nonesuch")).toBeUndefined();
    expect(evaluate(SOCKET, model("nonesuch", []), given({}))).toEqual({ unknown: "no model nonesuch", unit: "s" });
    expect(evaluate(SOCKET, model("linux.jiffy", ["hz", "rtt"]), given(HERE))).toEqual({
      unknown: "linux.jiffy reads 1 knobs, not 2",
      unit: "s",
    });
  });
});

describe("recovery after a stall (Q4)", () => {
  it("waits for the first retransmission past the end of the stall", () => {
    const after = (seconds: number) => recovery(SOCKET, "retransmit", given(HERE), s(seconds));
    // a 1 s stall: the probe and the RTO firings at 0.204, 0.408 and 0.816 s all fall inside it,
    // and the next comes 1.632 s after the send, each wait up to a jiffy early and its wheel late
    expect(after(1)).toEqual({
      firings: [
        { fired: 0, low: s(0.2), high: s(0.208) },
        { fired: 1, low: s(0.4), high: s(0.416) },
        { fired: 2, low: s(0.804), high: s(0.856) },
        { fired: 3, low: s(1.616), high: s(1.704) },
      ],
      first: [3],
      low: s(1.616),
      high: s(1.704),
    });
    // a stall just past a firing costs nearly all of the next, doubled wait: 3.5 s stalls 6.5 s
    expect(after(3.5)).toMatchObject({ first: [5], low: s(6.504), high: s(6.888) });
    // a stall that ends inside a firing's bounds may be met by that firing or the next
    expect(after(1.65)).toMatchObject({ first: [3, 4], low: s(1.65), high: s(3.368) });
    // a stall that never ends, and a timer that fires once
    expect(recovery(SOCKET, "retransmit", given(HERE), { value: "infinite", unit: "s" })).toEqual({
      unknown: "a stall that never ends: nothing recovers from it",
      unit: "s",
    });
    expect(() => recovery(SOCKET, "keepalive", given(HERE), s(1))).toThrow(/has no backoff/);
  });
});

describe("realizations", () => {
  it("gives what a machine realizes: a whole timer, or a time of its own over its knobs", () => {
    const HZ = { hz: { value: 250, unit: "Hz" } };
    // the idle time, rounded once on the wheel: 7200 s files at 131.072 s granularity, 300 s at 16.384 s
    expect(realizationOf(SOCKET, "test.mechanism.idle-refresh", given({ ...LINUX_66, ...HZ }))).toEqual({
      duration: s(7200),
      lateness: s(131.072),
      early: s(0.004),
    });
    expect(realizationOf(SERVER, "test.mechanism.idle-refresh", given({ tcp_keepalive: s(300), ...HZ }))?.lateness).toEqual(s(16.384));
    // a whole timer is the timer: the server closes an idle client after `timeout`, never by default
    expect(realizationOf(SERVER, "test.mechanism.server-idle-close", given({ timeout: { value: "infinite", unit: "s" } }))).toEqual({
      duration: { value: "infinite", unit: "s" },
    });
    expect(realizationOf(SOCKET, "test.mechanism.keepalive-window", given(LINUX_66))).toEqual(timerOf(SOCKET, "keepalive", given(LINUX_66)));
    expect(realizationKnobs(SERVER, "test.mechanism.idle-refresh")).toEqual(["tcp_keepalive", "hz"]);
    expect(realizationKnobs(SOCKET, "test.mechanism.keepalive-window")).toEqual(["keepidle", "keepintvl", "keepcnt", "hz"]);
    // and a mechanism the document does not realize has no time here
    expect(realizationOf(SERVER, "test.mechanism.middlebox-idle", given({}))).toBeUndefined();
    expect(realizationKnobs(SERVER, "test.mechanism.middlebox-idle")).toEqual([]);
  });
});

describe("the arithmetic of a duration", () => {
  it("says which knob it lacks, and lets a timer never set run forever", () => {
    const { keepcnt: _unsaid, ...lacking } = LINUX_66;
    expect(timerOf(SOCKET, "keepalive", given(lacking)).duration).toEqual({ unknown: "nothing gives keepcnt's value", unit: "s" });
    expect(timerOf(SOCKET, "keepalive", given({ ...LINUX_66, keepidle: { value: "infinite", unit: "s" } })).duration).toEqual({
      value: "infinite",
      unit: "s",
    });
    expect(evaluate(SOCKET, { knob: "tcp_user_timeout", unit: "ms" }, given({ tcp_user_timeout: { unknown: "no claim says" } }))).toEqual({
      unknown: "tcp_user_timeout: no claim says",
      unit: "ms",
    });
    expect(evaluate(SOCKET, { knob: "nonesuch", unit: "s" }, given({}))).toEqual({ unknown: "the machine names no knob nonesuch", unit: "s" });
  });

  it("gives no bound a sign: max(cap − ∞, cap / 2) is cap / 2, and a negative time is unknown", () => {
    // a window that nothing bounds: the cap less it is −∞, which a max discards and a min keeps
    const values = given({ ...LINUX_66, tcp_user_timeout: { value: "infinite", unit: "ms" } });
    const at = (expr: string) => evaluate(SOCKET, { expr, unit: "ms" }, values);
    expect(at("max(tcp_rto_max - tcp_user_timeout, tcp_rto_max / 2)")).toEqual({ value: 60_000, unit: "ms" });
    expect(at("max(tcp_rto_max / 2, tcp_rto_max - tcp_user_timeout)")).toEqual({ value: 60_000, unit: "ms" });
    expect(at("min(tcp_rto_max - tcp_user_timeout, tcp_rto_max)")).toEqual({ unknown: "a negative unbounded time", unit: "ms" });
    expect(at("min(tcp_user_timeout, tcp_rto_max)")).toEqual({ value: 120_000, unit: "ms" });
    expect(at("max(tcp_user_timeout, tcp_rto_max)")).toEqual({ value: "infinite", unit: "ms" });
    expect(at("tcp_rto_max - (0 - tcp_user_timeout)")).toEqual({ value: "infinite", unit: "ms" });
    expect(at("tcp_user_timeout - tcp_user_timeout")).toEqual({ unknown: "no bound less no bound", unit: "ms" });
    expect(at("tcp_rto_max / tcp_user_timeout")).toEqual({ value: 0, unit: "ms" });
    expect(at("tcp_rto_max / 0")).toEqual({ unknown: "a division by zero", unit: "ms" });
    expect(at("floor(tcp_rto_min / 3) + ceil(tcp_rto_min / 3)")).toEqual({ value: 133, unit: "ms" });
  });

  it("raises to a whole power, as a backoff with any multiplier does", () => {
    const values = given({ ...LINUX_66, tcp_user_timeout: { value: "infinite", unit: "ms" } });
    const at = (expr: string, fired?: number) => evaluate(SOCKET, { expr, unit: "ms" }, values, fired);
    // a reconnect of 500 ms × 1.5^fired, capped at 4 s: exact, wait by wait
    const wait = "min(500 * pow(1.5, fired), 4000)";
    expect(at(wait, 0)).toEqual({ value: 500, unit: "ms" });
    expect(at(wait, 3)).toEqual({ value: 1687.5, unit: "ms" });
    expect(at(wait, 9)).toEqual({ value: 4000, unit: "ms" });
    expect(at("tcp_rto_min * pow(2, -1)")).toEqual({ value: 100, unit: "ms" });
    // no bound to the power 0 is 1, and to a positive power it stays no bound
    expect(at("pow(tcp_user_timeout, 0)")).toEqual({ value: 1, unit: "ms" });
    expect(at("pow(tcp_user_timeout, 3)")).toEqual({ value: "infinite", unit: "ms" });
    expect(at("pow(2, 0.5)")).toEqual({ unknown: "pow takes a whole exponent", unit: "ms" });
    expect(at("pow(0, -1)")).toEqual({ unknown: "a division by zero", unit: "ms" });
    expect(at("pow(2, fired)")).toMatchObject({ unknown: expect.stringContaining("by how many times it has fired") });
    expect(() => parseExpr("pow(2)")).toThrow("pow takes 2, not 1");
  });

  it("refuses arithmetic it cannot parse, and a model that it does not have", () => {
    expect(() => parseExpr("keepidle + * keepcnt")).toThrow(/\* is not a term/);
    expect(() => parseExpr("max(1)")).toThrow(/max takes 2, not 1/);
    expect(() => parseExpr("(keepidle")).toThrow(/expected \) at the end/);
    expect(() => parseExpr("keepidle keepcnt")).toThrow(/keepcnt after the end/);
    const broken: Machine = {
      ...SOCKET,
      timers: {
        ...SOCKET.timers,
        odd: { duration: { expr: "keepidle + * keepcnt", unit: "s" }, arms: [], fires: "timer.rto" },
        new: { duration: model("nonesuch", []), arms: [], fires: "timer.rto" },
      },
    };
    expect(algebraProblems(broken)).toEqual([
      'timer odd: "keepidle + * keepcnt": * is not a term',
      "timer new: no model nonesuch",
    ]);
  });
});

describe("detection: the minimum over the detectors still live (Q1–Q3)", () => {
  const ESTABLISHED = { state: "ESTABLISHED", inFlight: false };
  const OFF = { ...LINUX_66, tcp_user_timeout: { value: "infinite", unit: "ms" } } as const;

  it("finds an idle black hole by keepalive, and a black hole in flight by the retransmissions", () => {
    // Q1: nothing is unacknowledged, so only keepalive runs, and nothing comes back to re-arm it
    expect(detection(SOCKET, ESTABLISHED, BLACKHOLE, given(OFF)).first).toEqual({
      timer: "keepalive",
      fires: "timer.keepalive.exhausted",
      duration: s(7875),
    });
    // Q2: the unacknowledged data is retransmitted, which cancels keepalive
    const busy = detection(SOCKET, { ...ESTABLISHED, inFlight: true }, BLACKHOLE, given(OFF));
    expect(busy.first).toMatchObject({ timer: "retrans_giveup", duration: s(924.6) });
    expect(busy.held).toEqual([{ timer: "keepalive", why: "tx.retransmit.first cancels it" }]);
    // a 30 s TCP_USER_TIMEOUT beats the ladder
    const bounded = detection(
      SOCKET,
      { ...ESTABLISHED, inFlight: true },
      BLACKHOLE,
      given({ ...LINUX_66, tcp_user_timeout: { value: 30000, unit: "ms" } }),
    );
    expect(bounded.first).toMatchObject({ timer: "user_timeout", duration: { value: 30000, unit: "ms" } });
  });

  it("finds nothing at TCP when the process freezes and its kernel keeps answering (Q3)", () => {
    for (const inFlight of [false, true]) {
      const frozen = detection(SOCKET, { ...ESTABLISHED, inFlight }, FROZEN, given(OFF));
      // the kernel acknowledges the data, so nothing is retransmitted, and it answers every probe
      expect(frozen.first).toBeNull();
      expect(frozen.detectors).toEqual([]);
      expect(frozen.held).toEqual([{ timer: "keepalive", why: "rx.ack keeps arriving and re-arms it" }]);
    }
  });

  it("says so when a socket has no keepalive, and when a live detector's time is unknown", () => {
    // a client that never sets SO_KEEPALIVE: an idle black hole is never noticed at TCP
    const bare = detection(SOCKET, ESTABLISHED, BLACKHOLE, given({ ...OFF, keepidle: { value: "infinite", unit: "s" } }));
    expect(bare.first).toBeNull();
    expect(bare.detectors.map((detector) => detector.timer)).toEqual(["keepalive"]);
    // with TCP_USER_TIMEOUT unknown, the retransmissions' 924.6 s is only an upper bound
    const open = detection(SOCKET, { ...ESTABLISHED, inFlight: true }, BLACKHOLE, given(LINUX_66));
    expect(open.first?.timer).toBe("retrans_giveup");
    expect(open.unsettled).toEqual(["user_timeout"]);
  });

  it("adds the detectors of the machine below, with the knobs that the machine above sets", () => {
    const values = given({ tcp_keepalive: s(5), timeout: { value: "infinite", unit: "s" } });
    const stacked = stackedDetection(SERVER, SOCKET, { state: "CONNECTED", inFlight: false }, BLACKHOLE, values, given(OFF));
    // keepalive at 5 s idle, then 3 probes 1 s apart, beside the idle timer of the server, which never fires
    expect(stacked.first).toEqual({ timer: "keepalive", fires: "timer.keepalive.exhausted", duration: s(8), beneath: SOCKET.id });
    expect(stacked.detectors.map((d) => d.timer)).toEqual(["keepalive", "idle"]);
    expect(() => stackedDetection(SOCKET, SOCKET, ESTABLISHED, BLACKHOLE, values, values)).toThrow("A socket runs on no other machine");
    expect(() => stackedDetection(SERVER, SOCKET, { state: "GONE", inFlight: false }, BLACKHOLE, values, values)).toThrow(
      "A server's GONE sits on no state of A socket",
    );
  });
});

describe("what a failure delivers, the errno it sets, and the durations it changes", () => {
  const reverted: Manifestation = {
    name: "unreachable-host",
    passes: [],
    errno: { errno: "EHOSTUNREACH", timers: ["retrans_giveup", "user_timeout"] },
    replaces: { retrans_giveup: { lateness: model("linux.retrans-step-reverted", STEP) } },
  };

  it("detects a FIN that the failure delivers at once, with no errno", () => {
    const fin = detection(SOCKET, { state: "ESTABLISHED", inFlight: false }, { name: "fin", passes: [], delivers: ["rx.fin"] }, given(HERE));
    expect(fin.delivered).toEqual([{ event: "rx.fin", to: "CLOSE_WAIT", errno: null }]);
    // a delivered event that no transition takes from the state detects nothing
    const none = detection(SOCKET, { state: "ESTABLISHED", inFlight: false }, { name: "x", passes: [], delivers: ["rx.synack"] }, given(HERE));
    expect(none.delivered).toEqual([]);
    expect(transitionOn(SOCKET, "CLOSE_WAIT", "timer.keepalive.exhausted")?.id).toBe("giveup");
  });

  it("reports the soft errno of an ICMP at the timeout of a retransmission, and not of keepalive", () => {
    const giveUp = { timer: "retrans_giveup", fires: "timer.rto.exhausted" };
    const keepalive = { timer: "keepalive", fires: "timer.keepalive.exhausted" };
    expect(errnoOf(SOCKET, "ESTABLISHED", giveUp, reverted)).toBe("EHOSTUNREACH");
    // a keepalive probe quotes snd_una − 1, outside the window, thus the kernel drops its ICMP
    expect(errnoOf(SOCKET, "ESTABLISHED", keepalive, reverted)).toBe("ETIMEDOUT");
    expect(errnoOf(SOCKET, "ESTABLISHED", giveUp, BLACKHOLE)).toBe("ETIMEDOUT");
    expect(errnoOf(SOCKET, "CLOSED", giveUp, reverted)).toBeNull();
  });

  it("gives the give-up under the revert of RFC 6069 at most one RTO after its budget", () => {
    const values = given({ ...HERE, tcp_retries2: { value: 3, unit: "count" } });
    // the budget is the same, 3.0 s. The step is one RTO of 51 jiffies, not the doubled 816
    expect(timerUnder(SOCKET, "retrans_giveup", values, reverted)).toMatchObject({ duration: s(3), lateness: s(0.268) });
    expect(timerOf(SOCKET, "retrans_giveup", values).lateness).toEqual(s(3.616));
    // each wait of the retransmission timer is one RTO under the revert
    const each = { ...reverted, replaces: { retransmit: { duration: model("linux.rto-wait-reverted", WAIT) } } };
    expect(timerUnder(SOCKET, "retransmit", values, each, 5).duration).toEqual(s(0.204));
  });
});

describe("a knob that turns its timers off (0.7.0)", () => {
  // a server that closes an idle client after its timeout, where 0 closes no client
  const IDLE: Machine = {
    format: "mark1russell7.machine/1",
    id: "idle-server",
    title: "A server with an idle timeout",
    layer: "server",
    version: "1",
    conditions: {},
    sources: [{ ref: "this test", rung: "documented" }],
    states: { OPEN: { initial: true }, GONE: {} },
    events: { "timer.idle": { kind: "timer" } },
    knobs: { timeout: { key: "timeout", scope: "server", unit: "s", default: 0, off: 0 } },
    timers: {
      idle: {
        duration: { knob: "timeout", unit: "s" },
        lateness: { expr: "timeout / 10", unit: "s" },
        arms: ["enter:OPEN"],
        fires: "timer.idle",
      },
    },
    transitions: [{ id: "close", from: "OPEN", to: "GONE", on: "timer.idle" }],
  };
  const secs = (value: number) => ({ value, unit: "s" });

  it("gives a timer that reads the knob at its off value no bound, in each expression", () => {
    expect(timerOf(IDLE, "idle", given({ timeout: secs(0) }))).toMatchObject({
      duration: { value: "infinite" },
      lateness: { value: "infinite" },
    });
    // the off value in another unit is the same value
    expect(timerOf(IDLE, "idle", given({ timeout: { value: 0, unit: "ms" } })).duration).toMatchObject({
      value: "infinite",
    });
    // any other value is a time
    expect(timerOf(IDLE, "idle", given({ timeout: secs(5) }))).toMatchObject({
      duration: secs(5),
      lateness: secs(0.5),
    });
    expect(machineProblems(IDLE)).toEqual([]);
  });
});
