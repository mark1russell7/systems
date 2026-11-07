import { quantity } from "@mark1russell7/quantity";
import { constant, measureLoad, schedule } from "@mark1russell7/rigor-chaos";
import type { Completion, LoadMeasure, Schedule } from "@mark1russell7/rigor-chaos";
import { describe, expect, it } from "vitest";
import type { LoadPrediction, ProbeEvent } from "./cell.ts";
import { LOAD_FORMAT, loadOf, loadPlanOf, loadVerdict, streamsLoadOf } from "./load.ts";

/** This schedule is 100 arrivals each second for 5 s: 500 arrivals, 10 ms apart. */
const PLAN: Schedule = schedule(constant(100, 5_000), { arrivals: "uniform" });

/** This time is the start of the schedule on the clock of the client, in ns. */
const START = 1_000_000_000;

/** This function gives a line of the client. */
const line = (ev: string, ms: number, fields: Record<string, unknown> = {}): ProbeEvent => ({ ev, t: START + ms * 1e6, ...fields });

/** This function gives a measure in which each arrival has the reply time that `service` gives, and is `late` ms behind its plan. */
const measured = (service: (index: number) => number | null, late = 0): LoadMeasure => {
  const completions: Completion[] = PLAN.times.map((planned, index) => {
    const reply = service(index);
    return { index, sent: planned + late, done: reply === null ? null : planned + late + reply };
  });
  return measureLoad(PLAN, completions, 6_000);
};

const P99_UNDER_10: LoadPrediction = { lag: quantity(50, "ms"), bands: [{ quantile: 0.99, high: quantity(10, "ms") }] };

/** This function gives the judgement of `load` as four equal runs. */
const judged = (load: LoadMeasure, prediction: LoadPrediction = P99_UNDER_10) =>
  loadVerdict(prediction, ["a", "b", "c", "d"].map((name) => ({ name, load })));

describe("the measure of a schedule", () => {
  it("reads each arrival from the lines that name it, from the start of the schedule", () => {
    const load = loadOf(
      [
        line("sent", -500),
        line("data", -499),
        line("scheduled", 0),
        line("sent", 5, { i: 0 }),
        line("replied", 6, { i: 0 }),
        line("sent", 15, { i: 1 }),
        line("deadline", 100),
      ],
      PLAN,
    );
    expect(load).toMatchObject({ planned: 500, unsent: 498, unfinished: 1 });
    expect(load?.latency).toEqual([1]);
    expect(load?.service).toEqual([1]);
    expect(load?.lag).toEqual([0, 0]);
  });

  it("is null when the client never started its schedule", () => {
    expect(loadOf([line("sent", -500), line("error", 1)], PLAN)).toBeNull();
  });

  it("counts a stall in each arrival behind it, from its planned time", () => {
    // the stall ends at 1,000 ms, and each arrival before that gets its reply there
    const events = PLAN.times.flatMap((planned, i) => [line("sent", planned, { i }), line("replied", Math.max(planned + 1, 1_000), { i })]);
    const load = loadOf([line("scheduled", 0), ...events], PLAN);
    expect(load?.latency[0]).toBeCloseTo(995);
    expect(load?.latency[50]).toBeCloseTo(495);
    expect(load?.latency[200]).toBeCloseTo(1);
  });
});

