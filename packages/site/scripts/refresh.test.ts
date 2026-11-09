import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFRESHES, UNSCHEDULED } from "../../cells/src/refresh.ts";
import { siteDataStamps } from "../src/lib/stamps.ts";
import { changedFiles, snapshot } from "./copies.ts";

const DATA = fileURLToPath(new URL("../src/data/", import.meta.url));
const PAGE = fileURLToPath(new URL("../src/content/docs/results/refresh.mdx", import.meta.url));

/** The seconds of each cell in the original runs of the studies. */
const cost = JSON.parse(readFileSync(new URL("../../cells/src/refresh-cost.json", import.meta.url), "utf8")) as {
  readonly seconds: Readonly<Record<string, number>>;
};

describe("the refresh of the studies", () => {
  it("gives each page with a limit one round, or says what it needs first", () => {
    const limited = siteDataStamps(DATA)
      .pages.filter((page) => "limit" in page && page.limit !== undefined)
      .map((page) => page.page);
    const planned = [...REFRESHES, ...UNSCHEDULED].map((each) => each.page);
    expect(new Set(planned)).toEqual(new Set(limited));
    expect(planned.length).toBe(limited.length);
  });

  it("shows each round on its page with its studies and its runner hours, from the plan", () => {
    const text = readFileSync(PAGE, "utf8");
    for (const round of new Set(REFRESHES.map((each) => each.round))) {
      const studies = REFRESHES.filter((each) => each.round === round);
      // a cell with no measure gets the mean of the measured cells of its study
      const seconds = studies.reduce((sum, study) => {
        const measured = study.cells.flatMap((cell) => (cost.seconds[cell.name] === undefined ? [] : [cost.seconds[cell.name] ?? 0]));
        const mean = measured.reduce((all, each) => all + each, 0) / measured.length;
        return sum + study.cells.reduce((all, cell) => all + (cost.seconds[cell.name] ?? mean), 0);
      }, 0);
      const names = studies.map((each) => each.page.split("/")[1] ?? "").map((name) => `[${name}](../${name}/)`);
      expect(text).toContain(`| ${round} | ${names.join(", ")} | ${Math.round(seconds / 3600)} |`);
    }
    for (const each of UNSCHEDULED) expect(text, each.page).toContain(each.page === "index.html" ? "the home page" : `/${each.page.split("/")[1]}/)`);
  });
});

describe("the copies of a refresh", () => {
  it("copies a new file and a file that a copy overwrote, and not a file that stayed the same", () => {
    const folder = mkdtempSync(join(tmpdir(), "site-refresh-"));
    try {
      writeFileSync(join(folder, "kept.json"), "{}\n");
      writeFileSync(join(folder, "kind-2026-11-08.json"), '{"round":1}\n');
      writeFileSync(join(folder, "notes.txt"), "a");
      const before = snapshot(folder);
      // a second round on the same day overwrites the copy of the first round
      writeFileSync(join(folder, "kind-2026-11-08.json"), '{"round":2}\n');
      writeFileSync(join(folder, "pg-2026-11-08.json"), "{}\n");
      writeFileSync(join(folder, "notes.txt"), "b");
      expect(changedFiles(before, snapshot(folder)).sort()).toEqual(["kind-2026-11-08.json", "pg-2026-11-08.json"]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
