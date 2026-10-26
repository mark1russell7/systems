import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CallerResult, CandidateScores, ModeScores, Score, Scorecard } from "./scores.ts";
import { CRITERIA, INCIDENTS, scoreCallers } from "./scores.ts";

// the copy of kind run 40358038728 that the site shows, and the scorecard that the site writes from it
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../site/src/data/${name}`, import.meta.url), "utf8")) as T;
const s2 = read<{ readonly cells: readonly CallerResult[] }>("s2-2026-10-26.json");
const s6 = read<Scorecard & { readonly ranAt: string }>("s6-2026-10-26.json");
const RUN = 40358038728;
const card = scoreCallers({ run: RUN, cells: s2.cells });

const scored = (scorecard: Scorecard): readonly ModeScores[] => {
  const incident = scorecard.incidents.find((each) => each.incident === "a pod that cannot serve");
  if (incident?.kind !== "scored") throw new Error("the incident of the S2 cells has no scores");
  return incident.modes;
};
const scoreOf = (candidate: CandidateScores, criterion: Score["criterion"]): Score => {
  const found = candidate.scores.find((each) => each.criterion === criterion);
  if (found === undefined) throw new Error(`${candidate.cell}: no score of ${criterion}`);
  return found;
};
const median = (candidate: CandidateScores): number => {
  const score = scoreOf(candidate, "failed requests");
  if (score.kind !== "measured") throw new Error(`${candidate.cell}: the failed requests are not measured`);
  return score.median.value;
};

describe("the scores of how callers learn, from the copy of kind run 40358038728", () => {
  it("are the scorecard that the site shows", () => {
    const { ranAt, ...shown } = s6;
    expect(ranAt).toBe("2026-10-26");
    expect(shown).toEqual(JSON.parse(JSON.stringify(card)));
  });

  it("give each candidate of each mode a score on each criterion, with the run and the cell as evidence", () => {
    expect(card.run).toBe(RUN);
    expect(card.incidents.map((each) => each.incident)).toEqual(INCIDENTS);
    const modes = scored(card);
    expect(modes.map((each) => each.mode)).toEqual(["iptables", "ipvs", "nftables"]);
    for (const mode of modes) {
      expect(mode.candidates.map((each) => [each.label, each.cell])).toEqual(
        ["endpoints", "lame-duck", "goaway"].map((suffix, at) => ["ABC"[at], `S2.T07.${mode.mode}.${suffix}`]),
      );
      for (const candidate of mode.candidates) {
        expect(candidate.scores.map((each) => each.criterion)).toEqual(CRITERIA);
        for (const score of candidate.scores)
          if (score.kind !== "not measured") expect(score.evidence, candidate.cell).toEqual({ run: RUN, cell: candidate.cell, decision: "holds", counted: 3 });
      }
    }
  });

  it("put the measure of the failed requests next to the prediction, and each counted run is in the prediction", () => {
    const medians = scored(card).map((mode) => mode.candidates.map(median));
    expect(medians).toEqual([
      [3044, 813, 1087],
      [2449, 983, 2133],
      [2562, 1092, 706],
    ]);
    const a = scoreOf(scored(card)[0]!.candidates[0]!, "failed requests");
    expect(a.kind === "measured" ? [a.prediction, a.values.map((each) => each.value), a.holds] : null).toEqual([
      { lo: { value: 1313, unit: "{request}" }, hi: { value: 3842, unit: "{request}" } },
      [3044, 3333, 2104],
      true,
    ]);
    for (const mode of scored(card)) for (const candidate of mode.candidates) expect(scoreOf(candidate, "failed requests"), candidate.cell).toMatchObject({ kind: "measured", holds: true });
  });

  it("support the decision: B and C each beat A in each mode, and neither B nor C has the fewest in each mode", () => {
    for (const mode of scored(card)) {
      const [a, b, c] = mode.candidates.map(median);
      expect(b, mode.mode).toBeLessThan(a!);
      expect(c, mode.mode).toBeLessThan(a!);
    }
    expect(scored(card).map((mode) => mode.fewest)).toEqual(["B", "B", "C"]);
  });

  it("bound the time until callers know by the window that held, and do not give it as a measure", () => {
    for (const mode of scored(card))
      for (const candidate of mode.candidates) {
        const score = scoreOf(candidate, "time until callers know");
        expect(score.kind, candidate.cell).toBe("bounded");
        if (score.kind !== "bounded") continue;
        expect(score.holds).toBe(true);
        // A ends only after the heal, and the in-band candidates end after the fault, 8 s at the earliest
        if (candidate.label === "A") expect([score.prediction.from, score.prediction.band.hi]).toEqual(["heal", { value: 6.16, unit: "s" }]);
        else expect([score.prediction.from, score.prediction.band.lo]).toEqual(["fault", { value: 8, unit: "s" }]);
      }
  });

  it("give no number for a criterion that the data cannot support, and give the reason", () => {
    const unmeasured = ["false removals on a blip", "time to recover", "probe load", "routes down", "complexity"] as const;
    for (const mode of scored(card))
      for (const candidate of mode.candidates)
        for (const criterion of unmeasured) {
          const score = scoreOf(candidate, criterion);
          expect(Object.keys(score).sort(), `${candidate.cell} ${criterion}`).toEqual(["criterion", "kind", "why"]);
          expect(score.kind === "not measured" ? score.why.length : 0).toBeGreaterThan(0);
        }
    // the incidents of the design with no cell of the candidates
    const rest = card.incidents.filter((each) => each.kind === "not measured").map((each) => each.incident);
    expect(rest).toEqual(INCIDENTS.slice(1));
  });

  it("give each criterion of a cell with no result in the copy as not measured", () => {
    const partial = scoreCallers({ run: RUN, cells: s2.cells.filter((each) => !each.id.endsWith(".goaway")) });
    for (const mode of scored(partial)) {
      expect(mode.candidates[2]!.scores.every((each) => each.kind === "not measured"), mode.mode).toBe(true);
      expect(mode.fewest).toBe("B");
    }
  });
});
