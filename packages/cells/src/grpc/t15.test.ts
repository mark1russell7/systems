import type { KindCell } from "@mark1russell7/kind";
import {
  CHANNEL_USE,
  LAST_SLACK,
  POLICY,
  ZTUNNEL_PODS,
  clientObjects,
  estimatedTime,
  followsZtunnel,
  namespaceObject,
  namespaceOf,
  planOf,
  policyObject,
  pollsListeners,
  propagationSource,
  serverCluster,
  serverObjects,
  shardOf,
  ztunnelEnvArgs,
} from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { PROPAGATION, calibrated, ms, s } from "../kind.ts";
import { T07_GRPC } from "./t07.ts";
import { backoffOf, lastWait, synWaitOf } from "./t07.ts";
import {
  AMBIENT,
  CERT_LIFETIME,
  EDS_CALIBRATION,
  EXPIRY_HOLD,
  MIDDLEBOX_HOP,
  NEXT_CALL,
  PONG,
  P_EDS,
  P_LDS,
  RELEASE,
  RENEWAL,
  SIDECAR,
  SIDECAR_IN_AMBIENT,
  SIGNAL_LATE,
  T15_GRPC,
  T15_GRPC_ALIASES,
  T15_GRPC_WAITING,
  TERM_LATE,
  ZTUNNEL_CONNECT,
  blackholeWindow,
  certificateMesh,
  deadlineMesh,
  drainEnd,
  forgetEnds,
  giveUpAfterPing,
  giveUpFirstEnds,
  longestSynGap,
  pingFirstEnds,
  pingOnMiddlebox,
  policyWindow,
  releaseEnds,
  resetWindow,
  restartEnds,
  sidecarDeletion,
} from "./t15.ts";

