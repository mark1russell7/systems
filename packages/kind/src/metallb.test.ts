import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { KUBE_VIP_ANNOUNCER, METALLB_ANNOUNCER, announcerOf, macsAt } from "./announcer.ts";
import type { KindCell } from "./cell.ts";
import { deletes, planOf } from "./faults.ts";
import { ensurePinnedChart } from "./helm.ts";
import { VIP_LABEL } from "./kubevip.ts";
import { arpMacOf } from "./lab.ts";
import { vipService } from "./manifests.ts";
import { cidrRange } from "./scenario.ts";
import {
  ANNOUNCE_ANNOTATION,
  MEMBERLIST,
  MEMBERLIST_FILE,
  METALLB_ANNOTATION,
  METALLB_CHART,
  METALLB_IMAGES,
  METALLB_NAMESPACE,
  METALLB_VERSION,
  announcementsOf,
  holdMetallb,
  memberlistFileOf,
  memberlistTermsOf,
  metallbObjects,
  metallbValues,
  metallbVipOf,
  ownerOrder,
  suspicionOf,
} from "./metallb.ts";

/** This cluster answers kubectl from a function of the arguments, and records each call. */
const fake = (answer: (args: readonly string[]) => string) => {
  const calls: string[][] = [];
  return { calls, kubectl: async (args: readonly string[]) => (calls.push([...args]), answer(args)) };
};

const statuses = (nodes: readonly string[], service = "server", namespace = "lab") =>
  JSON.stringify({ items: nodes.map((node) => ({ metadata: { creationTimestamp: "2026-11-02T10:00:00Z" }, status: { node, serviceName: service, serviceNamespace: namespace } })) });

const speakers = (nodes: readonly string[]) =>
  JSON.stringify({ items: nodes.map((node) => ({ metadata: {}, spec: { nodeName: node }, status: { containerStatuses: [{ ready: true }] } })) });

describe("the install of MetalLB", () => {
  it("pins the chart and each image of 0.16.1 by sha256", () => {
    expect(METALLB_CHART.url).toBe(`https://github.com/metallb/metallb/releases/download/metallb-chart-${METALLB_VERSION}/metallb-${METALLB_VERSION}.tgz`);
    expect(METALLB_CHART.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(METALLB_IMAGES.speaker).toMatch(/^quay\.io\/metallb\/speaker:v0\.16\.1@sha256:[0-9a-f]{64}$/);
    expect(METALLB_IMAGES.controller).toMatch(/^quay\.io\/metallb\/controller:v0\.16\.1@sha256:[0-9a-f]{64}$/);
  });

  it("downloads a chart in the cache whose sha256 is not the pinned value again, and refuses a wrong download", async () => {
    const cache = mkdtempSync(join(tmpdir(), "metallb-chart-"));
    mkdirSync(join(cache, "charts"), { recursive: true });
    writeFileSync(join(cache, "charts", `metallb-${METALLB_VERSION}.tgz`), "another chart");
    const urls: string[] = [];
    const get = async (url: string): Promise<Uint8Array> => (urls.push(url), new TextEncoder().encode("a third chart"));
    await expect(ensurePinnedChart(METALLB_CHART, cache, get)).rejects.toThrow(/not the pinned/);
    expect(urls).toEqual([METALLB_CHART.url]);
  });

  it("has no BGP, speakers only on the labelled workers, the controller on the control plane, and the local images", () => {
    const values = metallbValues({ speaker: "systems-lab/speaker:v0.16.1-0123456789ab", controller: "systems-lab/controller:v0.16.1-ba9876543210" });
    expect(values).toMatchObject({
      frrk8s: { enabled: false },
      speaker: {
        frr: { enabled: false },
        tolerateMaster: false,
        nodeSelector: { [VIP_LABEL]: "1" },
        memberlist: { enabled: true },
        image: { repository: "systems-lab/speaker", tag: "v0.16.1-0123456789ab", pullPolicy: "Never" },
      },
      controller: { nodeSelector: { "node-role.kubernetes.io/control-plane": "" }, image: { repository: "systems-lab/controller", tag: "v0.16.1-ba9876543210", pullPolicy: "Never" } },
    });
    expect(() => metallbValues({ speaker: "speaker", controller: "controller:x" })).toThrow(/no tag/);
  });

  it("gives a pool of only the VIP and an L2Advertisement of that pool", () => {
    expect(metallbObjects("172.18.255.250")).toEqual([
      { apiVersion: "metallb.io/v1beta1", kind: "IPAddressPool", metadata: { name: "lab-vip", namespace: METALLB_NAMESPACE }, spec: { addresses: ["172.18.255.250/32"] } },
      { apiVersion: "metallb.io/v1beta1", kind: "L2Advertisement", metadata: { name: "lab-vip", namespace: METALLB_NAMESPACE }, spec: { ipAddressPools: ["lab-vip"] } },
    ]);
  });
});

describe("the owner of a VIP of MetalLB", () => {
  it("is the first node by sha256(node + '#' + VIP), as bytes", () => {
    const nodes = ["lab-worker", "lab-worker2", "lab-worker3"];
    const vip = "172.18.255.250";
    const hex = (node: string) => createHash("sha256").update(`${node}#${vip}`).digest("hex");
    expect(ownerOrder(nodes, vip)).toEqual([...nodes].sort((a, b) => hex(a).localeCompare(hex(b))));
  });

  it("chooses the first address down from the sixth from the end that the lost node owns", () => {
    const nodes = ["lab-worker", "lab-worker2"];
    for (const owner of nodes) {
      const vip = metallbVipOf("172.18.0.0/16", owner, nodes);
      expect(ownerOrder(nodes, vip)[0]).toBe(owner);
      const [, last] = cidrRange("172.18.0.0/16");
      const address = vip.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0);
      expect(address).toBeLessThanOrEqual(last - 5);
      expect(address).toBeGreaterThan(last - 260);
    }
    expect(() => metallbVipOf("172.18.0.0/16", "lab-control-plane", nodes)).toThrow(/not one of the nodes/);
  });
});

