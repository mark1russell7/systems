import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";

/** A kube-proxy mode is the dataplane of each node: iptables (the default of kind), IPVS or nftables. */
export type KubeProxyMode = "iptables" | "ipvs" | "nftables";
export const KUBE_PROXY_MODES: readonly KubeProxyMode[] = ["iptables", "ipvs", "nftables"];

/** A node image is the kind node image of one Kubernetes version, pinned by digest. */
export interface NodeImage {
  readonly kubernetes: string;
  readonly image: string;
}

/**
 * These are the node images of kind v0.33.0, from its release notes. The image of Kubernetes 1.37
 * is v1.37.0. The research names v1.37.1 for some defaults, thus a default that changed in the
 * patch release is a mismatch to record.
 */
export const NODE_IMAGES: Readonly<Record<string, NodeImage>> = {
  "1.37": {
    kubernetes: "v1.37.0",
    image: "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5",
  },
  "1.36": {
    kubernetes: "v1.36.4",
    image: "kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed",
  },
};

/**
 * A scenario is one kind cluster as data. The lab generates the configuration of kind from it, and
 * nothing comes from a default of kind. The scenario gives the node count, the version, the mode
 * of kube-proxy and its sync periods, the CNI and the subnets.
 */
export interface KindScenario {
  /** This name names the cluster and its Docker network: lowercase letters, digits and dashes. */
  readonly name: string;
  /** This key selects the node image (`NODE_IMAGES`). */
  readonly kubernetes: string;
  /** This count is the number of workers. The cluster also has one control plane. */
  readonly workers: number;
  readonly kubeProxy: {
    readonly mode: KubeProxyMode;
    /** This time is the shortest interval between two syncs of the rules. */
    readonly minSyncPeriod: Quantity;
    /** This time is the interval of the full sync of the rules. */
    readonly syncPeriod: Quantity;
  };
  /** This CNI is kindnet, the CNI of kind. Cilium comes later. */
  readonly cni: "kindnet";
  readonly podSubnet: string;
  readonly serviceSubnet: string;
  /**
   * If this flag is true, each node has the label `topology.kubernetes.io/zone`. The last worker is
   * in the zone `ZONE_LOST`, and the other nodes are in the zone `ZONE_KEPT`.
   */
  readonly zoned?: boolean;
}

/** This label gives the zone of a node, as Kubernetes names it. */
export const ZONE_LABEL = "topology.kubernetes.io/zone";
/** This zone holds the control plane and each worker but the last. A zone loss keeps it. */
export const ZONE_KEPT = "zone-a";
/** This zone holds only the last worker. A zone loss loses it. */
export const ZONE_LOST = "zone-b";

/** This function gives the zone of the node at the position `at` of `nodeNames`, in a cluster of `count` nodes. */
export const zoneOf = (at: number, count: number): string => (at === count - 1 && at > 0 ? ZONE_LOST : ZONE_KEPT);

/** This function gives a scenario with the defaults of Kubernetes for kube-proxy, as explicit values. */
export const scenario = (name: string, mode: KubeProxyMode, workers: number, kubernetes = "1.37", zoned = false): KindScenario => ({
  name,
  kubernetes,
  workers,
  kubeProxy: { mode, minSyncPeriod: { value: 1, unit: "s" }, syncPeriod: { value: 30, unit: "s" } },
  cni: "kindnet",
  podSubnet: "10.244.0.0/16",
  serviceSubnet: "10.96.0.0/16",
  ...(zoned ? { zoned } : {}),
});

const NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** This function gives the problems of a scenario: a name that kind refuses, no image for the version, or a count out of range. */
export const scenarioProblems = (s: KindScenario): string[] => {
  const problems: string[] = [];
  if (!NAME.test(s.name)) problems.push(`the name ${s.name} is not lowercase letters, digits and dashes of 1 to 32 characters`);
  if (NODE_IMAGES[s.kubernetes] === undefined) problems.push(`no node image is pinned for Kubernetes ${s.kubernetes}`);
  if (!Number.isInteger(s.workers) || s.workers < 0 || s.workers > 8) problems.push(`${s.workers} workers is not a whole number from 0 to 8`);
  if (cidrOverlap(s.podSubnet, s.serviceSubnet)) problems.push(`the pod subnet ${s.podSubnet} overlaps the service subnet ${s.serviceSubnet}`);
  return problems;
};

