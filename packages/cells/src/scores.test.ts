import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CallerResult, CandidateScores, Incident, ModeScores, Score, Scorecard } from "./scores.ts";
import { CRITERIA, INCIDENTS, scoreCallers } from "./scores.ts";

// the copies of the kind runs that the site shows, and the scorecard that the site writes from them
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../site/src/data/${name}`, import.meta.url), "utf8")) as T;
const s2 = read<{ readonly cells: readonly CallerResult[] }>("s2-2026-10-26.json");
const partition = read<{ readonly cells: readonly CallerResult[] }>("s2-partition-2026-10-26.json");
const checked = read<{ readonly cells: readonly CallerResult[] }>("s2-session-check-2026-10-26.json");
const checkedPartition = read<{ readonly cells: readonly CallerResult[] }>("s2-partition-session-check-2026-10-26.json");
const s6 = read<Scorecard & { readonly ranAt: string }>("s6-2026-10-26.json");
const RUN = 40358038728;
const PARTITION_RUN = 40380943331;
const CHECK_RUN = 40394320219;
const card = scoreCallers(
  { run: RUN, cells: s2.cells },
  { run: PARTITION_RUN, cells: partition.cells },
  { run: CHECK_RUN, cells: checked.cells },
  { run: CHECK_RUN, cells: checkedPartition.cells },
);

const scoredOf = (scorecard: Scorecard, name: Incident): readonly ModeScores[] => {
  const incident = scorecard.incidents.find((each) => each.incident === name);
  if (incident?.kind !== "scored") throw new Error(`${name}: the incident has no scores`);
  return incident.modes;
};
const scored = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a pod that cannot serve");
const partitioned = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a partitioned pod");
const scoreOf = (candidate: CandidateScores, criterion: Score["criterion"]): Score => {
  const found = candidate.scores.find((each) => each.criterion === criterion);
  if (found === undefined) throw new Error(`${candidate.cell}: no score of ${criterion}`);
  return found;
};
const median = (candidate: CandidateScores, criterion: Score["criterion"] = "failed requests"): number => {
  const score = scoreOf(candidate, criterion);
  if (score.kind !== "measured") throw new Error(`${candidate.cell}: ${criterion} is not measured`);
  return score.median.value;
};

describe("the scores of how callers learn, from the copies of kind runs 40358038728, 40380943331 and 40394320219", () => {
  it("are the scorecard that the site shows", () => {
    const { ranAt, ...shown } = s6;
    expect(ranAt).toBe("2026-10-26");
    expect(shown).toEqual(JSON.parse(JSON.stringify(card)));
  });

  it("give each candidate of each mode a score on each criterion, with the run and the cell as evidence", () => {
    // the copies of run 40394320219 add D to each incident, and A, B and C keep the evidence of their own runs
    expect([card.run, card.runs]).toEqual([RUN, [RUN, PARTITION_RUN, CHECK_RUN]]);
    expect(card.incidents.map((each) => each.incident)).toEqual(INCIDENTS);
    for (const [modes, run, tail] of [
      [scored(card), RUN, ""],
      [partitioned(card), PARTITION_RUN, ".partition"],
    ] as const) {
      expect(modes.map((each) => each.mode)).toEqual(["iptables", "ipvs", "nftables"]);
      for (const mode of modes) {
        expect(mode.candidates.map((each) => [each.label, each.cell])).toEqual(
          ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix, at) => ["ABCD"[at], `S2.T07.${mode.mode}.${suffix}${tail}`]),
        );
        for (const candidate of mode.candidates) {
          expect(candidate.scores.map((each) => each.criterion)).toEqual(CRITERIA);
          const evidence = candidate.label === "D" ? CHECK_RUN : run;
          for (const score of candidate.scores)
            if (score.kind !== "not measured") expect(score.evidence, candidate.cell).toEqual({ run: evidence, cell: candidate.cell, decision: "holds", counted: 3 });
        }
      }
    }
    for (const incident of card.incidents.slice(0, 2)) expect(incident.kind === "scored" ? incident.run : null).toBe(incident.incident === "a partitioned pod" ? PARTITION_RUN : RUN);
  });

  it("put the measure of the failed requests next to the prediction, and each counted run is in the prediction", () => {
    const medians = scored(card).map((mode) => mode.candidates.map((each) => median(each)));
    expect(medians).toEqual([
      [3044, 813, 1087, 580],
      [2449, 983, 2133, 1608],
      [2562, 1092, 706, 572],
    ]);
    const a = scoreOf(scored(card)[0]!.candidates[0]!, "failed requests");
    expect(a.kind === "measured" ? [a.prediction, a.values.map((each) => each.value), a.holds] : null).toEqual([
      { lo: { value: 1313, unit: "{request}" }, hi: { value: 3842, unit: "{request}" } },
      [3044, 3333, 2104],
      true,
    ]);
    for (const modes of [scored(card), partitioned(card)])
      for (const mode of modes) for (const candidate of mode.candidates) expect(scoreOf(candidate, "failed requests"), candidate.cell).toMatchObject({ kind: "measured", holds: true });
  });

  it("support the decision: B, C and D each beat A in each mode, and no candidate has the fewest in each mode", () => {
    for (const mode of scored(card)) {
      const [a, b, c, d] = mode.candidates.map((each) => median(each));
      expect(b, mode.mode).toBeLessThan(a!);
      expect(c, mode.mode).toBeLessThan(a!);
      expect(d, mode.mode).toBeLessThan(a!);
    }
    // D has the prediction of C: the session check closed no session, thus the counts differ only by the sessions on the target
    expect(scored(card).map((mode) => mode.fewest)).toEqual(["D", "B", "D"]);
    for (const mode of scored(card)) {
      const [c, d] = [mode.candidates[2]!, mode.candidates[3]!].map((each) => scoreOf(each, "failed requests"));
      expect(d?.kind === "measured" && c?.kind === "measured" ? d.prediction : null, mode.mode).toEqual(c?.kind === "measured" ? c.prediction : undefined);
    }
  });

  it("bound the time until callers know by the window that held, when the copy has no time of the last failure", () => {
    for (const mode of scored(card))
      for (const candidate of mode.candidates) {
        const score = scoreOf(candidate, "time until callers know");
        // the copy of D has the time of the last failure of each run, thus its time is measured from the fault
        if (candidate.label === "D") {
          expect(score, candidate.cell).toMatchObject({ kind: "measured", from: "fault", holds: true });
          continue;
        }
        expect(score.kind, candidate.cell).toBe("bounded");
        if (score.kind !== "bounded") continue;
        expect(score.holds).toBe(true);
        // A ends only after the heal, and the in-band candidates end after the fault, 8 s at the earliest
        if (candidate.label === "A") expect([score.prediction.from, score.prediction.band.hi]).toEqual(["heal", { value: 6.16, unit: "s" }]);
        else expect([score.prediction.from, score.prediction.band.lo]).toEqual(["fault", { value: 8, unit: "s" }]);
      }
  });

  it("measure the time until callers know of a partitioned pod from the fault, and each counted run is in the prediction", () => {
    for (const mode of partitioned(card))
      for (const candidate of mode.candidates) {
        const score = scoreOf(candidate, "time until callers know");
        expect(score, candidate.cell).toMatchObject({ kind: "measured", from: "fault", holds: true });
        if (score.kind !== "measured") continue;
        expect(score.values.length, candidate.cell).toBeGreaterThan(0);
        expect(score.median.unit).toBe("s");
      }
    // A and B learn in about 2 s at the most, and C learns only after the first retransmission after the heal.
    // D learns at the PING of its session check, in 1.5 s at the most in the median run
    const times = partitioned(card).map((mode) => mode.candidates.map((each) => Math.round(median(each, "time until callers know") * 1e6) / 1e6));
    expect(times).toEqual([
      [0.594337, 0.420621, 26.439048, 1.456561],
      [0.516034, 0.503438, 26.480547, 1.070919],
      [0.527923, 0.77359, 26.268649, 1.070675],
    ]);
    const counts = partitioned(card).map((mode) => mode.candidates.map((each) => median(each)));
    expect(counts).toEqual([
      [27, 18, 1325, 73],
      [24, 24, 3953, 158],
      [19, 26, 1304, 107],
    ]);
    // one run of C in nftables had no session on the target, thus no failure and no time
    const c = scoreOf(partitioned(card)[2]!.candidates[2]!, "time until callers know");
    expect(c.kind === "measured" ? c.values.length : null).toBe(2);
    for (const mode of partitioned(card)) {
      const [a, b, c, d] = mode.candidates.map((each) => median(each, "time until callers know"));
      expect(c, mode.mode).toBeGreaterThan(Math.max(a!, b!));
      expect(d, mode.mode).toBeLessThan(1.5);
      expect(d, mode.mode).toBeLessThan(c! / 10);
    }
  });

  it("give no number for a criterion that the data cannot support, and give the reason", () => {
    const unmeasured = ["false removals on a blip", "time to recover", "probe load", "routes down", "complexity"] as const;
    for (const modes of [scored(card), partitioned(card)])
      for (const mode of modes)
        for (const candidate of mode.candidates)
          for (const criterion of unmeasured) {
            const score = scoreOf(candidate, criterion);
            expect(Object.keys(score).sort(), `${candidate.cell} ${criterion}`).toEqual(["criterion", "kind", "why"]);
            expect(score.kind === "not measured" ? score.why.length : 0).toBeGreaterThan(0);
          }
    // the incidents of the design with no cell of the candidates
    const rest = card.incidents.filter((each) => each.kind === "not measured").map((each) => each.incident);
    expect(rest).toEqual(INCIDENTS.slice(2));
  });

  it("give the step 1 scores unchanged with one copy, and an incident with cells but no copy as not measured", () => {
    const one = scoreCallers({ run: RUN, cells: s2.cells });
    expect(one.runs).toEqual([RUN]);
    // A, B and C keep their scores, and D has no result in the first copy
    const first = (scorecard: Scorecard) => scored(scorecard).map((mode) => mode.candidates.slice(0, 3));
    expect(first(one)).toEqual(first(card));
    expect(scored(one).map((mode) => mode.fewest)).toEqual(["B", "B", "C"]);
    for (const mode of scored(one)) expect(mode.candidates[3]!.scores.every((each) => each.kind === "not measured"), mode.mode).toBe(true);
    expect(one.incidents.find((each) => each.incident === "a partitioned pod")).toMatchObject({ kind: "not measured" });
  });

  it("give each criterion of a cell with no result in the copy as not measured", () => {
    const partial = scoreCallers({ run: RUN, cells: s2.cells.filter((each) => !each.id.endsWith(".goaway")) });
    for (const mode of scored(partial)) {
      expect(mode.candidates[2]!.scores.every((each) => each.kind === "not measured"), mode.mode).toBe(true);
      expect(mode.fewest).toBe("B");
    }
  });
});