describe("memberlist of the speakers", () => {
  it("has the defaults of DefaultLANConfig of v0.5.1", () => {
    expect(valueIn(MEMBERLIST.probeInterval, "ms")).toBe(1000);
    expect(valueIn(MEMBERLIST.probeTimeout, "ms")).toBe(500);
    expect(MEMBERLIST.suspicionMult).toBe(4);
    expect(MEMBERLIST.suspicionMaxTimeoutMult).toBe(6);
    expect(valueIn(MEMBERLIST.pushPullInterval, "s")).toBe(30);
  });

  it("gives the suspicion timeout of util.go: the minimum when no peer can confirm, else the maximum", () => {
    // two speakers: max(1, log10 2) = 1, and n − 2 = 0 < k = 2, thus k = 0 and the timer is the minimum
    expect(valueIn(suspicionOf(1), "ms")).toBe(4000);
    expect(valueIn(suspicionOf(2), "ms")).toBe(4000);
    expect(valueIn(suspicionOf(3), "ms")).toBe(4000);
    // four speakers have k = 2 peers that can confirm: 6 × the minimum with no confirmation
    expect(valueIn(suspicionOf(4), "ms")).toBe(24_000);
    // a hundred: log10 100 = 2, thus 8 s, and 48 s as the maximum
    expect(valueIn(suspicionOf(100), "ms")).toBe(48_000);
  });
});

