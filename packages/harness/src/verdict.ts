import type { Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";
import type { Prediction } from "./cell.ts";
import type { Measured } from "./observe.ts";

/**
 * This amount is the noise of the pipeline itself, δ_abs, as the calibration measured it. It is
 * the 99.9th percentile of the whole latency of a reset, at the concurrency cap or less. Its
 * minimum is one jiffy. On 2026-10-12 the worst of 60 resets at 1 and 4 environments took
 * 1.141 ms, thus the minimum sets it to 4 ms. The calibration occurs again after each change to
 * the harness, the kernel or Docker.
 */
export const NOISE: Quantity = quantity(4, "ms");
/** This fraction, δ_rel, is how far the median of a cell can be outside the prediction and stay equivalent. */
export const RELATIVE = 0.05;
/** These are the run counts of a cell: 11, then 22 and 44 while its median crosses the edge of the band. */
export const STEPS = [11, 22, 44] as const;

/** A decision is the result of a verdict. */
export type Decision = "holds" | "fails" | "extend" | "inconclusive";

/** An interval is a range of times. */
export interface Interval {
  readonly low: Quantity;
  readonly high: Quantity;
}

/** A verdict is the judgement of a cell on its runs. */
export interface Verdict {
  readonly decision: Decision;
  readonly counted: number;
  readonly voided: number;
  /** This band is where each run must land: [T_lo − δ_abs, T_hi + δ_abs]. It is null for a silent prediction. */
  readonly band: Interval | null;
  /** These are the runs outside the band, and the reason for each. Each is a finding. */
  readonly outside: ReadonlyArray<{ readonly run: string; readonly why: string }>;
  readonly median: Quantity | null;
  /** This interval is the order-statistic interval of the median at 95 %, or the whole range for fewer than six runs. */
  readonly medianInterval: Interval | null;
  readonly why: string;
}

const s = (value: number): Quantity => quantity(Math.round(value * 1e6) / 1e6, "s");
const name = (run: Measured): string => `env ${run.environment} run ${run.index}`;

/** This function gives P(X ≤ j) for X ~ Binomial(n, 1/2), exactly. */
const below = (n: number, j: number): number => {
  let term = 1;
  let sum = 0;
  for (let i = 0; i <= j; i += 1) {
    sum += term;
    term = (term * (n - i)) / (i + 1);
  }
  return sum / 2 ** n;
};

/**
 * This function gives the distribution-free interval of a median: [x_(k), x_(n+1−k)], for the
 * largest k whose two tails each hold 2.5 % or less. For eleven runs, it gives [x_(2), x_(10)],
 * at 98.8 %.
 */
export const medianInterval = (sorted: readonly number[]): [number, number] => {
  const n = sorted.length;
  let k = 0;
  while (k + 1 <= n / 2 && below(n, k) <= 0.025) k += 1;
  return k === 0 ? [sorted[0]!, sorted[n - 1]!] : [sorted[k - 1]!, sorted[n - k]!];
};

const middle = (sorted: readonly number[]): number => {
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};

/**
 * This function gives the verdict of a cell, from two tests:
 * - Containment: each run lands in [T_lo − δ_abs, T_hi + δ_abs]. A run outside is a finding.
 * - Median equivalence: the interval of the median is in the band, made wider by δ_rel. An
 *   interval outside the band fails. An interval across its edge extends the cell to 22 runs, then
 *   44, and then the verdict is inconclusive.
 *
 * A silent prediction holds only if no run detected the fault in its window. After a stall, the
 * return of the reply gets the same test as a detection, by its interval, and a detection is a
 * finding. The distribution test (a DKW band) needs a predicted distribution from a simulator,
 * which does not exist at this time.
 */
export const verdictOf = (prediction: Prediction, runs: readonly Measured[]): Verdict => {
  const counted = runs.filter((run) => run.void === null);
  const voided = runs.length - counted.length;
  const outside = counted
    .filter((run) => run.finding !== null)
    .map((run) => ({ run: name(run), why: run.finding! }));
  const empty = { counted: counted.length, voided, median: null, medianInterval: null };
  if (counted.length === 0)
    return { ...empty, decision: "inconclusive", band: null, outside, why: "no run counted" };

  if (!prediction.detects && prediction.recovers === undefined) {
    const decision = outside.length === 0 ? "holds" : "fails";
    const why =
      decision === "holds"
        ? `nothing detected it in ${counted.length} runs of ${valueIn(prediction.window, "s")} s`
        : `${outside.length} of ${counted.length} runs detected it`;
    return { ...empty, decision, band: null, outside, why };
  }

  // the interval of a detection, or of the return of the reply after a stall
  const timed = prediction.detects ? prediction : prediction.recovers!;
  const noise = valueIn(NOISE, "s");
  const low = valueIn(timed.low, "s");
  const high = valueIn(timed.high, "s");
  const band = { low: s(low - noise), high: s(high + noise) };
  const values: number[] = [];
  for (const run of counted) {
    if (run.elapsed === null) continue;
    const value = valueIn(run.elapsed, "s");
    values.push(value);
    if (value < low - noise || value > high + noise)
      outside.push({
        run: name(run),
        why: `${value} s is outside [${band.low.value}, ${band.high.value}] s`,
      });
  }
  values.sort((a, b) => a - b);
  if (values.length === 0)
    return { ...empty, decision: "fails", band, outside, why: "no run measured its time" };
  const [from, to] = medianInterval(values);
  const median = s(middle(values));
  const interval = { low: s(from), high: s(to) };
  const wide = { low: low * (1 - RELATIVE), high: high * (1 + RELATIVE) };
  const inside = from >= wide.low && to <= wide.high;
  const disjoint = to < wide.low || from > wide.high;
  const counts = `${counted.length - outside.length} of ${counted.length} runs inside [${band.low.value}, ${band.high.value}] s`;
  const centre = `median ${median.value} s, its interval [${interval.low.value}, ${interval.high.value}] s`;
  const result = {
    counted: counted.length,
    voided,
    band,
    outside,
    median,
    medianInterval: interval,
  };
  if (outside.length > 0 || disjoint)
    return { ...result, decision: "fails", why: `${counts}; ${centre}` };
  if (inside) return { ...result, decision: "holds", why: `${counts}; ${centre}` };
  const decision = counted.length < STEPS[2] ? "extend" : "inconclusive";
  return { ...result, decision, why: `${counts}; ${centre} straddles the band` };
};
