import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KUBE_PROXY_MODES, NODE_IMAGES, cidrOverlap, goDuration, kindConfig, kubeProxyPatch, nodeNames, scenario, scenarioProblems } from "./scenario.ts";
import { KIND, KUBECTL, ensureTool, platformKey, sha256, toolPath } from "./tools.ts";
import type { Tool } from "./tools.ts";

describe("the configuration of kind, from a scenario", () => {
  it("gives each node, the pinned image, the mode and the subnets", () => {
    for (const mode of KUBE_PROXY_MODES) {
      const config = kindConfig(scenario("lab-a", mode, 2));
      expect(config.networking).toEqual({
        ipFamily: "ipv4",
        kubeProxyMode: mode,
        disableDefaultCNI: false,
        podSubnet: "10.244.0.0/16",
        serviceSubnet: "10.96.0.0/16",
      });
      expect(config.nodes.map((node) => node.role)).toEqual(["control-plane", "worker", "worker"]);
      expect(new Set(config.nodes.map((node) => node.image))).toEqual(new Set([NODE_IMAGES["1.37"]!.image]));
      expect(config.nodes[0]!.image).toMatch(/^kindest\/node:v1\.37\.0@sha256:[0-9a-f]{64}$/);
      expect(config.kubeadmConfigPatches).toEqual([kubeProxyPatch(scenario("lab-a", mode, 2))]);
    }
  });

  it("states the sync periods of kube-proxy in the patch of its mode", () => {
    expect(kubeProxyPatch(scenario("lab-a", "ipvs", 1))).toBe(
      [
        "apiVersion: kubeproxy.config.k8s.io/v1alpha1",
        "kind: KubeProxyConfiguration",
        "mode: ipvs",
        "ipvs:",
        "  minSyncPeriod: 1s",
        "  syncPeriod: 30s",
        "",
      ].join("\n"),
    );
    expect(goDuration({ value: 500, unit: "ms" })).toBe("500ms");
    expect(goDuration({ value: 2, unit: "s" })).toBe("2s");
    expect(() => goDuration({ value: 0.5, unit: "ms" })).toThrow(/whole number/);
  });

  it("names the node containers as kind names them", () => {
    expect(nodeNames(scenario("lab-a", "iptables", 3))).toEqual(["lab-a-control-plane", "lab-a-worker", "lab-a-worker2", "lab-a-worker3"]);
  });

  it("refuses a name that kind refuses, an unpinned version, a bad count and overlapping subnets", () => {
    const good = scenario("lab-a", "iptables", 2);
    expect(scenarioProblems(good)).toEqual([]);
    expect(scenarioProblems({ ...good, name: "Lab_A" })[0]).toMatch(/lowercase/);
    expect(scenarioProblems({ ...good, kubernetes: "1.20" })[0]).toMatch(/no node image/);
    expect(scenarioProblems({ ...good, workers: 1.5 })[0]).toMatch(/whole number/);
    expect(scenarioProblems({ ...good, serviceSubnet: "10.244.128.0/20" })[0]).toMatch(/overlaps/);
    expect(() => kindConfig({ ...good, name: "" })).toThrow(/the scenario/);
  });

  it("finds the overlap of two IPv4 subnets", () => {
    expect(cidrOverlap("10.244.0.0/16", "10.244.3.0/24")).toBe(true);
    expect(cidrOverlap("10.244.0.0/16", "10.96.0.0/16")).toBe(false);
    expect(cidrOverlap("172.18.0.0/16", "172.16.0.0/12")).toBe(true);
    expect(() => cidrOverlap("10.0.0.0/33", "10.0.0.0/8")).toThrow(/not an IPv4 CIDR/);
  });
});

describe("the pinned tools", () => {
  it("pins kind and kubectl for Windows and Linux by sha256", () => {
    for (const tool of [KIND, KUBECTL])
      for (const key of ["win32-x64", "linux-x64"]) expect(tool.assets[key]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(platformKey("linux", "x64")).toBe("linux-x64");
    expect(toolPath(KIND, "win32-x64", "/cache")).toMatch(/kind-v0\.33\.0-win32-x64[\\/]kind\.exe$/);
    expect(toolPath(KUBECTL, "linux-x64", "/cache")).toMatch(/kubectl-v1\.37\.0-linux-x64[\\/]kubectl$/);
  });

  it("uses a cached binary only when its sha256 is the pinned one", async () => {
    const cache = mkdtempSync(join(tmpdir(), "kind-tools-"));
    const bytes = new TextEncoder().encode("a binary");
    const tool: Tool = { name: "kind", version: "v0", assets: { "linux-x64": { url: "https://example.invalid/kind", sha256: sha256(bytes) } } };
    const path = toolPath(tool, "linux-x64", cache);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    await expect(ensureTool(tool, "linux-x64", cache)).resolves.toBe(path);
    writeFileSync(path, "another binary");
    await expect(ensureTool(tool, "linux-x64", cache)).rejects.toThrow(/not the pinned/);
    await expect(ensureTool(tool, "darwin-x64", cache)).rejects.toThrow(/no pinned asset/);
  });
});
