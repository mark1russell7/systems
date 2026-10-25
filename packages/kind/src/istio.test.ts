import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { KindCell } from "./cell.ts";
import { cellOf } from "./cells.fixture.ts";
import { clusterFilter, hostsOf, outboundCluster } from "./eds.ts";
import { CHANNEL_USE, CLIENT_ACCOUNT, CLOSE_LEAD, NETNS_DEFAULTS, POLICY, QUIET_LEAD, SYSCTL, deletes, middleboxCommands, planOf, policyObject, sysctlCommand } from "./faults.ts";
import {
  ACCESS_LOG_FORMAT,
  ISTIO_IMAGES,
  ISTIO_VERSION,
  LDS_EVERY,
  MESH_IMAGES,
  MESH_WORKLOADS,
  followsZtunnel,
  istioOperator,
  meshKey,
  pollsListeners,
  serverCluster,
  ztunnelEnvArgs,
} from "./istio.ts";
import { LDS_FILTER, listenerCountsOf } from "./lds.ts";
import { clientObjects, namespaceObject } from "./manifests.ts";
import { keptKernel } from "./lab.ts";
import { HBONE_PORT, TCP_STATE, restartOf, tunnelsOf, ztunnelReplaced } from "./observe.ts";
import { referenceOf } from "./verdict.ts";
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
    // the watcher follows ztunnel in the flavor ambient: sidecar pods there need the lines of a restart of ztunnel too
    expect(followsZtunnel({ mesh: AMBIENT })).toBe(true);
    expect(followsZtunnel({ mesh: SIDECAR })).toBe(false);
    expect(followsZtunnel({ mesh: { flavor: "ambient", mode: "sidecar" } })).toBe(true);
    expect(followsZtunnel({})).toBe(false);
  });

  it("sets the environment of ztunnel for a cell and removes it after, and reads the restart from the lines of the ztunnel pods", () => {
    expect(ztunnelEnvArgs({ CONNECTION_TERMINATION_DEADLINE: "29s" }, false)).toEqual(["-n", "istio-system", "set", "env", "daemonset/ztunnel", "CONNECTION_TERMINATION_DEADLINE=29s"]);
    expect(ztunnelEnvArgs({ CONNECTION_TERMINATION_DEADLINE: "29s" }, true)).toEqual(["-n", "istio-system", "set", "env", "daemonset/ztunnel", "CONNECTION_TERMINATION_DEADLINE-"]);
    const pod = (t: number, name: string, node: string, del: boolean, ready: boolean, type = "MODIFIED") => ({ ev: "ztunnel-pod", t, type, name, node, ip: null, del, cs: [{ n: "istio-proxy", r: ready, rc: 0, st: "running", id: null }] });
    const nodes = ["a", "b"];
    const lines = [
      pod(1000, "zt-a", "a", true, true),
      pod(1010, "zt-b", "b", true, true),
      pod(1200, "zt-a2", "a", false, false, "ADDED"),
      pod(1300, "zt-b2", "b", false, false, "ADDED"),
      pod(3000, "zt-a2", "a", false, true),
      pod(3100, "zt-b2", "b", false, true),
    ];
    // the reference is the first deletion after the start of the run
    expect(restartOf(lines, 0)).toBe(1000);
    expect(restartOf(lines, 1005)).toBe(1010);
    expect(restartOf([], 0)).toBeNull();
    expect(referenceOf({ start: 0, acts: { fault: 900, heal: null, resume: null }, target: null, lines }, "restart")).toBe(1000);
    // the new pods are ready, and the old pods are not gone yet: the restart is not over
    expect(ztunnelReplaced(lines, nodes)).toBe(false);
    const gone = [...lines, pod(31_000, "zt-a", "a", true, false, "DELETED"), pod(31_100, "zt-b", "b", true, false, "DELETED")];
    expect(ztunnelReplaced(gone, nodes)).toBe(true);
    // a node with no ready new pod, or no deletion at all
    expect(ztunnelReplaced(gone, [...nodes, "c"])).toBe(false);
    expect(ztunnelReplaced(lines.slice(2), nodes)).toBe(false);
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

  const s = (value: number) => ({ value, unit: "s" }) as const;
  const gapOf = (trigger: KindCell["trigger"]): KindCell => ({ ...cellOf("idle"), template: "T15", stack: "grpc", mesh: AMBIENT, declaration: null, trigger });

  it("puts a middlebox in each replica before a gap, and removes it after the run", () => {
    expect(planOf(gapOf({ kind: "idle", hold: s(60), middlebox: s(9) }))).toEqual({
      prepare: [{ do: "middlebox", target: "servers", idle: s(9), port: HBONE_PORT }],
      inject: [{ do: "signal", target: "clients", signal: "SIGUSR1" }],
      hold: s(60),
      heal: [{ do: "signal", target: "clients", signal: "SIGUSR2" }],
      restore: [
        { do: "signal", target: "clients", signal: "SIGUSR2" },
        { do: "middlebox", target: "servers", idle: null, port: HBONE_PORT },
      ],
    });
  });

  it("gives each client a new channel at the fault of a gap with close, and closes it before the gap", () => {
    const hup = { do: "signal", target: "clients", signal: "SIGHUP" } as const;
    const usr2 = { do: "signal", target: "clients", signal: "SIGUSR2" } as const;
    expect(planOf(gapOf({ kind: "idle", hold: s(330), close: true }))).toEqual({
      prepare: [hup, { do: "wait", time: CLOSE_LEAD }],
      // the first act, the new channel, is the fault
      inject: [usr2, { do: "wait", time: CHANNEL_USE }, hup],
      hold: s(330),
      heal: [usr2],
      restore: [usr2],
    });
  });

  it("stops the calls before a quiet black hole, sets tcp_retries2 of each client pod, and puts both back", () => {
    const hole = gapOf({ kind: "blackhole", hold: s(45), quiet: true, retries: 4 });
    const usr2 = { do: "signal", target: "clients", signal: "SIGUSR2" } as const;
    expect(planOf(hole)).toEqual({
      prepare: [
        { do: "sysctl", target: "clients", key: SYSCTL.retries, value: "4" },
        { do: "signal", target: "clients", signal: "SIGUSR1" },
        { do: "wait", time: QUIET_LEAD },
      ],
      inject: [{ do: "inject", target: "servers", action: "blackhole" }],
      hold: s(45),
      heal: [{ do: "inject", target: "servers", action: "clear" }, usr2],
      restore: [{ do: "sysctl", target: "clients", key: SYSCTL.retries, value: NETNS_DEFAULTS.retries }, usr2],
    });
    // a black hole with neither keeps the plan of T15.defaults.2: no prepare
    expect(planOf(gapOf({ kind: "blackhole", hold: s(45) })).prepare).toBeUndefined();
    expect(() => planOf(gapOf({ kind: "blackhole", hold: s(45), retries: 0 }))).toThrow(/tcp_retries2 is a count from 1 to 255/);
  });
});

