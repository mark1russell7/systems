import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Judged, KindCell, KindRun } from "@systems/kind";
import { calibrationOf, cellsTable, judgeKind, runKindCells } from "@systems/kind";
import { describe, expect, it } from "vitest";
import { T07_CELLS } from "./t07.ts";
import { T18_CELLS } from "./t18.ts";

/**
 * The runner of the kind catalogs, T07 and T18. It starts only with KIND_LAB=1, because it creates
 * kind clusters in Docker. KIND_ONLY selects the cells whose names match a regular expression.
 * KIND_OUT is the folder of the raw records and of summary.ndjson (the default is out/kind/).
 * KIND_ENVIRONMENTS is the number of new clusters for each group of cells (the default is 2).
 *
 * KIND_JUDGE=<folder> judges the raw records in a folder again with the cells as they are now, by
 * name, and prints the tables of a report. The calibration of the propagation changes the bands,
 * thus the records of a run are judged again after it.
 */
const RUN = process.env["KIND_LAB"] === "1";
const JUDGE = process.env["KIND_JUDGE"];
const ONLY = new RegExp(process.env["KIND_ONLY"] ?? ".");
const OUT = process.env["KIND_OUT"] ?? fileURLToPath(new URL("../out/kind/", import.meta.url));
const ENVIRONMENTS = Number(process.env["KIND_ENVIRONMENTS"] ?? 2);

const CATALOG: readonly KindCell[] = [...T07_CELLS, ...T18_CELLS];
const selected: KindCell[] = CATALOG.filter((cell) => ONLY.test(cell.name));

describe.skipIf(!RUN)("the kind catalogs, in kind", () => {
  it(`runs ${selected.length} cells`, async () => {
    const results = await runKindCells(selected, { out: OUT, log: (line) => console.log(line), environments: ENVIRONMENTS });
    for (const result of results) console.log(`${result.cell.name}: ${result.verdict.decision}, ${result.verdict.why}`);
    expect(results.length).toBe(selected.length);
  });
});

describe.skipIf(JUDGE === undefined)("the kind records, judged again", () => {
  it("judges each record with the cell of the catalog of the same name", () => {
    const judged: Judged[] = [];
    for (const file of readdirSync(JUDGE!).filter((name) => name.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(join(JUDGE!, file), "utf8")) as { format?: string; cell: KindCell; runs: KindRun[] };
      if (record.format !== "systems.kind-cell-record/1") continue;
      const cell = CATALOG.find((each) => each.name === record.cell.name);
      if (cell === undefined || !ONLY.test(cell.name)) continue;
      judged.push({ cell, runs: record.runs, verdict: judgeKind(cell, record.runs) });
    }
    judged.sort((a, b) => CATALOG.indexOf(a.cell) - CATALOG.indexOf(b.cell));
    writeFileSync(
      join(JUDGE!, "summary.judged.ndjson"),
      judged.map(({ cell, verdict }) => JSON.stringify({ id: cell.id, name: cell.name, decision: verdict.decision, counted: verdict.counted, voided: verdict.voided, failed: verdict.failed, median: verdict.median, why: verdict.why })).join("\n") + "\n",
    );
    console.log(cellsTable(judged));
    for (const each of judged.filter((one) => one.cell.calibrates)) console.log(each.cell.mode, JSON.stringify(calibrationOf(each)));
    for (const each of judged.filter((one) => one.verdict.decision === "fails")) console.log(`${each.cell.name}: ${each.verdict.why}`);
    expect(judged.length).toBeGreaterThan(0);
  });
});
