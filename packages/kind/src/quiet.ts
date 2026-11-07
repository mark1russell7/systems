import { median } from "@mark1russell7/rigor-statistics";

/**
 * The quiet gate asks for an idle share of the VM before a run. The clients of the cell run at that
 * time, and the agent of each node reads the whole conntrack table each second. Thus the idle share
 * has the load of the cell in it. A flat share can void a heavy cell with no other load (SYS-95).
 * The gate reads the cell against itself. The baseline is the idle share of the settled cell, and
 * a foreign load shows as a fall from the baseline.
 */

/** These numbers are the terms of the gate. Each share is a share of all the CPUs of the VM. */
export interface QuietGate {
  /** This share is enough for each cell, as it was before SYS-95. */
  readonly flat: number;
  /** This share is the most fall from the baseline that the gate lets through. */
  readonly margin: number;
  /** This share is the least that the gate lets through, with any baseline. */
  readonly floor: number;
  /** This time in milliseconds is the age of a cell at its first baseline sample. */
  readonly settle: number;
  /** This count is the samples of a baseline. */
  readonly samples: number;
}

/**
 * These are the terms of the lab. The flat share is the share of SYS-42. The other terms come from the
 * calibration of SYS-95, over the 9 records of SYS-57, with no foreign container in them:
 *
 * - The margin is the 99th percentile of the fall from the settled median of an environment: 4.88
 *   points of 93 samples, rounded up.
 * - The floor is the lowest settled median of an environment, 48 %, minus the margin.
 * - The time to settle holds the slowest environment. Its conntrack table was at its plateau at 105 s.
 */
export const QUIET_GATE: QuietGate = { flat: 0.6, margin: 0.05, floor: 0.43, settle: 120_000, samples: 3 };

/**
 * This function gives the idle share that a run needs. With no baseline, it is the floor: a warm-up
 * counts for nothing, and its table is not full yet. A cell that is at rest at the flat share or more
 * keeps the flat share.
 */
export const neededIdle = (gate: QuietGate, baseline: number | null): number =>
  baseline === null ? gate.floor : Math.min(gate.flat, Math.max(gate.floor, baseline - gate.margin));

/** This function gives the reason of a sample that the gate refuses. The site reads it back with `NOT_QUIET`. */
export const quietWhy = (idle: number, needed: number, foreign: readonly string[]): string =>
  `${Math.round(idle * 100)}% idle, the gate needs ${Math.round(needed * 100)}%, other lab containers: ${foreign.join("; ") || "none"}`;

/**
 * This form reads the void of a run that the gate refuses. Its groups are the wait in seconds, the idle share, the share
 * of the gate and the other lab containers. A record from before SYS-95 has no share of the gate.
 */
export const NOT_QUIET: RegExp = /^the VM was not quiet in (\d+) s: (\d+)% idle(?:, the gate needs (\d+)%)?, other lab containers: (.*)$/;

/**
 * This function gives the next baseline of a cell from the samples of one environment. Samples with
 * a foreign container do not count. The highest median holds, because a foreign load only lowers
 * the idle share. Thus a load in one environment does not move the gate of the other one.
 */
export const baselineOf = (previous: number | null, samples: ReadonlyArray<{ readonly idle: number; readonly foreign: readonly string[] }>): number | null => {
  const clean = samples.filter((sample) => sample.foreign.length === 0).map((sample) => sample.idle);
  if (clean.length === 0) return previous;
  const middle = median(clean);
  return previous === null ? middle : Math.max(previous, middle);
};
