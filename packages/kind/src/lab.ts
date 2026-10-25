import type { StartedTestContainer } from "testcontainers";
import { harnessImage } from "@mark1russell7/harness";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { ServiceRule } from "./backends.ts";
import { deletedOf } from "./conntrack.ts";
import type { Cluster } from "./cluster.ts";
import { command } from "./cluster.ts";
import type { Line } from "./observe.ts";
import { isTunnelState } from "./observe.ts";

export type { Line } from "./observe.ts";

/** A stamp brackets an act on CLOCK_MONOTONIC, in milliseconds. */
export interface Stamp {
  readonly t0: number;
  readonly t1: number;
}

/**
 * These kinds of kernel record stay in the raw record of a run. The lab also keeps each change of the
 * state of a socket of the HBONE port (`isTunnelState`): the tunnels of ztunnel. It counts the other
 * records and drops them.
 */
export const KEPT_KERNEL: ReadonlySet<string> = new Set(["rst_tx", "rst_rx", "rst_v4", "error", "retrans", "begin", "fail"]);

/** This function tells if the lab keeps a kernel record of the prober. */
export const keptKernel = (record: Readonly<Record<string, unknown>>): boolean => KEPT_KERNEL.has(String(record["ev"])) || isTunnelState(record);

/** An EDS spec is the cluster that the EDS pollers read, their interval, and each client pod with its node and a PID in it. */
export interface EdsSpec {
  readonly cluster: string;
  readonly every: Quantity;
  readonly pods: ReadonlyArray<{ readonly node: string; readonly pod: string; readonly pid: number }>;
}

/** An LDS spec is the interval of the LDS pollers, and each server pod with its node and a PID in it. */
export interface LdsSpec {
  readonly every: Quantity;
  readonly pods: ReadonlyArray<{ readonly node: string; readonly pod: string; readonly pid: number }>;
}

/** These are the sidecars of one node: the agent of the lab and the injector of the harness, in the PID namespace of the node. */
interface Sidecars {
  readonly agent: StartedTestContainer;
  readonly injector: StartedTestContainer;
}

/** A kind lab is the instruments of one cluster: a sidecar pair on each node, the watcher of the API and the prober. */
export interface KindLab {
  readonly cluster: Cluster;
  readonly image: string;
  /** These are the lines since the last `take()`. */
  readonly lines: Line[];
  /** This record counts the kernel records that the lab dropped, by kind. */
  readonly dropped: Record<string, number>;
  /** This method gives the names of the containers that the lab started: they are not the lab containers of another agent. */
  own(): string[];
  /** This method gives the lines since the last call, and starts a new buffer. */
  take(): Line[];
  /** This method adds a listener of each line, and gives the function that removes it. */
  listen(listener: (line: Line) => void): () => void;
  /**
   * This method starts the watcher of the API on the namespaces. With `ztunnel`, it also follows the
   * log of each ztunnel in istio-system: lines `ztunnel-pod` and `ztunnel`, which no tracker of the
   * cell reads.
   */
  watch(namespaces: readonly string[], options?: { readonly ztunnel?: boolean | undefined }): Promise<void>;
  probe(netns: readonly number[]): Promise<void>;
  stopProbe(): Promise<void>;
  /** This method asks each agent to poll the backends of a Service in the rules of its node, `every` apart, or to stop with null. */
  rules(rule: (ServiceRule & { readonly every: Quantity }) | null): Promise<void>;
  /**
   * This method asks each agent to poll the sidecar of each client pod of its node, `every` apart.
   * Each poll gives the hosts of one cluster. With null, the polls stop. A pod gives the PID of one
   * of its processes, and the agent enters the network namespace of that PID.
   */
  eds(spec: EdsSpec | null): Promise<void>;
  /**
   * This method asks each agent to poll the sidecar of each server pod of its node, `every` apart.
   * Each poll gives the counters of LDS updates of that sidecar (`lds.ts`). With null, the polls stop.
   */
  lds(spec: LdsSpec | null): Promise<void>;
  act(node: string, spec: Readonly<Record<string, unknown>>): Promise<Stamp>;
  inject(node: string, pid: number, args: readonly string[]): Promise<Stamp>;
  /**
   * This method gives the rules of one table of iptables in the network namespace of a PID, with
   * their counters (`iptables-save -c`). The injector reads them. The method also adds them to the
   * lines as a line `tables`: evidence of which rules matched.
   */
  tables(node: string, pid: number, table: string): Promise<string>;
  /**
   * This method runs commands of the injector of the harness in the network namespace of a PID. Each
   * command is a sysctl or a rule of iptables, in sequence. It stops at the first command that fails. Each word of
   * a command is plain: letters, digits and `_ . , : = / + -`. The method adds the commands and their
   * output to the lines as a line `act`, and gives the output.
   */
  netns(node: string, pid: number, commands: ReadonlyArray<readonly string[]>): Promise<string>;
  now(): Promise<number>;
  pidOf(node: string, namespace: string, pod: string, container: string): Promise<number>;
  netnsOf(node: string, pid: number): Promise<number>;
  /** This method gives the path of the cgroup of a process, as the agent reaches it through the root of the node. */
  cgroupOf(node: string, pid: number): Promise<string>;
  /**
   * This method deletes the conntrack entries in SYN_SENT to a ClusterIP and port on each node, and
   * gives the count of each node. Such an entry is a SYN with no answer. It keeps its NAT for 120 s,
   * and a new SYN from the same port goes where it went.
   */
  forgetHandshakes(ip: string, port: number): Promise<Record<string, number>>;
  close(): Promise<void>;
}

