import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Extent, Unknown } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { Manifestation } from "./algebra.ts";
import {
  algebraProblems,
  detection,
  evaluate,
  overValues,
  parseExpr,
  realizationKnobs,
  realizationOf,
  recovery,
  timerOf,
} from "./algebra.ts";
import type { Machine } from "./machine.ts";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** a machine document, by its id in a graph: systems.machine.linux-tcp is fixtures/linux-tcp.json */
const machine = async (id: string): Promise<Machine> =>
  JSON.parse(await readFile(join(fixtures, `${id.split(".").at(-1)}.json`), "utf8")) as Machine;

/** a manifestation: the events it still lets through to Linux TCP */
const manifestation = async (slug: string): Promise<Manifestation> => {
  const passes = JSON.parse(await readFile(join(fixtures, "manifestations.json"), "utf8")) as Record<
    string,
    string[]
  >;
  const through = passes[slug];
  if (through === undefined) throw new Error(`no fixture says what ${slug} lets through`);
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
    // a whole timer is the timer: Redis closes an idle client after `timeout`, never by default
    expect(
      realizationOf(
        redis,
        "systems.mechanism.server-idle-close",
        given({ timeout: { value: "infinite", unit: "s" } }),
      ),
    ).toEqual({ duration: { value: "infinite", unit: "s" } });
    expect(realizationKnobs(redis, "systems.mechanism.idle-refresh-interval")).toEqual([
      "tcp_keepalive",
      "hz",
    ]);
    // and a mechanism the document does not realize has no time here
    expect(realizationOf(redis, "systems.mechanism.middlebox-idle", given({}))).toBeUndefined();
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

  it("reads every timer of the four documents, and refuses arithmetic it cannot parse", async () => {
    for (const id of [
      "systems.machine.linux-tcp",
      "systems.machine.nf-conntrack-tcp",
      "systems.machine.ioredis-status",
      "systems.machine.redis-client",
    ]) {
      expect(algebraProblems(await machine(id)), id).toEqual([]);
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
