import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CILIUM_CHART, CILIUM_IMAGES, CILIUM_VERSION, ciliumMode, ciliumValues, ensureChart } from "./cilium.ts";

describe("the install of Cilium", () => {
  it("pins the chart and each image of 1.20.4 by sha256", () => {
    expect(CILIUM_CHART.url).toBe(`https://helm.cilium.io/cilium-${CILIUM_VERSION}.tgz`);
    expect(CILIUM_CHART.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const image of Object.values(CILIUM_IMAGES)) expect(image).toMatch(/^quay\.io\/cilium\/[a-z-]+:v[0-9.]+[^@]*@sha256:[0-9a-f]{64}$/);
    expect(CILIUM_IMAGES.agent).toMatch(/^quay\.io\/cilium\/cilium:v1\.20\.4@/);
    expect(CILIUM_IMAGES.operator).toMatch(/^quay\.io\/cilium\/operator-generic:v1\.20\.4@/);
  });

  it("replaces kube-proxy, keeps socket LB at its default, and uses only the loaded images", () => {
    const values = ciliumValues("lab-a", { agent: "systems-lab/cilium:a", operator: "systems-lab/operator-generic:b", envoy: "systems-lab/cilium-envoy:c" });
    expect(values).toEqual({
      kubeProxyReplacement: true,
      k8sServiceHost: "lab-a-control-plane",
      k8sServicePort: 6443,
      ipam: { mode: "kubernetes" },
      image: { override: "systems-lab/cilium:a", pullPolicy: "Never" },
      operator: { replicas: 1, image: { override: "systems-lab/operator-generic:b", pullPolicy: "Never" } },
      envoy: { image: { override: "systems-lab/cilium-envoy:c", pullPolicy: "Never" } },
    });
    // no value names the socket LB or the algorithm: each stays at the default of the chart
    expect(JSON.stringify(values)).not.toMatch(/socketLB|loadBalancer|bpf/);
  });

  it("gives the mode of a cluster from cilium-config", () => {
    expect(ciliumMode({ "kube-proxy-replacement": "true", "bpf-lb-sock": "false", "routing-mode": "tunnel", ipam: "kubernetes" })).toBe(
      "cilium 1.20.4 kube-proxy-replacement=true bpf-lb-sock=false bpf-lb-algorithm=default routing-mode=tunnel ipam=kubernetes",
    );
  });

  it("uses a cached chart only when its sha256 is the pinned one", async () => {
    const cache = mkdtempSync(join(tmpdir(), "kind-charts-"));
    mkdirSync(join(cache, "charts"), { recursive: true });
    writeFileSync(join(cache, "charts", `cilium-${CILIUM_VERSION}.tgz`), "another chart");
    await expect(ensureChart(cache)).rejects.toThrow(/not the pinned/);
  });
});
