import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedTestContainer } from "testcontainers";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { KindCell, KindRun, Replica } from "./cell.ts";
import type { Cluster } from "./cluster.ts";
import { command, createCluster } from "./cluster.ts";
import type { Step } from "./faults.ts";
import { NODE, POD, VERSION, deletes as deletesAPod, planOf } from "./faults.ts";
import { labImage } from "./image.ts";
import type { KindLab, Line, Stamp } from "./lab.ts";
import { localPin, openKindLab } from "./lab.ts";
import { CLIENT, REDIS, REDIS_IMAGE, SERVER, clientObjects, namespaceOf, redisObjects, serverObjects } from "./manifests.ts";
import type { PodLine, Request } from "./observe.ts";
import type { EnvironmentManifest, KindCellRecord, KindCellResult, LoadSample } from "./record.ts";
import { FORMAT } from "./record.ts";
import { scenario } from "./scenario.ts";
import { judgeKind } from "./verdict.ts";

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

/** This tracker keeps the latest state of the cell from the lines: each pod, each slice, the backends of each node and each client. */
class Tracker {
  readonly pods = new Map<string, PodLine>();
  readonly slices = new Map<string, Line>();
  readonly backends = new Map<string, readonly string[]>();
  readonly clients = new Map<string, { node: string; ok: number; failed: number }>();
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
    } else if (line.ev === "req") {
      const request = line as unknown as Request;
      const client = this.clients.get(request.p) ?? { node: request.n, ok: 0, failed: 0 };
      if (request.o === "ok") client.ok = Math.max(client.ok, request.t);
      else client.failed = Math.max(client.failed, request.t);
      this.clients.set(request.p, client);
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
  /** This count is the replicas of the service at rest: one less while a scale-in holds. */
  expected: number;
}

