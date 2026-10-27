import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cell, Subject } from "@mark1russell7/harness";
import { measure, noiseOf, pairingsOf, runCell } from "@mark1russell7/harness";
import { subjectSchema } from "@mark1russell7/harness/schema";
import { describe, expect, it } from "vitest";
import type { Subjects } from "./all.ts";
import { catalogs } from "./all.ts";
import { environmentOf } from "./environments.ts";
import { limiterPair, pairOf } from "./limiter.ts";

/**
 * The runner of the catalog. It starts only with CELLS=1, because it needs Docker and privileged
 * containers. CELLS_ONLY selects the cells whose names match a regular expression, and
 * CELLS_SHARD=i/n takes every n-th cell from the i-th, so that two processes can share the
 * catalog. Each cell writes its raw record (the cell, the manifests and every run with its kernel
 * records) to CELLS_OUT, in the format that jarvis lands, and one line of its verdict to
 * summary.ndjson there. A cell that fails is a finding to examine, not a failure of the runner.
 * CELLS_FILE names a JSON file of cells that another repository compiles. Its cells then run in
 * place of the catalogs, with the same selection and the same records. CELLS_SUBJECT is a subject
 * as JSON (`Subject`), which replaces the subject of its name in the catalogs: another repository
 * runs the WS and WST cells on its own release this way. CELLS_PAIR is two versions of the
 * service, for example "0.5.6,0.6.0", and CELLS_PAIR_DIR holds a target folder for each version.
 * The cells of the limiter on the control and on the candidate then replace the catalogs (limiterPair).
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

/** These cells are the cells of the limiter pair, of the file, or of the catalogs on their subjects. */
const sourceOf = (): readonly Cell[] => {
  if (PAIR !== undefined) {
    if (FILE !== undefined || PAIR_DIR === undefined) throw new Error("CELLS_PAIR needs CELLS_PAIR_DIR, and it takes no CELLS_FILE");
    return limiterPair(pairOf(PAIR, PAIR_DIR), of, ONLY);
  }
  return FILE === undefined ? catalogs(subjects(SUBJECT)) : (JSON.parse(readFileSync(FILE, "utf8")) as Cell[]);
};
const source: readonly Cell[] = sourceOf();
const selected: Cell[] = source.filter((each) => ONLY.test(each.name)).filter((_, at) => at % of === shard);

/** This environment is the runner image, when stage 0 calibrated it. A cell without its own δ_abs gets the image's. */
const environment = environmentOf();
const inEnvironment = (cell: Cell): Cell =>
  cell.noise !== undefined || environment === undefined ? cell : { ...cell, noise: environment.noise };

/** This function gives a file name for a cell: its name in lower case, with a dash for each other character. */
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

describe.skipIf(!RUN)("the catalogs, on the harness", () => {
  mkdirSync(OUT, { recursive: true });
  for (const cell of selected) {
    it(cell.name, async () => {
      const result = await runCell(inEnvironment(cell), (line) => console.log(line));
      writeFileSync(
        `${OUT}/${slug(cell.name)}.json`,
        JSON.stringify({
          format: "loom.cell-record/1",
          cell: result.cell,
          case: null,
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
          ...(verdict.reordering === undefined ? {} : { reordering: verdict.reordering }),
          ...(verdict.proxy === undefined ? {} : { proxy: verdict.proxy }),
          ...(verdict.requests === undefined ? {} : { requests: verdict.requests }),
          ...(verdict.reconnect === undefined ? {} : { reconnect: verdict.reconnect }),
          ...(verdict.calls === undefined ? {} : { calls: verdict.calls }),
          ...(verdict.left === undefined ? {} : { left: verdict.left }),
          void: result.measured.filter((run) => run.void !== null).map((run) => run.void),
          // the jitter bound of the program and the pairing window of the runs, against δ_abs of the cell
          ...(pairings === null ? {} : { pairing: { noise: noiseOf(result.cell), ...pairings } }),
          warmups: result.warmups.map((run) => {
            const read = measure(cell, run);
            return read.elapsed?.value ?? read.outcome.kind;
          }),
        })}\n`,
      );
      console.log(`${cell.name}: ${verdict.decision}, ${verdict.why}`);
      expect(result.runs.length).toBeGreaterThan(0);
    });
  }
});
