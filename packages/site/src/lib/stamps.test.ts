import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDataStamps, renderDataStamp } from "@mark1russell7/site-pages";
import { describe, expect, it } from "vitest";
import { dateInName, enginesOf, HOME_LAB_FILE, homeStamp, NOT_STAMPED, newestSeriesFile, siteDataStamps, stampOfPage, versionsIn } from "./stamps.ts";

const DATA = fileURLToPath(new URL("../data/", import.meta.url));
const RESULTS = fileURLToPath(new URL("../content/docs/results/", import.meta.url));
const stamps = siteDataStamps(DATA);

describe("the versions of a data file", () => {
  it("reads an image tag and a text", () => {
    expect(versionsIn("redis:7.4")).toEqual({ redis: "7.4" });
    expect(versionsIn("valkey/valkey:9.1")).toEqual({ valkey: "9.1" });
    expect(versionsIn("node:24.21.0-alpine")).toEqual({ node: "24.21.0" });
    expect(versionsIn("a server of grpc-go v1.84.0 and etcd v3.6.15, direct")).toEqual({ "grpc-go": "1.84.0", etcd: "3.6.15" });
    expect(versionsIn("no version")).toEqual({});
  });

  it("names both kernels of a file with two", () => {
    expect(enginesOf({ kernel: "6.17.0" })).toEqual({ kernel: "6.17.0" });
    expect(enginesOf({ kernel: "6.17.0 and 7.0.0" })).toEqual({ "runner-1/kernel": "6.17.0", "runner-2/kernel": "7.0.0" });
    expect(enginesOf({ kubernetes: "v1.37.0", kind: "v0.33.0" })).toEqual({ kubernetes: "1.37.0", kind: "0.33.0" });
  });

  it("reads a date in a name, and refuses a name with none", () => {
    expect(dateInName("s2-2026-10-26.json")).toBe("2026-10-26");
    expect(() => dateInName("cells.json")).toThrow("no date");
  });

  it("takes the newest file of the series by its date", () => {
    expect(newestSeriesFile(["s2-z-2026-10-26.json", "s2-a-2026-11-04.json", "t15-2026-12-01.json"])).toBe("s2-a-2026-11-04.json");
    expect(() => newestSeriesFile(["t15-2026-12-01.json"])).toThrow("series s2");
  });
});

describe("the stamps of the site", () => {
  it("is a file that the gate reads with no fault", () => {
    expect(parseDataStamps(stamps)).toMatchObject({ ok: true });
  });

  it("gives each stamp the field study, a date and a version", () => {
    for (const page of stamps.pages) {
      expect(page.study).toBe(true);
      for (const run of page.runs) {
        expect(run.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
        expect(Object.keys(run.engines).length).toBeGreaterThan(0);
      }
    }
  });

  it("gives a date that is the date in the name of each file", () => {
    for (const run of stamps.pages.flatMap((page) => page.runs)) expect(run.date.slice(0, 10)).toBe(dateInName(run.id));
  });

  it("stamps each page of results, or names its reason", () => {
    const pages = readdirSync(RESULTS).map((name) => `results/${name.replace(/\.mdx$/, "")}`);
    const stamped = new Set(stamps.pages.map((page) => page.page.replace(/\/index\.html$/, "")));
    expect(pages.filter((page) => !stamped.has(page) && NOT_STAMPED[page] === undefined)).toEqual([]);
    expect(Object.keys(NOT_STAMPED).filter((page) => stamped.has(page))).toEqual([]);
  });

  it("stamps the home page with the data file that its lab reads", () => {
    const lab = readFileSync(fileURLToPath(new URL("../components/DetectionLab.tsx", import.meta.url)), "utf8");
    expect(lab).toContain(`"../data/${HOME_LAB_FILE}"`);
    expect(stamps.pages.map((page) => page.page)).toContain("index.html");
    expect(renderDataStamp(homeStamp(DATA))).toContain("a fixed study");
    expect(homeStamp(DATA).runs.map((run) => run.id)).toEqual([HOME_LAB_FILE]);
  });

  it("names the study of a page in plain words", () => {
    const stamp = stampOfPage(DATA, "results/faults");
    expect(stamp === undefined ? "" : renderDataStamp(stamp)).toContain("The measured numbers of this page are a fixed study of redis 7.4, kernel 6.17.0.");
    expect(stampOfPage(DATA, "thesis")).toBeUndefined();
  });

  it("gives the page of Kubernetes its first file and its newest file", () => {
    const names = stampOfPage(DATA, "results/kind")?.runs.map((run) => run.id);
    expect(names).toEqual(["kind-2026-10-18.json", newestSeriesFile(readdirSync(DATA))]);
  });

  it("says the period of the CI ledger on its page, as the data has it", () => {
    const ats = ["cells.json", "kind.json"].flatMap((name) => (JSON.parse(readFileSync(`${DATA}ci/${name}`, "utf8")) as { runs: { at: string }[] }).runs.map((run) => run.at.slice(0, 10)));
    const first = [...ats].sort().at(0) ?? "";
    const last = [...ats].sort().at(-1) ?? "";
    expect(readFileSync(`${RESULTS}ci.mdx`, "utf8")).toContain(`from ${first} to ${last}`);
  });
});
