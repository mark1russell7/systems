// The export of the MongoDB cells for the site: src/data/mongodb-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/mongodb.ts <folder>...
//
// The MongoDB cells put the Node driver of MongoDB against a replica set of mongod: one member for
// T01 and T03, three members for T11. Each folder is the output of one shard of the workflow Cells
// on a runner of GitHub: the raw record of each cell, summary.ndjson and runner.txt. The script reads
// each record again with the code of the harness (`judge`), and it stops when that verdict
// disagrees with summary.ndjson. It also stops when a prediction disagrees with the catalog at the
// HZ of the runner. The copy keeps only what the page shows.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cell, DriverBand, LineMatch, Reference } from "../../harness/src/index.ts";
import { NOISE, REPLICA_SET_STAGES } from "../../harness/src/index.ts";
import type { CellRecord, Reading, Summary } from "./judged.ts";
import { nameOf, read, resultOf } from "./judged.ts";
import { dateOf, noiseOf, ofCatalog, only, ordinal, readFolders, runnerOf, secondsOf, stringify, time, timeAt } from "./records.ts";

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/mongodb.ts <folder>...\n");
  process.exit(2);
}

// the catalog reads the HZ of the kernel when it loads, thus it loads after the HZ of the runner is known
const runner = runnerOf(folders);
process.env["CELLS_HZ"] = String(runner.hz);
const { MONGO_CELLS } = await import("../../cells/src/mongo/harness.ts");
const { DRIVER } = await import("../../cells/src/mongo/cells.ts");
const { ALL } = await import("../../cells/src/all.ts");

// a full run of the catalogs holds the cells of each catalog: this export takes its own
const found = ofCatalog(
  readFolders<CellRecord, Summary>(folders),
  MONGO_CELLS.map((cell) => cell.name),
  ALL.map((cell) => cell.name),
);

/** These phrases tell what detects the fault in a prediction, by the timer that the catalog names. */
const TIMERS: Readonly<Record<string, string>> = {
  "the monitor writes the server off: stream_timeout": "the monitor writes the server off at the timeout of its stream",
  "the monitor writes the server off: keepalive": "the keepalive of the kernel ends the socket of the monitor, and the monitor writes the server off",
  "the request meets a reset": "the request meets a reset",
  "the first write on the new primary": "the first write lands on the new primary",
  "the first write after the fault, on the same primary": "the first write after the fault lands on the same primary",
  "the first selection times out": "the first server selection times out",
  "the first selection times out, after the monitor's connect": "the first server selection times out after the connect of the monitor",
  "the monitor's stream ends": "the stream of the monitor ends",
  "the kernel ends the idle pool socket: keepalive": "the keepalive of the kernel ends the idle socket of the pool",
  "mongod's keepalive ends its socket of the pool connection": "the keepalive of mongod ends its socket of the pool connection",
  "the kernel ends the request's socket: retrans_giveup": "the give-up of the retransmissions ends the socket of the request",
  "the router forgets the flow and resets both ends": "the router forgets the flow and resets the two ends",
  "the first keepalive probe meets the router's reset": "the first keepalive probe meets the reset of the router",
  "the probes go into nothing: keepalive": "the keepalive probes get no answer, and the keepalive of the kernel gives up",
};
/** These phrases tell each later band of a driver, by the text that the catalog gives. */
const STEPS: Readonly<Record<string, string>> = {
  "the pool interrupts the operation in flight": "the pool interrupts the operation in flight",
  "the retry's selection times out": "the server selection of the retry times out",
  "the monitor's first connect times out": "the first connect of the monitor times out",
  "the retry lands when the fault lifts": "the retry lands when the fault lifts",
  "the monitor writes the server off: stream_timeout": "the monitor writes the server off at the timeout of its stream",
};
/** These phrases name the reference of a band of a driver, in a sentence. */
const FROMS: Readonly<Record<Reference, string>> = {
  fault: "the fault",
  "last-received": "the last segment on its socket",
  "request-sent": "the send of the request",
  "first-retransmission": "the first retransmission of the RTO timer",
  "peer-closed": "the close of the socket of the server",
  "client-start": "the start of the client",
} as Readonly<Record<Reference, string>>;
const from = (reference: Reference): string => {
  const text = FROMS[reference];
  if (text === undefined) throw new Error(`no text for the reference ${reference}`);
  return text;
};
/** This function gives the phrase of the error of a band: nothing for a success, or the name of the error. */
const withError = (name: string): string => (name === "OK" ? "" : name === "EOF" ? " with an end of file" : ` with ${name}`);

/** This function names a line that a prediction does not let come after the fault. */
const quietOf = (match: LineMatch): string => {
  if (match.ev === "sdam" && match.where?.["event"] === "heartbeat-failed") return "heartbeat-failed event of the monitor";
  if (match.ev === "socket-error" && match.where === undefined) return "socket error";
  if (match.ev === "fail" && match.where === undefined) return "failed operation";
  throw new Error(`no text for the line ${JSON.stringify(match)}`);
};
const QUIET_STAGES: Readonly<Record<string, string>> = { elected: "election", "written-off": "write-off of the primary" };
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/** This function gives the sentences of the later bands of a driver, and of the lines that must not come. */
const driverOf = (driver: DriverBand | undefined, quietStages: readonly string[]): string[] => {
  const at = timeAt(3);
  const out: string[] = [];
  for (const step of driver?.then ?? []) {
    const what = STEPS[step.what];
    if (what === undefined) throw new Error(`no text for the step "${step.what}"`);
    out.push(`Then ${what}${withError(step.name)}: ${at(secondsOf(step.low)!)} to ${at(secondsOf(step.high)!)} after ${from(step.from)}.`);
  }
  const quiet = [
    ...(driver?.quiet ?? []).map(quietOf),
    ...quietStages.map((stage) => {
      const text = QUIET_STAGES[stage];
      if (text === undefined) throw new Error(`no text for the stage ${stage}`);
      return text;
    }),
  ];
  if (quiet.length > 0) out.push(`The prediction has no ${listed(quiet)} after the fault.`);
  return out;
};

