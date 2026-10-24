import type { Machine, Manifestation } from "@mark1russell7/algebra";
import {
  algebraProblems,
  detection,
  errnoOf,
  evaluate,
  overValues,
  parseExpr,
  realizationKnobs,
  realizationOf,
  recovery,
  timerOf,
  timerUnder,
} from "@mark1russell7/algebra";
import type { Extent, Unknown } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { MACHINES, MANIFESTATIONS } from "./index.ts";

// The algebra on the real documents: the closed forms of Linux 6.6, Redis and ioredis, and the
// detection of each fault. The algebra's own tests use small machines of their own.

/** a machine document, by its id in a graph: systems.machine.linux-tcp is MACHINES["linux-tcp"] */
const machine = async (id: string): Promise<Machine> => {
  const doc = MACHINES[id.split(".").at(-1)!];
  if (doc === undefined) throw new Error(`no document ${id}`);
  return doc;
};

/** a manifestation: the events it still lets through to Linux TCP */
const manifestation = async (slug: string): Promise<Manifestation> => {
  const through = MANIFESTATIONS[slug];
  if (through === undefined) throw new Error(`no document says what ${slug} lets through`);
  return { name: slug, passes: through };
};

/** Linux 6.6's defaults, as the kernel's code at v6.6 sets them */
const LINUX_66: Readonly<Record<string, Extent | Unknown>> = {
  keepidle: { value: 7200, unit: "s" },
  keepintvl: { value: 75, unit: "s" },
  keepcnt: { value: 9, unit: "count" },
  tcp_retries2: { value: 15, unit: "count" },
  tcp_rto_min: { value: 200, unit: "ms" },
  tcp_rto_max: { value: 120, unit: "s" },
  tcp_syn_retries: { value: 6, unit: "count" },
  tcp_syn_linear_timeouts: { value: 4, unit: "count" },
  tcp_fin_timeout: { value: 60, unit: "s" },
};
const given = (values: Readonly<Record<string, Extent | Unknown>>) => (name: string) =>
  values[name];
/** and a build's HZ, and a Docker network's round trip, well under a jiffy */
const HERE = { ...LINUX_66, hz: { value: 250, unit: "Hz" }, rtt: { value: 0.1, unit: "ms" } };

