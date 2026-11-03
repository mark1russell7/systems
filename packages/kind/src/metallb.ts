import { createHash } from "node:crypto";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Cluster } from "./cluster.ts";
import type { PinnedChart } from "./helm.ts";
import { helmInstall } from "./helm.ts";
import { VIP_LABEL } from "./kubevip.ts";
import { cidrRange } from "./scenario.ts";

/**
 * This module installs MetalLB 0.16.1 in L2 mode in a kind cluster (SYS-53). The controller of
 * MetalLB gives a Service of type LoadBalancer an address from a pool: the VIP. A speaker on each
 * worker answers ARP for the VIP if its node owns the VIP. The VIP is on no interface of a node.
 * Thus a frozen speaker answers nothing.
 *
 * Each term of the owner comes from the source of the tag v0.16.1 (commit 791dfcc6):
 * - The owner of a VIP is the first node in the order of sha256(node + "#" + VIP), of the nodes with
 *   a usable speaker (speaker/layer2_controller.go, lines 83–129). A usable speaker is a member of
 *   memberlist that is not dead (internal/speakerlist/speakerlist.go, lines 303–320).
 * - The speakers start memberlist from `DefaultLANConfig` (speakerlist.go, line 72). A file
 *   /etc/metallb/memberlist/config.json replaces that config (lines 77–84). The install makes no
 *   such file, thus each value is the default of hashicorp/memberlist v0.5.1.
 * - Each event of memberlist (a join, a leave or an update) calls `ForceSync` (speakerlist.go, lines
 *   339–349). `ForceSync` reconciles each Service at once, with no delay (internal/k8s/k8s.go, lines
 *   181–184, and internal/k8s/controllers/service_controller_reload.go, lines 62–118).
 * - The owner sends a gratuitous ARP at each reconcile. It sends one at once, then one each 1100 ms
 *   for 5 s (internal/layer2/announcer.go, lines 157–197 and 258–272).
 */

/** This version is the release of MetalLB of the lab: the tag v0.16.1, the commit 791dfcc63ced7a6b3e869131eae75e645150fff0. */
export const METALLB_VERSION = "0.16.1";

/** This chart is the Helm chart of MetalLB 0.16.1. The sha256 is of the file of the release, and it is the digest in the index of the charts. */
export const METALLB_CHART: PinnedChart = {
  name: "metallb",
  version: METALLB_VERSION,
  url: "https://github.com/metallb/metallb/releases/download/metallb-chart-0.16.1/metallb-0.16.1.tgz",
  sha256: "fb06bb584fcb7856f15733b2a6a2aff5b61b5c350687e341c163ae24a5938adc",
};

/**
 * These are the images of MetalLB 0.16.1 for linux/amd64, pinned by the digest of the manifest of the
 * platform. The lab pulls each one by its digest, tags it (`localPin`), and loads it into each node.
 */
export const METALLB_IMAGES: { readonly speaker: string; readonly controller: string } = {
  speaker: "quay.io/metallb/speaker:v0.16.1@sha256:37a98a9d1cd970051c5dededb6f922c1e6c3b90fdd0fc1350d1686e67675af0e",
  controller: "quay.io/metallb/controller:v0.16.1@sha256:5a3e101335f5ea2cfb0ddf51acdfa9538251e0623ffcd6cbfc1b274b7898790c",
};

/** These are the local tags of the images of MetalLB, after the pull by digest. */
export interface MetallbImages {
  readonly speaker: string;
  readonly controller: string;
}

/** This namespace holds MetalLB: its controller, its speakers and its objects. */
export const METALLB_NAMESPACE = "metallb-system";

/** This annotation of a Service gives the controller of MetalLB the address of its VIP. */
export const METALLB_ANNOTATION = "metallb.io/loadBalancerIPs";

/** This name is the name of the pool of the VIP and of its L2Advertisement. */
export const METALLB_POOL = "lab-vip";

/** This annotation of the Service makes each speaker reconcile it. The owner then sends its gratuitous ARPs. */
export const ANNOUNCE_ANNOTATION = "lab.systems/announce";

