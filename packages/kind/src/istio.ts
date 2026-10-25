import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Quantity } from "@mark1russell7/quantity";
import type { KindCell, MeshFlavor } from "./cell.ts";
import type { Cluster } from "./cluster.ts";
import { command } from "./cluster.ts";
import { outboundCluster } from "./eds.ts";
import { ZTUNNEL_PODS } from "./faults.ts";
import { SERVER } from "./names.ts";
import { ISTIOCTL, ensureTool } from "./tools.ts";

/**
 * This module installs Istio 1.31.3 in a kind cluster with istioctl, from images pinned by digest.
 * The release notes of 1.31.2 and 1.31.3 change no default that a cell of T15 reads. Each value
 * of the install that is not a default of Istio is in `istioOperator`, with its reason.
 */

/** This version is the release of Istio of the lab: the tag of istioctl and of each image. */
export const ISTIO_VERSION = "1.31.3";

/**
 * These are the images of Istio, pinned by the digest of their index on Docker Hub (read on
 * 2026-10-24). `gcr.io/istio-release` has no final tag of 1.31. The lab pulls each one by its digest,
 * tags it with that digest (`localPin`), and loads it into each node. Thus no node pulls from a
 * registry. The flavor `sidecar` needs istiod and the proxy. The flavor `ambient` also needs
 * istio-cni and ztunnel (`MESH_IMAGES`).
 */
export const ISTIO_IMAGES: { readonly pilot: string; readonly proxy: string; readonly cni: string; readonly ztunnel: string } = {
  pilot: "istio/pilot:1.31.3@sha256:6ad1e816c4d4767ba3f30a6286a96d121851ddb23d33e20736758acb5f3f4ea9",
  proxy: "istio/proxyv2:1.31.3@sha256:eb74eacea98d3fb1e239ea84016085155478586a554158676b9b67d960151084",
  cni: "istio/install-cni:1.31.3@sha256:e98782038634ef4fadaf78b53dd8fa4134fda3d65838ead5fc1edef245451c0f",
  ztunnel: "istio/ztunnel:1.31.3@sha256:2c27371b3139ecbf4f5a017354bd540889482441712e88cd8e654ead5a3eb5b2",
};

/** These are the images that each flavor installs, by their names in `ISTIO_IMAGES`. */
export const MESH_IMAGES: Readonly<Record<MeshFlavor, ReadonlyArray<keyof typeof ISTIO_IMAGES>>> = {
  sidecar: ["pilot", "proxy"],
  ambient: ["pilot", "proxy", "cni", "ztunnel"],
};

/**
 * This format is the JSON access log of each sidecar. Each field is a command of the formatter of
 * Envoy v1.39.4. The fields give the status, the response flags and their details, and the gRPC
 * status as a number. They also give the tries of the router, the upstream host and cluster, and
 * the reasons of a failed connection. The watcher reads `code`, `flags`, `grpc` and `attempts`
 * (`image/watch.mjs`).
 */
export const ACCESS_LOG_FORMAT: Readonly<Record<string, string>> = {
  start: "%START_TIME%",
  code: "%RESPONSE_CODE%",
  flags: "%RESPONSE_FLAGS%",
  details: "%RESPONSE_CODE_DETAILS%",
  grpc: "%GRPC_STATUS_NUMBER%",
  attempts: "%UPSTREAM_REQUEST_ATTEMPT_COUNT%",
  host: "%UPSTREAM_HOST%",
  cluster: "%UPSTREAM_CLUSTER%",
  local: "%DOWNSTREAM_LOCAL_ADDRESS%",
  remote: "%DOWNSTREAM_REMOTE_ADDRESS%",
  duration: "%DURATION%",
  failure: "%UPSTREAM_TRANSPORT_FAILURE_REASON%",
  termination: "%CONNECTION_TERMINATION_DETAILS%",
};

/** These are the local tags of the images, after the pull by digest. The flavor `ambient` needs `cni` and `ztunnel`. */
export interface MeshImages {
  readonly pilot: string;
  readonly proxy: string;
  readonly cni?: string | undefined;
  readonly ztunnel?: string | undefined;
}

