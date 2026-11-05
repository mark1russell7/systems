import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetectionPauses, DetectionTimes, DetectionTrade, pauseRows, timeRows } from "./DetectionSweep.tsx";

describe("the figures of the detection sweep of SYS-57", () => {
  it("gives each setting its median and its band, in the sequence of the default first", () => {
    expect(timeRows().map((row) => [row.label, row.right, row.band])).toEqual([
      ["1 s × 4, T0 5 s", "5.85 s", { low: 5, high: 7.5 }],
      ["1 s × 2, T0 3 s", "3.71 s", { low: 3, high: 5.5 }],
      ["500 ms × 4, T0 2.5 s", "2.85 s", { low: 2.5, high: 4 }],
      ["500 ms × 2, T0 1.5 s", "2.05 s", { low: 1.5, high: 3 }],
    ]);
  });

  it("gives a line to each counted pause run, and a dot to each pause", () => {
    expect(pauseRows().map((row) => [row.tracks, row.dots.length, row.right])).toEqual([
      [4, 20, "2 of 5"],
      [4, 20, "2.5 of 5"],
      [4, 20, "3 of 5"],
      [2, 10, "4 of 5"],
    ]);
  });

  it("renders a dot for each run, filled for a false death and hollow for none", () => {
    expect(renderToString(<DetectionTimes />).match(/class="sy-run"/g)).toHaveLength(16);
    const pauses = renderToString(<DetectionPauses />);
    expect(pauses.match(/class="sy-run"/g)).toHaveLength(37 + 1);
    expect(pauses.match(/class="sy-run-hollow"/g)).toHaveLength(33 + 1);
    expect(pauses).toContain("The phase of the probe decides");
  });

  it("renders the trade-off with the false deaths of each counted run", () => {
    const trade = renderToString(<DetectionTrade />);
    for (const each of ["2, 2, 1, 2", "2, 3, 2, 3", "3, 3, 3, 3", "4, 4"]) expect(trade).toContain(each);
    expect(trade).toContain("872.5");
  });
});