/**
 * These are the terms of memberlist v0.5.1 that the speakers use: the defaults of `DefaultLANConfig`
 * (config.go, lines 302–341).
 * - `probeInterval` is the interval of the probes (line 318). The awareness of a healthy member does not scale it.
 * - `probeTimeout` is the wait for the ack of a direct ping (line 317).
 * - `suspicionMult` and `suspicionMaxTimeoutMult` give the time from suspect to dead (lines 314–315).
 * - `pushPullInterval` is the interval of the full exchange of state (line 316).
 * - `gossipInterval` is the interval of the gossip (line 323).
 */
export const MEMBERLIST: {
  readonly probeInterval: Quantity;
  readonly probeTimeout: Quantity;
  readonly suspicionMult: number;
  readonly suspicionMaxTimeoutMult: number;
  readonly pushPullInterval: Quantity;
  readonly gossipInterval: Quantity;
} = {
  probeInterval: { value: 1, unit: "s" },
  probeTimeout: { value: 500, unit: "ms" },
  suspicionMult: 4,
  suspicionMaxTimeoutMult: 6,
  pushPullInterval: { value: 30, unit: "s" },
  gossipInterval: { value: 200, unit: "ms" },
};

/** These are the gratuitous ARPs of the owner at each reconcile: one at once, then one each `every` until `for` (announcer.go, lines 172–182). */
export const METALLB_SPAM: { readonly every: Quantity; readonly for: Quantity } = {
  every: { value: 1100, unit: "ms" },
  for: { value: 5, unit: "s" },
};

/**
 * This function gives the time from suspect to dead in memberlist v0.5.1, for a cluster of `members`
 * members with no peer that can confirm. The terms:
 * - `suspicionTimeout` is SuspicionMult × max(1, log10(n)) × ProbeInterval (util.go, lines 71–76).
 * - `suspectNode` sets k = SuspicionMult − 2 confirmations, and k = 0 if n − 2 < k (state.go, lines 1216–1224).
 * - With k = 0, the timer fires at the minimum, not at the maximum (suspicion.go, lines 70–76).
 * With confirmations to wait for, the function gives the maximum: SuspicionMaxTimeoutMult times the minimum.
 */
export const suspicionOf = (members: number, terms: Pick<typeof MEMBERLIST, "probeInterval" | "suspicionMult" | "suspicionMaxTimeoutMult"> = MEMBERLIST): Quantity => {
  const scale = Math.max(1, Math.log10(Math.max(1, members)));
  const min = Math.floor(scale * 1000) * valueIn(terms.probeInterval, "ms") * terms.suspicionMult / 1000;
  const k = members - 2 < terms.suspicionMult - 2 ? 0 : terms.suspicionMult - 2;
  return { value: k < 1 ? min : min * terms.suspicionMaxTimeoutMult, unit: "ms" };
};

/**
 * This function gives the Helm values of the install. The values that are not the defaults of the chart:
 * - No FRR and no frr-k8s: the lab uses L2 mode only, thus it needs no BGP.
 * - A speaker only on a node with `VIP_LABEL`, the workers. Thus memberlist has the workers as its
 *   members, and the control plane does not answer ARP.
 * - The controller on the control plane. A zone loss of a worker then does not take it away.
 * - Each image from the node (`pullPolicy: Never`).
 */
export const metallbValues = (images: MetallbImages): Record<string, unknown> => {
  const image = (local: string) => {
    const at = local.lastIndexOf(":");
    if (at <= 0) throw new Error(`the image ${local} has no tag`);
    return { repository: local.slice(0, at), tag: local.slice(at + 1), pullPolicy: "Never" };
  };
  return {
    frrk8s: { enabled: false },
    controller: {
      image: image(images.controller),
      nodeSelector: { "node-role.kubernetes.io/control-plane": "" },
      tolerations: [{ key: "node-role.kubernetes.io/control-plane", operator: "Exists", effect: "NoSchedule" }],
    },
    speaker: {
      image: image(images.speaker),
      frr: { enabled: false },
      tolerateMaster: false,
      nodeSelector: { [VIP_LABEL]: "1" },
      memberlist: { enabled: true, mlBindPort: 7946 },
    },
  };
};

