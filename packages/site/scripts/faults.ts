// The export of the network-fault cells of T01 for the site: src/data/faults-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/faults.ts <folder>...
//
// Each folder is the output of the runner of @systems/cells: one raw record for each cell, and
// summary.ndjson. A cell in a later folder replaces the same cell of an earlier folder, thus a
// rerun goes after the full run. The script reads each record again with the code of the harness
// (`judge`). It stops when that verdict disagrees with the summary of the run, or when a
// prediction disagrees with the catalog. The copy keeps only what the page shows. It keeps no
// boot id, image digest, container, namespace inode, user or path.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cell, Manifest, Measured, Run, Verdict } from "../../harness/src/index.ts";
import { judge, NOISE } from "../../harness/src/index.ts";

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/faults.ts <folder>...\n");
  process.exit(2);
}

/** A record is the raw record of one cell, as the runner of @systems/cells writes it. */
interface CellRecord {
  readonly cell: Cell;
  readonly manifests: readonly Manifest[];
  readonly runs: readonly Run[];
  readonly at: { readonly started: string; readonly ended: string };
}
/** A summary is one line of summary.ndjson: the verdict of a cell at the time of its run. */
interface Summary {
  readonly name: string;
  readonly decision: string;
  readonly counted: number;
  readonly voided: number;
  readonly median: { readonly value: number } | null;
}
interface Found {
  readonly record: CellRecord;
  readonly summary: Summary;
  /** This decision is the decision of the run that a rerun replaced, or null. */
  readonly first: string | null;
}

const found = new Map<string, Found>();
for (const folder of folders) {
  const summaries = new Map<string, Summary>();
  for (const line of readFileSync(join(folder, "summary.ndjson"), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const summary = JSON.parse(line) as Summary;
    summaries.set(summary.name, summary);
  }
  for (const file of readdirSync(folder).filter((name) => name.endsWith(".json")).sort()) {
    const record = JSON.parse(readFileSync(join(folder, file), "utf8")) as CellRecord;
    const summary = summaries.get(record.cell.name);
    if (summary === undefined) throw new Error(`${file}: summary.ndjson has no line for ${record.cell.name}`);
    const before = found.get(record.cell.name);
    found.set(record.cell.name, { record, summary, first: before === undefined ? null : (before.first ?? before.summary.decision) });
  }
}

/** These are the defaults of Linux 6.6 and 6.17 for the sysctls that a cell sets. The page shows only the sysctls that differ. */
const LINUX: Readonly<Record<string, string>> = {
  "net.ipv4.tcp_syn_retries": "6",
  "net.ipv4.tcp_syn_linear_timeouts": "4",
  "net.ipv4.tcp_retries2": "15",
  "net.ipv4.tcp_keepalive_time": "7200",
  "net.ipv4.tcp_keepalive_intvl": "75",
  "net.ipv4.tcp_keepalive_probes": "9",
  "net.ipv4.tcp_fin_timeout": "60",
};
const changed = (sysctls: Readonly<Record<string, string>> | undefined) =>
  Object.entries(sysctls ?? {})
    .filter(([name, value]) => LINUX[name] !== value)
    .map(([name, value]) => ({ name, value }));

/** This function rounds a time in seconds to 0.1 µs, so that no binary fraction reaches the copy. */
const round = (seconds: number): number => Number(seconds.toFixed(7));
const secondsOf = (quantity: { readonly value: number; readonly unit: string } | undefined): number | null => {
  if (quantity === undefined) return null;
  const scale: Readonly<Record<string, number>> = { s: 1, ms: 1e-3 };
  const factor = scale[quantity.unit];
  if (factor === undefined) throw new Error(`no scale for the unit ${quantity.unit}`);
  return round(quantity.value * factor);
};

/** This function gives the manifestation of a cell: its fault, with the ICMP code or the direction of a drop. */
const manifestationOf = (cell: Cell): string =>
  cell.fault === "unreachable" ? `unreachable-${cell.icmp}` : cell.fault === "simplex" ? `simplex-${cell.drops}` : cell.fault;

/** This function gives the position of the fault: which side observes it, and what is in flight. */
const positionOf = (cell: Cell): string => {
  const server = cell.observer === "server";
  if (cell.probe.mode === "idle") return server ? "server idle" : "client idle";
  if (cell.probe.mode === "stream") return "client stream";
  return server ? "server reply in flight" : "client in flight";
};

/** This text is the start of the reason of each measurement-only cell, as the catalog writes it. */
const DISTRIBUTION = /^its reply times are a distribution: (.+)\. A simulator predicts it, and the algebra does not$/;

/** This function gives the prediction of a cell in one shape: a detection, a recovery, silence, or a measurement only. */
const predictionOf = (cell: Cell) => {
  const p = cell.prediction;
  const none = { timer: null, errno: null, from: null, low: null, high: null, window: null, why: null };
  if (p.detects === null) {
    const why = DISTRIBUTION.exec(p.why)?.[1];
    if (why === undefined) throw new Error(`${cell.name}: the reason "${p.why}" has an unknown form`);
    return { kind: "measured", ...none, why };
  }
  if (p.detects)
    return { kind: "detects", ...none, timer: p.timer, errno: p.errno, from: p.from, low: secondsOf(p.low), high: secondsOf(p.high) };
  if (p.recovers !== undefined)
    return { kind: "recovers", ...none, low: secondsOf(p.recovers.low), high: secondsOf(p.recovers.high), window: secondsOf(p.window) };
  return { kind: "silent", ...none, window: secondsOf(p.window) };
};

const outcomeOf = (run: Measured): string =>
  run.outcome.kind === "error" ? run.outcome.errno : run.outcome.kind === "eof" ? "EOF" : run.outcome.kind;

/** This function gives the fastest, the median and the slowest reply of a run of a measurement-only cell. */
const repliesOf = (run: Measured) => {
  if (run.samples === undefined) return null;
  const sorted = run.samples.map((sample) => secondsOf(sample)!).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, fastest: null, median: null, slowest: null };
  const half = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
  return { count: sorted.length, fastest: sorted[0]!, median: round(median), slowest: sorted.at(-1)! };
};