describe("the commands of the injector in a namespace", () => {
  it("sets the conntrack middlebox with the sysctls first, and removes it with the defaults first", () => {
    const set = middleboxCommands(["10.244.1.9", "10.244.2.9"], { value: 9, unit: "s" }, 15008);
    expect(set.slice(0, 2)).toEqual([
      ["sysctl", "-w", "net.netfilter.nf_conntrack_tcp_timeout_established=9"],
      ["sysctl", "-w", "net.netfilter.nf_conntrack_tcp_loose=0"],
    ]);
    expect(set[2]).toEqual(["iptables", "-I", "INPUT", "-s", "10.244.1.9/32", "-p", "tcp", "--dport", "15008", "-m", "conntrack", "--ctstate", "INVALID", "-j", "DROP"]);
    expect(set[3]).toEqual(["iptables", "-I", "OUTPUT", "-d", "10.244.1.9/32", "-p", "tcp", "--sport", "15008", "-m", "conntrack", "--ctstate", "INVALID", "-j", "DROP"]);
    expect(set).toHaveLength(6);
    const clear = middleboxCommands(["10.244.1.9"], null, 15008);
    expect(clear.slice(0, 2)).toEqual([
      ["sysctl", "-w", `net.netfilter.nf_conntrack_tcp_timeout_established=${NETNS_DEFAULTS.established}`],
      ["sysctl", "-w", `net.netfilter.nf_conntrack_tcp_loose=${NETNS_DEFAULTS.loose}`],
    ]);
    expect(clear.slice(2).map((argv) => argv[1])).toEqual(["-D", "-D"]);
  });

  it("refuses a word that is not plain: an address, a port, a time or a sysctl", () => {
    expect(() => middleboxCommands(["10.244.1.9; reboot"], { value: 9, unit: "s" }, 15008)).toThrow(/not an address/);
    expect(() => middleboxCommands([], { value: 9, unit: "s" }, 15008)).toThrow(/needs a peer/);
    expect(() => middleboxCommands(["10.244.1.9"], { value: 9.5, unit: "s" }, 15008)).toThrow(/a whole number of seconds/);
    expect(() => middleboxCommands(["10.244.1.9"], { value: 9, unit: "s" }, 0)).toThrow(/not a port/);
    expect(sysctlCommand("net.ipv4.tcp_retries2", "6")).toEqual(["sysctl", "-w", "net.ipv4.tcp_retries2=6"]);
    expect(() => sysctlCommand("kernel.panic", "1")).toThrow(/not a sysctl of a network namespace/);
    expect(() => sysctlCommand("net.ipv4.tcp_retries2", "6 && reboot")).toThrow(/not a whole number/);
  });

  it("keeps each change of the state of a socket of the HBONE port, and drops the others", () => {
    expect(keptKernel({ ev: "state", src: "10.244.1.9:51000", dst: "10.244.2.4:15008", old: 1, new: 4 })).toBe(true);
    expect(keptKernel({ ev: "state", src: "10.244.2.4:15008", dst: "10.244.1.9:51000", old: 1, new: 8 })).toBe(true);
    expect(keptKernel({ ev: "state", src: "10.244.1.9:51000", dst: "10.244.2.4:8080", old: 1, new: 4 })).toBe(false);
    expect(keptKernel({ ev: "retrans" })).toBe(true);
    expect(keptKernel({ ev: "tx" })).toBe(false);
    const lines = [
      { ev: "kernel.state", t: 20, src: "10.244.1.9:51000", dst: "10.244.2.4:15008", old: 1, new: 4 },
      { ev: "kernel.retrans", t: 5 },
      { ev: "kernel.state", t: 10, src: "10.244.1.9:51000", dst: "10.244.2.4:15008", old: 2, new: 1 },
    ];
    expect(tunnelsOf(lines).map((line) => line.t)).toEqual([10, 20]);
    expect(TCP_STATE).toEqual({ established: 1, finWait1: 4, closeWait: 8 });
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
