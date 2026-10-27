import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import type { Declaration } from "./cell.ts";
import { DESIGN, KUBE_PROBE, cellOf } from "./cells.fixture.ts";
import { deletes, faultSpan, planOf } from "./faults.ts";
import { clientObjects, namespaceOf, serverObjects } from "./manifests.ts";
import {
  DOCUMENTED,
  NODE_LIFECYCLE,
  deletionWindow,
  intakeAfter,
  kubeletBand,
  latchBand,
  learnWindow,
  nodeLossBand,
  nodeReturnBand,
  pausedWindow,
  removalBand,
  restartBand,
  stallRemovalBand,
} from "./predict.ts";
import { describeCell, lintCell, verdictsOf } from "./rules.ts";
import { estimatedTime, shardOf } from "./run.ts";

const s = (value: number) => ({ value, unit: "s" });
const b = (lo: number, hi: number) => ({ lo: s(lo), hi: s(hi) });
const PROBE = KUBE_PROBE;
const E = { ...b(0.05, 0.4), from: "a test" };

describe("the arithmetic of the predictions", () => {
  it("gives the kubelet's decision after a flip: the next probe, then threshold − 1 periods, and the timeout of a hang", () => {
    expect(kubeletBand(PROBE, false)).toEqual(b(20, 30));
    expect(kubeletBand(PROBE, true)).toEqual(b(21, 31));
  });

  it("trips the latch of 3 polls of 5 s ± 20 % in 8–18 s on a refusal, and to 20 s on a request timeout of 2 s", () => {
    expect(latchBand(DESIGN.readiness, DESIGN.poll, "refuses")).toEqual(b(8, 18));
    expect(latchBand(DESIGN.readiness, DESIGN.poll, "silent", s(2))).toEqual(b(8, 20));
    expect(latchBand(DESIGN.readiness, DESIGN.poll, "silent")).toEqual(b(8, 22));
  });

  it("empties the Service at the latch, the kubelet and the propagation: 28–48 s at the defaults, as the research has it", () => {
    expect(removalBand(b(8, 18), PROBE, DOCUMENTED)).toEqual(b(28, 49));
    expect(removalBand(b(8, 20), PROBE, E)).toEqual(b(28.05, 50.4));
    expect(restartBand(b(8, 20), PROBE, s(0))).toEqual(b(28, 50));
    expect(stallRemovalBand(PROBE, E)).toEqual(b(21.05, 31.4));
  });

  it("removes the pods of a lost node 39.6–55.25 s after the loss and the propagation, and gives them back in 26.85 s after the return, at the defaults of v1.37.0", () => {
    expect(nodeLossBand(NODE_LIFECYCLE, E)).toEqual(b(39.6, 55.65));
    expect(nodeLossBand(NODE_LIFECYCLE, { ...b(0, 0), from: "a test" })).toEqual(b(39.6, 55.25));
    expect(nodeReturnBand(NODE_LIFECYCLE)).toEqual(b(0, 26.85));
  });

  it("ends the failures of a replica that cannot serve at the removal with the lame duck, and at the recovery after the heal without it", () => {
    const chart = { period: s(2), threshold: 3, timeout: s(1) };
    const keeps = { every: { value: 20, unit: "ms" }, timeout: s(2), connections: 8 };
    // the lame duck: the latch closes each connection, then the rules select the replica until the removal, and one turn of 160 ms follows
    expect(learnWindow(DESIGN, chart, E, keeps)).toEqual({ turn: s(0.16), latch: b(8, 18), start: b(0, 0.16), end: { from: "fault", band: b(8, 24.56) } });
    // no lame duck: the connections stay, thus the failures end one turn after the readiness recovers (up to 6 s after the heal)
    expect(learnWindow({ ...DESIGN, lameDuck: false }, chart, E, keeps).end).toEqual({ from: "heal", band: b(0, 6.16) });
    // a new connection for each request: one turn is one interval
    expect(learnWindow(DESIGN, chart, E, { every: keeps.every, timeout: s(2) }).turn).toEqual(s(0.02));
    // GOAWAY on one session of HTTP/2: the same latch and removal, and a turn of one interval, thus the window ends 140 ms earlier
    expect(learnWindow({ ...DESIGN, protocol: "h2c" }, chart, E, { ...keeps, connections: 1 })).toEqual({
      turn: s(0.02),
      latch: b(8, 18),
      start: b(0, 0.02),
      end: { from: "fault", band: b(8, 24.42) },
    });
  });

  it("opens a deletion window only when the preStop sleep and the hold end before the propagation", () => {
    expect(intakeAfter(DESIGN, s(0))).toEqual(s(2));
    expect(deletionWindow(DESIGN, s(0), E).empty).toBe(true);
    const noHold: Declaration = { ...DESIGN, phases: DESIGN.phases.map(([stage, cap]) => [stage, stage === "fail readiness" ? s(0) : cap]) };
    expect(deletionWindow(noHold, s(0), E)).toEqual({ empty: false, end: b(0.05, 0.4), intake: s(0) });
    expect(deletionWindow(noHold, s(1), E).empty).toBe(true);
    // a pause of 5 s from 0.5 s before the deletion: the paused node syncs 4.5 s after it
    expect(pausedWindow(DESIGN, s(0), s(0.5), s(5), E)).toMatchObject({ empty: false, resume: s(4.5), intake: s(2) });
    const hold8: Declaration = { ...DESIGN, phases: DESIGN.phases.map(([stage, cap]) => [stage, stage === "fail readiness" ? s(8) : cap]) };
    expect(pausedWindow(hold8, s(0), s(0.5), s(5), E).empty).toBe(true);
  });

  it("agrees with lint(): O04 holds exactly where the window is empty, and O10 holds for the design", () => {
    const cell = cellOf("pod-deletion");
    const noHold = cellOf("pod-deletion", { ...DESIGN, phases: DESIGN.phases.map(([stage, cap]) => [stage, stage === "fail readiness" ? s(0) : cap]) });
    expect(verdictsOf(lintCell(describeCell(cell), cell, E))).toMatchObject({ O04: "holds", O10: "holds", O16: "holds" });
    expect(verdictsOf(lintCell(describeCell(noHold), noHold, E))).toMatchObject({ O04: "violated", O10: "holds" });
    const late = { ...cell, pod: { ...cell.pod, preStop: s(5) } };
    expect(verdictsOf(lintCell(describeCell(late), late, E))["O10"]).toBe("violated");
  });
});