/** This function gives the verdict of a cell. The reason of a measurement-only cell is in its prediction, thus its verdict does not repeat it. */
const verdictOf = (cell: Cell, verdict: Verdict) => {
  const reason = cell.prediction.detects === null ? `. ${cell.prediction.why}` : null;
  return {
    decision: verdict.decision,
    counted: verdict.counted,
    voided: verdict.voided,
    band: verdict.band === null ? null : { low: secondsOf(verdict.band.low), high: secondsOf(verdict.band.high) },
    median: verdict.median === null ? null : secondsOf(verdict.median),
    why: reason !== null && verdict.why.endsWith(reason) ? verdict.why.slice(0, -reason.length) : verdict.why,
  };
};

/** This function gives the one value that each manifest of each cell has, or it stops. */
const only = (what: string, values: readonly string[]): string => {
  const set = [...new Set(values)];
  if (set.length !== 1) throw new Error(`the records disagree on ${what}: ${set.join(", ")}`);
  return set[0]!;
};

// the catalog reads the HZ of the kernel when it loads, thus it loads after the HZ of the records is known
process.env["CELLS_HZ"] = only(
  "HZ",
  [...found.values()].flatMap((entry) => entry.record.manifests.flatMap((manifest) => (manifest.hz ? [manifest.hz] : []))),
);
const { CELLS } = await import("../../cells/src/catalog.ts");

const cells = CELLS.map((catalog) => {
  const entry = found.get(catalog.name);
  if (entry === undefined) throw new Error(`no record of ${catalog.name}`);
  const { record, summary, first } = entry;
  const { cell } = record;
  if (JSON.stringify(cell.prediction) !== JSON.stringify(catalog.prediction))
    throw new Error(`${cell.name}: the prediction of the record is not the prediction of the catalog`);
  const { measured, verdict } = judge(cell, record.runs);
  if (
    verdict.decision !== summary.decision ||
    verdict.counted !== summary.counted ||
    verdict.voided !== summary.voided ||
    (verdict.median?.value ?? null) !== (summary.median?.value ?? null)
  )
    throw new Error(`${cell.name}: the harness now gives ${verdict.decision} (${verdict.why}), and the run gave ${summary.decision}`);
  const server = cell.observer === "server";
  return {
    name: cell.name.replace(/^T01 /, ""),
    manifestation: manifestationOf(cell),
    position: positionOf(cell),
    settings: {
      observer: changed(server ? cell.targetSysctls : cell.sysctls),
      peer: changed(server ? cell.sysctls : cell.targetSysctls),
      redis: Object.entries(cell.targetSettings ?? {}).map(([name, value]) => ({ name, value })),
      latency: secondsOf(cell.latency),
      stall: secondsOf(cell.stall),
      mtu: cell.mtu ?? null,
      netem: cell.netem ?? null,
    },
    prediction: predictionOf(cell),
    verdict: verdictOf(cell, verdict),
    firstRun: first,
    runs: measured.map((run) => ({
      environment: run.environment,
      outcome: outcomeOf(run),
      elapsed: run.elapsed === null ? null : secondsOf(run.elapsed),
      retransmissions: run.retransmissions,
      replies: repliesOf(run),
      void: run.void,
    })),
  };
});

const records = CELLS.map((catalog) => found.get(catalog.name)!.record);
const manifests = records.flatMap((record) => record.manifests);
// the date of the copy is the day that the last of its records ended
const date = records.map((record) => record.at.ended.slice(0, 10)).sort().at(-1)!;
const copy = {
  source: "the prober's eBPF records, judged again by the harness. A rerun replaces the first run of its cell",
  topology: "T01",
  ranAt: date,
  units: "s",
  noise: Number(only("the noise", records.map((record) => String(secondsOf(record.cell.noise ?? NOISE))))),
  runs: Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: only("the kernel", manifests.map((manifest) => /^\d+(\.\d+)+/.exec(manifest.kernel)?.[0] ?? "")),
  hz: Number(only("HZ", manifests.map((manifest) => manifest.hz ?? ""))),
  target: only("the target", records.map((record) => record.cell.target.image.replace(/@.*$/, ""))),
  cells,
};
const out = fileURLToPath(new URL(`../src/data/faults-${date}.json`, import.meta.url));
writeFileSync(out, `${JSON.stringify(copy, null, 2)}\n`);
process.stdout.write(`${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.runs.length, 0)} runs: ${out}\n`);
