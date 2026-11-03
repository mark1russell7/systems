import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Cluster } from "./cluster.ts";
import { command } from "./cluster.ts";
import { cidrRange } from "./scenario.ts";

/**
 * This module installs kube-vip 1.3.1 in a kind cluster (SYS-51). The install gives a Service of type
 * LoadBalancer an address on the Docker network of the nodes: the VIP. In ARP mode, one node holds
 * the VIP on its link, and it sends a gratuitous ARP for it each `vip_arpRate`. A Lease elects that
 * node. Each value of the install is in `kubeVipObjects`, with its reason.
 *
 * The lab uses a VIP of a Service, not a VIP of the control plane. A VIP of the control plane needs
 * three control-plane nodes and TLS on port 6443. A VIP of a Service needs one DaemonSet on the
 * workers, and it serves the server of the cell.
 *
 * Each term of the election comes from the source of v1.3.1:
 * - With `svc_election` off, one election of the lease `plndr-svcs-lock` gives each VIP to one
 *   node (pkg/manager/worker/common.go, `GlobalLeader`). The lease is in the namespace of the pod.
 * - The election is `leaderelection.RunOrDie` of client-go v0.37.1, with a Lease lock and
 *   `ReleaseOnCancel` (pkg/election/election.go). The identity is the name of the node.
 * - A leader that loses its lease stops the process (`OnStoppedLeading`), and the kubelet starts it again.
 * - The ARP manager sends a gratuitous ARP for each VIP at each tick of one ticker of
 *   `vip_arpRate`. A new VIP gets its first one at the next tick, not at once (pkg/arp/arp.go).
 */

/** This version is the release of kube-vip of the lab, from 2026-10-19: the tag of its image. */
export const KUBE_VIP_VERSION = "1.3.1";

/**
 * This image is kube-vip 1.3.1 for linux/amd64, pinned by the digest of its manifest. The digest of
 * the index of the tag is sha256:1962f9daf226503f7e6b107f595cb28b7917fd2d0113957075e19a3e5a6c1e33.
 * The manifest of one platform loads into kind with no index.
 */
export const KUBE_VIP_IMAGE = "ghcr.io/kube-vip/kube-vip:v1.3.1@sha256:47353c7bde7fec21642cf621bc3fda2b999c051342912efda468999a399be667";

/** This is the name of kube-vip: of its ServiceAccount, its DaemonSet and its container. */
export const KUBE_VIP = "kube-vip";

/** This is the Lease of the election of the VIPs of the Services (`svc_leasename`, cmd/kube-vip.go of v1.3.1). */
export const KUBE_VIP_LEASE: { readonly namespace: string; readonly name: string } = { namespace: "kube-system", name: "plndr-svcs-lock" };

/**
 * These are the times of the election, as the install sets them. Each one is the default of the
 * flags of v1.3.1 (cmd/kube-vip.go, lines 91–94). They are a lease of 15 s, a renew deadline of 10 s
 * and a retry period of 2 s. The install sets each one in the environment, thus a new default cannot
 * change a cell.
 */
export const KUBE_VIP_ELECTION: { readonly lease: Quantity; readonly renew: Quantity; readonly retry: Quantity } = {
  lease: { value: 15, unit: "s" },
  renew: { value: 10, unit: "s" },
  retry: { value: 2, unit: "s" },
};

/** This time is the interval of the gratuitous ARPs, the default of the flag `arpRate` of v1.3.1 (cmd/kube-vip.go, line 61). */
export const KUBE_VIP_ARP_RATE: Quantity = { value: 3000, unit: "ms" };

/** This label of a node selects the nodes of kube-vip: the DaemonSet has a pod only on a node with it. */
export const VIP_LABEL = "lab.systems/vip";

/** This label of a pod of kube-vip selects them. */
const APP = { "app.kubernetes.io/name": KUBE_VIP };

const whole = (amount: Quantity): string => String(Math.round(valueIn(amount, "s")));

