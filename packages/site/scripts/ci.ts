// The CI ledger: the events of the runs of a workflow of cells that did not give a clean result.
//
//   pnpm exec tsx packages/site/scripts/ci.ts <run id>...
//
// For each run, the script reads the run and its jobs (gh run view --json), and it downloads the
// artifacts of the run to a temporary folder (gh run download). For each job that did not succeed, it
// also reads the annotations of the job and its log. It gives each void run of each raw record, and each
// job that did not succeed, as an event (src/lib/ci.ts). Then it adds the run and its events to
// src/data/ci/<workflow>.json. A second scan of a run replaces its entry and adds no event twice.
//
// A raw record of a kind cell gives the void reason of each run. A raw record of the harness gives it
// through `measure` of the harness. A partial record of a kind cell is the record of an environment of
// a shard that did not end. The ledger keeps no address, user, path or name of a person.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Cell, Run } from "../../harness/src/index.ts";
import { measure } from "../../harness/src/index.ts";
import type { KindCellRecord, KindCellRecordV1, KindRun } from "../../kind/src/index.ts";
import { FORMAT, FORMAT_V1, upgrade } from "../../kind/src/index.ts";
import type { CellRunInput, Ledger, RecordInput, RunInput, ShardInput, WorkflowOptions } from "../src/lib/ci.ts";
import { eventsOf, merged } from "../src/lib/ci.ts";
import { stringify } from "./records.ts";

const REPO = "mark1russell7/systems";

/** The workflows of cells, by the name that GitHub gives: the file of the ledger, the workflow file, and the options. */
const WORKFLOWS: Readonly<Record<string, { readonly name: string; readonly file: string; readonly options: WorkflowOptions }>> = {
  Kind: { name: "kind", file: ".github/workflows/kind.yml", options: { step: "The cells", idle: 0.6 } },
  Cells: { name: "cells", file: ".github/workflows/cells.yml", options: { step: "The cells", idle: 0.6 } },
};

const gh = (args: readonly string[]): string => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

/** This function gives the runs of a kind record, with the void reason of each. */
const kindRuns = (runs: readonly KindRun[]): CellRunInput[] => runs.map((run) => ({ env: run.env, index: run.index, warmup: run.warmup, void: run.void }));

/** This function gives the runs of a raw record of the harness, with the void reason of each from `measure`. */
const harnessRuns = (cell: Cell, runs: readonly Run[], warmups: readonly Run[]): CellRunInput[] =>
  [...warmups, ...runs].map((run) => {
    const warmup = run.warmup === true || warmups.includes(run);
    const measured = measure(cell, run);
    return { env: run.environment, index: run.index, warmup, void: measured.void };
  });

/** One line of summary.ndjson, with the fields that a record of an unknown format needs. */
interface SummaryLine {
  readonly name: string;
  readonly mode?: string;
  readonly voided?: number;
}

