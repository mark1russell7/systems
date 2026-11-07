// The data stamps of the pages of results. Each page names the data files that it shows. The date and the versions come
// from those files, so no person types them twice. Each study stays fixed: a newer run writes a new file and a new entry.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_STAMP_SCHEMA, renderDataStamp } from "@mark1russell7/site-pages";
import type { DataLimit, DataRun, DataStamps, NoAgeLimit, PageStamp } from "@mark1russell7/site-pages";

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

/** The public ruling of the age limit of 30 days (SYS-101). A limit over 14 days needs it. */
export const LIMIT_RULING = "https://github.com/mark1russell7/systems/issues/368";

/**
 * The age rule and the commit rule of each limit start on this day, the last start that the package accepts. The
 * scheduled refresh of each study comes before it, and a page with no fresh read on this day fails the gate.
 */
export const LIMIT_START = "2026-12-07T00:00:00Z";

/** The workflow with the schedule of the lab. Its schedule meets the limit of 30 days. */
export const LIMIT_WORKFLOW = ".github/workflows/cells.yml";

const limit = (reason: string): DataLimit => ({ days: 30, reason, workflow: LIMIT_WORKFLOW, ruling: LIMIT_RULING, startsAt: LIMIT_START });

/** The reasons of the limits, from the first read of the 17 pages in SYS-101. */
const OWN_CODE = limit("The subject is code of this repository, thus a change of the code can change the numbers.");
const PINNED = limit("The engine has a pinned version, but the driver, the prober and the bands are code of this repository.");
const CALIBRATION = limit("Stage 0 of the calibration occurs again after each change of the harness.");
const TIMERS = limit("The rule for a void run is in the current harness.");
const BAND = limit("The band comes from the current algebra at each build.");

/** The pages of the lab machine. Their Q cells are not in the catalog, thus no run of the current code can reproduce them. */
const HISTORY: NoAgeLimit = {
  reproduce: "These runs operated on one lab machine on kernel 6.6 at HZ 250. Their cells are not in the catalog, thus no current run can reproduce them.",
  today: "The page is a record of history and claims nothing about the current code. The page of faults has the current findings.",
};

/** The age of one page: its limit, or the reason that it has none. */
type Age = { readonly limit: DataLimit } | { readonly noLimit: NoAgeLimit };

/** One page with a fixed study: its data files and its age. */
interface Study {
  readonly sources: readonly Source[];
  readonly age: Age;
}

const study = (age: DataLimit | NoAgeLimit, ...sources: Source[]): Study => ({ sources, age: "days" in age ? { limit: age } : { noLimit: age } });

/** The data files of each page with a fixed study, by the id of the page. */
const STUDIES: Readonly<Record<string, Study>> = {
  "lab/detection": study(BAND, lab("harness-2026-10-08.json")),
  "results/harness": study(HISTORY, lab("harness-2026-10-08.json")),
  "results/calibration": study(CALIBRATION, lab("harness-2026-10-13.json", LAB_TARGET)),
  "results/cells": study(HISTORY, lab("harness-2026-10-13.json", LAB_TARGET)),
  "results/timers": study(TIMERS, lab("harness-2026-10-13.json", LAB_TARGET)),
  "results/faults": study(OWN_CODE, file("faults-2026-10-17.json")),
  "results/topologies": study(OWN_CODE, file("topologies-2026-10-17.json")),
  "results/sentinel": study(PINNED, file("sentinel-2026-10-17.json")),
  "results/http": study(PINNED, file("http-2026-10-17.json")),
  "results/r3": study(OWN_CODE, file("r3-2026-10-17.json")),
  "results/mongodb": study(PINNED, file("mongodb-2026-10-18.json")),
  "results/pg": study(PINNED, file("pg-2026-10-19.json")),
  "results/rabbitmq": study(PINNED, file("rabbitmq-2026-10-19.json")),
  "results/grpc": study(PINNED, file("grpc-2026-10-20.json")),
  "results/mesh": study(PINNED, file("t15-2026-10-25.json")),
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

/**
 * The gate reads a version of two or three parts. The file of the page `results/pg` names Temurin 21.0.12.1, so its stamp
 * leaves that version out. The text of the page names it.
 */
const GATE_VERSION = /^\d+\.\d+(?:\.\d+)?$/;

/** This function gives the versions that a data file names. A file with two kernels gives both. */
export function enginesOf(data: StudyData): Record<string, string> {
  const named = versionsIn([data.target ?? "", data.client ?? "", ...Object.values(data.clients ?? {})].join(", "));
  const engines = Object.fromEntries(Object.entries(named).filter(([, version]) => GATE_VERSION.test(version)));
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

const stamp = (id: string, runs: readonly DataRun[], age: Age): PageStamp => ({ page: `${id}/index.html`, runs, study: true, ...age });

/** This function gives the stamps of the site from the data files in `folder`. A missing file stops the build. */
export function siteDataStamps(folder: string): DataStamps {
  const newest = newestSeriesFile(readdirSync(folder));
  const kind = [
    { ...runOf(folder, file(KIND_FIRST)), method: "first data file" },
    { ...runOf(folder, file(newest)), method: "newest data file" },
  ];
  return {
    schema: DATA_STAMP_SCHEMA,
    pages: [homeStamp(folder), ...Object.entries(STUDIES).map(([id, { sources, age }]) => stamp(id, sources.map((source) => runOf(folder, source)), age)), stamp(KIND_PAGE, kind, { limit: OWN_CODE })],
  };
}

/** This function gives the stamp of the home page. A page with a hero does not show the title of the other pages. */
export function homeStamp(folder: string): PageStamp {
  return { page: "index.html", runs: [runOf(folder, lab(HOME_LAB_FILE))], study: true, limit: BAND };
}

/** The words of the package for a page where one study gives all the numbers, each with the words of the home page. */
const WHOLE_PAGE_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["The measured numbers of this page are", "The runs of this lab are"],
  ["The oldest data of this page is", "The oldest data of this lab is"],
];

/**
 * This function gives the line of the stamp of the home page. The home page also shows the results of other studies,
 * so the line names only the lab. New words in the package stop the build, because the line then has no true words.
 */
export function homeStampHtml(folder: string): string {
  let html = renderDataStamp(homeStamp(folder));
  for (const [page, home] of WHOLE_PAGE_WORDS) {
    if (!html.includes(page)) throw new Error(`The stamp of the home page does not have the words "${page}".`);
    html = html.replace(page, home);
  }
  return html;
}

/** This function gives the stamp of the page `id`, or undefined for a page with no measured data. */
export function stampOfPage(folder: string, id: string): PageStamp | undefined {
  return siteDataStamps(folder).pages.find((page) => page.page === `${id}/index.html`);
}

/** This function writes the file `data-stamps.json` that the gate of the Pages workflow reads. */
export function writeSiteStamps(out: string, folder: string): void {
  writeFileSync(join(out, "data-stamps.json"), `${JSON.stringify(siteDataStamps(folder), null, 2)}\n`);
}