/** This function gives the pool of the VIP and its L2Advertisement. The pool has only the VIP. */
export const metallbObjects = (vip: string): unknown[] => [
  {
    apiVersion: "metallb.io/v1beta1",
    kind: "IPAddressPool",
    metadata: { name: METALLB_POOL, namespace: METALLB_NAMESPACE },
    spec: { addresses: [`${vip}/32`] },
  },
  {
    apiVersion: "metallb.io/v1beta1",
    kind: "L2Advertisement",
    metadata: { name: METALLB_POOL, namespace: METALLB_NAMESPACE },
    spec: { ipAddressPools: [METALLB_POOL] },
  },
];

/** This function gives the nodes in the order of the election of the owner of `vip`: by sha256(node + "#" + vip), as bytes (layer2_controller.go, lines 115–120). */
export const ownerOrder = (nodes: readonly string[], vip: string): string[] => {
  const hash = (node: string) => createHash("sha256").update(`${node}#${vip}`).digest();
  return [...nodes].sort((a, b) => Buffer.compare(hash(a), hash(b)));
};

const dotted = (address: number): string => [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join(".");

/**
 * This function gives the VIP of a subnet for MetalLB. It looks down from the sixth address from the
 * end, and it gives the first address that `owner` owns, of the nodes `nodes`. Docker gives the address of each container
 * from the start of the subnet, thus no container takes it.
 */
export const metallbVipOf = (subnet: string, owner: string, nodes: readonly string[]): string => {
  if (!nodes.includes(owner)) throw new Error(`the owner ${owner} is not one of the nodes ${nodes.join(", ")}`);
  const [first, last] = cidrRange(subnet);
  for (let address = last - 5; address > first + 1 && address > last - 260; address--) {
    const vip = dotted(address);
    if (ownerOrder(nodes, vip)[0] === owner) return vip;
  }
  throw new Error(`the subnet ${subnet} has no VIP that ${owner} owns`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** This function waits until a condition gives null, and gives null, or the last reason after `within` ms. */
const until = async (within: number, check: () => Promise<string | null>): Promise<string | null> => {
  const end = Date.now() + within;
  let why = await check();
  while (why !== null && Date.now() < end) {
    await sleep(500);
    why = await check();
  }
  return why;
};

/** This is a ServiceL2Status of MetalLB: the node that announces a Service, and the time of the object. */
export interface Announcement {
  readonly node: string;
  readonly created: string | null;
}

/** This function gives the nodes that announce a Service, from the ServiceL2Status objects of the speakers. */
export const announcementsOf = async (cluster: Pick<Cluster, "kubectl">, namespace: string, service: string): Promise<Announcement[]> => {
  const list = JSON.parse(await cluster.kubectl(["-n", METALLB_NAMESPACE, "get", "servicel2statuses.metallb.io", "-o", "json"])) as {
    items: ReadonlyArray<{ metadata?: { creationTimestamp?: string }; status?: { node?: string; serviceName?: string; serviceNamespace?: string } }>;
  };
  return list.items
    .filter((item) => item.status?.serviceName === service && item.status.serviceNamespace === namespace && typeof item.status.node === "string")
    .map((item) => ({ node: item.status!.node!, created: item.metadata?.creationTimestamp ?? null }))
    .sort((a, b) => a.node.localeCompare(b.node));
};

/** This function gives the nodes with a ready speaker that is not deleted. */
export const speakersReady = async (cluster: Pick<Cluster, "kubectl">): Promise<string[]> => {
  const list = JSON.parse(await cluster.kubectl(["-n", METALLB_NAMESPACE, "get", "pods", "-l", "app.kubernetes.io/component=speaker", "-o", "json"])) as {
    items: ReadonlyArray<{ metadata: { deletionTimestamp?: string }; spec: { nodeName?: string }; status?: { containerStatuses?: ReadonlyArray<{ ready: boolean }> } }>;
  };
  return list.items
    .filter((pod) => pod.metadata.deletionTimestamp === undefined && pod.spec.nodeName !== undefined)
    .filter((pod) => (pod.status?.containerStatuses ?? []).length > 0 && pod.status!.containerStatuses!.every((status) => status.ready))
    .map((pod) => pod.spec.nodeName!)
    .sort();
};

/**
 * This function makes `owner` the only node that announces the Service, with a ready speaker on each
 * node of `nodes`. It gives null, or why it could not in `within` ms. After a heal, the other node
 * stops when it sees that the owner is alive again. The function then annotates the Service. Each
 * speaker reconciles it, and the owner sends its gratuitous ARPs for 5 s. Thus each client learns
 * the MAC address of the owner.
 */
export const holdMetallb = async (cluster: Pick<Cluster, "kubectl">, owner: string, nodes: readonly string[], namespace: string, service: string, within = 180_000): Promise<string | null> => {
  const ready = await until(within, async () => {
    const found = await speakersReady(cluster);
    const missing = nodes.filter((node) => !found.includes(node));
    return missing.length === 0 ? null : `the speaker of MetalLB is not ready on ${missing.join(", ")}`;
  });
  if (ready !== null) return ready;
  const sole = await until(within, async () => {
    const found = (await announcementsOf(cluster, namespace, service)).map((each) => each.node);
    return found.length === 1 && found[0] === owner ? null : `the Service ${service} is announced by ${found.join(", ") || "no node"}, not only by ${owner}`;
  });
  if (sole !== null) return sole;
  await cluster.kubectl(["-n", namespace, "annotate", "service", service, `${ANNOUNCE_ANNOTATION}=${Date.now()}`, "--overwrite"]);
  return null;
};

/**
 * This function installs MetalLB in a cluster, with its images on each node, the speakers on `nodes`,
 * and a pool of the VIP. The webhook of the controller checks the pool, thus the function tries the
 * pool again until the webhook answers. A failed install gives the pods of MetalLB and the tail of
 * their logs.
 */
export const installMetallb = async (cluster: Cluster, images: MetallbImages, nodes: readonly string[], vip: string): Promise<void> => {
  try {
    for (const node of nodes) await cluster.kubectl(["label", "node", node, `${VIP_LABEL}=1`, "--overwrite"]);
    await helmInstall(cluster, "metallb", METALLB_CHART, METALLB_NAMESPACE, metallbValues(images), { createNamespace: true });
    let failure: unknown = null;
    const end = Date.now() + 180_000;
    do {
      failure = await cluster.apply(metallbObjects(vip)).then(
        () => null,
        (error: unknown) => error,
      );
      if (failure !== null) await sleep(2000);
    } while (failure !== null && Date.now() < end);
    if (failure !== null) throw failure;
    const config = (await cluster.kubectl(["-n", METALLB_NAMESPACE, "get", "configmap", "metallb-memberlist-config", "--ignore-not-found", "-o", "name"])).trim();
    if (config !== "") throw new Error("the ConfigMap metallb-memberlist-config is there: memberlist would not use its defaults");
  } catch (error) {
    const state = async (args: readonly string[]): Promise<string> =>
      (await cluster.kubectl(["-n", METALLB_NAMESPACE, ...args]).catch((why: unknown) => String(why))).slice(-4000);
    const pods = await state(["get", "pods", "-o", "wide"]);
    const logs = await state(["logs", "-l", "app.kubernetes.io/name=metallb", "--tail=40", "--prefix", "--all-containers"]);
    throw new Error(`the install of MetalLB failed: ${String(error)}\nthe pods of MetalLB:\n${pods}\nthe logs:\n${logs}`);
  }
};

/** These words mark the lines of a speaker that the record keeps: the events of memberlist, the announces and the withdraws. */
const KEPT = /node event|Marking|Suspect|Refuting|serviceAnnounced|serviceWithdrawn|memberlist/;

/**
 * This function gives the record of MetalLB after a run: the nodes that announce the Service, and
 * some lines of each speaker. The lines are about memberlist and the announces, with the times of the kubelet.
 */
export const metallbRecord = async (cluster: Pick<Cluster, "kubectl">, namespace: string, service: string): Promise<Record<string, unknown>> => {
  const announcements = await announcementsOf(cluster, namespace, service);
  const text = await cluster
    .kubectl(["-n", METALLB_NAMESPACE, "logs", "-l", "app.kubernetes.io/component=speaker", "-c", "speaker", "--since=300s", "--tail=4000", "--prefix", "--timestamps"])
    .catch((error: unknown) => String(error));
  const log = text
    .split("\n")
    .filter((line) => KEPT.test(line))
    .slice(-120)
    .join("\n");
  return { announcements, log: log.slice(-12000) };
};
