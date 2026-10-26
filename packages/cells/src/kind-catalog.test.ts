import { describe, expect, it } from "vitest";
import { timerOf } from "@mark1russell7/algebra";
import type { KindCell } from "@mark1russell7/kind";
import { LINUX_TCP } from "@mark1russell7/machines";
import { clientObjects, describeCell, lintCell, namespaceOf, pausedWindow, planOf, serverObjects, stopOf, verdictsOf } from "@mark1russell7/kind";
import { STOP_RULE } from "@mark1russell7/service";
import { sessionCheckDetection, sessionCheckProblems } from "@mark1russell7/service/http-client";
import { valueIn } from "@mark1russell7/quantity";
import type { Candidate } from "./callers.ts";
import {
  CALLERS_CELLS,
  CALLERS_MODES,
  CALLER_FAULTS,
  CANDIDATES,
  CANNOT_SERVE_HOLD,
  CHECKED,
  KEEP_ALIVE,
  KIND_TCP,
  MULTIPLEXED,
  PARTITION_HOLD,
  SELECTION,
  SESSION_CHECK,
  callerFaultOf,
  expectedFailures,
  negativeBinomial,
  targetConnections,
} from "./callers.ts";
import type { CallerFault } from "./callers.ts";
import { PROPAGATION, SYN_SENT, afterSync, s } from "./kind.ts";
import { T07_CELLS } from "./t07.ts";
import { T18_CELLS } from "./t18.ts";

const ALL: readonly KindCell[] = [...T07_CELLS, ...T18_CELLS, ...CALLERS_CELLS];

/** This function gives the propagation that a cell meets. It is the pause of kube-proxy on one node, the wait after a sync in a rolling update, or the calibration of its mode. */
const propagationOf = (cell: KindCell) => {
  const e = PROPAGATION[cell.mode];
  if (cell.template === "T07" && cell.trigger.kind === "rolling-update") return afterSync(cell.mode);
  if (cell.template !== "T07" || cell.trigger.kind !== "freeze-process") return e;
  const window = pausedWindow(cell.declaration, cell.pod.preStop, cell.trigger.lead!, cell.trigger.hold!, e);
  return { ...e, hi: s(valueIn(window.resume, "s") + valueIn(e.hi, "s")) };
};

