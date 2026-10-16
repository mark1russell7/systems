import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { KindScenario } from "./scenario.ts";
import { NODE_IMAGES, cidrOverlap, kindConfig, nodeNames } from "./scenario.ts";
import { KIND, KUBECTL, ensureTool } from "./tools.ts";

const run = promisify(execFile);

/** This function starts a program and gives its standard output. A failure gives its standard error in the message. */
export const command = async (
  program: string,
  args: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>>; readonly input?: string; readonly timeout?: number } = {},
): Promise<string> => {
  try {
    const child = run(program, [...args], {
      env: { ...process.env, ...options.env },
      maxBuffer: 256 << 20,
      timeout: options.timeout ?? 600_000,
      windowsHide: true,
    });
    if (options.input !== undefined) {
      child.child.stdin?.end(options.input);
    }
    const { stdout } = await child;
    return stdout.toString();
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`${program} ${args.join(" ")} failed: ${(failed.stderr ?? failed.message ?? "").toString().trim().slice(0, 2000)}`);
  }
};

/** A cluster manifest is what a run records about its cluster: the versions, the images, the nodes and the mode as read back. */
export interface ClusterManifest {
  readonly kind: string;
  readonly nodeImage: string;
  readonly server: string;
  readonly mode: string;
  readonly docker: string;
  readonly nodes: ReadonlyArray<{
    readonly name: string;
    readonly kubelet: string;
    readonly kernel: string;
    readonly runtime: string;
    readonly os: string;
  }>;
}

/** The credentials of the API, as a container on the network of the cluster reaches it. */
export interface Credentials {
  readonly server: string;
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
}

/** A cluster is one kind cluster that the lab made, with its own kubeconfig and Docker network. */
export interface Cluster {
  readonly scenario: KindScenario;
  readonly dir: string;
  readonly kubeconfig: string;
  readonly network: string;
  readonly nodes: readonly string[];
  kubectl(args: readonly string[], input?: string): Promise<string>;
  /** This method applies Kubernetes objects, as JSON on standard input. */
  apply(objects: readonly unknown[]): Promise<void>;
  /** This method starts a command in a node container. */
  exec(node: string, argv: readonly string[]): Promise<string>;
  /** This method copies a local Docker image into each node. */
  load(image: string): Promise<void>;
  credentials(): Promise<Credentials>;
  manifest(): Promise<ClusterManifest>;
  delete(): Promise<void>;
}

/** This function gives the subnets of the Docker networks, by their names. */
const dockerSubnets = async (): Promise<Array<[string, string]>> => {
  const ids = (await command("docker", ["network", "ls", "-q"])).split(/\s+/).filter((id) => id !== "");
  if (ids.length === 0) return [];
  const info = JSON.parse(await command("docker", ["network", "inspect", ...ids])) as Array<{
    Name: string;
    IPAM?: { Config?: Array<{ Subnet?: string }> | null };
  }>;
  return info.flatMap((network) =>
    (network.IPAM?.Config ?? [])
      .map((config) => config.Subnet ?? "")
      .filter((subnet) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(subnet))
      .map((subnet): [string, string] => [network.Name, subnet]),
  );
};

/**
 * This function makes a kind cluster from a scenario, in a folder that holds its config, its
 * kubeconfig and the cache of kubectl. The cluster gets a Docker network of its own. The function
 * refuses a pod or service subnet that overlaps a Docker network, because that breaks the traffic
 * between the nodes.
 */
export const createCluster = async (scenario: KindScenario, dir: string): Promise<Cluster> => {
  const kind = await ensureTool(KIND);
  const kubectlPath = await ensureTool(KUBECTL);
  mkdirSync(dir, { recursive: true });
  const kubeconfig = join(dir, "kubeconfig");
  const network = `systems-${scenario.name}`;
  const config = kindConfig(scenario);
  for (const [name, subnet] of await dockerSubnets()) {
    if (name === network) continue;
    for (const ours of [scenario.podSubnet, scenario.serviceSubnet])
      if (cidrOverlap(ours, subnet)) throw new Error(`the subnet ${ours} overlaps the Docker network ${name} (${subnet})`);
  }
  const file = join(dir, "kind.json");
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const env = { KIND_EXPERIMENTAL_DOCKER_NETWORK: network };
  const nodes = nodeNames(scenario);
  const kubectl = (args: readonly string[], input?: string) =>
    command(kubectlPath, ["--kubeconfig", kubeconfig, "--cache-dir", join(dir, "kubectl-cache"), ...args], input === undefined ? {} : { input });
  const cluster: Cluster = {
    scenario,
    dir,
    kubeconfig,
    network,
    nodes,
    kubectl,
    async apply(objects) {
      await kubectl(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }));
    },
    exec: (node, argv) => command("docker", ["exec", node, ...argv]),
    async load(image) {
      await command(kind, ["load", "docker-image", "--name", scenario.name, image], { env, timeout: 900_000 });
    },
    async credentials() {
      const internal = join(dir, "kubeconfig.internal");
      writeFileSync(internal, await command(kind, ["get", "kubeconfig", "--internal", "--name", scenario.name], { env }));
      const view = JSON.parse(
        await command(kubectlPath, ["--kubeconfig", internal, "config", "view", "--raw", "-o", "json"]),
      ) as {
        clusters: Array<{ cluster: { server: string; "certificate-authority-data": string } }>;
        users: Array<{ user: { "client-certificate-data": string; "client-key-data": string } }>;
      };
      return {
        server: view.clusters[0]!.cluster.server,
        ca: view.clusters[0]!.cluster["certificate-authority-data"],
        cert: view.users[0]!.user["client-certificate-data"],
        key: view.users[0]!.user["client-key-data"],
      };
    },
    async manifest() {
      const nodesJson = JSON.parse(await kubectl(["get", "nodes", "-o", "json"])) as {
        items: Array<{ metadata: { name: string }; status: { nodeInfo: Record<string, string> } }>;
      };
      const proxy = JSON.parse(await kubectl(["-n", "kube-system", "get", "configmap", "kube-proxy", "-o", "json"])) as {
        data: Record<string, string>;
      };
      const mode = /^mode:\s*(\S*)/m.exec(proxy.data["config.conf"] ?? "")?.[1] ?? "";
      const version = JSON.parse(await kubectl(["version", "-o", "json"])) as { serverVersion?: { gitVersion?: string } };
      return {
        kind: (await command(kind, ["version"])).trim(),
        nodeImage: NODE_IMAGES[scenario.kubernetes]!.image,
        server: version.serverVersion?.gitVersion ?? "",
        mode: mode.replaceAll('"', ""),
        docker: (await command("docker", ["version", "--format", "{{.Server.Version}}"])).trim(),
        nodes: nodesJson.items.map((item) => ({
          name: item.metadata.name,
          kubelet: item.status.nodeInfo["kubeletVersion"] ?? "",
          kernel: item.status.nodeInfo["kernelVersion"] ?? "",
          runtime: item.status.nodeInfo["containerRuntimeVersion"] ?? "",
          os: item.status.nodeInfo["osImage"] ?? "",
        })),
      };
    },
    async delete() {
      await command(kind, ["delete", "cluster", "--name", scenario.name, "--kubeconfig", kubeconfig], { env });
      await command("docker", ["network", "rm", network]).catch(() => undefined);
    },
  };
  await command(
    kind,
    ["create", "cluster", "--name", scenario.name, "--config", file, "--kubeconfig", kubeconfig, "--wait", "180s"],
    { env, timeout: 900_000 },
  );
  return cluster;
};
