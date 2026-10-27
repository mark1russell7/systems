import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Judged, KindCell, KindCellRecord, KindCellRecordV1 } from "@mark1russell7/kind";
import { FORMAT, FORMAT_V1, calibrationOf, cellsTable, judgeKind, runKindCells, shardOf, upgrade } from "@mark1russell7/kind";
import { describe, expect, it } from "vitest";
import { CALLERS_CELLS } from "./callers.ts";
import { GATE_CELLS } from "./gate.ts";
import { T07_GRPC } from "./grpc/t07.ts";
import { T15_GRPC } from "./grpc/t15.ts";
import { T07_CELLS } from "./t07.ts";
import { T18_CELLS } from "./t18.ts";

/**
 * The runner of the kind catalogs, T07, T15 and T18. It starts only with KIND_LAB=1, because it makes
 * kind clusters in Docker. CI starts it on GitHub's runners (.github/workflows/kind.yml).
 * - KIND_ONLY selects the cells whose names match a regular expression.
 * - KIND_SHARD=i/n takes the i-th of n equal shares of the estimated time, the cells of one mode together.
 * - KIND_OUT is the folder of the raw records and of summary.ndjson (the default is out/kind/).
 * - KIND_WORK is the folder of the run folder of each cluster, outside the output: a kubeconfig holds credentials.
 * - KIND_ENVIRONMENTS is the number of new clusters for each group of cells (the default is 2).
 * - KIND_RUNS replaces the run count of each cell, for a smoke run.
 * - KIND_MODES names the dataplanes that the runner can do: the kube-proxy modes and `cilium`. Each cell of another mode waits,
 *   with the reason in KIND_WAITING, as a line of summary.ndjson.
 * - KIND_AMBIENT_WAITING, when it is not empty, is why the runner cannot do the ambient flavor of
 *   Istio: a module of istio-cni that does not load. Each ambient cell then waits with that reason.
 * - KIND_IDLE is the idle share of the CPUs that a run waits for (the default is 0.6).
 *
 * KIND_JUDGE=<folder> judges the raw records under a folder again with the cells of today,
 * by name, and prints the tables of a report. The calibration of the propagation changes the
 * bands, thus the records of a run are judged again after it. A record of the format `/1` is read
 * through `upgrade`.
 */
const RUN = process.env["KIND_LAB"] === "1";
const JUDGE = process.env["KIND_JUDGE"];
const ONLY = new RegExp(process.env["KIND_ONLY"] ?? ".");
const OUT = process.env["KIND_OUT"] ?? fileURLToPath(new URL("../out/kind/", import.meta.url));
const ENVIRONMENTS = Number(process.env["KIND_ENVIRONMENTS"] ?? 2);
const RUNS = process.env["KIND_RUNS"] === undefined || process.env["KIND_RUNS"] === "" ? null : Number(process.env["KIND_RUNS"]);
const MODES = (process.env["KIND_MODES"] ?? "iptables,ipvs,nftables,cilium").split(",").filter((mode) => mode !== "");
const [shard, of] = (process.env["KIND_SHARD"] ?? "0/1").split("/").map(Number) as [number, number];

const CATALOG: readonly KindCell[] = [...T07_CELLS, ...T18_CELLS, ...T07_GRPC, ...T15_GRPC, ...CALLERS_CELLS, ...GATE_CELLS];
const chosen: KindCell[] = shardOf(
  CATALOG.filter((cell) => ONLY.test(cell.name)),
  shard,
  of,
).map((cell) => (RUNS === null ? cell : { ...cell, runs: RUNS }));
const AMBIENT_WAITING = process.env["KIND_AMBIENT_WAITING"] ?? "";
/** This function gives why the runner cannot do a cell, or null when it can. */
const whyWaiting = (cell: KindCell): string | null => {
  if (!MODES.includes(cell.mode)) return process.env["KIND_WAITING"] ?? `the runner has no ${cell.mode} mode`;
  if (cell.mesh?.flavor === "ambient" && AMBIENT_WAITING !== "") return AMBIENT_WAITING;
  return null;
};
const selected = chosen.filter((cell) => whyWaiting(cell) === null);
const waiting = chosen.filter((cell) => whyWaiting(cell) !== null);

describe.skipIf(!RUN)("the kind catalogs, in kind", () => {
  it(`runs ${selected.length} cells`, async () => {
    mkdirSync(OUT, { recursive: true });
    for (const cell of waiting) {
      const why = whyWaiting(cell)!;
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
      const data = JSON.parse(readFileSync(file, "utf8")) as { format?: string };
      if (data.format !== FORMAT && data.format !== FORMAT_V1) continue;
      const record = upgrade(data as KindCellRecord | KindCellRecordV1);
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
    const report = [
      cellsTable(judged),
      "",
      ...judged.filter((one) => one.cell.calibrates).map((each) => `${each.cell.mode} ${JSON.stringify(calibrationOf(each))}`),
      "",
      ...judged.filter((one) => one.verdict.decision === "fails").map((each) => `${each.cell.name}: ${each.verdict.why}`),
    ].join("\n");
    writeFileSync(join(JUDGE!, "report.md"), `${report}\n`);
    console.log(report);
    expect(judged.length).toBeGreaterThan(0);
  });
});
