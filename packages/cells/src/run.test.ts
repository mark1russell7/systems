import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cell, CellResult, Subject } from "@mark1russell7/harness";
import { cloudOf, measure, noiseOf, pairingsOf, readHost, recordProblems, runCell, substrateKey, substrateOf } from "@mark1russell7/harness";
import { subjectSchema } from "@mark1russell7/harness/schema";
import { describe, expect, it } from "vitest";
import type { Subjects } from "./all.ts";
import { catalogs, selectedOf } from "./all.ts";
import { codeHere } from "./commit.ts";
import { environmentOf } from "./environments.ts";
import type { BenchTime, PairCell, PairSlot } from "./limiter.ts";
import { benchTimes, LIMITER_SPECS, limiterBench, pairedLines, pairOf } from "./limiter.ts";

/**
 * The runner of the catalog. It starts only with CELLS=1, because it needs Docker and privileged
 * containers. CELLS_ONLY selects the cells whose names match a regular expression. CELLS_SHARD=i/n
 * takes every n-th cell from the i-th, so that two processes can share the catalog. Each cell
 * writes its raw record (the cell, the manifests and every run with its kernel records) to
 * CELLS_OUT, in the format that the private repository lands. It also writes one line of its verdict to
 * summary.ndjson there. A cell that fails is a finding to examine, not a failure of the runner.
 *
 * CELLS_FILE names a JSON file of cells that another repository compiles. Its cells then operate
 * in place of the catalogs, with the same selection and the same records. CELLS_SUBJECT is a
 * subject as JSON (`Subject`), which replaces the subject of its name in the catalogs. Another
 * repository operates the WS and WST cells on its own release this way. CELLS_PAIR is two versions
 * of the service, for example "0.5.6,0.6.0", and CELLS_PAIR_DIR holds a target folder for each version.
 *
 * With CELLS_PAIR, the cells of the limiter pair replace the catalogs (limiterBench). In each
 * round, the A/B pair of the control and the candidate operates, then the A/A pair of the control.
 * Each raw record of a pair cell has its slot. paired.ndjson gets the PairedTime lines of rigor-bench.
 */
const RUN = process.env["CELLS"] === "1";
const ONLY = new RegExp(process.env["CELLS_ONLY"] ?? ".");
const [shard, of] = (process.env["CELLS_SHARD"] ?? "0/1").split("/").map(Number) as [number, number];
const OUT = process.env["CELLS_OUT"] ?? fileURLToPath(new URL("../out/", import.meta.url));
const FILE = process.env["CELLS_FILE"] || undefined;
const SUBJECT: Subject | undefined = process.env["CELLS_SUBJECT"] ? subjectSchema.parse(JSON.parse(process.env["CELLS_SUBJECT"])) : undefined;

/** These are the subjects of the catalogs: the subject of the caller in place of the one of its name. */
const subjects = (subject: Subject | undefined): Partial<Subjects> => {
  if (subject === undefined) return {};
  if (subject.name !== "procedures") throw new Error(`no catalog takes the subject ${subject.name}: the catalogs take procedures`);
  return { procedures: subject };
};

const PAIR = process.env["CELLS_PAIR"] || undefined;
const PAIR_DIR = process.env["CELLS_PAIR_DIR"] || undefined;

/** These are the cells of the limiter pair with their slots, if CELLS_PAIR gives a pair. */
const benchOf = (): readonly PairCell[] | undefined => {
  if (PAIR === undefined) return undefined;
  if (FILE !== undefined || PAIR_DIR === undefined) throw new Error("CELLS_PAIR needs CELLS_PAIR_DIR, and it takes no CELLS_FILE");
  return limiterBench(pairOf(PAIR, PAIR_DIR), of, ONLY);
};
const bench = benchOf();
const slots = new Map((bench ?? []).map((each) => [each.cell.name, each.slot]));

/** These cells are the cells of the limiter pair, of the file, or of the catalogs on their subjects. */
const sourceOf = (): readonly Cell[] => {
  if (bench !== undefined) return bench.map((each) => each.cell);
  return FILE === undefined ? catalogs(subjects(SUBJECT)) : (JSON.parse(readFileSync(FILE, "utf8")) as Cell[]);
};
const source: readonly Cell[] = sourceOf();

/** These are the times of the first arm of each pair in each round, until its second arm comes. */
const waiting = new Map<string, { readonly slot: PairSlot; readonly times: readonly BenchTime[] }>();

/**
 * This function gives the times of a pair cell. A void run gives no time, thus the cell runs once
 * more, in a new environment. The reason of the void run goes to its line in summary.ndjson.
 */
const timesOf = (slot: PairSlot, result: CellResult): readonly BenchTime[] => {
  const spec = LIMITER_SPECS.find((each) => each.plan === slot.plan);
  if (spec === undefined) throw new Error(`no limiter spec has the plan ${slot.plan}`);
  return result.measured.flatMap((run) => benchTimes(spec, run));
};

