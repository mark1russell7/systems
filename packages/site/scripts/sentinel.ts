// The export of the T12 cells for the site: src/data/sentinel-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/sentinel.ts <folder>...
//
// T12 is a group of three Valkey members under three Sentinels, with ioredis in Sentinel mode as
// the client. Each folder is the output of one shard of the workflow Cells on a runner of GitHub:
// the raw record of each cell, summary.ndjson and runner.txt. The folder of a re-run goes last,
// and its cell replaces the cell of the first run. The script reads each record again with the
// code of the harness (`judge`), and it stops when that verdict disagrees with summary.ndjson. It
// also stops when the catalog has no cell of the same name. The copy keeps only what the page shows.

import type { Cell, Stage } from "../../harness/src/index.ts";
import { NOISE, STAGES } from "../../harness/src/index.ts";
import { T12_CAL, T12_CELLS } from "../../cells/src/t12.ts";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CellRecord, Reading, Summary } from "./judged.ts";
import { nameOf, read, resultOf } from "./judged.ts";
import { dateOf, only, ordinal, readFolders, runnerOf, secondsOf, stringify, time } from "./records.ts";

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/sentinel.ts <folder>...\n");
  process.exit(2);
}

const CATALOG: readonly Cell[] = [...T12_CELLS, T12_CAL];
const found = readFolders<CellRecord, Summary>(folders);

/** These sentences tell the path of each prediction of a detection, by the timer that the catalog names. */
const PATHS: Readonly<Record<string, string>> = {
  "Sentinel failover, then the reconnect ladder of ioredis": "The Sentinels fail over. Then the reconnect ladder of ioredis finds the new primary.",
  "Sentinel failover behind a refusal, then the reconnect ladder of ioredis":
    "The primary refuses each connection, and the Sentinels fail over. Then the reconnect ladder of ioredis finds the new primary.",
  "Sentinel failover, the conversion of the thawed primary, then the reconnect of ioredis":
    "The Sentinels fail over. After the thaw, they make the old primary a replica, and that closes the connection of the client. Then ioredis connects to the new primary.",
  "SIGCONT: the frozen primary answers": "The thaw comes before down-after-milliseconds. Thus no failover occurs, and the same primary answers again.",
  "SENTINEL FAILOVER, the conversion of the old primary, then the reconnect of ioredis":
    "The command SENTINEL FAILOVER starts the failover. Then the Sentinels make the old primary a replica, and that closes the connection of the client. Then ioredis connects to the new primary.",
};

/** These sentences tell why a cell is a measurement only, by the start of the reason that the catalog gives. */
const PINNED =
  "The client stays on the old primary while the fault holds, because ioredis has no timer for the group. After the lift, the old primary becomes a replica again only when a Sentinel reaches it. That occurs on the SYN backoff of its kernel, from a time that no document gives.";
const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^a split brain: the client stays on the old primary while the fault holds/, `This cell is a split brain. ${PINNED}`],
  [/^the client stays on the old primary while the fault holds/, PINNED],
  [
    /^the server's own FAILOVER command pauses the writes and hands over the primary, and no machine document gives its time$/,
    "The FAILOVER command of the server stops the writes and gives the primary to a replica. No machine document gives its time.",
  ],
  [
    /^a calibration: each stamp of the observer against the write of its Sentinel that it read$/,
    "This cell is a calibration. It compares each stamp of the observer with the write of the Sentinel that the observer read.",
  ],
];

/** This text tells why CI did a cell again, by the name of the cell. */
const REPEATED: Readonly<Record<string, string>> = {
  "CAL the stamps of the observer of the Sentinels, event:planned SENTINEL FAILOVER":
    "In the first CI run, the harness did not keep the subscriptions of the observer, thus the calibration gave no delay of a stamp. After a fix, CI did the calibration again.",
};

/**
 * This function gives the prediction of a cell: its kind, its band and its text. The kind is a
 * detection, a recovery, silence, or a measurement only. Each time counts from the fault, to the
 * first write of the client that succeeds after it.
 */
const predictionOf = (cell: Cell) => {
  const p = cell.prediction;
  const none = { low: null, high: null, window: null };
  const span = (low: number, high: number): string => `The algebra predicts that a write of the client succeeds again ${time(low)} to ${time(high)} after the fault.`;
  if (p.detects === null) {
    const why = REASONS.find(([form]) => form.test(p.why))?.[1];
    if (why === undefined) throw new Error(`${cell.name}: the reason "${p.why}" has no text for the page`);
    if (p.from !== "fault") throw new Error(`${cell.name}: a measurement from ${p.from}, not from the fault`);
    return {
      kind: "measured",
      ...none,
      window: secondsOf(p.window),
      text: `This cell has no band. ${why} The harness measures the time from the fault to the first write that succeeds.`,
    };
  }
  if (p.detects) {
    const path = PATHS[p.timer];
    if (path === undefined) throw new Error(`${cell.name}: the timer "${p.timer}" has no text for the page`);
    if (p.from !== "fault") throw new Error(`${cell.name}: a detection from ${p.from}, not from the fault`);
    const [low, high] = [secondsOf(p.low)!, secondsOf(p.high)!];
    return { kind: "detects", ...none, low, high, text: `${span(low, high)} ${path}` };
  }
  if (p.recovers !== undefined) {
    const [low, high] = [secondsOf(p.recovers.low)!, secondsOf(p.recovers.high)!];
    const path = `The Sentinels see a live primary, thus no failover occurs. The reply comes at the first retransmission after the heal, the ${ordinal(p.recovers.firing)} firing of the RTO timer.`;
    return { kind: "recovers", ...none, low, high, window: secondsOf(p.window), text: `${span(low, high)} ${path}` };
  }
  throw new Error(`${cell.name}: a silent prediction, which T12 does not have`);
};

