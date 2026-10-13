import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import type * as Testcontainers from "testcontainers";
import type { Client, KernelRecord, ProbeEvent, Target } from "./cell.ts";

/**
 * These are the roots of the two packages that the images read: this package, and the prober
 * that Node resolves for it. In a workspace, they are two folders side by side. From npm, the
 * prober is a link, and a Docker build context does not follow a link. Thus each image builds
 * from a context that the harness copies from the two roots.
 */
const ROOTS: Readonly<Record<string, string>> = {
  harness: fileURLToPath(new URL("..", import.meta.url)),
  prober: dirname(
    realpathSync(createRequire(import.meta.url).resolve("@mark1russell7/prober/package.json")),
  ),
};

/** This function gives the path of a part of an image, which is `<package>/<path>` in the context. */
const pathOf = (part: string): string => {
  const [root, ...rest] = part.split("/");
  const base = ROOTS[root!];
  if (base === undefined) throw new Error(`${part} is in no package that the images read`);
  return join(base, ...rest);
};

/** This function loads Testcontainers when a lab first opens. Code that only measures and judges does not load it. */
const containers = (): Promise<typeof Testcontainers> => import("testcontainers");

/** An image is an image that the harness builds: its Dockerfile, and each file or folder that the Dockerfile reads. */
interface Image {
  readonly name: string;
  readonly dockerfile: string;
  readonly from: readonly string[];
}

/** This image holds the prober, the TCP client, the injector and the namespace admin. */
const HARNESS: Image = {
  name: "loom-harness",
  dockerfile: "harness/image/Dockerfile",
  from: [
    "harness/image/Dockerfile",
    "harness/image/native",
    "prober/bpf",
    "prober/native",
    "prober/fixtures",
  ],
};
/** This image holds the Node client: ioredis 6.0.0 on Node 24.21.0. */
const NODE: Image = {
  name: "loom-harness-node",
  dockerfile: "harness/image/node/Dockerfile",
  from: ["harness/image/node"],
};

/** This function gives each file under a path, in a stable sequence, but not the output of a local build. */
const sources = (path: string): string[] => {
  if (statSync(path).isFile()) return [path];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.name !== "target" && entry.name !== "node_modules")
    .flatMap((entry) => sources(join(path, entry.name)))
    .sort();
};

/** This function gives each file of an image, with its path in the build context. */
const filesOf = (image: Image): Array<{ readonly file: string; readonly at: string }> =>
  image.from.flatMap((part) => {
    const base = pathOf(part);
    return sources(base).map((file) => ({
      file,
      at: join(part, relative(base, file)).replaceAll("\\", "/"),
    }));
  });

/** This function gives the tag of an image from its content. Thus a changed probe or client cannot operate as an old one. */
const imageTag = (image: Image): string => {
  const hash = createHash("sha256");
  for (const { file, at } of filesOf(image)) {
    hash.update(at);
    hash.update(readFileSync(file));
  }
  return `${image.name}:${hash.digest("hex").slice(0, 12)}`;
};

/** This function copies the files of an image into a new build context, and gives its path. */
const stage = (image: Image): string => {
  const context = mkdtempSync(join(tmpdir(), `${image.name}-`));
  for (const { file, at } of filesOf(image)) {
    mkdirSync(dirname(join(context, at)), { recursive: true });
    copyFileSync(file, join(context, at));
  }
  return context;
};

const built = new Map<string, Promise<string>>();
/** This function builds an image one time for each process. Docker keeps its layers between runs. */
const build = (image: Image): Promise<string> => {
  let tag = built.get(image.name);
  if (tag === undefined) {
    tag = (async () => {
      const name = imageTag(image);
      const { GenericContainer } = await containers();
      const context = stage(image);
      try {
        await GenericContainer.fromDockerfile(context, image.dockerfile).build(name, {
          deleteOnExit: false,
        });
      } finally {
        rmSync(context, { recursive: true, force: true });
      }
      return name;
    })();
    built.set(image.name, tag);
  }
  return tag;
};

/** This function gives the image of the harness. */
export const harnessImage = (): Promise<string> => build(HARNESS);
/** This function gives the image of the Node client. */
export const nodeClientImage = (): Promise<string> => build(NODE);

/** A network fault is a fault that the injector applies, by the name of its manifestation. */
export type NetworkFault = "blackhole" | "rst";

/**
 * A fault side is the namespace that gets the rules of a fault: the namespace of the peer of the
 * observer. For the client, it is the namespace of the target (the injector). For the server, it
 * is the namespace of the client (its privileged admin). Rules in the namespace of the observer
 * make its sends fail locally, with EPERM, and the network does not lose them. Thus its
 * retransmissions do not go out. The retransmission tracepoint of the kernel then records none,
 * because it fires only for a retransmission that went out.
 */
export type FaultSide = "target" | "client";

