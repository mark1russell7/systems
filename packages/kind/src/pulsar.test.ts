import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KindCell } from "./cell.ts";
import { cellOf } from "./cells.fixture.ts";
import { planOf } from "./faults.ts";
import { ensurePinnedChart } from "./helm.ts";
import { LOG_LABEL } from "./names.ts";
import {
  PRODUCER,
  PRODUCER_SCRIPT,
  PULSAR_CHART,
  PULSAR_IMAGE,
  PULSAR_LOOKUP,
  PULSAR_SERVICE,
  brokerOfHost,
  brokersOf,
  holdPulsar,
  ownerAtRest,
  pulsarObjects,
  pulsarValues,
} from "./pulsar.ts";

/** This cluster answers kubectl from a function of the arguments, and records each call. */
const fake = (answer: (args: readonly string[]) => string) => {
  const calls: string[][] = [];
  return { calls, kubectl: async (args: readonly string[]) => (calls.push([...args]), answer(args)) };
};

const pods = (ready: readonly boolean[]) =>
  JSON.stringify({
    items: ready.map((each, index) => ({
      metadata: { name: `pulsar-broker-${index}` },
      spec: { nodeName: `lab-worker${index === 0 ? "" : index + 1}` },
      status: { podIP: `10.244.${index + 1}.9`, containerStatuses: [{ ready: each }] },
    })),
  });

const CELL: KindCell = { ...cellOf("crash"), pulsar: { clients: 2, probe: { value: 250, unit: "ms" } } };
const OWNER = "pulsar-broker-1.pulsar-broker-headless.pulsar.svc.cluster.local";

