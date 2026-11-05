// The data stamps of the pages of results. Each page names the data files that it shows. The date and the versions come
// from those files, so no person types them twice. Each study stays fixed: a newer run writes a new file and a new entry.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_STAMP_SCHEMA } from "@mark1russell7/site-pages";
import type { DataRun, DataStamps, PageStamp } from "@mark1russell7/site-pages";

const DATA_URL = "https://github.com/mark1russell7/systems/blob/main/packages/site/src/data";

/** The records of the lab name no kernel. The pages of these records name Linux 6.6, on one machine with no CI run. */
const LAB_KERNEL = "6.6";

/** The file `harness-2026-10-13.json` names no target. Its page names a stock Redis 7.4 container. */
const LAB_TARGET = "7.4";

/** One data file of a page. */
interface Source {
  readonly file: string;
  /** The words that the page shows in place of `run`. */
  readonly method: string;
  /** The versions that the file does not name. */
  readonly engines?: Readonly<Record<string, string>>;
}

const file = (name: string): Source => ({ file: name, method: "data file" });
const lab = (name: string, target?: string): Source => ({
  file: name,
  method: "lab data file",
  engines: { kernel: LAB_KERNEL, ...(target === undefined ? {} : { redis: target }) },
});

/** The data files of each page with a fixed study, by the id of the page. */
const STUDIES: Readonly<Record<string, readonly Source[]>> = {
  "lab/detection": [lab("harness-2026-10-08.json")],
  "results/harness": [lab("harness-2026-10-08.json")],
  "results/calibration": [lab("harness-2026-10-13.json", LAB_TARGET)],
  "results/cells": [lab("harness-2026-10-13.json", LAB_TARGET)],
  "results/timers": [lab("harness-2026-10-13.json", LAB_TARGET)],
  "results/faults": [file("faults-2026-10-17.json")],
  "results/topologies": [file("topologies-2026-10-17.json")],
  "results/sentinel": [file("sentinel-2026-10-17.json")],
  "results/http": [file("http-2026-10-17.json")],
  "results/r3": [file("r3-2026-10-17.json")],
  "results/mongodb": [file("mongodb-2026-10-18.json")],
  "results/pg": [file("pg-2026-10-19.json")],
  "results/rabbitmq": [file("rabbitmq-2026-10-19.json")],
  "results/grpc": [file("grpc-2026-10-20.json")],
  "results/mesh": [file("t15-2026-10-25.json")],
};

/**
 * The lab of the home page shows the runs of this file. The findings of the home page link to their pages of results,
 * and each of those pages has its own stamp.
 */
export const HOME_LAB_FILE = "harness-2026-10-08.json";

/** The page of Kubernetes shows many files. Its stamp names the first file and the newest file of the series `s2`. */
const KIND_PAGE = "results/kind";
const KIND_FIRST = "kind-2026-10-18.json";

/** The pages of results with no stamp, each with its reason. */
export const NOT_STAMPED: Readonly<Record<string, string>> = {
  "results/recovery": "A scheduled run replaces its data each Sunday, and its first scheduled run is on 2026-11-08. The limit of this page follows that run.",
  "results/ci": "The ledger counts the runs of the workflows, and it names no engine. The page says the period of its runs.",
};

/** This function gives each name with its version in a text, for example `redis:7.4` or `grpc-go v1.84.0`. */
export function versionsIn(text: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const match of text.matchAll(/([A-Za-z][\w-]*)[: ]v?(\d+(?:\.\d+)+)/g)) {
    const [, name, version] = match;
    if (name !== undefined && version !== undefined) versions[name] = version;
  }
  return versions;
}

/** The fields of a data file that a stamp reads. */
interface StudyData {
  readonly ranAt?: string;
  readonly date?: string;
  readonly target?: string;
  readonly client?: string;
  readonly clients?: Readonly<Record<string, string>>;
  readonly kernel?: string;
  readonly kubernetes?: string;
  readonly kind?: string;
}

/** This function gives the versions that a data file names. A file with two kernels gives both. */
export function enginesOf(data: StudyData): Record<string, string> {
  const engines = versionsIn([data.target ?? "", data.client ?? "", ...Object.values(data.clients ?? {})].join(", "));
  for (const name of ["kubernetes", "kind"] as const) {
    const version = data[name];
    if (version !== undefined) engines[name] = version.replace(/^v/, "");
  }
  const kernels = data.kernel?.split(" and ") ?? [];
  if (kernels.length === 1 && kernels[0] !== undefined) engines["kernel"] = kernels[0];
  for (const [index, kernel] of kernels.length > 1 ? kernels.entries() : []) engines[`runner-${index + 1}/kernel`] = kernel;
  return engines;
}

/** This function gives the date in the name of a data file. A file with no date in its name stops the build. */
export function dateInName(name: string): string {
  const date = /(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1];
  if (date === undefined) throw new Error(`The data file ${name} has no date in its name.`);
  return date;
}

const read = (folder: string, name: string): StudyData => JSON.parse(readFileSync(join(folder, name), "utf8")) as StudyData;

/** This function gives the run of one data file. */
function runOf(folder: string, source: Source): DataRun {
  const data = read(folder, source.file);
  return {
    id: source.file,
    url: `${DATA_URL}/${source.file}`,
    date: data.ranAt ?? data.date ?? dateInName(source.file),
    engines: { ...enginesOf(data), ...source.engines },
    method: source.method,
  };
}

/** This function gives the name of the newest file of the series `s2`, by the date of the file and then by its name. */
export function newestSeriesFile(names: readonly string[]): string {
  const series = names.filter((name) => /^s2-.*\.json$/.test(name));
  const newest = [...series].sort((a, b) => dateInName(a).localeCompare(dateInName(b)) || a.localeCompare(b)).at(-1);
  if (newest === undefined) throw new Error("The folder of the data has no file of the series s2.");
  return newest;
}

const stamp = (id: string, runs: readonly DataRun[]): PageStamp => ({ page: `${id}/index.html`, runs, study: true });

/** This function gives the stamps of the site from the data files in `folder`. A missing file stops the build. */
export function siteDataStamps(folder: string): DataStamps {
  const newest = newestSeriesFile(readdirSync(folder));
  const kind = [
    { ...runOf(folder, file(KIND_FIRST)), method: "first data file" },
    { ...runOf(folder, file(newest)), method: "newest data file" },
  ];
  return {
    schema: DATA_STAMP_SCHEMA,
    pages: [homeStamp(folder), ...Object.entries(STUDIES).map(([id, sources]) => stamp(id, sources.map((source) => runOf(folder, source)))), stamp(KIND_PAGE, kind)],
  };
}

/** This function gives the stamp of the home page. A page with a hero does not show the title of the other pages. */
export function homeStamp(folder: string): PageStamp {
  return { page: "index.html", runs: [runOf(folder, lab(HOME_LAB_FILE))], study: true };
}

/** This function gives the stamp of the page `id`, or undefined for a page with no measured data. */
export function stampOfPage(folder: string, id: string): PageStamp | undefined {
  return siteDataStamps(folder).pages.find((page) => page.page === `${id}/index.html`);
}

/** This function writes the file `data-stamps.json` that the gate of the Pages workflow reads. */
export function writeSiteStamps(out: string, folder: string): void {
  writeFileSync(join(out, "data-stamps.json"), `${JSON.stringify(siteDataStamps(folder), null, 2)}\n`);
}
