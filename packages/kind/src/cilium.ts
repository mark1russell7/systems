import type { Cluster } from "./cluster.ts";
import type { PinnedChart } from "./helm.ts";
import { ensurePinnedChart, helmInstall } from "./helm.ts";
import { cacheFolder } from "./tools.ts";

/**
 * This module installs Cilium 1.20.4 in a kind cluster with Helm, from images pinned by digest.
 * Cilium is the CNI and replaces kube-proxy (the dataplane `cilium`). Each value of the install
 * that is not a default of the chart is in `ciliumValues`, with its reason.
 */

/** This version is the release of Cilium of the lab, from 2026-10-23: the version of the chart and the tag of each image. */
export const CILIUM_VERSION = "1.20.4";

/** This chart is the Helm chart of Cilium 1.20.4. The sha256 is of the file on `helm.cilium.io` (read on 2026-10-27). */
export const CILIUM_CHART: PinnedChart = {
  name: "cilium",
  version: CILIUM_VERSION,
  url: "https://helm.cilium.io/cilium-1.20.4.tgz",
  sha256: "505abff8385811df1a949776fc42e9f10697989a332acc86d6e8933efcb855ed",
};

/**
 * These are the images that the install needs, pinned by the digests that the chart of 1.20.4 names
 * (`values.yaml`). The agent, the operator and Envoy are the only images: the install has no
 * node init, no preflight and no Hubble relay. The lab pulls each one by its digest, tags it
 * (`localPin`), and loads it into each node. Thus no node pulls from a registry.
 */
export const CILIUM_IMAGES: { readonly agent: string; readonly operator: string; readonly envoy: string } = {
  agent: "quay.io/cilium/cilium:v1.20.4@sha256:20fe92e4c86641233a450098c158d2d29085f3419931ab6bf681d2485dedf16e",
  operator: "quay.io/cilium/operator-generic:v1.20.4@sha256:7a7a3489dc66ad67e420d285c8a8d2e169b0957ad15e120f593d27081bf38d82",
  envoy:
    "quay.io/cilium/cilium-envoy:v1.39.5-1792733054-8c73b2816bc8239e27f1fd53b271884688137459@sha256:547ab45f6092f681d9f54f3be9fa8fb1e705c9c5dc2df388efe3a52aa6965629",
};

/** These are the local tags of the images of Cilium, after the pull by digest. */
export interface CiliumImages {
  readonly agent: string;
  readonly operator: string;
  readonly envoy: string;
}

/**
 * This function gives the Helm values of the install in a cluster. The values that are not the
 * defaults of the chart:
 * - `kubeProxyReplacement: true`, and the address of the API server on the control plane. With no
 *   kube-proxy, the agent cannot reach the API through its Service
 *   (`Documentation/network/kubernetes/kubeproxy-free.rst`).
 * - `ipam.mode: kubernetes`: the agent takes the pod CIDR of each node from the node, as the kind
 *   guide tells (`Documentation/installation/kind.rst`). Thus the pod subnet of the scenario holds.
 * - Each image is an `override`: the helper `cilium.image` of the chart then uses it as it is
 *   (`templates/_helpers.tpl`). `pullPolicy: Never`: each image is on each node.
 * - The operator has one replica, not two. Its anti-affinity puts each replica on a different node,
 *   and no cell examines a failover of the operator.
 *
 * Socket LB stays at its default. KPR sets it on (`pkg/kpr/kpr.go`). It selects a backend at
 * `connect()`. A connection keeps its backend, as with the conntrack NAT of kube-proxy. On the
 * deletion of a backend, the agent destroys only its UDP sockets, because
 * `LBSockTerminateAllProtos` is off by default (`pkg/loadbalancer/reconciler/termination.go`).
 */
export const ciliumValues = (clusterName: string, images: CiliumImages): Record<string, unknown> => ({
  kubeProxyReplacement: true,
  k8sServiceHost: `${clusterName}-control-plane`,
  k8sServicePort: 6443,
  ipam: { mode: "kubernetes" },
  image: { override: images.agent, pullPolicy: "Never" },
  operator: { replicas: 1, image: { override: images.operator, pullPolicy: "Never" } },
  envoy: { image: { override: images.envoy, pullPolicy: "Never" } },
});

/** These are the workloads in kube-system that the install waits for, then the DNS that waits for the CNI. */
export const CILIUM_WORKLOADS: readonly string[] = ["daemonset/cilium", "deployment/cilium-operator", "daemonset/cilium-envoy"];

/** This function gives the path of the chart in the cache, after a download when the cache does not have it. It refuses a file whose sha256 is not the pinned value. */
export const ensureChart = (cache: string = cacheFolder()): Promise<string> => ensurePinnedChart(CILIUM_CHART, cache);

/**
 * This function installs Cilium in a cluster with no CNI and no kube-proxy. Helm keeps its own
 * files in the folder of the cluster. The function waits for each workload, for each node to be
 * ready, and for CoreDNS. If the install fails, the error has the pods of kube-system and the last
 * lines of the log of the agent.
 */
export const installCilium = async (cluster: Cluster, images: CiliumImages): Promise<void> => {
  try {
    await helmInstall(cluster, "cilium", CILIUM_CHART, "kube-system", ciliumValues(cluster.scenario.name, images));
    for (const workload of CILIUM_WORKLOADS) await cluster.kubectl(["-n", "kube-system", "rollout", "status", workload, "--timeout=300s"]);
    await cluster.kubectl(["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=300s"]);
    await cluster.kubectl(["-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=300s"]);
  } catch (error) {
    const state = async (args: readonly string[]): Promise<string> =>
      (await cluster.kubectl(["-n", "kube-system", ...args]).catch((why: unknown) => String(why))).slice(-4000);
    const pods = await state(["get", "pods", "-o", "wide"]);
    const agent = await state(["logs", "daemonset/cilium", "-c", "cilium-agent", "--tail=80"]);
    throw new Error(`the install of Cilium failed: ${String(error)}\nthe pods of kube-system:\n${pods}\nthe log of the agent:\n${agent}`);
  }
};

/** This is the setting of Cilium that a cluster manifest records: the version and the keys of `cilium-config` that the cells depend on. */
export const CILIUM_CONFIG_KEYS: readonly string[] = ["kube-proxy-replacement", "bpf-lb-sock", "bpf-lb-algorithm", "routing-mode", "ipam"];

/** This function gives the mode of a cluster manifest of the dataplane `cilium`, from the data of the configmap `cilium-config`. */
export const ciliumMode = (data: Readonly<Record<string, string>>): string =>
  `cilium ${CILIUM_VERSION} ${CILIUM_CONFIG_KEYS.map((key) => `${key}=${data[key] ?? "default"}`).join(" ")}`;
