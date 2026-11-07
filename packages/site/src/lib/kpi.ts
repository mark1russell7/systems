// The numbers of the file `kpi.json` of the site. Each value comes from `docs/ROADMAP.md`, so no person types a number.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeKpi } from "@mark1russell7/site-pages";
import { commitTime } from "@mark1russell7/site-pages/vite";

/** The name of the project in the file. */
export const KPI_PROJECT = "systems";

/** The items of the piece S3. */
const S3_ITEMS = Array.from({ length: 18 }, (_, index) => `SYS-${58 + index}`);

/** The layers E0, E1 and E2 run today. Each item of this list adds one layer when it is done: E3, E4 and E5. */
const LAYERS_THAT_RUN = 3;
const LAYER_ITEMS = ["SYS-77", "SYS-81", "SYS-90"];

/** The item that holds the table of the rungs of the recovery drills. */
const RECOVERY_ITEM = "SYS-94";

/** One number of the file. */
export interface RoadmapMeasure {
  readonly id: string;
  readonly value: number;
  readonly unit: string;
}

/** This function splits the roadmap into its entries, by the id of the item. */
export function roadmapEntries(roadmap: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const part of roadmap.split(/^### /m).slice(1)) {
    const id = /^(SYS-\d+) /.exec(part)?.[1];
    if (id !== undefined) entries.set(id, part);
  }
  return entries;
}

/**
 * This function gives the measures of the roadmap.
 *
 * @throws When an item that a measure reads has no entry. A changed roadmap must not read as a count of 0.
 */
export function roadmapMeasures(roadmap: string): readonly RoadmapMeasure[] {
  const entries = roadmapEntries(roadmap);
  const entry = (id: string): string => {
    const text = entries.get(id);
    if (text === undefined) throw new Error(`The roadmap has no entry ${id}, so kpi.json cannot count it.`);
    return text;
  };
  const done = (id: string): boolean => /^- \*\*Status:\*\* (done|shipped)\s*$/m.test(entry(id));
  const rungs = entry(RECOVERY_ITEM)
    .split("\n")
    .filter((line) => /^\| Rung \d+\b.*\| holds \|/.test(line));
  return [
    { id: "s3-items-done", value: S3_ITEMS.filter(done).length, unit: "items" },
    { id: "environment-layers-live", value: LAYERS_THAT_RUN + LAYER_ITEMS.filter(done).length, unit: "layers" },
    { id: "recovery-rungs-held", value: rungs.length, unit: "rungs" },
  ];
}

/** This function writes `kpi.json` into the built site. The time of the data is the time of the commit of the build. */
export function writeSiteKpi(out: string, repoDir: string): void {
  const commit = process.env["GITHUB_SHA"] ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  const measures = roadmapMeasures(readFileSync(join(repoDir, "docs/ROADMAP.md"), "utf8"));
  writeKpi(out, { project: KPI_PROJECT, at: commitTime(process.env, repoDir), commit, measures: [...measures] });
}
