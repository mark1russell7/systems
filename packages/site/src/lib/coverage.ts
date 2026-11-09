/**
 * The floors of the coverage (SYS-109). Each package gets a floor for its lines, its functions and its branches. The
 * floor of a measure is the worst value of the runs on main, less the spread of those values, rounded down to 0.1.
 * The file `coverage-floors.json` at the root of the repository keeps the floors, the ids of the runs and the formula.
 * The Vitest config of each package reads its floors from that file, thus a run under a floor fails.
 *
 * The functions of this file have no input or output. The script `scripts/coverage-floors.ts` downloads the
 * artifact `coverage` of each run with `gh`, and the tests give the functions fixtures.
 */

/** The measures that get a floor. Vitest gives the share of each measure as a percent. */
export const MEASURES = ["lines", "functions", "branches"] as const;

/** One measure of the coverage. */
export type Measure = (typeof MEASURES)[number];

/** The fewest runs that give a floor (the rule of 2026-11-02 for limits). */
export const MINIMUM_RUNS = 5;

/** The formula of a floor, as the file gives it. */
export const FORMULA = "floor = rounddown(worst - (best - worst), 0.1), over the runs; the percent of each measure, from coverage-summary.json";

/** The percent of each measure for one package in one run. */
export type Shares = Readonly<Record<Measure, number>>;

/** The coverage of one CI run on main: the percent of each measure, for each package. */
export interface CoverageRun {
  /** The id of the GitHub Actions run. */
  readonly id: string;
  /** The commit of the run. */
  readonly commit: string;
  readonly packages: Readonly<Record<string, Shares>>;
}

/** The file `coverage-floors.json`. */
export interface FloorsFile {
  readonly formula: string;
  /** The runs that gave the floors, with their commits. */
  readonly runs: readonly { readonly id: string; readonly commit: string }[];
  /** The floors of each package. The Vitest config of a package gives this object to `coverage.thresholds`. */
  readonly floors: Readonly<Record<string, Shares>>;
  /** The worst value of each measure, over the runs. */
  readonly worst: Readonly<Record<string, Shares>>;
  /** The spread (the best value less the worst value) of each measure, over the runs. */
  readonly spread: Readonly<Record<string, Shares>>;
}

/** This function rounds a percent down to 0.1. The small step absorbs the error of the float product. */
export const roundDown = (percent: number): number => Number((Math.floor(percent * 10 + 1e-9) / 10).toFixed(1));

/** This function gives the floor of the values of one measure: the worst value less the spread, rounded down to 0.1. */
export const floorOf = (values: readonly number[]): number => {
  if (values.length === 0) throw new Error("A floor needs one value or more.");
  const worst = Math.min(...values);
  const best = Math.max(...values);
  return Math.max(0, roundDown(worst - (best - worst)));
};

/** This function gives the percent of each measure from the `total` of a file coverage-summary.json of Vitest. */
export const sharesOf = (summary: unknown): Shares => {
  const total = (summary as { total?: Record<string, { pct?: unknown }> } | null)?.total;
  const out: Partial<Record<Measure, number>> = {};
  for (const measure of MEASURES) {
    const pct = total?.[measure]?.pct;
    if (typeof pct !== "number" || !Number.isFinite(pct)) throw new Error(`The summary has no percent for ${measure}.`);
    out[measure] = pct;
  }
  return out as Shares;
};

/**
 * This function gives the file of the floors from the runs. It needs `MINIMUM_RUNS` runs or more, of different
 * commits, and each run must give each package. A package that is not in each run has no floor yet. The function
 * names it in the error, thus the person removes it or waits for more runs.
 */
export const floorsOf = (runs: readonly CoverageRun[]): FloorsFile => {
  if (runs.length < MINIMUM_RUNS) throw new Error(`A floor needs ${MINIMUM_RUNS} runs or more, not ${runs.length}.`);
  const commits = new Set(runs.map((run) => run.commit));
  if (commits.size !== runs.length) throw new Error("Two runs have the same commit. Each run must be of a different commit.");
  const names = [...new Set(runs.flatMap((run) => Object.keys(run.packages)))].sort();
  const floors: Record<string, Shares> = {};
  const worst: Record<string, Shares> = {};
  const spread: Record<string, Shares> = {};
  for (const name of names) {
    const missing = runs.filter((run) => run.packages[name] === undefined).map((run) => run.id);
    if (missing.length > 0) throw new Error(`The package ${name} is not in the runs ${missing.join(", ")}.`);
    const each = (fn: (values: number[]) => number): Shares => {
      const out: Partial<Record<Measure, number>> = {};
      for (const measure of MEASURES) out[measure] = fn(runs.map((run) => (run.packages[name] as Shares)[measure]));
      return out as Shares;
    };
    floors[name] = each(floorOf);
    worst[name] = each((values) => Math.min(...values));
    spread[name] = each((values) => Number((Math.max(...values) - Math.min(...values)).toFixed(2)));
  }
  return {
    formula: FORMULA,
    runs: [...runs].sort((a, b) => a.id.localeCompare(b.id)).map((run) => ({ id: run.id, commit: run.commit })),
    floors,
    worst,
    spread,
  };
};