/** This function reads the records of the folder of one artifact: its raw records, its partial records, and summary.ndjson for a record of an unknown format. */
const recordsOf = (folder: string, dataplane: string): RecordInput[] => {
  const out: RecordInput[] = [];
  const summary = existsSync(join(folder, "summary.ndjson"))
    ? readFileSync(join(folder, "summary.ndjson"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as SummaryLine)
    : [];
  const named = new Set<string>();
  const files = readdirSync(folder).filter((name) => name.endsWith(".json")).sort();
  for (const file of files) {
    const data = JSON.parse(readFileSync(join(folder, file), "utf8")) as { format?: string; cell?: { name?: string; mode?: string; id?: string } };
    const name = data.cell?.name;
    if (name === undefined) continue;
    if (data.format === FORMAT || data.format === FORMAT_V1) {
      const record = upgrade(data as KindCellRecord | KindCellRecordV1);
      out.push({ cell: record.cell.id, dataplane: record.cell.mode, runs: kindRuns(record.runs) });
      named.add(name);
      continue;
    }
    if (data.format === "loom.cell-record/1") {
      const record = data as unknown as { cell: Cell; runs: readonly Run[]; warmups?: readonly Run[] };
      try {
        out.push({ cell: name, dataplane, runs: harnessRuns(record.cell, record.runs, record.warmups ?? []) });
        named.add(name);
      } catch (error) {
        console.warn(`${file}: the harness cannot measure it (${String(error)}), thus summary.ndjson gives its void runs`);
      }
    }
  }
  // the partial records of a shard that did not end: the environments that it ended, for each cell with no record
  const partial = join(folder, "partial");
  if (existsSync(partial) && statSync(partial).isDirectory()) {
    for (const file of readdirSync(partial).filter((name) => name.endsWith(".json")).sort()) {
      const data = JSON.parse(readFileSync(join(partial, file), "utf8")) as { cell: { id: string; name: string; mode: string }; runs: readonly KindRun[] };
      if (named.has(data.cell.name)) continue;
      out.push({ cell: data.cell.id, dataplane: data.cell.mode, runs: kindRuns(data.runs) });
    }
  }
  // a line of summary.ndjson with no record that the script can read: its void runs, with no reason
  for (const line of summary) {
    if (named.has(line.name) || (line.voided ?? 0) === 0) continue;
    const runs: CellRunInput[] = Array.from({ length: line.voided ?? 0 }, (_, index) => ({ env: null, index, warmup: false, void: "the record gives no reason" }));
    out.push({ cell: line.name, dataplane: line.mode ?? dataplane, runs });
  }
  return out;
};

const ids = process.argv.slice(2);
if (ids.length === 0 || ids.some((id) => !/^\d+$/.test(id))) throw new Error("give the id of each run: pnpm exec tsx packages/site/scripts/ci.ts <run id>...");

for (const id of ids) {
  const run = JSON.parse(gh(["run", "view", id, "-R", REPO, "--json", "databaseId,workflowName,event,headBranch,conclusion,status,createdAt,url,jobs"])) as RunInput & { readonly workflowName: string };
  const workflow = WORKFLOWS[run.workflowName];
  if (workflow === undefined) throw new Error(`the run ${id} is of the workflow ${run.workflowName}, which has no ledger`);
  const path = fileURLToPath(new URL(`../src/data/ci/${workflow.name}.json`, import.meta.url));
  const ledger: Ledger = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Ledger)
    : { workflow: workflow.name, file: workflow.file, idle: workflow.options.idle, runs: [], events: [] };
  const folder = mkdtempSync(join(tmpdir(), `ci-ledger-${id}-`));
  try {
    const artifacts = JSON.parse(gh(["api", `repos/${REPO}/actions/runs/${id}/artifacts`, "--jq", "[.artifacts[] | select(.expired | not) | .name]"])) as string[];
    if (artifacts.length > 0) gh(["run", "download", id, "-R", REPO, "-D", folder]);
    const shards = new Map<number, ShardInput>();
    for (const job of run.jobs) {
      const shard = /\((\d+)\)$/.exec(job.name)?.[1];
      const artifact = shard === undefined ? undefined : artifacts.find((name) => name === `${workflow.name}-${shard}`);
      // a single artifact of a download can go in the folder itself, not in a folder of its name
      const dir = artifact === undefined ? null : existsSync(join(folder, artifact)) ? join(folder, artifact) : artifacts.length === 1 ? folder : null;
      const records = dir !== null && existsSync(dir) ? recordsOf(dir, "docker") : [];
      const clean = ["success", "skipped", "neutral"].includes(job.conclusion);
      const annotations = clean ? [] : (JSON.parse(gh(["api", `repos/${REPO}/check-runs/${job.databaseId}/annotations`, "--jq", "[.[].message]"])) as string[]);
      let log: string | null = null;
      if (!clean) {
        try {
          log = gh(["run", "view", id, "-R", REPO, "--log", "--job", String(job.databaseId)]);
        } catch (error) {
          console.warn(`the log of the job ${job.databaseId} is not available: ${String(error)}`);
        }
      }
      shards.set(job.databaseId, { records, annotations, log });
    }
    const found = eventsOf(run, shards, workflow.options);
    const next = merged(ledger, found.run, found.events);
    writeFileSync(path, stringify(next));
    console.log(`${workflow.name} ${id}: ${found.run.shards} shards, ${found.events.length} events, ${next.events.length - ledger.events.length} new`);
    for (const event of found.events) console.log(`  shard ${event.shard ?? "-"} ${event.kind} (${event.cause}) ${event.cell ?? ""}: ${event.detail}`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