describe("the config file of memberlist (SYS-57)", () => {
  // the fields of memberlistFileConfig in internal/speakerlist/speakerlist.go of v0.16.1, lines 355–379
  const FIELDS = [
    "TCPTimeout",
    "IndirectChecks",
    "RetransmitMult",
    "SuspicionMult",
    "SuspicionMaxTimeoutMult",
    "PushPullInterval",
    "ProbeTimeout",
    "ProbeInterval",
    "DisableTcpPings",
    "AwarenessMaxMultiplier",
    "GossipNodes",
    "GossipInterval",
    "GossipToTheDeadTime",
    "GossipVerifyIncoming",
    "GossipVerifyOutgoing",
    "EnableCompression",
    "HandoffQueueDepth",
    "UDPBufferSize",
    "QueueCheckInterval",
  ];
  const fast = { probeInterval: { value: 500, unit: "ms" }, probeTimeout: { value: 250, unit: "ms" }, suspicionMult: 2 } as const;

  it("has each field that the speaker needs, with the defaults of DefaultLANConfig", () => {
    expect(Object.keys(MEMBERLIST_FILE).sort()).toEqual([...FIELDS].sort());
    expect(MEMBERLIST_FILE["ProbeInterval"]).toBe(`${valueIn(MEMBERLIST.probeInterval, "ms") / 1000}s`);
    expect(MEMBERLIST_FILE["ProbeTimeout"]).toBe(`${valueIn(MEMBERLIST.probeTimeout, "ms")}ms`);
    expect(MEMBERLIST_FILE["SuspicionMult"]).toBe(MEMBERLIST.suspicionMult);
    expect(MEMBERLIST_FILE["SuspicionMaxTimeoutMult"]).toBe(MEMBERLIST.suspicionMaxTimeoutMult);
  });

  it("changes only the probe interval, the probe timeout and the multiplier, as durations of Go", () => {
    const file = memberlistFileOf(fast);
    expect(Object.keys(file).sort()).toEqual([...FIELDS].sort());
    expect(file).toMatchObject({ ProbeInterval: "500ms", ProbeTimeout: "250ms", SuspicionMult: 2 });
    const changed = FIELDS.filter((field) => file[field] !== MEMBERLIST_FILE[field]);
    expect(changed.sort()).toEqual(["ProbeInterval", "ProbeTimeout", "SuspicionMult"]);
  });

  it("refuses a timeout that is not less than the interval, a part of a millisecond, or a multiplier below 1", () => {
    expect(() => memberlistFileOf({ ...fast, probeTimeout: { value: 500, unit: "ms" } })).toThrow(RangeError);
    expect(() => memberlistFileOf({ ...fast, probeTimeout: { value: 0.5, unit: "ms" } })).toThrow(RangeError);
    expect(() => memberlistFileOf({ ...fast, suspicionMult: 0 })).toThrow(RangeError);
  });

  it("gives the terms of the settings to the suspicion timeout: SuspicionMult × ProbeInterval for two speakers", () => {
    expect(memberlistTermsOf(undefined)).toBe(MEMBERLIST);
    expect(valueIn(suspicionOf(2, memberlistTermsOf(fast)), "ms")).toBe(1000);
    expect(valueIn(suspicionOf(2, memberlistTermsOf({ ...fast, probeInterval: { value: 1, unit: "s" } })), "ms")).toBe(2000);
  });
});

describe("a pause of the speaker of the owner (SYS-57)", () => {
  const cell = {
    template: "T07",
    trigger: { kind: "freeze-process", hold: { value: 2, unit: "s" }, flaps: [{ rest: { value: 20, unit: "s" }, hold: { value: 4, unit: "s" } }] },
    vip: { clients: 3, announcer: "metallb" },
    workload: {},
    pod: { replicas: 2 },
  } as unknown as KindCell;

  it("is a SIGSTOP of the speaker, and its SIGCONT at the end of each hold, with no deletion", () => {
    const plan = planOf(cell);
    expect(plan.inject).toEqual([{ do: "signal", target: "speaker", signal: "SIGSTOP" }]);
    expect(plan.heal).toEqual([{ do: "signal", target: "speaker", signal: "SIGCONT" }]);
    expect(plan.restore).toEqual([{ do: "signal", target: "speaker", signal: "SIGCONT" }]);
    expect(valueIn(plan.hold!, "s")).toBe(2);
    expect(plan.flaps).toHaveLength(1);
    expect(deletes(cell)).toBe(false);
  });
});

