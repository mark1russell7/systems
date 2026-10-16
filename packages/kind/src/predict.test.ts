import { describe, expect, it } from "vitest";
import type { Declaration } from "./cell.ts";
import { DESIGN, KUBE_PROBE, cellOf } from "./cells.fixture.ts";
import { deletes, planOf } from "./faults.ts";
import { clientObjects, namespaceOf, serverObjects } from "./manifests.ts";
import {
  DOCUMENTED,
  deletionWindow,
  intakeAfter,
  kubeletBand,
  latchBand,
  pausedWindow,
  removalBand,
  restartBand,
  stallRemovalBand,
} from "./predict.ts";
import { describeCell, lintCell, verdictsOf } from "./rules.ts";
import { estimateSeconds, shardOf } from "./run.ts";

const s = (value: number) => ({ value, unit: "s" });
const PROBE = KUBE_PROBE;
const E = { lo: 0.05, hi: 0.4, from: "a test" };

describe("the arithmetic of the predictions", () => {
  it("gives the kubelet's decision after a flip: the next probe, then threshold − 1 periods, and the timeout of a hang", () => {
    expect(kubeletBand(PROBE, false)).toEqual({ lo: 20, hi: 30 });
    expect(kubeletBand(PROBE, true)).toEqual({ lo: 21, hi: 31 });
  });

  it("trips the latch of 3 polls of 5 s ± 20 % in 8–18 s on a refusal, and to 20 s on a request timeout of 2 s", () => {
    expect(latchBand(DESIGN.readiness, DESIGN.poll, "refuses")).toEqual({ lo: 8, hi: 18 });
    expect(latchBand(DESIGN.readiness, DESIGN.poll, "silent", s(2))).toEqual({ lo: 8, hi: 20 });
    expect(latchBand(DESIGN.readiness, DESIGN.poll, "silent")).toEqual({ lo: 8, hi: 22 });
  });

  it("empties the Service at the latch, the kubelet and the propagation: 28–48 s at the defaults, as the research has it", () => {
    expect(removalBand({ lo: 8, hi: 18 }, PROBE, DOCUMENTED)).toEqual({ lo: 28, hi: 49 });
    expect(removalBand({ lo: 8, hi: 20 }, PROBE, E)).toEqual({ lo: 28.05, hi: 50.4 });
    expect(restartBand({ lo: 8, hi: 20 }, PROBE, s(0))).toEqual({ lo: 28, hi: 50 });
    expect(stallRemovalBand(PROBE, E)).toEqual({ lo: 21.05, hi: 31.4 });
  });

  it("opens a deletion window only when the preStop sleep and the hold end before the propagation", () => {
    expect(intakeAfter(DESIGN, s(0))).toBe(2);
    expect(deletionWindow(DESIGN, s(0), E).empty).toBe(true);
    const noHold: Declaration = { ...DESIGN, phases: DESIGN.phases.map(([stage, cap]) => [stage, stage === "fail readiness" ? s(0) : cap]) };
    expect(deletionWindow(noHold, s(0), E)).toEqual({ empty: false, end: { lo: 0.05, hi: 0.4 }, intake: 0 });
    expect(deletionWindow(noHold, s(1), E).empty).toBe(true);
    // a pause of 5 s from 0.5 s before the deletion: the paused node syncs 4.5 s after it
    expect(pausedWindow(DESIGN, s(0), s(0.5), s(5), E)).toMatchObject({ empty: false, resume: 4.5, intake: 2 });
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
    expect(estimateSeconds(cells[0]!)).toBe(120 + 13 * 40);
  });
});

describe("the fault mapping", () => {
  it("maps each trigger to its acts", () => {
    expect(planOf(cellOf("pod-deletion")).inject).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "delete", "pod", "{pod}", "--wait=false"] }]);
    expect(planOf(cellOf("crash")).inject).toEqual([{ do: "signal", target: "server", signal: "SIGKILL" }]);
    const pause = planOf(cellOf("freeze-process"));
    expect(pause.inject.map((step) => step.do)).toEqual(["pause", "wait", "kubectl"]);
    expect(pause.inject[0]).toEqual({ do: "pause", target: "kube-proxy", ms: 5000 });
    expect(pause.inject[1]).toEqual({ do: "wait", ms: 500 });
    const frozen = planOf(cellOf("freeze-process", DESIGN, "T18"));
    expect(frozen).toEqual({
      inject: [{ do: "signal", target: "redis", signal: "SIGSTOP" }],
      hold: 5000,
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
    expect(planOf(cellOf("app-stall")).inject).toEqual([{ do: "stall", target: "server", ms: 5000 }]);
    expect(planOf(cellOf("liveness-restart")).inject).toEqual([{ do: "flag", target: "server", on: true }]);
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
});
