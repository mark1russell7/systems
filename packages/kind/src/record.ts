import type { Quantity } from "@mark1russell7/quantity";
import { seconds } from "./bands.ts";
import type { Band, KindCell, KindRun, Prediction, Trigger, WindowPrediction } from "./cell.ts";
import type { KindScenario } from "./scenario.ts";
import type { KindVerdict, Propagated, RunCheck, RunFacts } from "./verdict.ts";
import { judgeKind, unitOf } from "./verdict.ts";

/**
 * This module is the raw record of a kind cell: its formats, and the upgrade from the format `/1`
 * to the format `/2`. The lab writes `/2`, and it does not write `/1` again. A reader reads a record
 * of `/1` through `upgrade`, and the meaning of each value stays the same.
 */

/** This format is the format that the lab writes. Each amount in it is a quantity. */
export const FORMAT = "systems.kind-cell-record/2";
/** This format is the first format. Its bands, its medians and its times are numbers. */
export const FORMAT_V1 = "systems.kind-cell-record/1";

/** A load sample is what the VM did in 4 s before a run: when (a stamp of the wall clock in milliseconds), its idle share, and its busiest processes. */
export interface LoadSample {
  readonly t: number;
  readonly idle: number;
  readonly top: readonly string[];
  readonly foreign: readonly string[];
}

/** A cluster manifest is what a run records about its cluster: the versions, the images, the nodes and the mode as read back. */
export interface ClusterManifest {
  readonly kind: string;
  readonly nodeImage: string;
  readonly server: string;
  readonly mode: string;
  readonly docker: string;
  readonly nodes: ReadonlyArray<{
    readonly name: string;
    readonly kubelet: string;
    readonly kernel: string;
    readonly runtime: string;
    readonly os: string;
  }>;
}

/** An environment manifest is one cluster of a cell: its scenario, what the cluster was, and the images of the lab. */
export interface EnvironmentManifest {
  readonly env: number;
  readonly scenario: KindScenario;
  readonly cluster: ClusterManifest;
  readonly images: Readonly<Record<string, string>>;
}

/**
 * A kind cell result is a cell, its runs over its environments, the manifest of each environment,
 * and its verdict. The parameter `A` is the form of an amount.
 */
export interface KindCellResult<A = Quantity> {
  readonly cell: KindCell<A>;
  readonly runs: readonly KindRun[];
  readonly manifests: readonly EnvironmentManifest[];
  readonly loads: readonly LoadSample[];
  readonly verdict: KindVerdict<A>;
  /** This text is the time of the verdict, in ISO 8601. */
  readonly at: string;
}

/** A kind cell record is the raw record of a cell in the format `/2`: a result with its format. */
export interface KindCellRecord extends KindCellResult {
  readonly format: typeof FORMAT;
}

/** A kind cell record of the format `/1` gives each band, median, main value and time of a fact as a number. */
export interface KindCellRecordV1 extends KindCellResult<number> {
  readonly format: typeof FORMAT_V1;
}

/** These are the parts of the format `/1`, with numbers for amounts. */
export type BandV1 = Band<number>;
export type PredictionV1 = Prediction<number>;
export type TriggerV1 = Trigger<number>;
export type KindCellV1 = KindCell<number>;
export type KindVerdictV1 = KindVerdict<number>;
export type RunCheckV1 = RunCheck<number>;
export type RunFactsV1 = RunFacts<number>;

const time = (value: number | null): Quantity | null => (value === null ? null : seconds(value));
const band = (old: BandV1): Band => ({ lo: seconds(old.lo), hi: seconds(old.hi) });
/** The format `/1` gives each part of `cpu.max` in microseconds. */
const microseconds = (value: number): Quantity => ({ value, unit: "us" });

const upgradeTrigger = (trigger: TriggerV1): Trigger => {
  const { cpuMax, ...rest } = trigger;
  return cpuMax === undefined ? rest : { ...rest, cpuMax: { quota: microseconds(cpuMax.quota), period: microseconds(cpuMax.period) } };
};

const upgradeWindow = (window: WindowPrediction<number>): WindowPrediction => {
  const { afterReset, propagation, ...rest } = window;
  return {
    ...rest,
    start: { from: window.start.from, band: band(window.start.band) },
    end: window.end === null ? null : { from: window.end.from, band: band(window.end.band) },
    ...(afterReset === undefined ? {} : { afterReset: { life: seconds(afterReset.life), outcome: afterReset.outcome } }),
    ...(propagation === undefined ? {} : { propagation: band(propagation) }),
  };
};