describe("the kind catalogs", () => {
  it("names each cell by a cell of the plan, or as a calibration, and each name once", () => {
    for (const cell of ALL) expect(cell.id, cell.name).toMatch(/^(T07|T18)\.(defaults|border-off)\.\d+$|^CAL\.T07\.(iptables|ipvs|nftables)$|^S2\.T07\.(iptables|ipvs|nftables)\.(endpoints|lame-duck|goaway|session-check)(.partition)?$/);
    expect(new Set(ALL.map((cell) => cell.name)).size).toBe(ALL.length);
    expect(new Set(ALL.map(namespaceOf)).size).toBe(ALL.length);
  });

  it("runs each declaration pair of T07 in the three kube-proxy modes", () => {
    for (const mode of ["iptables", "ipvs", "nftables"] as const) {
      const cells = T07_CELLS.filter((cell) => cell.mode === mode && (cell.trigger.kind === "pod-deletion" || cell.trigger.kind === "freeze-process"));
      expect(cells.length, mode).toBe(5);
    }
  });

  it("gives each cell a prediction or the reason that it has none, and a plan for its trigger", () => {
    for (const cell of ALL) {
      expect(cell.prediction.why.length, cell.name).toBeGreaterThan(10);
      expect(() => planOf(cell), cell.name).not.toThrow();
      const objects = serverObjects(cell, namespaceOf(cell), "image");
      expect(objects.length).toBe(2);
      expect(clientObjects(cell, namespaceOf(cell), "image", "10.96.0.1:80").length).toBe(1);
    }
  });

  it("predicts no failed request exactly where lint() finds that O04 holds", () => {
    for (const cell of T07_CELLS.filter((each) => stopOf(each) === "deletion")) {
      const verdicts = verdictsOf(lintCell(describeCell(cell), cell, propagationOf(cell)));
      expect(verdicts["O04"] === "holds", cell.name).toBe(cell.prediction.kind === "none");
    }
  });

  it("gives the clients of T07 a timeout longer than the first SYN retransmission, at 1 s and 64 ms of the wheel", () => {
    for (const cell of T07_CELLS) expect(valueIn(cell.workload.timeout, "s"), cell.name).toBeGreaterThan(1.064);
    for (const cell of T18_CELLS) expect(cell.workload.timeout, cell.name).toEqual(s(1));
  });

  it("lets a stale SYN_SENT entry fail the paused node up to its life after the window, and before the intake from an earlier run", () => {
    const life = valueIn(SYN_SENT, "s") + 2;
    for (const mode of ["iptables", "ipvs", "nftables"] as const) {
      const paused = T07_CELLS.find((cell) => cell.mode === mode && cell.name.endsWith("pauses 5 s on one node, the design's hold of 2 s"))!;
      const prediction = paused.prediction;
      if (prediction.kind !== "window" || prediction.end === null) throw new Error(`${paused.name}: no window`);
      expect([prediction.nodes, prediction.certain, prediction.start.from, prediction.end.from]).toEqual(["paused", true, "intake", "resume"]);
      expect(prediction.start.band.lo).toEqual(s(-life));
      expect(prediction.end.band).toEqual({ lo: PROPAGATION[mode].lo, hi: s(valueIn(PROPAGATION[mode].hi, "s") + life) });
      const held = T07_CELLS.find((cell) => cell.mode === mode && cell.name.endsWith("pauses 5 s on one node, a hold of 8 s"))!;
      expect(held.prediction.kind).toBe("none");
    }
  });

  it("waits for the end of a sync and minSyncPeriod before the rules drop the old pod of a rolling update", () => {
    // a sync of up to one idle propagation at the deletion, minSyncPeriod (1 s) after its end, then the idle propagation
    for (const mode of ["iptables", "ipvs", "nftables"] as const)
      expect(valueIn(afterSync(mode).hi, "s"), mode).toBeCloseTo(1 + 2 * valueIn(PROPAGATION[mode].hi, "s"), 9);
    expect(afterSync("iptables")).toMatchObject({ lo: s(0), hi: s(1.21) });
    // the latest drop of an old pod: 1.391 s in IPVS (kind run 40128267098), 1.065 s in iptables (39090689204)
    expect(valueIn(afterSync("ipvs").hi, "s")).toBeGreaterThan(1.391);
    expect(valueIn(afterSync("iptables").hi, "s")).toBeGreaterThan(1.065);
    const update = T07_CELLS.find((cell) => cell.trigger.kind === "rolling-update")!;
    expect(update.prediction.kind).toBe("none");
    expect(update.prediction.why).toMatch(/1\.21 s at the most, a sync of up to 0\.105 s at the change, minSyncPeriod/);
  });

  it("fits the drain of each declaration in its grace: O10 and O16 hold, and a crash has no drain to fit", () => {
    for (const cell of ALL) {
      const verdicts = verdictsOf(lintCell(describeCell(cell), cell, PROPAGATION[cell.mode]));
      if (stopOf(cell) === "crash") {
        expect([verdicts["O10"], verdicts["O16"], verdicts[STOP_RULE]], cell.name).toEqual([undefined, undefined, "depends"]);
        continue;
      }
      expect(verdicts["O10"], cell.name).toBe("holds");
      expect(verdicts["O16"], cell.name).toBe("holds");
    }
  });

  it("applies O04 only to a deletion and O09 only to a liveness restart", () => {
    for (const cell of ALL) {
      const verdicts = verdictsOf(lintCell(describeCell(cell), cell, PROPAGATION[cell.mode]));
      const way = stopOf(cell);
      expect("O04" in verdicts, cell.name).toBe(way === "deletion" || way === null);
      expect("O09" in verdicts, cell.name).toBe(way === "liveness-restart" || way === null);
    }
  });

  it("gives T18 the bands of the research at the defaults: the Service is empty from 28 s, and each replica restarts in 28–50 s", () => {
    const e = { lo: valueIn(PROPAGATION.iptables.lo, "s"), hi: valueIn(PROPAGATION.iptables.hi, "s") };
    const b = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    const band = (name: RegExp) => {
      const prediction = T18_CELLS.find((cell) => name.test(cell.name))!.prediction;
      return "band" in prediction ? prediction.band : null;
    };
    expect(band(/^T18 rst/)).toEqual(b(28 + e.lo, 48 + e.hi));
    expect(band(/^T18 Redis frozen/)).toEqual(b(28 + e.lo, 50 + e.hi));
    expect(band(/readiness fails liveness/)).toEqual(b(28, 50));
    expect(band(/event loop/)).toEqual(b(21 + e.lo, 31 + e.hi));
    // the hold of each fault outlasts its band
    for (const cell of T18_CELLS) {
      const b = "band" in cell.prediction ? cell.prediction.band : null;
      if (b !== null && cell.trigger.kind !== "app-stall") expect(valueIn(cell.trigger.hold!, "s"), cell.name).toBeGreaterThan(valueIn(b.hi, "s"));
    }
    expect(T18_CELLS.find((cell) => cell.trigger.kind === "app-stall")!.trigger.hold).toEqual(s(40));
  });
});