/** A manifest is what a lab records about its machine, its images and its settings. */
export interface Manifest {
  readonly kernel: string;
  /** This text is the architecture of the machine, as uname -m gives it: x86_64. */
  readonly architecture: string;
  readonly hz: string | null;
  readonly boot_id: string;
  readonly docker: string;
  /** This record is the target, and its settings as it read them back. */
  readonly target: {
    readonly image: string;
    readonly id: string;
    readonly settings: Readonly<Record<string, string>>;
    /** These are the sysctls of its namespace, as read back after the harness set them. */
    readonly sysctls: Readonly<Record<string, string>>;
  };
  readonly harness: { readonly image: string; readonly id: string; readonly packages: string[] };
  /** This record is the client of each run: the TCP client of the harness, or a driver from its own image. */
  readonly client: { readonly kind: Client; readonly image: string };
  /** These are the namespaces that the prober watched, by inode. */
  readonly netns: { readonly client: number; readonly target: number };
  /** These are the sysctls of the client namespace, as read back after the harness set them. */
  readonly sysctls: Readonly<Record<string, string>>;
}

/** These are the JSON lines of a program, as they arrive. */
interface Lines<T extends { readonly ev: string }> {
  readonly seen: T[];
  /** These are the other lines that it wrote, for example an error. They explain a program that stopped its output. */
  readonly other: string[];
  consume: (stream: NodeJS.ReadableStream) => void;
  /** This method gives the first line of one of these kinds, or it rejects after `within` ms. */
  until(kinds: readonly string[], within: number, who: string): Promise<T>;
}

