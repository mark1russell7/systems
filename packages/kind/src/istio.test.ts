import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { KindCell } from "./cell.ts";
import { cellOf } from "./cells.fixture.ts";
import { clusterFilter, hostsOf, outboundCluster } from "./eds.ts";
import { CHANNEL_USE, CLIENT_ACCOUNT, CLOSE_LEAD, MIDDLEBOX, NETNS_DEFAULTS, POLICY, QUIET_LEAD, SYSCTL, deletes, middleboxCommands, planOf, policyObject, sysctlCommand } from "./faults.ts";
import {
  ACCESS_LOG_FORMAT,
  ISTIO_IMAGES,
  ISTIO_VERSION,
  LDS_EVERY,
  MESH_IMAGES,
  MESH_WORKLOADS,
  certificateArgs,
  followsZtunnel,
  istioOperator,
  leafCertificates,
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

  it("keeps the calls going for the hold of a certificate expiry, and reads the certificates of ztunnel at the fault and at the heal", () => {
    const expiry = gapOf({ kind: "certificate-expiry", hold: s(630) });
    expect(planOf(expiry)).toEqual({ inject: [{ do: "certificates" }], hold: s(630), heal: [{ do: "certificates" }], restore: [] });
    expect(deletes(expiry)).toBe(false);
    expect(() => planOf(gapOf({ kind: "certificate-expiry" }))).toThrow(/a hold, the time past the lifetime/);
    expect(certificateArgs("ztunnel-x1", "/k/config")).toEqual(["ztunnel-config", "certificate", "ztunnel-x1.istio-system", "--kubeconfig", "/k/config", "-o", "json"]);
    // the JSON of istioctl: the leaf is the first certificate of the chain, and an identity can have no chain yet
    const dump = JSON.stringify([
      {
        identity: "spiffe://cluster.local/ns/lab/sa/default",
        state: "Available",
        certChain: [
          { pem: "a", serialNumber: "1", validFrom: "2026-10-25T10:00:00Z", expirationTime: "2026-10-25T10:12:00Z" },
          { pem: "b", serialNumber: "2", validFrom: "2026-10-01T00:00:00Z", expirationTime: "2036-10-01T00:00:00Z" },
        ],
        rootCerts: [],
      },
      { identity: "spiffe://cluster.local/ns/lab/sa/server", state: "Initializing", certChain: [], rootCerts: [] },
    ]);
    expect(leafCertificates("ztunnel-x1", dump)).toEqual([
      { pod: "ztunnel-x1", identity: "spiffe://cluster.local/ns/lab/sa/default", state: "Available", from: "2026-10-25T10:00:00Z", to: "2026-10-25T10:12:00Z" },
      { pod: "ztunnel-x1", identity: "spiffe://cluster.local/ns/lab/sa/server", state: "Initializing", from: null, to: null },
    ]);
  });

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
  /**
   * This model runs the chains of the middlebox on one segment. It reads the rules of the commands
   * and follows the match recent of Linux v6.17 for one table (xt_recent.c, lines 283–321).
   */
  const modelOf = (commands: readonly string[][]) => {
    const chains = new Map<string, string[][]>();
    const jumps: string[][] = [];
    for (const argv of commands) {
      if (argv[1] === "-N") chains.set(argv[2]!, []);
      else if (argv[1] === "-A") chains.get(argv[2]!)!.push(argv.slice(3));
      else if (argv[1] === "-I") jumps.push(argv.slice(2));
    }
    const seen = new Map<string, number>();
    const option = (rule: readonly string[], name: string): string | undefined => rule[rule.indexOf(name) + 1];
    /** This function gives true when the middlebox drops a segment from the peer (`in`) or to it, at `t` seconds. */
    return (t: number, way: "in" | "out", peer: string, syn = false): boolean => {
      const jump = jumps.find((rule) => rule[0] === (way === "in" ? "INPUT" : "OUTPUT") && rule[2] === `${peer}/32`);
      if (jump === undefined) return false;
      for (const rule of chains.get(option(jump, "-j")!)!) {
        if (rule.includes("--syn") && !syn) continue;
        const known = seen.get(peer);
        let match: boolean;
        if (rule.includes("--set")) {
          seen.set(peer, t);
          match = true;
        } else if (rule.includes("--update")) {
          match = known !== undefined && known >= t - Number(option(rule, "--seconds"));
          if (match) seen.set(peer, t);
        } else match = known !== undefined;
        if (match) return option(rule, "-j") === "DROP";
      }
      return false;
    };
  };

  it("puts a stateful middlebox in chains of its own, and leaves conntrack as it is", () => {
    const set = middleboxCommands(["10.244.1.9", "10.244.2.9"], { value: 9, unit: "s" }, 15008);
    expect(set.some((argv) => argv[0] === "sysctl")).toBe(false);
    expect(set.slice(0, 2)).toEqual([
      ["iptables", "-N", MIDDLEBOX.input],
      ["iptables", "-N", MIDDLEBOX.output],
    ]);
    expect(set).toContainEqual(["iptables", "-A", MIDDLEBOX.input, "-m", "recent", "--name", MIDDLEBOX.table, "--rsource", "--update", "--seconds", "9", "-j", "RETURN"]);
    expect(set).toContainEqual(["iptables", "-A", MIDDLEBOX.output, "-m", "recent", "--name", MIDDLEBOX.table, "--rdest", "--rcheck", "-j", "DROP"]);
    expect(set.at(-4)).toEqual(["iptables", "-I", "INPUT", "-s", "10.244.1.9/32", "-p", "tcp", "--dport", "15008", "-j", MIDDLEBOX.input]);
    expect(set.at(-3)).toEqual(["iptables", "-I", "OUTPUT", "-d", "10.244.1.9/32", "-p", "tcp", "--sport", "15008", "-j", MIDDLEBOX.output]);
    // two chains, 4 rules in and 3 out, and two jumps for each peer
    expect(set).toHaveLength(13);
    // each word is plain: the lab refuses a word such as "!"
    for (const word of set.flat()) expect(word).toMatch(/^[A-Za-z0-9_.,:=/+-]+$/);
    const clear = middleboxCommands(["10.244.1.9"], null, 15008);
    expect(clear).toEqual([
      ["iptables", "-F", MIDDLEBOX.input],
      ["iptables", "-F", MIDDLEBOX.output],
      ["iptables", "-D", "INPUT", "-s", "10.244.1.9/32", "-p", "tcp", "--dport", "15008", "-j", MIDDLEBOX.input],
      ["iptables", "-D", "OUTPUT", "-d", "10.244.1.9/32", "-p", "tcp", "--sport", "15008", "-j", MIDDLEBOX.output],
      ["iptables", "-X", MIDDLEBOX.input],
      ["iptables", "-X", MIDDLEBOX.output],
    ]);
  });

  it("keeps a flow that a segment refreshes in each idle time, and forgets it for good after one idle time", () => {
    const peer = "10.244.1.9";
    const drops = modelOf(middleboxCommands([peer, "10.244.2.9"], { value: 11, unit: "s" }, 15008));
    // the flow is open before the set: its first segment puts its peer in the table
    expect(drops(0, "in", peer)).toBe(false);
    // a PING and its PONG each 10 s, in either direction, refresh the flow (T15.border-off.79)
    for (let t = 10; t <= 120; t += 10) {
      expect(drops(t, "out", peer)).toBe(false);
      expect(drops(t + 0.001, "in", peer)).toBe(false);
    }
    // a segment on another port, or of another peer, does not reach the chains
    expect(drops(500, "in", "10.244.3.9")).toBe(false);
    // 11.5 s with no segment: the middlebox forgot the flow, and each later segment is dropped (T15.border-off.80)
    expect(drops(131.501, "out", peer)).toBe(true);
    expect(drops(131.6, "in", peer)).toBe(true);
    expect(drops(140, "in", peer)).toBe(true);
    // the other peer has its own time
    expect(drops(131.7, "in", "10.244.2.9")).toBe(false);
    // a new SYN of the peer is a new flow
    expect(drops(150, "in", peer, true)).toBe(false);
    expect(drops(150.001, "out", peer)).toBe(false);
  });

  it("refuses a word that is not plain: an address, a port, a time or a sysctl", () => {
    expect(() => middleboxCommands(["10.244.1.9; reboot"], { value: 9, unit: "s" }, 15008)).toThrow(/not an address/);
    expect(() => middleboxCommands([], { value: 9, unit: "s" }, 15008)).toThrow(/needs a peer/);
    expect(() => middleboxCommands(["10.244.1.9"], { value: 9.5, unit: "s" }, 15008)).toThrow(/the idle timeout of the middlebox is a whole number of seconds/);
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