describe("the shards of a catalog", () => {
  it("puts each cell in one shard, with the cells of one mode together, in shares of the estimated time", () => {
    const modes = ["iptables", "ipvs", "nftables"] as const;
    const cells = Array.from({ length: 21 }, (_, at) => ({ ...cellOf("pod-deletion"), name: `cell ${at}`, mode: modes[at % 3]! }));
    const shards = Array.from({ length: 4 }, (_, index) => shardOf(cells, index, 4));
    expect(shards.flat().map((cell) => cell.name).sort()).toEqual(cells.map((cell) => cell.name).sort());
    for (const shard of shards) expect(shard.length).toBeGreaterThanOrEqual(5);
    // the cells are in sequence by mode, thus a shard holds two modes at the most
    for (const shard of shards) expect(new Set(shard.map((cell) => cell.mode)).size).toBeLessThanOrEqual(2);
    expect(shardOf(cells, 0, 1)).toHaveLength(21);
    expect(() => shardOf(cells, 4, 4)).toThrow(/not a shard/);
    expect(estimatedTime(cells[0]!)).toEqual(s(120 + 13 * 40));
  });

  it("estimates a run with its observation: a window that closes 122 s after the resume of a pause of 5 s", () => {
    const window = { kind: "window", nodes: "paused", start: { from: "intake", band: b(-122, 4.6) }, end: { from: "resume", band: b(0, 122) }, certain: true, why: "a test" } as const;
    const pause = { ...cellOf("freeze-process"), prediction: window };
    // the hold of 5 s, then the window, the timeout of 1 s of the workload and δ
    expect(valueIn(estimatedTime(pause), "s")).toBeCloseTo(120 + 13 * (25 + 5 + 122 + 1 + 0.1), 6);
    // a short window keeps the estimate of its trigger
    const short = { ...cellOf("pod-deletion"), prediction: { ...window, nodes: "all", end: { from: "deletion", band: b(0, 0.3) } } } as const;
    expect(estimatedTime(short)).toEqual(s(120 + 13 * 40));
  });
});