/** This function writes the PairedTime lines of rigor-bench to paired.ndjson when the second arm of a pair comes. */
const pairTimes = (slot: PairSlot, times: readonly BenchTime[]): void => {
  const key = `${slot.plan} ${slot.block} ${slot.round}`;
  const first = waiting.get(key);
  if (first === undefined) {
    waiting.set(key, { slot, times });
    return;
  }
  waiting.delete(key);
  const lines = pairedLines(first, { slot, times });
  appendFileSync(`${OUT}/paired.ndjson`, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
};
const selected = selectedOf(source, ONLY, shard, of);

/** This environment is the runner image, when stage 0 calibrated it. A cell without its own δ_abs gets the image's. */
const environment = environmentOf(cloudOf(readHost().vendor));
const inEnvironment = (cell: Cell): Cell =>
  cell.noise !== undefined || environment === undefined ? cell : { ...cell, noise: environment.noise };

/** This record is the commit of the code that operates the cells (`codeHere`). */
const code = codeHere();

/**
 * CELLS_DEBUG=1 marks a local debug run. Its records are marked so (`debug`), and no page reads
 * them. Only such a run can operate from a checkout with changes, or with an image that no digest
 * pins.
 */
const DEBUG = process.env["CELLS_DEBUG"] === "1";

/**
 * This function gives each problem that stops a record from pinning the programs of its runs
 * (`recordProblems`). The summary line of the cell holds them. A record with a problem is not a
 * record, thus its cell fails unless the run is a debug run (SYS-101).
 */
const pinsOf = (manifests: CellResult["manifests"]): string[] => recordProblems({ code, manifests, debug: DEBUG });

/** This function gives a file name for a cell: its name in lower case, with a dash for each other character. */
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

describe.skipIf(!RUN)("the catalogs, on the harness", () => {
  mkdirSync(OUT, { recursive: true });
  for (const cell of selected) {
    it(cell.name, async () => {
      const slot = slots.get(cell.name);
      let result = await runCell(inEnvironment(cell), (line) => console.log(line));
      let again: readonly (string | null)[] | undefined;
      if (slot !== undefined && timesOf(slot, result).length === 0) {
        again = result.measured.map((run) => run.void);
        result = await runCell(inEnvironment(cell), (line) => console.log(line));
      }
      const pins = pinsOf(result.manifests);
      writeFileSync(
        `${OUT}/${slug(cell.name)}.json`,
        JSON.stringify({
          format: "loom.cell-record/1",
          ...(code === undefined ? {} : { code }),
          ...(DEBUG ? { debug: true } : {}),
          cell: result.cell,
          case: null,
          ...(slot === undefined ? {} : { pair: slot }),
          manifests: result.manifests,
          runs: result.runs,
          warmups: result.warmups,
          at: result.at,
        }),
      );
      const { verdict } = result;
      const pairings = pairingsOf(result.measured, noiseOf(result.cell));
      appendFileSync(
        `${OUT}/summary.ndjson`,
        `${JSON.stringify({
          name: cell.name,
          decision: verdict.decision,
          counted: verdict.counted,
          voided: verdict.voided,
          median: verdict.median,
          band: verdict.band,
          outside: verdict.outside,
          why: verdict.why,
          substrate: substrateKey(substrateOf(result.manifests[0] ?? {}, result.at.started)),
          pins,
          ...(verdict.reordering === undefined ? {} : { reordering: verdict.reordering }),
          ...(verdict.proxy === undefined ? {} : { proxy: verdict.proxy }),
          ...(verdict.requests === undefined ? {} : { requests: verdict.requests }),
          ...(verdict.reconnect === undefined ? {} : { reconnect: verdict.reconnect }),
          ...(verdict.calls === undefined ? {} : { calls: verdict.calls }),
          ...(verdict.left === undefined ? {} : { left: verdict.left }),
          void: result.measured.filter((run) => run.void !== null).map((run) => run.void),
          // a pair cell whose run gave no time ran once more: these are the void reasons of the first time
          ...(again === undefined ? {} : { again }),
          // the jitter bound of the program and the pairing window of the runs, against δ_abs of the cell
          ...(pairings === null ? {} : { pairing: { noise: noiseOf(result.cell), ...pairings } }),
          warmups: result.warmups.map((run) => {
            const read = measure(cell, run);
            return read.elapsed?.value ?? read.outcome.kind;
          }),
        })}\n`,
      );
      console.log(`${cell.name}: ${verdict.decision}, ${verdict.why}`);
      if (slot !== undefined) pairTimes(slot, timesOf(slot, result));
      expect(result.runs.length).toBeGreaterThan(0);
      // a record that does not pin its programs is not a record: the run exits with 1 (SYS-101)
      if (!DEBUG) expect(pins, `${cell.name}: the record does not pin its programs`).toEqual([]);
    });
  }
});
