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
const stall = read<{ readonly cells: readonly CallerResult[] }>("s2-stall-2026-10-26.json");
const prober = read<{ readonly cells: readonly CallerResult[] }>("s2-prober-2026-10-26.json");
const s6 = read<Scorecard & { readonly ranAt: string }>("s6-2026-10-26.json");
const RUN = 40358038728;
const PARTITION_RUN = 40380943331;
const CHECK_RUN = 40394320219;
const STALL_RUN = 40406199754;
const PROBER_RUN = 40419289511;
const card = scoreCallers(
  { run: RUN, cells: s2.cells },
  { run: PARTITION_RUN, cells: partition.cells },
  { run: CHECK_RUN, cells: checked.cells },
  { run: CHECK_RUN, cells: checkedPartition.cells },
  { run: STALL_RUN, cells: stall.cells },
  { run: PROBER_RUN, cells: prober.cells },
);

const scoredOf = (scorecard: Scorecard, name: Incident): readonly ModeScores[] => {
  const incident = scorecard.incidents.find((each) => each.incident === name);
  if (incident?.kind !== "scored") throw new Error(`${name}: the incident has no scores`);
  return incident.modes;
};
const scored = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a pod that cannot serve");
const partitioned = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a partitioned pod");
const stalled = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a stalled pod (gray failure)");
const probed = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a failed prober");
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

