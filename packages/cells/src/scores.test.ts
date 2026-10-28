import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CallerResult, CandidateScores, Incident, ModeScores, Score, Scorecard } from "./scores.ts";
import { PING_FRAME, pingsOf } from "./callers.ts";
import { CRITERIA, INCIDENTS, scoreCallers } from "./scores.ts";

// the copies of the kind runs that the site shows, and the scorecard that the site writes from them
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../site/src/data/${name}`, import.meta.url), "utf8")) as T;
const s2 = read<{ readonly cells: readonly CallerResult[] }>("s2-2026-10-26.json");
const partition = read<{ readonly cells: readonly CallerResult[] }>("s2-partition-2026-10-26.json");
const checked = read<{ readonly cells: readonly CallerResult[] }>("s2-session-check-2026-10-26.json");
const checkedPartition = read<{ readonly cells: readonly CallerResult[] }>("s2-partition-session-check-2026-10-26.json");
const stall = read<{ readonly cells: readonly CallerResult[] }>("s2-stall-2026-10-26.json");
const prober = read<{ readonly cells: readonly CallerResult[] }>("s2-prober-2026-10-26.json");
const dependency = read<{ readonly cells: readonly CallerResult[] }>("s2-dependency-2026-10-27.json");
const flapping = read<{ readonly cells: readonly CallerResult[] }>("s2-flapping-2026-10-27.json");
const zone = read<{ readonly cells: readonly CallerResult[] }>("s2-zone-2026-10-27.json");
const slow = read<{ readonly cells: readonly CallerResult[] }>("s2-slow-2026-10-27.json");
// the copies of the run that counts the PINGs of D, for each incident
const loads = ["s2-load", "s2-partition-load", "s2-stall-load", "s2-prober-load", "s2-dependency-load"].map((name) => read<{ readonly cells: readonly CallerResult[] }>(`${name}-2026-10-27.json`));
// the copies of the run of the Cilium column: the kube-proxy replacement, for each incident that it has cells of
const ciliums = ["s2-cilium", "s2-partition-cilium", "s2-stall-cilium", "s2-prober-cilium", "s2-dependency-cilium", "s2-flapping-cilium"].map((name) => read<{ readonly cells: readonly CallerResult[] }>(`${name}-2026-10-27.json`));
const s6 = read<Scorecard & { readonly ranAt: string }>("s6-2026-10-27.json");
const RUN = 40358038728;
const PARTITION_RUN = 40380943331;
const CHECK_RUN = 40394320219;
const STALL_RUN = 40406199754;
const PROBER_RUN = 40419289511;
const DEPENDENCY_RUN = 40430856093;
const LOAD_RUN = 40440516571;
const FLAPPING_RUN = 40464814086;
const ZONE_RUN = 40500297695;
const SLOW_RUN = 40521784305;
const CILIUM_RUN = 40558968382;
const card = scoreCallers(
  { run: RUN, cells: s2.cells },
  { run: PARTITION_RUN, cells: partition.cells },
  { run: CHECK_RUN, cells: checked.cells },
  { run: CHECK_RUN, cells: checkedPartition.cells },
  { run: STALL_RUN, cells: stall.cells },
  { run: PROBER_RUN, cells: prober.cells },
  { run: DEPENDENCY_RUN, cells: dependency.cells },
  ...loads.map((each) => ({ run: LOAD_RUN, cells: each.cells })),
  { run: FLAPPING_RUN, cells: flapping.cells },
  { run: ZONE_RUN, cells: zone.cells },
  { run: SLOW_RUN, cells: slow.cells },
  ...ciliums.map((each) => ({ run: CILIUM_RUN, cells: each.cells })),
);

const modesOf = (scorecard: Scorecard, name: Incident): readonly ModeScores[] => {
  const incident = scorecard.incidents.find((each) => each.incident === name);
  if (incident?.kind !== "scored") throw new Error(`${name}: the incident has no scores`);
  return incident.modes;
};
// the modes of kube-proxy. The Cilium column has its own test
const scoredOf = (scorecard: Scorecard, name: Incident): readonly ModeScores[] => modesOf(scorecard, name).filter((each) => each.mode !== "cilium");
const ciliumOf = (scorecard: Scorecard, name: Incident): ModeScores => {
  const found = modesOf(scorecard, name).find((each) => each.mode === "cilium");
  if (found === undefined) throw new Error(`${name}: the incident has no Cilium column`);
  return found;
};
const scored = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a pod that cannot serve");
const partitioned = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a partitioned pod");
const stalled = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a stalled pod (gray failure)");
const probed = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a failed prober");
const depended = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a black-holed shared dependency");
const flapped = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a flapping dependency");
const zoned = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a lost zone");
const slowed = (scorecard: Scorecard): readonly ModeScores[] => scoredOf(scorecard, "a slow dependency (gray failure)");
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

describe("the scores of how callers learn, from the copies of kind runs 40358038728, 40380943331, 40394320219, 40406199754, 40419289511, 40430856093, 40440516571, 40464814086, 40500297695, 40521784305 and 40558968382", () => {
  it("are the scorecard that the site shows", () => {
    const { ranAt, ...shown } = s6;
    expect(ranAt).toBe("2026-10-27");
    expect(shown).toEqual(JSON.parse(JSON.stringify(card)));
  });

  it("give each candidate of each mode a score on each criterion, with the run and the cell as evidence", () => {
    // the copies of run 40394320219 add D to each incident, and A, B and C keep the evidence of their own runs
    expect([card.run, card.runs]).toEqual([RUN, [RUN, PARTITION_RUN, CHECK_RUN, STALL_RUN, PROBER_RUN, DEPENDENCY_RUN, LOAD_RUN, FLAPPING_RUN, ZONE_RUN, SLOW_RUN, CILIUM_RUN]]);
    expect(card.incidents.map((each) => each.incident)).toEqual(INCIDENTS);
    // the Cilium column is in each incident that the run of the Cilium copies has cells of
    const kubeProxy = ["iptables", "ipvs", "nftables"];
    expect(INCIDENTS.map((name) => modesOf(card, name).map((each) => each.mode))).toEqual(INCIDENTS.map((name) => (name === "a lost zone" || name === "a slow dependency (gray failure)" ? kubeProxy : [...kubeProxy, "cilium"])));
    for (const [modes, run, tail] of [
      [scored(card), RUN, ""],
      [partitioned(card), PARTITION_RUN, ".partition"],
      [stalled(card), STALL_RUN, ".stall"],
      [probed(card), PROBER_RUN, ".prober"],
      [depended(card), DEPENDENCY_RUN, ".dependency"],
      [flapped(card), FLAPPING_RUN, ".flapping"],
      [zoned(card), ZONE_RUN, ".zone"],
      [slowed(card), SLOW_RUN, ".slow"],
    ] as const) {
      expect(modes.map((each) => each.mode)).toEqual(["iptables", "ipvs", "nftables"]);
      for (const mode of modes) {
        expect(mode.candidates.map((each) => [each.label, each.cell])).toEqual(
          ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix, at) => ["ABCD"[at], `S2.T07.${mode.mode}.${suffix}${tail}`]),
        );
        for (const candidate of mode.candidates) {
          expect(candidate.scores.map((each) => each.criterion)).toEqual(CRITERIA);
          // the runs of the stall, of the prober and of each dependency have each candidate, D too
          const single = [STALL_RUN, PROBER_RUN, DEPENDENCY_RUN, FLAPPING_RUN, ZONE_RUN, SLOW_RUN].includes(run);
          const evidence = candidate.label === "D" && !single ? CHECK_RUN : run;
          // the gap: one run of B in nftables recovered before its window could end
          const decision = candidate.cell === "S2.T07.nftables.lame-duck.dependency" ? "fails" : "holds";
          // the PINGs of D come from the run that counts them, and each of its cells held. The runs of the flapping dependency, of the lost zone and of the slow dependency count their own
          const load = run === FLAPPING_RUN || run === ZONE_RUN || run === SLOW_RUN ? run : LOAD_RUN;
          for (const score of candidate.scores)
            if (score.kind === "measured" || score.kind === "bounded")
              expect(score.evidence, candidate.cell).toEqual(score.criterion === "probe load" ? { run: load, cell: candidate.cell, decision: "holds", counted: 3 } : { run: evidence, cell: candidate.cell, decision, counted: 3 });
        }
      }
    }
    const runOf: Partial<Record<Incident, number>> = { "a pod that cannot serve": RUN, "a partitioned pod": PARTITION_RUN, "a stalled pod (gray failure)": STALL_RUN, "a failed prober": PROBER_RUN, "a black-holed shared dependency": DEPENDENCY_RUN, "a flapping dependency": FLAPPING_RUN, "a lost zone": ZONE_RUN, "a slow dependency (gray failure)": SLOW_RUN };
    for (const incident of card.incidents) expect(incident.kind === "scored" ? incident.run : null).toBe(runOf[incident.incident]);
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

  it("score a black-holed shared dependency: each candidate fails each request, and the Service is empty in its band", () => {
    // no replica can serve, thus the counts are close. B has the fewest in each mode
    expect(depended(card).map((mode) => mode.candidates.map((each) => median(each)))).toEqual([
      [5019, 4173, 4403, 4690],
      [4530, 4452, 4492, 4778],
      [4714, 4126, 4677, 4932],
    ]);
    expect(depended(card).map((mode) => mode.fewest)).toEqual(["B", "B", "B"]);
    // the routes are down for each candidate: the Service is empty in its band, after the fault
    expect(depended(card).map((mode) => mode.candidates.map((each) => median(each, "routes down")))).toEqual([
      [18.165, 17.524, 16.982, 18.006],
      [19.418, 19.713, 18.288, 18.38],
      [18.549, 19.298, 17.59, 19.652],
    ]);
    for (const mode of depended(card))
      for (const candidate of mode.candidates) {
        const nft = candidate.cell === "S2.T07.nftables.lame-duck.dependency";
        expect(scoreOf(candidate, "routes down"), candidate.cell).toMatchObject({ kind: "measured", from: "fault", holds: true });
        // the gap: one run of B in nftables recovered early and had 3953 failed requests, under the band of 3954
        expect(scoreOf(candidate, "failed requests"), candidate.cell).toMatchObject({ kind: "measured", holds: !nft });
        // the gap: that run has no failure after the heal, thus no time to recover
        expect(scoreOf(candidate, "time to recover"), candidate.cell).toMatchObject({ kind: "measured", from: "heal", holds: !nft });
        // the gap: B, C and D fail slowly on the empty Service until the heal, thus only A knows in the band
        expect(scoreOf(candidate, "time until callers know"), candidate.cell).toMatchObject({ kind: "measured", from: "fault", holds: candidate.label === "A" });
      }
    const knows = depended(card).map((mode) => mode.candidates.map((each) => Math.round(median(each, "time until callers know") * 100) / 100));
    expect(knows).toEqual([
      [11.41, 27.12, 26.51, 26.4],
      [11.52, 27.16, 26.76, 26.95],
      [12.4, 27.11, 26.95, 26.96],
    ]);
    const recovers = depended(card).map((mode) => mode.candidates.map((each) => Math.round(median(each, "time to recover") * 100) / 100));
    expect(recovers).toEqual([
      [6.58, 0.91, 2.35, 4.33],
      [3.24, 2.76, 3, 4.92],
      [4.48, 1.45, 4.22, 5.92],
    ]);
  });

  it("score a flapping dependency: each of the 3 faults is the same as the first one, and each score holds", () => {
    // the failed requests of the median run, for the 3 faults of the run. B has the fewest in each mode, as in the shared dependency
    expect(flapped(card).map((mode) => mode.candidates.map((each) => median(each)))).toEqual([
      [13935, 12274, 13516, 13866],
      [13434, 12956, 13443, 14144],
      [14213, 13207, 14102, 13805],
    ]);
    expect(flapped(card).map((mode) => mode.fewest)).toEqual(["B", "B", "B"]);
    for (const mode of flapped(card))
      for (const candidate of mode.candidates) {
        expect(scoreOf(candidate, "failed requests"), candidate.cell).toMatchObject({ kind: "measured", holds: true });
        // each time has one value for each fault of each counted run: 3 runs of 3 faults
        for (const criterion of ["time until callers know", "time to recover", "routes down"] as const) {
          const score = scoreOf(candidate, criterion);
          expect(score, `${candidate.cell} ${criterion}`).toMatchObject({ kind: "measured", holds: true });
          expect(score.kind === "measured" ? score.values.length : null).toBe(9);
        }
      }
    // B, C and D fail slowly until each heal, with the correction of run 40430856093. A knows at the latch
    const knows = flapped(card).map((mode) => mode.candidates.map((each) => Math.round(median(each, "time until callers know") * 100) / 100));
    expect(knows).toEqual([
      [11.58, 27.13, 26.49, 26.7],
      [11.38, 27.12, 26.7, 26.47],
      [11.15, 27.18, 26.83, 26.53],
    ]);
    // B recovers first in each mode
    const recovers = flapped(card).map((mode) => mode.candidates.map((each) => Math.round(median(each, "time to recover") * 100) / 100));
    expect(recovers).toEqual([
      [3.93, 0.5, 2.29, 3.54],
      [3.68, 2.35, 2.63, 4.13],
      [4.32, 2.53, 4.05, 3.79],
    ]);
    // a last failure can start before its heal: one value below zero, in the band of B in iptables
    const early = scoreOf(flapped(card)[0]!.candidates[1]!, "time to recover");
    expect(early.kind === "measured" ? [Math.min(...early.values.map((each) => each.value)) < 0, early.prediction.lo] : null).toEqual([true, { value: -2, unit: "s" }]);
  });

  it("score a lost zone: the node lifecycle controller removes the target, and C learns only at the 9th retransmission", () => {
    // the failed requests of the median run. C fails until the 9th retransmission if a session is on the lost node, and D bounds it
    expect(zoned(card).map((mode) => mode.candidates.map((each) => median(each)))).toEqual([
      [21, 13, 5128, 0],
      [16, 16, 0, 133],
      [17, 23, 10464, 117],
    ]);
    // in IPVS, 2 of the 3 runs of C had no session on the lost node, thus its median is 0
    expect(zoned(card).map((mode) => mode.fewest)).toEqual(["D", "C", "A"]);
    for (const mode of zoned(card))
      for (const candidate of mode.candidates)
        for (const criterion of ["failed requests", "time to recover", "routes down"] as const)
          expect(scoreOf(candidate, criterion), `${candidate.cell} ${criterion}`).toMatchObject({ kind: "measured", holds: true });
    // the removal of the target, in seconds after the fault: in the band of the grace of the node controller for each candidate
    const removals = zoned(card).map((mode) => mode.candidates.map((each) => median(each, "routes down")));
    expect(removals).toEqual([
      [50.393, 45.402, 49.002, 50.695],
      [46.541, 45.697, 45.68, 47.451],
      [46.149, 46.293, 45.717, 45.539],
    ]);
    // A and B learn in 1.3 s at the most. C learns after the heal, at the 9th retransmission
    const knows = zoned(card).map((mode) => mode.candidates.slice(0, 3).map((each) => Math.round(median(each, "time until callers know") * 100) / 100));
    expect(knows).toEqual([
      [1.06, 0.49, 103.64],
      [0.53, 0.52, 103.34],
      [0.62, 0.79, 105.33],
    ]);
    // D in iptables had no failed request in a counted run, thus its time is bounded by the window
    expect(scoreOf(zoned(card)[0]!.candidates[3]!, "time until callers know")).toMatchObject({ kind: "bounded", holds: true });
    for (const mode of zoned(card).slice(1)) expect(median(mode.candidates[3]!, "time until callers know"), mode.mode).toBeLessThan(5);
  });

  it("score a slow dependency: A and B queue their requests on HTTP/1.1, and C and D fail none", () => {
    // the failed requests of the median run, each one a timeout of A or B
    expect(slowed(card).map((mode) => mode.candidates.map((each) => median(each)))).toEqual([
      [3487, 3483, 0, 0],
      [3486, 3487, 0, 0],
      [3487, 3482, 0, 0],
    ]);
    // C and D tie at 0, and the first of the two has the fewest
    expect(slowed(card).map((mode) => mode.fewest)).toEqual(["C", "C", "C"]);
    for (const mode of slowed(card))
      for (const candidate of mode.candidates) expect(scoreOf(candidate, "failed requests"), candidate.cell).toMatchObject({ kind: "measured", holds: true });
    // the last failure of A and B, in seconds from the heal: 1.70 s to 1.73 s before it, up to 38 ms after the band of -2.02 s to -1.74 s
    const lasts = slowed(card).map((mode) => mode.candidates.slice(0, 2).map((each) => Math.round(median(each, "time to recover") * 1000) / 1000));
    expect(lasts).toEqual([
      [-1.712, -1.708],
      [-1.716, -1.711],
      [-1.711, -1.711],
    ]);
    for (const mode of slowed(card))
      for (const candidate of mode.candidates.slice(0, 2)) {
        const score = scoreOf(candidate, "time to recover");
        expect(score.kind === "measured" ? [score.holds, score.prediction.lo.value, score.prediction.hi.value] : null, candidate.cell).toEqual([false, -2.02, -1.74]);
      }
    // C and D fail no request, thus they have nothing to recover from, and no candidate learns
    for (const mode of slowed(card)) {
      for (const candidate of mode.candidates.slice(2)) expect(scoreOf(candidate, "time to recover").kind, candidate.cell).toBe("not measured");
      for (const candidate of mode.candidates) expect(scoreOf(candidate, "time until callers know").kind, candidate.cell).toBe("not measured");
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
        // the close of the session of C reaches its client about 70 ms after the resume at the most. The band before SYS-48 ended at 10 s, and the backlog term
        // of SYS-45 closes it up to (n − 1) × 45 ms + 100 ms later, 10.19 s with the 3 sessions of C. Thus each time is in the band
        expect(score, candidate.cell).toMatchObject({ kind: "measured", from: "fault", holds: true });
        if (candidate.label === "C") expect(score.kind === "measured" ? [score.prediction.lo.value, score.prediction.hi.value] : null, candidate.cell).toEqual([9.98, 10.19]);
      }
    }
  });

  it("give no number for a criterion that the data cannot support, and give the reason", () => {
    const unmeasured = ["false removals on a blip", "time to recover", "routes down", "complexity"] as const;
    for (const [modes, criteria] of [
      [scored(card), unmeasured],
      [partitioned(card), unmeasured],
      [stalled(card), unmeasured],
      // a failed prober measures its false removal
      [probed(card), unmeasured.slice(1)],
      // a shared dependency measures its routes down and its time to recover
      [depended(card), ["false removals on a blip", "complexity"]],
      [flapped(card), ["false removals on a blip", "complexity"]],
      // a lost zone is a true loss: no removal is false
      [zoned(card), ["false removals on a blip", "complexity"]],
      // a slow dependency: no replica leaves the Service, and no candidate learns
      [slowed(card), ["time until callers know", "false removals on a blip", "routes down", "complexity"]],
    ] as const)
      for (const mode of modes)
        for (const candidate of mode.candidates)
          for (const criterion of criteria) {
            const score = scoreOf(candidate, criterion);
            expect(Object.keys(score).sort(), `${candidate.cell} ${criterion}`).toEqual(["criterion", "kind", "why"]);
            expect(score.kind === "not measured" ? score.why.length : 0).toBeGreaterThan(0);
          }
    // each incident of the design has cells of the candidates
    const rest = card.incidents.filter((each) => each.kind === "not measured").map((each) => each.incident);
    expect(rest).toEqual([]);
  });

  it("give A, B and C zero PINGs from the code, and the PINGs of D from the run that counts them", () => {
    const pings: number[][][] = [];
    for (const modes of [scored(card), partitioned(card), stalled(card), probed(card), depended(card), flapped(card), zoned(card), slowed(card)]) {
      pings.push([]);
      for (const mode of modes)
        for (const candidate of mode.candidates) {
          const score = scoreOf(candidate, "probe load");
          if (candidate.label === "D") {
            // each counted run of each cell of D is in the band of commit 47909ad
            expect(score.kind === "measured" ? [score.holds, score.values.length] : null, candidate.cell).toEqual([true, 3]);
            pings.at(-1)!.push(score.kind === "measured" ? score.values.map((each) => each.value) : []);
            continue;
          }
          expect(score.kind === "derived" ? [score.value, score.why.length > 0] : null, candidate.cell).toEqual([{ value: 0, unit: "{ping}" }, true]);
        }
    }
    // the values of each score are in order
    expect(pings).toEqual([
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      [[1, 1, 3], [3, 3, 3], [0, 1, 2]],
      [[1, 2, 8], [3, 3, 3], [0, 1, 3]],
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      [[33, 44, 51], [33, 45, 47], [33, 45, 51]],
      // three faults in one run: approximately three times the PINGs of the shared dependency
      [[122, 123, 135], [124, 131, 138], [112, 123, 126]],
      // a lost zone: the PINGs of a partition, from the 2 clients of the kept zone
      [[0, 0, 0], [2, 2, 2], [0, 1, 2]],
      // a slow dependency: each session hears a frame in each tick
      [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    ]);
    // without the copies of the PINGs, D has no number
    const without = scoreCallers({ run: RUN, cells: s2.cells }, { run: CHECK_RUN, cells: checked.cells });
    for (const mode of scored(without)) expect(scoreOf(mode.candidates[3]!, "probe load"), mode.mode).toMatchObject({ kind: "not measured" });
  });

  it("predict the PINGs of D in each incident before a run counts them", () => {
    const bands = (["cannot serve", "false failure", "partition", "stall", "shared dependency", "flapping dependency", "lost zone", "slow dependency"] as const).map((fault) =>
      (["iptables", "ipvs", "nftables"] as const).map((mode) => {
        const band = pingsOf(mode, "in band on HTTP/2 with a session check", fault);
        return [band.lo.value, band.hi.value];
      }),
    );
    expect(bands).toEqual([
      [[0, 0], [0, 0], [0, 0]],
      [[0, 0], [0, 0], [0, 0]],
      [[0, 3], [0, 3], [0, 3]],
      [[0, 9], [0, 3], [0, 9]],
      [[3, 126], [3, 126], [3, 126]],
      [[9, 378], [9, 378], [9, 378]],
      // a lost zone: the PINGs of a partition, with the 2 clients of the kept zone
      [[0, 2], [0, 2], [0, 2]],
      // a slow dependency: the delay is shorter than the tick, thus no PING
      [[0, 0], [0, 0], [0, 0]],
    ]);
    // a PING and its ACK are each a frame header of 9 bytes and 8 bytes of data
    expect(PING_FRAME).toEqual({ value: 17, unit: "B" });
  });

  it("score the Cilium column from the run 40558968382: each finding of kube-proxy holds, and the scores show one gap", () => {
    const column = (name: Incident): ModeScores => ciliumOf(card, name);
    const counts = (name: Incident): (number | null)[] => column(name).candidates.map((each) => (scoreOf(each, "failed requests").kind === "measured" ? median(each) : null));
    // the failed requests of the median run. The runs of the dependencies have only B
    expect(counts("a pod that cannot serve")).toEqual([2810, 956, 622, 734]);
    expect(counts("a partitioned pod")).toEqual([19, 21, 1318, 421]);
    expect(counts("a stalled pod (gray failure)")).toEqual([20, 22, 1001, 111]);
    expect(counts("a failed prober")).toEqual([1506, 22, 3, 3]);
    expect(counts("a black-holed shared dependency")).toEqual([null, 4568, null, null]);
    expect(counts("a flapping dependency")).toEqual([null, 14150, null, null]);
    expect((["a pod that cannot serve", "a partitioned pod", "a stalled pod (gray failure)", "a failed prober"] as const).map((name) => column(name).fewest)).toEqual(["C", "A", "A", "C"]);
    // B and C fail fewer requests than A in a pod that cannot serve. D fails fewer than C in a partition and a stall. B, C and D fail fewer than A on a failed prober
    const [a, b, c] = counts("a pod that cannot serve");
    expect([b! < a!, c! < a!]).toEqual([true, true]);
    for (const name of ["a partitioned pod", "a stalled pod (gray failure)"] as const) expect(counts(name)[3]!, name).toBeLessThan(counts(name)[2]!);
    for (const count of counts("a failed prober").slice(1)) expect(count!).toBeLessThan(counts("a failed prober")[0]!);
    // each measured or bounded score has the evidence of the Cilium run. The count of runs is 11 for a pod that cannot serve, and 3 for each other incident
    for (const name of ["a pod that cannot serve", "a partitioned pod", "a stalled pod (gray failure)", "a failed prober", "a black-holed shared dependency", "a flapping dependency"] as const)
      for (const candidate of column(name).candidates)
        for (const score of candidate.scores)
          if (score.kind === "measured" || score.kind === "bounded") {
            const decision = candidate.cell === "S2.T07.cilium.goaway.stall" ? "fails" : "holds";
            expect(score.evidence, `${candidate.cell} ${score.criterion}`).toEqual({ run: CILIUM_RUN, cell: candidate.cell, decision, counted: name === "a pod that cannot serve" ? 11 : 3 });
          }
    // the gap of the stall: the backlog of the target after the resume. One run of C had 1507 failed requests, over the band of 0 to 1503, and each run of C knew after the band of 9.98 s to 10 s.
    // The judge of the run used that band, thus the copy keeps its decision. The band of SYS-48 has the backlog term of SYS-45: 0 to 1542 requests and 9.98 s to 10.19 s, and each value is in it
    const stall = column("a stalled pod (gray failure)").candidates[2]!;
    const failed = scoreOf(stall, "failed requests");
    expect(failed.kind === "measured" ? [failed.holds, failed.values.map((each) => each.value), failed.prediction.hi.value] : null).toEqual([true, [1001, 499, 1507], 1542]);
    const late = scoreOf(stall, "time until callers know");
    expect(late.kind === "measured" ? [late.holds, late.values.every((each) => each.value > 10), late.prediction.hi.value] : null).toEqual([true, true, 10.19]);
    // each score of the failed requests holds
    for (const name of ["a pod that cannot serve", "a partitioned pod", "a stalled pod (gray failure)", "a failed prober", "a black-holed shared dependency", "a flapping dependency"] as const)
      for (const candidate of column(name).candidates) {
        const score = scoreOf(candidate, "failed requests");
        if (score.kind === "measured") expect(score.holds, candidate.cell).toBe(true);
      }
    // the false removal of each candidate is in its band, after the fault
    expect(column("a failed prober").candidates.map((each) => median(each, "false removals on a blip"))).toEqual([20.023, 18.528, 18.927, 19.227]);
    // the gap of the flapping dependency: Cilium refuses a connect to an empty Service at once, thus B fails fast after the removal. kube-proxy keeps the connect until its timeout.
    // Thus B knows at the removal, in each of the 9 faults, before the band of 24.98 s to 27.5 s that kube-proxy gave
    const flapping = column("a flapping dependency").candidates[1]!;
    const knows = scoreOf(flapping, "time until callers know");
    expect(knows.kind === "measured" ? [knows.holds, knows.values.length, knows.values.every((each) => each.value < knows.prediction.lo.value), knows.prediction.lo.value] : null).toEqual([false, 9, true, 24.98]);
    for (const criterion of ["time to recover", "routes down"] as const) expect(scoreOf(flapping, criterion), criterion).toMatchObject({ kind: "measured", holds: true });
    // on a black-holed shared dependency, the band of B is the band before the correction of kube-proxy, thus B knows in it
    const dependency = column("a black-holed shared dependency").candidates[1]!;
    for (const criterion of ["time until callers know", "time to recover", "routes down"] as const) expect(scoreOf(dependency, criterion), criterion).toMatchObject({ kind: "measured", holds: true });
    expect([median(dependency, "routes down"), Math.round(median(dependency, "time until callers know") * 100) / 100]).toEqual([18.273, 12.67]);
    // A, C and D of the dependencies have no cell in the run, thus no number
    for (const name of ["a black-holed shared dependency", "a flapping dependency"] as const)
      for (const candidate of column(name).candidates.filter((each) => each.label !== "B")) expect(candidate.scores.every((each) => each.kind === "not measured"), candidate.cell).toBe(true);
    // the PINGs of D, from the Cilium run
    const pings = (["a pod that cannot serve", "a partitioned pod", "a stalled pod (gray failure)", "a failed prober"] as const).map((name) => {
      const score = scoreOf(column(name).candidates[3]!, "probe load");
      return score.kind === "measured" && score.holds ? score.values.map((each) => each.value) : null;
    });
    expect(pings).toEqual([Array.from({ length: 11 }, () => 0), [2, 2, 2], [1, 2, 3], [0, 0, 0]]);
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
