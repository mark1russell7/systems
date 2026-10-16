import { createHash } from "node:crypto";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { KindCell, KubeletProbe } from "./cell.ts";

/**
 * This module generates the Kubernetes objects of a cell. They are its namespace, its Redis, the
 * service as a Deployment behind a Service, and one client on each node. Each setting of
 * the pod comes from the cell. The rollout strategy and the probe fields state the defaults of
 * Kubernetes as values.
 */

/** These are the ports of the app: its server, and its health server for the probes. */
export const PORT = 8080;
export const HEALTH_PORT = 9000;
/** This label makes the watcher follow the log of a pod. */
export const LOG_LABEL = "lab.systems/log";
/** These are the names of the objects of a cell. */
export const SERVER = "lab";
export const CLIENT = "client";
export const REDIS = "redis";

/** This image is Redis 7.4, the stock target of the harness, pinned by digest. */
export const REDIS_IMAGE = "redis:7.4@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f";

const whole = (amount: Quantity, what: string): number => {
  const seconds = valueIn(amount, "s");
  if (!Number.isInteger(seconds) || seconds < 0) throw new RangeError(`${what} is ${seconds} s, not a whole number of seconds`);
  return seconds;
};

/** This function gives the namespace of a cell: `lab-` and 10 digits of the sha256 of its name. */
export const namespaceOf = (cell: Pick<KindCell, "name">): string =>
  `lab-${createHash("sha256").update(cell.name).digest("hex").slice(0, 10)}`;

/** This function gives a probe of the pod: an HTTP GET of the health server, with each field of the cell. */
export const probeOf = (path: string, probe: KubeletProbe): Record<string, unknown> => ({
  httpGet: { path, port: HEALTH_PORT },
  initialDelaySeconds: 0,
  periodSeconds: whole(probe.period, `the period of ${path}`),
  timeoutSeconds: whole(probe.timeout, `the timeout of ${path}`),
  failureThreshold: probe.threshold,
  successThreshold: 1,
});

/** This function gives the environment of the app: its config as JSON, and the name of its pod. */
const appEnv = (cell: KindCell): Array<Record<string, unknown>> => [
  { name: "CONFIG", value: JSON.stringify({ name: SERVER, port: PORT, healthPort: HEALTH_PORT, declaration: cell.declaration }) },
  { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
];

/** These are the objects of Redis: one replica behind a Service, with no persistence. */
export const redisObjects = (namespace: string, image: string): unknown[] => [
  {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: REDIS, namespace, labels: { app: REDIS } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: REDIS } },
      template: {
        metadata: { labels: { app: REDIS } },
        spec: {
          terminationGracePeriodSeconds: 1,
          containers: [
            {
              name: REDIS,
              image,
              imagePullPolicy: "Never",
              command: ["redis-server", "--save", "", "--appendonly", "no"],
              ports: [{ containerPort: 6379 }],
              readinessProbe: { tcpSocket: { port: 6379 }, periodSeconds: 1, failureThreshold: 1, successThreshold: 1, timeoutSeconds: 1 },
            },
          ],
        },
      },
    },
  },
  {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: REDIS, namespace },
    spec: { selector: { app: REDIS }, ports: [{ port: 6379, targetPort: 6379 }] },
  },
];

/** These are the objects of the service: a Service of type ClusterIP, and the Deployment with the settings of the cell. */
export const serverObjects = (cell: KindCell, namespace: string, image: string, version = 1): unknown[] => {
  const preStop = whole(cell.pod.preStop, "the preStop sleep");
  return [
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: SERVER, namespace },
      spec: { selector: { app: SERVER }, ports: [{ name: "http", port: 80, targetPort: PORT }] },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: SERVER, namespace, labels: { app: SERVER } },
      spec: {
        replicas: cell.pod.replicas,
        selector: { matchLabels: { app: SERVER } },
        strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } },
        minReadySeconds: 0,
        template: {
          metadata: { labels: { app: SERVER, [LOG_LABEL]: "1", "lab.systems/version": String(version) } },
          spec: {
            terminationGracePeriodSeconds: whole(cell.pod.grace, "the grace period"),
            enableServiceLinks: true,
            topologySpreadConstraints: [
              {
                maxSkew: 1,
                topologyKey: "kubernetes.io/hostname",
                whenUnsatisfiable: "ScheduleAnyway",
                labelSelector: { matchLabels: { app: SERVER } },
              },
            ],
            containers: [
              {
                name: "app",
                image,
                imagePullPolicy: "Never",
                command: ["node", "app.mjs"],
                env: [...appEnv(cell), { name: "LAB_VERSION", value: String(version) }],
                ports: [{ containerPort: PORT }, { containerPort: HEALTH_PORT }],
                ...(cell.pod.startup === null ? {} : { startupProbe: probeOf("/startup", cell.pod.startup) }),
                readinessProbe: probeOf("/readiness", cell.pod.readiness),
                livenessProbe: probeOf("/liveness", cell.pod.liveness),
                ...(preStop === 0 ? {} : { lifecycle: { preStop: { sleep: { seconds: preStop } } } }),
              },
            ],
          },
        },
      },
    },
  ];
};

/** These are the objects of the clients: a DaemonSet with one client on each node, the control plane too. */
export const clientObjects = (cell: KindCell, namespace: string, image: string, target: string): unknown[] => [
  {
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: CLIENT, namespace, labels: { app: CLIENT } },
    spec: {
      selector: { matchLabels: { app: CLIENT } },
      template: {
        metadata: { labels: { app: CLIENT, [LOG_LABEL]: "1" } },
        spec: {
          terminationGracePeriodSeconds: 0,
          tolerations: [{ key: "node-role.kubernetes.io/control-plane", operator: "Exists", effect: "NoSchedule" }],
          containers: [
            {
              name: CLIENT,
              image,
              imagePullPolicy: "Never",
              command: ["node", "client.mjs"],
              env: [
                { name: "TARGET", value: target },
                { name: "EVERY_MS", value: String(valueIn(cell.workload.every, "ms")) },
                { name: "TIMEOUT_MS", value: String(valueIn(cell.workload.timeout, "ms")) },
                { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
                { name: "NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
              ],
            },
          ],
        },
      },
    },
  },
];
