// The export of R3's queue for the site: src/data/r3-<date>.json.
//
//   pnpm exec tsx packages/site/scripts/r3.ts <folder>...
//
// jarvis compiles the cells of R3 from its corpus: the plan of each template at each stage, with
// each knob at its default, at a border, or at a value of an array or of a random draw. CI runs them
// on the runners of GitHub with the workflow Cells, from a branch `jarvis/stage-<stamp>` that holds
// the cells. Each folder is the output of one shard: the raw record of each cell, summary.ndjson and
// runner.txt. The folders of a re-run go last, and each of their cells replaces the cell of the
// first run. The script reads each record again with the code of the harness (`judge`), and it
// stops when that verdict disagrees with summary.ndjson. The copy keeps only what the page shows.
// A record names no corpus claim: the case of each compiled cell is null.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cell } from "../../harness/src/index.ts";
import { NOISE } from "../../harness/src/index.ts";
import type { CellRecord, Summary } from "./judged.ts";
import { nameOf, read, resultOf } from "./judged.ts";
import { dateOf, noiseOf, only, readFolders, runnerOf, secondsOf, stringify, timeAt } from "./records.ts";

const folders = process.argv.slice(2);
if (folders.length === 0) {
  process.stderr.write("usage: pnpm exec tsx packages/site/scripts/r3.ts <folder>...\n");
  process.exit(2);
}

const runner = runnerOf(folders);
const found = readFolders<CellRecord, Summary>(folders);
// the first record of each cell that a later folder replaced, for the reason of its re-run
const firsts = new Map<string, CellRecord>();
for (const folder of folders) {
  for (const [name, entry] of readFolders<CellRecord, Summary>([folder])) if (!firsts.has(name)) firsts.set(name, entry.record);
}

/** These phrases tell what ends the connection in a prediction, by its timer and its errno. */
const CLOSERS: Readonly<Record<string, string>> = {
  "keepalive ETIMEDOUT": "the keepalive of the kernel gives up on the connection with ETIMEDOUT",
  "retrans_giveup ETIMEDOUT": "the give-up of the retransmissions gives ETIMEDOUT",
  "retrans_giveup EHOSTUNREACH": "the give-up of the retransmissions gives EHOSTUNREACH, the soft error of an ICMP",
  "retrans_giveup ENETUNREACH": "the give-up of the retransmissions gives ENETUNREACH, the soft error of an ICMP",
  "retrans_giveup ECONNREFUSED": "the give-up of the retransmissions gives ECONNREFUSED, the soft error of an ICMP",
  "rx.rst ECONNRESET": "a reset reaches the observer as ECONNRESET",
  "rx.fin EOF": "the FIN of the peer reaches the observer as an end of file",
  "idle CLOSED": "Redis closes the idle client at its timeout, with its own FIN",
};

/** These phrases name the reference of a time of an R3 cell, in a sentence. */
const R3_FROM: Readonly<Record<string, string>> = {
  "last-received": "the last segment that the observer received",
  "request-sent": "the send of the request",
  "first-retransmission": "the first retransmission of the RTO timer",
  "peer-closed": "the close of the socket of the peer",
};

/** These are the reasons of the measurements only, as the compiler gives them, and as the page tells them. */
const MEASURED: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray, at: (s: number) => string) => string]> = [
  [
    /^the corpus says the router forgets the flow ([\d.]+) to ([\d.]+) s after the last segment and that nothing notices it in ([\d.]+) s/,
    (match, at) =>
      `The corpus gives the forget of the router at ${at(Number(match[1]))} to ${at(Number(match[2]))} after the last segment, and nothing notices it in ${at(Number(match[3]))}. The harness of that run read silence through a router as the router keeping the flow. Thus the cell measures the forget.`,
  ],
  [
    /^the corpus cannot predict it: (\w+) \(([\d.]+)–([\d.]+) s\) and (\w+) \(([\d.]+) s\) can fire in either order$/,
    (match, at) =>
      `The ${match[1]} timer of Redis (${at(Number(match[2]))} to ${at(Number(match[3]))}) and the ${match[4]} of the kernel (${at(Number(match[5]))}) can fire in either order. Thus the corpus predicts neither, and the cell measures the end of the connection.`,
  ],
];

