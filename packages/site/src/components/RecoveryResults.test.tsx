import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecoveryRungs, RecoveryTimes, drillRows, rungRows, runText, shareText, timeText } from "./RecoveryResults.tsx";

describe("the results of the recovery drills of SYS-94", () => {
  it("gives each rung its budgets, its worst values and its outcome", () => {
    expect(rungRows().map((row) => [row.rung, row.rpo.limit, row.rto.limit, row.outcome, row.locked])).toEqual([
      ["1", 86_400, 14_400, "within", true],
      ["100", 300, 1_800, "within", true],
      ["1000", 60, 900, "within", true],
    ]);
    expect(rungRows().map((row) => [timeText(row.rpo.worst), timeText(row.rto.worst)])).toEqual([
      ["23 h", "2.65 s"],
      ["4 min", "16.42 s"],
      ["44.8 s", "22.95 s"],
    ]);
  });

  it("writes the part of a budget in two digits", () => {
    expect(rungRows().map((row) => [shareText(row.rpo), shareText(row.rto)])).toEqual([
      ["96 %", "0.018 %"],
      ["80 %", "0.91 %"],
      ["75 %", "2.5 %"],
    ]);
  });

  it("gives 4 runs to each drill, the restores first", () => {
    const rows = drillRows();
    expect(rows.map((row) => [row.id, row.runs.length])).toEqual([
      ["RD.control", 4],
      ["RD.1", 4],
      ["RD.100.restore", 4],
      ["RD.1000.restore", 4],
      ["RD.100.failover", 4],
      ["RD.1000.failover", 4],
    ]);
    expect(rows.map((row) => timeText(row.median))).toEqual(["2.56 s", "2.64 s", "15.27 s", "21.97 s", "10.5 s", "10.19 s"]);
  });

  it("tells a run with a loss from a run with none", () => {
    const [control, one, , , failover] = drillRows();
    expect(runText(one!, one!.runs[0]!)).toBe("RD.1, run 1 of 4. 1,157 writes lost, each one after the last backup, and no hole.");
    expect(runText(control!, control!.runs[0]!)).toBe("RD.control, run 1 of 4. No write lost: none came after the backup.");
    expect(runText(failover!, failover!.runs[0]!)).toBe("RD.100.failover, run 1 of 4. No accepted write lost.");
  });

  it("renders the rungs and the chart with a dot for each run", () => {
    const rungs = renderToString(<RecoveryRungs />);
    expect(rungs).toContain("Worst RTO");
    expect(rungs).toContain("holds");
    expect(rungs.match(/class="sy-recovery-budget"/g)).toHaveLength(6);
    const chart = renderToString(<RecoveryTimes />);
    expect(chart.match(/class="sy-run"/g)).toHaveLength(24);
    expect(chart.match(/class="sy-median"/g)).toHaveLength(6);
  });
});
