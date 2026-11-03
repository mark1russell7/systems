import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KindResults } from "./RunResults.tsx";
import StallBand, { STALL_MODES, STALL_RUNS, outOfBand, runText, stallBands } from "./StallBand.tsx";

describe("the chart of the stall band of SYS-48", () => {
  const modes = stallBands();

  it("gives each mode the band without the backlog term and the band with it", () => {
    expect(modes.map((bands) => bands.mode)).toEqual([...STALL_MODES]);
    for (const bands of modes) expect([bands.old, bands.new], bands.mode).toEqual([{ low: 0, high: 1503 }, { low: 0, high: 1542 }]);
    expect(modes.map((bands) => [bands.before.run, bands.before.decision, bands.after.run, bands.after.decision])).toEqual([
      [STALL_RUNS.stall, "holds", STALL_RUNS.band, "holds"],
      [STALL_RUNS.stall, "holds", STALL_RUNS.band, "holds"],
      [STALL_RUNS.stall, "holds", STALL_RUNS.band, "holds"],
      [STALL_RUNS.cilium, "fails", STALL_RUNS.band, "holds"],
    ]);
  });

  it("has the 3 counted runs of each copy, and only the run of 1,507 in Cilium misses its band", () => {
    expect(modes.map((bands) => bands.runs.map((run) => run.value))).toEqual([
      [498, 0, 499, 499, 1000, 1005],
      [1502, 1497, 1498, 1502, 1503, 999],
      [497, 498, 996, 501, 498, 500],
      [1001, 499, 1507, 996, 999, 998],
    ]);
    const misses = modes.flatMap((bands) => bands.runs).filter(outOfBand);
    expect(misses.map((run) => [run.mode, run.run, run.index, run.value, run.overOld, run.overNew])).toEqual([["cilium", STALL_RUNS.cilium, 3, 1507, 4, 0]]);
    // each run of the earlier copies is in the band with the term
    expect(modes.flatMap((bands) => bands.runs).every((run) => run.overNew === 0)).toBe(true);
    expect(runText(misses[0]!, modes[3]!)).toBe(
      "S2.T07.cilium.goaway.stall, run 3 of 3 of CI run 40558968382. Without the term, the band is 0 to 1,503: 4 over. With the term, the band is 0 to 1,542: in.",
    );
  });

  it("links each dot to a frame of the kind page", () => {
    const frames = [renderToString(<KindResults template="T07" group="stall" />), renderToString(<KindResults template="T07" group="stall" copy="sys-48" />)].join("");
    for (const run of modes.flatMap((bands) => bands.runs)) expect(frames, run.href).toContain(`id="${run.href.slice(1)}"`);
    expect(renderToString(<KindResults template="T07" group="stall" copy="sys-48" />).split('class="sy-frame').length - 1).toBe(4);
  });

  it("gives each frame of the kind page its own ID", () => {
    const groups = [
      ["T07", "calibration"],
      ["T07", "deletion"],
      ["T07", "pause"],
      ["T07", "triggers"],
      ["T18", "redis"],
      ["T18", "liveness"],
      ["T18", "other"],
      ["T07", "callers"],
      ["T07", "partition"],
      ["T07", "stall"],
      ["T07", "prober"],
      ["T07", "dependency"],
      ["T07", "flapping"],
      ["T07", "zone"],
      ["T07", "slow"],
      ["T07", "gate"],
    ] as const;
    const html = [...groups.map(([template, group]) => renderToString(<KindResults template={template} group={group} />)), renderToString(<KindResults template="T07" group="stall" copy="sys-48" />)].join("");
    const ids = [...html.matchAll(/<section class="sy-frame not-content" id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(100);
    expect(ids.filter((id, n) => ids.indexOf(id) !== n)).toEqual([]);
  });

  it("renders the chart with a link for each run, the note of the miss and the legend", () => {
    const html = renderToString(<StallBand />);
    expect(html.split("<a ").length - 1).toBe(24);
    expect(html).toContain("1,507: 4 over its band");
    expect(html).toContain("Without the backlog term, 0 to 1,503, and its runs");
    expect(html).toContain("With the term (SYS-48), 0 to 1,542, and its runs");
  });
});