/** This function gives the prediction of a cell: its kind, its band and its text. */
const predictionOf = (cell: Cell) => {
  const p = cell.prediction;
  const at = timeAt(3);
  const none = { low: null, high: null, window: null };
  if (p.detects === null) {
    for (const [form, text] of MEASURED) {
      const match = form.exec(p.why);
      if (match !== null) return { kind: "measured", ...none, window: secondsOf(p.window), text: `This cell has no band. ${text(match, at)}` };
    }
    throw new Error(`${cell.name}: the reason "${p.why}" has no text for the page`);
  }
  if (p.detects) {
    const closes = CLOSERS[`${p.timer} ${p.errno}`];
    if (closes === undefined) throw new Error(`${cell.name}: the timer ${p.timer} with ${p.errno} has no text for the page`);
    const [low, high] = [secondsOf(p.low)!, secondsOf(p.high)!];
    return { kind: "detects", ...none, low, high, text: `The corpus predicts that ${closes}. The band is ${at(low)} to ${at(high)} after ${R3_FROM[p.from] ?? p.from}.` };
  }
  if (p.recovers !== undefined) {
    const [low, high] = [secondsOf(p.recovers.low)!, secondsOf(p.recovers.high)!];
    return { kind: "recovers", ...none, low, high, window: secondsOf(p.window), text: `The corpus predicts that the reply comes back ${at(low)} to ${at(high)} after the send of the request.` };
  }
  if (p.replies !== undefined) {
    const [low, high] = [secondsOf(p.replies.low)!, secondsOf(p.replies.high)!];
    return {
      kind: "replies",
      ...none,
      low,
      high,
      window: secondsOf(p.window),
      text: `The corpus predicts that the keepalive refreshes the flow before the router forgets it. Thus the request gets its reply ${at(low)} to ${at(high)} after its send.`,
    };
  }
  const window = secondsOf(p.window)!;
  return { kind: "silent", ...none, window, text: `The corpus predicts that nothing detects the fault in a window of ${at(window)}.` };
};

/** This function tells why CI did a cell again, from the prediction of its first run. It stops on a reason that it does not know. */
const repeatedOf = (name: string): string => {
  const first = firsts.get(name)?.cell.prediction;
  if (first?.detects === true && first.timer === "idle" && first.errno === "ETIMEDOUT")
    return "In the first CI run, the corpus said that the idle timeout of Redis ends the client with ETIMEDOUT. Redis closes the idle client itself, with a FIN. After that fix of the corpus, CI did the cell again.";
  if (first?.detects === true && first.timer === "rx.rst" && first.errno === "ECONNRESET")
    return "In the first CI run, the corpus raced the keepalive refresh with the forget of the router only for an idle flow. A flow that idles before its request races them too. After that fix of the corpus, CI did the cell again.";
  if (first?.detects === null && first.ends === undefined)
    return "In the first CI run, the measurement waited for a close by the peer of the observer, and no run measured a time. The close of Redis is its own. Then the compiler made the cell end on the close of the observer, and CI did the cell again.";
  throw new Error(`${name}: the page has no reason for its re-run`);
};

const cells = [...found.entries()]
  .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
  .map(([name, entry]) => {
    const named = nameOf(name);
    if (named.plan === null) throw new Error(`${name}: no cell of the plan`);
    return {
      ...named,
      group: named.catalog,
      stage: named.plan.split(".")[1]!,
      prediction: predictionOf(entry.record.cell),
      ...resultOf(read(entry), { digits: 3, silent: "Nothing detected the fault" }),
      // the δ_abs of the run of the cell: the first run of the queue had the default of the harness
      noise: secondsOf(entry.record.cell.noise ?? NOISE),
      first: entry.first,
      repeated: entry.first === null ? null : repeatedOf(name),
    };
  });

const records = [...found.values()].map((entry) => entry.record);
const date = dateOf(records.map((record) => record.at.ended));
const copy = {
  source: "the raw records of the runners of GitHub, judged again by the harness. A re-run replaces the first run of its cell",
  ranAt: date,
  units: "s",
  noise: noiseOf(records.map((record) => record.cell), NOISE),
  runs: Number(only("the count of runs", records.map((record) => String(record.cell.runs)))),
  kernel: runner.kernel,
  hz: runner.hz,
  target: only("the target", records.map((record) => record.cell.target.image.replace(/@.*$/, ""))),
  cells,
};
const out = fileURLToPath(new URL(`../src/data/r3-${date}.json`, import.meta.url));
writeFileSync(out, stringify(copy));
process.stdout.write(`${cells.length} cells, ${cells.reduce((sum, cell) => sum + cell.counted + cell.voided, 0)} runs: ${out}\n`);
