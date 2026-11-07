import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Rung, RungRecord } from "@mark1russell7/rigor-bench";
import { rungVerdict } from "@mark1russell7/rigor-bench";
import type { Completion, LoadMeasure, Schedule } from "@mark1russell7/rigor-chaos";
import { measureLoad, schedule, scheduleHeld } from "@mark1russell7/rigor-chaos";
import { quantile } from "@mark1russell7/rigor-statistics";
import type { LoadPrediction, LoadStream, ProbeEvent, RunStream } from "./cell.ts";

/**
 * The measure and the verdict of an open-loop cell (SYS-68). A client on a schedule sends each
 * arrival at its time, thus a stall counts in each arrival that it delayed. The package rigor-chaos
 * counts each latency from the planned time. The package rigor-bench judges a quantile by a
 * distribution-free interval.
 */

/** This path is where the client of an open-loop cell finds its schedule. */
export const SCHEDULE_PATH = "/tmp/schedule.json";

/** This function gives the time of a line of the client, in ms from the start of the schedule. */
const fromStart = (start: number, t: number): number => (t - start) / 1e6;

/**
 * This function gives the measure of one run of a schedule from the lines of its client. It gives
 * null when the client did not start the schedule. The first `sent` line of a client is its request
 * before `ready`, and it names no arrival. The end of the run is its last line.
 */
export const loadOf = (events: readonly ProbeEvent[], plan: Schedule): RunLoad | null => {
  const start = events.find((event) => event.ev === "scheduled")?.t;
  if (start === undefined) return null;
  return measureOf(events, start, plan, undefined);
};

/**
 * A run load is the measure of one run of a schedule. `failed` counts the replies with a status
 * outside 200 to 299. Such a reply is a completion, thus its time is in `latency`. The client
 * `schedule` gives no status, and a record from before this field has none: both read as 0.
 */
export type RunLoad = LoadMeasure & { readonly failed?: number };

/** This function tells if a status of a reply is a failure: a number outside 200 to 299. */
const failedStatus = (status: unknown): boolean => typeof status === "number" && (status < 200 || status > 299);

/** This function gives the measure of the arrivals of one stream: the lines with the key `key`, or each line for no key. */
const measureOf = (events: readonly ProbeEvent[], start: number, plan: Schedule, key: string | undefined): RunLoad => {
  const sent = new Map<number, number>();
  const done = new Map<number, number>();
  let failed = 0;
  for (const event of events) {
    const index = event["i"];
    if (typeof index !== "number" || (key !== undefined && event["k"] !== key)) continue;
    if (event.ev === "sent") sent.set(index, fromStart(start, event.t));
    if (event.ev === "replied") {
      done.set(index, fromStart(start, event.t));
      if (failedStatus(event["status"])) failed += 1;
    }
  }
  const completions: Completion[] = [...sent].map(([index, at]) => ({ index, sent: at, done: done.get(index) ?? null }));
  const end = events.reduce((latest, event) => Math.max(latest, fromStart(start, event.t)), 0);
  return { ...measureLoad(plan, completions, end), failed };
};

/** This path is where the client `load` finds its plan. */
export const LOAD_PATH = "/tmp/load.json";

/** This text is the format of the plan of the client `load`. */
export const LOAD_FORMAT = "systems-load/1";

/**
 * This function gives the schedule of each stream of a cell, and the text of the plan of the client
 * `load`. It throws for no stream, for two streams with one key and for a stream with no request.
 */
export const loadPlanOf = (streams: readonly LoadStream[]): { readonly streams: readonly RunStream[]; readonly content: string } => {
  if (streams.length === 0) throw new RangeError("a plan of the client load has no stream");
  const keys = new Set<string>();
  for (const stream of streams) {
    if (keys.has(stream.key)) throw new RangeError(`two streams have the key ${stream.key}`);
    if (stream.requests.length === 0) throw new RangeError(`the stream ${stream.key} has no request`);
    keys.add(stream.key);
  }
  const scheduled = streams.map((stream) => ({ key: stream.key, schedule: schedule(stream.plan.profile, stream.plan.options), requests: stream.requests }));
  return {
    streams: scheduled.map(({ key, schedule: each }) => ({ key, schedule: each })),
    content: JSON.stringify({ format: LOAD_FORMAT, streams: scheduled }),
  };
};