describe("the algebra's first closed forms", () => {
  it("computes, from the kernel's defaults, the times worked out by hand", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    // a dead peer on an idle connection: 7200 s idle, then 9 probes 75 s apart
    expect(timerOf(tcp, "keepalive", given(LINUX_66)).duration).toEqual({
      value: 7875,
      unit: "s",
    });
    // a black-holed connection with data in flight: the hypothetical timeout of tcp_retries2,
    // 0.2 s × (2^10 − 1) + 6 × 120 s
    expect(timerOf(tcp, "retrans_giveup", given(LINUX_66)).duration).toEqual({
      value: 924.6,
      unit: "s",
    });
    // a SYN into a black hole: five 1 s waits, then 2, 4, 8, 16, 32 and 64 s
    expect(timerOf(tcp, "syn_giveup", given(LINUX_66)).duration).toEqual({ value: 131, unit: "s" });
    // with linear timeouts off, the classic doubling from 1 s: 127 s
    expect(
      timerOf(
        tcp,
        "syn_giveup",
        given({ ...LINUX_66, tcp_syn_linear_timeouts: { value: 0, unit: "count" } }),
      ).duration,
    ).toEqual({ value: 127, unit: "s" });
    expect(timerOf(tcp, "fin_wait2", given(LINUX_66)).duration).toEqual({ value: 60, unit: "s" });
    expect(timerOf(tcp, "time_wait", given(LINUX_66)).duration).toEqual({ value: 60, unit: "s" });
  });

  it("bounds how late a timer fires by the wheel it waits on, which needs the build's HZ", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    // 6.6 alone does not say HZ, a build option, so how late is unknown and says why
    expect(timerOf(tcp, "keepalive", given(LINUX_66)).lateness).toEqual({
      unknown: "nothing gives hz's value",
      unit: "s",
    });
    // at HZ 250 a 7200 s timer files at the wheel's level of 131.072 s, and each 75 s probe
    // interval at 2.048 s: up to 149.504 s late in all
    expect(timerOf(tcp, "keepalive", given(HERE))).toEqual({
      duration: { value: 7875, unit: "s" },
      lateness: { value: 149.504, unit: "s" },
      early: { value: 0.004, unit: "s" },
    });
    // the give-up lands at most one capped 120 s step past its budget, plus the rounding of the
    // sixteen RTO firings before it: 21.344 s more at HZ 250
    expect(timerOf(tcp, "retrans_giveup", given(HERE))).toEqual({
      duration: { value: 924.6, unit: "s" },
      lateness: { value: 141.344, unit: "s" },
    });
    // each wait of the SYN is a timer of the wheel: five 1 s waits at 8 jiffies, 2 s at 8, 4, 8 and 16 s
    // at 64, and 32 and 64 s at 512. Thus 1264 jiffies, 5.056 s at HZ 250
    expect(timerOf(tcp, "syn_giveup", given(HERE))).toEqual({
      duration: { value: 131, unit: "s" },
      lateness: { value: 5.056, unit: "s" },
    });
    // at HZ 1000 the wait of 64 s is at the level of 4096 jiffies: 6.08 s in all
    expect(timerOf(tcp, "syn_giveup", given({ ...HERE, hz: { value: 1000, unit: "Hz" } })).lateness).toEqual({ value: 6.08, unit: "s" });
  });

  it("sends the SYN again each 1 s for the linear timeouts, the waits of the give-up", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const KIND = given({ ...HERE, hz: { value: 1000, unit: "Hz" } });
    const waits = Array.from({ length: 11 }, (_, fired) => timerOf(tcp, "syn_retransmit", KIND, fired).duration);
    // five waits of 1 s, then 2, 4, 8, 16, 32 and 64 s: the give-up of 131 s
    expect(waits.map((wait) => (wait as { value: number }).value)).toEqual([1, 1, 1, 1, 1, 2, 4, 8, 16, 32, 64]);
    // each wait of 1 s is 1000 jiffies at HZ 1000, up to 64 jiffies late (the kind runners)
    expect(timerOf(tcp, "syn_retransmit", KIND, 0)).toEqual({ duration: { value: 1, unit: "s" }, lateness: { value: 0.064, unit: "s" }, early: { value: 0.001, unit: "s" } });
    // through a stall of 1.309 s from the first SYN, the second retransmission is the first after it
    expect(recovery(tcp, "syn_retransmit", KIND, { value: 1.309, unit: "s" })).toMatchObject({ first: [1], low: { value: 1.998, unit: "s" }, high: { value: 2.128, unit: "s" } });
  });

  it("predicts the harness's scaled cells, where the RTO is the round trip plus 200 ms, in jiffies", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const scaled = {
      ...HERE,
      keepidle: { value: 5, unit: "s" },
      keepintvl: { value: 2, unit: "s" },
      keepcnt: { value: 3, unit: "count" },
    };
    // 5 s idle waits on the 256 ms level, each 2 s interval on the 32 ms one
    expect(timerOf(tcp, "keepalive", given(scaled))).toEqual({
      duration: { value: 11, unit: "s" },
      lateness: { value: 0.352, unit: "s" },
      early: { value: 0.004, unit: "s" },
    });
    // tcp_retries2 = 3: the RTO starts at 204 ms (51 jiffies), so its firings fall at 0.408,
    // 1.224 and 2.856 s, just short of the 3 s budget, and the next is a 3.264 s step later. The
    // harness measured 6.21–6.42 s, where the old bound of 3.2 s allowed only 6.2 s
    expect(
      timerOf(
        tcp,
        "retrans_giveup",
        given({ ...scaled, tcp_retries2: { value: 3, unit: "count" } }),
      ),
    ).toEqual({ duration: { value: 3, unit: "s" }, lateness: { value: 3.616, unit: "s" } });
    // a 20 ms zone link moves the RTO to 220 ms, and so the steps
    expect(
      timerOf(
        tcp,
        "retrans_giveup",
        given({
          ...scaled,
          tcp_retries2: { value: 5, unit: "count" },
          rtt: { value: 20, unit: "ms" },
        }),
      ).lateness,
    ).toEqual({ value: 14.944, unit: "s" });
  });

  it("reads a server's own arithmetic in its own units, and a client's backoff from its formula", async () => {
    // Redis's keepalive is the kernel's (its document runs `over` Linux TCP): anetKeepAlive sets
    // TCP_KEEPIDLE to tcp-keepalive, TCP_KEEPINTVL to a third of it in whole seconds, and three
    // probes, so 300 + 3 × 100 = 600 s
    const redis = await machine("systems.machine.redis-client");
    const linux = await machine("systems.machine.linux-tcp");
    const keepalive = (values: Readonly<Record<string, Extent | Unknown>>) =>
      timerOf(linux, "keepalive", overValues(redis, given(values), given(values)));
    expect(redis.timers["keepalive"]).toBeUndefined();
    expect(keepalive({ tcp_keepalive: { value: 300, unit: "s" } }).duration).toEqual({
      value: 600,
      unit: "s",
    });
    // a third of 301 s is 100 whole seconds, as Redis divides it
    expect(keepalive({ tcp_keepalive: { value: 301, unit: "s" } }).duration).toEqual({
      value: 601,
      unit: "s",
    });
    // so the kernel's wheel rounds it: at 300 s the idle timer files at 16.384 s granularity and
    // each 100 s interval at 2.048 s, a first refresh up to 316.4 s
    const canonical = keepalive({
      tcp_keepalive: { value: 300, unit: "s" },
      hz: { value: 250, unit: "Hz" },
    });
    expect(canonical).toMatchObject({
      lateness: { value: 22.528, unit: "s" },
      early: { value: 0.004, unit: "s" },
    });
    // the harness's scaled 5 s: an interval of 1 s, the least Redis sets
    expect(
      keepalive({ tcp_keepalive: { value: 5, unit: "s" }, hz: { value: 250, unit: "Hz" } }),
    ).toMatchObject({
      duration: { value: 8, unit: "s" },
      lateness: { value: 0.352, unit: "s" },
    });
    // ioredis 6 waits min(2^(times − 1) × 50, 5000) ms between reconnects, plus its jitter, where
    // times counts from 1: one more than how many times its delay has fired since it was ready
    const ioredis = await machine("systems.machine.ioredis-status");
    const delay = (fired: number) => timerOf(ioredis, "retry_delay", given({}), fired).duration;
    expect(delay(0)).toEqual({ value: 0.05, unit: "s" });
    expect(delay(2)).toEqual({ value: 0.2, unit: "s" });
    expect(delay(98)).toEqual({ value: 5, unit: "s" });
  });

  it("gives a backoff timer's waits one at a time, by how many times it has fired", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const wait = (fired: number) => timerOf(tcp, "retransmit", given(HERE), fired);
    // the tail loss probe waits one RTO, 51 jiffies at HZ 250, as the RTO's own first wait does
    const jiffy = { value: 0.004, unit: "s" };
    expect(wait(0)).toEqual({
      duration: { value: 0.204, unit: "s" },
      lateness: jiffy,
      early: jiffy,
    });
    expect(wait(1).duration).toEqual({ value: 0.204, unit: "s" });
    // then each wait doubles, and files on the wheel at its own level: 102 jiffies at 8 of them
    expect(wait(2)).toEqual({
      duration: { value: 0.408, unit: "s" },
      lateness: { value: 0.032, unit: "s" },
      early: jiffy,
    });
    expect(wait(4).duration).toEqual({ value: 1.632, unit: "s" });
    expect(wait(5).lateness).toEqual({ value: 0.256, unit: "s" });
    // up to tcp_rto_max: 0.204 s × 2^11 would be 417.792 s
    expect(wait(12).duration).toEqual({ value: 120, unit: "s" });
    // which wait it is has to be said
    expect(timerOf(tcp, "retransmit", given(HERE)).duration).toEqual({
      unknown: "one wait of a timer with a backoff: say which, by how many times it has fired",
      unit: "s",
    });
    // a timer that runs again gives up on nothing by firing, so it never detects a failure
    const lost = detection(
      tcp,
      { state: "ESTABLISHED", inFlight: true },
      await manifestation("blackhole"),
      given(HERE),
    );
    expect(lost.detectors.map((d) => d.timer)).not.toContain("retransmit");
  });

  it("answers Q4: after a stall, the connection waits for the first retransmission past its end", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const after = (seconds: number) =>
      recovery(tcp, "retransmit", given(HERE), { value: seconds, unit: "s" });
    const s = (value: number) => ({ value, unit: "s" });
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
    // a timer that fires once has no firings after the first to wait for
    expect(() => recovery(tcp, "keepalive", given(HERE), s(1))).toThrow(/has no backoff/);
  });

  it("gives what a machine realizes: a whole timer, or a time of its own over its knobs", async () => {
    const HZ = { hz: { value: 250, unit: "Hz" } };
    // an idle flow is first refreshed when keepalive's first probe goes out: its idle time,
    // rounded once on the wheel. 7200 s files at 131.072 s granularity, 300 s at 16.384 s
    const tcp = await machine("systems.machine.linux-tcp");
    expect(
      realizationOf(tcp, "systems.mechanism.idle-refresh-interval", given({ ...LINUX_66, ...HZ })),
    ).toEqual({
      duration: { value: 7200, unit: "s" },
      lateness: { value: 131.072, unit: "s" },
      early: { value: 0.004, unit: "s" },
    });
    const redis = await machine("systems.machine.redis-client");
    expect(
      realizationOf(
        redis,
        "systems.mechanism.idle-refresh-interval",
        given({ tcp_keepalive: { value: 300, unit: "s" }, ...HZ }),
      )?.lateness,
    ).toEqual({ value: 16.384, unit: "s" });
    // a whole timer is the timer: Redis closes an idle client after `timeout`, never by default.
    // clientsCron counts whole seconds and runs at each serverCron tick, thus the close comes up to
    // 1 s and one tick late: 1.1 s at the default hz of 10
    expect(
      realizationOf(
        redis,
        "systems.mechanism.server-idle-close",
        given({ timeout: { value: "infinite", unit: "s" }, redis_hz: { value: 10, unit: "Hz" } }),
      ),
    ).toEqual({ duration: { value: "infinite", unit: "s" }, lateness: { value: 1.1, unit: "s" } });
    expect(realizationKnobs(redis, "systems.mechanism.idle-refresh-interval")).toEqual([
      "tcp_keepalive",
      "hz",
    ]);
    // and a mechanism the document does not realize has no time here
    expect(realizationOf(redis, "systems.mechanism.middlebox-idle", given({}))).toBeUndefined();
  });

  it("gives the delayed ACK from the round trip, and the ack delay from at once to it", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const at = (rttMs: number, hz: number) =>
      given({ rtt: { value: rttMs, unit: "ms" }, hz: { value: hz, unit: "Hz" } });
    // on a fast path the timer waits TCP_DELACK_MIN, 40 ms, counted from the jiffy before the data
    expect(timerOf(tcp, "delayed_ack", at(0.1, 1000))).toEqual({
      duration: { value: 0.04, unit: "s" },
      lateness: { value: 0.001, unit: "s" },
      early: { value: 0.001, unit: "s" },
    });
    // the ack delay can be 0: in quick-ACK mode the kernel acknowledges at once
    expect(realizationOf(tcp, "systems.mechanism.ack-delay", at(0.1, 250))).toEqual({
      duration: { value: 0.04, unit: "s" },
      lateness: { value: 0.004, unit: "s" },
      early: { value: 0.04, unit: "s" },
    });
    // a round trip of 300 ms meets TCP_DELACK_MAX, 200 ms: 50 jiffies at HZ 250, still on the
    // wheel's level 0, and 200 at HZ 1000, on the 8 ms level
    expect(timerOf(tcp, "delayed_ack", at(300, 250))).toMatchObject({
      duration: { value: 0.2, unit: "s" },
      lateness: { value: 0.004, unit: "s" },
    });
    expect(timerOf(tcp, "delayed_ack", at(300, 1000)).lateness).toEqual({ value: 0.008, unit: "s" });
    // no failure lets data through, thus the delayed ACK detects nothing
    for (const slug of Object.keys(MANIFESTATIONS)) {
      const passes = await manifestation(slug);
      for (const inFlight of [false, true]) {
        const found = detection(tcp, { state: "ESTABLISHED", inFlight }, passes, given(HERE));
        expect(found.detectors.map((d) => d.timer), slug).not.toContain("delayed_ack");
      }
    }
  });

  it("says which knob it lacks, and lets a timer never set run forever", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const { keepcnt: _unsaid, ...lacking } = LINUX_66;
    expect(timerOf(tcp, "keepalive", given(lacking)).duration).toEqual({
      unknown: "nothing gives keepcnt's value",
      unit: "s",
    });
    expect(
      timerOf(tcp, "keepalive", given({ ...LINUX_66, keepidle: { value: "infinite", unit: "s" } }))
        .duration,
    ).toEqual({ value: "infinite", unit: "s" });
    expect(
      evaluate(
        tcp,
        { knob: "tcp_user_timeout", unit: "ms" },
        given({ tcp_user_timeout: { unknown: "no claim says" } }),
      ),
    ).toEqual({
      unknown: "tcp_user_timeout: no claim says",
      unit: "ms",
    });
  });

  it("gives no bound a sign: max(cap − ∞, cap / 2) is cap / 2, and a negative time is unknown", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    // a window that nothing bounds: the cap less it is −∞, which a max discards and a min keeps
    const values = given({ ...LINUX_66, tcp_user_timeout: { value: "infinite", unit: "ms" } });
    const at = (expr: string) => evaluate(tcp, { expr, unit: "ms" }, values);
    expect(at("max(tcp_rto_max - tcp_user_timeout, tcp_rto_max / 2)")).toEqual({
      value: 60_000,
      unit: "ms",
    });
    expect(at("max(tcp_rto_max / 2, tcp_rto_max - tcp_user_timeout)")).toEqual({
      value: 60_000,
      unit: "ms",
    });
    expect(at("min(tcp_rto_max - tcp_user_timeout, tcp_rto_max)")).toEqual({
      unknown: "a negative unbounded time",
      unit: "ms",
    });
    expect(at("min(tcp_user_timeout, tcp_rto_max)")).toEqual({ value: 120_000, unit: "ms" });
    expect(at("max(tcp_user_timeout, tcp_rto_max)")).toEqual({ value: "infinite", unit: "ms" });
    expect(at("tcp_rto_max - (0 - tcp_user_timeout)")).toEqual({ value: "infinite", unit: "ms" });
    expect(at("tcp_user_timeout - tcp_user_timeout")).toEqual({
      unknown: "no bound less no bound",
      unit: "ms",
    });
    expect(at("tcp_rto_max / tcp_user_timeout")).toEqual({ value: 0, unit: "ms" });
  });

  it("raises to a whole power, as a backoff with any multiplier does", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const values = given({ ...LINUX_66, tcp_user_timeout: { value: "infinite", unit: "ms" } });
    const at = (expr: string, fired?: number) => evaluate(tcp, { expr, unit: "ms" }, values, fired);
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

  it("reads every timer of every document, and refuses arithmetic it cannot parse", async () => {
    for (const id of Object.keys(MACHINES)) {
      expect(algebraProblems(await machine(`systems.machine.${id}`)), id).toEqual([]);
    }
    expect(() => parseExpr("keepidle + * keepcnt")).toThrow(/\* is not a term/);
    expect(() => parseExpr("max(1)")).toThrow(/max takes 2, not 1/);
  });
});