const lines = <T extends { readonly ev: string }>(): Lines<T> => {
  const seen: T[] = [];
  const other: string[] = [];
  const waiting: Array<{ kinds: readonly string[]; resolve: (line: T) => void }> = [];
  let partial = "";
  const take = (text: string) => {
    if (!text.startsWith("{")) {
      if (text.length > 0) other.push(text);
      return;
    }
    const line = JSON.parse(text) as T;
    seen.push(line);
    for (const wait of waiting.splice(0)) {
      if (wait.kinds.includes(line.ev)) wait.resolve(line);
      else waiting.push(wait);
    }
  };
  return {
    seen,
    other,
    consume: (stream) =>
      stream.on("data", (chunk: Buffer | string) => {
        partial += chunk.toString();
        const split = partial.split("\n");
        partial = split.pop() ?? "";
        for (const text of split) take(text.trim());
      }),
    until(kinds, within, who) {
      const found = seen.find((line) => kinds.includes(line.ev));
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const said = other.length === 0 ? "" : `; it wrote: ${other.slice(-3).join(" | ")}`;
          reject(new Error(`no ${kinds.join(" or ")} from the ${who} in ${within} ms${said}`));
        }, within);
        waiting.push({
          kinds,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
  };
};

/** A probe is the client container of one run. */
export interface Probe {
  /** This method gives the first event of one of these kinds, or it rejects after `within` ms. */
  until(kinds: readonly string[], within: number): Promise<ProbeEvent>;
  /** This method lets an in-flight probe send its request. */
  go(): Promise<void>;
  /** This method freezes the client with the cgroup freezer: its process stops, and its kernel continues to answer. */
  freeze(): Promise<void>;
  thaw(): Promise<void>;
  readonly events: readonly ProbeEvent[];
  stop(): Promise<void>;
}

/** A lab is one environment: the target, the client, the injector and the prober. */
export interface Lab {
  readonly targetIp: string;
  readonly clientIp: string;
  readonly netns: { readonly client: number; readonly target: number };
  /** These are all the records that the prober wrote, in sequence. */
  readonly kernel: readonly KernelRecord[];
  /** This method sets the sysctls of the client namespace through its privileged sidecar, and reads them back. */
  sysctl(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /** This method sets the settings of the target in it before a client connects, and reads them back. */
  configure(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /** This method sets the sysctls of the target namespace through a privileged sidecar there, and reads them back. */
  targetSysctl(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /**
   * This method applies a fault between the client and the target, from the namespace of the
   * target. The fault is a black hole, or a reset that answers the next segment of the client. The stamps of
   * the injector bracket it.
   */
  fault(kind: NetworkFault, at?: FaultSide): Promise<{ t0: number; t1: number }>;
  /** This method removes a fault. */
  lift(kind: NetworkFault, at?: FaultSide): Promise<void>;
  /**
   * This method stops a black hole at an instant on the monotonic clock of the VM. The injector
   * waits for that instant in the VM, thus the length of a stall does not include the latency of
   * a docker exec. Stamps bracket it, as for a fault.
   */
  heal(at: FaultSide, when: number): Promise<{ t0: number; t1: number }>;
  /**
   * This method removes what the two kernels learned from their earlier connections. These are
   * the TCP metrics that each kernel keeps for a peer address when a connection closes. These metrics set the
   * first round trip of the next connection, and thus its RTO. A run with these metrics is not
   * independent of the run before it.
   */
  forget(): Promise<void>;
  /** This method freezes the target with the cgroup freezer: its process stops, and its kernel continues to answer. */
  freeze(): Promise<void>;
  thaw(): Promise<void>;
  probe(args: readonly string[]): Promise<Probe>;
  /**
   * This method waits for the next clock line of the prober, which gives the count of lost
   * records. It gives null when no clock line comes in 5 s, because then nothing tells the count.
   */
  settle(): Promise<number | null>;
  manifest(
    sysctls: Readonly<Record<string, string>>,
    settings?: Readonly<Record<string, string>>,
    targetSysctls?: Readonly<Record<string, string>>,
  ): Promise<Manifest>;
  close(): Promise<void>;
}

// each container here is a holder, a probe or the prober: nothing drains, thus the stop is immediate
const STOP = { timeout: 0 };

const output = async (container: StartedTestContainer, argv: string[]): Promise<string> => {
  const result = await container.exec(argv);
  if (result.exitCode !== 0)
    throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.output.trim()}`);
  return result.stdout.trim();
};

/** This function gives the inode of the network namespace of a container: net:[4026532583]. */
const netnsOf = async (container: StartedTestContainer): Promise<number> => {
  const link = await output(container, ["readlink", "/proc/self/ns/net"]);
  const inode = /^net:\[(\d+)\]$/.exec(link)?.[1];
  if (inode === undefined) throw new Error(`not a network namespace: ${link}`);
  return Number(inode);
};

/**
 * This function opens one environment:
 * - a new network and the stock target.
 * - a client that holds its own network namespace, with a privileged sidecar in it for its
 *   sysctls. Docker Desktop keeps /proc/sys read-only in a container that operates.
 * - an injector sidecar in the namespace of the target.
 * - the prober, a privileged container that loads the kernel program and watches the two
 *   namespaces.
 *
 * The client of each run is its own container in the namespace of the client. It is the TCP
 * client of the harness, or a driver from its own image (ioredis on Node). The two print the same
 * lines.
 */
export const openLab = async (target: Target, kind: Client = "tcp"): Promise<Lab> => {
  const image = await harnessImage();
  const clientImage = kind === "ioredis" ? await nodeClientImage() : image;
  const command =
    kind === "ioredis" ? ["node", "/opt/harness/node/client-ioredis.mjs"] : ["/opt/harness/client"];
  const { GenericContainer, Network, Wait, getContainerRuntimeClient } = await containers();
  const opened: StartedTestContainer[] = [];
  let network: StartedNetwork | undefined;
  const close = async () => {
    for (const container of opened.reverse()) await container.stop(STOP).catch(() => undefined);
    await network?.stop().catch(() => undefined);
  };
  try {
    network = await new Network().start();
    const server = await new GenericContainer(target.image)
      .withNetwork(network)
      .withWaitStrategy(Wait.forLogMessage(target.ready))
      .start();
    opened.push(server);
    const client = await new GenericContainer(image).withNetwork(network).start();
    opened.push(client);
    const admin = await new GenericContainer(image)
      .withNetworkMode(`container:${client.getId()}`)
      .withPrivilegedMode()
      .start();
    opened.push(admin);
    const injector = await new GenericContainer(image)
      .withNetworkMode(`container:${server.getId()}`)
      .withAddedCapabilities("NET_ADMIN", "NET_RAW")
      .start();
    opened.push(injector);
    const netns = { client: await netnsOf(admin), target: await netnsOf(injector) };
    const records = lines<KernelRecord>();
    const prober = await new GenericContainer(image)
      .withPrivilegedMode()
      .withNetworkMode("none")
      .withCommand(["/opt/harness/prober", String(netns.client), String(netns.target)])
      .withLogConsumer(records.consume)
      .start();
    opened.push(prober);
    const begun = await records.until(["begin", "fail"], 30_000, "prober");
    if (begun.ev === "fail") throw new Error(`the prober failed: ${String(begun["why"])}`);
    const targetIp = server.getIpAddress(network.getName());
    const clientIp = client.getIpAddress(network.getName());
    const runtime = await getContainerRuntimeClient();
    const paused = runtime.container.getById(server.getId());
    let targetAdmin: StartedTestContainer | undefined;

    return {
      targetIp,
      clientIp,
      netns,
      kernel: records.seen,
      async sysctl(values) {
        const settings = Object.entries(values).map(([key, value]) => `${key}=${value}`);
        if (settings.length > 0) await output(admin, ["sysctl", "-q", "-w", ...settings]);
        const read: Record<string, string> = {};
        for (const key of Object.keys(values))
          read[key] = await output(admin, ["sysctl", "-n", key]);
        return read;
      },
      async targetSysctl(values) {
        const read: Record<string, string> = {};
        if (Object.keys(values).length === 0) return read;
        // privileged, and only when a cell asks for it: otherwise the namespace of the target stays as it is
        targetAdmin ??= await new GenericContainer(image)
          .withNetworkMode(`container:${server.getId()}`)
          .withPrivilegedMode()
          .start();
        opened.push(targetAdmin);
        const settings = Object.entries(values).map(([key, value]) => `${key}=${value}`);
        await output(targetAdmin, ["sysctl", "-q", "-w", ...settings]);
        for (const key of Object.keys(values))
          read[key] = await output(targetAdmin, ["sysctl", "-n", key]);
        return read;
      },
      async configure(values) {
        const read: Record<string, string> = {};
        if (Object.keys(values).length === 0) return read;
        const how = target.settings;
        if (how === undefined) throw new Error(`${target.image} names no way to set its settings`);
        for (const [name, value] of Object.entries(values)) {
          await output(server, [...how.set, name, value]);
          read[name] = (await output(server, [...how.get, name])).split("\n").at(-1) ?? "";
        }
        return read;
      },
      async fault(kind, at = "target") {
        const [where, peer] = at === "client" ? [admin, targetIp] : [injector, clientIp];
        const stamp = JSON.parse(await output(where, ["/opt/harness/inject", kind, peer])) as {
          t0: number;
          t1: number;
        };
        return { t0: stamp.t0, t1: stamp.t1 };
      },
      async lift(kind, at = "target") {
        const [where, peer] = at === "client" ? [admin, targetIp] : [injector, clientIp];
        const action = kind === "blackhole" ? "clear" : "clear-rst";
        await output(where, ["/opt/harness/inject", action, peer]);
      },
      async heal(at, when) {
        const [where, peer] = at === "client" ? [admin, targetIp] : [injector, clientIp];
        const args = ["/opt/harness/inject", "clear", peer, "--at", String(Math.round(when))];
        const stamp = JSON.parse(await output(where, args)) as { t0: number; t1: number };
        return { t0: stamp.t0, t1: stamp.t1 };
      },
      async forget() {
        await output(admin, ["ip", "tcp_metrics", "flush", "all"]);
        await output(injector, ["ip", "tcp_metrics", "flush", "all"]);
      },
      freeze: () => paused.pause().then(() => undefined),
      thaw: () => paused.unpause().then(() => undefined),
      async probe(args) {
        const events = lines<ProbeEvent>();
        const container = await new GenericContainer(clientImage)
          .withNetworkMode(`container:${client.getId()}`)
          .withCommand([...command, ...args])
          .withLogConsumer(events.consume)
          .start();
        return {
          events: events.seen,
          until: (kinds, within) => events.until(kinds, within, "client"),
          go: () => output(container, ["touch", "/tmp/go"]).then(() => undefined),
          freeze: () =>
            runtime.container
              .getById(container.getId())
              .pause()
              .then(() => undefined),
          thaw: () =>
            runtime.container
              .getById(container.getId())
              .unpause()
              .then(() => undefined),
          stop: () => container.stop(STOP).then(() => undefined),
        };
      },
      async settle() {
        // the prober drains its ring each 20 ms, and it writes a clock line each second
        const after = records.seen.length;
        const clock = await new Promise<KernelRecord | null>((resolve) => {
          const started = Date.now();
          const look = () => {
            const line = records.seen.slice(after).find((record) => record.ev === "clock");
            if (line !== undefined) resolve(line);
            else if (Date.now() - started > 5_000) resolve(null);
            else setTimeout(look, 50);
          };
          look();
        });
        return clock === null ? null : Number(clock["lost"] ?? 0);
      },
      async manifest(sysctls, settings = {}, targetSysctls = {}) {
        const config = await output(admin, ["zcat", "/proc/config.gz"]).catch(() => "");
        const inspect = async (container: StartedTestContainer) =>
          runtime.container.inspect(runtime.container.getById(container.getId()));
        return {
          kernel: await output(client, ["uname", "-r"]),
          architecture: await output(client, ["uname", "-m"]),
          hz: /^CONFIG_HZ=(\d+)$/m.exec(config)?.[1] ?? null,
          boot_id: await output(client, ["cat", "/proc/sys/kernel/random/boot_id"]),
          docker: `${runtime.info.containerRuntime.serverVersion} on ${runtime.info.containerRuntime.operatingSystem}`,
          target: {
            image: target.image,
            id: (await inspect(server)).Image,
            settings,
            sysctls: targetSysctls,
          },
          harness: {
            image,
            id: (await inspect(client)).Image,
            packages: (await output(client, ["apk", "info", "-v"])).split("\n").sort(),
          },
          client: { kind, image: clientImage },
          netns,
          sysctls,
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
};