/**
 * This function gives the measure of each stream of a run of the client `load`, and their pool. Each
 * stream counts its arrivals from 0, thus the lines of a stream are the lines with its key. The pool
 * sums the counts and joins the times, in the order of the streams. It gives null when the client did
 * not start its schedule.
 */
export const streamsLoadOf = (
  events: readonly ProbeEvent[],
  streams: readonly RunStream[],
): { readonly pool: RunLoad; readonly streams: Readonly<Record<string, RunLoad>> } | null => {
  const start = events.find((event) => event.ev === "scheduled")?.t;
  if (start === undefined) return null;
  const each = streams.map((stream) => [stream.key, measureOf(events, start, stream.schedule, stream.key)] as const);
  const measures = each.map(([, measure]) => measure);
  const sum = (count: (measure: RunLoad) => number) => measures.reduce((total, measure) => total + count(measure), 0);
  const join = (times: (measure: RunLoad) => readonly number[]) => measures.flatMap(times);
  return {
    pool: {
      planned: sum((measure) => measure.planned),
      unsent: sum((measure) => measure.unsent),
      unfinished: sum((measure) => measure.unfinished),
      failed: sum((measure) => measure.failed ?? 0),
      latency: join((measure) => measure.latency),
      service: join((measure) => measure.service),
      lag: join((measure) => measure.lag),
      censored: join((measure) => measure.censored),
    },
    streams: Object.fromEntries(each),
  };
};

/** A load spread is a part of the distribution of one measure of an open-loop cell, over its counted runs. */
export interface LoadSpread {
  readonly p50: Quantity;
  readonly p99: Quantity;
  readonly max: Quantity;
}

/**
 * A load verdict sums the schedule of an open-loop cell over its counted runs. `latency` counts from
 * the planned time, and `service` counts from the send: the measure of a closed-loop driver. Each
 * arrival with no reply counts in `latency` at its age at the end of its run, a lower bound.
 */
export interface LoadVerdict {
  readonly planned: number;
  readonly unsent: number;
  readonly unfinished: number;
  /** This count is the replies with a status of a failure, over the counted runs. */
  readonly failed: number;
  readonly latency: LoadSpread | null;
  readonly service: LoadSpread | null;
  readonly lag: LoadSpread | null;
  /** This text is the verdict of each band, in the order of the prediction. */
  readonly bands: readonly string[];
  /** This text is the verdict of the share of failed arrivals, when the prediction has a limit on it. */
  readonly failures?: string;
}

/** This function gives the spread of a list of times in ms, or null for no time. */
const spreadOf = (values: readonly number[]): LoadSpread | null =>
  values.length === 0
    ? null
    : {
        p50: quantity(quantile(values, 0.5, "nearest-rank"), "ms"),
        p99: quantity(quantile(values, 0.99, "nearest-rank"), "ms"),
        max: quantity(values.reduce((most, value) => Math.max(most, value), 0), "ms"),
      };

/** This time is the date of the record of a band and the date of its verdict. The record has no age, because it comes from this run. */
const NOW = "2026-01-01T00:00:00.000Z";

/**
 * This function judges one band of the latency over the pooled arrivals of the counted runs. The
 * top of the band reads the interval of rigor-bench: the band holds only if the interval is under its top.
 * The latencies of one run can follow each other, thus the width of the interval is an estimate.
 * The bottom of the band reads the quantile itself. It gives the text of the verdict, and if it holds.
 */
const bandVerdict = (
  band: LoadPrediction["bands"][number],
  values: readonly number[],
  censored: readonly number[],
): { readonly holds: boolean; readonly words: string } => {
  const high = valueIn(band.high, "ms");
  const rung: Rung = {
    name: "band",
    at: {},
    budgets: [{ kind: "quantile", measure: "latency", unit: "ms", quantile: band.quantile, limit: high }],
    test: "the cell",
  };
  const record: RungRecord = {
    rung: "band",
    commit: "the cell",
    at: NOW,
    real: ["the counted runs"],
    synthetic: [],
    evidence: [{ kind: "quantile", measure: "latency", values, censored }],
  };
  const top = rungVerdict(rung, record, { now: NOW });
  const read = values.length + censored.length === 0 ? null : quantile([...values, ...censored], band.quantile, "nearest-rank");
  const low = band.low === undefined ? null : valueIn(band.low, "ms");
  const above = low === null || (read !== null && read >= low);
  const place = low === null ? `under ${high} ms` : `in [${low}, ${high}] ms`;
  // the rung judges only the top of the band: a read under its bottom is not within the band
  const outcome = top.outcome === "within" && !above ? "under the bottom of the band" : top.outcome;
  return {
    holds: top.outcome === "within" && above,
    words: `p${band.quantile * 100} of the latency ${read === null ? "has no value" : `is ${read} ms`}, wanted ${place}: ${outcome}. ${top.reason}`,
  };
};

