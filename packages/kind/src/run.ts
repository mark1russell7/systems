import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedTestContainer } from "testcontainers";
import { imageOf } from "@mark1russell7/harness";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Cycle, KindCell, KindRun, Replica } from "./cell.ts";
import type { Cluster } from "./cluster.ts";
import { command, createCluster } from "./cluster.ts";
import type { Step, Target } from "./faults.ts";
import { NODE, POD, VERSION, deletes as deletesAPod, faultSpan, middleboxCommands, planOf, sysctlCommand } from "./faults.ts";
import { labImage } from "./image.ts";
import type { MeshImages } from "./istio.ts";
import { EDS_EVERY, ISTIO_IMAGES, LDS_EVERY, MESH_IMAGES, followsZtunnel, installMesh, meshKey, pollsListeners, serverCluster, setZtunnelEnv, ztunnelCertificates } from "./istio.ts";
import type { KindLab, Line, Stamp } from "./lab.ts";
import { localPin, openKindLab } from "./lab.ts";
import { CLIENT, REDIS, REDIS_IMAGE, SERVER, clientObjects, namespaceObject, namespaceOf, redisObjects, serverObjects, stackOf } from "./manifests.ts";
import type { PodLine, Request } from "./observe.ts";
import { byClients, ztunnelReplaced } from "./observe.ts";
import type { EnvironmentManifest, KindCellRecord, KindCellResult, LoadSample } from "./record.ts";
import { FORMAT } from "./record.ts";
import { scenario } from "./scenario.ts";
import { judgeKind, observationAfter, observationEnd } from "./verdict.ts";

/** This time is the interval of the poll of the rules on each node. */
export const RULES_EVERY: Quantity = { value: 50, unit: "ms" };

