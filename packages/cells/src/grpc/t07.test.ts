import { clientObjects, judgeKind, planOf, serverObjects } from "@mark1russell7/kind";
import type { KindRun } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { PROPAGATION, afterSync, kubeDefaults, s } from "../kind.ts";
import { T07_CELLS } from "../t07.ts";
import { FIRST_BACKOFF, T07_GRPC, T07_GRPC_ALIASES, T07_GRPC_SPECS, T07_GRPC_WAITING, backoffOf, grpcDeletion, lastWait, stalledConnect, synWaitOf } from "./t07.ts";

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

  it("predicts a window for each old pod of a rolling update, through two refused connects or a stalled SYN (IPVS)", () => {
    const rolling = cell("T07.defaults.12");
    expect(rolling).toMatchObject({ mode: "ipvs", trigger: { kind: "rolling-update" }, pod: { replicas: 2 } });
    expect(rolling.prediction).toMatchObject({ kind: "window", nodes: "all", each: true, start: { from: "intake" }, end: { from: "deletion" }, certain: false });
    if (rolling.prediction.kind !== "window") throw new Error("a window");
    // a sync of up to 0.309 s at the deletion, minSyncPeriod of 1 s after it, then the idle propagation of 0.309 s
    const propagation = valueIn(afterSync("ipvs").hi, "s");
    expect(propagation).toBeCloseTo(1.618, 9);
    expect(valueIn(rolling.prediction.start.band.hi, "s")).toBeCloseTo(propagation, 9);
    expect(valueIn(rolling.prediction.end!.band.lo, "s")).toBeCloseTo(FIRST_BACKOFF.lo, 9);
    // the judge tests that band in each run
    expect(rolling.prediction.propagation).toEqual({ lo: afterSync("ipvs").lo, hi: afterSync("ipvs").hi });
    // the stalled SYN ends later than the second refused connect: 1.618 + 2 × 1.064 s, not 1.618 + 1.93 s
    const end = valueIn(rolling.prediction.end!.band.hi, "s");
    expect(end).toBeCloseTo(propagation + stalledConnect(propagation), 6);
    expect(end).toBeCloseTo(3.746, 6);
    expect(end).toBeGreaterThan(propagation + backoffOf(1).hi);
    expect(rolling.prediction.why).toMatch(/A pod that is gone gives no answer/);
    expect(planOf(rolling).inject).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "set", "env", "deployment/lab", "LAB_VERSION={version}"] }]);
  });

  it("connects two SYNs after IPVS drops an old pod that is gone, each 1 s apart and up to 64 ms late at HZ 1000", () => {
    // the waits 0 to 4 of the SYN timer keep the initial RTO of 1 s (tcp_syn_linear_timeouts), then double
    for (const k of [0, 1, 2, 3, 4]) expect(synWaitOf(k), `wait ${k}`).toEqual({ lo: 0.999, hi: 1.064 });
    expect(synWaitOf(5).lo).toBeCloseTo(1.999, 9);
    // a stall up to 1.309 s: the first SYN after the drop comes one wait later at the most, and IPVS
    // drops it. The next one, one wait later, gets a live pod
    expect(stalledConnect(1.618)).toBeCloseTo(2.128, 9);
    expect(stalledConnect(1.309)).toBeCloseTo(2.128, 9);
    expect(stalledConnect(0.309)).toBeCloseTo(2.128, 9);
    // kind run 40123580623: the second deletion came 0.499 s to 0.602 s after the first, IPVS dropped the
    // first pod 1.118 s to 1.276 s after its deletion, and the connect came 2.055 s to 2.101 s after the second
    const propagation = valueIn(afterSync("ipvs").hi, "s");
    expect(2.101).toBeLessThan(propagation + stalledConnect(propagation));
    // conntrack keeps the NAT of a SYN to an old pod that is gone: no model gives that window
    expect(() => grpcDeletion({ pod: kubeDefaults(2), mode: "iptables" }, afterSync("iptables"), true)).toThrow(/no model/);
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
    // a call that waits for a stalled SYN: it starts 0.104 s after the second deletion and ends at its timeout
    expect(judgeKind(rolling, [run(12_104)]).decision).toBe("holds");
    // a failure after the end of the window of the last pod
    if (rolling.prediction.kind !== "window") throw new Error("a window");
    expect(judgeKind(rolling, [run(12_000 + 1000 * valueIn(rolling.prediction.end!.band.hi, "s") + 300)]).decision).toBe("fails");
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
    // only a liveness restart gives grpc-go its flag file
    expect(container["command"]).not.toContain("--fail-file");
    expect((container["livenessProbe"] as { grpc: Record<string, unknown> }).grpc).not.toHaveProperty("service");
    // the preStop of DP28 is the native sleep action
    const hardened = (serverObjects(cell("T07.array.4"), "lab-ns", "x") as Array<{ spec: { template?: { spec: { containers: Array<Record<string, unknown>> } } } }>)[1]!;
    expect(hardened.spec.template!.spec.containers[0]).toMatchObject({ lifecycle: { preStop: { sleep: { seconds: 20 } } } });
    const [daemonSet] = clientObjects(deletion, "lab-ns", "systems-kind-lab:test", "10.96.0.10:80") as [{ spec: { template: { spec: { containers: Array<{ command: string[] }> } } } }];
    expect(daemonSet.spec.template.spec.containers[0]!.command).toEqual(["node", "client-grpc.mjs"]);
  });

  it("fails the service liveness of grpc-go with the flag file, and keeps the readiness probe on the service \"\"", () => {
    const restart = cell("T07.defaults.35");
    expect(restart).toMatchObject({ mode: "nftables", trigger: { kind: "liveness-restart" }, pod: { replicas: 2 } });
    const [, deployment] = serverObjects(restart, "lab-ns", "loom-harness-grpc-go:test") as [unknown, { spec: { template: { spec: { containers: Array<Record<string, unknown>> } } } }];
    const container = deployment.spec.template.spec.containers[0]!;
    expect(container["command"]).toEqual(["grpc-go-server", "--port", "8080", "--name", "$(POD_NAME)", "--clock", "ms", "--fail-file", "/tmp/lab-fail"]);
    expect(container["livenessProbe"]).toEqual({ grpc: { port: 8080, service: "liveness" }, initialDelaySeconds: 0, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 });
    expect(container["readinessProbe"]).toEqual({ grpc: { port: 8080 }, initialDelaySeconds: 0, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3, successThreshold: 1 });
    // the lab writes the flag file in the root of the server process of the target
    expect(planOf(restart).inject).toEqual([{ do: "flag", target: "server", on: true }]);
  });

  it("predicts a window from the GOAWAY of a liveness restart with no end, because no document bounds the start of the new container", () => {
    const restart = cell("T07.defaults.35");
    expect(restart.prediction).toEqual({
      kind: "window",
      nodes: "all",
      start: { from: "intake", band: { lo: s(0), hi: s(0) } },
      end: null,
      certain: false,
      why: expect.stringMatching(/After 3 failed probes, 20 s to 30 s after the flag/),
    });
    expect(restart.prediction.why).toMatch(/the window has no end$/);
    // DP26 sets the defaults of Kubernetes: the array cell is the same cell
    expect(T07_GRPC_ALIASES.find((each) => each.plan === "T07.array.35")).toMatchObject({ is: "T07.defaults.35" });
    expect(T07_GRPC_WAITING.map((each) => each.plan)).not.toContain("T07.defaults.35");
  });

  it("judges a liveness restart from the line stopping of the old container", () => {
    const restart = cell("T07.defaults.35");
    const target = { pod: "lab-a", node: "w1", ip: "10.244.1.5", version: "1" };
    const failure = (t: number) => ({ ev: "req", t, d: 0.4, o: "refused", p: "client-x", n: "w1", lp: 40312 });
    const run = (stopping: boolean, ...failedAt: number[]): KindRun => ({
      env: 0,
      index: 0,
      warmup: false,
      start: 0,
      end: 40_000,
      acts: { fault: 1000, heal: null, resume: null },
      target,
      paused: null,
      replicas: [target],
      void: null,
      lines: [
        { ev: "rules", t: 900, prev: 850, node: "w1", b: ["10.244.1.5:8080", "10.244.2.7:8080"] },
        ...(stopping ? [{ ev: "stopping", t: 25_000, p: "lab-a" }, { ev: "listening", t: 25_600, p: "lab-a" }] : []),
        ...failedAt.map(failure),
      ],
      dropped: {},
    });
    // no failure, or refused connects until after the new container listens and one backoff
    expect(judgeKind(restart, [run(true)]).decision).toBe("holds");
    expect(judgeKind(restart, [run(true, 25_020, 26_100, 27_900)]).decision).toBe("holds");
    // a failure before the GOAWAY, less δ
    expect(judgeKind(restart, [run(true, 24_800)]).decision).toBe("fails");
    // no restart: the run has no intake
    expect(judgeKind(restart, [run(false)]).decision).toBe("fails");
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