describe("the install of Pulsar", () => {
  it("pins the chart 4.8.0 and the image 5.0.0 by sha256", () => {
    expect(PULSAR_CHART.url).toBe("https://downloads.apache.org/pulsar/helm-chart/4.8.0/pulsar-4.8.0.tgz");
    expect(PULSAR_CHART.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(PULSAR_IMAGE).toMatch(/^apachepulsar\/pulsar:5\.0\.0@sha256:[0-9a-f]{64}$/);
  });

  it("refuses a chart in the cache whose sha256 is not the pinned value", async () => {
    const cache = mkdtempSync(join(tmpdir(), "pulsar-chart-"));
    mkdirSync(join(cache, "charts"), { recursive: true });
    writeFileSync(join(cache, "charts", "pulsar-4.8.0.tgz"), "another chart");
    await expect(ensurePinnedChart(PULSAR_CHART, cache)).rejects.toThrow(/not the pinned/);
  });

  it("has one ZooKeeper, one bookie, two brokers, no other part, and the local image with no pull", () => {
    const values = pulsarValues("systems-lab/pulsar:5.0.0-0123456789ab");
    expect(values).toMatchObject({
      components: { zookeeper: true, bookkeeper: true, broker: true, autorecovery: false, proxy: false, toolset: false },
      "victoria-metrics-k8s-stack": { enabled: false },
      defaultPulsarImageRepository: "systems-lab/pulsar",
      defaultPulsarImageTag: "5.0.0-0123456789ab",
      defaultPullPolicy: "Never",
      zookeeper: { replicaCount: 1 },
      bookkeeper: { replicaCount: 1 },
      broker: { replicaCount: 2, configData: { managedLedgerDefaultEnsembleSize: "1", loadBalancerSheddingEnabled: "false", loadBalancerAutoBundleSplitEnabled: "false" } },
    });
    // the session timeout is the default of the broker and of the chart: the values do not set it
    expect(JSON.stringify(values)).not.toMatch(/SessionTimeout/);
    expect(() => pulsarValues("no-tag")).toThrow(/has no tag/);
  });
});

describe("the producers of a cell with a broker", () => {
  it("are a script in a ConfigMap and one pod on each worker, which the watcher follows", () => {
    const [config, deployment] = pulsarObjects(CELL, "lab-crash", "systems-lab/pulsar:5.0.0-0123456789ab") as [
      { data: Record<string, string> },
      { spec: { replicas: number; template: { metadata: { labels: Record<string, string> }; spec: { containers: Array<{ image: string; imagePullPolicy: string; env: Array<{ name: string; value?: string }> }> } } } },
    ];
    expect(config.data["producer.py"]).toBe(PRODUCER_SCRIPT);
    expect(deployment.spec.replicas).toBe(2);
    expect(deployment.spec.template.metadata.labels).toEqual({ app: PRODUCER, [LOG_LABEL]: "1" });
    const [container] = deployment.spec.template.spec.containers;
    expect(container!.imagePullPolicy).toBe("Never");
    const env = Object.fromEntries(container!.env.map((each) => [each.name, each.value]));
    expect(env).toMatchObject({ SERVICE: PULSAR_SERVICE, LOOKUP: PULSAR_LOOKUP, PROBE_MS: "250", EVERY_MS: "20", TIMEOUT_MS: "1000" });
    expect(() => pulsarObjects(cellOf("crash"), "lab", "image:tag")).toThrow(/has no broker/);
  });

  it("send with the defaults of the client and write each line on the monotonic clock", () => {
    expect(PRODUCER_SCRIPT).toMatch(/client\.create_producer\(os\.environ\["TOPIC"\]\)/);
    expect(PRODUCER_SCRIPT).toMatch(/time\.monotonic\(\) \* 1000/);
    expect(PRODUCER_SCRIPT).toMatch(/pulsar\.Client\(os\.environ\["SERVICE"\], logger=logger\)/);
  });

  it("stop the broker that owns the topic in a crash", () => {
    expect(planOf(CELL).inject).toEqual([{ do: "signal", target: "broker", signal: "SIGKILL" }]);
    expect(planOf(cellOf("crash")).inject).toEqual([{ do: "signal", target: "server", signal: "SIGKILL" }]);
  });
});

describe("the hold of the owner", () => {
  const state = (owners: ReadonlyArray<[string, string | null]>, failed = 0) => ({
    owners: new Map(owners.map(([pod, owner]) => [pod, { t: 9_500, owner }])),
    sends: new Map(owners.map(([pod]) => [pod, { ok: 9_900, failed }])),
    last: 10_000,
  });

  it("gives the owner when each producer sends and each lookup names it", () => {
    expect(ownerAtRest(state([["a", OWNER], ["b", OWNER]]), 2)).toEqual({ owner: OWNER });
    expect(ownerAtRest(state([["a", OWNER]]), 2)).toBe("1 producers send, not 2");
    expect(ownerAtRest(state([["a", OWNER], ["b", "pulsar-broker-0.pulsar-broker-headless.pulsar.svc.cluster.local"]]), 2)).toMatch(/the lookups name/);
    expect(ownerAtRest(state([["a", OWNER], ["b", null]]), 2)).toMatch(/b has no lookup with an owner/);
    expect(ownerAtRest(state([["a", OWNER], ["b", OWNER]], 9_000), 2)).toMatch(/failed in the last 2 s/);
  });

  it("finds the broker of a host by its pod or by its address", async () => {
    const brokers = await brokersOf(fake(() => pods([true, true])));
    expect(brokerOfHost(brokers, OWNER)?.pod).toBe("pulsar-broker-1");
    expect(brokerOfHost(brokers, "10.244.1.9")?.pod).toBe("pulsar-broker-0");
    expect(brokerOfHost(brokers, "another")).toBeUndefined();
  });

  it("waits for each broker, then gives the owner and its node", async () => {
    let calls = 0;
    const cluster = fake(() => pods(calls++ === 0 ? [true, false] : [true, true]));
    const held = await holdPulsar(cluster, () => state([["a", OWNER], ["b", OWNER]]), 2, 5_000);
    expect(held).toEqual({ broker: { pod: "pulsar-broker-1", node: "lab-worker2", ip: "10.244.2.9", ready: true }, host: OWNER });
    expect(cluster.calls[0]).toEqual(["-n", "pulsar", "get", "pods", "-l", "component=broker", "-o", "json"]);
    expect(await holdPulsar(fake(() => pods([true, false])), () => state([["a", OWNER], ["b", OWNER]]), 2, 600)).toBe("the broker pulsar-broker-1 is not ready");
  });
});
