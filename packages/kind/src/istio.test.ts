import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { KindCell } from "./cell.ts";
import { cellOf } from "./cells.fixture.ts";
import { clusterFilter, hostsOf, outboundCluster } from "./eds.ts";
import { CLIENT_ACCOUNT, POLICY, deletes, planOf, policyObject } from "./faults.ts";
import { ACCESS_LOG_FORMAT, ISTIO_IMAGES, ISTIO_VERSION, LDS_EVERY, MESH_IMAGES, MESH_WORKLOADS, followsZtunnel, istioOperator, meshKey, pollsListeners, serverCluster } from "./istio.ts";
import { LDS_FILTER, listenerCountsOf } from "./lds.ts";
import { clientObjects, namespaceObject } from "./manifests.ts";
import type { Tool } from "./tools.ts";
import { ISTIOCTL, ensureTool, sha256, tarEntry, toolPath } from "./tools.ts";

/** a tar file of entries in the ustar format: a header of 512 bytes, then the data in blocks of 512 */
const tarOf = (entries: ReadonlyArray<readonly [string, string, string?]>): Uint8Array => {
  const blocks: Buffer[] = [];
  for (const [name, data, type = "0"] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "latin1");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write(type, 156, "latin1");
    header.write("ustar\0", 257, "latin1");
    blocks.push(header, Buffer.from(data, "latin1"), Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
};

const IMAGES = { pilot: "systems-lab/pilot:1.31.3-6ad1e816c4d4", proxy: "systems-lab/proxyv2:1.31.3-eb74eacea98d" };
const AMBIENT_IMAGES = { ...IMAGES, cni: "systems-lab/install-cni:1.31.3-e98782038634", ztunnel: "systems-lab/ztunnel:1.31.3-2c27371b3139" };
const SIDECAR = { flavor: "sidecar", mode: "sidecar" } as const;
const AMBIENT = { flavor: "ambient", mode: "ambient" } as const;

describe("the install of Istio", () => {
  it("pins each image of each flavor by digest, at the version of istioctl", () => {
    for (const image of Object.values(ISTIO_IMAGES)) expect(image).toMatch(new RegExp(`^istio/[a-z0-9-]+:${ISTIO_VERSION.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$`));
    expect(MESH_IMAGES.sidecar).toEqual(["pilot", "proxy"]);
    expect(MESH_IMAGES.ambient).toEqual(["pilot", "proxy", "cni", "ztunnel"]);
    expect(Object.keys(ISTIO_IMAGES).sort()).toEqual([...MESH_IMAGES.ambient].sort());
    expect(ISTIOCTL.version).toBe(ISTIO_VERSION);
    for (const key of ["linux-x64", "linux-arm64", "darwin-arm64"]) {
      expect(ISTIOCTL.assets[key]?.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(ISTIOCTL.assets[key]?.url, key).toContain(`/releases/download/${ISTIO_VERSION}/istioctl-${ISTIO_VERSION}-`);
    }
  });

  it("installs istiod only, with each image as a full reference that no node pulls", () => {
    const operator = istioOperator("sidecar", IMAGES) as { spec: { profile: string; meshConfig: Record<string, string>; values: Record<string, Record<string, unknown>> } };
    expect(operator.spec.profile).toBe("minimal");
    expect(operator.spec.values["global"]).toEqual({ imagePullPolicy: "Never", proxy: { image: IMAGES.proxy }, proxy_init: { image: IMAGES.proxy } });
    expect(operator.spec.values["pilot"]).toMatchObject({ image: IMAGES.pilot, autoscaleEnabled: false, replicaCount: 1 });
    // the charts use a value with a "/" as it is: a name with no "/" gets the hub and the tag of the chart
    for (const image of Object.values(IMAGES)) expect(image).toContain("/");
    expect(operator.spec.meshConfig).toMatchObject({ accessLogFile: "/dev/stdout", accessLogEncoding: "JSON" });
    // the watcher reads these fields of each access line
    expect(JSON.parse(operator.spec.meshConfig["accessLogFormat"]!)).toMatchObject({ code: "%RESPONSE_CODE%", flags: "%RESPONSE_FLAGS%", grpc: "%GRPC_STATUS_NUMBER%", attempts: "%UPSTREAM_REQUEST_ATTEMPT_COUNT%" });
    expect(Object.keys(ACCESS_LOG_FORMAT)).toContain("host");
    expect(operator.spec.values["cni"]).toBeUndefined();
    expect(operator.spec.values["ztunnel"]).toBeUndefined();
    expect(MESH_WORKLOADS.sidecar).toEqual(["deployment/istiod"]);
  });

  it("installs istiod, istio-cni and ztunnel for the flavor ambient, each image a full reference that no node pulls", () => {
    const operator = istioOperator("ambient", AMBIENT_IMAGES) as { spec: { profile: string; values: Record<string, Record<string, unknown>> } };
    expect(operator.spec.profile).toBe("ambient");
    expect(operator.spec.values["global"]).toEqual({ imagePullPolicy: "Never", proxy: { image: IMAGES.proxy }, proxy_init: { image: IMAGES.proxy } });
    expect(operator.spec.values["pilot"]).toMatchObject({ image: IMAGES.pilot, replicaCount: 1, resources: { requests: { cpu: "500m", memory: "256Mi" } } });
    // istio-cni takes the pull policy of global; the chart of ztunnel reads only its own
    expect(operator.spec.values["cni"]).toEqual({ image: AMBIENT_IMAGES.cni });
    expect(operator.spec.values["ztunnel"]).toEqual({ image: AMBIENT_IMAGES.ztunnel, imagePullPolicy: "Never" });
    for (const image of Object.values(AMBIENT_IMAGES)) expect(image).toContain("/");
    // the install waits for istio-cni and ztunnel on each node too
    expect(MESH_WORKLOADS.ambient).toEqual(["deployment/istiod", "daemonset/istio-cni-node", "daemonset/ztunnel"]);
    expect(() => istioOperator("ambient", IMAGES)).toThrow(/istio-cni and ztunnel/);
  });

  it("gives a cell with a mesh its flavor as the key of its cluster, and a labeled namespace", () => {
    expect(meshKey(cellOf("pod-deletion"))).toBe("none");
    expect(meshKey({ mesh: SIDECAR })).toBe("sidecar");
    expect(meshKey({ mesh: AMBIENT })).toBe("ambient");
    expect(namespaceObject({ mesh: SIDECAR }, "lab-a")).toMatchObject({ metadata: { name: "lab-a", labels: { "istio-injection": "enabled" } } });
    expect(namespaceObject({ mesh: { flavor: "ambient", mode: "sidecar" } }, "lab-a")).toMatchObject({ metadata: { labels: { "istio-injection": "enabled" } } });
    expect(namespaceObject({ mesh: AMBIENT }, "lab-a")).toEqual({ apiVersion: "v1", kind: "Namespace", metadata: { name: "lab-a", labels: { "istio.io/dataplane-mode": "ambient" } } });
    expect(namespaceObject({}, "lab-a")).toEqual({ apiVersion: "v1", kind: "Namespace", metadata: { name: "lab-a" } });
    // the watcher follows ztunnel only for the pods of the ambient mode
    expect(followsZtunnel({ mesh: AMBIENT })).toBe(true);
    expect(followsZtunnel({ mesh: SIDECAR })).toBe(false);
    expect(followsZtunnel({ mesh: { flavor: "ambient", mode: "sidecar" } })).toBe(false);
    expect(followsZtunnel({})).toBe(false);
  });

  it("resets the mesh leg in T15: the injector in each replica, with the client pods as peers, and Redis elsewhere", () => {
    const ambient: KindCell = { ...cellOf("rst"), template: "T15", stack: "grpc", mesh: AMBIENT, declaration: null, trigger: { kind: "rst", hold: { value: 10, unit: "s" } } };
    expect(planOf(ambient)).toEqual({
      inject: [{ do: "inject", target: "servers", action: "rst" }],
      hold: { value: 10, unit: "s" },
      heal: [{ do: "inject", target: "servers", action: "clear-rst" }],
      restore: [],
    });
    const hole = planOf({ ...ambient, trigger: { kind: "blackhole", hold: { value: 45, unit: "s" } } });
    expect([hole.inject, hole.heal]).toEqual([[{ do: "inject", target: "servers", action: "blackhole" }], [{ do: "inject", target: "servers", action: "clear" }]]);
    // T18 keeps Redis as the target, with the replicas as peers
    expect(planOf(cellOf("rst", undefined, "T18")).inject).toEqual([{ do: "inject", target: "redis", action: "rst" }]);
    expect(() => planOf({ ...ambient, trigger: { kind: "rst" } })).toThrow(/a hold/);
  });

  it("stops the calls of each client for the hold of a gap, and starts them again at the heal and at the restore", () => {
    const gap: KindCell = { ...cellOf("idle"), template: "T15", stack: "grpc", mesh: AMBIENT, declaration: null, trigger: { kind: "idle", hold: { value: 330, unit: "s" } } };
    expect(planOf(gap)).toEqual({
      inject: [{ do: "signal", target: "clients", signal: "SIGUSR1" }],
      hold: { value: 330, unit: "s" },
      heal: [{ do: "signal", target: "clients", signal: "SIGUSR2" }],
      restore: [{ do: "signal", target: "clients", signal: "SIGUSR2" }],
    });
    expect(deletes(gap)).toBe(false);
    expect(() => planOf({ ...gap, trigger: { kind: "idle" } })).toThrow(/a hold, the time of the gap/);
  });
});

describe("the hosts of a cluster in a sidecar", () => {
  const cluster = serverCluster("lab-abc");
  const text = [
    `${cluster}::observability_name::${cluster}`,
    `${cluster}::default_priority::max_connections::4294967295`,
    `${cluster}::10.244.2.4:8080::cx_active::1`,
    `${cluster}::10.244.2.4:8080::health_flags::healthy`,
    `${cluster}::10.244.1.3:8080::health_flags::healthy`,
    `${cluster}::10.244.3.9:8080::health_flags::/failed_eds_health`,
    "outbound|80||other.lab-abc.svc.cluster.local::10.244.9.9:8080::health_flags::healthy",
    "",
  ].join("\n");

  it("names the outbound cluster of the Service of a cell, and selects it alone with a filter of RE2", () => {
    expect(cluster).toBe("outbound|80||lab.lab-abc.svc.cluster.local");
    expect(outboundCluster("lab", "lab-abc", 80)).toBe(cluster);
    const filter = new RegExp(clusterFilter(cluster));
    expect(filter.test(cluster)).toBe(true);
    expect(filter.test("outbound|80||lab.lab-abc.svc.cluster.local.other")).toBe(false);
    expect(filter.test("outbound|8080||lab.lab-abc.svc.cluster.local")).toBe(false);
  });

  it("gives the healthy hosts in sequence, and each other host with its flags", () => {
    expect(hostsOf(text, cluster)).toEqual({ b: ["10.244.1.3:8080", "10.244.2.4:8080"], u: { "10.244.3.9:8080": "/failed_eds_health" } });
    expect(hostsOf("", cluster)).toEqual({ b: [], u: {} });
  });
});

describe("the trigger authorization-policy", () => {
  const policyCell = (account?: string): KindCell => ({
    ...cellOf("authorization-policy"),
    template: "T15",
    stack: "grpc",
    mesh: SIDECAR,
    trigger: { kind: "authorization-policy", hold: { value: 15, unit: "s" }, ...(account === undefined ? {} : { account }) },
  });

  it("applies a DENY policy on the server pods for the principal of the clients, and deletes it after the hold", () => {
    const plan = planOf(policyCell());
    expect(plan.inject).toEqual([{ do: "apply", object: policyObject(CLIENT_ACCOUNT) }]);
    expect(plan.hold).toEqual({ value: 15, unit: "s" });
    expect(plan.heal).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "delete", "authorizationpolicy", POLICY] }]);
    expect(plan.restore).toEqual([{ do: "kubectl", args: ["-n", "{namespace}", "delete", "authorizationpolicy", POLICY, "--ignore-not-found"] }]);
    expect(deletes(policyCell())).toBe(false);
    // the clients run as the service account default: their pods name no other account
    expect(CLIENT_ACCOUNT).toBe("default");
    for (const pod of clientObjects(policyCell(), "lab-a", "systems-lab:test", "10.96.0.10:80").filter((object) => (object as { kind: string }).kind === "DaemonSet"))
      expect(JSON.stringify(pod)).not.toContain("serviceAccountName");
  });

  it("names the policy of Istio 1.31.3: security.istio.io/v1, the selector of the server and the principal of an account", () => {
    expect(policyObject("default")).toEqual({
      apiVersion: "security.istio.io/v1",
      kind: "AuthorizationPolicy",
      metadata: { name: "lab-deny", namespace: "{namespace}" },
      spec: {
        selector: { matchLabels: { app: "lab" } },
        action: "DENY",
        rules: [{ from: [{ source: { principals: ["cluster.local/ns/{namespace}/sa/default"] } }] }],
      },
    });
    // a calibration denies an account that no pod has: the policy changes, and no call fails
    expect(JSON.stringify(planOf(policyCell("lab-absent")).inject)).toContain("cluster.local/ns/{namespace}/sa/lab-absent");
    expect(() => planOf({ ...policyCell(), trigger: { kind: "authorization-policy" } })).toThrow(/a hold/);
  });

  it("polls the LDS updates of the server sidecars only for a policy in a sidecar mesh", () => {
    expect(pollsListeners(policyCell())).toBe(true);
    expect(pollsListeners({ trigger: policyCell().trigger })).toBe(false);
    expect(pollsListeners({ mesh: SIDECAR, trigger: { kind: "pod-deletion" } })).toBe(false);
    expect(LDS_EVERY).toEqual({ value: 50, unit: "ms" });
  });

  it("reads the two counters of the listener manager from the text of /stats, with a filter that selects them alone", () => {
    const filter = new RegExp(LDS_FILTER);
    expect(filter.test("listener_manager.listener_modified")).toBe(true);
    expect(filter.test("listener_manager.listener_in_place_updated")).toBe(true);
    expect(filter.test("listener_manager.listener_added")).toBe(false);
    expect(filter.test("listener_manager.listener_modified.other")).toBe(false);
    const text = "listener_manager.listener_in_place_updated: 2\nlistener_manager.listener_modified: 5\n";
    expect(listenerCountsOf(text)).toEqual({ mod: 5, inPlace: 2 });
    expect(listenerCountsOf("listener_manager.listener_modified: 1\n")).toEqual({ mod: 1, inPlace: 0 });
    expect(listenerCountsOf("")).toBeNull();
  });
});

