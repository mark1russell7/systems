// The statistics of a kind verdict: the median, the interval of the median and a quantile. They are
// the statistics of the verdict of the harness, and a test holds them to it. The judge reads a
// record without the harness, because the harness loads its Docker lab. The median and the quantile
// come from @mark1russell7/rigor-statistics.
import { median, quantileSorted } from "@mark1russell7/rigor-statistics";

/** This fraction, δ_rel, is how far the median of a cell can be outside its band and stay equivalent. */
export const RELATIVE = 0.05;

/**
 * This function gives the median of sorted values: the middle value, or the mean of the two middle values.
 * It is `median` of @mark1russell7/rigor-statistics, which throws a RangeError for an empty list.
 */
export const middle = (sorted: readonly number[]): number => median(sorted);

/**
 * This function gives the value at quantile p of sorted values, by nearest rank: x_(⌈p·n⌉). It is
 * `quantileSorted` of @mark1russell7/rigor-statistics with the method `"nearest-rank"`.
 */
export const quantileOf = (sorted: readonly number[], p: number): number => quantileSorted(sorted, p, "nearest-rank");

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
// TODO(npm): use medianInterval of @mark1russell7/rigor-statistics 0.1.3 (mark1russell7/rigor#17) after its release.
export const medianInterval = (sorted: readonly number[]): [number, number] => {
  const n = sorted.length;
  let k = 0;
  while (k + 1 <= n / 2 && below(n, k) <= 0.025) k += 1;
  return k === 0 ? [sorted[0]!, sorted[n - 1]!] : [sorted[k - 1]!, sorted[n - k]!];
};