/** This function gives the names of the node containers, as kind names them: the control plane, then each worker. */
export const nodeNames = (s: KindScenario): string[] => [
  `${s.name}-control-plane`,
  ...Array.from({ length: s.workers }, (_, at) => `${s.name}-worker${at === 0 ? "" : at + 1}`),
];

/** This function gives a duration as kube-proxy reads it, in whole milliseconds: `1s`, `500ms`. */
export const goDuration = (amount: Quantity): string => {
  const ms = valueIn(amount, "ms");
  if (!Number.isInteger(ms) || ms < 0) throw new RangeError(`${ms} ms is not a whole number of milliseconds`);
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
};

/** This function gives the KubeProxyConfiguration patch of a scenario, as kubeadm reads it. */
export const kubeProxyPatch = (s: KindScenario): string =>
  [
    "apiVersion: kubeproxy.config.k8s.io/v1alpha1",
    "kind: KubeProxyConfiguration",
    `mode: ${s.kubeProxy.mode}`,
    `${s.kubeProxy.mode}:`,
    `  minSyncPeriod: ${goDuration(s.kubeProxy.minSyncPeriod)}`,
    `  syncPeriod: ${goDuration(s.kubeProxy.syncPeriod)}`,
    "",
  ].join("\n");

/** A kind configuration is the cluster file that `kind create cluster --config` reads. JSON is YAML, thus the lab writes it as JSON. */
export interface KindConfig {
  readonly kind: "Cluster";
  readonly apiVersion: "kind.x-k8s.io/v1alpha4";
  readonly networking: {
    readonly ipFamily: "ipv4";
    readonly kubeProxyMode: KubeProxyMode;
    readonly disableDefaultCNI: boolean;
    readonly podSubnet: string;
    readonly serviceSubnet: string;
  };
  readonly nodes: ReadonlyArray<{
    readonly role: "control-plane" | "worker";
    readonly image: string;
    readonly labels: Readonly<Record<string, string>>;
  }>;
  readonly kubeadmConfigPatches: readonly string[];
}

/** This function generates the configuration of kind from a scenario. It refuses a scenario with a problem. */
export const kindConfig = (s: KindScenario): KindConfig => {
  const problems = scenarioProblems(s);
  if (problems.length > 0) throw new Error(`the scenario ${s.name}: ${problems.join("; ")}`);
  const image = NODE_IMAGES[s.kubernetes]!.image;
  return {
    kind: "Cluster",
    apiVersion: "kind.x-k8s.io/v1alpha4",
    networking: {
      ipFamily: "ipv4",
      kubeProxyMode: s.kubeProxy.mode,
      disableDefaultCNI: false,
      podSubnet: s.podSubnet,
      serviceSubnet: s.serviceSubnet,
    },
    nodes: nodeNames(s).map((node, at, all) => ({
      role: at === 0 ? "control-plane" : "worker",
      image,
      labels: {
        "lab.systems/node": node.slice(s.name.length + 1),
        ...(s.zoned === true ? { [ZONE_LABEL]: zoneOf(at, all.length) } : {}),
      },
    })),
    kubeadmConfigPatches: [kubeProxyPatch(s)],
  };
};

/** This function gives the first and the last address of an IPv4 CIDR, as numbers. */
export const cidrRange = (cidr: string): [number, number] => {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (match === null) throw new Error(`not an IPv4 CIDR: ${cidr}`);
  const octets = match.slice(1, 5).map(Number);
  const bits = Number(match[5]);
  if (octets.some((octet) => octet > 255) || bits > 32) throw new Error(`not an IPv4 CIDR: ${cidr}`);
  const base = octets.reduce((sum, octet) => sum * 256 + octet, 0);
  const size = 2 ** (32 - bits);
  const first = Math.floor(base / size) * size;
  return [first, first + size - 1];
};

/** This function tells if two IPv4 CIDRs share an address. */
export const cidrOverlap = (a: string, b: string): boolean => {
  const [a0, a1] = cidrRange(a);
  const [b0, b1] = cidrRange(b);
  return a0 <= b1 && b0 <= a1;
};
