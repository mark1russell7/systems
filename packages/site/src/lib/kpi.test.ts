import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { roadmapMeasures } from "./kpi.ts";

/** This function gives a roadmap with an entry for each item that a measure reads. */
function roadmap(status: (id: string) => string, rungs = ""): string {
  const ids = [...Array.from({ length: 18 }, (_, index) => `SYS-${58 + index}`), "SYS-81", "SYS-90", "SYS-94"];
  return ids.map((id) => `### ${id} · A title\n\n- **Status:** ${status(id)}\n${id === "SYS-94" ? rungs : ""}\n`).join("");
}

const value = (text: string, id: string): number | undefined => roadmapMeasures(text).find((measure) => measure.id === id)?.value;

describe("the file kpi.json reads the roadmap", () => {
  it("counts only the S3 items that are done or shipped", () => {
    const text = roadmap((id) => (id === "SYS-58" ? "done" : id === "SYS-59" ? "shipped" : "built"));
    expect(value(text, "s3-items-done")).toBe(2);
  });

  it("adds a layer to the three that run today for each layer item that is done", () => {
    expect(value(roadmap(() => "planned"), "environment-layers-live")).toBe(3);
    expect(value(roadmap((id) => (id === "SYS-77" ? "done" : "planned")), "environment-layers-live")).toBe(4);
  });

  it("counts a rung only when its row says that it holds", () => {
    const rows = "| Rung 1 | 4 of 4 | holds |\n| Rung 100 | 4 of 4 | holds |\n| Rung 1000 | 0 of 4 | fails |\n";
    expect(value(roadmap(() => "done", rows), "recovery-rungs-held")).toBe(2);
  });

  it("stops the build when an item has no entry, so a changed roadmap does not read as 0", () => {
    expect(() => roadmapMeasures("### SYS-58 · A title\n")).toThrow(/no entry SYS-/);
  });

  it("reads the real roadmap", () => {
    const measures = roadmapMeasures(readFileSync(new URL("../../../../docs/ROADMAP.md", import.meta.url), "utf8"));
    expect(measures.map((measure) => measure.id)).toEqual(["s3-items-done", "environment-layers-live", "recovery-rungs-held"]);
    for (const measure of measures) expect(measure.value).toBeGreaterThanOrEqual(0);
    expect(measures[1]?.value).toBeGreaterThanOrEqual(3);
  });
});