/** This container class can share the process namespace of another container. */
const shared = async () => {
  const { GenericContainer } = await import("testcontainers");
  return class extends GenericContainer {
    withPidMode(mode: string): this {
      (this as unknown as { hostConfig: { PidMode?: string } }).hostConfig.PidMode = mode;
      return this;
    }
  };
};

/** This function collects the JSON lines of a stream, and gives each one to `take`. */
const consume = (take: (line: Record<string, unknown>) => void) => (stream: NodeJS.ReadableStream) => {
  let partial = "";
  stream.on("data", (chunk: Buffer | string) => {
    partial += chunk.toString();
    const split = partial.split("\n");
    partial = split.pop() ?? "";
    for (const text of split) {
      const trimmed = text.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        take(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // a line that is not whole JSON is not a record
      }
    }
  });
};

/** This function gives a stamp of the injector of the harness, in nanoseconds, as milliseconds. */
const injectorStamp = (stdout: string): Stamp => {
  const stamp = JSON.parse(stdout.trim().split("\n").at(-1)!) as { t0: number | string; t1: number | string };
  return { t0: Number(BigInt(stamp.t0)) / 1e6, t1: Number(BigInt(stamp.t1)) / 1e6 };
};

const output = async (container: StartedTestContainer, argv: readonly string[]): Promise<string> => {
  const result = await container.exec([...argv]);
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.output.trim().slice(0, 500)}`);
  return result.stdout;
};

/**
 * This function opens the instruments of a cluster. Each node gets the agent of the lab and the
 * injector of the harness, privileged and in the PID namespace of the node. Thus the agent signals
 * a process of a pod by its PID on the node. The injector enters the network namespace of a pod
 * with `nsenter`.
 */
export const openKindLab = async (cluster: Cluster, image: string): Promise<KindLab> => {
  const harness = await harnessImage();
  const Shared = await shared();
  const { GenericContainer } = await import("testcontainers");
  let lines: Line[] = [];
  const dropped: Record<string, number> = {};
  const listeners = new Set<(line: Line) => void>();
  const push = (line: Line): void => {
    lines.push(line);
    for (const listener of listeners) listener(line);
  };
  const sidecars = new Map<string, Sidecars>();
  const opened: StartedTestContainer[] = [];
  let watcher: StartedTestContainer | null = null;
  let prober: StartedTestContainer | null = null;
  try {
    for (const node of cluster.nodes) {
      const agent = await new Shared(image)
        .withPidMode(`container:${node}`)
        .withPrivilegedMode()
        .withNetworkMode("none")
        .withEnvironment({ NODE_NAME: node })
        .withCommand(["node", "agent.mjs", "serve"])
        .withLogConsumer(consume((line) => push({ ...(line as unknown as Line), node })))
        .start();
      opened.push(agent);
      const injector = await new Shared(harness)
        .withPidMode(`container:${node}`)
        .withPrivilegedMode()
        .withNetworkMode("none")
        .start();
      opened.push(injector);
      sidecars.set(node, { agent, injector });
    }
  } catch (error) {
    for (const container of opened.reverse()) await container.stop({ timeout: 0 }).catch(() => undefined);
    throw error;
  }
  const sidecarOf = (node: string): Sidecars => {
    const found = sidecars.get(node);
    if (found === undefined) throw new Error(`the cluster has no node ${node}`);
    return found;
  };
  const firstNode = cluster.nodes[0]!;
  /**
   * This function writes the file of the pollers of one kind on each agent: `fields`, the interval
   * and the pods of its node. A node without a pod, or a spec of null, gets no file.
   */
  const pollersOf = async (
    kind: "eds" | "lds",
    fields: Readonly<Record<string, unknown>> | null,
    spec: { readonly every: Quantity; readonly pods: LdsSpec["pods"] } | null,
  ): Promise<void> => {
    for (const [node, { agent }] of sidecars) {
      const pods = spec === null ? [] : spec.pods.filter((pod) => pod.node === node).map(({ pod, pid }) => ({ pod, pid }));
      // the agent reads the interval of its poll in milliseconds
      const file = spec === null || pods.length === 0 ? null : JSON.stringify({ ...fields, every: valueIn(spec.every, "ms"), pods });
      if (file === null) await output(agent, ["rm", "-f", `/tmp/${kind}.json`]);
      // a rename is atomic, thus the agent never reads a part of the file
      else await output(agent, ["sh", "-c", `printf '%s' '${file}' > /tmp/${kind}.json.partial && mv /tmp/${kind}.json.partial /tmp/${kind}.json`]);
    }
  };
  const lab: KindLab = {
    cluster,
    image,
    get lines() {
      return lines;
    },
    dropped,
    own() {
      return [...opened, ...(watcher === null ? [] : [watcher]), ...(prober === null ? [] : [prober])].map((container) => container.getName().replace(/^\//, ""));
    },
    take() {
      const out = lines;
      lines = [];
      return out;
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async watch(namespaces, options) {
      if (watcher !== null) await watcher.stop({ timeout: 0 }).catch(() => undefined);
      const kube = await cluster.credentials();
      watcher = await new GenericContainer(image)
        .withNetworkMode(cluster.network)
        .withEnvironment({ KUBE: JSON.stringify(kube), NAMESPACES: namespaces.join(","), ZTUNNEL: options?.ztunnel === true ? "1" : "0" })
        .withCommand(["node", "watch.mjs"])
        .withLogConsumer(consume((line) => push(line as unknown as Line)))
        .start();
    },
    async probe(netns) {
      await lab.stopProbe();
      let begun: (ok: boolean, why: string) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => {
        begun = (ok, why) => (ok ? resolve() : reject(new Error(`the prober failed: ${why}`)));
      });
      prober = await new GenericContainer(harness)
        .withPrivilegedMode()
        .withNetworkMode("none")
        .withCommand(["/opt/harness/prober", ...netns.map(String)])
        .withLogConsumer(
          consume((record) => {
            const ev = String(record["ev"]);
            if (ev === "begin") begun(true, "");
            if (ev === "fail") begun(false, String(record["why"]));
            if (!keptKernel(record) && ev !== "clock") {
              dropped[ev] = (dropped[ev] ?? 0) + 1;
              return;
            }
            const mono = Number(record["mono"] ?? 0);
            push({ ...(record as unknown as Line), ev: `kernel.${ev}`, t: mono / 1e6 });
          }),
        )
        .start();
      await Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error("no begin line from the prober in 60 s")), 60_000)),
      ]);
    },
    async stopProbe() {
      if (prober !== null) await prober.stop({ timeout: 0 }).catch(() => undefined);
      prober = null;
    },
    async rules(rule) {
      // the agent reads the interval of its poll in milliseconds
      const file = rule === null ? null : JSON.stringify({ ...rule, every: valueIn(rule.every, "ms") });
      for (const { agent } of sidecars.values()) {
        if (file === null) await output(agent, ["rm", "-f", "/tmp/rules.json"]);
        else await output(agent, ["sh", "-c", `printf '%s' '${file}' > /tmp/rules.json`]);
      }
    },
    async eds(spec) {
      await pollersOf("eds", spec === null ? null : { cluster: spec.cluster }, spec);
    },
    async lds(spec) {
      await pollersOf("lds", {}, spec);
    },
    async forgetHandshakes(ip, port) {
      const out: Record<string, number> = {};
      for (const [node, { agent }] of sidecars) {
        const argv = ["nsenter", "-t", "1", "-m", "-n", "--", "conntrack", "-D", "-p", "tcp", "--orig-dst", ip, "--dport", String(port), "--state", "SYN_SENT"];
        // the tool writes its count to stderr, and exits 1 when it deletes no entry
        const result = await agent.exec(argv);
        if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.output.trim().slice(0, 300)}`);
        out[node] = deletedOf(result.output);
      }
      return out;
    },
    async act(node, spec) {
      const stdout = await output(sidecarOf(node).agent, ["node", "agent.mjs", "act", JSON.stringify(spec)]);
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as { ok: boolean; t0: number; t1: number; why?: string };
      if (!result.ok) throw new Error(`the act ${JSON.stringify(spec)} on ${node} failed: ${result.why}`);
      push({ ev: "act", t: result.t0, t1: result.t1, node, spec });
      return { t0: result.t0, t1: result.t1 };
    },
    async inject(node, pid, args) {
      const stdout = await output(sidecarOf(node).injector, ["nsenter", "-t", String(pid), "-n", "/opt/harness/inject", ...args]);
      const stamp = injectorStamp(stdout);
      push({ ev: "act", t: stamp.t0, t1: stamp.t1, node, spec: { op: "inject", pid, args } });
      return stamp;
    },
    async tables(node, pid, table) {
      const t = await lab.now();
      const text = await output(sidecarOf(node).injector, ["nsenter", "-t", String(pid), "-n", "iptables-save", "-c", "-t", table]);
      push({ ev: "tables", t, node, pid, table, text: text.slice(0, 8000) });
      return text;
    },
    async netns(node, pid, commands) {
      // the words go to a shell as they are, thus each one is plain
      for (const word of commands.flat()) if (!/^[A-Za-z0-9_.,:=/+-]+$/.test(word)) throw new Error(`not a plain word of a command: ${word}`);
      if (commands.length === 0) throw new Error("no command");
      const t = await lab.now();
      const text = await output(sidecarOf(node).injector, ["nsenter", "-t", String(pid), "-n", "sh", "-c", commands.map((argv) => argv.join(" ")).join(" && ")]);
      push({ ev: "act", t, t1: await lab.now(), node, spec: { op: "netns", pid, commands }, out: text.slice(0, 2000) });
      return text;
    },
    async now() {
      return (await lab.act(firstNode, { op: "now" })).t0;
    },
    async pidOf(node, namespace, pod, container) {
      const ids = (
        await cluster.exec(node, [
          "crictl",
          "ps",
          "-q",
          "--state",
          "running",
          "--label",
          `io.kubernetes.pod.namespace=${namespace}`,
          "--label",
          `io.kubernetes.pod.name=${pod}`,
          "--name",
          `^${container}$`,
        ])
      )
        .split(/\s+/)
        .filter((id) => id !== "");
      if (ids.length !== 1) throw new Error(`${namespace}/${pod}/${container} on ${node} has ${ids.length} running containers, not 1`);
      const info = JSON.parse(await cluster.exec(node, ["crictl", "inspect", ids[0]!])) as { info?: { pid?: number } };
      const pid = info.info?.pid;
      if (pid === undefined || !(pid > 1)) throw new Error(`crictl gives no PID for ${namespace}/${pod}/${container}`);
      return pid;
    },
    async netnsOf(node, pid) {
      const link = (await cluster.exec(node, ["readlink", `/proc/${pid}/ns/net`])).trim();
      const inode = /^net:\[(\d+)\]$/.exec(link)?.[1];
      if (inode === undefined) throw new Error(`not a network namespace: ${link}`);
      return Number(inode);
    },
    async cgroupOf(node, pid) {
      const text = (await cluster.exec(node, ["cat", `/proc/${pid}/cgroup`])).trim();
      const path = /^0::(\S+)$/m.exec(text)?.[1];
      // an empty or a short path is the root of the node: a write there throttles or freezes each pod of the node
      if (path === undefined || !/\/cri-containerd-[0-9a-f]{64}\.scope$/.test(path))
        throw new Error(`the cgroup of ${pid} on ${node} is not the scope of one container: ${text}`);
      return `/proc/1/root/sys/fs/cgroup${path}`;
    },
    async close() {
      await lab.stopProbe();
      if (watcher !== null) await watcher.stop({ timeout: 0 }).catch(() => undefined);
      watcher = null;
      for (const container of opened.reverse()) await container.stop({ timeout: 0 }).catch(() => undefined);
    },
  };
  return lab;
};

/** This function pins a Docker image by digest under a local tag that holds the digest, for `kind load` and `imagePullPolicy: Never`. */
export const localPin = async (image: string): Promise<string> => {
  const match = /^([^@]+?)(?::([^@:/]+))?@sha256:([0-9a-f]{64})$/.exec(image);
  if (match === null) throw new Error(`${image} is not pinned by a digest`);
  const [, repository, tag, digest] = match;
  const local = `systems-lab/${repository!.split("/").at(-1)}:${tag ?? "pinned"}-${digest!.slice(0, 12)}`;
  const present = await command("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", `${repository}@sha256:${digest}`]).catch(() => "");
  if (!present.includes(digest!)) await command("docker", ["pull", `${repository}@sha256:${digest}`], { timeout: 900_000 });
  await command("docker", ["tag", `${repository}@sha256:${digest}`, local]);
  return local;
};
