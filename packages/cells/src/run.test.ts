import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cell } from "@mark1russell7/harness";
import { runCell } from "@mark1russell7/harness";
import { describe, expect, it } from "vitest";
import { CELLS } from "./catalog.ts";

/**
 * The runner of the catalog. It starts only with CELLS=1, because it needs Docker and privileged
 * containers. CELLS_ONLY selects the cells whose names match a regular expression, and
 * CELLS_SHARD=i/n takes every n-th cell from the i-th, so that two processes can share the
 * catalog. Each cell writes its raw record (the cell, the manifests and every run with its kernel
 * records) to CELLS_OUT, in the format that jarvis lands, and one line of its verdict to
 * summary.ndjson there. A cell that fails is a finding to examine, not a failure of the runner.
 */
const RUN = process.env["CELLS"] === "1";
const ONLY = new RegExp(process.env["CELLS_ONLY"] ?? ".");
const [shard, of] = (process.env["CELLS_SHARD"] ?? "0/1").split("/").map(Number) as [number, number];
const OUT = process.env["CELLS_OUT"] ?? fileURLToPath(new URL("../out/", import.meta.url));

const selected: Cell[] = CELLS.filter((each) => ONLY.test(each.name)).filter((_, at) => at % of === shard);

/** This function gives a file name for a cell: its name in lower case, with a dash for each other character. */
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

describe.skipIf(!RUN)("the T01 catalog, on the harness", () => {
  mkdirSync(OUT, { recursive: true });
  for (const cell of selected) {
    it(cell.name, async () => {
      const result = await runCell(cell, (line) => console.log(line));
      writeFileSync(
        `${OUT}/${slug(cell.name)}.json`,
        JSON.stringify({
          format: "loom.cell-record/1",
          cell: result.cell,
          case: null,
          manifests: result.manifests,
          runs: result.runs,
          at: result.at,
        }),
      );
      const { verdict } = result;
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
          void: result.measured.filter((run) => run.void !== null).map((run) => run.void),
        })}\n`,
      );
      console.log(`${cell.name}: ${verdict.decision}, ${verdict.why}`);
      expect(result.runs.length).toBeGreaterThan(0);
    });
  }
});
