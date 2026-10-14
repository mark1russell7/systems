import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import harness from "./harness-2026-10-13.json";

const cell = (name: string) => {
  const found = harness.cells.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};
const band = (name: string) => {
  const p = cell(name).prediction;
  if ("low" in p && p.low !== undefined) return [p.low, p.high];
  if ("recovers" in p && p.recovers !== undefined) return [p.recovers.low, p.recovers.high];
  return null;
};

describe("the copy of the harness results holds the figures of jarvis (SYSTEMS.md §16.9)", () => {
  it("has the twelve S1 cells and the six calibration cells, and each holds", () => {
    expect(harness.cells.filter((each) => each.group !== "calibration")).toHaveLength(12);
    expect(harness.cells.filter((each) => each.group === "calibration")).toHaveLength(6);
    expect(harness.cells.filter((each) => each.verdict.decision !== "holds")).toEqual([]);
  });

  it("predicts the bands that the algebra gives", () => {
    expect(band("Q1 idle, black hole")).toEqual([10.996, 11.352]);
    expect(band("Q2 in flight, black hole, tcp_retries2 = 3")).toEqual([3, 6.616]);
    expect(band("Q2 in flight, black hole, tcp_retries2 = 5")).toEqual([12.6, 26.52]);
    expect(band("Q4 in flight, a 1 s stall")).toEqual([1.616, 1.705]);
    expect(band("Q4 in flight, a 3.5 s stall")).toEqual([6.504, 6.889]);
    expect(band("ioredis Q1 idle, black hole")).toEqual([14.996, 15.576]);
    expect(band("server Q1 idle, black hole")).toEqual([7.996, 8.352]);
    expect(band("server Q3 idle, frozen client")).toBeNull();
    expect(harness.noise).toBe(0.004);
  });

  it("counts the firings of the timers as the records do: 977 of 1019 on their slot", () => {
    const s1 = harness.cells.filter((each) => each.group !== "calibration");
    const sum = (key: "firings" | "onSlot" | "oneBehind" | "twoOrMore" | "owned") =>
      s1.reduce((total, each) => total + each.timers[key], 0);
    expect([sum("firings"), sum("onSlot"), sum("oneBehind"), sum("twoOrMore"), sum("owned")]).toEqual([
      1019, 977, 37, 5, 0,
    ]);
    expect(s1.reduce((total, each) => total + each.runs.length, 0)).toBe(132);
  });

  it("names no machine: no boot id, image digest, container or namespace inode", () => {
    const text = readFileSync(new URL("./harness-2026-10-13.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|netns|[0-9a-f]{12,}/);
  });
});
