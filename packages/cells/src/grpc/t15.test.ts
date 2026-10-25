import type { KindCell } from "@mark1russell7/kind";
import { clientObjects, estimatedTime, namespaceObject, namespaceOf, planOf, propagationSource, serverCluster, serverObjects, shardOf } from "@mark1russell7/kind";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { s } from "../kind.ts";
import { T07_GRPC } from "./t07.ts";
import { SIDECAR, T15_GRPC, T15_GRPC_ALIASES } from "./t15.ts";

const cell = (id: string): KindCell => {
  const found = T15_GRPC.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no cell ${id}`);
  return found;
};

describe("the gRPC catalog of T15, step 1", () => {
  it("has the calibration of the sidecar and the deletion, each in the sidecar mesh, and each name once", () => {
    expect(T15_GRPC.map((each) => each.id)).toEqual(["CAL.T15.sidecar", "T15.defaults.13"]);
    expect(new Set(T15_GRPC.map((each) => each.name)).size).toBe(T15_GRPC.length);
    expect(new Set(T15_GRPC.map(namespaceOf)).size).toBe(T15_GRPC.length);
    for (const each of T15_GRPC) {
      // the workflow selects the catalog with only='^T15'
      expect(each.name, each.id).toMatch(/^T15 sidecar, gRPC, /);
      expect(each, each.name).toMatchObject({ template: "T15", stack: "grpc", mesh: { flavor: "sidecar", mode: "sidecar" }, declaration: null, mode: "iptables", runs: 11 });
      expect(each.trigger.kind, each.name).toBe("pod-deletion");
      expect(each.prediction.why.length, each.name).toBeGreaterThan(10);
      expect(propagationSource(each), each.name).toBe("eds");
    }
  });

  it("calibrates the push of EDS with a preStop sleep that outlasts it", () => {
    const calibration = cell("CAL.T15.sidecar");
    expect(calibration.calibrates).toBe(true);
    expect(calibration.prediction.kind).toBe("none");
    expect(calibration.pod).toMatchObject({ replicas: 2, preStop: s(10), grace: s(40) });
  });

  it("measures the deletion at the defaults of Kubernetes and Istio, until a calibration gives its band", () => {
    const deletion = cell("T15.defaults.13");
    expect(deletion.calibrates).toBe(false);
    expect(deletion.prediction.kind).toBe("measured");
    expect(deletion.pod).toMatchObject({ replicas: 2, preStop: s(0), grace: s(30) });
    expect(valueIn(deletion.workload.timeout, "s")).toBe(2);
    expect(T15_GRPC_ALIASES).toEqual([expect.objectContaining({ plan: "T15.array.13", is: "T15.defaults.13" })]);
    for (const alias of T15_GRPC_ALIASES) expect(() => cell(alias.is), alias.plan).not.toThrow();
  });

  it("labels the namespace for the injector, and gives each cell its objects and its plan", () => {
    for (const each of T15_GRPC) {
      const namespace = namespaceOf(each);
      expect(namespaceObject(each, namespace)).toEqual({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels: { "istio-injection": "enabled" } } });
      expect(serverCluster(namespace)).toBe(`outbound|80||lab.${namespace}.svc.cluster.local`);
      expect(serverObjects(each, namespace, "image").length).toBe(2);
      expect(clientObjects(each, namespace, "image", "10.96.0.1:80").length).toBe(1);
      expect(planOf(each).inject).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "delete", "pod", "{pod}", "--wait=false"] }]);
    }
    // a cell with no mesh keeps a namespace with no label
    expect(namespaceObject(T07_GRPC[0]!, "lab-x")).toEqual({ apiVersion: "v1", kind: "Namespace", metadata: { name: "lab-x" } });
  });

  it("keeps the sidecar cells of iptables together in a shard, after the cells with no mesh", () => {
    const catalog = [...T15_GRPC, ...T07_GRPC];
    const one = shardOf(catalog, 0, 1);
    const iptables = one.filter((each) => each.mode === "iptables");
    const first = iptables.findIndex((each) => each.mesh !== undefined);
    expect(iptables.slice(first).every((each) => each.mesh === SIDECAR)).toBe(true);
    expect(iptables.slice(0, first).every((each) => each.mesh === undefined)).toBe(true);
    // the install of Istio adds 2 min to the setup of each cluster
    const plain = { ...cell("T15.defaults.13"), mesh: undefined };
    expect(valueIn(estimatedTime(cell("T15.defaults.13")), "s") - valueIn(estimatedTime(plain), "s")).toBe(240);
  });
});
