// The move of the pages of a refresh (SYS-101): each page that shows a study goes from its old data file to the new copy.
// The old file stays in src/data, because each study stays fixed and a retired file stays readable. A test keeps its
// old file too: it examines the numbers of that file, not the numbers of the page.

import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** One copy of a refresh: the series of its study and the day of its run, from its name. */
export interface Copy {
  readonly name: string;
  readonly series: string;
  readonly date: string;
}

/** The move of one copy: the old data file, the source files that changed, and the lines that a person must examine. */
export interface Move {
  readonly copy: Copy;
  /** This is the old data file of the pages. It is undefined when a copy overwrites a file of the same name. */
  readonly from: string | undefined;
  /** These are the source files that name the new copy after the move, relative to the site. */
  readonly files: readonly string[];
  /** This is the page of the study, relative to the site, when its first sentence gets the new day. */
  readonly page: string | undefined;
  /** These lines still name the day of the old file. Their text can be false for the new copy. */
  readonly review: readonly string[];
}

const DATED = /^([a-z0-9][a-z0-9-]*?)-(\d{4}-\d{2}-\d{2})\.json$/;

/** This function gives the series and the day of a copy from its name. A name with no day stops the move. */
export function copyOf(name: string): Copy {
  const match = DATED.exec(name);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error(`The copy ${name} has no day in its name.`);
  return { name, series: match[1], date: match[2] };
}

/** The kinds of source file that can name a data file of a page. */
const SOURCE = /\.(?:ts|tsx|astro|mdx|md)$/;

/**
 * This function gives the source files of the site that a page reads: each file of `src` except the data files and
 * the tests. The walk reads the folders itself, thus no ignore rule of a tool hides a folder.
 */
export function sourcesOf(site: string): string[] {
  const out: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && path !== join(site, "src", "data")) walk(path);
      } else if (SOURCE.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name)) out.push(path);
    }
  };
  walk(join(site, "src"));
  return out.sort();
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name in a source starts after a character that cannot be in a name, thus `ohttp-<day>.json` is not `http-<day>.json`. */
const START = "(?<![\\w-])";

/** This function gives the old data files of a series that the sources name, oldest first. */
export function namedFiles(texts: readonly string[], series: string): string[] {
  const pattern = new RegExp(`${START}${escape(series)}-(\\d{4}-\\d{2}-\\d{2})\\.json`, "g");
  const names = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(pattern)) names.add(match[0]);
  return [...names].sort((a, b) => copyOf(a).date.localeCompare(copyOf(b).date));
}

/**
 * The first sentence of a page of results, for example "These are the results of the HTTP cells, from 2026-10-17." A
 * study of two days names both, for example "from 2026-10-19 and 2026-10-20.". The copy of a round has one day.
 */
const FIRST_SENTENCE = /^These are the results\b.*, from (\d{4}-\d{2}-\d{2}(?:(?:, | and )\d{4}-\d{2}-\d{2})*)\./;

/**
 * This function moves each copy of the folder `copies` into the site. Each copy goes into `src/data`. Then each source
 * that names the newest older file of its series names the copy. `pages` gives the page of each series, relative to
 * the site, for example `src/content/docs/results/http.mdx`. Its first sentence gets the day of the copy, and each other
 * line with the old day goes to `review`. A copy that no source names stops the move, because no page shows it.
 */
export function moveCopies(site: string, copies: string, pages: Readonly<Record<string, string>>): Move[] {
  const data = join(site, "src", "data");
  const sources = sourcesOf(site);
  const moves: Move[] = [];
  for (const name of readdirSync(copies).filter((each) => each.endsWith(".json")).sort()) {
    const copy = copyOf(name);
    const texts = sources.map((path) => readFileSync(path, "utf8"));
    const named = namedFiles(texts, copy.series);
    const older = named.filter((each) => copyOf(each).date < copy.date);
    if (older.length === 0 && !named.includes(name)) throw new Error(`No page shows the series ${copy.series}, thus the copy ${name} has no page.`);
    copyFileSync(join(copies, name), join(data, name));
    const from = named.includes(name) ? undefined : older.at(-1);
    const files: string[] = [];
    const review: string[] = [];
    let page: string | undefined;
    if (from !== undefined) {
      const pattern = new RegExp(`${START}${escape(from)}`, "g");
      sources.forEach((path, at) => {
        const text = texts[at] ?? "";
        const moved = text.replace(pattern, name);
        if (moved === text) return;
        writeFileSync(path, moved);
        files.push(relative(site, path).replaceAll("\\", "/"));
      });
      const old = copyOf(from).date;
      const at = pages[copy.series];
      if (at !== undefined) {
        const lines = readFileSync(join(site, at), "utf8").split("\n");
        lines.forEach((line, index) => {
          const days = FIRST_SENTENCE.exec(line)?.[1];
          if (page === undefined && days !== undefined && days.split(/, | and /).at(-1) === old) {
            lines[index] = line.replace(`, from ${days}.`, `, from ${copy.date}.`);
            page = at;
          } else if (line.includes(old)) review.push(`${at}:${index + 1}: ${line.trim()}`);
        });
        if (page !== undefined) writeFileSync(join(site, at), lines.join("\n"));
        else review.unshift(`${at}: no first sentence names ${old}, thus the page keeps its text`);
      }
    }
    moves.push({ copy, from, files, page, review });
  }
  return moves;
}

/** This function gives the page of each study, by the series of its copies: an exporter writes `<exporter>-<day>.json`. */
export const pagesOf = (refreshes: readonly { readonly exporter: string; readonly page: string }[]): Record<string, string> =>
  Object.fromEntries(refreshes.map((each) => [each.exporter, `src/content/docs/${each.page.replace(/\/index\.html$/, "")}.mdx`]));

/** This function writes the report of the moves in Markdown, for the body of the pull request. */
export function reportOf(moves: readonly Move[]): string {
  const lines = ["| Copy | Old file | Changed sources |", "| --- | --- | --- |"];
  for (const move of moves) lines.push(`| \`${move.copy.name}\` | ${move.from === undefined ? "the same name" : `\`${move.from}\``} | ${move.files.length} |`);
  const review = moves.flatMap((move) => move.review);
  if (review.length > 0) lines.push("", "These lines name the day of an old file. Examine each one against the new copy:", "", ...review.map((line) => `- ${line}`));
  return `${lines.join("\n")}\n`;
}
