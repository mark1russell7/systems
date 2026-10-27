import { describe, expect, it } from "vitest";
import type { KindCell, KindRun, Prediction } from "./cell.ts";
import type { Line } from "./lab.ts";
import { cellOf } from "./cells.fixture.ts";
import { predictionText } from "./report.ts";
import { checkRun, judgeKind, observationAfter, observationEnd, propagationOf, propagationSource, updatesOf } from "./verdict.ts";

const TARGET = { pod: "lab-a", node: "w1", ip: "10.244.1.3", version: "h1" };
const OTHER = { pod: "lab-b", node: "w2", ip: "10.244.2.4", version: "h1" };

/** a run with a deletion at 1000 ms, the stop of the intake at 3000 ms, and the backend gone from w1 at 1100 ms */
const runWith = (extra: Line[], acts: Partial<KindRun["acts"]> = {}): KindRun => ({
  env: 0,
  index: 0,
  warmup: false,
  start: 0,
  end: 60_000,
  acts: { fault: null, heal: null, resume: null, ...acts },
  target: TARGET,
  paused: "w1",
  replicas: [TARGET, OTHER],
  void: null,
  dropped: {},
  lines: [
    { ev: "pod", t: 1000, type: "MODIFIED", name: "lab-a", node: "w1", ip: TARGET.ip, del: true, ready: true, phase: "Running", cs: [], labels: {} },
    { ev: "rules", t: 1100, prev: 1050, node: "w1", b: ["10.244.2.4:8080"] },
    { ev: "rules", t: 1080, prev: 1030, node: "w2", b: ["10.244.2.4:8080"] },
    { ev: "rec", t: 3000, at: 3000, p: "lab-a", m: "drain", i: "lab", from: "fail readiness", to: "stop intake", on: "phase.done", d: null },
    ...extra,
  ],
});

const request = (t: number, o: string, n = "w1"): Line => ({ ev: "req", t, d: 1, o, p: `client-${n}`, n });
const s = (value: number) => ({ value, unit: "s" });
const b = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
const cell = (prediction: Prediction): KindCell => ({ ...cellOf("pod-deletion"), prediction });