const cell = (id: string): KindCell => {
  const found = T15_GRPC.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no cell ${id}`);
  return found;
};

/** These are the cells of the sidecar mesh: steps 1 and 2. */
const SIDECAR_CELLS = T15_GRPC.filter((each) => each.mesh === SIDECAR);

describe("the gRPC catalog of T15, steps 2 to 6", () => {
  it("has the calibrations, the deletion and the policy, each in the sidecar mesh, the reset, the black hole, the gap and the restarts in the ambient flavor, and each name once", () => {
    expect(T15_GRPC.map((each) => each.id)).toEqual([
      "CAL.T15.sidecar",
      "T15.defaults.13",
      "CAL.T15.policy",
      "T15.defaults.5",
      "T15.defaults.12",
      "T15.defaults.2",
      "T15.defaults.10",
      "T15.border-off.79",
      "T15.border-off.80",
      "T15.border-off.87",
      "T15.border-off.88",
      "T15.defaults.14",
      "T15.border-off.85",
      "T15.border-off.86",
      "T15.border-off.77",
      "T15.border-off.92",
    ]);
    expect(T15_GRPC.filter((each) => each.mesh?.mode === "ambient").map((each) => each.id)).toEqual([
      "T15.defaults.12",
      "T15.defaults.2",
      "T15.defaults.10",
      "T15.border-off.79",
      "T15.border-off.80",
      "T15.border-off.87",
      "T15.border-off.88",
      "T15.border-off.85",
      "T15.border-off.86",
      "T15.border-off.77",
      "T15.border-off.92",
    ]);
    expect(T15_GRPC.filter((each) => each.mesh?.flavor === "ambient" && each.mesh.mode === "sidecar").map((each) => each.id)).toEqual(["T15.defaults.14"]);
    expect(new Set(T15_GRPC.map((each) => each.name)).size).toBe(T15_GRPC.length);
    expect(new Set(T15_GRPC.map(namespaceOf)).size).toBe(T15_GRPC.length);
    for (const each of SIDECAR_CELLS) {
      // the workflow selects the catalog with only='^T15'
      expect(each.name, each.id).toMatch(/^T15 sidecar, gRPC, /);
      expect(each, each.name).toMatchObject({ template: "T15", stack: "grpc", mesh: { flavor: "sidecar", mode: "sidecar" }, declaration: null, mode: "iptables", runs: 11 });
      expect(each.prediction.why.length, each.name).toBeGreaterThan(10);
      expect(propagationSource(each), each.name).toBe("eds");
    }
    for (const each of T15_GRPC.filter((one) => one.mesh?.mode === "ambient")) {
      expect(each.name, each.id).toMatch(/^T15 ambient, gRPC, /);
      expect(each, each.name).toMatchObject({ template: "T15", stack: "grpc", mesh: { flavor: "ambient", mode: "ambient" }, declaration: null, mode: "iptables", runs: 11 });
    }
    expect(T15_GRPC.filter((each) => each.trigger.kind === "pod-deletion").map((each) => each.id)).toEqual(["CAL.T15.sidecar", "T15.defaults.13"]);
    expect(T15_GRPC.filter(pollsListeners).map((each) => each.id)).toEqual(["CAL.T15.policy", "T15.defaults.5"]);
  });

  it("calibrates the push of EDS with a preStop sleep that outlasts it", () => {
    const calibration = cell("CAL.T15.sidecar");
    expect(calibration.calibrates).toBe(true);
    expect(calibration.prediction.kind).toBe("none");
    expect(calibration.pod).toMatchObject({ replicas: 2, preStop: s(10), grace: s(40) });
  });

  it("derives the push of EDS from its calibration by the rule of T07", () => {
    // the rule of the table of T07: the longest poll without the pod, and the shortest less one poll
    expect(calibrated({ cell: "CAL.T07.ipvs", run: 0, count: 33, min: s(0.123), median: s(0.192), max: s(0.309), poll: ms(50) })).toEqual(PROPAGATION.ipvs);
    expect(calibrated({ cell: "CAL.T07.iptables", run: 0, count: 33, min: s(0.03), median: s(0.059), max: s(0.105), poll: ms(50) })).toEqual(PROPAGATION.iptables);
    expect(EDS_CALIBRATION).toMatchObject({ cell: "CAL.T15.sidecar", run: 40147396211, count: 33 });
    expect(P_EDS).toEqual({ lo: s(0.078), hi: s(0.205), from: "CAL.T15.sidecar: median 0.168 s, 33 times" });
  });

  it("gives the deletion a window of one push of EDS after it, with that propagation, and no failure it must have", () => {
    const deletion = cell("T15.defaults.13");
    expect(deletion.calibrates).toBe(false);
    expect(deletion.pod).toMatchObject({ replicas: 2, preStop: s(0), grace: s(30) });
    expect(valueIn(deletion.workload.timeout, "s")).toBe(2);
    expect(deletion.prediction).toEqual(sidecarDeletion(P_EDS, deletion.prediction.why));
    expect(deletion.prediction).toMatchObject({
      kind: "window",
      start: { from: "deletion", band: { lo: s(0), hi: s(0.205) } },
      end: { from: "deletion", band: { lo: s(0), hi: s(0.205) } },
      certain: false,
      propagation: { lo: s(0.078), hi: s(0.205) },
    });
    expect(deletion.prediction.why).toContain("0.205 s (CAL.T15.sidecar: median 0.168 s, 33 times)");
  });

  it("calibrates the LDS update of a policy with an account that no pod has", () => {
    const calibration = cell("CAL.T15.policy");
    expect(calibration).toMatchObject({ calibrates: true, prediction: { kind: "none" }, trigger: { kind: "authorization-policy", hold: s(15), account: "lab-absent" } });
    expect(JSON.stringify(planOf(calibration).inject)).toContain("/sa/lab-absent");
  });

  it("gives the policy a window of denials from the update after the apply to the update after the delete", () => {
    const policy = cell("T15.defaults.5");
    expect(policy.trigger).toEqual({ kind: "authorization-policy", hold: s(15) });
    expect(NEXT_CALL).toEqual(LAST_SLACK);
    expect(P_LDS).toMatchObject({ lo: s(0.1), hi: s(10) });
    expect(policy.prediction).toEqual(policyWindow(P_LDS, s(15), policy.prediction.why));
    // the first denial: the update, two next calls of 250 ms and one step of 10 ms; the last: the update, one next call and one step
    expect(policy.prediction).toMatchObject({
      kind: "window",
      start: { from: "fault", band: { lo: s(0.1), hi: s(10.51) } },
      end: { from: "heal", band: { lo: s(0.1), hi: s(10.26) } },
      certain: true,
      outcomes: ["denied"],
      propagation: { lo: s(0.1), hi: s(10) },
    });
    // a hold shorter than the first denial can be gives no certain window
    expect(policyWindow(P_LDS, s(10), "a test")).toMatchObject({ certain: false });
    expect(planOf(policy)).toEqual({
      inject: [{ do: "apply", object: policyObject("default") }],
      hold: s(15),
      heal: [{ do: "kubectl", args: ["-n", "{namespace}", "delete", "authorizationpolicy", POLICY] }],
      restore: [{ do: "kubectl", args: ["-n", "{namespace}", "delete", "authorizationpolicy", POLICY, "--ignore-not-found"] }],
    });
  });

  it("gives the reset a window from the fault to the end of the wait of grpc-js in progress at the heal", () => {
    const reset = cell("T15.defaults.12");
    expect(reset.trigger).toEqual({ kind: "rst", hold: s(10) });
    expect(reset.pod).toMatchObject({ replicas: 2, preStop: s(0), grace: s(30) });
    expect(reset.prediction).toEqual(resetWindow(s(10), reset.prediction.why));
    // the heal comes by 12 s after the fault: the connects 0 to 5 can start by then, and not the connect 6
    expect(lastWait(12)).toBe(5);
    expect(lastWait(8.6)).toBe(4);
    expect(lastWait(12.2)).toBe(6);
    // the wait 5: the jitter of 20 % adds up over the waits, thus at most (1.6 × 1.2)^5 s, late by one step
    expect(backoffOf(5).hi).toBeCloseTo(1.92 ** 5 + 0.01, 6);
    expect(reset.prediction).toMatchObject({
      kind: "window",
      nodes: "all",
      start: { from: "fault", band: { lo: s(0), hi: s(0.03) } },
      end: { from: "heal", band: { lo: s(0), hi: s(Math.round(backoffOf(5).hi * 1e6) / 1e6) } },
      certain: true,
      outcomes: ["error", "reset", "refused"],
    });
    expect(reset.prediction.why).toContain("the wait 5: 26.101926 s");
    expect(reset.prediction.why).toContain("h2.rs of ztunnel 1.31.3");
    // the injector in each replica, with the client pods as peers
    expect(planOf(reset)).toEqual({
      inject: [{ do: "inject", target: "servers", action: "rst" }],
      hold: s(10),
      heal: [{ do: "inject", target: "servers", action: "clear-rst" }],
      restore: [],
    });
    expect(propagationSource(reset)).toBe("rules");
  });

  it("gives the black hole a close from the PING of ztunnel, and a window to the next SYN after the heal", () => {
    const hole = cell("T15.defaults.2");
    expect(hole.trigger).toEqual({ kind: "blackhole", hold: s(45) });
    expect(hole.pod).toMatchObject({ replicas: 2, preStop: s(0), grace: s(30) });
    // the timer pong: a PING 10 s after the last PONG, then 20 s for its PONG, late by two steps
    expect(PONG).toEqual({ lo: 20, hi: 30.02 });
    expect(ZTUNNEL_CONNECT).toEqual({ lo: 10, hi: 10.01 });
    // the SYNs of a connect of 10.01 s: 5 waits of 1 s (the linear timeouts of Linux), then a wait of 2 s, thus the last SYN at 7 s.
    // The longest time to the next try is the rest of the connect: at the timeout, a new connect sends its SYN at once
    const gap = longestSynGap(ZTUNNEL_CONNECT.hi);
    const last = [0, 1, 2, 3, 4, 5].reduce((at, k) => at + synWaitOf(k).lo, 0);
    expect(last + synWaitOf(6).lo).toBeGreaterThan(ZTUNNEL_CONNECT.hi);
    expect(gap).toBe(Math.round((ZTUNNEL_CONNECT.hi - last) * 1e6) / 1e6);
    expect(gap).toBeCloseTo(3.016, 6);
    expect(gap).toBeGreaterThan(synWaitOf(5).hi);
    expect(hole.prediction).toMatchObject({
      kind: "ends",
      from: "fault",
      band: { lo: s(20), hi: s(30.03) },
      window: {
        kind: "window",
        nodes: "all",
        start: { from: "fault", band: { lo: s(0), hi: s(0.03) } },
        end: { from: "heal", band: { lo: s(-2), hi: s(Math.round((gap + 0.03) * 1e6) / 1e6) } },
        certain: true,
        outcomes: ["timeout", "error", "reset"],
      },
    });
    const ends = hole.prediction as { readonly why: string; readonly window: { readonly why: string } };
    expect(hole.prediction).toEqual(blackholeWindow(s(45), ends.why, ends.window.why));
    expect(ends.why).toContain("h2.rs of ztunnel 1.31.3");
    expect(ends.window.why).toContain("proxy.rs of ztunnel 1.31.3, line 645");
    // the heal comes by 47 s: at most the connect 2 after the end of the connection, and the wait 2 is shorter than a connect
    expect(backoffOf(2).hi).toBeLessThan(ZTUNNEL_CONNECT.lo);
    expect(() => blackholeWindow(s(60), "a test", "a test")).toThrow(/the wait 4 of grpc-js/);
    expect(() => blackholeWindow(s(30), "a test", "a test")).toThrow(/ends before the PING/);
    const plan = planOf(hole);
    expect([plan.inject, plan.heal]).toEqual([[{ do: "inject", target: "servers", action: "blackhole" }], [{ do: "inject", target: "servers", action: "clear" }]]);
  });

  it("gives the gap no end of a socket: longer than the release of the pool and the keepalive of ztunnel, shorter than each idle timer", () => {
    const gap = cell("T15.defaults.10");
    expect(gap.trigger).toEqual({ kind: "idle", hold: s(330) });
    expect(gap.prediction).toMatchObject({ kind: "ends", from: "fault", band: null });
    expect(gap.prediction.why).toContain("pool.rs");
    expect(gap.prediction.why).toContain("internal-channel.ts of grpc-js 1.14.6");
    expect(gap.prediction.why).toContain("defaults.go of grpc-go v1.84.0");
    const hold = valueIn(gap.trigger.hold!, "s");
    // the release of the pool at 300 s and the keepalive at 180 s come in the gap, and the IDLE of grpc-js at 30 min does not
    expect(hold).toBeGreaterThan(300);
    expect(hold).toBeGreaterThan(180);
    expect(hold).toBeLessThan(1800);
    expect(planOf(gap)).toEqual({
      inject: [{ do: "signal", target: "clients", signal: "SIGUSR1" }],
      hold: s(330),
      heal: [{ do: "signal", target: "clients", signal: "SIGUSR2" }],
      restore: [{ do: "signal", target: "clients", signal: "SIGUSR2" }],
    });
  });

  it("aliases the array cells of the deletion, the policy, the reset, the black hole and the gap to the cells at the defaults", () => {
    expect(T15_GRPC_ALIASES.map((alias) => [alias.plan, alias.is])).toEqual([
      ["T15.array.13", "T15.defaults.13"],
      ["T15.array.5", "T15.defaults.5"],
      ["T15.array.12", "T15.defaults.12"],
      ["T15.array.2", "T15.defaults.2"],
      ["T15.array.10", "T15.defaults.10"],
      ["T15.array.14", "T15.defaults.14"],
    ]);
    expect(T15_GRPC_ALIASES.find((alias) => alias.plan === "T15.array.10")?.why).toContain("workload.proto");
    expect(T15_GRPC_ALIASES.find((alias) => alias.plan === "T15.array.12")?.why).toContain("workload.proto");
    for (const alias of T15_GRPC_ALIASES) expect(() => cell(alias.is), alias.plan).not.toThrow();
  });

  it("labels the namespace for the mesh, and gives each cell its objects and its plan", () => {
    for (const each of T15_GRPC) {
      const namespace = namespaceOf(each);
      const labels = each.mesh?.mode === "ambient" ? { "istio.io/dataplane-mode": "ambient" } : { "istio-injection": "enabled" };
      expect(namespaceObject(each, namespace)).toEqual({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels } });
      expect(serverCluster(namespace)).toBe(`outbound|80||lab.${namespace}.svc.cluster.local`);
      expect(serverObjects(each, namespace, "image").length).toBe(2);
      expect(clientObjects(each, namespace, "image", "10.96.0.1:80").length).toBe(1);
      if (each.trigger.kind === "pod-deletion") expect(planOf(each).inject).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "delete", "pod", "{pod}", "--wait=false"] }]);
    }
    // a cell with no mesh keeps a namespace with no label
    expect(namespaceObject(T07_GRPC[0]!, "lab-x")).toEqual({ apiVersion: "v1", kind: "Namespace", metadata: { name: "lab-x" } });
  });

  it("keeps the cells of iptables of each flavor together in a shard, after the cells with no mesh", () => {
    const catalog = [...T15_GRPC, ...T07_GRPC];
    const one = shardOf(catalog, 0, 1);
    const iptables = one.filter((each) => each.mode === "iptables");
    // each flavor is one run of cells: no mesh, then ambient, then sidecar
    const flavors = iptables.map((each) => each.mesh?.flavor ?? "none");
    expect(flavors.filter((flavor, index) => index === 0 || flavor !== flavors[index - 1])).toEqual(["none", "ambient", "sidecar"]);
    // the install of Istio adds 2 min to the setup of each cluster
    const plain = { ...cell("T15.defaults.13"), mesh: undefined };
    expect(valueIn(estimatedTime(cell("T15.defaults.13")), "s") - valueIn(estimatedTime(plain), "s")).toBe(240);
    // a run of a policy: 25 s at rest, then the hold of 15 s and 20 s after it, in 11 runs and 2 warm-ups
    expect(valueIn(estimatedTime(cell("T15.defaults.5")), "s")).toBe(2 * 180 + 13 * (25 + 35));
    // a run of the reset: 25 s at rest, then the hold, the end of the window, the timeout of 2 s and the noise
    const reset = cell("T15.defaults.12");
    const end = valueIn((reset.prediction as { end: { band: { hi: { value: number; unit: string } } } }).end.band.hi, "s");
    expect(valueIn(estimatedTime(reset), "s")).toBeCloseTo(2 * 180 + 13 * (25 + 10 + end + 2 + 0.1), 1);
    // a run of the black hole: the hold, the end of the window after the heal, the timeout and the noise
    const hole = cell("T15.defaults.2");
    const after = valueIn((hole.prediction as { window: { end: { band: { hi: { value: number; unit: string } } } } }).window.end.band.hi, "s");
    expect(valueIn(estimatedTime(hole), "s")).toBeCloseTo(2 * 180 + 13 * (25 + 45 + after + 2 + 0.1), 1);
    // a run of the gap: 25 s at rest, the gap of 330 s and 5 s after it
    expect(valueIn(estimatedTime(cell("T15.defaults.10")), "s")).toBe(2 * 180 + 13 * (25 + 335));
    // a run of a restart of ztunnel: 25 s at rest, then the grace of 30 s and the removal of the old pods
    for (const id of ["T15.defaults.14", "T15.border-off.85", "T15.border-off.86"]) expect(valueIn(estimatedTime(cell(id)), "s"), id).toBe(2 * 180 + 13 * (25 + 40));
    // a run of a quiet black hole: the hold and 10 s for the stop and the start of the calls
    for (const id of ["T15.border-off.87", "T15.border-off.88"]) expect(valueIn(estimatedTime(cell(id)), "s"), id).toBe(2 * 180 + 13 * (25 + 55));
    // a run of a gap through a middlebox: the gap and 5 s after it
    expect(valueIn(estimatedTime(cell("T15.border-off.79")), "s")).toBe(2 * 180 + 13 * (25 + 125));
    expect(valueIn(estimatedTime(cell("T15.border-off.80")), "s")).toBe(2 * 180 + 13 * (25 + 65));
    expect(valueIn(estimatedTime(cell("T15.border-off.77")), "s")).toBe(2 * 180 + 13 * (25 + 335));
    // a run of a certificate expiry: the hold of 630 s and 20 s for the two reads of the certificates
    expect(valueIn(estimatedTime(cell("T15.border-off.92")), "s")).toBe(2 * 180 + 13 * (25 + 650));
    // With 8 shards, each gap of 330 s and the expiry of 630 s is alone on a shard. The middle of the
    // expiry is past the share of the shard 5, thus that shard is empty.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((index) => shardOf(T15_GRPC, index, 8).map((each) => each.id))).toEqual([
      ["T15.defaults.12", "T15.defaults.2"],
      ["T15.defaults.10", "T15.border-off.79"],
      ["T15.border-off.80", "T15.border-off.87", "T15.border-off.88"],
      ["T15.defaults.14", "T15.border-off.85", "T15.border-off.86"],
      ["T15.border-off.77"],
      [],
      ["T15.border-off.92"],
      ["CAL.T15.sidecar", "T15.defaults.13", "CAL.T15.policy", "T15.defaults.5"],
    ]);
  });
});

describe("the border of O22 of T15, and the cells that wait, step 7", () => {
  it("gives each workload certificate of ztunnel a lifetime of 600 s, renewed 240 s after its issue", () => {
    expect(certificateMesh(CERT_LIFETIME)).toEqual({ ...AMBIENT, ztunnel: { SECRET_TTL: "600s" } });
    // The validity starts 120 s before the issue, thus its middle is (600 + 120) / 2 - 120 s after the issue.
    expect(RENEWAL).toEqual(s(240));
    expect(EXPIRY_HOLD).toEqual(s(630));
    const expiry = cell("T15.border-off.92");
    expect(expiry).toMatchObject({ mesh: { flavor: "ambient", mode: "ambient", ztunnel: { SECRET_TTL: "600s" } }, trigger: { kind: "certificate-expiry", hold: s(630) }, runs: 11 });
    expect(followsZtunnel(expiry)).toBe(true);
    expect(ztunnelEnvArgs(expiry.mesh!.ztunnel!, false)).toEqual(["-n", "istio-system", "set", "env", "daemonset/ztunnel", "SECRET_TTL=600s"]);
    expect(ztunnelEnvArgs(expiry.mesh!.ztunnel!, true)).toEqual(["-n", "istio-system", "set", "env", "daemonset/ztunnel", "SECRET_TTL-"]);
  });

  it("predicts no end of a socket: the hold is past the lifetime of each certificate in use at the fault", () => {
    const expiry = cell("T15.border-off.92");
    expect(expiry.prediction).toMatchObject({ kind: "ends", from: "fault", band: null });
    expect(valueIn(EXPIRY_HOLD, "s")).toBeGreaterThan(valueIn(CERT_LIFETIME, "s"));
    // The read of the certificates is the fault and the heal: the evidence of their lifetime.
    expect(planOf(expiry)).toEqual({ inject: [{ do: "certificates" }], hold: s(630), heal: [{ do: "certificates" }], restore: [] });
    for (const cite of ["config.rs of ztunnel 1.31.3, lines 59, 104 and 868", "ca.go, lines 460–469", "certificate.rs, lines 402–408", "manager.rs, lines 408–431", "O22 is violated"])
      expect(expiry.prediction.why, cite).toContain(cite);
  });

  it("covers each cell of the plan of T15 over gRPC once: a cell, an alias or a cell that waits with its reason", () => {
    const counted = T15_GRPC.filter((each) => !each.calibrates).map((each) => each.id);
    const plan = [...counted, ...T15_GRPC_ALIASES.map((alias) => alias.plan), ...T15_GRPC_WAITING.map((each) => each.plan)];
    expect(counted.length).toBe(14);
    expect(T15_GRPC_WAITING.map((each) => each.plan)).toEqual(["T15.border-off.78", "T15.border-off.91"]);
    expect(plan.length).toBe(22);
    expect(new Set(plan).size).toBe(22);
    expect(T15_GRPC_WAITING.find((each) => each.plan === "T15.border-off.78")?.why).toContain("h2/server.rs, lines 140–186");
    expect(T15_GRPC_WAITING.find((each) => each.plan === "T15.border-off.91")?.why).toContain("config.rs, lines 74–75 and 790–797");
  });
});

describe("the borders of O03, O17 and O02 of T15, step 6", () => {
  it("puts a middlebox of 11 s and of 9 s in each replica, a stand-in for the router of the research, on each side of O03", () => {
    const inside = cell("T15.border-off.79");
    const outside = cell("T15.border-off.80");
    for (const each of [inside, outside]) {
      expect(each.substitutes, each.id).toBe(MIDDLEBOX_HOP);
      expect(each.prediction.why, each.id).toContain("xt_recent.c of Linux v6.17");
      // the middlebox leaves conntrack as it is: istio-cni needs it on the local leg to the app
      expect(each.prediction.why, each.id).not.toContain("nf_conntrack_tcp_loose");
      expect(each.name, each.id).toContain("a stateful middlebox");
      expect(planOf(each).prepare, each.id).toEqual([{ do: "middlebox", target: "servers", idle: each.trigger.middlebox, port: 15008 }]);
      expect(planOf(each).restore.at(-1), each.id).toEqual({ do: "middlebox", target: "servers", idle: null, port: 15008 });
    }
    expect([inside.trigger, outside.trigger]).toEqual([
      { kind: "idle", hold: s(120), middlebox: s(11) },
      { kind: "idle", hold: s(60), middlebox: s(9) },
    ]);
    // the PING at its latest, 10.01 s, against the forget at its earliest
    expect(pingOnMiddlebox(s(11))).toMatchObject({ holds: true, refresh: 10.01, forget: 11 });
    expect(pingOnMiddlebox(s(9))).toMatchObject({ holds: false, refresh: 10.01, forget: 9 });
    expect(pingOnMiddlebox(s(10))).toMatchObject({ holds: false });
    expect(inside.prediction).toMatchObject({ kind: "ends", from: "fault", band: null });
  });

  it("ends the tunnel behind a middlebox of 9 s from the forget and the PING timeout, to a sleep later", () => {
    const outside = cell("T15.border-off.80");
    // the forget after the last call of 20 ms, then the PING timeout; at the latest the signal, the
    // delayed ACK, the forget, the sleep and the PING timeout, with their lateness and one step
    expect(outside.prediction).toMatchObject({ kind: "ends", from: "fault", band: { lo: s(28.98), hi: s(39.73) } });
    expect(SIGNAL_LATE).toEqual(s(0.5));
    expect(() => forgetEnds(s(11), "a test")).toThrow(/O03 holds/);
    // a forget at 9.9 s with a delayed ACK can come after the next PING
    expect(() => forgetEnds(s(9.9), "a test")).toThrow(/after the next PING/);
    expect(valueIn(outside.trigger.hold!, "s")).toBeGreaterThan(39.73 + 10);
  });

  it("moves the give-up of TCP on the PING to each side of the PING timeout with tcp_retries2 6 and 4 (O17)", () => {
    // the first retransmission one or two RTOs after the PING, then the budget of the give-up and its last step
    expect(giveUpAfterPing(6)).toEqual({ lo: 25.6, hi: 54.84 });
    expect(giveUpAfterPing(4)).toEqual({ lo: 6.4, hi: 13.752 });
    // tcp_retries2 5 can give up on either side of the PING timeout of 20 s, thus no cell takes it
    expect(giveUpAfterPing(5).lo).toBeLessThan(20);
    expect(giveUpAfterPing(5).hi).toBeGreaterThan(20);
    const inside = cell("T15.border-off.87");
    const outside = cell("T15.border-off.88");
    expect([inside.trigger, outside.trigger]).toEqual([
      { kind: "blackhole", hold: s(45), quiet: true, retries: 6 },
      { kind: "blackhole", hold: s(45), quiet: true, retries: 4 },
    ]);
    // the PING timeout first: the band of T15.defaults.2
    expect(inside.prediction).toMatchObject({ kind: "ends", from: "fault", band: { lo: s(PONG.lo), hi: s(30.03) } });
    // TCP first: the PING in one sleep after the fault, then the give-up on it and one step
    expect(outside.prediction).toMatchObject({ kind: "ends", from: "fault", band: { lo: s(6.4), hi: s(23.772) } });
    expect(outside.prediction.why).toContain("ETIMEDOUT");
    expect(() => pingFirstEnds(4, "a test")).toThrow(/before its timeout/);
    expect(() => giveUpFirstEnds(6, "a test")).toThrow(/after its timeout/);
    expect(planOf(outside).prepare).toEqual([
      { do: "sysctl", target: "clients", key: "net.ipv4.tcp_retries2", value: "4" },
      { do: "signal", target: "clients", signal: "SIGUSR1" },
      { do: "wait", time: s(1) },
    ]);
    expect(planOf(outside).restore[0]).toEqual({ do: "sysctl", target: "clients", key: "net.ipv4.tcp_retries2", value: "15" });
  });

  it("releases the tunnel 300 s after the checkout of a new channel at the fault, not after the end of its stream (O02)", () => {
    const release = cell("T15.border-off.77");
    expect(release.trigger).toEqual({ kind: "idle", hold: s(330), close: true });
    expect(RELEASE).toEqual({ lo: 300, hi: 300.01 });
    expect(release.prediction).toMatchObject({ kind: "ends", from: "fault", of: "tunnel", band: { lo: s(300), hi: s(300.62) } });
    expect(release.prediction.why).toContain("pool.rs of ztunnel 1.31.3, lines 150–176 and 338–341");
    // the server answers the GOAWAY of the client at once: its FIN can come first, one round trip and one step after the band
    expect(release.prediction).toMatchObject({ answer: { lo: s(300), hi: s(300.631) } });
    expect(release.prediction.why).toContain("proto/connection.rs of h2 0.4.19, lines 309–316, 325–329 and 563–570");
    // a release from the end of the stream, 5 s later, is out of the band and its noise
    expect(300 + valueIn(CHANNEL_USE, "s")).toBeGreaterThan(300.62 + 0.1);
    expect(() => releaseEnds(s(300), "a test")).toThrow(/ends before the release/);
    const plan = planOf(release);
    expect(plan.prepare?.map((step) => (step.do === "signal" ? step.signal : step.do))).toEqual(["SIGHUP", "wait"]);
    expect(plan.inject.map((step) => (step.do === "signal" ? step.signal : step.do))).toEqual(["SIGUSR2", "wait", "SIGHUP"]);
    // the gap of T15.defaults.10 keeps its stream open: the release does not end it
    expect(cell("T15.defaults.10").prediction.why).toContain("lines 142–176 and 338–341");
  });
});

describe("the restarts of ztunnel of T15, step 5", () => {
  it("deletes the ztunnel pod of each node, and waits for the DaemonSet in the restore", () => {
    for (const id of ["T15.defaults.14", "T15.border-off.85", "T15.border-off.86"]) {
      expect(cell(id).trigger, id).toEqual({ kind: "ztunnel-restart" });
      expect(planOf(cell(id)), id).toEqual({
        inject: [{ do: "kubectl", args: ["-n", "istio-system", "delete", "pod", "-l", ZTUNNEL_PODS, "--wait=false"] }],
        hold: null,
        heal: [],
        restore: [{ do: "kubectl", args: ["-n", "istio-system", "rollout", "status", "daemonset/ztunnel", "--timeout=300s"] }],
      });
    }
    expect(ZTUNNEL_PODS).toBe("app=ztunnel");
  });

  it("runs the control with sidecar pods in the ambient flavor, and predicts no failure", () => {
    const control = cell("T15.defaults.14");
    expect(control.mesh).toEqual(SIDECAR_IN_AMBIENT);
    expect(control.mesh).toEqual({ flavor: "ambient", mode: "sidecar" });
    expect(control.prediction).toMatchObject({ kind: "none" });
    expect(control.prediction.why).toContain("informers.go of Istio 1.31.3, line 132");
    // the sidecar namespace, the EDS poll of a sidecar cell, and the lines of the ztunnel pods as the evidence of the restart
    expect(namespaceObject(control, "lab-a")).toMatchObject({ metadata: { labels: { "istio-injection": "enabled" } } });
    expect(propagationSource(control)).toBe("eds");
    expect(followsZtunnel(control)).toBe(true);
  });

  it("gives each border the environment of its deadline, with its undo", () => {
    expect(cell("T15.border-off.85").mesh).toEqual({ flavor: "ambient", mode: "ambient", ztunnel: { CONNECTION_TERMINATION_DEADLINE: "29s" } });
    expect(cell("T15.border-off.86").mesh).toEqual(deadlineMesh(s(31)));
    expect(ztunnelEnvArgs({ CONNECTION_TERMINATION_DEADLINE: "29s" }, false)).toEqual(["-n", "istio-system", "set", "env", "daemonset/ztunnel", "CONNECTION_TERMINATION_DEADLINE=29s"]);
    expect(ztunnelEnvArgs({ B: "2", A: "1" }, true)).toEqual(["-n", "istio-system", "set", "env", "daemonset/ztunnel", "A-", "B-"]);
    // The only other cell of T15 that sets the environment of ztunnel is the border of O22.
    expect(T15_GRPC.filter((each) => each.mesh?.ztunnel !== undefined).map((each) => each.id)).toEqual(["T15.border-off.85", "T15.border-off.86", "T15.border-off.92"]);
  });

  it("ends the drain at the first of the deadline and the grace of 30 s: the two sides of the line of O10", () => {
    expect(drainEnd(s(29))).toEqual({ by: "deadline", span: { lo: 29, hi: 29.01 } });
    expect(drainEnd(s(31))).toEqual({ by: "grace", span: { lo: 30, hi: 30.01 } });
    // the default deadline of 25 s is inside the grace too
    expect(drainEnd(s(25)).by).toBe("deadline");
    expect(drainEnd(s(30)).by).toBe("grace");
  });

  it("gives each border a band of the close after the restart, 1 s apart, and a window of the calls in flight", () => {
    const inside = cell("T15.border-off.85");
    const outside = cell("T15.border-off.86");
    // the timer and its lateness of 10 ms, the SIGTERM 500 ms late at the most, and one step of ztunnel
    expect(TERM_LATE).toEqual(s(0.5));
    expect(inside.prediction).toMatchObject({
      kind: "ends",
      from: "restart",
      band: { lo: s(29), hi: s(29.52) },
      window: {
        kind: "window",
        nodes: "all",
        start: { from: "restart", band: { lo: s(28.98), hi: s(29.52) } },
        end: { from: "restart", band: { lo: s(28.98), hi: s(29.52) } },
        certain: false,
        outcomes: ["error", "reset"],
      },
    });
    expect(outside.prediction).toMatchObject({ kind: "ends", from: "restart", band: { lo: s(30), hi: s(30.52) } });
    const ends = inside.prediction as { readonly why: string; readonly window: { readonly why: string } };
    expect(inside.prediction).toEqual(restartEnds(s(29), ends.why, ends.window.why));
    // the bands do not meet, with δ of 100 ms on each side
    const bandOf = (each: KindCell): { lo: number; hi: number } => {
      const band = (each.prediction as { band: { lo: { value: number; unit: string }; hi: { value: number; unit: string } } }).band;
      return { lo: valueIn(band.lo, "s"), hi: valueIn(band.hi, "s") };
    };
    expect(bandOf(outside).lo - 0.1).toBeGreaterThan(bandOf(inside).hi + 0.1);
    expect(inside.prediction.why).toContain("The law O10 holds");
    expect(outside.prediction.why).toContain("The law O10 is violated");
    expect(outside.prediction.why).toContain("kuberuntime_container.go of Kubernetes v1.37.0");
    expect(ends.window.why).toContain("daemon_controller.go, lines 863–924");
  });
});
