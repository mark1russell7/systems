import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Quantity } from "@mark1russell7/quantity";
import type { KindCell, MeshFlavor } from "./cell.ts";
import type { Cluster } from "./cluster.ts";
import { command } from "./cluster.ts";
import { outboundCluster } from "./eds.ts";
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
 * These are the images of the flavor `sidecar`, pinned by the digest of their index on Docker Hub
 * (read on 2026-10-24). `gcr.io/istio-release` has no final tag of 1.31. The lab pulls each one by
 * its digest, tags it with that digest (`localPin`), and loads it into each node. Thus no node pulls
 * from a registry.
 */
export const ISTIO_IMAGES: { readonly pilot: string; readonly proxy: string } = {
  pilot: "istio/pilot:1.31.3@sha256:6ad1e816c4d4767ba3f30a6286a96d121851ddb23d33e20736758acb5f3f4ea9",
  proxy: "istio/proxyv2:1.31.3@sha256:eb74eacea98d3fb1e239ea84016085155478586a554158676b9b67d960151084",
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

/** These are the local tags of the images, after the pull by digest. */
export interface MeshImages {
  readonly pilot: string;
  readonly proxy: string;
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
 * The flavor `ambient` comes in a later step, thus it is refused.
 */
export const istioOperator = (flavor: MeshFlavor, images: MeshImages): Record<string, unknown> => {
  if (flavor !== "sidecar") throw new Error(`the lab installs the mesh flavor sidecar only, not ${flavor}`);
  return {
    apiVersion: "install.istio.io/v1alpha1",
    kind: "IstioOperator",
    metadata: { name: "lab", namespace: "istio-system" },
    spec: {
      profile: "minimal",
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
      },
    },
  };
};

/**
 * This function installs the mesh of a flavor in a cluster with `istioctl install` and the operator
 * of the flavor. Then it waits for istiod. The kubeconfig of the cluster goes to istioctl.
 */
export const installMesh = async (cluster: Cluster, flavor: MeshFlavor, images: MeshImages): Promise<void> => {
  const istioctl = await ensureTool(ISTIOCTL);
  const file = join(cluster.dir, `istio-${flavor}.json`);
  writeFileSync(file, `${JSON.stringify(istioOperator(flavor, images), null, 2)}\n`);
  await command(istioctl, ["install", "--kubeconfig", cluster.kubeconfig, "-y", "-f", file, "--readiness-timeout", "10m0s"], { timeout: 900_000 });
  await cluster.kubectl(["-n", "istio-system", "rollout", "status", "deployment/istiod", "--timeout=300s"]);
};

/** This function gives the key of the mesh of a cell for its cluster: its flavor, or `none`. */
export const meshKey = (cell: Pick<KindCell, "mesh">): MeshFlavor | "none" => cell.mesh?.flavor ?? "none";

/** This function gives the outbound cluster of the server of a cell in each client sidecar: the port 80 of its Service. */
export const serverCluster = (namespace: string): string => outboundCluster(SERVER, namespace, 80);

/** This time is the interval of the EDS poll of each client sidecar, the same as the poll of the rules. */
export const EDS_EVERY: Quantity = { value: 50, unit: "ms" };

/** This time is the interval of the LDS poll of each server sidecar, the same as the poll of EDS. */
export const LDS_EVERY: Quantity = { value: 50, unit: "ms" };

/** This function tells if the lab polls the LDS updates of the server sidecars of a cell: a policy in a sidecar mesh. */
export const pollsListeners = (cell: Pick<KindCell, "mesh" | "trigger">): boolean => cell.mesh?.mode === "sidecar" && cell.trigger.kind === "authorization-policy";