/** This function tells why the cell is not at rest, or gives null when it is. */
const unsteady = (ctx: Context): string | null => {
  const { tracker, cell } = ctx;
  const servers = tracker.servers();
  if (servers.length !== ctx.expected) return `${servers.length} replicas, not ${ctx.expected}`;
  const busy = servers.find((pod) => pod.del || !pod.ready);
  if (busy !== undefined) return `${busy.name} is not ready`;
  if (new Set(servers.map((pod) => pod.labels["pod-template-hash"])).size > 1) return "two versions of the replicas";
  if (cell.declaration.redis !== null) {
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

/** This function deploys a cell in its namespace, with the watcher, the poll of the rules and the clients. */
const deploy = async (lab: KindLab, cluster: Cluster, cell: KindCell, namespace: string, redisImage: string): Promise<string> => {
  await cluster.apply([{ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } }]);
  await lab.watch([namespace]);
  if (cell.declaration.redis !== null) {
    await cluster.apply(redisObjects(namespace, redisImage));
    await cluster.kubectl(["-n", namespace, "rollout", "status", `deployment/${REDIS}`, "--timeout=180s"]);
  }
  await cluster.apply(serverObjects(cell, namespace, lab.image));
  const clusterIp = (await cluster.kubectl(["-n", namespace, "get", "service", SERVER, "-o", "jsonpath={.spec.clusterIP}"])).trim();
  await cluster.apply(clientObjects(cell, namespace, lab.image, `${clusterIp}:80`));
  await cluster.kubectl(["-n", namespace, "rollout", "status", `deployment/${SERVER}`, "--timeout=300s"]);
  await cluster.kubectl(["-n", namespace, "rollout", "status", `daemonset/${CLIENT}`, "--timeout=300s"]);
  await lab.rules({ mode: cluster.scenario.kubeProxy.mode, ns: namespace, svc: SERVER, ip: clusterIp, port: 80, every: RULES_EVERY });
  return clusterIp;
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

/** This function gives the replicas of the service at this time, in the sequence of their names. */
const replicasOf = (ctx: Context): Replica[] =>
  ctx.tracker.servers().map((pod) => ({ pod: pod.name, node: pod.node ?? "", ip: pod.ip ?? "", version: pod.labels["pod-template-hash"] ?? "" }));

/** This function does one step of a fault plan. It gives the stamp of its act, or null for an act without a stamp. */
const doStep = async (ctx: Context, step: Step, replicas: readonly Replica[], background: Array<Promise<unknown>>): Promise<Stamp | null> => {
  const { lab, cluster, namespace } = ctx;
  const target = replicas[0]!;
  const fill = (args: readonly string[]): string[] =>
    args.map((arg) =>
      arg.replaceAll("{namespace}", namespace).replaceAll(POD, target.pod).replaceAll(NODE, target.node).replaceAll(VERSION, String(ctx.version)),
    );
  const where = async (which: "server" | "redis" | "kube-proxy"): Promise<{ node: string; pid: number; pod: PodLine | null }> => {
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
  if (run.target !== null && ["pod-deletion", "node-drain", "scale-in", "freeze-process"].includes(kind) && ctx.cell.template === "T07")
    return kind === "scale-in" || kind === "node-drain"
      ? run.replicas.some((replica) => !ctx.tracker.pods.has(replica.pod))
      : !ctx.tracker.pods.has(run.target.pod);
  if (kind === "rolling-update" || kind === "rollout") return run.replicas.every((replica) => !ctx.tracker.pods.has(replica.pod));
  if (kind === "app-stall") return lines.some((line) => line.ev === "stall" && line["phase"] === "end");
  return true;
};

/** This function does one run of a cell: at rest, the trigger, the heal, then the observation until the cell is at rest again. */
const runOnce = async (ctx: Context, env: number, index: number, warmup: boolean, ours: Set<string>): Promise<KindRun> => {
  const { lab, cell, cluster, namespace } = ctx;
  const plan = planOf(cell);
  const atRest = await steady(ctx, 300_000);
  const empty = (why: string, start: number): KindRun => ({
    env, index, warmup, start, end: start, acts: { fault: null, heal: null, resume: null }, target: null, paused: null, replicas: [], void: why, lines: lab.take(), dropped: {},
  });
  if (atRest !== null) return empty(`the cell was not at rest: ${atRest}`, await lab.now());
  await probeThePods(ctx);
  await quiet(ctx, ours);
  if ((await steady(ctx, 300_000)) !== null) return empty("the cell was not at rest after the wait for a quiet VM", await lab.now());
  const replicas = replicasOf(ctx);
  const restarts = new Map(ctx.tracker.servers().map((pod) => [pod.name, pod.cs.reduce((sum, status) => sum + status.rc, 0)]));
  const target = cell.declaration.redis !== null && ["rst", "blackhole", "freeze-process", "peer-gone-without-close", "rollout"].includes(cell.trigger.kind) ? null : replicas[0]!;
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
  for (const step of plan.inject) {
    const stamp = await doStep(ctx, step, replicas, background);
    if (stamp !== null && fault === null) fault = stamp.t0;
  }
  let heal: number | null = null;
  if (plan.hold !== null) {
    const now = await lab.now();
    await sleep(Math.max(0, valueIn(plan.hold, "ms") - (now - (fault ?? now))));
    for (const step of plan.heal) {
      try {
        const stamp = await doStep(ctx, step, replicas, background);
        if (stamp !== null && heal === null) heal = stamp.t0;
      } catch (error) {
        notes.push(`the heal ${step.do} failed: ${String(error)}`);
      }
    }
  }
  const settled = await Promise.allSettled(background);
  for (const each of settled) {
    if (each.status === "fulfilled" && typeof each.value === "object" && each.value !== null && "t1" in each.value) resume = (each.value as Stamp).t1;
  }
  // the observation: at least 3 s after the last act, until the trigger happened and the cell is at rest again
  const limit = Date.now() + 240_000 + valueIn(cell.pod.grace, "ms") + valueIn(cell.pod.preStop, "ms");
  await sleep(3000);
  while (Date.now() < limit && !over(ctx, { target, replicas, restarts }, lab.lines)) await sleep(250);
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
  // the replica that the trigger stopped: for a scale-in or a drain, the controller chooses it
  const stopped = deletesAPod(cell) ? (replicas.find((replica) => lines.some((line) => line.ev === "pod" && line["name"] === replica.pod && line["del"] === true)) ?? target) : target;
  const restarted = lines.some((line) => line.ev === "pod" && (line["cs"] as Array<{ rc: number }>).some((status) => status.rc > 0));
  if (restarted) {
    // a container that restarted gets a back-off on its next restart: new pods start without one
    await cluster.kubectl(["-n", namespace, "rollout", "restart", `deployment/${SERVER}`]);
    await cluster.kubectl(["-n", namespace, "rollout", "status", `deployment/${SERVER}`, "--timeout=300s"]);
  }
  if (cell.trigger.kind === "node-drain") await rebalance(ctx);
  ctx.log(`  ${warmup ? "warm-up" : `run ${index}`}: ${sec(end - start)} s${timedOut ? ", not at rest in time" : ""}`);
  return {
    env, index, warmup, start, end, acts: { fault, heal, resume }, target: stopped, paused, replicas, void: null, lines, dropped: { ...lab.dropped }, notes,
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
  const groups = new Map<string, KindCell[]>();
  for (const cell of cells) groups.set(`${cell.mode}-${cell.workers}`, [...(groups.get(`${cell.mode}-${cell.workers}`) ?? []), cell]);
  const results: KindCellResult[] = [];
  for (const [key, group] of groups) {
    const partial = new Map<string, { runs: KindRun[]; manifests: EnvironmentManifest[]; loads: LoadSample[] }>();
    for (let env = 0; env < environments; env += 1) {
      const s = scenario(`lab-${key}-${env}`, group[0]!.mode, group[0]!.workers);
      const dir = join(options.work ?? join(tmpdir(), "systems-kind-work"), s.name);
      options.log(`cluster ${s.name}: ${s.kubeProxy.mode}, ${s.workers} workers`);
      const cluster = await createCluster(s, dir);
      let lab: KindLab | null = null;
      let loader: StartedTestContainer | null = null;
      try {
        await cluster.load(image);
        await cluster.load(redisImage);
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
          try {
            const clusterIp = await deploy(lab, cluster, cell, namespace, redisImage);
            for (const name of [...lab.own(), loader.getName().replace(/^\//, "")]) ours.add(name);
            const ctx: Context = { lab, cluster, cell, namespace, tracker, clusterIp, loads, loader, idle: options.idle ?? 0.6, log: options.log, version: 1, probed: "", expected: cell.pod.replicas };
            const share = Math.ceil(cell.runs / environments) - (env < cell.runs % environments || cell.runs % environments === 0 ? 0 : 1);
            const runs: KindRun[] = [await runOnce(ctx, env, -1, true, ours)];
            for (let index = 0; index < share; index += 1) runs.push(await runOnce(ctx, env, index, false, ours));
            const entry = partial.get(cell.name) ?? { runs: [], manifests: [], loads: [] };
            entry.runs.push(...runs);
            entry.manifests.push({ env, scenario: s, cluster: manifest, images: { lab: image, redis: redisImage } });
            entry.loads.push(...loads);
            partial.set(cell.name, entry);
            mkdirSync(join(options.out, "partial"), { recursive: true });
            writeFileSync(join(options.out, "partial", `${slug(cell.name)}.env${env}.json`), JSON.stringify({ cell, runs, manifest, loads }));
          } finally {
            off();
            await lab.rules(null).catch(() => undefined);
            await lab.stopProbe();
            await cluster.kubectl(["delete", "namespace", namespace, "--wait=true", "--timeout=300s"]).catch((error: unknown) => options.log(`  ${String(error)}`));
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
  const hold = cell.trigger.hold === undefined ? 0 : valueIn(cell.trigger.hold, "s");
  const trigger: Record<string, number> = {
    "liveness-restart": 100,
    crash: 30,
    "app-stall": hold + 40,
    "cpu-throttle": hold + 40,
    rollout: hold + 50,
  };
  const each = 25 + (trigger[cell.trigger.kind] ?? (cell.template === "T18" ? hold + 35 : 15 + valueIn(cell.pod.preStop, "s")));
  return 60 * environments + (cell.runs + environments) * each;
};

/**
 * This function gives an estimate of the time of a cell: its setup, then each run and each
 * warm-up. A run waits for the cell at rest, samples the load, does the trigger and waits until the
 * cell is at rest again.
 */
export const estimatedTime = (cell: KindCell, environments = 2): Quantity => ({ value: estimate(cell, environments), unit: "s" });

/**
 * This function gives the share of a shard of a catalog: cells in sequence. Thus the cells of one
 * mode stay together and share clusters. Each shard gets an equal share of the estimated time.
 */
export const shardOf = <T extends KindCell>(cells: readonly T[], index: number, count: number): T[] => {
  if (!(Number.isInteger(index) && Number.isInteger(count) && count >= 1 && index >= 0 && index < count))
    throw new RangeError(`shard ${index} of ${count} is not a shard`);
  const ordered = [...cells].sort((a, b) => (a.mode === b.mode ? 0 : a.mode < b.mode ? -1 : 1));
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