/**
 * This function gives the objects of kube-vip in kube-system. They are its ServiceAccount, its
 * ClusterRole and binding, and its DaemonSet. The rules of the role are those of the manifest that
 * v1.3.1 generates (pkg/kubevip/config_generator.go, lines 95–134). The DaemonSet:
 * - is on the host network, with NET_ADMIN and NET_RAW. It adds the VIP to `eth0` and sends ARP.
 * - has a pod only on a node with `VIP_LABEL`. Thus the lab chooses the holder of the VIP.
 * - sets ARP mode, the Services, one election for all VIPs, and each time of the election.
 * - takes the image from the node (`imagePullPolicy: Never`).
 */
export const kubeVipObjects = (image: string): unknown[] => {
  const env: Record<string, string> = {
    vip_arp: "true",
    vip_interface: "eth0",
    port: "6443",
    cp_enable: "false",
    svc_enable: "true",
    svc_election: "false",
    svc_leasename: KUBE_VIP_LEASE.name,
    vip_leaderelection: "true",
    vip_leaseduration: whole(KUBE_VIP_ELECTION.lease),
    vip_renewdeadline: whole(KUBE_VIP_ELECTION.renew),
    vip_retryperiod: whole(KUBE_VIP_ELECTION.retry),
    vip_arpRate: String(Math.round(valueIn(KUBE_VIP_ARP_RATE, "ms"))),
  };
  const namespace = KUBE_VIP_LEASE.namespace;
  return [
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: KUBE_VIP, namespace } },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name: "system:kube-vip-role" },
      rules: [
        { apiGroups: [""], resources: ["services/status"], verbs: ["update"] },
        { apiGroups: [""], resources: ["services", "endpoints"], verbs: ["list", "get", "watch", "update"] },
        { apiGroups: [""], resources: ["nodes"], verbs: ["list", "get", "watch", "update", "patch"] },
        { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["list", "get", "watch", "update", "create"] },
        { apiGroups: ["discovery.k8s.io"], resources: ["endpointslices"], verbs: ["list", "get", "watch", "update"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["list"] },
        { apiGroups: ["networking.k8s.io"], resources: ["servicecidrs"], verbs: ["list", "get", "watch"] },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name: "system:kube-vip-binding" },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "system:kube-vip-role" },
      subjects: [{ kind: "ServiceAccount", name: KUBE_VIP, namespace }],
    },
    {
      apiVersion: "apps/v1",
      kind: "DaemonSet",
      metadata: { name: KUBE_VIP, namespace, labels: APP },
      spec: {
        selector: { matchLabels: APP },
        template: {
          metadata: { labels: APP },
          spec: {
            serviceAccountName: KUBE_VIP,
            hostNetwork: true,
            nodeSelector: { [VIP_LABEL]: "1" },
            containers: [
              {
                name: KUBE_VIP,
                image,
                imagePullPolicy: "Never",
                args: ["manager"],
                env: [
                  ...Object.entries(env).map(([name, value]) => ({ name, value })),
                  { name: "vip_nodename", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
                ],
                securityContext: { capabilities: { add: ["NET_ADMIN", "NET_RAW"] } },
              },
            ],
          },
        },
      },
    },
  ];
};

/** This is the Lease of the election, as the API gives it: its holder and its times. */
export interface VipLease {
  readonly holder: string | null;
  readonly acquireTime: string | null;
  readonly renewTime: string | null;
  readonly leaseDurationSeconds: number | null;
  readonly leaseTransitions: number | null;
}

/** This function gives the Lease of the election, or null when it is not there yet. */
export const vipLeaseOf = async (cluster: Pick<Cluster, "kubectl">): Promise<VipLease | null> => {
  const text = await cluster.kubectl(["-n", KUBE_VIP_LEASE.namespace, "get", "lease", KUBE_VIP_LEASE.name, "-o", "json", "--ignore-not-found"]);
  if (text.trim() === "") return null;
  const spec = (JSON.parse(text) as { spec?: Record<string, unknown> }).spec ?? {};
  const text0 = (key: string): string | null => (typeof spec[key] === "string" && spec[key] !== "" ? (spec[key] as string) : null);
  const number0 = (key: string): number | null => (typeof spec[key] === "number" ? (spec[key] as number) : null);
  return {
    holder: text0("holderIdentity"),
    acquireTime: text0("acquireTime"),
    renewTime: text0("renewTime"),
    leaseDurationSeconds: number0("leaseDurationSeconds"),
    leaseTransitions: number0("leaseTransitions"),
  };
};