describe("the judgement of a kind run", () => {
  it("measures the propagation of each node from the deletion, between two polls", () => {
    expect(propagationOf(runWith([]), 1000)).toEqual({ w1: { after: s(0.05), by: s(0.1) }, w2: { after: s(0.03), by: s(0.08) } });
  });

  it("measures the propagation of a sidecar mesh from the EDS poll of each client sidecar, not from the rules", () => {
    const eds: Line[] = [
      { ev: "eds", t: 1300, prev: 1250, node: "w1", pod: "client-w1", b: ["10.244.2.4:8080"] },
      { ev: "eds", t: 1420, prev: 1370, node: "w2", pod: "client-w2", b: ["10.244.2.4:8080"] },
    ];
    const run = runWith(eds);
    expect(propagationOf(run, 1000, undefined, "eds")).toEqual({ w1: { after: s(0.25), by: s(0.3) }, w2: { after: s(0.37), by: s(0.42) } });
    const sidecar = { ...cellOf("pod-deletion"), template: "T15", mesh: { flavor: "sidecar", mode: "sidecar" } } as const;
    expect(propagationSource(sidecar)).toBe("eds");
    expect(propagationSource(cellOf("pod-deletion"))).toBe("rules");
    expect(checkRun({ ...sidecar, prediction: { kind: "none", why: "a test" } }, run).facts.propagation).toEqual(propagationOf(run, 1000, undefined, "eds"));
    expect(checkRun(cell({ kind: "none", why: "a test" }), run).facts.propagation).toEqual(propagationOf(run, 1000));
  });

  it("holds a prediction of no failure only when each request succeeds", () => {
    const none = cell({ kind: "none", why: "a test" });
    expect(checkRun(none, runWith([request(2000, "ok")])).ok).toBe(true);
    const failed = checkRun(none, runWith([request(2000, "refused")]));
    expect(failed.ok).toBe(false);
    expect(failed.why).toMatch(/1 requests failed/);
  });

  it("holds the failures of a window between the stop of the intake and the end of the propagation", () => {
    const window = cell({
      kind: "window",
      nodes: "all",
      start: { from: "intake", band: b(0, 1) },
      end: { from: "deletion", band: b(0, 2.5) },
      certain: false,
      why: "a test",
    });
    expect(checkRun(window, runWith([request(3010, "refused"), request(3400, "reset")])).ok).toBe(true);
    // a refusal before the intake stopped, or after the end of the window, is a finding
    expect(checkRun(window, runWith([request(2500, "refused")])).ok).toBe(false);
    expect(checkRun(window, runWith([request(3700, "refused")])).ok).toBe(false);
  });

  it("holds a timeout outside the window on a port that a reset closed, inside the life of the CLOSE entry", () => {
    const reuse = cell({
      kind: "window",
      nodes: "all",
      start: { from: "intake", band: b(0, 1) },
      end: { from: "deletion", band: b(0, 2.5) },
      certain: false,
      afterReset: { life: s(10), outcome: "timeout" },
      why: "a test",
    });
    const on = (t: number, o: string, lp: number, d = 1, p = "client-w1"): Line => ({ ev: "req", t, d, o, p, n: "w1", lp });
    // the reset ends at 3011 ms, and the same client sends a SYN from the same port 6.8 s later
    const reused = checkRun(reuse, runWith([on(3010, "reset", 51794), on(9810, "timeout", 51794, 2000)]));
    expect([reused.ok, reused.why]).toEqual([true, "1 failed requests in the window (span 0 s), and 1 on a port that a reset closed"]);
    // after the life of the entry, on another port, from another client, or as another outcome: a finding
    expect(checkRun(reuse, runWith([on(3010, "reset", 51794), on(13_200, "timeout", 51794, 2000)])).ok).toBe(false);
    expect(checkRun(reuse, runWith([on(3010, "reset", 51794), on(9810, "timeout", 51796, 2000)])).ok).toBe(false);
    expect(checkRun(reuse, runWith([on(3010, "reset", 51794), on(9810, "timeout", 51794, 2000, "client-w2")])).ok).toBe(false);
    expect(checkRun(reuse, runWith([on(3010, "reset", 51794), on(9810, "refused", 51794)])).ok).toBe(false);
    // a window without the rule does not hold the reuse
    const plain = cell({ ...reuse.prediction, afterReset: undefined } as Prediction);
    expect(checkRun(plain, runWith([on(3010, "reset", 51794), on(9810, "timeout", 51794, 2000)])).ok).toBe(false);
  });

  it("holds a window on the paused node only, with its end after the resume", () => {
    const paused = cell({
      kind: "window",
      nodes: "paused",
      start: { from: "intake", band: b(0, 5) },
      end: { from: "resume", band: b(0.05, 0.4) },
      certain: true,
      why: "a test",
    });
    const acts = { resume: 5500 };
    expect(checkRun(paused, runWith([request(3020, "refused"), request(5600, "refused")], acts)).ok).toBe(true);
    // the last failure long before the resume: the node synced early
    expect(checkRun(paused, runWith([request(3020, "refused")], acts)).ok).toBe(false);
    // a failure on a node that did not pause
    expect(checkRun(paused, runWith([request(3020, "refused"), request(5600, "refused"), request(4000, "refused", "w2")], acts)).ok).toBe(false);
    // a certain window with no failure
    expect(checkRun(paused, runWith([], acts)).ok).toBe(false);
  });

  it("times the empty Service from the fault, in the EndpointSlice and in the rules of each node", () => {
    const removal = cell({ kind: "removal", band: b(28, 49), why: "a test" });
    const lines: Line[] = [
      { ev: "slice", t: 40_000, type: "MODIFIED", name: "lab-x", svc: "lab", eps: [{ ip: TARGET.ip, r: false }, { ip: OTHER.ip, r: false }] },
      { ev: "rules", t: 40_200, prev: 40_150, node: "w1", b: [] },
      { ev: "rules", t: 40_100, prev: 40_050, node: "w2", b: [] },
    ];
    const run = { ...runWith([]), lines: lines.map((line) => line), acts: { fault: 5000, heal: 60_000, resume: null } };
    const check = checkRun(removal, run);
    expect(check).toMatchObject({ ok: true, value: s(35), facts: { sliceEmpty: s(35), rules: { w1: s(35.2), w2: s(35.1) } } });
    const late = { ...run, acts: { ...run.acts, fault: -20_000 } };
    expect(checkRun(removal, late).ok).toBe(false);
  });

  it("holds the failed requests of an empty Service to its window, from the fault to the heal", () => {
    const window = { kind: "window", nodes: "all", start: { from: "fault", band: b(0, 0.02) }, end: { from: "heal", band: b(0, 9) }, certain: true, why: "a test" } as const;
    const removal = cell({ kind: "removal", band: b(12, 26.105), window, why: "a test" });
    const lines: Line[] = [
      { ev: "slice", t: 20_000, type: "MODIFIED", name: "lab-x", svc: "lab", eps: [{ ip: TARGET.ip, r: false }, { ip: OTHER.ip, r: false }] },
      { ev: "rules", t: 20_200, prev: 20_150, node: "w1", b: [] },
      { ev: "rules", t: 20_100, prev: 20_050, node: "w2", b: [] },
    ];
    const run = (extra: Line[]): KindRun => ({ ...runWith([]), lines: [...lines, ...extra], acts: { fault: 5000, heal: 32_000, resume: null } });
    const check = checkRun(removal, run([request(6000, "timeout"), request(21_000, "refused"), request(38_000, "503")]));
    expect(check).toMatchObject({ ok: true, value: s(15), facts: { sliceEmpty: s(15), failures: 3 } });
    expect(check.why).toBe("the Service was empty at 15 s; 3 failed requests, all in the window (span 32 s)");
    // a failure before the fault or long after the heal is outside the window
    expect(checkRun(removal, run([request(4000, "timeout"), request(21_000, "refused")])).ok).toBe(false);
    expect(checkRun(removal, run([request(21_000, "refused"), request(42_000, "refused")])).ok).toBe(false);
    expect(predictionText(removal.prediction)).toBe("Service empty in [12, 26.105] s; failures only from the fault + [0, 0.02] s to the heal + [0, 9] s, at least one");
  });

  it("holds a flapping dependency to the empty Service and the window of each cycle, and to its return before the next fault", () => {
    const window = { kind: "window", nodes: "all", start: { from: "fault", band: b(0, 0.02) }, end: { from: "heal", band: b(-2, 9) }, certain: true, flaps: true, why: "a test" } as const;
    const removal = cell({ kind: "removal", band: b(12, 26.105), window, flaps: true, why: "a test" });
    // three cycles of 27 s, 15 s apart: each one 42 s after the one before it
    const cycles = [0, 1, 2].map((k) => ({ fault: 5000 + k * 42_000, heal: 32_000 + k * 42_000 }));
    const empty = (at: number): Line[] => [
      { ev: "slice", t: at, type: "MODIFIED", name: "lab-x", svc: "lab", eps: [{ ip: TARGET.ip, r: false }, { ip: OTHER.ip, r: false }] },
      { ev: "rules", t: at + 200, prev: at + 150, node: "w1", b: [] },
      { ev: "rules", t: at + 100, prev: at + 50, node: "w2", b: [] },
    ];
    const ready = (at: number): Line[] => [
      { ev: "slice", t: at, type: "MODIFIED", name: "lab-x", svc: "lab", eps: [{ ip: TARGET.ip, r: true }, { ip: OTHER.ip, r: true }] },
      { ev: "rules", t: at + 200, prev: at + 150, node: "w1", b: [`${TARGET.ip}:8080`] },
      { ev: "rules", t: at + 100, prev: at + 50, node: "w2", b: [`${TARGET.ip}:8080`] },
    ];
    const failures = (k: number): Line[] => [request(6000 + k * 42_000, "timeout"), request(21_000 + k * 42_000, "refused"), request(33_000 + k * 42_000, "refused")];
    const run = (lines: Line[]): KindRun => ({ ...runWith([]), end: 140_000, lines, acts: { fault: cycles[0]!.fault, heal: cycles[2]!.heal, resume: null, cycles } });
    const all = [0, 1, 2].flatMap((k) => [...empty(20_000 + k * 42_000), ...ready(36_000 + k * 42_000)]);
    const each = [0, 1, 2].flatMap(failures);
    const check = checkRun(removal, run([...all, ...each]));
    expect(check).toMatchObject({ ok: true, value: s(15), facts: { sliceEmpty: s(15), failures: 9, cycles: [0, 1, 2].map(() => ({ empty: s(15), ready: s(4) })) } });
    expect(check.why).toBe("the Service was empty in each of 3 cycles, at 15 s, 15 s, 15 s after its fault; 9 failed requests, all in the windows of 3 cycles (span 111 s)");
    // a failure in a rest is outside each window
    expect(checkRun(removal, run([...all, ...each, request(44_000, "refused")])).why).toMatch(/^1 failed requests outside the window of each cycle: 1 \[-0.1, 36.1\] s/);
    // a cycle with no failure, or whose last failure comes long before its heal
    expect(checkRun(removal, run([...all, ...failures(0), ...failures(2)])).why).toContain("no request failed in the window of the cycle 2");
    expect(checkRun(removal, run([...all, ...failures(0), ...failures(1).slice(0, 2), ...failures(2)])).why).toContain("the last failed request of the cycle 2 started 8.65 s before its window can end");
    // the Service did not come back after the first heal: the second cycle starts empty
    const stuck = [...empty(20_000), ...empty(104_000), ...ready(120_000)];
    expect(checkRun(removal, run([...stuck, ...each])).why).toContain("the Service had no ready endpoint at the fault of the cycle 2");
    // the Service empties late in the third cycle
    const late = [0, 1].flatMap((k) => [...empty(20_000 + k * 42_000), ...ready(36_000 + k * 42_000)]).concat(empty(116_000), ready(120_000));
    expect(checkRun(removal, run([...late, ...each])).why).toContain("the EndpointSlice had no ready endpoint at 27 s in the cycle 3");
    expect(predictionText(removal.prediction)).toBe(
      "Service empty in [12, 26.105] s after each fault, and ready again before the next; failures only from the fault + [0, 0.02] s to the heal + [-2, 9] s, in each cycle, at least one",
    );
  });

  it("refuses a window with flaps on a reference that a cycle does not have, and a run with no cycle", () => {
    const window = cell({ kind: "window", nodes: "all", start: { from: "deletion", band: b(0, 1) }, end: { from: "heal", band: b(0, 9) }, certain: true, flaps: true, why: "a test" });
    expect(checkRun(window, runWith([], { fault: 5000, heal: 32_000 })).why).toBe("a window with flaps has no each, and its references are the fault and the heal");
    const fault = cell({ kind: "window", nodes: "all", start: { from: "fault", band: b(0, 1) }, end: { from: "heal", band: b(0, 9) }, certain: true, flaps: true, why: "a test" });
    expect(checkRun(fault, runWith([], { fault: 5000 })).why).toBe("the run has no cycle of a fault and its heal");
  });

  it("times the departure of the target from the fault, and with a window it holds the failed requests to that window too", () => {
    const window = { kind: "window", nodes: "all", start: { from: "fault", band: b(8, 18.16) }, end: { from: "fault", band: b(8, 20.24) }, certain: true, outcomes: ["503"], why: "a test" } as const;
    const leaves = cell({ kind: "leaves", band: b(12, 24.105), window, why: "a test" });
    const lines: Line[] = [
      { ev: "slice", t: 20_000, type: "MODIFIED", name: "lab-x", svc: "lab", eps: [{ ip: TARGET.ip, r: false }, { ip: OTHER.ip, r: true }] },
      { ev: "rules", t: 20_200, prev: 20_150, node: "w1", b: ["10.244.2.4:8080"] },
      { ev: "rules", t: 20_100, prev: 20_050, node: "w2", b: ["10.244.2.4:8080"] },
    ];
    const run = (extra: Line[]): KindRun => ({ ...runWith([]), lines: [...lines, ...extra], acts: { fault: 5000, heal: 35_000, resume: null } });
    const check = checkRun(leaves, run([request(6000, "ok"), request(13_000, "503"), request(14_000, "503")]));
    expect(check).toMatchObject({ ok: true, value: s(15), facts: { left: s(15), failures: 2 } });
    expect(check.why).toBe("lab-a left at 15 s; 2 failed requests, all in the window (span 1 s)");
    // a refusal before the latch can trip, or another outcome, is a finding of the window
    expect(checkRun(leaves, run([request(6000, "503")])).ok).toBe(false);
    expect(checkRun(leaves, run([request(13_000, "timeout")])).ok).toBe(false);
    // a certain window with no failure, and the same departure without a window holds
    expect(checkRun(leaves, run([])).ok).toBe(false);
    expect(checkRun(cell({ kind: "leaves", band: b(12, 24.105), why: "a test" }), run([])).ok).toBe(true);
    expect(predictionText(leaves.prediction)).toBe("the replica leaves in [12, 24.105] s; failures only from the fault + [8, 18.16] s to the fault + [8, 20.24] s, at least one, each one 503");
  });

  it("times the departure of the target in a zone loss by the rules of each node but the frozen node of the lost zone", () => {
    const both = [`${TARGET.ip}:8080`, `${OTHER.ip}:8080`];
    const lines: Line[] = [
      { ev: "rules", t: 4000, prev: 3950, node: "w1", b: both },
      { ev: "rules", t: 4000, prev: 3950, node: "w2", b: both },
      { ev: "slice", t: 50_000, type: "MODIFIED", name: "lab-x", svc: "lab", eps: [{ ip: TARGET.ip, r: false }, { ip: OTHER.ip, r: true }] },
      { ev: "rules", t: 50_200, prev: 50_150, node: "w2", b: [`${OTHER.ip}:8080`] },
    ];
    // the paused node w1 is the node of the lost zone: its kube-proxy is frozen, and its rules keep the target
    const run: KindRun = { ...runWith([]), lines, acts: { fault: 5000, heal: 75_000, resume: null } };
    const prediction: Prediction = { kind: "leaves", band: b(39.6, 55.65), why: "a test" };
    const zone: KindCell = { ...cellOf("zone-loss"), prediction };
    expect(checkRun(zone, run)).toMatchObject({ ok: true, value: s(45), facts: { left: s(45) } });
    // each other trigger counts the rules of each node
    expect(checkRun(cell(prediction), run).why).toBe("the rules of w1 kept lab-a");
  });

  it("keeps each replica in a slow dependency, and holds its failed requests to the window or to none", () => {
    const window = { kind: "window", nodes: "all", start: { from: "fault", band: b(0.96, 2.24) }, end: { from: "heal", band: b(-2.02, -1.74) }, certain: true, outcomes: ["timeout"], why: "a test" } as const;
    const slow: KindCell = { ...cellOf("latency"), prediction: { kind: "stays", failures: window, why: "a test" } };
    const run = (extra: Line[]): KindRun => ({ ...runWith([]), target: null, lines: [...runWith([]).lines, ...extra], acts: { fault: 5000, heal: 32_000, resume: null } });
    const check = checkRun(slow, run([request(7000, "timeout"), request(30_100, "timeout"), request(31_000, "ok")]));
    expect(check).toMatchObject({ ok: true, value: { value: 2, unit: "{request}" } });
    expect(check.why).toBe("the replicas stayed ready, 2 requests failed by their dependency; 2 failed requests, all in the window (span 23.1 s)");
    // a failure before the queue can reach the timeout, a 503, a failure after the heal, or a run with no failure
    expect(checkRun(slow, run([request(5500, "timeout"), request(30_100, "timeout")])).ok).toBe(false);
    expect(checkRun(slow, run([request(7000, "503"), request(30_100, "timeout")])).ok).toBe(false);
    expect(checkRun(slow, run([request(7000, "timeout"), request(30_500, "timeout")])).ok).toBe(false);
    expect(checkRun(slow, run([])).ok).toBe(false);
    // a replica that leaves the EndpointSlice fails the run, with no failed request too
    const left: Line = { ev: "slice", t: 20_000, type: "MODIFIED", name: "lab-x", svc: "lab", eps: [{ ip: TARGET.ip, r: false }, { ip: OTHER.ip, r: true }] };
    expect(checkRun(slow, run([left, request(7000, "timeout"), request(30_100, "timeout")])).why).toBe("1 replicas left the EndpointSlice");
    // with none, each failed request fails the run
    const none: KindCell = { ...slow, prediction: { kind: "stays", failures: { kind: "none", why: "a test" }, why: "a test" } };
    expect(checkRun(none, run([])).ok).toBe(true);
    expect(checkRun(none, run([request(7000, "timeout")])).why).toBe('1 requests failed: {"timeout":1}');
    expect(predictionText(slow.prediction)).toBe("stays ready, no refusal; failures only from the fault + [0.96, 2.24] s to the heal + [-2.02, -1.74] s, at least one, each one timeout");
    expect(predictionText(none.prediction)).toBe("stays ready, no refusal; no failure");
    // the run observes until the window can close: its end after the heal, the timeout and δ
    expect(observationAfter(slow)).not.toBeNull();
  });

  it("decides a cell on its counted runs: a disagreeing run fails it, and a warm-up does not count", () => {
    const none = cell({ kind: "none", why: "a test" });
    const good = runWith([request(2000, "ok")]);
    const bad = { ...runWith([request(2000, "refused")]), warmup: true };
    expect(judgeKind(none, [bad, good, good]).decision).toBe("holds");
    expect(judgeKind(none, [good, { ...bad, warmup: false }]).decision).toBe("fails");
    expect(judgeKind(none, [{ ...good, void: "not at rest" }]).decision).toBe("void");
    expect(judgeKind({ ...none, calibrates: true }, [good]).decision).toBe("calibration");
  });

  it("extends a cell whose request failed after the calibrated band, but before the rules of its node dropped the target", () => {
    const window = cell({
      kind: "window",
      nodes: "all",
      start: { from: "intake", band: b(0, 1) },
      end: { from: "deletion", band: b(0, 2.5) },
      certain: false,
      why: "a test",
    });
    // the rules of w1 keep the target until 4000 ms, after the end of the window at 3500 ms
    const slow = (extra: Line[]): KindRun => {
      const run = runWith(extra);
      const lines = run.lines.filter((line) => !(line.ev === "rules" && line["node"] === "w1"));
      return {
        ...run,
        lines: [
          ...lines,
          { ev: "rules", t: 1100, prev: 1050, node: "w1", b: [`${TARGET.ip}:8080`, "10.244.2.4:8080"] },
          { ev: "rules", t: 4000, prev: 3900, node: "w1", b: ["10.244.2.4:8080"] },
        ],
      };
    };
    const tail = checkRun(window, slow([request(3010, "refused"), request(3700, "refused")]));
    expect(tail).toMatchObject({ ok: true, tail: "1 failed requests after the window, the last 0.2 s after it on w1, before the rules of w1 dropped the target" });
    expect(judgeKind(window, [slow([request(3010, "refused")]), slow([request(3700, "refused")])])).toMatchObject({
      decision: "extend",
      why: "1 of 2 runs are past the calibrated band, the first: 1 failed requests after the window, the last 0.2 s after it on w1, before the rules of w1 dropped the target",
    });
    // after the drop, or on a node whose rules dropped the target in the band, the request is still late
    expect(checkRun(window, slow([request(4200, "refused")])).ok).toBe(false);
    expect(checkRun(window, slow([request(3700, "refused", "w2")])).ok).toBe(false);
    // a run that disagrees still fails the cell
    expect(judgeKind(window, [slow([request(3700, "refused")]), slow([request(4200, "refused")])]).decision).toBe("fails");
  });

  describe("a window for each deleted replica", () => {
    const window = {
      kind: "window",
      nodes: "all",
      start: { from: "intake", band: b(0, 0.3) },
      end: { from: "deletion", band: b(1, 1.5) },
      certain: false,
      why: "a test",
    } as const;
    const each = cell({ ...window, each: true });
    const NEW = "10.244.3.5:8080";
    const deleted = (t: number, replica: typeof TARGET): Line => ({
      ev: "pod", t, type: "MODIFIED", name: replica.pod, node: replica.node, ip: replica.ip, del: true, ready: false, phase: "Running", cs: [], labels: {},
    });
    /** a rolling update: lab-a goes at 1000 ms and stops at 1050 ms, lab-b goes at 8000 ms and stops at 8040 ms */
    const rolling = (extra: Line[], w1 = 8100): KindRun => ({
      ...runWith([]),
      lines: [
        { ev: "rules", t: 900, prev: 850, node: "w1", b: [`${TARGET.ip}:8080`, `${OTHER.ip}:8080`, NEW] },
        deleted(1000, TARGET),
        { ev: "stopping", t: 1050, p: "lab-a" },
        { ev: "rules", t: 1100, prev: 1050, node: "w1", b: [`${OTHER.ip}:8080`, NEW] },
        deleted(8000, OTHER),
        { ev: "stopping", t: 8040, p: "lab-b" },
        { ev: "rules", t: 8100, prev: 8050, node: "w2", b: [NEW] },
        { ev: "rules", t: w1, prev: w1 - 50, node: "w1", b: [NEW] },
        ...extra,
      ],
    });

    it("holds a failure in the window of each replica, from its own intake to its own deletion", () => {
      const check = checkRun(each, rolling([request(1500, "refused"), request(8500, "refused")]));
      expect([check.ok, check.why]).toEqual([true, "2 failed requests, all in the windows of 2 deleted replicas (span 7 s)"]);
      expect(check.facts.deletions).toEqual([
        { pod: "lab-a", intake: 1050, deletion: 1000 },
        { pod: "lab-b", intake: 8040, deletion: 8000 },
      ]);
      expect(judgeKind(each, [rolling([request(1500, "refused")]), rolling([request(8500, "refused")])]).decision).toBe("holds");
      // the window of the target alone does not hold the failure of the second replica, and its facts have no deletions
      const target = checkRun(cell(window), rolling([request(1500, "refused"), request(8500, "refused")]));
      expect(target.ok).toBe(false);
      expect(target.facts).not.toHaveProperty("deletions");
    });

    it("fails a failure between the windows, and a run with no deletion", () => {
      const between = checkRun(each, rolling([request(5000, "refused")]));
      expect([between.ok, between.why]).toEqual([
        false,
        "1 failed requests outside the window of each deleted replica: lab-a [-0.1, 1.55] s, lab-b [-0.1, 1.56] s after its intake",
      ]);
      expect(judgeKind(each, [rolling([request(1500, "refused")]), rolling([request(5000, "refused")])]).decision).toBe("fails");
      const none = { ...rolling([]), lines: rolling([]).lines.filter((line) => line.ev !== "pod") };
      expect(checkRun(each, none)).toMatchObject({ ok: false, why: "no replica of the run got a deletion" });
      // a deleted replica with no intake has no window
      const silent = { ...rolling([]), lines: rolling([]).lines.filter((line) => !(line.ev === "stopping" && line["p"] === "lab-b")) };
      expect(checkRun(each, silent)).toMatchObject({ ok: false, why: "the run has no intake reference for lab-b" });
    });

    it("extends a cell whose request failed after a window, before the rules of its node dropped the replica of that window", () => {
      // the rules of w1 keep lab-b until 10 000 ms, after the end of its window at 9600 ms
      const slow = rolling([request(9800, "refused")], 10_000);
      expect(checkRun(each, slow)).toMatchObject({
        ok: true,
        tail: "1 failed requests after a window, the last 0.3 s after the window of lab-b on w1, before the rules of w1 dropped lab-b",
      });
      expect(judgeKind(each, [slow]).decision).toBe("extend");
      // after the drop, the request is late
      expect(checkRun(each, rolling([request(9800, "refused")])).ok).toBe(false);
    });

    it("writes the window of each deleted replica in the short form of a prediction", () => {
      expect(predictionText(each.prediction)).toBe("failures only from the intake + [0, 0.3] s to the deletion + [1, 1.5] s, of each deleted replica");
      expect(predictionText(window)).toBe("failures only from the intake + [0, 0.3] s to the deletion + [1, 1.5] s");
      expect(predictionText({ ...window, each: true, propagation: b(0, 0.5) })).toBe(
        "failures only from the intake + [0, 0.3] s to the deletion + [1, 1.5] s, of each deleted replica, the rules drop the replica in [0, 0.5] s",
      );
    });

    it("extends a cell whose rules dropped the replica of a window after the propagation of its prediction", () => {
      const bounded = cell({ ...window, each: true, propagation: b(0, 0.5) });
      // w2 drops lab-a 80 ms after its deletion, and w1 drops lab-b 0.1 s after its deletion, or 0.9 s
      const w2 = { ev: "rules", t: 1080, prev: 1030, node: "w2", b: [`${OTHER.ip}:8080`, NEW] };
      const fast = checkRun(bounded, rolling([w2, request(1500, "refused")]));
      expect(fast.ok).toBe(true);
      expect(fast).not.toHaveProperty("tail");
      const slow = rolling([w2, request(1500, "refused")], 8900);
      expect(checkRun(bounded, slow)).toMatchObject({
        ok: true,
        tail: "1 drops after the propagation of 0.5 s at the most, the latest: the rules of w1 dropped lab-b 0.9 s after its deletion",
      });
      expect(judgeKind(bounded, [rolling([w2]), slow])).toMatchObject({ decision: "extend", failed: 0 });
      // without the band, the judge does not test the propagation
      expect(checkRun(each, slow)).not.toHaveProperty("tail");
      // a node that keeps the replica past the band, to the end of the run
      const kept = { ...slow, lines: slow.lines.filter((line) => !(line.ev === "rules" && line["node"] === "w1" && line.t === 8900)) };
      expect(checkRun(bounded, kept).tail).toBe("1 drops after the propagation of 0.5 s at the most, the latest: the rules of w1 kept lab-b to the end of the run");
      // a run that ends in the band says nothing of the node
      expect(checkRun(bounded, { ...kept, end: 8550 })).not.toHaveProperty("tail");
      // a request outside each window still fails the run
      expect(checkRun(bounded, rolling([w2, request(5000, "refused")], 8900)).ok).toBe(false);
    });
  });

  it("tells both a late request and a late drop of the target", () => {
    const window = cell({
      kind: "window",
      nodes: "all",
      start: { from: "intake", band: b(0, 1) },
      end: { from: "deletion", band: b(0, 2.5) },
      certain: false,
      propagation: b(0, 1),
      why: "a test",
    });
    // the rules of w1 keep the target until 4000 ms: 3 s after its deletion, and after the end of the window
    const run = runWith([request(3700, "refused"), { ev: "rules", t: 4000, prev: 3900, node: "w1", b: ["10.244.2.4:8080"] }]);
    const lines = run.lines.filter((line) => !(line.ev === "rules" && line["node"] === "w1" && line.t === 1100));
    expect(checkRun(window, { ...run, lines: [...lines, { ev: "rules", t: 1100, prev: 1050, node: "w1", b: [`${TARGET.ip}:8080`, "10.244.2.4:8080"] }] }).tail).toBe(
      "1 failed requests after the window, the last 0.2 s after it on w1, before the rules of w1 dropped the target; 1 drops after the propagation of 1 s at the most, the latest: the rules of w1 dropped the target 3 s after its deletion",
    );
  });
});