describe("detection: the minimum over the detectors still live (Q1–Q3)", () => {
  const ESTABLISHED = { state: "ESTABLISHED", inFlight: false };
  const OFF = { ...LINUX_66, tcp_user_timeout: { value: "infinite", unit: "ms" } } as const;

  it("finds an idle black hole by keepalive, and a black hole in flight by the retransmissions", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    // Q1: nothing is unacknowledged, so only keepalive runs, and nothing comes back to re-arm it
    const idle = detection(tcp, ESTABLISHED, await manifestation("blackhole"), given(OFF));
    expect(idle.first).toEqual({
      timer: "keepalive",
      fires: "timer.keepalive.exhausted",
      duration: { value: 7875, unit: "s" },
    });
    // Q2: the unacknowledged data is retransmitted, which cancels keepalive
    const busy = detection(
      tcp,
      { ...ESTABLISHED, inFlight: true },
      await manifestation("blackhole"),
      given(OFF),
    );
    expect(busy.first).toMatchObject({
      timer: "retrans_giveup",
      duration: { value: 924.6, unit: "s" },
    });
    expect(busy.held).toEqual([{ timer: "keepalive", why: "tx.retransmit.first cancels it" }]);
    // a 30 s TCP_USER_TIMEOUT beats the ladder
    const bounded = detection(
      tcp,
      { ...ESTABLISHED, inFlight: true },
      await manifestation("blackhole"),
      given({ ...LINUX_66, tcp_user_timeout: { value: 30000, unit: "ms" } }),
    );
    expect(bounded.first).toMatchObject({
      timer: "user_timeout",
      duration: { value: 30000, unit: "ms" },
    });
  });

  it("finds nothing at TCP when the process freezes and its kernel keeps answering (Q3)", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    for (const inFlight of [false, true]) {
      const frozen = detection(
        tcp,
        { ...ESTABLISHED, inFlight },
        await manifestation("freeze-process"),
        given(OFF),
      );
      // the kernel acknowledges the data, so nothing is retransmitted, and it answers every probe
      expect(frozen.first).toBeNull();
      expect(frozen.detectors).toEqual([]);
      expect(frozen.held).toEqual([
        { timer: "keepalive", why: "rx.ack keeps arriving and re-arms it" },
      ]);
    }
  });

  it("says so when a socket has no keepalive, and when a live detector's time is unknown", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    // a client that never sets SO_KEEPALIVE: an idle black hole is never noticed at TCP
    const bare = detection(
      tcp,
      ESTABLISHED,
      await manifestation("blackhole"),
      given({ ...OFF, keepidle: { value: "infinite", unit: "s" } }),
    );
    expect(bare.first).toBeNull();
    expect(bare.detectors.map((detector) => detector.timer)).toEqual(["keepalive"]);
    // with TCP_USER_TIMEOUT unknown, the retransmissions' 924.6 s is only an upper bound
    const open = detection(
      tcp,
      { ...ESTABLISHED, inFlight: true },
      await manifestation("blackhole"),
      given(LINUX_66),
    );
    expect(open.first?.timer).toBe("retrans_giveup");
    expect(open.unsettled).toEqual(["user_timeout"]);
  });
});

