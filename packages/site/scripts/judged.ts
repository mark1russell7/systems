// The parts that the exports of the harness cells share: sentinel.ts, http.ts and mongodb.ts.
//
// Each export reads each raw record with the code of the harness (`judge`), and it stops when that
// verdict disagrees with the line of the cell in summary.ndjson. The copy of a cell keeps its
// verdict, the time of each counted run and of each warm-up, and the reason of each void run. It
// keeps no boot id, image digest, container, namespace inode, address, user or path.

import type { Cell, Manifest, Measured, Run, Verdict } from "../../harness/src/index.ts";
import { judge, measure, RELATIVE } from "../../harness/src/index.ts";
import type { Found } from "./records.ts";
import { round, secondsOf, timeAt, voidsOf } from "./records.ts";

/** A record is the raw record of one cell, as the runner of @systems/cells writes it. */
export interface CellRecord {
  readonly cell: Cell;
  readonly manifests: readonly Manifest[];
  readonly runs: readonly Run[];
  readonly warmups?: readonly Run[];
  readonly at: { readonly started: string; readonly ended: string };
}
/** A summary is one line of summary.ndjson: the verdict of a cell at the time of its run. */
export interface Summary {
  readonly name: string;
  readonly decision: string;
  readonly counted: number;
  readonly voided: number;
  readonly median: { readonly value: number } | null;
  readonly warmups: readonly (number | string)[];
}

/** These phrases name the reference of a time, in a sentence. */
export const FROM: Readonly<Record<string, string>> = {
  fault: "the fault",
  "last-received": "the last segment that the client received",
  "request-sent": "the send of the request",
  "first-retransmission": "the first retransmission of the RTO timer",
  "peer-closed": "the close of the socket of the peer",
};

/** This function gives the outcome of a run in one word: the errno, EOF, or the kind of the outcome. */
export const outcomeOf = (run: Measured): string =>
  run.outcome.kind === "error" ? run.outcome.errno : run.outcome.kind === "eof" ? "EOF" : run.outcome.kind;

/** A reading is a record that the harness judged again: its measures, its verdict and its warm-ups. */
export interface Reading {
  readonly cell: Cell;
  readonly measured: readonly Measured[];
  readonly verdict: Verdict;
  readonly warmups: readonly Measured[];
}

/** This function reads one record with the harness, and stops when the harness disagrees with summary.ndjson. */
export const read = (entry: Found<CellRecord, Summary>): Reading => {
  const { record, summary } = entry;
  const { cell } = record;
  const { measured, verdict } = judge(cell, record.runs);
  if (
    verdict.decision !== summary.decision ||
    verdict.counted !== summary.counted ||
    verdict.voided !== summary.voided ||
    (verdict.median?.value ?? null) !== (summary.median?.value ?? null)
  )
    throw new Error(`${cell.name}: the harness now gives ${verdict.decision} (${verdict.why}), and summary.ndjson gives ${summary.decision}`);
  const warmups = (record.warmups ?? []).map((run) => measure(cell, run));
  const again = warmups.map((run) => run.elapsed?.value ?? run.outcome.kind);
  if (JSON.stringify(again) !== JSON.stringify(summary.warmups))
    throw new Error(`${cell.name}: the warm-ups now read ${JSON.stringify(again)}, and summary.ndjson gives ${JSON.stringify(summary.warmups)}`);
  return { cell, measured, verdict, warmups };
};