/** This is the Docker network of a cluster: its IPv4 subnet, and the MAC address of each container on it, by name. */
export interface VipNetwork {
  readonly subnet: string;
  readonly macs: Readonly<Record<string, string>>;
}

/** This function reads the Docker network of a cluster: its IPv4 subnet, and the MAC address of each container. */
export const vipNetworkOf = async (network: string): Promise<VipNetwork> => {
  const [info] = JSON.parse(await command("docker", ["network", "inspect", network])) as Array<{
    IPAM?: { Config?: Array<{ Subnet?: string }> | null };
    Containers?: Record<string, { Name?: string; MacAddress?: string }> | null;
  }>;
  const subnet = (info?.IPAM?.Config ?? []).map((config) => config.Subnet ?? "").find((each) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(each));
  if (subnet === undefined) throw new Error(`the Docker network ${network} has no IPv4 subnet`);
  const macs: Record<string, string> = {};
  for (const container of Object.values(info?.Containers ?? {})) if (container.Name !== undefined && container.MacAddress !== undefined) macs[container.Name] = container.MacAddress.toLowerCase();
  return { subnet, macs };
};

/**
 * This function gives the VIP of a subnet: the sixth address from its end. Docker gives the address
 * of each container from the start of the subnet, thus no container takes it.
 */
