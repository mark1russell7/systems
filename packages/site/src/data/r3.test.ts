import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import r3 from "./r3-2026-10-17.json";

const decisions = (decision: string) => r3.cells.filter((each) => each.decision === decision);
const stage = (group: string, name: string) => r3.cells.filter((each) => each.group === group && each.stage === name);

describe("the copy of R3's queue holds the figures of its CI runs", () => {
  it("has the 115 cells of the queue and 6 canonical cells, on Linux 6.17 at HZ 1000", () => {
    expect([r3.kernel, r3.hz, r3.target, r3.runs]).toEqual(["6.17.0", 1000, "redis:7.4", 11]);
    expect(r3.cells).toHaveLength(121);
    expect([decisions("holds").length, decisions("fails").length, decisions("measured").length]).toEqual([115, 0, 6]);
    expect(["defaults", "border-off", "array", "random"].map((name) => [stage("T01", name).length, stage("T03", name).length])).toEqual([
      [3, 7],
      [4, 2],
      [48, 31],
      [12, 14],
    ]);
  });

  it("holds the 9 cells that failed first, on two gaps of the corpus", () => {
    const again = r3.cells.filter((each) => each.first === "fails");
    expect(again.map((each) => [each.first, each.decision])).toEqual(Array.from({ length: 9 }, () => ["fails", "holds"]));
    // Redis closes an idle client itself, with a FIN: 7 cells; a flow that idles before its request: 2
    expect(again.filter((each) => /idle timeout of Redis/.test(each.repeated ?? "")).length).toBe(7);
    expect(again.filter((each) => /idles before its request/.test(each.repeated ?? "")).length).toBe(2);
    for (const each of again.filter((cell) => cell.group === "T01")) expect(each.prediction.text).toMatch(/Redis closes the idle client at its timeout, with its own FIN/);
  });

  it("gives the measurements only: the either order of 600 s and the forget behind a router", () => {
    expect(decisions("measured").map((each) => each.plan)).toEqual(["T01.array.7", "T01.array.17", "T01.array.17", "T01.array.17", "T01.array.17", "T03.random.15"]);
    for (const each of decisions("measured")) expect(each.prediction.kind).toBe("measured");
    // the first run of the 5 either-order cells measured nothing; their re-run ends on the idle close of Redis
    const either = decisions("measured").filter((each) => each.plan.startsWith("T01."));
    expect(either.map((each) => each.first)).toEqual(Array.from({ length: 5 }, () => "measured"));
    for (const each of either) expect(each.repeated).toMatch(/end on the close of the observer/);
    for (const each of either) expect(each.median).toBeGreaterThanOrEqual(600);
    for (const each of either) expect(each.median).toBeLessThanOrEqual(601.1);
    expect(decisions("measured").find((each) => each.plan === "T03.random.15")!.median).toBeNull();
  });

  it("names no machine and no claim of the corpus", () => {
    const text = readFileSync(new URL("./r3-2026-10-17.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|systems\.claim\.|systems\.knob\./i);
  });
});