describe("what a failure delivers, the errno it sets, and the durations it changes", () => {
  const reverted: Manifestation = {
    name: "unreachable-host",
    passes: [],
    errno: { errno: "EHOSTUNREACH", timers: ["retrans_giveup", "user_timeout"] },
    replaces: {
      retrans_giveup: {
        lateness: {
          model: "linux.retrans-step-reverted",
          knobs: ["tcp_retries2", "tcp_rto_min", "tcp_rto_max", "rtt", "hz"],
          unit: "s",
        },
      },
    },
  };

  it("detects a FIN that the failure delivers at once, with no errno", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const fin = detection(
      tcp,
      { state: "ESTABLISHED", inFlight: false },
      { name: "fin", passes: [], delivers: ["rx.fin"] },
      given(HERE),
    );
    expect(fin.delivered).toEqual([{ event: "rx.fin", to: "CLOSE_WAIT", errno: null }]);
    // a delivered event that no transition takes from the state detects nothing
    const none = detection(
      tcp,
      { state: "ESTABLISHED", inFlight: false },
      { name: "x", passes: [], delivers: ["rx.synack"] },
      given(HERE),
    );
    expect(none.delivered).toEqual([]);
  });

  it("reports the soft errno of an ICMP at the timeout of a retransmission, and not of keepalive", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const giveUp = { timer: "retrans_giveup", fires: "timer.rto.exhausted" };
    const keepalive = { timer: "keepalive", fires: "timer.keepalive.exhausted" };
    expect(errnoOf(tcp, "ESTABLISHED", giveUp, reverted)).toBe("EHOSTUNREACH");
    // a keepalive probe quotes snd_una − 1, outside the window, thus tcp_v4_err drops its ICMP
    expect(errnoOf(tcp, "ESTABLISHED", keepalive, reverted)).toBe("ETIMEDOUT");
    const blackhole = { name: "blackhole", passes: [] };
    expect(errnoOf(tcp, "ESTABLISHED", giveUp, blackhole)).toBe("ETIMEDOUT");
  });

  it("gives the give-up under the revert of RFC 6069 at most one RTO after its budget", async () => {
    const tcp = await machine("systems.machine.linux-tcp");
    const values = given({ ...HERE, tcp_retries2: { value: 3, unit: "count" } });
    // the budget is the same, 3.0 s. The step is one RTO of 51 jiffies, not the doubled 816
    expect(timerUnder(tcp, "retrans_giveup", values, reverted)).toMatchObject({
      duration: { value: 3, unit: "s" },
      lateness: { value: 0.268, unit: "s" },
    });
    expect(timerOf(tcp, "retrans_giveup", values).lateness).toEqual({ value: 3.616, unit: "s" });
  });
});