/** This function gives the prediction of a cell: its kind, its band and its text. */
const predictionOf = (cell: Cell) => {
  const p = cell.prediction;
  const at = timeAt(3);
  const none = { low: null, high: null, window: null };
  if (p.detects === null) throw new Error(`${cell.name}: a measurement only, which the MongoDB cells do not have`);
  const group = p.group;
  const errors = (group?.errors ?? []).map(
    (error) => `The client meets ${error.name} ${at(secondsOf(error.low)!)} to ${at(secondsOf(error.high)!)} after the fault.`,
  );
  const extra = [...driverOf(p.driver, group?.quiet ?? []), ...errors];
  const text = (first: string): string => [first, ...extra].join(" ");
  if (p.detects) {
    const timer = TIMERS[p.timer];
    if (timer === undefined) throw new Error(`${cell.name}: the timer "${p.timer}" has no text for the page`);
    const [low, high] = [secondsOf(p.low)!, secondsOf(p.high)!];
    return {
      kind: "detects",
      ...none,
      low,
      high,
      text: text(`The algebra predicts that ${timer}${withError(p.errno)}. The band is ${at(low)} to ${at(high)} after ${from(p.from)}.`),
    };
  }
  if (p.recovers !== undefined) {
    const [low, high] = [secondsOf(p.recovers.low)!, secondsOf(p.recovers.high)!];
    const reference = group === undefined ? "the send of the request" : "the fault";
    return {
      kind: "recovers",
      ...none,
      low,
      high,
      window: secondsOf(p.window),
      text: text(
        `The algebra predicts that the reply comes back at the ${ordinal(p.recovers.firing)} firing of the RTO timer. The band is ${at(low)} to ${at(high)} after ${reference}.`,
      ),
    };
  }
  if (p.replies !== undefined) {
    const [low, high] = [secondsOf(p.replies.low)!, secondsOf(p.replies.high)!];
    return {
      kind: "replies",
      ...none,
      low,
      high,
      window: secondsOf(p.window),
      text: text(`The algebra predicts that nothing detects the fault, and that the reply comes back. The band of the reply is ${at(low)} to ${at(high)} after the fault.`),
    };
  }
  const window = secondsOf(p.window)!;
  return { kind: "silent", ...none, window, text: text(`The algebra predicts that nothing detects the fault in a window of ${at(window)}.`) };
};

/** These texts are the findings of a run other than its time, as the harness gives them, and as the page tells them. */
const FINDINGS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [
    /^a sdam line with event heartbeat-failed came ([\d.]+) s after the fault, where none should$/,
    (match) => `the monitor reported heartbeat-failed ${time(Number(match[1]))} after the fault, where the prediction has no such event`,
  ],
];

/** This function gives each stage of the timeline of a replica set. A stage has its band, when the prediction gives one, and its median. */
const stagesOf = (reading: Reading) => {
  const group = reading.verdict.group;
  if (group === undefined) return null;
  return REPLICA_SET_STAGES.flatMap((stage) => {
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

/** This function gives what became of the writes of a replica set, and the member that the client wrote to after the fault. */
const writesOf = (reading: Reading) => {
  const group = reading.verdict.group;
  if (group === undefined) return null;
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

/** This function gives the name of a cell without the client and the target, which each MongoDB cell has. */
const shortOf = (name: string): string => {
  const short = name.replace(/^mongodb-node-7\.7 to mongodb-replset( of three)?, /, "");
  if (short === name) throw new Error(`${name}: not the client and the target of the MongoDB cells`);
  return short;
};

const cells = MONGO_CELLS.flatMap((catalog) => {
  const entry = found.get(catalog.name);
  if (entry === undefined) return [];
  if (JSON.stringify(entry.record.cell.prediction) !== JSON.stringify(catalog.prediction))
    throw new Error(`${catalog.name}: the prediction of the record is not the prediction of the catalog at HZ ${runner.hz}`);
  const reading = read(entry);
  const named = nameOf(catalog.name);
  return [
    {
      ...named,
      name: shortOf(named.name),
      group: named.catalog,
      stage: named.plan?.includes(".border-off.") ? "border" : "defaults",
      prediction: predictionOf(entry.record.cell),
      ...resultOf(reading, { findings: FINDINGS }),
      stages: stagesOf(reading),
      writes: writesOf(reading),
    },
  ];
});
const unknown = [...found.keys()].filter((name) => !MONGO_CELLS.some((catalog) => catalog.name === name));
if (unknown.length > 0) throw new Error(`no catalog has the cells ${unknown.join(", ")}`);

const records = [...found.values()].map((entry) => entry.record);
const date = dateOf(records.map((record) => record.at.ended));
const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness",
  ranAt: date,
  units: "s",
  noise: noiseOf(records.map((record) => record.cell), NOISE),
  runs: Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: runner.kernel,
  hz: runner.hz,
  target: only("the target", records.map((record) => record.cell.target.image.replace(/@.*$/, ""))),
  client: DRIVER,
  cells,
};
const out = fileURLToPath(new URL(`../src/data/mongodb-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.counted + cell.voided, 0)} runs: ${out}\n`);