describe("the observation of a kind run", () => {
  const window = {
    kind: "window",
    nodes: "all",
    start: { from: "intake", band: b(0, 1) },
    end: { from: "deletion", band: b(0, 2.5) },
    certain: false,
    why: "a test",
  } as const;
  const deleted = (t: number, replica: typeof TARGET): Line => ({
    ev: "pod", t, type: "MODIFIED", name: replica.pod, node: replica.node, ip: replica.ip, del: true, ready: false, phase: "Running", cs: [], labels: {},
  });

  it("lasts until a request that starts at the end of the window ends: the end of its band, the timeout and δ", () => {
    // the deletion at 1000 ms, the window to 2.5 s after it, and the timeout of 1 s of the workload
    expect(observationAfter(cell(window))).toEqual(s(3.6));
    expect(observationEnd(cell(window), runWith([]))).toBe(1000 + 2500 + 1000 + 100);
    // a timeout of 2 s, as in T07
    expect(observationEnd({ ...cell(window), workload: { every: { value: 20, unit: "ms" }, timeout: s(2) } }, runWith([]))).toBe(5600);
  });

  it("counts from the end reference of each deleted replica with `each`, and from the latest one", () => {
    const run = { ...runWith([]), lines: [deleted(1000, TARGET), deleted(8000, OTHER)] };
    expect(observationEnd(cell({ ...window, each: true }), run)).toBe(8000 + 3600);
    // without `each`, only the target counts
    expect(observationEnd(cell(window), run)).toBe(1000 + 3600);
    // a pause counts from its resume
    expect(observationEnd(cell({ ...window, end: { from: "resume", band: b(0, 120) } }), runWith([], { resume: 9000 }))).toBeCloseTo(9000 + 120_000 + 1100, 6);
  });

  it("sets no time for another prediction, a window with no end, or a run that has no end reference yet", () => {
    expect(observationAfter(cell({ kind: "none", why: "a test" }))).toBeNull();
    expect(observationEnd(cell({ kind: "none", why: "a test" }), runWith([]))).toBeNull();
    expect(observationEnd(cell({ ...window, end: null }), runWith([]))).toBeNull();
    expect(observationEnd(cell(window), { ...runWith([]), lines: [] })).toBeNull();
    expect(observationEnd(cell({ ...window, end: { from: "resume", band: b(0, 1) } }), runWith([]))).toBeNull();
  });

  it("counts a window of a policy from its heal", () => {
    const policy = cell({ ...window, start: { from: "fault", band: b(0.1, 2) }, end: { from: "heal", band: b(0.1, 2) } });
    expect(observationEnd(policy, runWith([], { fault: 5000, heal: 20_000 }))).toBe(20_000 + 2000 + 1000 + 100);
    expect(observationEnd(policy, runWith([], { fault: 5000 }))).toBeNull();
  });
});

