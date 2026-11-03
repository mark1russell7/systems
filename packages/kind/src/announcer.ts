import type { Quantity } from "@mark1russell7/quantity";
import type { KindCell, VipAnnouncerName } from "./cell.ts";
import type { Cluster } from "./cluster.ts";
import { KUBE_VIP, KUBE_VIP_ARP_RATE, KUBE_VIP_IMAGE, KUBE_VIP_LEASE, holdVip, installKubeVip, vipLeaseOf, vipOf } from "./kubevip.ts";
import { METALLB_ANNOTATION, METALLB_IMAGES, METALLB_SPAM, holdMetallb, installMetallb, metallbRecord, metallbVipOf } from "./metallb.ts";
import { LB_CLASS, VIP_ANNOTATION } from "./names.ts";

/**
 * This module gives one shape to each announcer of a VIP: kube-vip (SYS-51) and MetalLB in L2 mode
 * (SYS-53). The lab, the Service of the VIP and the clients outside the cluster are the same for
 * each one. Only the install, the choice of the VIP, the hold before each run and the record differ.
 */

/** This is how the Service of a VIP selects its announcer: its class of load balancer, or none, and the annotation of its address. */
export interface VipService {
  readonly loadBalancerClass: string | null;
  readonly annotation: string;
}

/** An announcer is one way to give a Service of type LoadBalancer a VIP on the Docker network of the nodes. */
export interface VipAnnouncer {
  readonly name: VipAnnouncerName;
  /** These are the images of the announcer, pinned by digest, by their names in the manifest of a record. */
  readonly images: Readonly<Record<string, string>>;
  readonly service: VipService;
  /** This time is the most from the end of a hold to the first gratuitous ARP of the holder. */
  readonly settle: Quantity;
  /** This function gives the VIP of a subnet, with `owner` its holder among `nodes`. */
  readonly vipOf: (subnet: string, owner: string, nodes: readonly string[]) => string;
  /** This function installs the announcer, with the local tags of its images, by the names of `images`. */
  readonly install: (cluster: Cluster, local: Readonly<Record<string, string>>, owner: string, nodes: readonly string[], vip: string) => Promise<void>;
  /** This function makes `owner` the holder of the VIP before a run. It gives null, or why not. */
  readonly hold: (cluster: Cluster, owner: string, nodes: readonly string[], namespace: string, service: string) => Promise<string | null>;
  /** This function gives the state of the announcer after a run, for the line `vip`. */
  readonly record: (cluster: Cluster, namespace: string, service: string) => Promise<Record<string, unknown>>;
}

const local = (images: Readonly<Record<string, string>>, name: string): string => {
  const image = images[name];
  if (image === undefined) throw new Error(`the run has no local image of ${name}`);
  return image;
};

/** This announcer is kube-vip 1.3.1 in ARP mode, with one Lease for each VIP of a Service (`kubevip.ts`). */
export const KUBE_VIP_ANNOUNCER: VipAnnouncer = {
  name: "kube-vip",
  images: { [KUBE_VIP]: KUBE_VIP_IMAGE },
  service: { loadBalancerClass: LB_CLASS, annotation: VIP_ANNOTATION },
  settle: KUBE_VIP_ARP_RATE,
  vipOf: (subnet) => vipOf(subnet),
  install: (cluster, images, owner, nodes) => installKubeVip(cluster, local(images, KUBE_VIP), owner, nodes),
  hold: (cluster, owner, nodes) => holdVip(cluster, owner, nodes),
  record: async (cluster) => {
    const lease = await vipLeaseOf(cluster);
    const log = await cluster
      .kubectl(["-n", KUBE_VIP_LEASE.namespace, "logs", "-l", `app.kubernetes.io/name=${KUBE_VIP}`, "--tail=30", "--prefix", "--timestamps"])
      .catch((error: unknown) => String(error));
    return { lease, log: log.slice(-6000) };
  },
};

/** This announcer is MetalLB 0.16.1 in L2 mode, with its speakers in memberlist (`metallb.ts`). */
export const METALLB_ANNOUNCER: VipAnnouncer = {
  name: "metallb",
  images: { "metallb-speaker": METALLB_IMAGES.speaker, "metallb-controller": METALLB_IMAGES.controller },
  service: { loadBalancerClass: null, annotation: METALLB_ANNOTATION },
  settle: METALLB_SPAM.for,
  vipOf: (subnet, owner, nodes) => metallbVipOf(subnet, owner, nodes),
  install: (cluster, images, _owner, nodes, vip) => installMetallb(cluster, { speaker: local(images, "metallb-speaker"), controller: local(images, "metallb-controller") }, nodes, vip),
  hold: (cluster, owner, nodes, namespace, service) => holdMetallb(cluster, owner, nodes, namespace, service),
  record: (cluster, namespace, service) => metallbRecord(cluster, namespace, service),
};

/** This function gives the announcer of the VIP of a cell: kube-vip when the cell names none. */
export const announcerOf = (cell: Pick<KindCell, "vip">): VipAnnouncer => (cell.vip?.announcer === "metallb" ? METALLB_ANNOUNCER : KUBE_VIP_ANNOUNCER);

/** This function gives null if each client sends to `mac`, or the clients that do not. */
export const macsAt = (found: ReadonlyArray<{ readonly client: string; readonly mac: string | null }>, mac: string, count: number): string | null => {
  const wrong = found.filter((each) => each.mac !== mac);
  if (found.length !== count) return `${found.length} clients outside answer, not ${count}`;
  return wrong.length === 0 ? null : wrong.map((each) => `${each.client} has ${each.mac ?? "no MAC"}`).join(", ");
};