/** These options run a catalog of kind cells. */
export interface RunOptions {
  /** This folder gets the raw record of each cell and `summary.ndjson`. */
  readonly out: string;
  readonly log: (line: string) => void;
  /** This count is the number of environments, each a new cluster. */
  readonly environments?: number;
  /** This share of the CPUs of the VM must be idle before a run starts. */
  readonly idle?: number;
  /**
   * This folder holds the run folder of each cluster: its config, its kubeconfig and the cache of
   * kubectl. It is not the output, because a kubeconfig holds credentials.
   */
  readonly work?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** This function tells if a cell has Redis: only a declaration of the service can have it. */
const hasRedis = (cell: KindCell): boolean => cell.declaration !== null && cell.declaration.redis !== null;

/** These are the images of a cluster: the lab, Redis, grpc-go for the stack `grpc`, and Istio for a mesh. */
interface Images {
  readonly lab: string;
  readonly redis: string;
  readonly grpc?: string | undefined;
  readonly mesh?: MeshImages | undefined;
}

/** This function gives the key of the cluster of a cell: its kube-proxy mode, its node count, and the flavor of its mesh. */
const clusterKey = (cell: KindCell): string => (cell.mesh === undefined ? `${cell.mode}-${cell.workers}` : `${cell.mode}-${cell.workers}-${cell.mesh.flavor}`);

/**
 * This tracker keeps the latest state of the cell from the lines: each pod, each slice and each
 * client. It also has, for each node, the backends of its rules and the hosts of its client sidecar.
 */
class Tracker {
  readonly pods = new Map<string, PodLine>();
  readonly slices = new Map<string, Line>();
  readonly backends = new Map<string, readonly string[]>();
  readonly hosts = new Map<string, readonly string[]>();
  readonly clients = new Map<string, { node: string; ok: number; failed: number }>();
  /** This map is the backend of the last answer of each client, by client. */
  readonly answers = new Map<string, string>();
  last = 0;
  see = (line: Line): void => {
    if (typeof line.t === "number" && line.t > this.last && line.ev === "req") this.last = line.t;
    if (line.ev === "pod") {
      const pod = line as unknown as PodLine;
      if (pod.type === "DELETED") this.pods.delete(pod.name);
      else this.pods.set(pod.name, pod);
    } else if (line.ev === "slice") {
      if (line["type"] === "DELETED") this.slices.delete(String(line["name"]));
      else this.slices.set(String(line["name"]), line);
    } else if (line.ev === "rules") {
      this.backends.set(String(line["node"]), line["b"] as readonly string[]);
    } else if (line.ev === "eds") {
      this.hosts.set(String(line["node"]), line["b"] as readonly string[]);
    } else if (line.ev === "req") {
      const request = line as unknown as Request;
      const client = this.clients.get(request.p) ?? { node: request.n, ok: 0, failed: 0 };
      if (request.o === "ok") client.ok = Math.max(client.ok, request.t);
      else client.failed = Math.max(client.failed, request.t);
      this.clients.set(request.p, client);
      if (request.o === "ok" && request.b !== undefined) this.answers.set(request.p, request.b);
    }
  };
  servers(): PodLine[] {
    return [...this.pods.values()].filter((pod) => pod.labels["app"] === SERVER).sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** A context is the state of one cell in one environment. */
interface Context {
  readonly lab: KindLab;
  readonly cluster: Cluster;
  readonly cell: KindCell;
  readonly namespace: string;
  readonly tracker: Tracker;
  readonly clusterIp: string;
  readonly loads: LoadSample[];
  readonly loader: StartedTestContainer;
  readonly idle: number;
  readonly log: (line: string) => void;
  version: number;
  probed: string;
  /** This key is the server pods whose sidecars the LDS pollers read, or "" for none. */
  listened: string;
  /** This count is the replicas of the service at rest: one less while a scale-in holds. */
  expected: number;
  /** This map gives the PID of the app of each pod. A replica gets it from the last fault of the target `servers`, and a client from the last gap. */
  readonly pids: Map<string, number>;
}

/** This function tells why the cell is not at rest, or gives null when it is. */
const unsteady = (ctx: Context): string | null => {
  const { tracker, cell } = ctx;
  const servers = tracker.servers();
  if (servers.length !== ctx.expected) return `${servers.length} replicas, not ${ctx.expected}`;
  const busy = servers.find((pod) => pod.del || !pod.ready);
  if (busy !== undefined) return `${busy.name} is not ready`;
  if (new Set(servers.map((pod) => pod.labels["pod-template-hash"])).size > 1) return "two versions of the replicas";
  if (hasRedis(cell)) {
    const redis = [...tracker.pods.values()].filter((pod) => pod.labels["app"] === REDIS);
    if (redis.length !== 1 || !redis[0]!.ready || redis[0]!.del) return "Redis is not ready";
  }
  const ips = servers.map((pod) => pod.ip ?? "").sort();
  const ready = [...tracker.slices.values()]
    .filter((slice) => slice["svc"] === SERVER)
    .flatMap((slice) => (slice["eps"] as Array<{ ip: string; r: boolean }>).filter((endpoint) => endpoint.r).map((endpoint) => endpoint.ip))
    .sort();
  if (ready.join() !== ips.join()) return `the EndpointSlice has ${ready.join(" ")}, not ${ips.join(" ")}`;
  const expected = ips.map((ip) => `${ip}:8080`).sort().join();
  for (const node of ctx.cluster.nodes)
    if ((tracker.backends.get(node) ?? []).join() !== expected) return `the rules of ${node} have ${(tracker.backends.get(node) ?? []).join(" ")}`;
  // in a sidecar mesh, the client sidecar of each node picks the backend of each call from its endpoints
  if (cell.mesh?.mode === "sidecar")
    for (const node of ctx.cluster.nodes)
      if ((tracker.hosts.get(node) ?? []).join() !== expected) return `the client sidecar of ${node} has ${(tracker.hosts.get(node) ?? []).join(" ") || "no host"}`;
  const nodes = new Set([...tracker.clients.values()].map((client) => client.node));
  if (nodes.size !== ctx.cluster.nodes.length) return `clients answer on ${nodes.size} nodes`;
  for (const [pod, client] of tracker.clients) {
    if (tracker.last - client.ok > 1000) return `client ${pod} has no answer in the last second`;
    if (tracker.last - client.failed < 2000) return `client ${pod} failed in the last 2 s`;
  }
  return null;
};

/** This function waits until the cell is at rest, and gives null, or the reason when it is not at rest in time. */
const steady = async (ctx: Context, within: number): Promise<string | null> => {
  const end = Date.now() + within;
  let why = unsteady(ctx);
  while (why !== null && Date.now() < end) {
    await sleep(200);
    why = unsteady(ctx);
  }
  return why;
};

/** This function samples the load of the VM for 4 s, and names the lab containers that are not of this run. */
const sample = async (ctx: Context, ours: ReadonlySet<string>): Promise<LoadSample> => {
  const result = await ctx.loader.exec(["top", "-b", "-n", "2", "-d", "4"]);
  const second = result.stdout.split(/^Mem:/m).at(-1) ?? "";
  const idle = Number(/(\d+)% idle/.exec(second)?.[1] ?? "0") / 100;
  const top = second
    .split("\n")
    .filter((line) => /^\s*\d+\s/.test(line))
    .slice(0, 6)
    .map((line) => line.trim().replace(/\s+/g, " "));
  const listed = (await command("docker", ["ps", "--format", "{{.ID}} {{.Names}} {{.Image}}"])).trim().split("\n");
  const foreign = listed
    .filter((line) => line !== "")
    .filter((line) => !ours.has(line.split(" ")[1]!) && !ours.has(line.split(" ")[0]!))
    .filter((line) => /loom-|kindest\/node|toxiproxy|haproxy|redis|systems-kind-lab|f6-/.test(line.split(" ")[2] ?? ""));
  return { t: Date.now(), idle, top, foreign };
};

/** This function waits until the VM is quiet: no lab container of another agent, and an idle share of the CPUs. */
const quiet = async (ctx: Context, ours: ReadonlySet<string>): Promise<LoadSample> => {
  for (;;) {
    // the prober and the watcher start again with new names, thus the names of this lab come at each sample
    const load = await sample(ctx, new Set([...ours, ...ctx.lab.own(), ctx.loader.getName().replace(/^\//, "")]));
    ctx.loads.push(load);
    if (load.foreign.length === 0 && load.idle >= ctx.idle) return load;
    ctx.log(`  waiting: ${Math.round(load.idle * 100)}% idle, other lab containers: ${load.foreign.join("; ") || "none"}`);
    await sleep(30_000);
  }
};

/**
 * This function deploys a cell in its namespace, with the watcher, the poll of the rules and the
 * clients. A client of gRPC starts after the server is ready: each failed connect of a channel makes
 * the backoff of grpc-js longer, up to 120 s.
 */
const deploy = async (lab: KindLab, cluster: Cluster, cell: KindCell, namespace: string, images: Images): Promise<string> => {
  await cluster.apply([namespaceObject(cell, namespace)]);
  await lab.watch([namespace], { ztunnel: followsZtunnel(cell) });
  if (hasRedis(cell)) {
    await cluster.apply(redisObjects(namespace, images.redis));
    await cluster.kubectl(["-n", namespace, "rollout", "status", `deployment/${REDIS}`, "--timeout=180s"]);
  }
  const grpc = stackOf(cell) === "grpc";
  if (grpc && images.grpc === undefined) throw new Error(`${cell.name}: the cluster has no image of grpc-go`);
  await cluster.apply(serverObjects(cell, namespace, grpc ? images.grpc! : lab.image));
  const clusterIp = (await cluster.kubectl(["-n", namespace, "get", "service", SERVER, "-o", "jsonpath={.spec.clusterIP}"])).trim();
  const clients = clientObjects(cell, namespace, lab.image, `${clusterIp}:80`);
  if (!grpc) await cluster.apply(clients);
  await cluster.kubectl(["-n", namespace, "rollout", "status", `deployment/${SERVER}`, "--timeout=300s"]);
  if (grpc) await cluster.apply(clients);
  await cluster.kubectl(["-n", namespace, "rollout", "status", `daemonset/${CLIENT}`, "--timeout=300s"]);
  await lab.rules({ mode: cluster.scenario.kubeProxy.mode, ns: namespace, svc: SERVER, ip: clusterIp, port: 80, every: RULES_EVERY });
  if (cell.mesh?.mode === "sidecar") await pollEndpoints(lab, cluster, namespace);
  return clusterIp;
};

/**
 * This function starts the EDS poll of the client sidecar on each node: the hosts of the server
 * cluster, each 50 ms. The agent enters the network namespace of the client pod through the PID of
 * its client process. The sidecar shares that namespace.
 */
const pollEndpoints = async (lab: KindLab, cluster: Cluster, namespace: string): Promise<void> => {
  const listed = JSON.parse(await cluster.kubectl(["-n", namespace, "get", "pods", "-l", `app=${CLIENT}`, "-o", "json"])) as {
    items: Array<{ metadata: { name: string; deletionTimestamp?: string }; spec: { nodeName?: string } }>;
  };
  const pods: Array<{ node: string; pod: string; pid: number }> = [];
  for (const item of listed.items.filter((each) => each.metadata.deletionTimestamp === undefined)) {
    const node = item.spec.nodeName ?? "";
    pods.push({ node, pod: item.metadata.name, pid: await lab.pidOf(node, namespace, item.metadata.name, CLIENT) });
  }
  await lab.eds({ cluster: serverCluster(namespace), every: EDS_EVERY, pods });
};

/**
 * This function starts the LDS poll of the sidecar of each server pod, each 50 ms, for a cell that
 * polls them (`pollsListeners`). It starts the pollers again only when the server pods changed. The
 * agent enters the network namespace of the pod through the PID of its app.
 */
const pollListeners = async (ctx: Context): Promise<void> => {
  if (!pollsListeners(ctx.cell)) return;
  const servers = ctx.tracker.servers().filter((pod) => !pod.del && pod.node !== null);
  const key = servers.map((pod) => `${pod.name}/${pod.cs.map((status) => status.id).join("+")}`).sort().join();
  if (key === ctx.listened) return;
  const pods: Array<{ node: string; pod: string; pid: number }> = [];
  for (const pod of servers) pods.push({ node: pod.node!, pod: pod.name, pid: await ctx.lab.pidOf(pod.node!, ctx.namespace, pod.name, "app") });
  await ctx.lab.lds({ every: LDS_EVERY, pods });
  ctx.listened = key;
};

/** This function starts the prober again when the pods of the cell changed: it watches the namespace of each pod. */
const probeThePods = async (ctx: Context): Promise<void> => {
  const pods = [...ctx.tracker.pods.values()].filter((pod) => !pod.del && pod.node !== null && pod.cs.every((status) => status.st === "running"));
  const key = pods.map((pod) => `${pod.name}/${pod.cs.map((status) => status.id).join("+")}`).sort().join();
  if (key === ctx.probed) return;
  const netns: number[] = [];
  for (const pod of pods) {
    const container = pod.labels["app"] === SERVER ? "app" : pod.labels["app"] === CLIENT ? CLIENT : REDIS;
    const pid = await ctx.lab.pidOf(pod.node!, ctx.namespace, pod.name, container);
    netns.push(await ctx.lab.netnsOf(pod.node!, pid));
  }
  await ctx.lab.probe([...new Set(netns)]);
  ctx.probed = key;
};

/**
 * This function gives the replicas of the server at this time, in the sequence of their names. The
 * first one is the target of a run. A client of gRPC holds its connection to one replica, and the
 * channels go to the replica that stays after a run. Thus for the stack `grpc`, the first replica
 * is the one that answers the most clients (`byClients`).
 */
const replicasOf = (ctx: Context): Replica[] => {
  const replicas = ctx.tracker.servers().map((pod) => ({ pod: pod.name, node: pod.node ?? "", ip: pod.ip ?? "", version: pod.labels["pod-template-hash"] ?? "" }));
  return stackOf(ctx.cell) === "grpc" ? byClients(replicas, ctx.tracker.answers) : replicas;
};

/**
 * This time is how long before the commit of its rules the lab starts the injector in each replica.
 * It is more than the execs of one node before its commit: a read of its tables and the injector.
 */
const INJECT_LEAD_MS = 700;

/**
 * This function puts the rules of an action in the network namespace of each replica, with each
 * client pod as a peer. The target `servers` gives all replicas, and `server` the target replica alone.
 * The rules of all replicas commit at one instant on
 * CLOCK_MONOTONIC (`--at`). Thus no client meets one replica with the rule and one without it. The
 * replicas of one node go one after the other, and the nodes at the same time.
 *
 * The fault finds the PID of each replica, and the clear uses it again: thus the heal comes soon
 * after its hold. Before the commit of a clear, the lab reads the filter table of each replica. Its
 * counters show if the rule matched the clients beside the rules of istio-cni. After the commit of a
 * fault, the lab reads the nat table, with the redirect of istio-cni. The stamp is the first commit
 * and the last end.
 */
const injectServers = async (ctx: Context, action: string, replicas: readonly Replica[]): Promise<Stamp> => {
  const clients = [...ctx.tracker.pods.values()]
    .filter((pod) => pod.labels["app"] === CLIENT && !pod.del && pod.ip !== null)
    .map((pod) => pod.ip!)
    .sort();
  if (clients.length === 0 || replicas.length === 0) throw new Error(`the injector needs clients and replicas: ${clients.length} clients, ${replicas.length} replicas`);
  const clear = action.startsWith("clear");
  const byNode = new Map<string, number[]>();
  for (const replica of replicas) {
    const known = clear ? ctx.pids.get(replica.pod) : undefined;
    const pid = known ?? (await ctx.lab.pidOf(replica.node, ctx.namespace, replica.pod, "app"));
    ctx.pids.set(replica.pod, pid);
    byNode.set(replica.node, [...(byNode.get(replica.node) ?? []), pid]);
  }
  const at = (await ctx.lab.now()) + INJECT_LEAD_MS;
  const args = [action, clients.join(","), "--at", String(Math.round(at * 1e6))];
  const stamps = await Promise.all(
    [...byNode].map(async ([node, pids]) => {
      const out: Stamp[] = [];
      for (const pid of pids) {
        if (clear) await ctx.lab.tables(node, pid, "filter");
        out.push(await ctx.lab.inject(node, pid, args));
      }
      return out;
    }),
  );
  if (!clear) for (const [node, pids] of byNode) for (const pid of pids) await ctx.lab.tables(node, pid, "nat");
  const all = stamps.flat();
  return { t0: Math.min(...all.map((stamp) => stamp.t0)), t1: Math.max(...all.map((stamp) => stamp.t1)) };
};

/**
 * This function sends a signal to the process of each client pod: the target `clients`. The nodes go
 * at the same time. SIGUSR1 finds the PID of each client, and SIGUSR2 uses it again, thus the heal of
 * a gap comes soon after its hold. When that PID fails, the client started again, and the lab finds
 * its PID. The stamp is the first act and the last end.
 */
const signalClients = async (ctx: Context, signal: string): Promise<Stamp> => {
  const clients = [...ctx.tracker.pods.values()].filter((pod) => pod.labels["app"] === CLIENT && !pod.del && pod.node !== null);
  if (clients.length === 0) throw new Error(`the signal ${signal} needs clients`);
  const stamps = await Promise.all(
    clients.map(async (pod) => {
      const node = pod.node!;
      const known = signal === "SIGUSR2" ? ctx.pids.get(pod.name) : undefined;
      if (known !== undefined) {
        try {
          return await ctx.lab.act(node, { op: "signal", pid: known, signal });
        } catch {
          // the client started again: its PID is new
        }
      }
      const pid = await ctx.lab.pidOf(node, ctx.namespace, pod.name, CLIENT);
      ctx.pids.set(pod.name, pid);
      return ctx.lab.act(node, { op: "signal", pid, signal });
    }),
  );
  return { t0: Math.min(...stamps.map((stamp) => stamp.t0)), t1: Math.max(...stamps.map((stamp) => stamp.t1)) };
};

/**
 * This function gives the network namespace of each pod of a target, as a node and a PID in it. The
 * pods are each client pod (`clients`), or each replica (`servers`).
 */
const namespacesOf = async (ctx: Context, target: Target, replicas: readonly Replica[]): Promise<Array<{ node: string; pod: string; pid: number }>> => {
  if (target === "servers") return Promise.all(replicas.map(async (replica) => ({ node: replica.node, pod: replica.pod, pid: await ctx.lab.pidOf(replica.node, ctx.namespace, replica.pod, "app") })));
  if (target !== "clients") throw new Error(`a sysctl or a middlebox takes the target clients or servers, not ${target}`);
  const clients = [...ctx.tracker.pods.values()].filter((pod) => pod.labels["app"] === CLIENT && !pod.del && pod.node !== null);
  if (clients.length === 0) throw new Error("the step needs clients");
  return Promise.all(clients.map(async (pod) => ({ node: pod.node!, pod: pod.name, pid: await ctx.lab.pidOf(pod.node!, ctx.namespace, pod.name, CLIENT) })));
};

/**
 * This function puts a stateful middlebox in the network namespace of each replica, or removes it.
 * Each client pod is a peer (`middleboxCommands`), and the nodes go at the same time. After the set,
 * the lab reads the filter table: it shows the chains of the middlebox. Before the removal, the lab
 * reads the filter table again: the counters show which segments the middlebox dropped.
 */
const middleboxServers = async (ctx: Context, idle: Quantity | null, port: number, replicas: readonly Replica[]): Promise<Stamp> => {
  const peers = [...ctx.tracker.pods.values()]
    .filter((pod) => pod.labels["app"] === CLIENT && !pod.del && pod.ip !== null)
    .map((pod) => pod.ip!)
    .sort();
  const commands = middleboxCommands(peers, idle, port);
  const t0 = await ctx.lab.now();
  const each = await namespacesOf(ctx, "servers", replicas);
  await Promise.all(
    each.map(async ({ node, pid }) => {
      if (idle === null) await ctx.lab.tables(node, pid, "filter");
      await ctx.lab.netns(node, pid, commands);
      if (idle !== null) await ctx.lab.tables(node, pid, "filter");
    }),
  );
  return { t0, t1: await ctx.lab.now() };
};

/** This function does one step of a fault plan. It gives the stamp of its act, or null for an act without a stamp. */
const doStep = async (ctx: Context, step: Step, replicas: readonly Replica[], background: Array<Promise<unknown>>): Promise<Stamp | null> => {
  const { lab, cluster, namespace } = ctx;
  const target = replicas[0]!;
  const fill = (args: readonly string[]): string[] =>
    args.map((arg) =>
      arg.replaceAll("{namespace}", namespace).replaceAll(POD, target.pod).replaceAll(NODE, target.node).replaceAll(VERSION, String(ctx.version)),
    );
  const where = async (which: Target): Promise<{ node: string; pid: number; pod: PodLine | null }> => {
    if (which === "servers") throw new Error("the target servers is a target of the injector only");
    if (which === "clients") throw new Error("the target clients is a target of a signal only");
    if (which === "server") return { node: target.node, pid: await lab.pidOf(target.node, namespace, target.pod, "app"), pod: null };
    if (which === "redis") {
      const redis = [...ctx.tracker.pods.values()].find((pod) => pod.labels["app"] === REDIS && !pod.del)!;
      return { node: redis.node!, pid: await lab.pidOf(redis.node!, namespace, redis.name, REDIS), pod: redis };
    }
    const worker = cluster.nodes[1] ?? cluster.nodes[0]!;
    const proxy = JSON.parse(
      await cluster.kubectl(["-n", "kube-system", "get", "pods", "-l", "k8s-app=kube-proxy", "--field-selector", `spec.nodeName=${worker}`, "-o", "json"]),
    ) as { items: Array<{ metadata: { name: string } }> };
    return { node: worker, pid: await lab.pidOf(worker, "kube-system", proxy.items[0]!.metadata.name, "kube-proxy"), pod: null };
  };
  switch (step.do) {
    case "kubectl": {
      const t0 = await lab.now();
      if (step.args.includes(`LAB_VERSION=${VERSION}`)) ctx.version += 1;
      const call = cluster.kubectl(fill(step.args));
      if (step.background === true) {
        background.push(call.catch((error: unknown) => ctx.log(`  kubectl ${step.args.join(" ")}: ${String(error)}`)));
        return { t0, t1: t0 };
      }
      await call;
      return { t0, t1: await lab.now() };
    }
    case "signal": {
      if (step.target === "clients") return signalClients(ctx, step.signal);
      const at = await where(step.target);
      return lab.act(at.node, { op: "signal", pid: at.pid, signal: step.signal });
    }
    case "pause": {
      const at = await where(step.target);
      const stamp = lab.act(at.node, { op: "pause", pid: at.pid, ms: valueIn(step.time, "ms") });
      background.push(stamp);
      const now = await lab.now();
      return { t0: now, t1: now };
    }
    case "inject": {
      if (step.target === "servers") return injectServers(ctx, step.action, replicas);
      // the partition of the target: its namespace only, with each client pod as a peer
      if (step.target === "server") return injectServers(ctx, step.action, [target]);
      const at = await where(step.target);
      let first: Stamp | null = null;
      for (const replica of replicas) {
        const stamp = await lab.inject(at.node, at.pid, [step.action, replica.ip]);
        first ??= stamp;
      }
      return first;
    }
    case "flag": {
      const at = await where(step.target);
      return step.on
        ? lab.act(at.node, { op: "write", path: `/proc/${at.pid}/root/tmp/lab-fail`, data: "1" })
        : lab.act(at.node, { op: "remove", path: `/proc/${at.pid}/root/tmp/lab-fail` });
    }
    case "cpu": {
      const at = await where(step.target);
      const cgroup = await lab.cgroupOf(at.node, at.pid);
      return lab.act(at.node, { op: "write", path: `${cgroup}/cpu.max`, data: step.max });
    }
    case "stall": {
      const at = await where(step.target);
      return lab.act(at.node, { op: "stall", pid: at.pid, ms: valueIn(step.time, "ms") });
    }
    case "wait":
      await sleep(valueIn(step.time, "ms"));
      return null;
    case "apply": {
      // the marks are in the strings of the object: its JSON keeps them as they are
      const object = JSON.parse(fill([JSON.stringify(step.object)])[0]!) as Record<string, unknown>;
      const t0 = await lab.now();
      await cluster.apply([object]);
      return { t0, t1: await lab.now() };
    }
    case "sysctl": {
      const command = sysctlCommand(step.key, step.value);
      const t0 = await lab.now();
      await Promise.all((await namespacesOf(ctx, step.target, replicas)).map(({ node, pid }) => lab.netns(node, pid, [command])));
      return { t0, t1: await lab.now() };
    }
    case "certificates": {
      // a failed read is evidence too: the line has its error, and the run goes on
      const t0 = await lab.now();
      const certificates = await ztunnelCertificates(cluster).catch((error: unknown) => String(error).slice(0, 400));
      const t1 = await lab.now();
      lab.record(typeof certificates === "string" ? { ev: "certificates", t: t0, t1, error: certificates } : { ev: "certificates", t: t0, t1, certificates });
      return { t0, t1 };
    }
    case "middlebox":
      if (step.target !== "servers") throw new Error(`a middlebox takes the target servers, not ${step.target}`);
      return middleboxServers(ctx, step.idle, step.port, replicas);
  }
};

/** This function tells if a run is over: the trigger is done, and the cell is at rest again. */
const over = (
  ctx: Context,
  run: { readonly target: Replica | null; readonly replicas: readonly Replica[]; readonly restarts: ReadonlyMap<string, number> },
  lines: readonly Line[],
): boolean => {
  if (unsteady(ctx) !== null) return false;
  const kind = ctx.cell.trigger.kind;
  if ((kind === "crash" || kind === "liveness-restart") && run.target !== null) {
    const pod = ctx.tracker.pods.get(run.target.pod);
    const now = pod === undefined ? 0 : pod.cs.reduce((sum, status) => sum + status.rc, 0);
    return now > (run.restarts.get(run.target.pod) ?? 0);
  }
  if (run.target !== null && ["pod-deletion", "node-drain", "scale-in", "freeze-process"].includes(kind) && (ctx.cell.template === "T07" || ctx.cell.template === "T15"))
    return kind === "scale-in" || kind === "node-drain"
      ? run.replicas.some((replica) => !ctx.tracker.pods.has(replica.pod))
      : !ctx.tracker.pods.has(run.target.pod);
  if (kind === "rolling-update" || kind === "rollout") return run.replicas.every((replica) => !ctx.tracker.pods.has(replica.pod));
  if (kind === "app-stall") return lines.some((line) => line.ev === "stall" && line["phase"] === "end");
  if (kind === "ztunnel-restart") return ztunnelReplaced(lines, ctx.cluster.nodes);
  return true;
};

/** This function gives the replica that the trigger stopped. For a scale-in or a drain, the controller chooses it. */
const stoppedOf = (cell: KindCell, replicas: readonly Replica[], target: Replica | null, lines: readonly Line[]): Replica | null =>
  deletesAPod(cell) ? (replicas.find((replica) => lines.some((line) => line.ev === "pod" && line["name"] === replica.pod && line["del"] === true)) ?? target) : target;

/**
 * This function does one run of a cell: at rest, the trigger, the heal, then the observation. The
 * observation lasts until the cell is at rest again, and until each predicted window can close
 * (`observationEnd`).
 */
const runOnce = async (ctx: Context, env: number, index: number, warmup: boolean, ours: Set<string>): Promise<KindRun> => {
  const { lab, cell, cluster, namespace } = ctx;
  const plan = planOf(cell);
  const atRest = await steady(ctx, 300_000);
  const empty = (why: string, start: number): KindRun => ({
    env, index, warmup, start, end: start, acts: { fault: null, heal: null, resume: null }, target: null, paused: null, replicas: [], void: why, lines: lab.take(), dropped: {},
  });
  if (atRest !== null) return empty(`the cell was not at rest: ${atRest}`, await lab.now());
  await probeThePods(ctx);
  await pollListeners(ctx);
  await quiet(ctx, ours);
  if ((await steady(ctx, 300_000)) !== null) return empty("the cell was not at rest after the wait for a quiet VM", await lab.now());
  const replicas = replicasOf(ctx);
  const restarts = new Map(ctx.tracker.servers().map((pod) => [pod.name, pod.cs.reduce((sum, status) => sum + status.rc, 0)]));
  const target = hasRedis(cell) && ["rst", "blackhole", "freeze-process", "peer-gone-without-close", "rollout"].includes(cell.trigger.kind) ? null : replicas[0]!;
  const paused = cell.template === "T07" && cell.trigger.kind === "freeze-process" ? (cluster.nodes[1] ?? cluster.nodes[0]!) : null;
  // A SYN with no answer before the run keeps its NAT for 120 s (SYN_SENT). A client that takes its
  // port again in the run meets it, and the restore of the last run leaves such SYNs. Each run starts with none
  const cleared = await lab.forgetHandshakes(ctx.clusterIp, 80);
  lab.take();
  for (const key of Object.keys(lab.dropped)) delete lab.dropped[key];
  const start = await lab.now();
  const background: Array<Promise<unknown>> = [];
  let fault: number | null = null;
  let resume: number | null = null;
  if (cell.trigger.kind === "scale-in") ctx.expected = cell.pod.replicas - 1;
  const notes: string[] = [];
  const forgotten = Object.entries(cleared).filter(([, count]) => count > 0);
  if (forgotten.length > 0) notes.push(`before the run, the lab deleted SYN_SENT entries of the ClusterIP: ${forgotten.map(([node, count]) => `${count} on ${node}`).join(", ")}`);
  // the steps before the fault. A failed one makes the run void with its reason, after the restore
  for (const step of plan.prepare ?? []) {
    try {
      await doStep(ctx, step, replicas, background);
    } catch (error) {
      const why = `the step ${step.do} before the fault failed: ${String(error).slice(0, 400)}`;
      ctx.log(`  ${why}`);
      for (const each of plan.restore) await doStep(ctx, each, replicas, background).catch((failure: unknown) => ctx.log(`  the restore ${each.do} failed: ${String(failure)}`));
      return empty(why, start);
    }
  }
  for (const step of plan.inject) {
    const stamp = await doStep(ctx, step, replicas, background);
    if (stamp !== null && fault === null) fault = stamp.t0;
  }
  let heal: number | null = null;
  // the heal of one fault, `hold` after its stamp: the stamp of its first act, or null
  const healAfter = async (from: number | null, hold: Quantity): Promise<number | null> => {
    const now = await lab.now();
    await sleep(Math.max(0, valueIn(hold, "ms") - (now - (from ?? now))));
    let stamped: number | null = null;
    for (const step of plan.heal) {
      try {
        const stamp = await doStep(ctx, step, replicas, background);
        if (stamp !== null && stamped === null) stamped = stamp.t0;
      } catch (error) {
        notes.push(`the heal ${step.do} failed: ${String(error)}`);
      }
    }
    return stamped;
  };
  const cycles: Cycle[] = [];
  if (plan.hold !== null) {
    heal = await healAfter(fault, plan.hold);
    if (fault !== null && heal !== null) cycles.push({ fault, heal });
    // each flap: the rest from the heal before it, the inject again, and its heal after its own hold
    for (const flap of plan.flaps ?? []) {
      const now = await lab.now();
      await sleep(Math.max(0, valueIn(flap.rest, "ms") - (now - (heal ?? now))));
      let again: number | null = null;
      for (const step of plan.inject) {
        try {
          const stamp = await doStep(ctx, step, replicas, background);
          if (stamp !== null && again === null) again = stamp.t0;
        } catch (error) {
          notes.push(`the inject ${step.do} of a flap failed: ${String(error)}`);
        }
      }
      const healed = await healAfter(again, flap.hold);
      if (again !== null && healed !== null) cycles.push({ fault: again, heal: healed });
      heal = healed ?? heal;
    }
  }
  const flapped = (plan.flaps ?? []).length > 0;
  if (flapped && cycles.length !== (plan.flaps ?? []).length + 1) notes.push(`the run has ${cycles.length} cycles with stamps of the ${(plan.flaps ?? []).length + 1} of the trigger`);
  const flapping = flapped ? { cycles } : {};
  const settled = await Promise.allSettled(background);
  for (const each of settled) {
    if (each.status === "fulfilled" && typeof each.value === "object" && each.value !== null && "t1" in each.value) resume = (each.value as Stamp).t1;
  }
  // the observation: at least 3 s after the last act, until the trigger happened and the cell is at rest again
  const limit = Date.now() + 240_000 + valueIn(cell.pod.grace, "ms") + valueIn(cell.pod.preStop, "ms");
  await sleep(3000);
  while (Date.now() < limit && !over(ctx, { target, replicas, restarts }, lab.lines)) await sleep(250);
  // then until each predicted window can close and each request that started in it ended (`observationEnd`)
  const until = observationEnd(cell, { start, acts: { fault, heal, resume, ...flapping }, target: stoppedOf(cell, replicas, target, lab.lines), replicas, lines: lab.lines });
  if (until !== null) {
    const wait = Math.min(until - (await lab.now()), limit - Date.now());
    if (wait > 0) await sleep(wait);
  }
  const end = await lab.now();
  const timedOut = Date.now() >= limit;
  for (const step of plan.restore) {
    try {
      await doStep(ctx, step, replicas, background);
    } catch (error) {
      notes.push(`the restore ${step.do} failed: ${String(error)}`);
    }
  }
  ctx.expected = cell.pod.replicas;
  for (const note of notes) ctx.log(`  ${note}`);
  const lines = lab.take();
  const stopped = stoppedOf(cell, replicas, target, lines);
  const restarted = lines.some((line) => line.ev === "pod" && (line["cs"] as Array<{ rc: number }>).some((status) => status.rc > 0));
  if (restarted) {
    // a container that restarted gets a back-off on its next restart: new pods start without one
    await cluster.kubectl(["-n", namespace, "rollout", "restart", `deployment/${SERVER}`]);
    await cluster.kubectl(["-n", namespace, "rollout", "status", `deployment/${SERVER}`, "--timeout=300s"]);
  }
  if (cell.trigger.kind === "node-drain") await rebalance(ctx);
  ctx.log(`  ${warmup ? "warm-up" : `run ${index}`}: ${sec(end - start)} s${timedOut ? ", not at rest in time" : ""}`);
  return {
    env, index, warmup, start, end, acts: { fault, heal, resume, ...flapping }, target: stopped, paused, replicas, void: null, lines, dropped: { ...lab.dropped }, notes,
  };
};

const sec = (ms: number): number => Math.round(ms) / 1000;

/** This function moves a replica back to a node without one after a drain: it deletes one replica of the node with two. */
const rebalance = async (ctx: Context): Promise<void> => {
  await steady(ctx, 300_000);
  const servers = ctx.tracker.servers();
  const byNode = new Map<string, string[]>();
  for (const pod of servers) byNode.set(pod.node ?? "", [...(byNode.get(pod.node ?? "") ?? []), pod.name]);
  const crowded = [...byNode.values()].find((pods) => pods.length > 1);
  if (crowded !== undefined && byNode.size < ctx.cluster.nodes.length - 1)
    await ctx.cluster.kubectl(["-n", ctx.namespace, "delete", "pod", crowded[0]!, "--wait=true"]);
};

/** This function writes the result of a cell: its raw record, and one line of its verdict in `summary.ndjson`. */
export const writeResult = (out: string, result: KindCellResult): void => {
  mkdirSync(out, { recursive: true });
  const record: KindCellRecord = { format: FORMAT, ...result };
  writeFileSync(join(out, `${slug(result.cell.name)}.json`), JSON.stringify(record));
  const { verdict, cell } = result;
  writeFileSync(
    join(out, "summary.ndjson"),
    `${JSON.stringify({
      id: cell.id,
      name: cell.name,
      mode: cell.mode,
      trigger: cell.trigger.kind,
      prediction: cell.prediction.kind,
      decision: verdict.decision,
      counted: verdict.counted,
      voided: verdict.voided,
      failed: verdict.failed,
      median: verdict.median,
      why: verdict.why,
    })}\n`,
    { flag: "a" },
  );
};

/**
 * This function does the runs of a catalog of kind cells. The cells of one kube-proxy mode and node
 * count share a cluster. Each group gets new clusters in sequence, one for each environment. Each
 * environment does its share of the runs of each cell, after one warm-up. The function deletes each
 * cluster after its cells.
 */
export const runKindCells = async (cells: readonly KindCell[], options: RunOptions): Promise<KindCellResult[]> => {
  const environments = options.environments ?? 2;
  const image = await labImage();
  const redisImage = await localPin(REDIS_IMAGE);
  // the server of the stack grpc: the image of grpc-go of the harness, built from its tag
  const grpcImage = cells.some((cell) => stackOf(cell) === "grpc") ? await imageOf({ kind: "shipped", name: "grpc-go" }) : undefined;
  // Istio: each image of each flavor of the cells pulled once by its digest, and tagged with it, for `kind load`
  const flavors = new Set(cells.flatMap((cell) => (cell.mesh === undefined ? [] : [cell.mesh.flavor])));
  const pinned = new Map<keyof typeof ISTIO_IMAGES, string>();
  for (const name of new Set([...flavors].flatMap((flavor) => MESH_IMAGES[flavor]))) pinned.set(name, await localPin(ISTIO_IMAGES[name]));
  const meshImages: MeshImages | undefined =
    flavors.size === 0 ? undefined : { pilot: pinned.get("pilot")!, proxy: pinned.get("proxy")!, cni: pinned.get("cni"), ztunnel: pinned.get("ztunnel") };
  const images: Images = { lab: image, redis: redisImage, grpc: grpcImage, mesh: meshImages };
  // the cells of one kube-proxy mode, node count and mesh flavor share a cluster
  const groups = new Map<string, KindCell[]>();
  for (const cell of cells) groups.set(clusterKey(cell), [...(groups.get(clusterKey(cell)) ?? []), cell]);
  const results: KindCellResult[] = [];
  for (const [key, group] of groups) {
    const partial = new Map<string, { runs: KindRun[]; manifests: EnvironmentManifest[]; loads: LoadSample[] }>();
    for (let env = 0; env < environments; env += 1) {
      const s = scenario(`lab-${key}-${env}`, group[0]!.mode, group[0]!.workers);
      const dir = join(options.work ?? join(tmpdir(), "systems-kind-work"), s.name);
      const mesh = group[0]!.mesh;
      options.log(`cluster ${s.name}: ${s.kubeProxy.mode}, ${s.workers} workers${mesh === undefined ? "" : `, Istio ${mesh.flavor}`}`);
      const cluster = await createCluster(s, dir);
      let lab: KindLab | null = null;
      let loader: StartedTestContainer | null = null;
      try {
        await cluster.load(image);
        await cluster.load(redisImage);
        if (grpcImage !== undefined && group.some((cell) => stackOf(cell) === "grpc")) await cluster.load(grpcImage);
        if (mesh !== undefined) {
          if (images.mesh === undefined) throw new Error(`${group[0]!.name}: the run has no images of Istio`);
          for (const name of MESH_IMAGES[mesh.flavor]) {
            const each = images.mesh[name];
            if (each === undefined) throw new Error(`${group[0]!.name}: the run has no image ${name} of Istio`);
            await cluster.load(each);
          }
          const began = Date.now();
          await installMesh(cluster, mesh.flavor, images.mesh);
          options.log(`  Istio ${mesh.flavor} installed in ${Math.round((Date.now() - began) / 100) / 10} s`);
        }
        lab = await openKindLab(cluster, image);
        const { GenericContainer } = await import("testcontainers");
        const Shared = class extends GenericContainer {
          withPidMode(mode: string): this {
            (this as unknown as { hostConfig: { PidMode?: string } }).hostConfig.PidMode = mode;
            return this;
          }
        };
        loader = await new Shared(image).withPidMode("host").withNetworkMode("none").withCommand(["sleep", "infinity"]).start();
        const manifest = await cluster.manifest();
        const ours = new Set<string>([...cluster.nodes]);
        for (const cell of group) {
          const namespace = namespaceOf(cell);
          options.log(`${cell.name} (${cell.id}), environment ${env}`);
          const tracker = new Tracker();
          const off = lab.listen(tracker.see);
          const loads: LoadSample[] = [];
          // the environment of ztunnel for the cell, before its pods: thus its rollout ends no flow of the cell
          const ztunnelEnv = cell.mesh?.ztunnel;
          try {
            if (ztunnelEnv !== undefined) await setZtunnelEnv(cluster, ztunnelEnv, false);
            const clusterIp = await deploy(lab, cluster, cell, namespace, images);
            for (const name of [...lab.own(), loader.getName().replace(/^\//, "")]) ours.add(name);
            const ctx: Context = { lab, cluster, cell, namespace, tracker, clusterIp, loads, loader, idle: options.idle ?? 0.6, log: options.log, version: 1, probed: "", listened: "", expected: cell.pod.replicas, pids: new Map() };
            const share = Math.ceil(cell.runs / environments) - (env < cell.runs % environments || cell.runs % environments === 0 ? 0 : 1);
            const runs: KindRun[] = [await runOnce(ctx, env, -1, true, ours)];
            for (let index = 0; index < share; index += 1) runs.push(await runOnce(ctx, env, index, false, ours));
            const entry = partial.get(cell.name) ?? { runs: [], manifests: [], loads: [] };
            entry.runs.push(...runs);
            entry.manifests.push({
              env,
              scenario: s,
              cluster: manifest,
              images: {
                lab: image,
                redis: redisImage,
                ...(stackOf(cell) === "grpc" ? { grpc: grpcImage! } : {}),
                ...(cell.mesh === undefined ? {} : Object.fromEntries(MESH_IMAGES[cell.mesh.flavor].map((name) => [`istio-${name}`, ISTIO_IMAGES[name]]))),
              },
            });
            entry.loads.push(...loads);
            partial.set(cell.name, entry);
            mkdirSync(join(options.out, "partial"), { recursive: true });
            writeFileSync(join(options.out, "partial", `${slug(cell.name)}.env${env}.json`), JSON.stringify({ cell, runs, manifest, loads }));
          } finally {
            off();
            await lab.rules(null).catch(() => undefined);
            await lab.eds(null).catch(() => undefined);
            await lab.lds(null).catch(() => undefined);
            await lab.stopProbe();
            await cluster.kubectl(["delete", "namespace", namespace, "--wait=true", "--timeout=300s"]).catch((error: unknown) => options.log(`  ${String(error)}`));
            if (ztunnelEnv !== undefined) await setZtunnelEnv(cluster, ztunnelEnv, true).catch((error: unknown) => options.log(`  the undo of the environment of ztunnel failed: ${String(error)}`));
          }
        }
      } finally {
        if (loader !== null) await loader.stop({ timeout: 0 }).catch(() => undefined);
        if (lab !== null) await lab.close();
        await cluster.delete();
        options.log(`cluster ${s.name} deleted`);
      }
    }
    for (const cell of group) {
      const entry = partial.get(cell.name);
      if (entry === undefined) continue;
      const result: KindCellResult = { cell, ...entry, verdict: judgeKind(cell, entry.runs), at: new Date().toISOString() };
      writeResult(options.out, result);
      rmSync(join(options.out, "partial", `${slug(cell.name)}.env0.json`), { force: true });
      for (let env = 1; env < environments; env += 1) rmSync(join(options.out, "partial", `${slug(cell.name)}.env${env}.json`), { force: true });
      options.log(`${cell.name}: ${result.verdict.decision}, ${result.verdict.why}`);
      results.push(result);
    }
  }
  return results;
};

/** This function gives the estimate of a cell in seconds, for the arithmetic of the shards. */
const estimate = (cell: KindCell, environments = 2): number => {
  // the span of the faults: the hold, then the rest and the hold of each flap
  const hold = valueIn(faultSpan(cell.trigger), "s");
  const trigger: Record<string, number> = {
    "liveness-restart": 100,
    crash: 30,
    "app-stall": hold + 40,
    "cpu-throttle": hold + 40,
    rollout: hold + 50,
    "authorization-policy": hold + 20,
    idle: hold + 5,
    // the grace of 30 s of the chart of ztunnel, then the removal of the old pods
    "ztunnel-restart": 40,
    // the hold, and a read of the certificates of each ztunnel pod at the fault and at the heal
    "certificate-expiry": hold + 20,
    "cannot-serve": hold + 20,
  };
  // a window can need a longer observation: from the end of the hold, until each request that started in it ended
  const after = observationAfter(cell);
  const observed = after === null ? 0 : hold + valueIn(after, "s");
  // the band of `ends` too: until each socket can end
  const closes = cell.prediction.kind === "ends" && cell.prediction.band !== null ? valueIn(cell.prediction.band.hi, "s") + 3 : 0;
  // a quiet black hole: the stop of the calls before the fault, the hold, and the start of the calls after the clear
  const quiet = cell.trigger.quiet === true ? hold + 10 : 0;
  const each = 25 + Math.max(observed, closes, quiet, trigger[cell.trigger.kind] ?? (cell.template === "T18" ? hold + 35 : 15 + valueIn(cell.pod.preStop, "s")));
  // the install of Istio in each cluster takes 1 to 2 min
  const setup = cell.mesh === undefined ? 60 : 180;
  return setup * environments + (cell.runs + environments) * each;
};

/**
 * This function gives an estimate of the time of a cell: its setup, then each run and each
 * warm-up. A run waits for the cell at rest, samples the load, does the trigger and waits until the
 * cell is at rest again.
 */
export const estimatedTime = (cell: KindCell, environments = 2): Quantity => ({ value: estimate(cell, environments), unit: "s" });

/**
 * This function gives the share of a shard of a catalog: cells in sequence. Thus the cells of one
 * mode and one mesh flavor stay together and share clusters. Each shard gets an equal share of the
 * estimated time. In one mode, the cells with no mesh come first, in the sequence of the catalog.
 */
export const shardOf = <T extends KindCell>(cells: readonly T[], index: number, count: number): T[] => {
  if (!(Number.isInteger(index) && Number.isInteger(count) && count >= 1 && index >= 0 && index < count))
    throw new RangeError(`shard ${index} of ${count} is not a shard`);
  const rank = (cell: KindCell): string => `${cell.mode}/${meshKey(cell) === "none" ? "" : meshKey(cell)}`;
  const ordered = [...cells].sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1));
  const total = ordered.reduce((sum, cell) => sum + estimate(cell), 0);
  const out: T[] = [];
  let before = 0;
  for (const cell of ordered) {
    const middle = before + estimate(cell) / 2;
    if (Math.min(count - 1, Math.floor((middle / total) * count)) === index) out.push(cell);
    before += estimate(cell);
  }
  return out;
};
