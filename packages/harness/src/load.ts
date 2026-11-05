import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Rung, RungRecord } from "@mark1russell7/rigor-bench";
import { rungVerdict } from "@mark1russell7/rigor-bench";
import type { Completion, LoadMeasure, Schedule } from "@mark1russell7/rigor-chaos";
import { measureLoad, scheduleHeld } from "@mark1russell7/rigor-chaos";
import { quantile } from "@mark1russell7/rigor-statistics";
import type { LoadPrediction, ProbeEvent } from "./cell.ts";

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
export const loadOf = (events: readonly ProbeEvent[], plan: Schedule): LoadMeasure | null => {
  const start = events.find((event) => event.ev === "scheduled")?.t;
  if (start === undefined) return null;
  const sent = new Map<number, number>();
  const done = new Map<number, number>();
  for (const event of events) {
    const index = event["i"];
    if (typeof index !== "number") continue;
    if (event.ev === "sent") sent.set(index, fromStart(start, event.t));
    if (event.ev === "replied") done.set(index, fromStart(start, event.t));
  }
  const completions: Completion[] = [...sent].map(([index, at]) => ({ index, sent: at, done: done.get(index) ?? null }));
  const end = events.reduce((latest, event) => Math.max(latest, fromStart(start, event.t)), 0);
  return measureLoad(plan, completions, end);
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
  readonly latency: LoadSpread | null;
  readonly service: LoadSpread | null;
  readonly lag: LoadSpread | null;
  /** This text is the verdict of each band, in the order of the prediction. */
  readonly bands: readonly string[];
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
  return {
    holds: top.outcome === "within" && above,
    words: `p${band.quantile * 100} of the latency ${read === null ? "has no value" : `is ${read} ms`}, wanted ${place}: ${top.outcome}. ${top.reason}`,
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
  runs: ReadonlyArray<{ readonly name: string; readonly load: LoadMeasure | undefined }>,
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
  return {
    holds: runs.length > 0 && outside.length === 0 && bands.every((band) => band.holds),
    outside,
    load: {
      planned: measures.reduce((sum, measure) => sum + measure.planned, 0),
      unsent: measures.reduce((sum, measure) => sum + measure.unsent, 0),
      unfinished: measures.reduce((sum, measure) => sum + measure.unfinished, 0),
      latency: spreadOf([...latency, ...censored]),
      service: spreadOf(measures.flatMap((measure) => measure.service)),
      lag: spreadOf(measures.flatMap((measure) => measure.lag.map((lag) => Math.abs(lag)))),
      bands: bands.map((band) => band.words),
    },
  };
};
