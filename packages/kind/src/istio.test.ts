import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cellOf } from "./cells.fixture.ts";
import { clusterFilter, hostsOf, outboundCluster } from "./eds.ts";
import { ACCESS_LOG_FORMAT, ISTIO_IMAGES, ISTIO_VERSION, istioOperator, meshKey, serverCluster } from "./istio.ts";
import { namespaceObject } from "./manifests.ts";
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
const SIDECAR = { flavor: "sidecar", mode: "sidecar" } as const;

describe("the install of Istio", () => {
  it("pins each image of the sidecar flavor by digest, at the version of istioctl", () => {
    for (const image of Object.values(ISTIO_IMAGES)) expect(image).toMatch(new RegExp(`^istio/[a-z0-9]+:${ISTIO_VERSION.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$`));
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
    expect(() => istioOperator("ambient", IMAGES)).toThrow(/sidecar only/);
  });

  it("gives a cell with a mesh its flavor as the key of its cluster, and a labeled namespace", () => {
    expect(meshKey(cellOf("pod-deletion"))).toBe("none");
    expect(meshKey({ mesh: SIDECAR })).toBe("sidecar");
    expect(namespaceObject({ mesh: SIDECAR }, "lab-a")).toMatchObject({ metadata: { name: "lab-a", labels: { "istio-injection": "enabled" } } });
    expect(namespaceObject({ mesh: { flavor: "ambient", mode: "sidecar" } }, "lab-a")).toMatchObject({ metadata: { labels: { "istio-injection": "enabled" } } });
    expect(namespaceObject({}, "lab-a")).toEqual({ apiVersion: "v1", kind: "Namespace", metadata: { name: "lab-a" } });
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
