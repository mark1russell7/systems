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
    expect(pacingCounts(ALL, KIND_CATALOG), TABLE).toEqual({
      "one request": 329,
      "one gap": 64,
      "closed loop, reply times": 11,
      "closed loop, first write": 61,
      timer: 222,
    });
  });

  it("keeps the closed-loop families of the table of SYS-91", () => {
    expect(closedLoopFamilies(ALL), TABLE).toEqual({
      "CAL: closed loop, first write": 1,
      "CAL: closed loop, reply times": 2,
      "E3.F1: closed loop, reply times": 1,
      "RD.1: closed loop, first write": 1,
      "RD.100: closed loop, first write": 2,
      "RD.1000: closed loop, first write": 2,
      "RD.control: closed loop, first write": 1,
      "T01: closed loop, reply times": 8,
      "T10.commit: closed loop, first write": 5,
      "T11.writes: closed loop, first write": 3,
      "T12.resend: closed loop, first write": 5,
      "T11.border-off: closed loop, first write": 10,
      "T11.defaults: closed loop, first write": 16,
      "T12.border-off: closed loop, first write": 4,
      "T12.defaults: closed loop, first write": 8,
      "T12.writes: closed loop, first write": 3,
    });
  });

  it("reads an idle probe as one request, and a stream with no prediction of a time as reply times", () => {
    const [idle] = ALL.filter((cell) => cell.probe.mode === "idle");
    const [netem] = ALL.filter((cell) => cell.name.includes("client stream, netem"));
    expect(pacingOf(idle!)).toBe("one request");
    expect(pacingOf(netem!)).toBe("closed loop, reply times");
  });
});
