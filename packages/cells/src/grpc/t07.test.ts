import { clientObjects, judgeKind, planOf, serverObjects } from "@mark1russell7/kind";
import type { KindRun } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { PROPAGATION, afterSync, kubeDefaults, s } from "../kind.ts";
import { T07_CELLS } from "../t07.ts";
import { FIRST_BACKOFF, T07_GRPC, T07_GRPC_ALIASES, T07_GRPC_SPECS, T07_GRPC_WAITING, backoffOf, grpcDeletion, lastWait } from "./t07.ts";

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

  it("ends the window after the wait of the last connect that the pod can refuse", () => {
    // the wait k of grpc-js: 1 s with no jitter, then 1.6 times longer each time, ± 20 % of jitter that compounds
    expect(backoffOf(0)).toEqual(FIRST_BACKOFF);
    expect(backoffOf(1).lo).toBeCloseTo(1.28, 9);
    expect(backoffOf(1).hi).toBeCloseTo(1.92 + (FIRST_BACKOFF.hi - 1), 9);
    // a propagation shorter than the first wait: one refused connect, the band of each deletion
    for (const propagation of Object.values(PROPAGATION)) expect(lastWait(valueIn(propagation.hi, "s"))).toBe(0);
    // after a sync, the propagation is longer than 1 s: a second connect can go to the pod
    expect(lastWait(valueIn(afterSync("ipvs").hi, "s"))).toBe(1);
    expect(lastWait(valueIn(afterSync("iptables").hi, "s"))).toBe(1);
    expect(lastWait(2.5)).toBe(2);
    const prediction = grpcDeletion({ pod: kubeDefaults(2), mode: "ipvs" }, { lo: s(0), hi: s(2.5), from: "a test" });
    if (prediction.kind !== "window") throw new Error("a window");
    expect(valueIn(prediction.end!.band.hi, "s")).toBeCloseTo(2.5 + backoffOf(2).hi, 6);
    expect(prediction).not.toHaveProperty("each");
  });

  it("predicts a window for each old pod of a rolling update, through two refused connects (IPVS)", () => {
    const rolling = cell("T07.defaults.12");
    expect(rolling).toMatchObject({ mode: "ipvs", trigger: { kind: "rolling-update" }, pod: { replicas: 2 } });
    expect(rolling.prediction).toMatchObject({ kind: "window", nodes: "all", each: true, start: { from: "intake" }, end: { from: "deletion" }, certain: false });
    if (rolling.prediction.kind !== "window") throw new Error("a window");
    const propagation = valueIn(afterSync("ipvs").hi, "s");
    expect(propagation).toBeCloseTo(1.309, 9);
    expect(valueIn(rolling.prediction.start.band.hi, "s")).toBeCloseTo(propagation, 9);
    expect(valueIn(rolling.prediction.end!.band.lo, "s")).toBeCloseTo(FIRST_BACKOFF.lo, 9);
    expect(valueIn(rolling.prediction.end!.band.hi, "s")).toBeCloseTo(propagation + backoffOf(1).hi, 6);
    expect(planOf(rolling).inject).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "set", "env", "deployment/lab", "LAB_VERSION={version}"] }]);
  });

  it("predicts no failure when the kubelet stops a preStop of 60 s at the grace of 30 s (DP29)", () => {
    const misconfigured = cell("T07.array.46");
    expect(misconfigured).toMatchObject({ mode: "iptables", trigger: { kind: "rolling-update" } });
    expect([valueIn(misconfigured.pod.preStop, "s"), valueIn(misconfigured.pod.grace, "s")]).toEqual([60, 30]);
    expect(misconfigured.prediction.kind).toBe("none");
    expect(misconfigured.prediction.why).toMatch(/SIGTERM 30 s after the deletion/);
    // the API server refuses a sleep action longer than the grace: the sleep is a command of the container
    const [, deployment] = serverObjects(misconfigured, "lab-ns", "x") as Array<{ spec: { template?: { spec: { containers: Array<Record<string, unknown>> } } } }>;
    expect(deployment!.spec.template!.spec.containers[0]).toMatchObject({ lifecycle: { preStop: { exec: { command: ["/bin/sh", "-c", "sleep 60"] } } } });
  });

  it("holds the failures of a rolling update in the window of each old pod, and fails one between them", () => {
    const rolling = cell("T07.defaults.12");
    const a = { pod: "lab-a", node: "w1", ip: "10.244.1.5", version: "1" };
    const b = { pod: "lab-b", node: "w2", ip: "10.244.2.7", version: "1" };
    const rules = (t: number, backends: string[]) => ({ ev: "rules", t, prev: t - 50, node: "w1", b: backends });
    const deleted = (t: number, replica: typeof a) => ({
      ev: "pod", t, type: "MODIFIED", name: replica.pod, node: replica.node, ip: replica.ip, del: true, ready: false, phase: "Running", cs: [], labels: { app: "lab" },
    });
    const failure = (t: number) => ({ ev: "req", t, d: 0.4, o: "refused", p: "client-x", n: "w1", lp: 40312 });
    const run = (...failedAt: number[]): KindRun => ({
      env: 0,
      index: 0,
      warmup: false,
      start: 0,
      end: 30_000,
      acts: { fault: 1000, heal: null, resume: null },
      target: a,
      paused: null,
      replicas: [a, b],
      void: null,
      lines: [
        rules(900, ["10.244.1.5:8080", "10.244.2.7:8080", "10.244.3.9:8080"]),
        deleted(5000, a),
        { ev: "stopping", t: 5030, p: "lab-a" },
        rules(6200, ["10.244.2.7:8080", "10.244.3.9:8080"]),
        deleted(12_000, b),
        { ev: "stopping", t: 12_040, p: "lab-b" },
        rules(13_200, ["10.244.3.9:8080", "10.244.4.2:8080"]),
        ...failedAt.map(failure),
      ],
      dropped: {},
    });
    // a refused connect in each window, the second one 2.5 s after its deletion: after the first backoff
    expect(judgeKind(rolling, [run(5100, 7500), run(12_100, 14_500)]).decision).toBe("holds");
    // a failure between the two windows
    expect(judgeKind(rolling, [run(5100, 9000)]).decision).toBe("fails");
    // a failure after the end of the window of the last pod
    expect(judgeKind(rolling, [run(12_000 + 1000 * (valueIn(afterSync("ipvs").hi, "s") + backoffOf(1).hi) + 300)]).decision).toBe("fails");
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