export const vipOf = (subnet: string): string => {
  const [first, last] = cidrRange(subnet);
  const address = last - 5;
  if (address <= first + 1) throw new Error(`the subnet ${subnet} is too small for a VIP`);
  return [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join(".");
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PodList {
  readonly items: ReadonlyArray<{
    readonly metadata: { readonly name: string; readonly deletionTimestamp?: string };
    readonly spec: { readonly nodeName?: string };
    readonly status?: { readonly containerStatuses?: ReadonlyArray<{ readonly ready: boolean; readonly restartCount?: number }> };
  }>;
}

/** This is a pod of kube-vip that is not deleted: its name, its node, if it is ready, and the restarts of its container. */
export interface KubeVipPod {
  readonly name: string;
  readonly node: string;
  readonly ready: boolean;
  readonly restarts: number;
}

/** This function gives the pods of kube-vip that are not deleted. */
export const kubeVipPods = async (cluster: Pick<Cluster, "kubectl">): Promise<KubeVipPod[]> => {
  const list = JSON.parse(await cluster.kubectl(["-n", KUBE_VIP_LEASE.namespace, "get", "pods", "-l", `app.kubernetes.io/name=${KUBE_VIP}`, "-o", "json"])) as PodList;
  return list.items
    .filter((pod) => pod.metadata.deletionTimestamp === undefined)
    .map((pod) => {
      const statuses = pod.status?.containerStatuses ?? [];
      return {
        name: pod.metadata.name,
        node: pod.spec.nodeName ?? "",
        ready: statuses.length > 0 && statuses.every((status) => status.ready),
        restarts: statuses.reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
      };
    });
};

/** This function gives the nodes with a ready pod of kube-vip that is not deleted. */
export const kubeVipReady = async (cluster: Pick<Cluster, "kubectl">): Promise<string[]> =>
  (await kubeVipPods(cluster))
    .filter((pod) => pod.ready && pod.node !== "")
    .map((pod) => pod.node)
    .sort();

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

const label = (cluster: Pick<Cluster, "kubectl">, node: string, on: boolean): Promise<string> =>
  cluster.kubectl(["label", "node", node, on ? `${VIP_LABEL}=1` : `${VIP_LABEL}-`, ...(on ? ["--overwrite"] : [])]);

/**
 * This function makes `holder` the holder of the VIP, with a ready pod of kube-vip on each node of
 * `nodes`. It gives null, or why it could not in `within` ms. If another node holds the lease, the
 * function takes the label from each other node. The DaemonSet then deletes their pods. The leader
 * gives back its lease at its stop (`ReleaseOnCancel`). The function gives each label back after
 * `holder` takes the lease.
 *
 * A leader that lost its lease restarted its container. The kubelet gives a container a longer
 * back-off at each restart, thus the function first deletes each pod of kube-vip with a restart.
 * The DaemonSet then makes a new pod with no back-off.
 */
export const holdVip = async (cluster: Pick<Cluster, "kubectl">, holder: string, nodes: readonly string[], within = 180_000): Promise<string | null> => {
  const others = nodes.filter((node) => node !== holder);
  for (const pod of await kubeVipPods(cluster))
    if (pod.restarts > 0) await cluster.kubectl(["-n", KUBE_VIP_LEASE.namespace, "delete", "pod", pod.name, "--wait=true", "--timeout=120s"]);
  await label(cluster, holder, true);
  const own = await until(within, async () => ((await kubeVipReady(cluster)).includes(holder) ? null : `kube-vip on ${holder} is not ready`));
  if (own !== null) return own;
  const held = async (): Promise<string | null> => {
    const lease = await vipLeaseOf(cluster);
    return lease?.holder === holder ? null : `the lease ${KUBE_VIP_LEASE.name} is held by ${lease?.holder ?? "no node"}, not ${holder}`;
  };
  if ((await held()) !== null) {
    for (const node of others) await label(cluster, node, false);
    const moved = await until(within, held);
    if (moved !== null) return moved;
  }
  for (const node of others) await label(cluster, node, true);
  return until(within, async () => {
    const ready = await kubeVipReady(cluster);
    const missing = nodes.filter((node) => !ready.includes(node));
    return missing.length === 0 ? null : `kube-vip is not ready on ${missing.join(", ")}`;
  });
};

/**
 * This function installs kube-vip in a cluster, with its image on each node (`cluster.load`), and
 * makes `holder` the holder of the VIP. A failed install gives the pods of kube-vip and the tail of
 * their logs.
 */
export const installKubeVip = async (cluster: Cluster, image: string, holder: string, nodes: readonly string[]): Promise<void> => {
  try {
    await label(cluster, holder, true);
    await cluster.apply(kubeVipObjects(image));
    const why = await holdVip(cluster, holder, nodes);
    if (why !== null) throw new Error(why);
  } catch (error) {
    const state = async (args: readonly string[]): Promise<string> =>
      (await cluster.kubectl(["-n", KUBE_VIP_LEASE.namespace, ...args]).catch((failure: unknown) => String(failure))).slice(-4000);
    const pods = await state(["get", "pods", "-l", `app.kubernetes.io/name=${KUBE_VIP}`, "-o", "wide"]);
    const logs = await state(["logs", "-l", `app.kubernetes.io/name=${KUBE_VIP}`, "--tail=40", "--prefix"]);
    throw new Error(`the install of kube-vip failed: ${String(error)}\nthe pods of kube-vip:\n${pods}\nthe logs:\n${logs}`);
  }
};

/**
 * This function waits until the Service of a VIP has the VIP in its status: kube-vip took it. It
 * gives null, or why not in `within` ms.
 */
export const vipServed = (cluster: Pick<Cluster, "kubectl">, namespace: string, service: string, vip: string, within = 120_000): Promise<string | null> =>
  until(within, async () => {
    const ingress = (await cluster.kubectl(["-n", namespace, "get", "service", service, "-o", "jsonpath={.status.loadBalancer.ingress[*].ip}"])).trim();
    return ingress.split(/\s+/).includes(vip) ? null : `the Service ${service} has the ingress ${ingress || "none"}, not ${vip}`;
  });