const upgradePrediction = (prediction: PredictionV1): Prediction => {
  switch (prediction.kind) {
    case "window":
      return upgradeWindow(prediction);
    // the format /1 has no prediction `ends`, but its type does
    case "ends": {
      const { window, answer, ...rest } = prediction;
      return {
        ...rest,
        band: prediction.band === null ? null : band(prediction.band),
        ...(window === undefined ? {} : { window: upgradeWindow(window) }),
        ...(answer === undefined ? {} : { answer: band(answer) }),
      };
    }
    // the format /1 has no window on `removal` and `leaves`, but their types do
    case "removal":
    case "leaves": {
      const { window, ...rest } = prediction;
      return { ...rest, band: band(prediction.band), ...(window === undefined ? {} : { window: upgradeWindow(window) }) };
    }
    case "restarts":
      return { ...prediction, band: prediction.band === null ? null : band(prediction.band) };
    // the format /1 has no failures on `stays`, but its type does
    case "stays": {
      const { failures, ...rest } = prediction;
      return { ...rest, ...(failures === undefined ? {} : { failures: failures.kind === "window" ? upgradeWindow(failures) : failures }) };
    }
    default:
      return prediction;
  }
};

/** This function gives a cell of the format `/1` in the format `/2`: its bands in seconds, and its `cpu.max` in microseconds. */
export const upgradeCell = (cell: KindCellV1): KindCell => ({
  ...cell,
  trigger: upgradeTrigger(cell.trigger),
  prediction: upgradePrediction(cell.prediction),
});

const upgradeFacts = (facts: RunFactsV1): RunFacts => {
  const propagated = (old: Propagated<number> | null): Propagated | null => (old === null ? null : { after: time(old.after), by: seconds(old.by) });
  const byKey = (record: Readonly<Record<string, Propagated<number> | null>>) => Object.fromEntries(Object.entries(record).map(([key, old]) => [key, propagated(old)]));
  const { sliceEmpty, rules, left, signals, updates, healUpdates, closes, cycles, ...rest } = facts;
  return {
    ...rest,
    intakeAfterDeletion: time(facts.intakeAfterDeletion),
    sliceAfter: time(facts.sliceAfter),
    propagation: byKey(facts.propagation),
    ...(updates === undefined ? {} : { updates: byKey(updates) }),
    ...(healUpdates === undefined ? {} : { healUpdates: byKey(healUpdates) }),
    ...(sliceEmpty === undefined ? {} : { sliceEmpty: seconds(sliceEmpty) }),
    ...(rules === undefined ? {} : { rules: Object.fromEntries(Object.entries(rules).map(([node, old]) => [node, time(old)])) }),
    ...(left === undefined ? {} : { left: seconds(left) }),
    ...(signals === undefined ? {} : { signals: signals.map((old) => time(old)) }),
    ...(closes === undefined ? {} : { closes: Object.fromEntries(Object.entries(closes).map(([client, old]) => [client, time(old)])) }),
    ...(cycles === undefined ? {} : { cycles: cycles.map((old) => ({ empty: time(old.empty), ready: time(old.ready) })) }),
  };
};

/**
 * This function gives a record in the format `/2`. A record of `/2` comes back as it is. A record
 * of `/1` gets each amount as a quantity, and each value stays the same:
 * - Each band and each time of a fact is in seconds, as `/1` gives it.
 * - The `cpu.max` of a throttle is in microseconds, as `/1` gives it.
 * - The median and the main value of each run get the unit of the prediction (`unitOf`): seconds,
 *   failed requests (`{request}`) or replicas (`{replica}`).
 */
export const upgrade = (record: KindCellRecordV1 | KindCellRecord): KindCellRecord => {
  if (record.format === FORMAT) return record;
  const unit = unitOf(record.cell.prediction);
  const amount = (value: number | null): Quantity | null => (value === null ? null : { value, unit });
  const verdict = record.verdict;
  return {
    format: FORMAT,
    cell: upgradeCell(record.cell),
    runs: record.runs,
    manifests: record.manifests,
    loads: record.loads,
    verdict: {
      ...verdict,
      median: amount(verdict.median),
      checks: verdict.checks.map((check) => ({ ...check, value: amount(check.value), facts: upgradeFacts(check.facts) })),
    },
    at: record.at,
  };
};

/**
 * This function judges a record again, from its cell and its runs, with the judge of this version.
 * It reads a record of `/1` through `upgrade`. The verdict is in the format `/2`.
 */
export const judge = (record: KindCellRecordV1 | KindCellRecord): KindVerdict => {
  const current = upgrade(record);
  return judgeKind(current.cell, current.runs);
};