/**
 * This function judges the share of failed arrivals over the counted runs against a limit. Each
 * planned arrival is a trial. An arrival fails if the client did not send it. It also fails with no
 * reply at the end of its run, or with the status of a failure. The rate budget of rigor-bench
 * reads the upper end of the Wilson interval at 0.95. Thus 381 arrivals with no failure hold a limit
 * of 1 %, and fewer arrivals cannot decide.
 */
const failuresVerdict = (limit: number, failures: number, trials: number): { readonly holds: boolean; readonly words: string } => {
  const rung: Rung = { name: "failures", at: {}, budgets: [{ kind: "rate", measure: "failures", limit }], test: "the cell" };
  const record: RungRecord = {
    rung: "failures",
    commit: "the cell",
    at: NOW,
    real: ["the counted runs"],
    synthetic: [],
    evidence: [{ kind: "rate", measure: "failures", failures, trials }],
  };
  const verdict = rungVerdict(rung, record, { now: NOW });
  return {
    holds: verdict.outcome === "within",
    words: `${failures} of ${trials} arrivals failed, wanted a share under ${limit * 100} %: ${verdict.outcome}. ${verdict.reason}`,
  };
};

/** This record is what the verdict of a cell takes from its load: the runs that broke the schedule, and the sum. */
export interface LoadJudgement {
  readonly holds: boolean;
  readonly outside: ReadonlyArray<{ readonly run: string; readonly why: string }>;
  readonly load: LoadVerdict;
}

/**
 * This function judges the load of an open-loop cell over its counted runs. A run that did not keep
 * its schedule measures its driver, not the target, thus it is a finding of that run. Each
 * band reads all the arrivals of the counted runs.
 */
export const loadVerdict = (
  prediction: LoadPrediction,
  runs: ReadonlyArray<{ readonly name: string; readonly load: RunLoad | undefined }>,
): LoadJudgement => {
  const limit = valueIn(prediction.lag, "ms");
  const outside = runs.flatMap((run) => {
    if (run.load === undefined) return [{ run: run.name, why: "the client never started its schedule" }];
    const check = scheduleHeld(run.load, limit);
    return check.held ? [] : [{ run: run.name, why: check.reason }];
  });
  const measures = runs.flatMap((run) => (run.load === undefined ? [] : [run.load]));
  const latency = measures.flatMap((measure) => measure.latency);
  const censored = measures.flatMap((measure) => measure.censored);
  const bands = prediction.bands.map((band) => bandVerdict(band, latency, censored));
  const total = (count: (measure: RunLoad) => number) => measures.reduce((sum, measure) => sum + count(measure), 0);
  const planned = total((measure) => measure.planned);
  const unsent = total((measure) => measure.unsent);
  const unfinished = total((measure) => measure.unfinished);
  const failed = total((measure) => measure.failed ?? 0);
  const failures = prediction.failures === undefined ? undefined : failuresVerdict(prediction.failures, unsent + unfinished + failed, planned);
  return {
    holds: runs.length > 0 && outside.length === 0 && bands.every((band) => band.holds) && (failures?.holds ?? true),
    outside,
    load: {
      planned,
      unsent,
      unfinished,
      failed,
      latency: spreadOf([...latency, ...censored]),
      service: spreadOf(measures.flatMap((measure) => measure.service)),
      lag: spreadOf(measures.flatMap((measure) => measure.lag.map((lag) => Math.abs(lag)))),
      bands: bands.map((band) => band.words),
      ...(failures === undefined ? {} : { failures: failures.words }),
    },
  };
};
