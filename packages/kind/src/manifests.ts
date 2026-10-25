import { createHash } from "node:crypto";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { KindCell, KubeletProbe, MeshMode, Stack } from "./cell.ts";
import { CLIENT, HEALTH_PORT, LOG_LABEL, PORT, REDIS, SERVER } from "./names.ts";

/**
 * This module generates the Kubernetes objects of a cell. They are its namespace, its Redis, the
 * server as a Deployment behind a Service, and one client on each node. The server is the service
 * or grpc-go, by the stack of the cell. Each setting of the pod comes from the cell. The rollout
 * strategy and the probe fields state the defaults of Kubernetes as values.
 */

/** This function gives the stack of a cell: the service, when the cell names no stack. */
export const stackOf = (cell: Pick<KindCell, "stack">): Stack => cell.stack ?? "service";

export { CLIENT, HEALTH_PORT, LOG_LABEL, PORT, REDIS, SERVER } from "./names.ts";

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

/** These are the labels of the namespace of each mode of a mesh. */
const MESH_LABELS: Readonly<Record<MeshMode, Readonly<Record<string, string>>>> = {
  sidecar: { "istio-injection": "enabled" },
  ambient: { "istio.io/dataplane-mode": "ambient" },
};

/**
 * This function gives the Namespace object of a cell. In the sidecar mode of a mesh, the label
 * `istio-injection=enabled` makes the injector of Istio put a sidecar in each pod of the namespace.
 * In the ambient mode, the label `istio.io/dataplane-mode=ambient` makes istio-cni redirect the
 * traffic of each pod of the namespace to ztunnel, in the network namespace of the pod.
 */
export const namespaceObject = (cell: Pick<KindCell, "mesh">, namespace: string): Record<string, unknown> => ({
  apiVersion: "v1",
  kind: "Namespace",
  metadata: { name: namespace, ...(cell.mesh === undefined ? {} : { labels: { ...MESH_LABELS[cell.mesh.mode] } }) },
});

/**
 * This function gives a probe of the pod, with each field of the cell. The probe of the service is an
 * HTTP GET of its health server (`path`). The probe of grpc-go (`path` null) is the gRPC probe of the
 * kubelet. It is a Check of the service "" on the port of the server, and the answer is SERVING until
 * GracefulStop. A gRPC probe can name another service (`service`): the field `service` of `GRPCAction`
 * (`staging/src/k8s.io/api/core/v1/types.go` at v1.37.0, line 2892).
 */
export const probeOf = (path: string | null, probe: KubeletProbe, service?: string): Record<string, unknown> => ({
  ...(path === null ? { grpc: service === undefined ? { port: PORT } : { port: PORT, service } } : { httpGet: { path, port: HEALTH_PORT } }),
  initialDelaySeconds: 0,
  periodSeconds: whole(probe.period, `the period of ${path ?? "the gRPC probe"}`),
  timeoutSeconds: whole(probe.timeout, `the timeout of ${path ?? "the gRPC probe"}`),
  failureThreshold: probe.threshold,
  successThreshold: 1,
});

/** This variable is the name of the pod, from the API: the service and grpc-go put it in their lines. */
const POD_ENV = { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } };

/** This function gives the environment of the app: its config as JSON, and the name of its pod. */
const appEnv = (cell: KindCell): Array<Record<string, unknown>> => [
  { name: "CONFIG", value: JSON.stringify({ name: SERVER, port: PORT, healthPort: HEALTH_PORT, declaration: cell.declaration }) },
  POD_ENV,
];

/** This file is the flag of the trigger `liveness-restart`, in the root of the server process (`run.ts`, the step `flag`). */
const FLAG_FILE = "/tmp/lab-fail";

/**
 * This function gives the container of the server of a cell. The service runs `app.mjs` of the lab
 * image with its declaration. The server grpc-go runs from the image of the harness. Its lines name
 * the pod and stamp in milliseconds. Its replies name the pod in the header `x-pod`. Kubernetes
 * expands `$(POD_NAME)` in the command.
 *
 * The seam of `liveness-restart` in grpc-go is its service `liveness`, which the flag file fails
 * (`--fail-file`). Thus for that trigger the liveness probe is a Check of `liveness`. The readiness
 * probe stays a Check of "", which the flag file does not fail.
 */
const serverContainer = (cell: KindCell, version: number): Record<string, unknown> => {
  const env = { name: "LAB_VERSION", value: String(version) };
  if (stackOf(cell) === "service")
    return {
      command: ["node", "app.mjs"],
      env: [...appEnv(cell), env],
      ports: [{ containerPort: PORT }, { containerPort: HEALTH_PORT }],
      ...(cell.pod.startup === null ? {} : { startupProbe: probeOf("/startup", cell.pod.startup) }),
      readinessProbe: probeOf("/readiness", cell.pod.readiness),
      livenessProbe: probeOf("/liveness", cell.pod.liveness),
    };
  const seam = cell.trigger.kind === "liveness-restart";
  return {
    command: ["grpc-go-server", "--port", String(PORT), "--name", "$(POD_NAME)", "--clock", "ms", ...(seam ? ["--fail-file", FLAG_FILE] : [])],
    env: [POD_ENV, env],
    ports: [{ containerPort: PORT }],
    ...(cell.pod.startup === null ? {} : { startupProbe: probeOf(null, cell.pod.startup) }),
    readinessProbe: probeOf(null, cell.pod.readiness),
    livenessProbe: seam ? probeOf(null, cell.pod.liveness, "liveness") : probeOf(null, cell.pod.liveness),
  };
};

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

/**
 * This function gives the preStop hook of a sleep, or nothing for no sleep. The hook is the native
 * sleep action of the kubelet. The API server refuses a sleep action that is longer than the grace
 * (`validateSleepAction`, `pkg/apis/core/validation/validation.go` at v1.37.0, line 3483). Thus a
 * longer sleep is a command in the container, `sleep` from `/bin/sh`, as public manifests write it.
 * The kubelet starts that command with no timeout (`pkg/kubelet/lifecycle/handlers.go`, line 81).
 */
const preStopOf = (preStop: number, grace: number): Record<string, unknown> => {
  if (preStop === 0) return {};
  if (preStop <= grace) return { lifecycle: { preStop: { sleep: { seconds: preStop } } } };
  return { lifecycle: { preStop: { exec: { command: ["/bin/sh", "-c", `sleep ${preStop}`] } } } };
};

/**
 * These are the objects of the server: a Service of type ClusterIP, and the Deployment with the
 * settings of the cell. The image is the lab image for the service, or the image of grpc-go.
 */
export const serverObjects = (cell: KindCell, namespace: string, image: string, version = 1): unknown[] => {
  const preStop = whole(cell.pod.preStop, "the preStop sleep");
  const grace = whole(cell.pod.grace, "the grace period");
  return [
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: SERVER, namespace },
      spec: { selector: { app: SERVER }, ports: [{ name: stackOf(cell) === "grpc" ? "grpc" : "http", port: 80, targetPort: PORT }] },
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
            terminationGracePeriodSeconds: grace,
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
                ...serverContainer(cell, version),
                ...preStopOf(preStop, grace),
              },
            ],
          },
        },
      },
    },
  ];
};

/**
 * These are the objects of the clients: a DaemonSet with one client on each node, the control plane
 * too. The client of the service is `client.mjs`, and the client of grpc-go is `client-grpc.mjs`.
 * Each one is in the lab image, and each one writes the same lines.
 */
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
              command: ["node", stackOf(cell) === "grpc" ? "client-grpc.mjs" : "client.mjs"],
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