describe("the plan of the client load", () => {
  const plan = { profile: constant(100, 5_000), options: { arrivals: "uniform" as const } };
  const request = "GET /doc HTTP/1.1\r\nHost: reference\r\n\r\n";

  it("writes the schedule and the requests of each stream in the format of the driver", () => {
    const { streams, content } = loadPlanOf([
      { key: "a", plan, requests: [request] },
      { key: "b", plan, requests: [request, request] },
    ]);
    const written = JSON.parse(content) as { format: string; streams: Array<{ key: string; schedule: Schedule; requests: string[] }> };
    expect(written.format).toBe(LOAD_FORMAT);
    expect(written.streams.map((stream) => [stream.key, stream.requests.length])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(written.streams[0]?.requests[0]).toBe(request);
    // the run keeps the same schedule that the driver read, thus each latency counts from its own planned time
    expect(streams.map((stream) => stream.key)).toEqual(["a", "b"]);
    expect(written.streams[0]?.schedule).toEqual(streams[0]?.schedule);
    expect(streams[0]?.schedule).toEqual(PLAN);
  });

  it("throws for no stream, for two streams with one key and for a stream with no request", () => {
    expect(() => loadPlanOf([])).toThrow(RangeError);
    expect(() => loadPlanOf([{ key: "a", plan, requests: [request] }, { key: "a", plan, requests: [request] }])).toThrow(/two streams have the key a/);
    expect(() => loadPlanOf([{ key: "a", plan, requests: [] }])).toThrow(/the stream a has no request/);
  });
});

describe("the measure of the streams of the client load", () => {
  const streams = [
    { key: "a", schedule: PLAN },
    { key: "b", schedule: PLAN },
  ];
  const first = PLAN.times[0]!;

  it("gives each stream the lines with its key, and the pool of the streams", () => {
    // both streams count their arrivals from 0, thus the key alone tells the two first arrivals apart
    const read = streamsLoadOf(
      [
        line("connected", -10, { k: "a", local: "10.0.0.2:40000" }),
        line("connected", -9, { k: "b", local: "10.0.0.2:40002" }),
        line("ready", -8, { streams: 2 }),
        line("scheduled", 0, { streams: 2, arrivals: 1_000 }),
        line("sent", first, { k: "a", i: 0 }),
        line("sent", first, { k: "b", i: 0 }),
        line("replied", first + 2, { k: "a", i: 0, status: 200 }),
        line("replied", first + 7, { k: "b", i: 0, status: 200 }),
        line("sent", first + 10, { k: "b", i: 1 }),
        line("deadline", 100),
      ],
      streams,
    );
    expect(read?.streams["a"]).toMatchObject({ planned: 500, unsent: 499, unfinished: 0, latency: [2] });
    expect(read?.streams["b"]).toMatchObject({ planned: 500, unsent: 498, unfinished: 1, latency: [7] });
    expect(read?.pool).toMatchObject({ planned: 1_000, unsent: 997, unfinished: 1, latency: [2, 7], service: [2, 7] });
    expect(read?.pool.censored).toEqual([...read!.streams["a"]!.censored, ...read!.streams["b"]!.censored]);
    expect(read?.pool.lag).toEqual([0, 0, 0]);
  });

  it("is null when the client never started its schedule", () => {
    expect(streamsLoadOf([line("ready", -8), line("error", 1, { k: "a", errno: "ECONNRESET" })], streams)).toBeNull();
  });
});

describe("the verdict of a schedule", () => {
  it("holds when each run keeps its schedule and the band holds", () => {
    const judgement = judged(measured(() => 1));
    expect(judgement.holds).toBe(true);
    expect(judgement.outside).toEqual([]);
    expect(judgement.load).toMatchObject({ planned: 2_000, unsent: 0, unfinished: 0 });
    expect(judgement.load.latency?.p99).toEqual(quantity(1, "ms"));
    expect(judgement.load.service?.max).toEqual(quantity(1, "ms"));
  });

  it("fails a run whose sends are past the limit, and names the run", () => {
    const judgement = judged(measured(() => 1, 60));
    expect(judgement.holds).toBe(false);
    expect(judgement.outside.map((run) => run.run)).toEqual(["a", "b", "c", "d"]);
  });

  it("fails a run with an arrival it did not send", () => {
    const completions: Completion[] = PLAN.times.slice(1).map((planned, index) => ({ index: index + 1, sent: planned, done: planned + 1 }));
    const judgement = judged(measureLoad(PLAN, completions, 6_000));
    expect(judgement.holds).toBe(false);
    expect(judgement.load.unsent).toBe(4);
  });

  it("fails a band over its top, with the number in its words", () => {
    const judgement = judged(measured(() => 20));
    expect(judgement.holds).toBe(false);
    expect(judgement.load.bands[0]).toContain("is 20 ms");
    expect(judgement.load.bands[0]).toContain("beyond");
  });

  it("fails a band under its bottom: a stall that went away is a lost target", () => {
    const low: LoadPrediction = { lag: quantity(50, "ms"), bands: [{ quantile: 0.99, low: quantity(5, "ms"), high: quantity(10, "ms") }] };
    const under = judged(measured(() => 1), low);
    expect(under.holds).toBe(false);
    expect(under.load.bands[0]).toContain("wanted in [5, 10] ms: under the bottom of the band.");
    expect(judged(measured(() => 7), low).holds).toBe(true);
  });

  it("counts an arrival with no reply in the band at its age, thus a lost tail does not lower the quantile", () => {
    // 2 % of the arrivals have no reply at 6 s
    const judgement = judged(measured((index) => (index % 50 === 0 ? null : 1)));
    expect(judgement.holds).toBe(false);
    expect(judgement.load.unfinished).toBe(40);
    expect(judgement.load.latency?.p99).not.toEqual(quantity(1, "ms"));
  });

  it("cannot decide on too few values, and that is not a pass", () => {
    const short = schedule(constant(100, 100), { arrivals: "uniform" });
    const load = measureLoad(short, short.times.map((planned, index) => ({ index, sent: planned, done: planned + 1 })), 200);
    const judgement = loadVerdict(P99_UNDER_10, [{ name: "a", load }]);
    expect(judgement.holds).toBe(false);
    expect(judgement.load.bands[0]).toContain("cannot decide");
  });

  it("does not hold with no run, or with a run that never started", () => {
    expect(loadVerdict(P99_UNDER_10, []).holds).toBe(false);
    expect(loadVerdict(P99_UNDER_10, [{ name: "a", load: undefined }]).outside).toEqual([{ run: "a", why: "the client never started its schedule" }]);
  });
});
