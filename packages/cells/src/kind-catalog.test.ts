import { describe, expect, it } from "vitest";
import { timerOf } from "@mark1russell7/algebra";
import type { KindCell } from "@mark1russell7/kind";
import { LINUX_TCP } from "@mark1russell7/machines";
import {
  NODE_LIFECYCLE,
  clientObjects,
  describeCell,
  faultSpan,
  kubeletBand,
  lintCell,
  namespaceOf,
  nodeLossBand,
  pausedWindow,
  planOf,
  removalBand,
  serverObjects,
  stallRemovalBand,
  stopOf,
  verdictsOf,
} from "@mark1russell7/kind";
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
  DEPENDENCY_HOLD,
  FLAPS,
  FLAP_FAULTS,
  FLAP_HOLD,
  FLAP_REST,
  KEEP_ALIVE,
  KIND_TCP,
  MULTIPLEXED,
  PARTITION_HOLD,
  REDIS_HEAL_LEAD,
  SELECTION,
  SESSION_CHECK,
  SLOW_DELAY,
  SLOW_HOLD,
  STALL_HOLD,
  ZONE_CLIENTS,
  ZONE_HEAL_LEAD,
  ZONE_HOLD,
  callerFaultOf,
  dependencyOf,
  expectedFailures,
  falseOf,
  flappingOf,
  lostZoneOf,
  negativeBinomial,
  pingsOf,
  slowOf,
  targetConnections,
} from "./callers.ts";
import type { CallerFault } from "./callers.ts";
import { CHART_READINESS, DESIGN_REDIS, KUBE_PROBE, PROPAGATION, SYN_SENT, afterSync, s } from "./kind.ts";
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
    for (const cell of ALL) expect(cell.id, cell.name).toMatch(/^(T07|T18)\.(defaults|border-off)\.\d+$|^CAL\.T07\.(iptables|ipvs|nftables)$|^S2\.T07\.(iptables|ipvs|nftables)\.(endpoints|lame-duck|goaway|session-check)(\.partition|\.stall|\.prober|\.dependency|\.flapping|\.zone|\.slow)?$/);
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
    expect(CALLER_FAULTS).toEqual(["cannot serve", "partition", "stall", "false failure", "shared dependency", "flapping dependency", "lost zone", "slow dependency"]);
    expect(CALLERS_CELLS.map((cell) => cell.id)).toEqual(
      ["", ".partition", ".stall", ".prober", ".dependency", ".flapping", ".zone", ".slow"].flatMap((tail) =>
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

  it("stalls the target in each mode with the cells of each candidate: only the trigger, the prediction and the runs change", () => {
    for (const mode of CALLERS_MODES) {
      const serve = trioOf(mode);
      const stall = trioOf(mode, "stall");
      expect(stall.map((cell) => cell.name)).toEqual(CANDIDATES.map((candidate) => `T07 ${mode}, callers learn that a pod is stalled: ${candidate}`));
      for (const [at, cell] of stall.entries()) {
        const { id, name: _n, trigger, prediction: _p, runs, ...rest } = cell;
        const { id: twin, name: _tn, trigger: _tt, prediction: _tp, runs: _tr, ...restTwin } = serve[at]!;
        expect(id).toBe(`${twin}.stall`);
        expect(rest).toEqual(restTwin);
        expect(trigger).toEqual({ kind: "app-stall", hold: STALL_HOLD });
        expect(runs).toBe(3);
        // each client opens new connections before the stall, as in a partition
        expect(planOf(cell).prepare).toEqual([{ do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: s(3) }]);
      }
    }
  });

  it("holds the stall past the removal by the readiness probe and the idle close of the server, and short of the liveness restart", () => {
    const removals = CALLERS_MODES.map((mode) => valueIn(stallRemovalBand(CHART_READINESS, PROPAGATION[mode]).hi, "s"));
    expect(removals).toEqual([7.105, 7.309, 7.079]);
    const hold = valueIn(STALL_HOLD, "s");
    expect(hold).toBeGreaterThan(Math.max(...removals));
    // the idle close of the server is 6 s (server_idle_close of the image)
    expect(hold).toBeGreaterThan(6);
    // the third failed liveness probe comes 21 s after the start of the stall at the earliest
    expect(valueIn(kubeletBand(KUBE_PROBE, true).lo, "s")).toBe(21);
    expect(hold).toBeLessThan(21);
  });

  it("predicts that A, B and D of a stall fail as in a partition, D until the removal, and C until one timeout before the resume", () => {
    const band = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    const requests = (lo: number, hi: number) => ({ lo: { value: lo, unit: "{request}" }, hi: { value: hi, unit: "{request}" } });
    // the latest removal, then one check of the last session on the target
    const dEnd = { iptables: 8.105, ipvs: 1.5, nftables: 8.079 };
    for (const mode of CALLERS_MODES) {
      const [a, b, c, d] = trioOf(mode, "stall").map(windowOf) as [Window, Window, Window, Window];
      const random = SELECTION[mode] === "random";
      for (const prediction of [a, b])
        expect([prediction.certain, prediction.start, prediction.end, prediction.outcomes]).toEqual([
          true,
          { from: "fault", band: band(0, 0.16) },
          { from: "fault", band: band(0, random ? 2.24 : 0.64) },
          ["timeout"],
        ]);
      expect(a.why).toBe(b.why.replace(". The lame duck never starts, thus B is the same as A", ""));
      // the last pick of a chain: one turn before the last failure, plus the timeout
      expect(a.why).toMatch(random ? /The last pick of a chain comes 4\.08 s after the fault at the latest, before the removal/ : /The last pick of a chain comes 2\.48 s after the fault at the latest, before the removal/);
      for (const candidate of ["endpoints only", "in band (lame duck)"] as const) {
        const { lo, hi } = expectedFailures(candidate, mode, "stall");
        expect({ lo, hi }).toEqual(random ? requests(12, 39) : requests(21, 24));
      }
      // C: the resume 12 s after the fault, less the timeout of 2 s and up to one request
      expect([c.certain, c.start, c.end, c.outcomes]).toEqual([false, { from: "fault", band: band(0, 0.02) }, { from: "fault", band: band(9.98, 10) }, ["timeout"]]);
      expect(expectedFailures("in band on HTTP/2 (GOAWAY)", mode, "stall")).toMatchObject(requests(0, 1503));
      // D: the arithmetic of the partition, and the removal ends the chains at random
      expect([d.certain, d.start, d.end, d.outcomes]).toEqual([false, { from: "fault", band: band(0, 0.02) }, { from: "fault", band: band(0, dEnd[mode]) }, undefined]);
      expect(d.why).toMatch(/its TCP connects, but the blocked loop sends no SETTINGS frame\. The check sends a PING, which gets no ACK, and it closes the session 1 s after its first stream|IPVS selects in turn/);
      const { lo, hi } = expectedFailures("in band on HTTP/2 with a session check", mode, "stall");
      expect({ lo, hi }).toEqual(random ? requests(0, 534) : requests(0, 228));
    }
  });

  it("fails the prober of the target while it can serve, with the cells of each candidate: only the trigger, the prediction and the runs change", () => {
    for (const mode of CALLERS_MODES) {
      const serve = trioOf(mode);
      const prober = trioOf(mode, "false failure");
      expect(prober.map((cell) => cell.name)).toEqual(CANDIDATES.map((candidate) => `T07 ${mode}, callers learn that a prober fails while the pod can serve: ${candidate}`));
      for (const [at, cell] of prober.entries()) {
        const { id, name: _n, trigger, prediction: _p, runs, ...rest } = cell;
        const { id: twin, name: _tn, trigger: twinTrigger, prediction: _tp, runs: _tr, ...restTwin } = serve[at]!;
        expect(id).toBe(`${twin}.prober`);
        expect(rest).toEqual(restTwin);
        // the trigger of "cannot serve", with the flag that keeps the route
        expect(trigger).toEqual({ ...twinTrigger, serves: true });
        expect(runs).toBe(3);
        expect(planOf(cell)).toEqual(planOf(serve[at]!));
      }
    }
  });

  it("predicts the false removal of each candidate by the latch, the probe and the propagation, and the refusals after the latch", () => {
    const band = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    const requests = (lo: number, hi: number) => ({ lo: { value: lo, unit: "{request}" }, hi: { value: hi, unit: "{request}" } });
    // the latch of 8–18 s, the readiness probe of the chart (4–6 s), and the propagation of the mode
    const removal = { iptables: band(12, 24.105), ipvs: band(12.073, 24.309), nftables: band(12, 24.079) };
    for (const mode of CALLERS_MODES) {
      const random = SELECTION[mode] === "random";
      const cells = trioOf(mode, "false failure");
      for (const cell of cells) {
        if (cell.prediction.kind !== "leaves" || cell.prediction.window === undefined) throw new Error(`${cell.name}: no departure with a window`);
        expect(cell.prediction.band).toEqual(removal[mode]);
        expect(cell.prediction.band).toEqual(removalBand({ lo: s(8), hi: s(18) }, CHART_READINESS, PROPAGATION[mode]));
        expect(valueIn(cell.prediction.band.hi, "s")).toBeLessThan(valueIn(CANNOT_SERVE_HOLD, "s"));
      }
      const [a, b, c, d] = cells.map((cell) => (cell.prediction.kind === "leaves" ? cell.prediction.window! : null)) as [Window, Window, Window, Window];
      // no request fails before the latch: the first refusal comes in one turn after it
      expect([a.certain, a.start, a.end, a.outcomes]).toEqual([true, { from: "fault", band: band(8, 18.16) }, { from: "heal", band: band(0, 6.16) }, ["503"]]);
      // B: the chains of new connections after the latch, 14 picks at random and 4 rounds in turn
      expect([b.certain, b.start, b.end, b.outcomes]).toEqual([true, { from: "fault", band: band(8, 18.16) }, { from: "fault", band: band(8, random ? 20.24 : 18.64) }, ["503"]]);
      // C: one session for each client, 11 picks of 20 ms at random, and 1 round in turn
      expect([c.certain, c.start, c.end, c.outcomes]).toEqual([false, { from: "fault", band: band(8, 18.02) }, { from: "fault", band: band(8, random ? 18.22 : 18.02) }, ["503"]]);
      // D: the target answers at once, thus D has the window of C
      const { why: whyD, ...windowD } = d;
      const { why: whyC, ...windowC } = c;
      expect(windowD).toEqual(windowC);
      expect(whyD).toBe(`${whyC.replace(/\. Each pick goes|\. IPVS selects/, (found) => `. The target answers each stream at once, thus the session check closes no session, and D is the same as C${found}`)}`);
      const counts = (candidate: Candidate) => { const { lo, hi } = falseOf(mode, candidate).expected; return { lo, hi }; };
      // A: 6.25 requests each second on each connection on the target, from the latch to the recovery after the heal
      expect(counts("endpoints only")).toEqual(random ? requests(525, 2992) : requests(900, 2112));
      expect(counts("in band (lame duck)")).toEqual(random ? requests(12, 39) : requests(21, 24));
      expect(counts("in band on HTTP/2 (GOAWAY)")).toEqual(random ? requests(0, 9) : requests(0, 3));
      expect(counts("in band on HTTP/2 with a session check")).toEqual(counts("in band on HTTP/2 (GOAWAY)"));
      for (const candidate of CANDIDATES) expect(expectedFailures(candidate, mode, "false failure")).toEqual(falseOf(mode, candidate).expected);
    }
  });

  it("black-holes Redis for each replica, with the cells of each candidate: the design with Redis, and no flag", () => {
    for (const mode of CALLERS_MODES) {
      const serve = trioOf(mode);
      const dependency = trioOf(mode, "shared dependency");
      expect(dependency.map((cell) => cell.name)).toEqual(CANDIDATES.map((candidate) => `T07 ${mode}, callers learn that a shared dependency is black-holed: ${candidate}`));
      for (const [at, cell] of dependency.entries()) {
        const { id, name: _n, trigger, prediction: _p, runs, declaration, ...rest } = cell;
        const { id: twin, name: _tn, trigger: _tt, prediction: _tp, runs: _tr, declaration: twinDeclaration, ...restTwin } = serve[at]!;
        expect(id).toBe(`${twin}.dependency`);
        expect(rest).toEqual(restTwin);
        // the settings of the candidate, on the design with Redis: the round trip gates readiness
        expect(declaration).toEqual({ ...twinDeclaration, flag: null, redis: DESIGN_REDIS.redis });
        expect(declaration!.redis!.gates).toBe("readiness");
        // a black hole with no partition is on Redis, with each replica as a peer
        expect(trigger).toEqual({ kind: "blackhole", hold: DEPENDENCY_HOLD });
        expect(planOf(cell).inject).toEqual([{ do: "inject", target: "redis", action: "blackhole" }]);
        expect(runs).toBe(3);
      }
    }
  });

  it("predicts the empty Service of each candidate, the failed requests from the fault to the recovery, and the recovery after the heal", () => {
    const band = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    // the silent latch of 8–20 s, the readiness probe of the chart (4–6 s), and the propagation of the mode
    const removal = { iptables: band(12, 26.105), ipvs: band(12.073, 26.309), nftables: band(12, 26.079) };
    // the reconnect (3.1 s), the recovery of the readiness (6 s), then for B, C and D the kubelet (2 s) and the propagation, and one turn
    const ends = {
      iptables: [9.26, 11.365, 11.225, 11.225],
      ipvs: [9.26, 11.569, 11.429, 11.429],
      nftables: [9.26, 11.339, 11.199, 11.199],
    };
    const counts = { iptables: [5742, 6060, 6039, 6039], ipvs: [5742, 6090, 6069, 6069], nftables: [5742, 6054, 6033, 6033] };
    for (const mode of CALLERS_MODES) {
      for (const [at, cell] of trioOf(mode, "shared dependency").entries()) {
        if (cell.prediction.kind !== "removal" || cell.prediction.window === undefined) throw new Error(`${cell.name}: no removal with a window`);
        expect(cell.prediction.band).toEqual(removal[mode]);
        expect(valueIn(cell.prediction.band.hi, "s")).toBeLessThan(valueIn(DEPENDENCY_HOLD, "s"));
        const window = cell.prediction.window;
        expect([window.certain, window.start, window.end, window.outcomes]).toEqual([true, { from: "fault", band: band(0, 0.02) }, { from: "heal", band: band(0, ends[mode][at]!) }, undefined]);
        const candidate = CANDIDATES[at]!;
        const predicted = dependencyOf(mode, candidate);
        // the callers know at the latch: after it, each failure is fast. A request can wait one timeout behind a slow one
        expect(predicted.knows).toEqual(band(7.98, 22));
        const { lo, hi } = expectedFailures(candidate, mode, "shared dependency");
        expect([lo.value, hi.value]).toEqual([3954, counts[mode][at]]);
      }
    }
  });

  it("flaps the black hole of Redis: the cells of the shared dependency, with three faults in one run", () => {
    expect(FLAP_FAULTS).toBe(3);
    expect(FLAPS).toEqual([
      { rest: s(15), hold: s(27) },
      { rest: s(15), hold: s(27) },
    ]);
    expect(FLAP_HOLD).toEqual(DEPENDENCY_HOLD);
    for (const mode of CALLERS_MODES) {
      const dependency = trioOf(mode, "shared dependency");
      const flapping = trioOf(mode, "flapping dependency");
      expect(flapping.map((cell) => cell.name)).toEqual(CANDIDATES.map((candidate) => `T07 ${mode}, callers learn that a shared dependency flaps: ${candidate}`));
      for (const [at, cell] of flapping.entries()) {
        const { id, name: _n, trigger, prediction: _p, ...rest } = cell;
        const { id: twin, name: _tn, trigger: _tt, prediction: _tp, ...restTwin } = dependency[at]!;
        expect(id).toBe(twin.slice(0, -".dependency".length) + ".flapping");
        // the same design, settings, workload and runs: only the trigger and the prediction differ
        expect(rest).toEqual(restTwin);
        expect(trigger).toEqual({ kind: "blackhole", hold: FLAP_HOLD, flaps: FLAPS });
        expect(callerFaultOf(cell)).toBe("flapping dependency");
        const plan = planOf(cell);
        expect(plan.inject).toEqual([{ do: "inject", target: "redis", action: "blackhole" }]);
        expect(plan.flaps).toEqual(FLAPS);
        // three holds and two rests
        expect(faultSpan(cell.trigger)).toEqual(s(111));
      }
    }
  });

  it("predicts each fault of a flapping dependency: the empty Service, the window of each cycle, and the failed requests", () => {
    const band = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    // per fault: A from the fault to its recovery. B, C and D: their last failure can start one timeout before the heal
    const each = { iptables: [5517, 5835, 5814, 5814], ipvs: [5517, 5865, 5844, 5844], nftables: [5517, 5829, 5808, 5808] };
    for (const mode of CALLERS_MODES) {
      for (const [at, cell] of trioOf(mode, "flapping dependency").entries()) {
        const candidate = CANDIDATES[at]!;
        const one = dependencyOf(mode, candidate);
        const predicted = flappingOf(mode, candidate);
        if (cell.prediction.kind !== "removal" || cell.prediction.window === undefined) throw new Error(`${cell.name}: no removal with a window`);
        expect(cell.prediction.flaps).toBe(true);
        expect(cell.prediction.band).toEqual(one.removal);
        // the Service is empty in each fault, and its recovery ends in the rest
        expect(valueIn(one.removal.hi, "s")).toBeLessThan(valueIn(FLAP_HOLD, "s"));
        expect(valueIn(one.end.hi, "s") + 2).toBeLessThan(valueIn(FLAP_REST, "s"));
        const window = cell.prediction.window;
        const a = candidate === "endpoints only";
        expect([window.certain, window.flaps, window.start, window.end]).toEqual([true, true, { from: "fault", band: band(0, 0.02) }, { from: "heal", band: { lo: s(a ? 0 : -2), hi: one.end.hi } }]);
        expect(REDIS_HEAL_LEAD).toEqual(band(0, 0.5));
        // A knows at the latch. B, C and D fail slowly until the heal, thus they know in the last timeout before it
        expect(predicted.knows).toEqual(a ? band(7.98, 22) : band(24.98, 27.5));
        expect([predicted.each.lo.value, predicted.each.hi.value]).toEqual([a ? 3852 : 3567, each[mode][at]]);
        const { lo, hi } = expectedFailures(candidate, mode, "flapping dependency");
        expect([lo.value, hi.value]).toEqual([3 * predicted.each.lo.value, 3 * predicted.each.hi.value]);
        expect(predicted.why).toContain(`${predicted.each.lo.value}–${predicted.each.hi.value} requests fail in each fault`);
        // D sends the PINGs of the shared dependency in each fault
        if (candidate === "in band on HTTP/2 with a session check") {
          const once = pingsOf(mode, candidate, "shared dependency");
          const thrice = pingsOf(mode, candidate, "flapping dependency");
          expect([thrice.lo.value, thrice.hi.value]).toEqual([3 * once.lo.value, 3 * once.hi.value]);
        }
      }
    }
  });

  it("loses the zone of the target: the cells of the partition, with the trigger zone-loss and the clients of the kept zone", () => {
    expect(ZONE_CLIENTS).toBe(2);
    for (const mode of CALLERS_MODES) {
      const partition = trioOf(mode, "partition");
      const zone = trioOf(mode, "lost zone");
      expect(zone.map((cell) => cell.name)).toEqual(CANDIDATES.map((candidate) => `T07 ${mode}, callers learn that a zone is lost: ${candidate}`));
      for (const [at, cell] of zone.entries()) {
        const { id, name: _n, trigger, prediction: _p, ...rest } = cell;
        const { id: twin, name: _tn, trigger: _tt, prediction: _tp, ...restTwin } = partition[at]!;
        expect(id).toBe(twin.slice(0, -".partition".length) + ".zone");
        // the same design, settings, workload and runs: only the trigger and the prediction differ
        expect(rest).toEqual(restTwin);
        expect(trigger).toEqual({ kind: "zone-loss", hold: ZONE_HOLD });
        expect(callerFaultOf(cell)).toBe("lost zone");
        const plan = planOf(cell);
        expect([plan.inject, plan.heal]).toEqual([[{ do: "zone", lost: true }], [{ do: "zone", lost: false }]]);
        expect(stopOf(cell)).toBeNull();
      }
    }
  });

  it("predicts a lost zone: the removal by the node lifecycle controller, the window of each candidate, and the return", () => {
    const band = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    const removal = { iptables: band(39.6, 55.355), ipvs: band(39.6, 55.559), nftables: band(39.6, 55.329) };
    // A and B: the chains of a partition on 16 connections. C: firing 9 crosses the heal. D: the session check
    const ends = { iptables: [2.08, 2.08, 108.78, 10.68], ipvs: [0.64, 0.64, 108.78, 1.5], nftables: [2.08, 2.08, 108.78, 10.68] };
    const counts = { iptables: [[6, 28], [6, 28], [0, 10878], [0, 407]], ipvs: [[14, 16], [14, 16], [0, 10878], [0, 152]], nftables: [[6, 28], [6, 28], [0, 10878], [0, 407]] };
    for (const mode of CALLERS_MODES) {
      for (const [at, cell] of trioOf(mode, "lost zone").entries()) {
        const candidate = CANDIDATES[at]!;
        const predicted = lostZoneOf(mode, candidate);
        if (cell.prediction.kind !== "leaves" || cell.prediction.window === undefined) throw new Error(`${cell.name}: no departure with a window`);
        expect(cell.prediction.band).toEqual(removal[mode]);
        expect(predicted.removal).toEqual(nodeLossBand(NODE_LIFECYCLE, PROPAGATION[mode]));
        // the hold outlasts the removal, and no pod is evicted in it (300 s)
        expect(valueIn(predicted.removal.hi, "s")).toBeLessThan(valueIn(ZONE_HOLD, "s"));
        expect(valueIn(ZONE_HOLD, "s")).toBeLessThan(300);
        expect(predicted.returns).toEqual(band(0, 26.85));
        expect(ZONE_HEAL_LEAD).toEqual(band(0, 2));
        const window = cell.prediction.window;
        const c = candidate === "in band on HTTP/2 (GOAWAY)";
        expect(window.end).toEqual({ from: "fault", band: band(c ? 67.98 : 0, ends[mode][at]!) });
        const { lo, hi } = expectedFailures(candidate, mode, "lost zone");
        expect([lo.value, hi.value]).toEqual(counts[mode][at]);
        // a run of C or D can have no session on the target, thus only A and B are certain
        expect(window.certain).toBe(!inBandOnHttp2(candidate));
        expect(window.outcomes).toEqual(inBandOnHttp2(candidate) ? undefined : ["timeout"]);
      }
      // D sends one PING on each session on the target, as in a partition, with 2 clients
      const pings = pingsOf(mode, "in band on HTTP/2 with a session check", "lost zone");
      expect([pings.lo.value, pings.hi.value]).toEqual([0, 2]);
      expect(targetConnections(mode, 1, ZONE_CLIENTS).of.value).toBe(2);
    }
  });

  it("slows the shared dependency: the cells of the black hole, with the trigger latency", () => {
    expect(valueIn(SLOW_DELAY, "ms")).toBe(300);
    expect(SLOW_HOLD).toEqual(DEPENDENCY_HOLD);
    for (const mode of CALLERS_MODES) {
      const dependency = trioOf(mode, "shared dependency");
      const slow = trioOf(mode, "slow dependency");
      expect(slow.map((cell) => cell.name)).toEqual(CANDIDATES.map((candidate) => `T07 ${mode}, callers learn that a shared dependency is slow: ${candidate}`));
      for (const [at, cell] of slow.entries()) {
        const { id, name: _n, trigger, prediction: _p, ...rest } = cell;
        const { id: twin, name: _tn, trigger: _tt, prediction: _tp, ...restTwin } = dependency[at]!;
        expect(id).toBe(twin.slice(0, -".dependency".length) + ".slow");
        // the same design, settings, workload and runs: only the trigger and the prediction differ
        expect(rest).toEqual(restTwin);
        expect(trigger).toEqual({ kind: "latency", hold: SLOW_HOLD, delay: SLOW_DELAY });
        expect(callerFaultOf(cell)).toBe("slow dependency");
        const plan = planOf(cell);
        expect(plan.inject).toEqual([{ do: "netem", target: "redis", delay: SLOW_DELAY }]);
        expect(plan.heal).toEqual(plan.restore);
        expect(stopOf(cell)).toBeNull();
        expect(lintCell(cell)).toEqual([]);
      }
    }
  });

  it("predicts a slow dependency: each replica stays, A and B fail by the queue of HTTP/1.1, and C and D fail no request", () => {
    const band = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
    for (const mode of CALLERS_MODES) {
      for (const [at, cell] of trioOf(mode, "slow dependency").entries()) {
        const candidate = CANDIDATES[at]!;
        const predicted = slowOf(mode, candidate);
        if (cell.prediction.kind !== "stays" || cell.prediction.failures === undefined) throw new Error(`${cell.name}: no stay with its failures`);
        const failures = cell.prediction.failures;
        const { lo, hi } = expectedFailures(candidate, mode, "slow dependency");
        if (inBandOnHttp2(candidate)) {
          // each stream waits for Redis on its own: 0.3 s, far below the timeout of 2 s
          expect(failures.kind).toBe("none");
          expect([lo.value, hi.value]).toEqual([0, 0]);
          expect([predicted.start, predicted.end]).toEqual([null, null]);
          continue;
        }
        if (failures.kind !== "window") throw new Error(`${cell.name}: A and B have a window`);
        // request j of a connection takes 0.3 s + j × 0.14 s: request 13 is the first above the timeout of 2 s
        expect(failures.start).toEqual({ from: "fault", band: band(0.96, 2.24) });
        expect(failures.end).toEqual({ from: "heal", band: band(-2.02, -1.74) });
        expect([failures.certain, failures.outcomes]).toEqual([true, ["timeout"]]);
        expect([lo.value, hi.value]).toEqual([3240, 3744]);
        expect(predicted.expected.connections.lo.value).toBe(24);
      }
      // the longest time with no frame on a session of D is the delay, shorter than its tick of 0.5 s
      const pings = pingsOf(mode, "in band on HTTP/2 with a session check", "slow dependency");
      expect([pings.lo.value, pings.hi.value]).toEqual([0, 0]);
      expect(valueIn(SLOW_DELAY, "s")).toBeLessThan(valueIn(SESSION_CHECK.keepalive_time, "s"));
    }
  });
});

/** This function tells if a candidate is C or D: one session of HTTP/2 for each client. */
const inBandOnHttp2 = (candidate: Candidate): boolean => candidate === "in band on HTTP/2 (GOAWAY)" || candidate === "in band on HTTP/2 with a session check";