describe("the scores of how callers learn, from the copies of kind runs 40358038728, 40380943331, 40394320219, 40406199754 and 40419289511", () => {
  it("are the scorecard that the site shows", () => {
    const { ranAt, ...shown } = s6;
    expect(ranAt).toBe("2026-10-26");
    expect(shown).toEqual(JSON.parse(JSON.stringify(card)));
  });

  it("give each candidate of each mode a score on each criterion, with the run and the cell as evidence", () => {
    // the copies of run 40394320219 add D to each incident, and A, B and C keep the evidence of their own runs
    expect([card.run, card.runs]).toEqual([RUN, [RUN, PARTITION_RUN, CHECK_RUN, STALL_RUN, PROBER_RUN]]);
    expect(card.incidents.map((each) => each.incident)).toEqual(INCIDENTS);
    for (const [modes, run, tail] of [
      [scored(card), RUN, ""],
      [partitioned(card), PARTITION_RUN, ".partition"],
      [stalled(card), STALL_RUN, ".stall"],
      [probed(card), PROBER_RUN, ".prober"],
    ] as const) {
      expect(modes.map((each) => each.mode)).toEqual(["iptables", "ipvs", "nftables"]);
      for (const mode of modes) {
        expect(mode.candidates.map((each) => [each.label, each.cell])).toEqual(
          ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix, at) => ["ABCD"[at], `S2.T07.${mode.mode}.${suffix}${tail}`]),
        );
        for (const candidate of mode.candidates) {
          expect(candidate.scores.map((each) => each.criterion)).toEqual(CRITERIA);
          // the runs of the stall and of the prober have each candidate, D too
          const evidence = candidate.label === "D" && run !== STALL_RUN && run !== PROBER_RUN ? CHECK_RUN : run;
          for (const score of candidate.scores)
            if (score.kind !== "not measured") expect(score.evidence, candidate.cell).toEqual({ run: evidence, cell: candidate.cell, decision: "holds", counted: 3 });
        }
      }
    }
    const runOf: Partial<Record<Incident, number>> = { "a pod that cannot serve": RUN, "a partitioned pod": PARTITION_RUN, "a stalled pod (gray failure)": STALL_RUN, "a failed prober": PROBER_RUN };
    for (const incident of card.incidents.slice(0, 4)) expect(incident.kind === "scored" ? incident.run : null).toBe(runOf[incident.incident]);
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
    for (const modes of [scored(card), partitioned(card), stalled(card)])
      for (const mode of modes) for (const candidate of mode.candidates) expect(scoreOf(candidate, "failed requests"), candidate.cell).toMatchObject({ kind: "measured", holds: true });
  });

  it("score a failed prober: each candidate removes the target falsely, and A fails the most requests by far", () => {
    // the failed requests of the median run: the copy keeps them apart from the main value, the time of the removal
    expect(probed(card).map((mode) => mode.candidates.map((each) => median(each)))).toEqual([
      [1690, 25, 5, 4],
      [1529, 24, 3, 3],
      [1679, 25, 3, 6],
    ]);
    expect(probed(card).map((mode) => mode.fewest)).toEqual(["D", "C", "C"]);
    // the gap: one run of C in nftables had 12 failed requests, over the band of 0 to 9. The band stays as the commit before the run gave it
    for (const mode of probed(card))
      for (const candidate of mode.candidates) {
        const score = scoreOf(candidate, "failed requests");
        expect(score, candidate.cell).toMatchObject({ kind: "measured", holds: candidate.cell !== "S2.T07.nftables.goaway.prober" });
      }
    const c = scoreOf(probed(card)[2]!.candidates[2]!, "failed requests");
    expect(c.kind === "measured" ? [c.values.map((each) => each.value), c.prediction.hi.value] : null).toEqual([[3, 3, 12], 9]);
    // the false removal of each candidate is in its band, after the fault
    expect(probed(card).map((mode) => mode.candidates.map((each) => median(each, "false removals on a blip")))).toEqual([
      [16.855, 18.913, 17.843, 15.136],
      [16.249, 19.087, 19.059, 17.232],
      [15.014, 20.947, 16.488, 18.422],
    ]);
    for (const mode of probed(card))
      for (const candidate of mode.candidates) {
        expect(scoreOf(candidate, "false removals on a blip"), candidate.cell).toMatchObject({ kind: "measured", from: "fault", holds: true });
        // A learns only after the heal, thus its time is bounded by its window. B, C and D learn from the fault, before the heal
        const time = scoreOf(candidate, "time until callers know");
        expect(time, candidate.cell).toMatchObject(candidate.label === "A" ? { kind: "bounded", holds: true } : { kind: "measured", from: "fault", holds: true });
        if (time.kind === "measured") expect(time.median.value, candidate.cell).toBeLessThan(30);
      }
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

  it("measure the time until callers know of a stalled pod from the fault: C learns only at the resume", () => {
    const times = stalled(card).map((mode) => mode.candidates.map((each) => Math.round(median(each, "time until callers know") * 1e6) / 1e6));
    expect(times).toEqual([
      [0.596866, 0.467674, 10.007897, 3.301874],
      [0.51071, 0.520535, 10.04704, 1.282535],
      [0.934373, 0.800189, 10.027349, 3.203802],
    ]);
    const counts = stalled(card).map((mode) => mode.candidates.map((each) => median(each)));
    expect(counts).toEqual([
      [22, 18, 498, 280],
      [24, 24, 1498, 191],
      [25, 21, 498, 274],
    ]);
    for (const mode of stalled(card)) {
      const [a, b, c, d] = mode.candidates.map((each) => median(each, "time until callers know"));
      expect(c, mode.mode).toBeGreaterThan(Math.max(a!, b!, d!));
      expect(d, mode.mode).toBeLessThan(c! / 2);
      for (const candidate of mode.candidates) {
        const score = scoreOf(candidate, "time until callers know");
        // the close of the session of C reaches its client about 70 ms after the resume at the most, thus its time is over the band of the prediction, in the noise of the judge (100 ms)
        expect(score, candidate.cell).toMatchObject({ kind: "measured", from: "fault", holds: candidate.label !== "C" });
        if (score.kind === "measured" && !score.holds) expect(Math.max(...score.values.map((each) => each.value)) - score.prediction.hi.value, candidate.cell).toBeLessThan(0.1);
      }
    }
  });

  it("give no number for a criterion that the data cannot support, and give the reason", () => {
    const unmeasured = ["false removals on a blip", "time to recover", "probe load", "routes down", "complexity"] as const;
    for (const [modes, criteria] of [
      [scored(card), unmeasured],
      [partitioned(card), unmeasured],
      [stalled(card), unmeasured],
      // a failed prober measures its false removal
      [probed(card), unmeasured.slice(1)],
    ] as const)
      for (const mode of modes)
        for (const candidate of mode.candidates)
          for (const criterion of criteria) {
            const score = scoreOf(candidate, criterion);
            expect(Object.keys(score).sort(), `${candidate.cell} ${criterion}`).toEqual(["criterion", "kind", "why"]);
            expect(score.kind === "not measured" ? score.why.length : 0).toBeGreaterThan(0);
          }
    // the incidents of the design with no cell of the candidates
    const rest = card.incidents.filter((each) => each.kind === "not measured").map((each) => each.incident);
    expect(rest).toEqual(INCIDENTS.slice(4));
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