describe("the S2 cells: how callers learn that a pod cannot serve", () => {
  type Window = Extract<KindCell["prediction"], { kind: "window" }>;
  const windowOf = (cell: KindCell): Window => {
    if (cell.prediction.kind !== "window" || cell.prediction.end === null) throw new Error(`${cell.name}: no window`);
    return cell.prediction;
  };
  const trioOf = (mode: string, fault: CallerFault = "cannot serve"): [KindCell, KindCell, KindCell, KindCell] => {
    const trio = CALLERS_CELLS.filter((cell) => cell.mode === mode && callerFaultOf(cell) === fault);
    if (trio.length !== 4) throw new Error(`${mode}: ${trio.length} cells`);
    return trio as [KindCell, KindCell, KindCell, KindCell];
  };

  it("has the four candidates in each mode of kube-proxy, from one definition", () => {
    expect(CALLERS_MODES).toEqual(["iptables", "ipvs", "nftables"]);
    expect(CALLER_FAULTS).toEqual(["cannot serve", "partition"]);
    expect(CALLERS_CELLS.map((cell) => cell.id)).toEqual(
      ["", ".partition"].flatMap((tail) =>
        CALLERS_MODES.flatMap((mode) => [`S2.T07.${mode}.endpoints${tail}`, `S2.T07.${mode}.lame-duck${tail}`, `S2.T07.${mode}.goaway${tail}`, `S2.T07.${mode}.session-check${tail}`]),
      ),
    );
    for (const mode of CALLERS_MODES)
      expect(trioOf(mode).map((cell) => cell.name)).toEqual(CANDIDATES.map((candidate) => `T07 ${mode}, callers learn that a pod cannot serve: ${candidate}`));
  });

  it("is one cell with two settings: the lame duck of the edge, and its protocol with the connections of the clients", () => {
    for (const mode of CALLERS_MODES) {
      const [endpoints, lameDuck, goaway, checked] = trioOf(mode);
      const { declaration: a, id: _a, name: _na, prediction: _pa, ...restA } = endpoints;
      const { declaration: b, id: _b, name: _nb, prediction: _pb, ...restB } = lameDuck;
      const { declaration: c, id: _c, name: _nc, prediction: _pc, workload: workloadC, ...restC } = goaway;
      expect(restA).toEqual(restB);
      expect(a).toEqual({ ...b, lameDuck: false });
      expect(b.lameDuck).toBeUndefined();
      expect(b.protocol).toBeUndefined();
      expect(b.flag).toBe("readiness");
      expect(endpoints.workload).toEqual(KEEP_ALIVE);
      // C is B on HTTP/2: the protocol of the edge, and one session for each client
      expect(c).toEqual({ ...b, protocol: "h2c" });
      const { workload: _wb, ...restB2 } = restB;
      expect(restC).toEqual(restB2);
      expect(workloadC).toEqual(MULTIPLEXED);
      expect(MULTIPLEXED).toEqual({ ...KEEP_ALIVE, connections: 1 });
      // D is C with the session check of the client: the same server, and the knobs on the workload
      const { id: _d, name: _nd, prediction: _pd, workload: workloadD, ...restD } = checked;
      const { id: _c2, name: _nc2, prediction: _pc2, workload: _wc2, ...restC2 } = goaway;
      expect(restD).toEqual(restC2);
      expect(workloadD).toEqual(CHECKED);
      expect(CHECKED).toEqual({ ...MULTIPLEXED, sessionCheck: { keepalive_time: s(0.5), keepalive_timeout: s(0.5) } });
      // the check closes a session in 1.5 s at the most, before the stream timeout of 2 s
      expect(sessionCheckDetection(SESSION_CHECK)).toEqual(s(1.5));
      expect(valueIn(SESSION_CHECK.keepalive_time, "s") * 2 + valueIn(SESSION_CHECK.keepalive_timeout, "s")).toBeLessThan(valueIn(CHECKED.timeout, "s"));
      expect(sessionCheckProblems("D", SESSION_CHECK)).toEqual([]);
    }
    // the mode changes only the mode and the prediction
    const strip = ({ id: _id, name: _name, mode: _mode, prediction: _prediction, ...rest }: KindCell) => rest;
    const candidateOf = (cell: KindCell): string => `${callerFaultOf(cell)} ${cell.id.split(".")[3]}`;
    for (const cell of CALLERS_CELLS) expect(strip(cell)).toEqual(strip(CALLERS_CELLS.find((each) => candidateOf(each) === candidateOf(cell))!));
  });

  it("ends the window of the lame duck before the heal by the propagation of each mode, and the window of the endpoints only after it", () => {
    // the latch of 8–18 s, the readiness probe of the chart (4–6 s), the propagation of the mode, and one turn of 160 ms
    const removal = { iptables: 24.265, ipvs: 24.469, nftables: 24.239 };
    for (const mode of CALLERS_MODES) {
      const [a, b, c, d] = trioOf(mode).map(windowOf) as [Window, Window, Window, Window];
      expect([a.end!.from, b.end!.from, c.end!.from]).toEqual(["heal", "fault", "fault"]);
      // D: GOAWAY comes first, thus D has the window of C
      const { why: whyD, ...windowD } = d;
      const { why: whyC, ...windowC } = c;
      expect(windowD).toEqual(windowC);
      expect(whyD).toBe(`${whyC}. The target answers each stream at once, thus the session check closes no session, and D is the same as C`);
      expect(b.end!.band).toEqual({ lo: s(8), hi: s(removal[mode]) });
      expect(valueIn(b.end!.band.hi, "s")).toBeLessThan(valueIn(CANNOT_SERVE_HOLD, "s"));
      // C: the same latch and removal, and one turn of 20 ms on one session, thus 140 ms earlier at the latest
      expect(c.end!.band).toEqual({ lo: s(8), hi: s(Math.round((removal[mode] - 0.14) * 1000) / 1000) });
      expect(c.start.band).toEqual({ lo: s(0), hi: s(0.02) });
      // the recovery of the readiness (up to 6 s) and one turn: no propagation
      expect(a.end!.band).toEqual({ lo: s(0), hi: s(6.16) });
      for (const prediction of [a, b]) expect([prediction.certain, prediction.start.from, prediction.outcomes]).toEqual([true, "fault", ["503"]]);
      // a run of C with no session on the target has no failure, thus C is not certain
      expect([c.certain, c.start.from, c.outcomes]).toEqual([false, "fault", ["503"]]);
    }
  });

  it("puts 12 of the 24 connections on the target in turn, and 7 to 17 at random", () => {
    const band = (lo: number, hi: number) => ({ lo: { value: lo, unit: "{connection}" }, hi: { value: hi, unit: "{connection}" }, of: { value: 24, unit: "{connection}" } });
    expect(SELECTION).toEqual({ iptables: "random", ipvs: "in turn", nftables: "random" });
    // the binomial count of 24 connections with a chance of 1/2: P(k <= 6) = P(k >= 18) = 0.011, P(k <= 7) = 0.032
    expect(CALLERS_MODES.map((mode) => targetConnections(mode))).toEqual([band(7, 17), band(12, 12), band(7, 17)]);
  });

  it("puts 0 to 3 of the 3 sessions of HTTP/2 on the target in each mode", () => {
    const band = (lo: number, hi: number) => ({ lo: { value: lo, unit: "{connection}" }, hi: { value: hi, unit: "{connection}" }, of: { value: 3, unit: "{connection}" } });
    // at random, P(k = 0) = 1/8 is above the tail of 0.025. In turn, the first pick of each node is not known
    expect(CALLERS_MODES.map((mode) => targetConnections(mode, 1))).toEqual([band(0, 3), band(0, 3), band(0, 3)]);
  });

  it("expects 6.25 failed requests each second for each connection on the target", () => {
    const band = (lo: number, hi: number) => ({ lo: { value: lo, unit: "{request}" }, hi: { value: hi, unit: "{request}" } });
    const counts = (candidate: Candidate) => CALLERS_MODES.map((mode) => { const { lo, hi } = expectedFailures(candidate, mode); return { lo, hi }; });
    // A: the hold of 30 s, then up to 6.16 s of recovery. B: the latch of 8 to 18 s
    expect(counts("endpoints only")).toEqual([band(1313, 3842), band(2250, 2712), band(1313, 3842)]);
    expect(counts("in band (lame duck)")).toEqual([band(350, 1913), band(600, 1350), band(350, 1913)]);
    // C: 50 failed requests each second for each session on the target, until the latch (up to 18 s)
    expect(counts("in band on HTTP/2 (GOAWAY)")).toEqual([band(0, 2700), band(0, 2700), band(0, 2700)]);
    expect(counts("in band on HTTP/2 with a session check")).toEqual(counts("in band on HTTP/2 (GOAWAY)"));
  });

  it("partitions the target in each mode with the cells of each candidate: only the trigger, the prediction and the runs change", () => {
    for (const mode of CALLERS_MODES) {
      const serve = trioOf(mode);
      const partition = trioOf(mode, "partition");
      expect(partition.map((cell) => cell.name)).toEqual(CANDIDATES.map((candidate) => `T07 ${mode}, callers learn that a pod is partitioned: ${candidate}`));
      for (const [at, cell] of partition.entries()) {
        const { id, name: _n, trigger, prediction: _p, runs, ...rest } = cell;
        const { id: twin, name: _tn, trigger: _tt, prediction: _tp, runs: _tr, ...restTwin } = serve[at]!;
        expect(id).toBe(`${twin}.partition`);
        expect(rest).toEqual(restTwin);
        expect(trigger).toEqual({ kind: "blackhole", hold: PARTITION_HOLD, partition: true });
        expect(runs).toBe(3);
      }
    }
  });

  it("predicts that A and B fail on new connections for a few turns, and C until the first retransmission after the heal", () => {
    // the RTO of a kind node: 200 ms and one jiffy at HZ 1000
    expect(timerOf(LINUX_TCP, "retransmit", KIND_TCP, 0).duration).toEqual(s(0.201));
    // the failures of 24 connections, each on the target with a chance of 1/2: P(k <= 11) = 0.021, P(k >= 40) = 0.022
    expect(negativeBinomial(24, 0.5)).toEqual({ lo: 12, hi: 39 });
    const band = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    const requests = (lo: number, hi: number) => ({ lo: { value: lo, unit: "{request}" }, hi: { value: hi, unit: "{request}" } });
    for (const mode of CALLERS_MODES) {
      const [a, b, c] = trioOf(mode, "partition").map(windowOf) as [Window, Window, Window];
      const random = SELECTION[mode] === "random";
      // A and B: 14 picks of 160 ms at random (24 × 2^-15 < 0.001), 4 rounds in turn
      for (const prediction of [a, b]) {
        expect([prediction.certain, prediction.start, prediction.end, prediction.outcomes]).toEqual([
          true,
          { from: "fault", band: band(0, 0.16) },
          { from: "fault", band: band(0, random ? 2.24 : 0.64) },
          ["timeout"],
        ]);
      }
      expect(a.why).toBe(b.why.replace(". The lame duck never starts, thus B is the same as A", ""));
      for (const candidate of ["endpoints only", "in band (lame duck)"] as const) {
        const { lo, hi } = expectedFailures(candidate, mode, "partition");
        expect({ lo, hi }).toEqual(random ? requests(12, 39) : requests(21, 24));
      }
      // C: firing 7 crosses 25.72–26.968 s after its start, which is 0.221 s before the fault to 0.02 s after it
      expect([c.certain, c.start, c.end, c.outcomes]).toEqual([false, { from: "fault", band: band(0, 0.02) }, { from: "fault", band: band(23.479, 26.988) }, undefined]);
      expect(c.why).toMatch(/firing 7 of the timer is the first after the heal: 25\.499 s–26\.988 s after the fault/);
      const { lo, hi } = expectedFailures("in band on HTTP/2 (GOAWAY)", mode, "partition");
      expect({ lo, hi }).toEqual(requests(0, 4048));
    }
  });

  it("predicts that D closes each session on the target in 1.5 s at the most, and its next session in 1 s", () => {
    // the picks of the target of 3 sessions at random: P(k <= 8) = 0.967, P(k <= 9) = 0.981
    expect(negativeBinomial(3, 0.5)).toEqual({ lo: 0, hi: 9 });
    const band = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    const requests = (lo: number, hi: number) => ({ lo: { value: lo, unit: "{request}" }, hi: { value: hi, unit: "{request}" } });
    for (const mode of CALLERS_MODES) {
      const d = windowOf(trioOf(mode, "partition")[3]);
      const random = SELECTION[mode] === "random";
      // in turn, the next session goes to the other replica. At random, a chain of 11 picks: 3 × 2^-12 < 0.001, and 10 next sessions of 1.02 s
      expect([d.certain, d.start, d.end, d.outcomes]).toEqual([false, { from: "fault", band: band(0, 0.02) }, { from: "fault", band: band(0, random ? 11.7 : 1.5) }, undefined]);
      expect(d.why).toMatch(/The first session on the target closes 0\.98 s–1\.5 s after the fault, before its first stream timeout \(2 s\)\. Each stream on it fails at the close, 49–76 streams/);
      // in turn, 3 first sessions of 76 streams at the most. At random, 9 picks: 3 first sessions, and 6 next sessions of 51 streams at the most
      const { lo, hi } = expectedFailures("in band on HTTP/2 with a session check", mode, "partition");
      expect({ lo, hi }).toEqual(random ? requests(0, 534) : requests(0, 228));
    }
  });
});