/**
 * This function gives the IstioOperator of a flavor. The values that are not the defaults of Istio:
 * - The profile `minimal` is istiod only. The profile `default` also has an ingress gateway, which no cell uses.
 * - Each image is a full reference, thus the charts use it as it is (`contains "/"` in the
 *   templates of istiod and of the injector). The init container of the injector has the image of the proxy too (`proxy_init`).
 * - `imagePullPolicy: Never`: each image is on each node. An image that the lab did not load fails the install at once.
 * - istiod requests 256 MiB, not 2 GiB, and has one replica with no autoscaler. Each node of kind
 *   reports the whole runner, and no cell scales istiod.
 * - The access log of each sidecar goes to its output as JSON (`ACCESS_LOG_FORMAT`).
 *
 * The flavor `ambient` has the profile `ambient`: istiod, istio-cni and ztunnel, and no gateway
 * (manifests/profiles/ambient.yaml of Istio 1.31.3). Its two other images are full references too
 * (templates/daemonset.yaml of the chart of istio-cni, lines 93–96, and of ztunnel, lines 65–68).
 * The chart of istio-cni takes the pull policy of `global`. The template of ztunnel reads only its own
 * `imagePullPolicy`, thus the operator sets it there too.
 */
export const istioOperator = (flavor: MeshFlavor, images: MeshImages): Record<string, unknown> => {
  const ambient = flavor === "ambient";
  if (ambient && (images.cni === undefined || images.ztunnel === undefined)) throw new Error("the flavor ambient needs the images of istio-cni and ztunnel");
  return {
    apiVersion: "install.istio.io/v1alpha1",
    kind: "IstioOperator",
    metadata: { name: "lab", namespace: "istio-system" },
    spec: {
      profile: ambient ? "ambient" : "minimal",
      hub: "docker.io/istio",
      tag: ISTIO_VERSION,
      meshConfig: {
        accessLogFile: "/dev/stdout",
        accessLogEncoding: "JSON",
        accessLogFormat: JSON.stringify(ACCESS_LOG_FORMAT),
      },
      values: {
        global: { imagePullPolicy: "Never", proxy: { image: images.proxy }, proxy_init: { image: images.proxy } },
        pilot: { image: images.pilot, autoscaleEnabled: false, replicaCount: 1, resources: { requests: { cpu: "500m", memory: "256Mi" } } },
        ...(ambient ? { cni: { image: images.cni }, ztunnel: { image: images.ztunnel, imagePullPolicy: "Never" } } : {}),
      },
    },
  };
};

/** These are the workloads of each flavor in istio-system that the install waits for. */
export const MESH_WORKLOADS: Readonly<Record<MeshFlavor, readonly string[]>> = {
  sidecar: ["deployment/istiod"],
  ambient: ["deployment/istiod", "daemonset/istio-cni-node", "daemonset/ztunnel"],
};

/**
 * This function installs the mesh of a flavor in a cluster with `istioctl install` and the operator
 * of the flavor. Then it waits for each workload of the flavor. The kubeconfig of the cluster goes to
 * istioctl. When the install fails, the error has the pods of istio-system and the last lines of the
 * log of istio-cni. Thus the log of the job shows the cause, for example a module that the kernel of
 * the runner does not have.
 */
export const installMesh = async (cluster: Cluster, flavor: MeshFlavor, images: MeshImages): Promise<void> => {
  const istioctl = await ensureTool(ISTIOCTL);
  const file = join(cluster.dir, `istio-${flavor}.json`);
  writeFileSync(file, `${JSON.stringify(istioOperator(flavor, images), null, 2)}\n`);
  try {
    await command(istioctl, ["install", "--kubeconfig", cluster.kubeconfig, "-y", "-f", file, "--readiness-timeout", "10m0s"], { timeout: 900_000 });
    for (const workload of MESH_WORKLOADS[flavor]) await cluster.kubectl(["-n", "istio-system", "rollout", "status", workload, "--timeout=300s"]);
  } catch (error) {
    const state = async (args: readonly string[]): Promise<string> =>
      (await cluster.kubectl(["-n", "istio-system", ...args]).catch((why: unknown) => String(why))).slice(-4000);
    const pods = await state(["get", "pods", "-o", "wide"]);
    const cni = flavor === "ambient" ? `\nthe log of istio-cni:\n${await state(["logs", "daemonset/istio-cni-node", "--tail=60", "--all-containers"])}` : "";
    throw new Error(`the install of Istio ${flavor} failed: ${String(error)}\nthe pods of istio-system:\n${pods}${cni}`);
  }
};

/** This function gives the key of the mesh of a cell for its cluster: its flavor, or `none`. */
export const meshKey = (cell: Pick<KindCell, "mesh">): MeshFlavor | "none" => cell.mesh?.flavor ?? "none";

/** This function gives the outbound cluster of the server of a cell in each client sidecar: the port 80 of its Service. */
export const serverCluster = (namespace: string): string => outboundCluster(SERVER, namespace, 80);

/** This time is the interval of the EDS poll of each client sidecar, the same as the poll of the rules. */
export const EDS_EVERY: Quantity = { value: 50, unit: "ms" };

/** This time is the interval of the LDS poll of each server sidecar, the same as the poll of EDS. */
export const LDS_EVERY: Quantity = { value: 50, unit: "ms" };