describe("istioctl from its tar file", () => {
  it("takes one file from a gzipped tar file, by the last part of its name", () => {
    const tar = tarOf([
      ["./", "", "5"],
      ["./LICENSE", "a license"],
      ["./istioctl", "the binary"],
    ]);
    expect(Buffer.from(tarEntry(tar, "istioctl")).toString()).toBe("the binary");
    expect(() => tarEntry(tar, "kubectl")).toThrow(/no file kubectl/);
  });

  it("keeps the tar file in the cache, examines it at each use, and writes the tool again when it changed", async () => {
    const cache = mkdtempSync(join(tmpdir(), "kind-istioctl-"));
    const tar = tarOf([["istioctl", "the binary"]]);
    const tool: Tool = { name: "istioctl", version: "0", entry: "istioctl", assets: { "linux-x64": { url: "https://example.invalid/istioctl.tar.gz", sha256: sha256(tar) } } };
    const path = toolPath(tool, "linux-x64", cache);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(`${path}.tar.gz`, tar);
    await expect(ensureTool(tool, "linux-x64", cache)).resolves.toBe(path);
    expect(readFileSync(path, "utf8")).toBe("the binary");
    writeFileSync(path, "another binary");
    await ensureTool(tool, "linux-x64", cache);
    expect(readFileSync(path, "utf8")).toBe("the binary");
    writeFileSync(`${path}.tar.gz`, tarOf([["istioctl", "a changed binary"]]));
    await expect(ensureTool(tool, "linux-x64", cache)).rejects.toThrow(/not the pinned/);
  });
});