describe("the hold of MetalLB before a run", () => {
  it("waits for the owner to be the only node that announces, then annotates the Service", async () => {
    let seen = 0;
    const cluster = fake((args) => {
      if (args.includes("pods")) return speakers(["w1", "w2"]);
      if (args.some((arg) => arg === "servicel2statuses.metallb.io")) return statuses(seen++ === 0 ? ["w1", "w2"] : ["w2"]);
      return "";
    });
    expect(await holdMetallb(cluster, "w2", ["w1", "w2"], "lab", "server", 5000)).toBeNull();
    const annotate = cluster.calls.find((call) => call.includes("annotate"));
    expect(annotate).toBeDefined();
    expect(annotate!.join(" ")).toMatch(new RegExp(`^-n lab annotate service server ${ANNOUNCE_ANNOTATION}=\\d+ --overwrite$`));
  });

  it("gives why, when another node keeps the VIP", async () => {
    const cluster = fake((args) => (args.includes("pods") ? speakers(["w1", "w2"]) : statuses(["w1"])));
    expect(await holdMetallb(cluster, "w2", ["w1", "w2"], "lab", "server", 600)).toBe("the Service server is announced by w1, not only by w2");
    expect(cluster.calls.some((call) => call.includes("annotate"))).toBe(false);
  });

  it("reads only the statuses of the Service", async () => {
    const cluster = fake(() =>
      JSON.stringify({
        items: [
          { status: { node: "w1", serviceName: "server", serviceNamespace: "lab" } },
          { status: { node: "w2", serviceName: "other", serviceNamespace: "lab" } },
          { status: { node: "w2", serviceName: "server", serviceNamespace: "lab-2" } },
        ],
      }),
    );
    expect(await announcementsOf(cluster, "lab", "server")).toEqual([{ node: "w1", created: null }]);
  });
});

describe("the announcers of a VIP", () => {
  it("are kube-vip by default, and MetalLB when the cell names it", () => {
    expect(announcerOf({ vip: { clients: 3 } })).toBe(KUBE_VIP_ANNOUNCER);
    expect(announcerOf({ vip: { clients: 3, announcer: "metallb" } })).toBe(METALLB_ANNOUNCER);
    expect(Object.keys(METALLB_ANNOUNCER.images)).toEqual(["metallb-speaker", "metallb-controller"]);
  });

  it("give the Service of a VIP its class and annotation: none and the annotation of MetalLB", () => {
    const ports = [{ name: "http", port: 80, targetPort: 8080 }];
    const metallb = vipService("lab", "172.18.255.250", ports, METALLB_ANNOUNCER.service) as { metadata: { annotations: Record<string, string> }; spec: Record<string, unknown> };
    expect(metallb.metadata.annotations).toEqual({ [METALLB_ANNOTATION]: "172.18.255.250" });
    expect(metallb.spec).not.toHaveProperty("loadBalancerClass");
    expect(metallb.spec).toMatchObject({ type: "LoadBalancer", externalTrafficPolicy: "Cluster" });
    expect(vipService("lab", "172.18.255.250", ports)).toEqual(vipService("lab", "172.18.255.250", ports, KUBE_VIP_ANNOUNCER.service));
  });

  it("read the MAC of the VIP in /proc/net/arp, and know when each client sends to the holder", () => {
    const table = [
      "IP address       HW type     Flags       HW address            Mask     Device",
      "172.18.0.3       0x1         0x2         02:42:AC:12:00:03     *        eth0",
      "172.18.255.250   0x1         0x2         02:42:ac:12:00:04     *        eth0",
      "172.18.255.251   0x1         0x0         00:00:00:00:00:00     *        eth0",
    ].join("\n");
    expect(arpMacOf(table, "172.18.255.250")).toBe("02:42:ac:12:00:04");
    expect(arpMacOf(table, "172.18.0.3")).toBe("02:42:ac:12:00:03");
    expect(arpMacOf(table, "172.18.255.251")).toBeNull();
    expect(arpMacOf(table, "172.18.255.252")).toBeNull();
    const mac = "02:42:ac:12:00:04";
    expect(macsAt([{ client: "outside-0", mac }, { client: "outside-1", mac }], mac, 2)).toBeNull();
    expect(macsAt([{ client: "outside-0", mac }, { client: "outside-1", mac: null }], mac, 2)).toBe("outside-1 has no MAC");
    expect(macsAt([{ client: "outside-0", mac }], mac, 2)).toBe("1 clients outside answer, not 2");
  });
});
