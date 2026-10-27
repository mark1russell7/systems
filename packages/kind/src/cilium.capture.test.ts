import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ciliumBackendsOf } from "./backends.ts";
import { CILIUM_IMAGES, installCilium } from "./cilium.ts";
import type { Cluster } from "./cluster.ts";
import { createCluster } from "./cluster.ts";
import { localPin } from "./lab.ts";
import { REDIS_IMAGE } from "./manifests.ts";
import { scenario } from "./scenario.ts";

/**
 * The capture of Cilium. It starts only with `KIND_CAPTURE=<folder>`, because it makes a kind
 * cluster in Docker. CI starts it (the job `capture` of `.github/workflows/kind.yml`), and the job
 * uploads the folder as an artifact. The unit tests of `ciliumBackendsOf` read a part of that dump
 * (`test/cilium/`).
 *
 * The cluster has the dataplane `cilium` and 2 workers. A Service has 2 replicas of Redis. Each
 * replica has a preStop sleep of 40 s, thus a deleted replica stays `terminating` and serving. The
 * capture asks the agent of each node at each of three states:
 * - `ready`: the 2 replicas are ready.
 * - `one-terminating`: one replica has its deletion, and the other is ready.
 * - `all-terminating`: both old replicas have their deletion, and no new replica is ready yet.
 */
const OUT = process.env["KIND_CAPTURE"];
const NS = "cap";
const SVC = "server";

/** These are the objects of the capture: its namespace, a Deployment of Redis with 2 replicas, and its Service on the port 80. */
const objects = (image: string): unknown[] => [
  { apiVersion: "v1", kind: "Namespace", metadata: { name: NS } },
  {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: SVC, namespace: NS },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: SVC } },
      template: {
        metadata: { labels: { app: SVC } },
        spec: {
          terminationGracePeriodSeconds: 60,
          containers: [
            {
              name: "redis",
              image,
              imagePullPolicy: "Never",
              ports: [{ containerPort: 6379 }],
              // a new replica is ready only after 20 s, thus the state all-terminating has no ready replica
              readinessProbe: { tcpSocket: { port: 6379 }, initialDelaySeconds: 20, periodSeconds: 2 },
              lifecycle: { preStop: { exec: { command: ["sleep", "40"] } } },
            },
          ],
        },
      },
    },
  },
  {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: SVC, namespace: NS },
    spec: { selector: { app: SVC }, ports: [{ port: 80, targetPort: 6379, protocol: "TCP" }] },
  },
];

/** This function writes a file of the capture, and gives its text. */
const keep = (dir: string, name: string, text: string): string => {
  writeFileSync(join(dir, name), text);
  return text;
};

/** This function asks the agent of each node for its services, as the lab agent asks it, and writes each reply. */
const services = async (cluster: Cluster, dir: string, state: string): Promise<Map<string, string>> => {
  const replies = new Map<string, string>();
  for (const node of cluster.nodes) {
    const text = await cluster.exec(node, ["curl", "-sS", "--fail", "--max-time", "2", "--unix-socket", "/var/run/cilium/cilium.sock", "http://localhost/v1/service"]);
    replies.set(node, keep(dir, `services-${state}-${node.slice(cluster.scenario.name.length + 1)}.json`, text));
  }
  return replies;
};

const pods = async (cluster: Cluster): Promise<string[]> =>
  (await cluster.kubectl(["-n", NS, "get", "pods", "-l", `app=${SVC}`, "-o", "jsonpath={.items[*].metadata.name}"])).split(/\s+/).filter((name) => name !== "");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(OUT === undefined)("the capture of the agent of Cilium, in kind", () => {
  it("dumps the services of each agent in three states of the backends", async () => {
    const dir = OUT!;
    mkdirSync(dir, { recursive: true });
    const s = scenario("cap", "cilium", 2);
    const cluster = await createCluster(s, join(process.env["KIND_WORK"] ?? tmpdir(), s.name));
    try {
      const images = { agent: await localPin(CILIUM_IMAGES.agent), operator: await localPin(CILIUM_IMAGES.operator), envoy: await localPin(CILIUM_IMAGES.envoy) };
      const redis = await localPin(REDIS_IMAGE);
      for (const image of [images.agent, images.operator, images.envoy, redis]) await cluster.load(image);
      const began = Date.now();
      await installCilium(cluster, images);
      keep(dir, "install.txt", `Cilium installed in ${Math.round((Date.now() - began) / 100) / 10} s\n`);
      keep(dir, "cilium-config.json", await cluster.kubectl(["-n", "kube-system", "get", "configmap", "cilium-config", "-o", "json"]));
      const agent = ["-n", "kube-system", "exec", "ds/cilium", "-c", "cilium-agent", "--"];
      keep(dir, "status.txt", await cluster.kubectl([...agent, "cilium-dbg", "status", "--verbose"]));
      keep(dir, "version.txt", await cluster.kubectl([...agent, "cilium-dbg", "version"]));

      await cluster.apply(objects(redis));
      await cluster.kubectl(["-n", NS, "rollout", "status", `deployment/${SVC}`, "--timeout=300s"]);
      const ip = (await cluster.kubectl(["-n", NS, "get", "service", SVC, "-o", "jsonpath={.spec.clusterIP}"])).trim();
      const rule = { ip, port: 80 };
      const endpoints = async (state: string): Promise<void> => {
        keep(dir, `endpointslices-${state}.json`, await cluster.kubectl(["-n", NS, "get", "endpointslices", "-o", "json"]));
        keep(dir, `service-list-${state}.json`, await cluster.kubectl([...agent, "cilium-dbg", "service", "list", "-o", "json"]));
        keep(dir, `bpf-lb-list-${state}.json`, await cluster.kubectl([...agent, "cilium-dbg", "bpf", "lb", "list", "-o", "json"]));
      };
      keep(dir, "rule.json", `${JSON.stringify({ ns: NS, svc: SVC, ...rule })}\n`);
      // the agent writes the services of a change after its reflector buffer, up to 500 ms
      await sleep(3000);
      const ready = await services(cluster, dir, "ready");
      await endpoints("ready");
      const old = await pods(cluster);
      expect(old).toHaveLength(2);

      await cluster.kubectl(["-n", NS, "delete", "pod", old[0]!, "--wait=false"]);
      await sleep(3000);
      const one = await services(cluster, dir, "one-terminating");
      await endpoints("one-terminating");

      await cluster.kubectl(["-n", NS, "delete", "pod", old[1]!, "--wait=false"]);
      await sleep(3000);
      const all = await services(cluster, dir, "all-terminating");
      await endpoints("all-terminating");

      // the checks come after each file, thus a failure still leaves the whole dump
      for (const text of ready.values()) expect(ciliumBackendsOf(text, rule)).toHaveLength(2);
      for (const text of one.values()) expect(ciliumBackendsOf(text, rule)).toHaveLength(1);
      for (const text of all.values()) expect(ciliumBackendsOf(text, rule)).toHaveLength(2);
    } finally {
      await cluster.delete().catch(() => undefined);
    }
  });
});
