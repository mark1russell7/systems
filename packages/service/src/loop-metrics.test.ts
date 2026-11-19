// Law 11 of the loop core (SYS-138 part 2): the metrics of the entry `/otel` count the records of the loop. On random
// schedules and scripted rounds, each counter and each histogram agrees with the records, and `loop.inflight` agrees
// with `inFlight()` until the stop.

import { captureTelemetry, type OwnSdkTelemetryCapture } from "@mark1russell7/rigor-testkit/otel";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { Case } from "./loop-rig.ts";
import { base, caseOf, fail, HORIZON, ms, pass, rig } from "./loop-rig.ts";
import type { LoopRecord, RoundEnd } from "./loop.ts";
import { LOOP_BOUNDS, loopErrorType, loopMetrics } from "./otel.ts";
import { seeded } from "./testing.ts";

/** The runs of the law. A deeper run sets LOOP_LAW_RUNS. */
const RUNS = Number(process.env["LOOP_LAW_RUNS"] ?? 100);

/** The value of one point: a number for a sum, the count, the sum and the bounds for a histogram. */
type Value = number | { readonly count: number; readonly sum: number; readonly boundaries: readonly number[] };

interface Point {
  readonly metric: string;
  readonly unit: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly value: Value;
}

interface RawPoint {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly value: number | { readonly count: number; readonly sum?: number; readonly buckets: { readonly boundaries: readonly number[] } };
}

/** This function collects the points after the last collection (the reader of the capture uses the delta temporality). */
const collect = async (capture: OwnSdkTelemetryCapture): Promise<Point[]> => {
  const { resourceMetrics } = await capture.metricReader.collect();
  return resourceMetrics.scopeMetrics.flatMap((scope) =>
    scope.metrics.flatMap((metric) =>
      (metric.dataPoints as readonly RawPoint[]).map(
        (point): Point => ({
          metric: metric.descriptor.name,
          unit: metric.descriptor.unit,
          attributes: point.attributes,
          value: typeof point.value === "number" ? point.value : { count: point.value.count, sum: point.value.sum ?? 0, boundaries: point.value.buckets.boundaries },
        }),
      ),
    ),
  );
};

/** The key of a series: its metric and its attributes, in the order of their names. */
const keyOf = (metric: string, attributes: Readonly<Record<string, unknown>>): string =>
  `${metric} ${JSON.stringify(Object.keys(attributes).sort().map((name) => [name, attributes[name]]))}`;

/** The totals of each series over one or more collections: a sum, or a count and a sum of a histogram. */
const totals = (points: readonly Point[]): Map<string, { count: number; sum: number }> => {
  const out = new Map<string, { count: number; sum: number }>();
  for (const point of points) {
    const key = keyOf(point.metric, point.attributes);
    const total = out.get(key) ?? { count: 0, sum: 0 };
    if (typeof point.value === "number") total.sum += point.value;
    else {
      total.count += point.value.count;
      total.sum += point.value.sum;
    }
    out.set(key, total);
  }
  return out;
};

/** The totals that the records give, in the form of `totals`. Each series that has no record is absent. */
const expected = (records: readonly LoopRecord[]): Map<string, { count: number; sum: number }> => {
  const out = new Map<string, { count: number; sum: number }>();
  const add = (metric: string, attributes: Record<string, unknown>, count: number, sum: number): void => {
    const key = keyOf(metric, attributes);
    const total = out.get(key) ?? { count: 0, sum: 0 };
    total.count += count;
    total.sum += sum;
    out.set(key, total);
  };
  for (const record of records) {
    const on = { "loop.name": record.loop, "loop.lane": record.lane };
    if (record.kind === "start") {
      add("loop.rounds", on, 0, 1);
      add("loop.lateness", on, 1, (record.start - record.planned) / 1000);
    } else if (record.kind === "end") {
      const tagged = record.outcome === "fail" ? { ...on, "error.type": loopErrorType(record) } : on;
      if (record.outcome === "fail") add("loop.failures", tagged, 0, 1);
      if (!record.blocked) add("loop.round.duration", tagged, 1, (record.end - record.start) / 1000);
    } else if (record.kind === "skip") add("loop.skipped", on, 0, record.count);
    else add("loop.deferred", on, 0, 1);
  }
  return out;
};

/** The sum of `loop.inflight` over each lane. */
const inflightOf = (all: Map<string, { count: number; sum: number }>): number =>
  [...all].filter(([key]) => key.startsWith("loop.inflight ")).reduce((sum, [, total]) => sum + total.sum, 0);

const captures: OwnSdkTelemetryCapture[] = [];
const capture = (): OwnSdkTelemetryCapture => {
  const made = captureTelemetry();
  captures.push(made);
  return made;
};

afterEach(async () => {
  for (const made of captures.splice(0)) await made.shutdown();
});

/** This function operates a case with the metrics on a tap, and gives the totals at the stop and after it. */
const operate = async (each: Case) => {
  const telemetry = capture();
  const meters = loopMetrics(telemetry.meterProvider.getMeter("law-11"));
  const r = rig(each.schedule, (round) => each.scripts[(round - 1) % each.scripts.length]!, { random: seeded(each.seed), tap: meters });
  r.handle.start();
  await r.fake.advance(each.stopAt);
  const before = await collect(telemetry);
  const inFlight = r.handle.inFlight();
  await r.handle.stop().catch(() => undefined);
  await r.fake.advance(HORIZON);
  const after = await collect(telemetry);
  return { r, before, after, inFlight };
};

