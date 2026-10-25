import type { KindCell } from "@mark1russell7/kind";
import {
  LAST_SLACK,
  POLICY,
  clientObjects,
  estimatedTime,
  namespaceObject,
  namespaceOf,
  planOf,
  policyObject,
  pollsListeners,
  propagationSource,
  serverCluster,
  serverObjects,
  shardOf,
} from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { PROPAGATION, calibrated, ms, s } from "../kind.ts";
import { T07_GRPC } from "./t07.ts";
import { backoffOf, lastWait } from "./t07.ts";
import { AMBIENT, EDS_CALIBRATION, NEXT_CALL, P_EDS, P_LDS, SIDECAR, T15_GRPC, T15_GRPC_ALIASES, policyWindow, resetWindow, sidecarDeletion } from "./t15.ts";

const cell = (id: string): KindCell => {
  const found = T15_GRPC.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no cell ${id}`);
  return found;
};

/** These are the cells of the sidecar mesh: steps 1 and 2. */
const SIDECAR_CELLS = T15_GRPC.filter((each) => each.mesh === SIDECAR);

describe("the gRPC catalog of T15, steps 2 and 3", () => {
  it("has the calibrations, the deletion and the policy, each in the sidecar mesh, the reset in the ambient mesh, and each name once", () => {
    expect(T15_GRPC.map((each) => each.id)).toEqual(["CAL.T15.sidecar", "T15.defaults.13", "CAL.T15.policy", "T15.defaults.5", "T15.defaults.12"]);
    expect(T15_GRPC.filter((each) => each.mesh === AMBIENT).map((each) => each.id)).toEqual(["T15.defaults.12"]);
    expect(new Set(T15_GRPC.map((each) => each.name)).size).toBe(T15_GRPC.length);
    expect(new Set(T15_GRPC.map(namespaceOf)).size).toBe(T15_GRPC.length);
    for (const each of SIDECAR_CELLS) {
      // the workflow selects the catalog with only='^T15'
      expect(each.name, each.id).toMatch(/^T15 sidecar, gRPC, /);
      expect(each, each.name).toMatchObject({ template: "T15", stack: "grpc", mesh: { flavor: "sidecar", mode: "sidecar" }, declaration: null, mode: "iptables", runs: 11 });
      expect(each.prediction.why.length, each.name).toBeGreaterThan(10);
      expect(propagationSource(each), each.name).toBe("eds");
    }
    for (const each of T15_GRPC.filter((one) => one.mesh === AMBIENT)) {
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

  it("aliases the array cells of the deletion, the policy and the reset to the cells at the defaults", () => {
    expect(T15_GRPC_ALIASES.map((alias) => [alias.plan, alias.is])).toEqual([
      ["T15.array.13", "T15.defaults.13"],
      ["T15.array.5", "T15.defaults.5"],
      ["T15.array.12", "T15.defaults.12"],
    ]);
    expect(T15_GRPC_ALIASES.find((alias) => alias.plan === "T15.array.12")?.why).toContain("workload.proto");
    for (const alias of T15_GRPC_ALIASES) expect(() => cell(alias.is), alias.plan).not.toThrow();
  });

  it("labels the namespace for the mesh, and gives each cell its objects and its plan", () => {
    for (const each of T15_GRPC) {
      const namespace = namespaceOf(each);
      const labels = each.mesh === AMBIENT ? { "istio.io/dataplane-mode": "ambient" } : { "istio-injection": "enabled" };
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
  });
});
