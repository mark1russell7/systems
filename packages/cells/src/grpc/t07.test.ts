import { clientObjects, judgeKind, planOf, serverObjects } from "@mark1russell7/kind";
import type { KindRun } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { PROPAGATION } from "../kind.ts";
import { T07_CELLS } from "../t07.ts";
import { FIRST_BACKOFF, T07_GRPC, T07_GRPC_ALIASES, T07_GRPC_SPECS, T07_GRPC_WAITING } from "./t07.ts";

/** These are the cells of R3's plan over grpc-go-server in T07 (plan.json): a client of gRPC in pods on each node. */
const DEFAULTS = [4, 10, 12, 17, 20, 35, 38] as const;
const ARRAY = [4, 10, 12, 17, 20, 35, 38, 46, 47] as const;

const cell = (id: string) => {
  const found = T07_GRPC.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no cell ${id}`);
  return found;
};

describe("the gRPC catalog of T07", () => {
  it("gives each cell of the plan a cell, an alias or a reason to wait, once", () => {
    const named = T07_GRPC_SPECS.map((spec) => spec.id).concat(T07_GRPC_ALIASES.map((each) => each.plan), T07_GRPC_WAITING.map((each) => each.plan));
    expect(named.sort()).toEqual([...DEFAULTS.map((n) => `T07.defaults.${n}`), ...ARRAY.map((n) => `T07.array.${n}`)].sort());
    for (const alias of T07_GRPC_ALIASES) expect(() => cell(alias.is), alias.plan).not.toThrow();
    expect(new Set(T07_GRPC.map((each) => each.name)).size).toBe(T07_GRPC.length);
    for (const each of T07_GRPC) expect(each, each.name).toMatchObject({ template: "T07", stack: "grpc", declaration: null, runs: 11 });
  });

  it("waits the first backoff of grpc-js, 1 s with no jitter, after a connect that the pod refused", () => {
    expect(FIRST_BACKOFF.lo).toBeCloseTo(1, 9);
    // one step of Node
    expect(FIRST_BACKOFF.hi).toBeGreaterThan(1);
    expect(FIRST_BACKOFF.hi).toBeLessThan(1.05);
    // the next connect comes after the propagation of each mode, thus it goes to another pod
    for (const propagation of Object.values(PROPAGATION)) expect(valueIn(propagation.hi, "s")).toBeLessThan(FIRST_BACKOFF.lo);
  });

  it("predicts a window from the GOAWAY to one backoff after the propagation, with no preStop", () => {
    for (const id of ["T07.defaults.38", "T07.defaults.4", "T07.defaults.10", "T07.array.47"]) {
      const each = cell(id);
      expect(each.prediction, id).toMatchObject({ kind: "window", nodes: "all", start: { from: "intake" }, end: { from: "deletion" }, certain: false });
      if (each.prediction.kind !== "window") throw new Error("a window");
      expect(each.prediction).not.toHaveProperty("afterReset");
      const hi = valueIn(each.prediction.end!.band.hi, "s");
      expect(hi, id).toBeCloseTo(valueIn(PROPAGATION[each.mode].hi, "s") + FIRST_BACKOFF.hi, 6);
    }
  });

  it("predicts no failure when a preStop of 20 s outlasts the propagation (DP28)", () => {
    const hardened = cell("T07.array.4");
    expect(hardened.prediction.kind).toBe("none");
    expect(valueIn(hardened.pod.preStop, "s")).toBe(20);
    expect(valueIn(hardened.pod.grace, "s")).toBe(30);
  });

  it("runs grpc-go with the gRPC probes of the kubelet, and the client of grpc-js after it", () => {
    const deletion = cell("T07.defaults.38");
    const [service, deployment] = serverObjects(deletion, "lab-ns", "loom-harness-grpc-go:test") as [
      { spec: { ports: Array<{ name: string; port: number; targetPort: number }> } },
      { spec: { template: { spec: { containers: Array<Record<string, unknown>> } } } },
    ];
    expect(service.spec.ports).toEqual([{ name: "grpc", port: 80, targetPort: 8080 }]);
    const container = deployment.spec.template.spec.containers[0]!;
    expect(container).toMatchObject({
      name: "app",
      image: "loom-harness-grpc-go:test",
      command: ["grpc-go-server", "--port", "8080", "--name", "$(POD_NAME)", "--clock", "ms"],
      readinessProbe: { grpc: { port: 8080 }, periodSeconds: 10, failureThreshold: 3 },
      livenessProbe: { grpc: { port: 8080 } },
    });
    expect(container).not.toHaveProperty("lifecycle");
    // the preStop of DP28 is the native sleep action
    const hardened = (serverObjects(cell("T07.array.4"), "lab-ns", "x") as Array<{ spec: { template?: { spec: { containers: Array<Record<string, unknown>> } } } }>)[1]!;
    expect(hardened.spec.template!.spec.containers[0]).toMatchObject({ lifecycle: { preStop: { sleep: { seconds: 20 } } } });
    const [daemonSet] = clientObjects(deletion, "lab-ns", "systems-kind-lab:test", "10.96.0.10:80") as [{ spec: { template: { spec: { containers: Array<{ command: string[] }> } } } }];
    expect(daemonSet.spec.template.spec.containers[0]!.command).toEqual(["node", "client-grpc.mjs"]);
  });

  it("names the replica that a scale-in removes by its deletion cost, for gRPC only", () => {
    const annotate = { do: "kubectl", args: ["-n", "{namespace}", "annotate", "pod", "{pod}", "controller.kubernetes.io/pod-deletion-cost=-1", "--overwrite"] };
    for (const id of ["T07.defaults.4", "T07.array.4"]) expect(planOf(cell(id)).inject, id).toEqual([annotate, { do: "kubectl", args: ["-n", "{namespace}", "scale", "deployment/lab", "--replicas=2"] }]);
    // the scale-in of the service keeps the choice of its controller
    const service = T07_CELLS.find((each) => each.trigger.kind === "scale-in")!;
    expect(planOf(service).inject).toHaveLength(1);
  });

  it("judges a run by the GOAWAY of grpc-go and the calls of its clients", () => {
    const deletion = cell("T07.defaults.38");
    const target = { pod: "lab-a", node: "w1", ip: "10.244.1.5", version: "1" };
    const rules = (t: number, b: string[]) => ({ ev: "rules", t, prev: t - 50, node: "w1", b });
    const run = (failedAt: number): KindRun => ({
      env: 0,
      index: 0,
      warmup: false,
      start: 0,
      end: 10_000,
      acts: { fault: 1000, heal: null, resume: null },
      target,
      paused: null,
      replicas: [target],
      void: null,
      lines: [
        rules(900, ["10.244.1.5:8080", "10.244.2.7:8080"]),
        { ev: "pod", t: 1010, type: "MODIFIED", name: "lab-a", node: "w1", ip: target.ip, del: true, ready: false, phase: "Running", cs: [], labels: { app: "lab" } },
        { ev: "stopping", t: 1060, p: "lab-a" },
        rules(1200, ["10.244.2.7:8080"]),
        { ev: "req", t: failedAt, d: 0.4, o: "refused", p: "client-x", n: "w1", lp: 40312 },
      ],
      dropped: {},
    });
    // a call fails 1.2 s after the deletion: in the window
    expect(judgeKind(deletion, [run(2200)]).decision).toBe("holds");
    // a failure before the GOAWAY, less δ, is outside the window
    expect(judgeKind(deletion, [run(800)]).decision).toBe("fails");
    // a failure after one backoff past the propagation is outside it too
    expect(judgeKind(deletion, [run(1010 + 1000 * (valueIn(PROPAGATION.ipvs.hi, "s") + FIRST_BACKOFF.hi) + 300)]).decision).toBe("fails");
  });
});