describe("the judgement of a policy of Istio", () => {
  const FAULT = 5000;
  const HEAL = 20_000;
  // the LDS lines of a server sidecar: the first line of its poller, an update after the policy, and one after its delete
  const lds = (pod: string, apply: number, remove: number): Line[] => [
    { ev: "lds", t: 4000, prev: null, node: pod === "lab-a" ? "w1" : "w2", pod, mod: 3, inPlace: 1 },
    { ev: "lds", t: apply, prev: apply - 50, node: pod === "lab-a" ? "w1" : "w2", pod, mod: 4, inPlace: 2 },
    { ev: "lds", t: remove, prev: remove - 50, node: pod === "lab-a" ? "w1" : "w2", pod, mod: 5, inPlace: 3 },
  ];
  const policyRun = (extra: Line[], remove = 20_600): KindRun => ({
    ...runWith([], { fault: FAULT, heal: HEAL }),
    lines: [...lds("lab-a", 5300, 20_400), ...lds("lab-b", 5500, remove), ...extra],
  });
  const policy: KindCell = {
    ...cellOf("authorization-policy"),
    template: "T15",
    stack: "grpc",
    mesh: { flavor: "sidecar", mode: "sidecar" },
    trigger: { kind: "authorization-policy", hold: s(15) },
    prediction: {
      kind: "window",
      nodes: "all",
      start: { from: "fault", band: b(0.1, 2) },
      end: { from: "heal", band: b(0.1, 1.9) },
      certain: true,
      outcomes: ["denied"],
      propagation: b(0.1, 1.5),
      why: "a test",
    },
  };

  it("gives the first LDS update of each server sidecar after the policy and after its delete, and not the first line of a poller", () => {
    const run = policyRun([]);
    expect(updatesOf(run, FAULT)).toEqual({ "lab-a": { after: s(0.25), by: s(0.3) }, "lab-b": { after: s(0.45), by: s(0.5) } });
    expect(updatesOf(run, HEAL)).toEqual({ "lab-a": { after: s(0.35), by: s(0.4) }, "lab-b": { after: s(0.55), by: s(0.6) } });
    // a poller that starts again gives a first line with no poll before it: no update
    const restarted = { ...run, lines: [...run.lines.filter((line) => line["pod"] !== "lab-b" || line.t === 4000), { ev: "lds", t: 6000, prev: null, node: "w2", pod: "lab-b", mod: 4, inPlace: 2 }] };
    expect(updatesOf(restarted, FAULT)["lab-b"]).toBeNull();
    expect(updatesOf(run, null)).toEqual({});
    expect(checkRun(policy, run).facts).toMatchObject({ updates: updatesOf(run, FAULT), healUpdates: updatesOf(run, HEAL) });
  });

  it("holds the denials from the update after the policy to the update after its delete, and only denials", () => {
    const denials = [request(5310, "denied"), request(5400, "denied", "w2"), request(20_500, "denied")];
    const held = checkRun(policy, policyRun(denials));
    expect(held.ok, held.why).toBe(true);
    expect(held.tail).toBeUndefined();
    // a timeout in the window is not a denial
    const timeout = checkRun(policy, policyRun([...denials, request(9000, "timeout")]));
    expect(timeout.ok).toBe(false);
    expect(timeout.why).toMatch(/1 failed requests in the window ended \{"timeout":1\}, not denied/);
    // no denial at all: the policy did not reach the sidecars in the hold
    expect(checkRun(policy, policyRun([])).why).toMatch(/no request failed/);
    // a denial before the policy can reach a sidecar
    expect(checkRun(policy, policyRun([request(4800, "denied"), ...denials])).ok).toBe(false);
    expect(predictionText(policy.prediction)).toContain("each one denied");
  });

  it("extends a policy whose LDS update after the delete is past the band, and keeps its later denials in the tail", () => {
    // the sidecar of lab-b takes the delete 2 s after it: past 1.5 s, and its denials go on until then
    const run = policyRun([request(5310, "denied"), request(21_990, "denied"), request(22_100, "denied", "w2")], 22_000);
    const check = checkRun(policy, run);
    expect(check.ok, check.why).toBe(true);
    expect(check.tail).toMatch(/1 failed requests after the window/);
    expect(check.tail).toMatch(/1 LDS updates after the propagation of 1\.5 s at the most, the latest: the sidecar of lab-b had its LDS update 2 s after the delete of the policy/);
    expect(judgeKind(policy, [run]).decision).toBe("extend");
    // a denial after that update and the next call is late
    expect(checkRun(policy, policyRun([request(5310, "denied"), request(22_500, "denied")], 22_000)).ok).toBe(false);
  });
});