/** This function writes the count of a noun: "1 run", "2 runs". */
export const count = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`;

/** These are the options of the text of a verdict. */
export interface WhyOptions {
  /** This count is the count of decimals of each time of 1 s or more. */
  readonly digits?: number;
  /** This text starts the sentence of a silent cell: "Nothing detected the fault". */
  readonly silent?: string;
  /** These texts are the findings of a run other than its time, as the harness gives them, and as the page tells them. */
  readonly findings?: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]>;
}

/** This form is the finding of a run whose time is outside the band. */
const OFF_BAND = /^-?[\d.]+ s is outside \[/;

/** This function gives the text of a finding for the page, or it stops at a finding with no text for the page. */
const findingOf = (why: string, options: WhyOptions): string => {
  for (const [form, text] of options.findings ?? []) {
    const match = form.exec(why);
    if (match !== null) return text(match);
  }
  throw new Error(`the finding "${why}" has no text for the page`);
};

/** This function writes the verdict of a cell as the page shows it: what the counted runs measured, against the prediction. */
export const whyOf = (reading: Reading, options: WhyOptions = {}): string => {
  const { cell, verdict, measured } = reading;
  const at = timeAt(options.digits ?? 3);
  const p = cell.prediction;
  const counted = measured.filter((run) => run.void === null);
  const median = secondsOf(verdict.median);
  if (p.detects === null) {
    const times = counted.flatMap((run) => (run.elapsed === null ? [] : [secondsOf(run.elapsed)!])).sort((a, b) => a - b);
    if (times.length === 0) return `None of the ${counted.length} counted runs measured a time.`;
    return `The median is ${at(median ?? 0)} from ${FROM[p.from ?? ""] ?? p.from}, and the counted runs measured ${at(times[0]!)} to ${at(times.at(-1)!)}.`;
  }
  // a finding other than a time outside the band: the first one, and the count of runs that have one
  const others = verdict.outside.filter((each) => !OFF_BAND.test(each.why));
  const found = new Set(others.map((each) => each.run)).size;
  const finding =
    others.length === 0
      ? null
      : `${found === counted.length ? "Each counted run has" : `${found} of the counted runs have`} a finding: ${findingOf(others[0]!.why, options)}.`;
  if (verdict.band === null) {
    if (verdict.outside.length === 0) return `${options.silent ?? "Nothing detected the fault"} in the ${counted.length} counted runs, each of ${at(secondsOf(p.window)!)}.`;
    return finding ?? `${verdict.outside.length} of the ${counted.length} counted runs disagree with the prediction.`;
  }
  const low = secondsOf(verdict.band.low)!;
  const high = secondsOf(verdict.band.high)!;
  const off = new Set(verdict.outside.filter((each) => OFF_BAND.test(each.why)).map((each) => each.run)).size;
  const interval = verdict.medianInterval;
  const parts = [
    `${counted.length - off} of the ${counted.length} counted runs are in the band of ${at(low)} to ${at(high)}.`,
    `The median is ${at(median ?? 0)}, and its interval is ${at(secondsOf(interval?.low) ?? 0)} to ${at(secondsOf(interval?.high) ?? 0)}.`,
    ...(finding === null ? [] : [finding]),
  ];
  const timed = p.detects ? p : (p.recovers ?? p.replies)!;
  const wide = { low: secondsOf(timed.low)! * (1 - RELATIVE), high: secondsOf(timed.high)! * (1 + RELATIVE) };
  if (interval !== null && (secondsOf(interval.high)! < wide.low || secondsOf(interval.low)! > wide.high))
    parts.push(`That interval is outside the prediction with a margin of 5 %, ${at(round(wide.low))} to ${at(round(wide.high))}. Thus the cell fails on its median.`);
  return parts.join(" ");
};

/** This function gives the time of each counted run, by environment and in sequence. A run with no time gets null. */
export const runsOf = (reading: Reading): (number | null)[][] => {
  const environments = Math.max(0, ...reading.measured.map((run) => run.environment)) + 1;
  return Array.from({ length: environments }, (_, environment) =>
    reading.measured.filter((run) => run.environment === environment && run.void === null).map((run) => secondsOf(run.elapsed)),
  );
};

/** This function gives the copy of the verdict of a cell, with its runs, its warm-ups and the text of its void runs. */
export const resultOf = (reading: Reading, options: WhyOptions = {}) => {
  const { verdict, measured, warmups } = reading;
  return {
    decision: verdict.decision,
    counted: verdict.counted,
    voided: verdict.voided,
    band: verdict.band === null ? null : { low: secondsOf(verdict.band.low), high: secondsOf(verdict.band.high) },
    median: secondsOf(verdict.median),
    why: whyOf(reading, options),
    runs: runsOf(reading),
    warmups: warmups.map((run) => secondsOf(run.elapsed)),
    voids: voidsOf(measured.flatMap((run) => (run.void === null ? [] : [run.void]))),
  };
};

/** This function splits the name of a harness cell into the cell of the plan that it stands for, its catalog, and the rest. */
export const nameOf = (name: string): { readonly plan: string | null; readonly catalog: string; readonly name: string } => {
  const planned = /^((T\d+|CAL)\.[\w-]+\.\d+) (.+)$/.exec(name);
  if (planned !== null) return { plan: planned[1]!, catalog: planned[2]!, name: planned[3]! };
  const plain = /^(T\d+|CAL) (.+)$/.exec(name);
  if (plain === null) throw new Error(`${name}: no catalog`);
  return { plan: null, catalog: plain[1]!, name: plain[2]! };
};
