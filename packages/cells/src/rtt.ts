import type { Prediction, RttRange } from "@mark1russell7/harness";
import { NOISE } from "@mark1russell7/harness";
import { valueIn } from "@mark1russell7/quantity";

/** A band is the interval of a prediction in seconds, with the name of what it times. A silent or measurement-only prediction has none. */
interface Band {
  readonly what: string;
  readonly low: number;
  readonly high: number;
}

const bandOf = (prediction: Prediction): Band | null => {
  if (prediction.detects === true)
    return {
      what: `${prediction.timer} ${prediction.errno} ${prediction.from}`,
      low: valueIn(prediction.low, "s"),
      high: valueIn(prediction.high, "s"),
    };
  if (prediction.detects === false && prediction.recovers !== undefined)
    return {
      what: `firing ${prediction.recovers.firing}`,
      low: valueIn(prediction.recovers.low, "s"),
      high: valueIn(prediction.recovers.high, "s"),
    };
  if (prediction.detects === false && prediction.replies !== undefined)
    return { what: "reply", low: valueIn(prediction.replies.low, "s"), high: valueIn(prediction.replies.high, "s") };
  return null;
};

/** This time is how far past the nominal round trip the search goes, in ms. A band that stays the same that far does not read the round trip. */
const REACH = 1000;
/** This time is the resolution of the edges of a range, in ms: 1 µs. */
const RESOLUTION = 0.001;

/**
 * This function gives the range of the first round trip that a prediction assumes. `at` gives
 * the prediction at a round trip in ms, and `nominal` is the round trip that the models of the
 * cell read. The range holds each round trip where the band is the band at `nominal`. Each edge
 * stays within δ_abs, and the timer stays the same.
 *
 * An example is a ladder of the RTO. At HZ 250,
 * its RTO is the same number of jiffies for each round trip up to 4 ms. A larger round trip adds
 * one jiffy to each wait. A prediction that throws at a round trip has no band there.
 *
 * The search doubles its step out from `nominal`, then halves the last step to 1 µs. It gives
 * undefined for a band that has no edge `REACH` past `nominal`: such a band does not read the
 * round trip.
 */
export const rttRange = (at: (rtt: number) => Prediction, nominal: number): RttRange | undefined => {
  const base = bandOf(at(nominal));
  if (base === null) return undefined;
  const noise = valueIn(NOISE, "s") + 1e-9;
  const same = (rtt: number): boolean => {
    try {
      const band = bandOf(at(rtt));
      return (
        band !== null &&
        band.what === base.what &&
        Math.abs(band.low - base.low) <= noise &&
        Math.abs(band.high - base.high) <= noise
      );
    } catch {
      return false;
    }
  };
  /** This function gives the farthest round trip from `nominal` toward `limit` with the same band. It gives undefined when the band is the same up to the limit. */
  const edge = (limit: number): number | undefined => {
    const direction = Math.sign(limit - nominal);
    let good = nominal;
    let bad = Number.NaN;
    for (let step = 0.25; Number.isNaN(bad); step *= 2) {
      const next = nominal + direction * step;
      const candidate = direction * (next - limit) >= 0 ? limit : next;
      if (!same(candidate)) bad = candidate;
      else if (candidate === limit) return undefined;
      else good = candidate;
    }
    while (Math.abs(bad - good) > RESOLUTION) {
      const middle = (good + bad) / 2;
      if (same(middle)) good = middle;
      else bad = middle;
    }
    return good;
  };
  const high = edge(nominal + REACH);
  if (high === undefined) return undefined;
  const low = nominal > 0 ? (edge(0) ?? 0) : 0;
  const ms = (value: number) => ({ value: Math.round(value * 1000) / 1000, unit: "ms" });
  return {
    low: ms(Math.max(0, Math.ceil(low / RESOLUTION - 1e-6) * RESOLUTION)),
    high: ms(Math.floor(high / RESOLUTION + 1e-6) * RESOLUTION),
  };
};

/** This function gives the prediction at the nominal round trip, with the range of round trips that its band assumes. */
export const assuming = (at: (rtt: number) => Prediction, nominal: number): Prediction => {
  const prediction = at(nominal);
  if (prediction.detects === null) return prediction;
  const rtt = rttRange(at, nominal);
  return rtt === undefined ? prediction : { ...prediction, rtt };
};