/**
 * This function tells if the watcher follows each ztunnel pod and its log for a cell: a cell in the
 * flavor `ambient`. A cell of sidecar pods in that flavor needs the lines of the ztunnel pods too.
 * They show the restart of ztunnel, which its pods do not see.
 */
export const followsZtunnel = (cell: Pick<KindCell, "mesh">): boolean => cell.mesh?.flavor === "ambient";

/**
 * This function gives the arguments of kubectl that set the environment of ztunnel for a cell, or
 * remove it (`undo`). The variables go in the sequence of their names.
 */
export const ztunnelEnvArgs = (env: Readonly<Record<string, string>>, undo: boolean): string[] => [
  "-n",
  "istio-system",
  "set",
  "env",
  "daemonset/ztunnel",
  ...Object.keys(env)
    .sort()
    .map((key) => (undo ? `${key}-` : `${key}=${env[key]!}`)),
];

/**
 * This function sets the environment of ztunnel for a cell, or removes it (`undo`). Then it waits for
 * the rollout of the DaemonSet, and until no old ztunnel pod is left. An old pod drains for its
 * deadline after the rollout replaces it. Thus no run starts beside a ztunnel pod that is going.
 */
export const setZtunnelEnv = async (cluster: Cluster, env: Readonly<Record<string, string>>, undo: boolean): Promise<void> => {
  await cluster.kubectl(ztunnelEnvArgs(env, undo));
  await cluster.kubectl(["-n", "istio-system", "rollout", "status", "daemonset/ztunnel", "--timeout=300s"]);
  const until = Date.now() + 120_000;
  for (;;) {
    const listed = JSON.parse(await cluster.kubectl(["-n", "istio-system", "get", "pods", "-l", ZTUNNEL_PODS, "-o", "json"])) as {
      items: Array<{ metadata: { deletionTimestamp?: string } }>;
    };
    if (listed.items.every((item) => item.metadata.deletionTimestamp === undefined)) return;
    if (Date.now() > until) throw new Error("an old ztunnel pod is still going 120 s after the rollout");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
};

/** This function tells if the lab polls the LDS updates of the server sidecars of a cell: a policy in a sidecar mesh. */
export const pollsListeners = (cell: Pick<KindCell, "mesh" | "trigger">): boolean => cell.mesh?.mode === "sidecar" && cell.trigger.kind === "authorization-policy";

/** This is the validity of one leaf certificate of ztunnel, as istioctl gives it: RFC 3339 times. */
export interface LeafCertificate {
  readonly pod: string;
  readonly identity: string;
  readonly state: string;
  readonly from: string | null;
  readonly to: string | null;
}

/** This function gives the arguments of istioctl that read the certificates of one ztunnel pod as JSON. */
export const certificateArgs = (pod: string, kubeconfig: string): string[] => [
  "ztunnel-config",
  "certificate",
  `${pod}.istio-system`,
  "--kubeconfig",
  kubeconfig,
  "-o",
  "json",
];

/**
 * This function gives the leaf of each identity in the JSON of `istioctl ztunnel-config certificate`.
 * The leaf is the first certificate of the chain (certificates.go of istioctl 1.31.3, lines 68–71).
 * An identity with no chain yet has no times.
 */
export const leafCertificates = (pod: string, json: string): LeafCertificate[] => {
  const dump = JSON.parse(json) as Array<{
    identity?: string;
    state?: string;
    certChain?: Array<{ validFrom?: string; expirationTime?: string }> | null;
  }>;
  return dump.map((each) => {
    const leaf = each.certChain?.[0];
    return { pod, identity: each.identity ?? "", state: each.state ?? "", from: leaf?.validFrom || null, to: leaf?.expirationTime || null };
  });
};

/**
 * This function reads the leaf certificates of each ztunnel pod that is not going, with istioctl.
 * The CLI reads the admin port of ztunnel through a port-forward. Each ztunnel binds that port to
 * localhost only (config.rs of ztunnel 1.31.3, lines 831–835).
 */
export const ztunnelCertificates = async (cluster: Cluster): Promise<LeafCertificate[]> => {
  const istioctl = await ensureTool(ISTIOCTL);
  const listed = JSON.parse(await cluster.kubectl(["-n", "istio-system", "get", "pods", "-l", ZTUNNEL_PODS, "-o", "json"])) as {
    items: Array<{ metadata: { name: string; deletionTimestamp?: string } }>;
  };
  const out: LeafCertificate[] = [];
  for (const item of listed.items.filter((each) => each.metadata.deletionTimestamp === undefined)) {
    const json = await command(istioctl, certificateArgs(item.metadata.name, cluster.kubeconfig), { timeout: 60_000 });
    out.push(...leafCertificates(item.metadata.name, json));
  }
  return out;
};