/** This function gives each stage of the failover: its band, when the prediction gives one, and its median over the counted runs. */
const stagesOf = (reading: Reading) => {
  const group = reading.verdict.group;
  if (group === undefined) throw new Error(`${reading.cell.name}: no verdict of the group`);
  return STAGES.flatMap((stage: Stage) => {
    const banded = group.stages.find((each) => each.stage === stage);
    const median = secondsOf(group.medians[stage]);
    if (banded === undefined && median === null) return [];
    return [
      {
        stage,
        low: banded === undefined ? null : secondsOf(banded.band.low),
        high: banded === undefined ? null : secondsOf(banded.band.high),
        median,
        decision: banded?.decision ?? null,
      },
    ];
  });
};

/** This function gives what became of the writes of a cell, and the member that the client wrote to after the fault. */
const writesOf = (reading: Reading) => {
  const group = reading.verdict.group!;
  const counted = reading.measured.filter((run) => run.void === null);
  const moved = counted.filter((run) => run.group !== undefined && run.group.to !== null && run.group.to !== run.group.from).length;
  return {
    lost: group.lost,
    old: group.old,
    unknown: group.unknown,
    errors: group.errors.map((each) => ({ name: each.name, runs: each.runs, first: secondsOf(each.first) })),
    moved,
    stayed: counted.length - moved,
  };
};

const cells = CATALOG.flatMap((catalog) => {
  const entry = found.get(catalog.name);
  if (entry === undefined) return [];
  const reading = read(entry);
  const { cell } = reading;
  const named = nameOf(cell.name);
  const group = cell.group;
  if (group === undefined) throw new Error(`${cell.name}: no group`);
  const place = cell.faultAt !== undefined && "role" in cell.faultAt ? cell.faultAt : null;
  return [
    {
      ...named,
      group: named.catalog === "CAL" ? "calibration" : named.plan?.includes(".border-off.") ? "border" : "defaults",
      fault: cell.fault,
      at: place?.role ?? null,
      cuts: place !== null && "cuts" in place ? (place.cuts ?? null) : null,
      hold: secondsOf(cell.hold),
      downAfter: Number(group.sentinelSettings["down-after-milliseconds"]) / 1000,
      lands: cell.prediction.group?.lands ?? null,
      prediction: predictionOf(cell),
      ...resultOf(reading),
      stages: stagesOf(reading),
      writes: writesOf(reading),
      first: entry.first,
      repeated: entry.first === null ? null : (REPEATED[cell.name] ?? null),
    },
  ];
});
const unknown = [...found.keys()].filter((name) => !CATALOG.some((catalog) => catalog.name === name));
if (unknown.length > 0) throw new Error(`no catalog has the cells ${unknown.join(", ")}`);
for (const cell of cells)
  if (cell.first !== null && cell.repeated === null) throw new Error(`${cell.name}: a re-run with no reason for the page`);

const records = [...found.values()].map((entry) => entry.record);
const calibration = (() => {
  const entry = found.get(T12_CAL.name);
  if (entry === undefined) throw new Error("no calibration of the stamps");
  const lags = read(entry).verdict.group?.lags;
  if (lags === undefined || lags === null) throw new Error("the calibration of the stamps has no delays");
  return { count: lags.count, median: secondsOf(lags.median), p99: secondsOf(lags.p99), max: secondsOf(lags.max) };
})();
const runner = runnerOf(folders);
const date = dateOf(records.map((record) => record.at.ended));
const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness. A re-run replaces the first run of its cell",
  ranAt: date,
  units: "s",
  noise: secondsOf(NOISE),
  runs: Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: runner.kernel,
  hz: runner.hz,
  target: only("the target", records.map((record) => record.cell.target.image.replace(/@.*$/, ""))),
  quorum: Number(only("the quorum", records.map((record) => String(record.cell.group?.quorum)))),
  /** This time is the error of the stamps that each stage band of these runs includes. */
  stampBound: Number(only("the error of the stamps", records.map((record) => String(secondsOf(record.cell.prediction.group?.stamps))))),
  /** This record is the delay of the stamps of the observer after the writes of the Sentinels, from the calibration. */
  stamps: calibration,
  cells,
};
const out = fileURLToPath(new URL(`../src/data/sentinel-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.counted + cell.voided, 0)} runs: ${out}\n`);