describe("law 11: the metrics count the records", () => {
  it("each counter and histogram agrees with the records, and loop.inflight agrees with inFlight() until the stop, then falls to zero", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(caseOf(), caseOf({ budget: true, stable: true, timeout: true })), async (each) => {
        const { r, before, after, inFlight } = await operate(each);
        const atStop = totals(before);
        expect(inflightOf(atStop), "loop.inflight at the stop").toBe(inFlight);
        const all = totals([...before, ...after]);
        expect(inflightOf(all), "loop.inflight after the stop").toBe(0);
        const want = expected(r.records);
        for (const [key, total] of want) {
          const got = all.get(key) ?? { count: 0, sum: 0 };
          expect(got.count, key).toBe(total.count);
          expect(got.sum, key).toBeCloseTo(total.sum, 9);
        }
        // no series without a record: the zero points of a delta collection aside
        for (const [key, total] of all)
          if (!key.startsWith("loop.inflight ") && (total.count !== 0 || total.sum !== 0)) expect(want.has(key), key).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("the instruments", () => {
  it("have the units of the semantic conventions, and the histograms have the bounds of LOOP_BOUNDS in seconds", async () => {
    const telemetry = capture();
    const r = rig(base({ period: ms(100), overlap: "fail" }), (round) => (round === 1 ? pass(150) : fail(10)), { tap: loopMetrics(telemetry.meterProvider.getMeter("units")) });
    r.handle.start();
    await r.fake.advance(400);
    const points = await collect(telemetry);
    const units = Object.fromEntries(points.map((point) => [point.metric, point.unit]));
    expect(units).toEqual({
      "loop.rounds": "{round}",
      "loop.failures": "{round}",
      "loop.lateness": "s",
      "loop.round.duration": "s",
      "loop.inflight": "{round}",
    });
    const bounds = (metric: string) => points.find((point) => point.metric === metric && typeof point.value !== "number")?.value as { boundaries: readonly number[] };
    expect(bounds("loop.lateness").boundaries).toEqual(LOOP_BOUNDS.lateness);
    expect(bounds("loop.round.duration").boundaries).toEqual(LOOP_BOUNDS.duration);
    // round 1 holds the lane past the period: the round due at 100 is blocked, a failure with no start and no duration
    const blocked = points.filter((point) => point.attributes["error.type"] === "blocked");
    expect(blocked.map((point) => point.metric)).toEqual(["loop.failures"]);
    await r.handle.stop();
  });

  it("count each period that a late loop skips, and its lateness in seconds", async () => {
    const telemetry = capture();
    const r = rig(base({ period: ms(100) }), () => pass(10), { tap: loopMetrics(telemetry.meterProvider.getMeter("late-loop")) });
    r.handle.start();
    await r.fake.advance(50);
    // a blocked event loop: the timer of the round due at 100 starts at 450, and the rounds due at 200, 300 and 400 do not occur
    r.fake.block(400);
    await r.fake.advance(0);
    const skips = r.records.filter((record) => record.kind === "skip");
    expect(skips.map((record) => record.count)).toEqual([3]);
    const all = totals(await collect(telemetry));
    const on = { "loop.name": "l", "loop.lane": 0 };
    expect(all.get(keyOf("loop.skipped", on))?.sum).toBe(3);
    expect(all.get(keyOf("loop.lateness", on))).toEqual({ count: 2, sum: 0.35 });
    await r.handle.stop();
  });

  it("keep a round past its timeout in loop.inflight until its late answer", async () => {
    const telemetry = capture();
    const r = rig(base({ period: ms(1000), timeout: ms(50) }), () => ({ duration: 100, outcome: "pass", ignores: true }), {
      tap: loopMetrics(telemetry.meterProvider.getMeter("late")),
    });
    r.handle.start();
    await r.fake.advance(60);
    const late = totals(await collect(telemetry));
    expect(inflightOf(late)).toBe(1);
    expect(late.get(keyOf("loop.failures", { "loop.name": "l", "loop.lane": 0, "error.type": "timeout" }))?.sum).toBe(1);
    // a round past its timeout gives the timeout as its duration
    expect(late.get(keyOf("loop.round.duration", { "loop.name": "l", "loop.lane": 0, "error.type": "timeout" }))).toEqual({ count: 1, sum: 0.05 });
    await r.fake.advance(50);
    expect(inflightOf(totals(await collect(telemetry)))).toBe(-1);
    expect(r.handle.inFlight()).toBe(0);
    await r.handle.stop();
  });
});

describe("loopErrorType", () => {
  const end = (patch: Partial<RoundEnd>): RoundEnd => ({
    kind: "end",
    loop: "l",
    lane: 0,
    round: 1,
    planned: 0,
    start: 0,
    end: 1,
    outcome: "fail",
    timedOut: false,
    blocked: false,
    error: undefined,
    ...patch,
  });
  class QueueGone extends Error {}

  it("names a timeout, a blocked round and a round with no proof, then the class of the error, then _OTHER", () => {
    expect(loopErrorType(end({ timedOut: true, error: new Error("late") }))).toBe("timeout");
    expect(loopErrorType(end({ blocked: true }))).toBe("blocked");
    const unproved = new Error("no proof");
    unproved.name = "UnprovedRoundError";
    expect(loopErrorType(end({ error: unproved }))).toBe("unproved");
    // the class, not the field name: a subclass that keeps the name "Error" still gives its class
    expect(loopErrorType(end({ error: new QueueGone("gone") }))).toBe("QueueGone");
    expect(loopErrorType(end({ error: new TypeError("x") }))).toBe("TypeError");
    expect(loopErrorType(end({ error: "a string" }))).toBe("_OTHER");
    expect(loopErrorType(end({ error: undefined }))).toBe("_OTHER");
  });
});
