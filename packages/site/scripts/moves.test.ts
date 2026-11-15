import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REFRESHES } from "../../cells/src/refresh.ts";
import { copyOf, moveCopies, namedFiles, pagesOf, reportOf, sourcesOf } from "./moves.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));

let root = "";
let site = "";
let copies = "";
const put = (path: string, text: string): void => {
  mkdirSync(dirname(join(site, path)), { recursive: true });
  writeFileSync(join(site, path), text);
};
const text = (path: string): string => readFileSync(join(site, path), "utf8");
const PAGES = { http: "src/content/docs/results/http.mdx" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "site-moves-"));
  site = join(root, "site");
  copies = join(root, "copies");
  mkdirSync(copies);
  put("src/data/http-2026-10-01.json", '{"old":1}\n');
  put("src/data/http-2026-10-17.json", '{"old":2}\n');
  put("src/data/http.test.ts", 'import http from "./http-2026-10-17.json";\n');
  put("src/lib/stamps.ts", '"results/http": study(PINNED, file("http-2026-10-17.json")),\n"results/ohttp": file("ohttp-2026-10-17.json"),\n');
  put("src/components/RunResults.tsx", 'import http from "../data/http-2026-10-17.json";\nimport first from "../data/http-2026-10-01.json";\n');
  put("src/components/RunResults.test.tsx", 'import http from "../data/http-2026-10-17.json";\n');
  put(PAGES.http, "---\ntitle: HTTP\n---\n\nThese are the results of the HTTP cells, from 2026-10-17. The server is Node.\n\nIn the run of 2026-10-17, no cell failed.\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the move of the pages of a refresh", () => {
  it("reads the series and the day of a copy, and refuses a copy with no day", () => {
    expect(copyOf("http-2026-11-11.json")).toEqual({ name: "http-2026-11-11.json", series: "http", date: "2026-11-11" });
    expect(copyOf("t15-2026-10-25.json").series).toBe("t15");
    expect(copyOf("kind-s2-2026-10-26.json").series).toBe("kind-s2");
    expect(() => copyOf("http.json")).toThrow(/no day/);
  });

  it("names a file only by its whole series, thus ohttp is not http", () => {
    expect(namedFiles(['file("ohttp-2026-10-17.json")', 'import "./http-2026-10-01.json"'], "http")).toEqual(["http-2026-10-01.json"]);
  });

  it("walks the sources of the pages and leaves out the data and the tests", () => {
    const names = sourcesOf(site).map((path) => path.slice(site.length + 1).replaceAll("\\", "/"));
    expect(names).toEqual(["src/components/RunResults.tsx", "src/content/docs/results/http.mdx", "src/lib/stamps.ts"]);
  });

  it("moves each source from the newest older file to the copy, and keeps the old file and its tests", () => {
    writeFileSync(join(copies, "http-2026-11-11.json"), '{"new":1}\n');
    const [move] = moveCopies(site, copies, PAGES);
    expect(move).toMatchObject({ from: "http-2026-10-17.json", files: ["src/components/RunResults.tsx", "src/lib/stamps.ts"], page: PAGES.http });
    expect(text("src/data/http-2026-11-11.json")).toBe('{"new":1}\n');
    expect(text("src/lib/stamps.ts")).toContain('file("http-2026-11-11.json")');
    expect(text("src/lib/stamps.ts")).toContain('file("ohttp-2026-10-17.json")');
    // the first file of the series is a second study of the page: it stays
    expect(text("src/components/RunResults.tsx")).toBe('import http from "../data/http-2026-11-11.json";\nimport first from "../data/http-2026-10-01.json";\n');
    expect(existsSync(join(site, "src/data/http-2026-10-17.json"))).toBe(true);
    expect(text("src/data/http.test.ts")).toContain("http-2026-10-17.json");
    expect(text("src/components/RunResults.test.tsx")).toContain("http-2026-10-17.json");
  });

  it("gives the first sentence of the page the new day, and lists each other line with the old day", () => {
    writeFileSync(join(copies, "http-2026-11-11.json"), "{}\n");
    const [move] = moveCopies(site, copies, PAGES);
    expect(text(PAGES.http)).toContain("These are the results of the HTTP cells, from 2026-11-11. The server is Node.");
    expect(move?.review).toEqual([`${PAGES.http}:7: In the run of 2026-10-17, no cell failed.`]);
    expect(reportOf(move === undefined ? [] : [move])).toBe(
      [
        "| Copy | Old file | Changed sources |",
        "| --- | --- | --- |",
        "| `http-2026-11-11.json` | `http-2026-10-17.json` | 2 |",
        "",
        "These lines name the day of an old file. Examine each one against the new copy:",
        "",
        `- ${PAGES.http}:7: In the run of 2026-10-17, no cell failed.`,
        "",
      ].join("\n"),
    );
  });

  it("gives one day to a first sentence of two days, because the copy of a round has one day", () => {
    put(PAGES.http, "These are the results of the HTTP cells, from 2026-10-16 and 2026-10-17. The server is Node.\n");
    writeFileSync(join(copies, "http-2026-11-11.json"), "{}\n");
    expect(moveCopies(site, copies, PAGES)[0]?.page).toBe(PAGES.http);
    expect(text(PAGES.http)).toBe("These are the results of the HTTP cells, from 2026-11-11. The server is Node.\n");
  });

  it("says so when the page has no first sentence with the old day", () => {
    put(PAGES.http, "These are the HTTP cells.\n");
    writeFileSync(join(copies, "http-2026-11-11.json"), "{}\n");
    const [move] = moveCopies(site, copies, PAGES);
    expect(move?.page).toBeUndefined();
    expect(move?.review).toEqual([`${PAGES.http}: no first sentence names 2026-10-17, thus the page keeps its text`]);
  });

  it("overwrites a copy of the same name and changes no source", () => {
    writeFileSync(join(copies, "http-2026-10-17.json"), '{"again":1}\n');
    const [move] = moveCopies(site, copies, PAGES);
    expect(move).toMatchObject({ from: undefined, files: [], page: undefined, review: [] });
    expect(text("src/data/http-2026-10-17.json")).toBe('{"again":1}\n');
  });

  it("refuses a copy that no page shows, before it writes a file", () => {
    writeFileSync(join(copies, "pg-2026-11-11.json"), "{}\n");
    expect(() => moveCopies(site, copies, PAGES)).toThrow(/No page shows the series pg/);
    expect(existsSync(join(site, "src/data/pg-2026-11-11.json"))).toBe(false);
  });
});

describe("the pages of the refresh in the site", () => {
  const pages = pagesOf(REFRESHES);

  it("finds the page of each study, with the first sentence that names the day of its file", () => {
    const texts = sourcesOf(SITE).map((path) => readFileSync(path, "utf8"));
    for (const each of REFRESHES) {
      const page = pages[each.exporter] ?? "";
      const [current] = namedFiles(texts, each.exporter).slice(-1);
      expect(current, each.exporter).toBeDefined();
      const first = readFileSync(join(SITE, page), "utf8")
        .split("\n")
        .find((line) => line.startsWith("These are the results"));
      expect(first, page).toMatch(new RegExp(`, from (?:[\\d-]+(?:, | and ))*${copyOf(current ?? "").date}\\.`));
    }
  });

  it("names each copy as its exporter writes it", () => {
    for (const each of REFRESHES) {
      const script = readFileSync(join(SITE, "scripts", `${each.exporter}.ts`), "utf8");
      expect(script, each.exporter).toContain(`../src/data/${each.exporter}-\${date}.json`);
    }
  });
});