describe("the fault mapping", () => {
  it("gives the flaps of a trigger to its plan, and its span from the first fault to the last heal", () => {
    const flaps = [{ rest: s(15), hold: s(27) }, { rest: s(15), hold: s(27) }];
    const base = cellOf("blackhole", DESIGN, "T18");
    const flapping = { ...base, trigger: { ...base.trigger, hold: s(27), flaps } };
    expect(planOf(flapping)).toEqual({ ...planOf(base), hold: s(27), flaps });
    expect(faultSpan(flapping.trigger)).toEqual(s(111));
    expect(faultSpan({ hold: s(5) })).toEqual(s(5));
    expect(faultSpan({})).toEqual(s(0));
    // a trigger with no hold and heal cannot flap, and each flap has a rest and a hold
    expect(() => planOf({ ...cellOf("pod-deletion"), trigger: { kind: "pod-deletion", flaps } })).toThrow("the trigger pod-deletion has no hold and heal, thus it cannot flap");
    expect(() => planOf({ ...flapping, trigger: { ...flapping.trigger, flaps: [{ rest: s(0), hold: s(27) }] } })).toThrow("each flap has a rest and a hold above zero");
  });

  it("maps each trigger to its acts", () => {
    expect(planOf(cellOf("pod-deletion")).inject).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "delete", "pod", "{pod}", "--wait=false"] }]);
    expect(planOf(cellOf("crash")).inject).toEqual([{ do: "signal", target: "server", signal: "SIGKILL" }]);
    const pause = planOf(cellOf("freeze-process"));
    expect(pause.inject.map((step) => step.do)).toEqual(["pause", "wait", "kubectl"]);
    expect(pause.inject[0]).toEqual({ do: "pause", target: "kube-proxy", time: s(5) });
    expect(pause.inject[1]).toEqual({ do: "wait", time: s(0.5) });
    const frozen = planOf(cellOf("freeze-process", DESIGN, "T18"));
    expect(frozen).toEqual({
      inject: [{ do: "signal", target: "redis", signal: "SIGSTOP" }],
      hold: s(5),
      heal: [{ do: "signal", target: "redis", signal: "SIGCONT" }],
      restore: [],
    });
    expect(planOf(cellOf("blackhole", DESIGN, "T18")).heal).toEqual([{ do: "inject", target: "redis", action: "clear" }]);
    expect(planOf(cellOf("rst", DESIGN, "T18")).inject).toEqual([{ do: "inject", target: "redis", action: "rst" }]);
    expect(planOf(cellOf("peer-gone-without-close", DESIGN, "T18")).inject.map((step) => step.do)).toEqual(["inject", "kubectl"]);
    expect(planOf(cellOf("scale-in")).restore).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "scale", "deployment/lab", "--replicas=2"] }]);
    expect(planOf(cellOf("scale-in")).inject).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "scale", "deployment/lab", "--replicas=1"] }]);
    expect(planOf(cellOf("node-drain")).restore).toEqual([{ do: "kubectl", args: ["uncordon", "{node}"] }]);
    expect(planOf(cellOf("cpu-throttle")).inject).toEqual([{ do: "cpu", target: "server", max: "1000 1000000" }]);
    expect(planOf(cellOf("cpu-throttle")).heal).toEqual([{ do: "cpu", target: "server", max: "max 1000000" }]);
    expect(planOf(cellOf("app-stall")).inject).toEqual([{ do: "stall", target: "server", time: s(5) }]);
    // a stall in T07 gives each client new connections first, as a partition does. T18 has no such step
    expect(planOf(cellOf("app-stall")).prepare).toEqual([{ do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: s(3) }]);
    expect(planOf(cellOf("app-stall", DESIGN, "T18"))).toEqual({ inject: [{ do: "stall", target: "server", time: s(5) }], hold: null, heal: [], restore: [] });
    expect(planOf(cellOf("liveness-restart")).inject).toEqual([{ do: "flag", target: "server", on: true }]);
    const cannot = planOf(cellOf("cannot-serve"));
    expect(cannot.prepare).toEqual([{ do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: s(3) }]);
    expect([cannot.inject, cannot.hold, cannot.heal, cannot.restore]).toEqual([
      [{ do: "flag", target: "server", on: true }],
      s(5),
      [{ do: "flag", target: "server", on: false }],
      [{ do: "flag", target: "server", on: false }],
    ]);
    // a partition: new connections first, then a black hole in the namespace of the target replica
    const partition = planOf({ ...cellOf("blackhole"), trigger: { kind: "blackhole", hold: s(22), partition: true } });
    expect(partition).toEqual({
      prepare: [{ do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: s(3) }],
      inject: [{ do: "inject", target: "server", action: "blackhole" }],
      hold: s(22),
      heal: [{ do: "inject", target: "server", action: "clear" }],
      restore: [],
    });
    // a zone loss: new connections first, then the loss of the zone of the last worker, which no pod deletion follows
    expect(planOf(cellOf("zone-loss"))).toEqual({
      prepare: [{ do: "signal", target: "clients", signal: "SIGHUP" }, { do: "wait", time: s(3) }],
      inject: [{ do: "zone", lost: true }],
      hold: s(5),
      heal: [{ do: "zone", lost: false }],
      restore: [{ do: "zone", lost: false }],
    });
    expect(deletes(cellOf("zone-loss"))).toBe(false);
    // a slow dependency: a netem on the link of Redis. The heal sets the delay to zero, waits for the queue, then removes the qdisc
    const base = cellOf("latency");
    const latency = { ...base, trigger: { ...base.trigger, delay: { value: 300, unit: "ms" } } };
    const back = [{ do: "netem", target: "redis", delay: s(0) }, { do: "wait", time: s(1) }, { do: "netem", target: "redis", delay: null }];
    expect(planOf(latency)).toEqual({ inject: [{ do: "netem", target: "redis", delay: { value: 300, unit: "ms" } }], hold: s(5), heal: back, restore: back });
    expect(deletes(latency)).toBe(false);
    expect(() => planOf(base)).toThrow("the trigger needs a delay, the time that each packet of Redis waits");
    expect(() => planOf({ ...base, trigger: { ...base.trigger, delay: s(1) } })).toThrow("the delay of latency is above zero and below 1 s");
    expect(planOf(cellOf("rollout", DESIGN, "T18")).heal).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "scale", "deployment/redis", "--replicas=1"] }]);
    expect(deletes(cellOf("rolling-update"))).toBe(true);
    expect(deletes(cellOf("crash"))).toBe(false);
  });

  it("refuses a trigger without the setting that its acts need", () => {
    const cell = cellOf("blackhole", DESIGN, "T18");
    expect(() => planOf({ ...cell, trigger: { kind: "blackhole" } })).toThrow(/needs a hold/);
  });

  it("generates the objects of a cell from its settings", () => {
    const cell = { ...cellOf("pod-deletion"), pod: { ...cellOf("pod-deletion").pod, preStop: s(10) } };
    const namespace = namespaceOf(cell);
    expect(namespace).toMatch(/^lab-[0-9a-f]{10}$/);
    const [, deployment] = serverObjects(cell, namespace, "systems-kind-lab:test") as Array<{ spec: { template: { spec: Record<string, unknown> } } }>;
    const spec = deployment!.spec.template.spec as { terminationGracePeriodSeconds: number; containers: Array<Record<string, unknown>> };
    expect(spec.terminationGracePeriodSeconds).toBe(30);
    expect(spec.containers[0]!["lifecycle"]).toEqual({ preStop: { sleep: { seconds: 10 } } });
    expect(spec.containers[0]!["readinessProbe"]).toMatchObject({ periodSeconds: 10, failureThreshold: 3, timeoutSeconds: 1 });
    expect(spec.containers[0]!["startupProbe"]).toBeUndefined();
    const [daemonset] = clientObjects(cell, namespace, "systems-kind-lab:test", "10.96.0.10:80") as Array<{ spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } } }>;
    expect(daemonset!.spec.template.spec.containers[0]!.env.find((each) => each.name === "EVERY_MS")?.value).toBe("20");
    expect(() => serverObjects({ ...cell, pod: { ...cell.pod, grace: s(2.5) } }, namespace, "image")).toThrow(/whole number/);
  });

  it("gives a preStop sleep longer than the grace as a command, because the API server refuses such a sleep action", () => {
    const base = cellOf("rolling-update");
    const lifecycleOf = (preStop: number): unknown => {
      const [, deployment] = serverObjects({ ...base, pod: { ...base.pod, preStop: s(preStop) } }, "lab-ns", "image") as Array<{
        spec: { template: { spec: { containers: Array<Record<string, unknown>> } } };
      }>;
      return deployment!.spec.template.spec.containers[0]!["lifecycle"];
    };
    // the grace of the fixture is 30 s
    expect(lifecycleOf(30)).toEqual({ preStop: { sleep: { seconds: 30 } } });
    expect(lifecycleOf(60)).toEqual({ preStop: { exec: { command: ["/bin/sh", "-c", "sleep 60"] } } });
    expect(lifecycleOf(0)).toBeUndefined();
  });
});
