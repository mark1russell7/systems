import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CILIUM_CHART } from "./cilium.ts";
import { ensurePinnedChart, type PinnedChart } from "./helm.ts";
import { METALLB_CHART } from "./metallb.ts";
import { PULSAR_CHART } from "./pulsar.ts";
import { sha256 } from "./tools.ts";

const BYTES = new TextEncoder().encode("the bytes of the chart");
const CHART: PinnedChart = { name: "demo", version: "1.2.3", url: "https://charts.test/demo-1.2.3.tgz", sha256: sha256(BYTES) };

const folders: string[] = [];
const cacheOf = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "kind-helm-"));
  folders.push(folder);
  return folder;
};
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const counted = (bytes: Uint8Array) => {
  const urls: string[] = [];
  return { urls, get: async (url: string) => (urls.push(url), bytes) };
};

describe("the cache of a pinned chart", () => {
  it("downloads the chart again over a torn file in the cache, and keeps the whole file for the next install", async () => {
    const cache = cacheOf();
    mkdirSync(join(cache, "charts"), { recursive: true });
    const path = join(cache, "charts", "demo-1.2.3.tgz");
    writeFileSync(path, BYTES.slice(0, 5));
    const { urls, get } = counted(BYTES);
    expect(await ensurePinnedChart(CHART, cache, get)).toBe(path);
    expect(urls).toEqual([CHART.url]);
    expect(sha256(readFileSync(path))).toBe(CHART.sha256);
    expect(existsSync(`${path}.partial`)).toBe(false);
    expect(await ensurePinnedChart(CHART, cache, get)).toBe(path);
    expect(urls).toHaveLength(1);
  });

  it("refuses a download with a different sha256, and writes nothing to the cache", async () => {
    const cache = cacheOf();
    const { get } = counted(new TextEncoder().encode("other bytes"));
    await expect(ensurePinnedChart(CHART, cache, get)).rejects.toThrow(/not the pinned/);
    expect(existsSync(join(cache, "charts", "demo-1.2.3.tgz"))).toBe(false);
  });

  it("pins each chart at a URL that keeps its release", () => {
    // The mirrors of Apache keep only the latest releases. The archive keeps each one.
    for (const chart of [CILIUM_CHART, METALLB_CHART, PULSAR_CHART]) expect(chart.url, chart.name).not.toMatch(/^https:\/\/(downloads|dlcdn)\.apache\.org\//);
  });
});
