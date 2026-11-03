import { describe, expect, it } from "vitest";
import { KUBE_VIP_ELECTION, KUBE_VIP_IMAGE, KUBE_VIP_LEASE, KUBE_VIP_VERSION, VIP_LABEL, holdVip, kubeVipObjects, kubeVipReady, vipLeaseOf, vipOf } from "./kubevip.ts";

interface Container {
  readonly image: string;
  readonly env: ReadonlyArray<{ readonly name: string; readonly value?: string; readonly valueFrom?: unknown }>;
  readonly securityContext: { readonly capabilities: { readonly add: readonly string[] } };
}
interface DaemonSet {
  readonly kind: string;
  readonly spec: { readonly template: { readonly spec: { readonly hostNetwork: boolean; readonly nodeSelector: Record<string, string>; readonly containers: readonly Container[] } } };
}

/** This cluster answers kubectl from a list of answers, and records each call. */
const fake = (answer: (args: readonly string[]) => string) => {
  const calls: string[][] = [];
  return { calls, kubectl: async (args: readonly string[]) => (calls.push([...args]), answer(args)) };
};

describe("the install of kube-vip", () => {
  it("pins the image of the release by its digest", () => {
    expect(KUBE_VIP_IMAGE).toMatch(new RegExp(`^ghcr\\.io/kube-vip/kube-vip:v${KUBE_VIP_VERSION.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$`));
  });

  it("gives ARP mode, one election for the Services, and each time of the election of client-go", () => {
    const objects = kubeVipObjects("kube-vip:test") as Array<{ kind: string }>;
    expect(objects.map((object) => object.kind)).toEqual(["ServiceAccount", "ClusterRole", "ClusterRoleBinding", "DaemonSet"]);
    const daemonSet = objects.find((object) => object.kind === "DaemonSet") as unknown as DaemonSet;
    const pod = daemonSet.spec.template.spec;
    expect(pod).toMatchObject({ hostNetwork: true, nodeSelector: { [VIP_LABEL]: "1" } });
    const container = pod.containers[0]!;
    expect(container.image).toBe("kube-vip:test");
    expect(container.securityContext.capabilities.add).toEqual(["NET_ADMIN", "NET_RAW"]);
    const env = Object.fromEntries(container.env.map((each) => [each.name, each.value ?? "from the pod"]));
    expect(env).toEqual({
      vip_arp: "true",
      vip_interface: "eth0",
      port: "6443",
      cp_enable: "false",
      svc_enable: "true",
      svc_election: "false",
      svc_leasename: KUBE_VIP_LEASE.name,
      vip_leaderelection: "true",
      vip_leaseduration: "15",
      vip_renewdeadline: "10",
      vip_retryperiod: "2",
      vip_arpRate: "3000",
      vip_nodename: "from the pod",
    });
    expect(KUBE_VIP_ELECTION).toEqual({ lease: { value: 15, unit: "s" }, renew: { value: 10, unit: "s" }, retry: { value: 2, unit: "s" } });
  });

  it("gives a VIP near the end of the subnet, where Docker gives no container an address", () => {
    expect(vipOf("172.18.0.0/16")).toBe("172.18.255.250");
    expect(vipOf("10.89.0.0/24")).toBe("10.89.0.250");
    expect(() => vipOf("10.0.0.0/30")).toThrow(/too small/);
  });

  it("reads the Lease, and gives null when it is not there", async () => {
    const lease = { spec: { holderIdentity: "lab-worker2", acquireTime: "2026-11-02T10:00:00.123456Z", renewTime: "2026-11-02T10:00:02.000000Z", leaseDurationSeconds: 15, leaseTransitions: 3 } };
    expect(await vipLeaseOf(fake(() => JSON.stringify(lease)))).toEqual({
      holder: "lab-worker2",
      acquireTime: "2026-11-02T10:00:00.123456Z",
      renewTime: "2026-11-02T10:00:02.000000Z",
      leaseDurationSeconds: 15,
      leaseTransitions: 3,
    });
    expect(await vipLeaseOf(fake(() => ""))).toBeNull();
  });

  it("counts only the ready pods that are not deleted", async () => {
    const pods = {
      items: [
        { metadata: { name: "a" }, spec: { nodeName: "w2" }, status: { containerStatuses: [{ ready: true }] } },
        { metadata: { name: "b", deletionTimestamp: "x" }, spec: { nodeName: "w1" }, status: { containerStatuses: [{ ready: true }] } },
        { metadata: { name: "c" }, spec: { nodeName: "w3" }, status: { containerStatuses: [{ ready: false }] } },
        { metadata: { name: "d" }, spec: { nodeName: "w1" }, status: { containerStatuses: [{ ready: true }] } },
      ],
    };
    expect(await kubeVipReady(fake(() => JSON.stringify(pods)))).toEqual(["w1", "w2"]);
  });

  it("keeps each label when the holder has the Lease, and deletes a pod that restarted", async () => {
    const pods = {
      items: [
        { metadata: { name: "on-w1" }, spec: { nodeName: "w1" }, status: { containerStatuses: [{ ready: true, restartCount: 0 }] } },
        { metadata: { name: "on-w2" }, spec: { nodeName: "w2" }, status: { containerStatuses: [{ ready: true, restartCount: 2 }] } },
      ],
    };
    const lease = { spec: { holderIdentity: "w2" } };
    const cluster = fake((args) => (args.includes("lease") ? JSON.stringify(lease) : args.includes("pods") ? JSON.stringify(pods) : ""));
    expect(await holdVip(cluster, "w2", ["w1", "w2"], 5_000)).toBeNull();
    expect(cluster.calls.filter((call) => call.includes("delete")).map((call) => call.at(-3))).toEqual(["on-w2"]);
    expect(cluster.calls.some((call) => call.includes(`${VIP_LABEL}-`))).toBe(false);
  });
});
