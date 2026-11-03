import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cluster } from "./cluster.ts";
import { command } from "./cluster.ts";
import { HELM, cacheFolder, download, ensureTool, sha256 } from "./tools.ts";

/**
 * This module installs a Helm chart that is pinned by the sha256 of its file. The installs of Cilium
 * (`cilium.ts`) and of MetalLB (`metallb.ts`) use it. Helm keeps its own files in the folder of the
 * cluster, thus two clusters do not share a cache of Helm.
 */

/** A pinned chart is a Helm chart: its name, its version, the URL of its file and the sha256 of that file. */
export interface PinnedChart {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

/** This function gives the path of a chart in the cache, after a download when the cache does not have it. It refuses a file whose sha256 is not the pinned value. */
export const ensurePinnedChart = async (chart: PinnedChart, cache: string = cacheFolder()): Promise<string> => {
  const path = join(cache, "charts", `${chart.name}-${chart.version}.tgz`);
  const bytes = existsSync(path) ? readFileSync(path) : await download(chart.url);
  const found = sha256(bytes);
  if (found !== chart.sha256) throw new Error(`the chart ${chart.name} ${chart.version} has the sha256 ${found}, not the pinned ${chart.sha256}`);
  if (!existsSync(path)) {
    mkdirSync(join(cache, "charts"), { recursive: true });
    writeFileSync(path, bytes);
  }
  return path;
};

/**
 * This function installs a pinned chart in a cluster with the values `values`. It writes the values
 * to a file in the folder of the cluster. Helm waits for each workload of the chart, for up to 10 min.
 */
export const helmInstall = async (
  cluster: Pick<Cluster, "dir" | "kubeconfig">,
  release: string,
  chart: PinnedChart,
  namespace: string,
  values: Readonly<Record<string, unknown>>,
  options: { readonly createNamespace?: boolean } = {},
): Promise<void> => {
  const helm = await ensureTool(HELM);
  const path = await ensurePinnedChart(chart);
  const file = join(cluster.dir, `${release}-values.json`);
  writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`);
  const home = join(cluster.dir, "helm");
  const env = { HELM_CACHE_HOME: join(home, "cache"), HELM_CONFIG_HOME: join(home, "config"), HELM_DATA_HOME: join(home, "data") };
  const create = options.createNamespace === true ? ["--create-namespace"] : [];
  await command(helm, ["install", release, path, "-n", namespace, ...create, "--kubeconfig", cluster.kubeconfig, "-f", file, "--wait", "--timeout", "10m"], { env, timeout: 900_000 });
};
