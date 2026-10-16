import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Judged, KindCell, KindRun } from "@systems/kind";
import { calibrationOf, cellsTable, judgeKind, runKindCells, shardOf } from "@systems/kind";
import { describe, expect, it } from "vitest";
import { T07_CELLS } from "./t07.ts";
import { T18_CELLS } from "./t18.ts";

/**
 * The runner of the kind catalogs, T07 and T18. It starts only with KIND_LAB=1, because it creates
 * kind clusters in Docker. CI starts it on GitHub's runners (.github/workflows/kind.yml).
 * - KIND_ONLY selects the cells whose names match a regular expression.
 * - KIND_SHARD=i/n takes the i-th of n equal shares of the estimated time, the cells of one mode together.
 * - KIND_OUT is the folder of the raw records and of summary.ndjson (the default is out/kind/).
 * - KIND_WORK is the folder of the run folder of each cluster, outside the output: a kubeconfig holds credentials.
 * - KIND_ENVIRONMENTS is the number of new clusters for each group of cells (the default is 2).
 * - KIND_RUNS replaces the run count of each cell, for a smoke run.
 * - KIND_MODES names the kube-proxy modes that the runner can do. Each cell of another mode waits,
 *   with the reason in KIND_WAITING, as a line of summary.ndjson.
 * - KIND_IDLE is the idle share of the CPUs that a run waits for (the default is 0.6).
 *
 * KIND_JUDGE=<folder> judges the raw records under a folder again with the cells as they are now,
 * by name, and prints the tables of a report. The calibration of the propagation changes the
 * bands, thus the records of a run are judged again after it.
 */
const RUN = process.env["KIND_LAB"] === "1";
const JUDGE = process.env["KIND_JUDGE"];
const ONLY = new RegExp(process.env["KIND_ONLY"] ?? ".");
const OUT = process.env["KIND_OUT"] ?? fileURLToPath(new URL("../out/kind/", import.meta.url));
const ENVIRONMENTS = Number(process.env["KIND_ENVIRONMENTS"] ?? 2);
const RUNS = process.env["KIND_RUNS"] === undefined || process.env["KIND_RUNS"] === "" ? null : Number(process.env["KIND_RUNS"]);
const MODES = (process.env["KIND_MODES"] ?? "iptables,ipvs,nftables").split(",").filter((mode) => mode !== "");
const [shard, of] = (process.env["KIND_SHARD"] ?? "0/1").split("/").map(Number) as [number, number];

const CATALOG: readonly KindCell[] = [...T07_CELLS, ...T18_CELLS];
const chosen: KindCell[] = shardOf(
  CATALOG.filter((cell) => ONLY.test(cell.name)),
  shard,
  of,
).map((cell) => (RUNS === null ? cell : { ...cell, runs: RUNS }));
const selected = chosen.filter((cell) => MODES.includes(cell.mode));
const waiting = chosen.filter((cell) => !MODES.includes(cell.mode));

describe.skipIf(!RUN)("the kind catalogs, in kind", () => {
  it(`runs ${selected.length} cells`, async () => {
    mkdirSync(OUT, { recursive: true });
    for (const cell of waiting) {
      const why = process.env["KIND_WAITING"] ?? `the runner has no ${cell.mode} mode`;
      const line = { id: cell.id, name: cell.name, mode: cell.mode, trigger: cell.trigger.kind, prediction: cell.prediction.kind, decision: "waiting", why };
      appendFileSync(join(OUT, "summary.ndjson"), `${JSON.stringify(line)}\n`);
      console.log(`${cell.name}: waiting, ${why}`);
    }
    const results = await runKindCells(selected, {
      out: OUT,
      log: (line) => console.log(line),
      environments: ENVIRONMENTS,
      ...(process.env["KIND_WORK"] === undefined ? {} : { work: process.env["KIND_WORK"] }),
      ...(process.env["KIND_IDLE"] === undefined ? {} : { idle: Number(process.env["KIND_IDLE"]) }),
    });
    for (const result of results) console.log(`${result.cell.name}: ${result.verdict.decision}, ${result.verdict.why}`);
    expect(results.length).toBe(selected.length);
  });
});

/** the files of the raw records under a folder, in each folder of an artifact, without the partial records */
const recordsUnder = (folder: string): string[] =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === "partial" ? [] : recordsUnder(path);
    return name.endsWith(".json") ? [path] : [];
  });

describe.skipIf(JUDGE === undefined)("the kind records, judged again", () => {
  it("judges each record with the cell of the catalog of the same name", () => {
    const judged: Judged[] = [];
    for (const file of recordsUnder(JUDGE!)) {
      const record = JSON.parse(readFileSync(file, "utf8")) as { format?: string; cell: KindCell; runs: KindRun[] };
      if (record.format !== "systems.kind-cell-record/1") continue;
      const cell = CATALOG.find((each) => each.name === record.cell.name);
      if (cell === undefined || !ONLY.test(cell.name)) continue;
      judged.push({ cell, runs: record.runs, verdict: judgeKind(cell, record.runs) });
    }
    judged.sort((a, b) => CATALOG.indexOf(a.cell) - CATALOG.indexOf(b.cell));
    writeFileSync(
      join(JUDGE!, "summary.judged.ndjson"),
      judged
        .map(({ cell, verdict }) =>
          JSON.stringify({ id: cell.id, name: cell.name, decision: verdict.decision, counted: verdict.counted, voided: verdict.voided, failed: verdict.failed, median: verdict.median, why: verdict.why }),
        )
        .join("\n") + "\n",
    );
    console.log(cellsTable(judged));
    for (const each of judged.filter((one) => one.cell.calibrates)) console.log(each.cell.mode, JSON.stringify(calibrationOf(each)));
    for (const each of judged.filter((one) => one.verdict.decision === "fails")) console.log(`${each.cell.name}: ${each.verdict.why}`);
    expect(judged.length).toBeGreaterThan(0);
  });
});