describe("the judgement of the end of the sockets of the clients", () => {
  const FAULT = 5000;
  const HEAL = 50_000;
  /** a call of the client of a node on the local port `lp` */
  const call = (t: number, o: string, n: string, lp: number | null): Line => ({ ev: "req", t, d: 1, o, p: `client-${n}`, n, lp });
  const close = (t: number, n: string, lp: number | null, err: string | null = null): Line => ({ ev: "sock", what: "close", t, p: `client-${n}`, n, lp, err });
  const connect = (t: number, n: string, lp: number): Line => ({ ev: "sock", what: "connect", t, p: `client-${n}`, n, lp });
  const before = [call(4900, "ok", "w1", 40_001), call(4910, "ok", "w2", 40_002)];
  const runOf = (extra: Line[], acts: Partial<KindRun["acts"]> = { fault: FAULT, heal: HEAL }): KindRun => ({ ...runWith([], acts), lines: [...before, ...extra] });
  const window = {
    kind: "window",
    nodes: "all",
    start: { from: "fault", band: b(0, 0.03) },
    end: { from: "heal", band: b(-2, 4.1) },
    certain: true,
    outcomes: ["timeout", "error", "reset"],
    why: "a window",
  } as const;
  const T07 = { every: { value: 20, unit: "ms" }, timeout: s(2) };
  const hole: KindCell = {
    ...cellOf("blackhole"),
    template: "T15",
    stack: "grpc",
    mesh: { flavor: "ambient", mode: "ambient" },
    workload: T07,
    trigger: { kind: "blackhole", hold: s(45) },
    prediction: { kind: "ends", from: "fault", band: b(20, 30.03), window, why: "a test" },
  };
  const gap: KindCell = { ...hole, trigger: { kind: "idle", hold: s(30) }, prediction: { kind: "ends", from: "fault", band: null, why: "a test" } };
  const failures = [call(5010, "timeout", "w1", 40_001), call(5020, "timeout", "w2", 40_002), call(30_500, "error", "w1", 40_001), call(48_100, "timeout", "w2", 40_010)];
  const ends = [close(30_000, "w1", 40_001), close(31_000, "w2", 40_002, "ECONNRESET"), connect(30_010, "w1", 40_010), close(40_020, "w1", 40_010)];

  it("holds a black hole whose sockets end in the band, on the ports of the last answers, with the failures in the window", () => {
    const check = checkRun(hole, runOf([...failures, ...ends]));
    expect(check.ok, check.why).toBe(true);
    expect(check.value).toEqual({ value: 25.5, unit: "s" });
    expect(check.facts.closes).toEqual({ "client-w1": s(25), "client-w2": s(26) });
    expect(check.why).toMatch(/the socket of each of 2 clients ended, at 25, 26 s/);
  });

  it("fails a black hole whose socket ends out of the band, does not end, or is not the socket of the last answer", () => {
    const early = checkRun(hole, runOf([...failures, close(12_000, "w1", 40_001), close(31_000, "w2", 40_002)]));
    expect(early.ok).toBe(false);
    expect(early.why).toMatch(/the socket of client-w1 ended at 7 s/);
    const none = checkRun(hole, runOf([...failures, close(31_000, "w2", 40_002)]));
    expect(none.why).toMatch(/the socket of client-w1 did not end/);
    expect(none.facts.closes).toEqual({ "client-w1": null, "client-w2": s(26) });
    const other = checkRun(hole, runOf([...failures, close(30_000, "w1", 40_077), close(31_000, "w2", 40_002)]));
    expect(other.why).toMatch(/the first socket of client-w1 to end had the port 40077, not the port 40001 of its last answer/);
  });

  it("fails a black hole whose failures do not agree with its window", () => {
    // a failure 3 s after the heal agrees, and one 5 s after it does not
    expect(checkRun(hole, runOf([...failures, call(53_000, "timeout", "w1", 40_010), ...ends])).ok).toBe(true);
    const late = checkRun(hole, runOf([...failures, call(55_000, "timeout", "w1", 40_010), ...ends]));
    expect(late.ok).toBe(false);
    // an outcome that the window does not permit
    expect(checkRun(hole, runOf([...failures, call(20_000, "denied", "w1", 40_001), ...ends])).ok).toBe(false);
    // no client had an answer before the fault
    expect(checkRun(hole, { ...runOf([...failures, ...ends]), lines: [...failures, ...ends] }).why).toMatch(/no client had an answer before the fault/);
  });

  it("holds a gap in which no socket ends, and after which each client calls again on its socket", () => {
    const resumed = [call(HEAL + 15, "ok", "w1", 40_001), call(HEAL + 18, "ok", "w2", 40_002)];
    const check = checkRun(gap, runOf(resumed));
    expect(check.ok, check.why).toBe(true);
    expect(check.value).toEqual({ value: 0, unit: "{socket}" });
    expect(check.facts.closes).toEqual({ "client-w1": null, "client-w2": null });
  });

  it("fails a gap in which a socket ends, or after which a client calls on another socket or fails", () => {
    const resumed = [call(HEAL + 15, "ok", "w1", 40_001), call(HEAL + 18, "ok", "w2", 40_002)];
    const closed = checkRun(gap, runOf([close(35_000, "w2", 40_002), ...resumed]));
    expect(closed.ok).toBe(false);
    expect(closed.why).toMatch(/the socket of client-w2 ended 30 s after the fault/);
    expect(closed.value).toEqual({ value: 1, unit: "{socket}" });
    const moved = checkRun(gap, runOf([call(HEAL + 15, "ok", "w1", 40_001), call(HEAL + 18, "ok", "w2", 40_099)]));
    expect(moved.why).toMatch(/the first call of client-w2 after the heal went on the port 40099, not 40002/);
    const failed = checkRun(gap, runOf([call(HEAL + 15, "ok", "w1", 40_001), call(HEAL + 18, "reset", "w2", 40_002)]));
    expect(failed.why).toMatch(/the first call of client-w2 after the heal ended reset/);
    expect(checkRun(gap, runOf([call(HEAL + 15, "ok", "w1", 40_001)])).why).toMatch(/client-w2 sent no call after the heal/);
  });

  it("observes until each socket can end and each request of the window ended", () => {
    const only: KindCell = { ...hole, prediction: { kind: "ends", from: "fault", band: b(20, 30.03), why: "a test" } };
    expect(observationEnd(only, runOf([]))).toBe(FAULT + 30_030 + 100);
    expect(observationAfter(hole)).toEqual(s(6.2));
    expect(observationEnd(hole, runOf([]))).toBe(HEAL + 4100 + 2000 + 100);
    expect(observationEnd(gap, runOf([]))).toBeNull();
  });

  it("counts the close of a restart of ztunnel from the first deletion of a ztunnel pod, with the calls in flight in the window", () => {
    const zpod = (t: number, name: string): Line => ({ ev: "ztunnel-pod", t, type: "MODIFIED", name, node: "w1", ip: null, del: true, cs: [] });
    const failed = { lo: s(28.98), hi: s(29.52) };
    const restart: KindCell = {
      ...hole,
      trigger: { kind: "ztunnel-restart" },
      prediction: {
        kind: "ends",
        from: "restart",
        band: b(29, 29.52),
        window: { kind: "window", nodes: "all", start: { from: "restart", band: failed }, end: { from: "restart", band: failed }, certain: false, outcomes: ["error", "reset"], why: "a window" },
        why: "a test",
      },
    };
    // the deletions at 6000 and 6010; each socket ends 29.2 s and 29.3 s after the first one, with a call in flight on w1
    const lines = [zpod(6000, "zt-1"), zpod(6010, "zt-2"), call(35_195, "error", "w1", 40_001), close(35_200, "w1", 40_001), close(35_300, "w2", 40_002)];
    const held = checkRun(restart, runOf(lines, { fault: 5800, heal: null }));
    expect(held.ok, held.why).toBe(true);
    expect(held.facts.closes).toEqual({ "client-w1": s(29.2), "client-w2": s(29.3) });
    // the same close 1 s later is out of the band: the side of the kill at the end of the grace
    const killed = checkRun(restart, runOf([zpod(6000, "zt-1"), close(36_200, "w1", 40_001), close(36_300, "w2", 40_002)], { fault: 5800, heal: null }));
    expect(killed.ok).toBe(false);
    expect(killed.why).toMatch(/the socket of client-w1 ended at 30.2 s/);
    // a run with no deletion of a ztunnel pod has no reference
    expect(checkRun(restart, runOf([close(35_200, "w1", 40_001)], { fault: 5800, heal: null })).why).toMatch(/the run has no restart reference/);
    expect(observationEnd(restart, runOf(lines, { fault: 5800, heal: null }))).toBe(6000 + 29_520 + 2000 + 100);
  });

  it("writes the prediction of a close and of a gap", () => {
    expect(predictionText(hole.prediction)).toMatch(/^the socket of each client ends in /);
    expect(predictionText(hole.prediction)).toContain("; ");
    expect(predictionText(gap.prediction)).toBe("no socket of a client ends, and each one calls again on its socket");
  });

  describe("the end of a tunnel of ztunnel", () => {
    const HEALED = 335_000;
    const release: KindCell = {
      ...hole,
      trigger: { kind: "idle", hold: s(330), close: true },
      prediction: { kind: "ends", from: "fault", of: "tunnel", band: b(300, 300.62), why: "a test" },
    };
    /** a call of a client that a replica answered */
    const answered = (t: number, o: string, n: string, pod: string, lp: number): Line => ({ ev: "req", t, d: 1, o, p: `client-${n}`, n, lp, b: pod });
    const opened = (t: number, n: string, lp: number, la: string): Line => ({ ev: "sock", what: "connect", t, p: `client-${n}`, n, lp, la });
    /** a change of the state of the HBONE socket of a client pod to a replica */
    const state = (t: number, la: string, ip: string, old: number, now: number): Line => ({ ev: "kernel.state", t, src: `${la}:51000`, dst: `${ip}:15008`, old, new: now, netns: 1 });
    const LA1 = "10.244.1.9";
    const LA2 = "10.244.2.9";
    // the new channel of each client at the fault, its calls to one replica, and the first call after the heal
    const lines = [
      opened(FAULT + 30, "w1", 41_001, LA1),
      opened(FAULT + 35, "w2", 41_002, LA2),
      answered(FAULT + 40, "ok", "w1", TARGET.pod, 41_001),
      answered(FAULT + 45, "ok", "w2", OTHER.pod, 41_002),
      answered(HEALED + 20, "ok", "w1", TARGET.pod, 41_101),
      answered(HEALED + 25, "ok", "w2", TARGET.pod, 41_102),
    ];
    const runOfTunnels = (extra: Line[]): KindRun => ({ ...runWith([], { fault: FAULT, heal: HEALED }), end: HEALED + 5000, lines: [...before, ...lines, ...extra] });

    it("holds a release whose side of the client ends each tunnel in the band, after which each client calls again", () => {
      const ends = [state(FAULT + 300_100, LA1, TARGET.ip, 1, 4), state(FAULT + 300_200, LA2, OTHER.ip, 1, 4)];
      const check = checkRun(release, runOfTunnels(ends));
      expect(check.ok, check.why).toBe(true);
      expect(check.value).toEqual({ value: 300.15, unit: "s" });
      expect(check.facts.closes).toEqual({ "client-w1": s(300.1), "client-w2": s(300.2) });
      expect(check.why).toMatch(/the side of the client ended the tunnel of each of 2 clients, at 300.1, 300.2 s/);
      expect(predictionText(release.prediction)).toMatch(/^the side of the client ends the tunnel of each client in /);
    });

    it("fails a tunnel that the peer closes first, that ends out of the band, or that does not end", () => {
      // the peer closed first: ESTABLISHED to CLOSE_WAIT
      const peer = checkRun(release, runOfTunnels([state(FAULT + 300_100, LA1, TARGET.ip, 1, 8), state(FAULT + 300_200, LA2, OTHER.ip, 1, 4)]));
      expect(peer.ok).toBe(false);
      expect(peer.why).toMatch(/the tunnel of client-w1 went from ESTABLISHED to the state 8, not FIN_WAIT1: the peer closed first/);
      // 5 s late: the release counted from the end of the stream
      const late = checkRun(release, runOfTunnels([state(FAULT + 305_000, LA1, TARGET.ip, 1, 4), state(FAULT + 300_200, LA2, OTHER.ip, 1, 4)]));
      expect(late.why).toMatch(/the tunnel of client-w1 ended at 305 s/);
      // the end of a tunnel to another replica is not the end of the tunnel of the client
      const other = checkRun(release, runOfTunnels([state(FAULT + 300_100, LA1, OTHER.ip, 1, 4), state(FAULT + 300_200, LA2, OTHER.ip, 1, 4)]));
      expect(other.why).toMatch(/the tunnel of client-w1 to lab-a did not end/);
      expect(other.facts.closes).toEqual({ "client-w1": null, "client-w2": s(300.2) });
    });

    it("holds a close of the peer in the band of its answer, and fails one before it", () => {
      const answering: KindCell = { ...release, prediction: { ...release.prediction, answer: b(300, 300.623) } as KindCell["prediction"] };
      // the peer answers the GOAWAY of the client with its own FIN, and that FIN comes first
      const answer = checkRun(answering, runOfTunnels([state(FAULT + 300_100, LA1, TARGET.ip, 1, 8), state(FAULT + 300_200, LA2, OTHER.ip, 1, 4)]));
      expect(answer.ok, answer.why).toBe(true);
      expect(answer.facts.closes).toEqual({ "client-w1": s(300.1), "client-w2": s(300.2) });
      expect(predictionText(answering.prediction)).toMatch(/, or the peer answers in the fault \+ /);
      // a close of the peer before the release is no answer: the peer closed first
      const early = checkRun(answering, runOfTunnels([state(FAULT + 290_000, LA1, TARGET.ip, 1, 8), state(FAULT + 300_200, LA2, OTHER.ip, 1, 4)]));
      expect(early.ok).toBe(false);
      expect(early.why).toMatch(/the peer closed the tunnel of client-w1 at 290 s, outside the band of its answer/);
      // the band of the answer does not let another state agree
      const other = checkRun(answering, runOfTunnels([state(FAULT + 300_100, LA1, TARGET.ip, 1, 7), state(FAULT + 300_200, LA2, OTHER.ip, 1, 4)]));
      expect(other.why).toMatch(/the tunnel of client-w1 went from ESTABLISHED to the state 7, not FIN_WAIT1/);
    });

    it("fails a run with no address of a client pod, or a failed call after the heal", () => {
      const ends = [state(FAULT + 300_100, LA1, TARGET.ip, 1, 4), state(FAULT + 300_200, LA2, OTHER.ip, 1, 4)];
      const noAddress = { ...runOfTunnels(ends), lines: [...before, ...lines.filter((line) => line.ev !== "sock"), ...ends] };
      expect(checkRun(release, noAddress).why).toMatch(/no socket of client-w1 gave the address of its pod/);
      const failed = checkRun(release, runOfTunnels([...ends, answered(HEALED + 10, "reset", "w2", TARGET.pod, 41_102)]));
      expect(failed.why).toMatch(/the first call of client-w2 after the heal ended reset/);
    });
  });
});
