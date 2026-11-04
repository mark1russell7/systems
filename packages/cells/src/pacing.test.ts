import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { KIND_CATALOG } from "./kinds.ts";
import { closedLoopFamilies, pacingCounts, pacingOf } from "./pacing.ts";

/** This text tells what to do when a count changes. */
const TABLE = "A cell changed its pacing. Read what the pacing does to its measure, then change the table of SYS-91 in docs/ROADMAP.md and these counts.";

/** SYS-91: the list of the cells that a closed loop times. */
describe("the pacing of each cell", () => {
  it("gives each cell one pacing", () => {
    const counts = Object.values(pacingCounts(ALL, KIND_CATALOG));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(ALL.length + KIND_CATALOG.length);
  });

  it("keeps the counts of the table of SYS-91", () => {
    expect(pacingCounts(ALL, KIND_CATALOG), TABLE).toEqual({});
  });

  it("keeps the closed-loop families of the table of SYS-91", () => {
    expect(closedLoopFamilies(ALL), TABLE).toEqual({});
  });

  it("reads an idle probe as one request, and a stream with no prediction of a time as reply times", () => {
    const [idle] = ALL.filter((cell) => cell.probe.mode === "idle");
    const [netem] = ALL.filter((cell) => cell.name.includes("client stream, netem"));
    expect(pacingOf(idle!)).toBe("one request");
    expect(pacingOf(netem!)).toBe("closed loop, reply times");
  });
});
