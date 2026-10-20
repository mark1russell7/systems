import { createHash } from "node:crypto";
import type { StartedNetwork, StartedTestContainer } from "testcontainers";
import type * as Testcontainers from "testcontainers";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { isHopPlace } from "./cell.ts";
import type {
  Client,
  ClientImage,
  FaultPlace,
  Hop,
  HopEvent,
  HopPlace,
  ImageSource,
  KernelRecord,
  MiddleboxEvent,
  ProbeEvent,
  ProxyHop,
  RunTopology,
  Target,
  Topology,
  Toxic,
} from "./cell.ts";
import { SHIPPED_CLIENTS, harnessImage, imageOf, routerImage, targetImageOf } from "./image.ts";

/** This function loads Testcontainers when a lab first opens. Code that only measures and judges does not load it. */
export const containers = (): Promise<typeof Testcontainers> => import("testcontainers");

/**
 * This time is the interval of the listing of a router, when its hop does not set one. A listing
 * evicts each expired flow that it walks past, and the DESTROY event of that flow follows.
 */
export const PUMP: Quantity = { value: 0.1, unit: "s" };
/**
 * This time is the longest listing of the conntrack table of a router that a prediction assumes.
 * A DESTROY follows an expiry within the interval of the pump and two listings. On 2026-10-15,
 * the slowest of 500 listings in an idle router took 19.4 ms, and the median took 5.5 ms. A
 * longer listing writes a `pump-slow` line, and a run with one near its detection is void.
 */
export const LISTING: Quantity = { value: 20, unit: "ms" };
/**
 * This time is how late the pump of a router can be beyond its interval and its two listings. The
 * pump sleeps after each listing, and the sleep can end late. The watcher also reads and stamps each
 * event within a millisecond. Thus a DESTROY follows an expiry within the interval of the pump, two
 * listings and this slack. It is an assumption: in run 39116866471, two of 11 forgets came 1.6 ms
 * and 2.2 ms after the pump and two listings.
 */
export const PUMP_SLACK: Quantity = { value: 5, unit: "ms" };

/** This count is how many of the last lines of a proxy hop the lab keeps. The error of a hop that does not start gives them. */
const TAIL_LINES = 60;

/** This count is how many lines of the output of a proxy hop the lab keeps, for a write that the proxy confirms. */
const OUTPUT_LINES = 2000;

/** This time is how long a write of a hop waits for the line that confirms it, in milliseconds. */
const CONFIRM_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A network fault is a fault that the injector applies as a filter rule. It is a black hole (both
 * directions, or one), or a reset on the next segment. It can also be an ICMP unreachable for each
 * segment, or a drop of each segment that is longer than a length.
 */
export type NetworkFault = "blackhole" | "rst" | "reject" | "mtu";

/** These are the options of a network fault: the direction of a black hole, the code of a reject, the length of an MTU drop. */
export interface FaultOptions {
  /** This direction is relative to the namespace of the rule: `in` drops what comes from the peer, `out` what goes to it. */
  readonly direction?: "in" | "out";
  readonly code?: "host" | "net" | "port" | "admin";
  /** This length is the longest segment in bytes that an MTU drop lets through. */
  readonly above?: number;
}

/** This function gives the arguments of the injector for the options of a fault. */
export const optionArgs = (options: FaultOptions): string[] => [
  ...(options.direction === undefined ? [] : ["--direction", options.direction]),
  ...(options.code === undefined ? [] : ["--code", options.code]),
  ...(options.above === undefined ? [] : ["--above", String(options.above)]),
];

/** These are the actions of the injector that lift each network fault. */
export const LIFT: Readonly<Record<NetworkFault, string>> = {
  blackhole: "clear",
  rst: "clear-rst",
  reject: "clear-reject",
  mtu: "clear-mtu",
};

/**
 * A fault side is the namespace that gets the rules of a fault: the namespace of the peer of the
 * observer. For the client, it is the namespace of the target (the injector). For the server, it
 * is the namespace of the client (its privileged admin). Rules in the namespace of the observer
 * make its sends fail locally, with EPERM, and the network does not lose them. Thus its
 * retransmissions do not go out. The retransmission tracepoint of the kernel then records none,
 * because it fires only for a retransmission that went out.
 */
export type FaultSide = "target" | "client";

/** A hop of a manifest is one hop of a topology, as the lab started it. */
export interface ManifestHop {
  readonly name: string;
  readonly kind: "router" | "proxy";
  readonly image: string;
  readonly id: string;
  /** These are the settings of the hop: the form and the idle timeout of a router, the files and settings of a proxy. */
  readonly settings: Readonly<Record<string, string>>;
  /** These are the sysctls of the namespace of the hop, as read back after the harness set them. */
  readonly sysctls: Readonly<Record<string, string>>;
}

/** A manifest is what a lab records about its machine, its images and its settings. */
export interface Manifest {
  readonly kernel: string;
  /** This text is the architecture of the machine, as uname -m gives it: x86_64. */
  readonly architecture: string;
  readonly hz: string | null;
  /**
   * This text tells where the HZ came from: the configuration of the kernel, or a measurement. A
   * host without /proc/config.gz (a hosted runner) gets a measurement of jiffies against the clock.
   */
  readonly hzFrom?: "config" | "measured";
  readonly boot_id: string;
  readonly docker: string;
  /** This record is the target, and its settings as it read them back. */
  readonly target: {
    readonly image: string;
    /** This source is the image of the subject that the target operates (`Target.subject`), with its stock base. */
    readonly subject?: ImageSource;
    /** This name is the image of the harness that the target operates, with its stock base (`Target.harness`). */
    readonly harness?: string;
    readonly base?: string;
    readonly id: string;
    readonly settings: Readonly<Record<string, string>>;
    /** These are the sysctls of its namespace, as read back after the harness set them. */
    readonly sysctls: Readonly<Record<string, string>>;
    /** These are the files that went into the target, by their path, each with the sha256 of its content. */
    readonly files?: Readonly<Record<string, string>>;
    /** This line is the first line of a target that writes them: a server that tells its settings as it reads them. */
    readonly first?: ProbeEvent;
  };
  readonly harness: { readonly image: string; readonly id: string; readonly packages: string[] };
  /**
   * This record is the client of each run: the TCP client of the harness, a driver, or an image that
   * the cell gives. `source` is the source of its image, when it is not a stock image by its name.
   */
  readonly client: { readonly kind: Client | "image"; readonly image: string; readonly source?: ImageSource };
  /** These are the namespaces that the prober watched, by inode. */
  readonly netns: {
    readonly client: number;
    readonly target: number;
    readonly hops?: Readonly<Record<string, number>>;
  };
  /** These are the sysctls of the client namespace, as read back after the harness set them. */
  readonly sysctls: Readonly<Record<string, string>>;
  /** These are the hops of a topology, in sequence from the client. */
  readonly hops?: readonly ManifestHop[];
  /** These are the parts of a group, with their settings as each part read them back. */
  readonly group?: {
    readonly members: ReadonlyArray<{ readonly name: string; readonly ip: string; readonly id: string; readonly settings: Readonly<Record<string, string>> }>;
    readonly sentinels: ReadonlyArray<{ readonly name: string; readonly ip: string; readonly id: string; readonly settings: Readonly<Record<string, string>> }>;
    readonly observer: { readonly image: string };
  };
}

/** These are the JSON lines of a program, as they arrive. */
export interface Lines<T extends { readonly ev: string }> {
  readonly seen: T[];
  /** These are the other lines that it wrote, for example an error. They explain a program that stopped its output. */
  readonly other: string[];
  consume: (stream: NodeJS.ReadableStream) => void;
  /** This method gives the first line of one of these kinds, or it rejects after `within` ms. */
  until(kinds: readonly string[], within: number, who: string): Promise<T>;
}

/** This function collects the JSON lines of a program. It gives each line to `also` too, when the caller gives it. */
export const lines = <T extends { readonly ev: string }>(also?: (line: T) => void): Lines<T> => {
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
    also?.(line);
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
          // its last lines tell why: a fail line of a client that could not connect, or a text that is not a line
          const failed = seen.filter((line) => line.ev === "fail" || line.ev === "error").slice(0, 3);
          const last = [...new Set([...failed, ...seen.slice(-3)])].map((line) => JSON.stringify(line));
          const said = [...(last.length === 0 ? [] : [`its last lines: ${last.join(" | ")}`]), ...(other.length === 0 ? [] : [`it wrote: ${other.slice(-3).join(" | ")}`])];
          reject(new Error(`no ${kinds.join(" or ")} from the ${who} in ${within} ms${said.length === 0 ? "" : `; ${said.join("; ")}`}`));
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
  /** This method stops the process of the client with SIGKILL. Its kernel then closes its socket with a FIN, or a reset. */
  kill(): Promise<void>;
  readonly events: readonly ProbeEvent[];
  stop(): Promise<void>;
}

/** An agent is a container that a lab starts in the namespaces of the target, for example a Node process that signals the server. */
export interface Agent {
  /** These are the JSON lines that it wrote, as they arrive. */
  readonly lines: Lines<{ readonly ev: string }>;
  /** This method starts a command in the agent, and gives its standard output. */
  exec(argv: readonly string[]): Promise<string>;
  stop(): Promise<void>;
}

/** A lab is one environment: the target, the client, the hops of a topology, the injectors and the prober. */
export interface Lab {
  /** This address is the address that the client connects to: the target, or the first proxy of a topology. */
  readonly targetIp: string;
  /** This port is the port that the client connects to. */
  readonly targetPort: number;
  readonly clientIp: string;
  readonly netns: {
    readonly client: number;
    readonly target: number;
    readonly hops?: Readonly<Record<string, number>>;
  };
  /** This record is where each socket of a topology is, or null for a direct pair. */
  readonly topology: RunTopology | null;
  /** These are the lines of the routers of a topology, in sequence, each with the name of its hop. A direct pair has none. */
  readonly middlebox: readonly MiddleboxEvent[];
  /** These are the lines of a target that writes them (`Target.lines`), in sequence. Another target has none. */
  readonly server: readonly ProbeEvent[];
  /** This method adds a toxic to the Toxiproxy hop of a topology, or removes it with null. The stamps of the injector bracket it. */
  toxic(toxic: Toxic | null): Promise<{ t0: number; t1: number }>;
  /** This method makes the target close the connection of each client, with the command of the target. */
  serverClose(): Promise<void>;
  /**
   * This method starts an agent in the network namespace of the target, and in its process
   * namespace with `pid`. Its command keeps it up, for example `sleep infinity`.
   */
  agent(image: string, command: readonly string[], options?: { readonly pid?: boolean }): Promise<Agent>;
  /** These are all the records that the prober wrote, in sequence. */
  readonly kernel: readonly KernelRecord[];
  /** This method sets the sysctls of the client namespace through its privileged sidecar, and reads them back. */
  sysctl(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /** This method sets the settings of the target in it before a client connects, and reads them back. */
  configure(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /** This method sets the sysctls of the target namespace through a privileged sidecar there, and reads them back. */
  targetSysctl(values: Readonly<Record<string, string>>): Promise<Record<string, string>>;
  /**
   * This method applies a fault between the client and the target, by default from the namespace
   * of the target. The fault is a black hole, or a reset that answers the next segment of the
   * client. At a proxy of a topology, the rules face the peer of the proxy on one side. The stamps
   * of the injector bracket it.
   */
  fault(
    kind: NetworkFault,
    at?: FaultPlace,
    options?: FaultOptions,
  ): Promise<{ t0: number; t1: number }>;
  /** This method removes a fault. */
  lift(kind: NetworkFault, at?: FaultPlace, options?: FaultOptions): Promise<void>;
  /**
   * This method puts tc netem on the egress of a namespace, for example "delay 20ms" or "loss 5%",
   * or removes it with null. At a hop, it is the egress of the device of the hop toward one side.
   * The stamps of the injector bracket it.
   */
  netem(spec: string | null, at?: FaultPlace): Promise<{ t0: number; t1: number }>;
  /**
   * This method sets the TSO, GSO and GRO of a namespace. With them off, netem and a length match
   * act on segments, not on GSO super-packets of up to 64 KB. At a hop, it sets the two devices of the hop.
   */
  offload(on: boolean, at?: FaultPlace): Promise<void>;
  /** This method stops the server process in the target with SIGKILL, with the command of the target. */
  kill(): Promise<void>;
  /**
   * This method resolves the neighbors of the path in the two directions, with a ping from each
   * namespace. Without it, the first connection of an environment waits for ARP. Under a netem
   * delay, that wait is one more delayed round, and its round trip and RTO are longer.
   */
  warm(): Promise<void>;
  /** This method runs commands in the target before a client connects, each as argv. */
  setup(commands: ReadonlyArray<readonly string[]>): Promise<void>;
  /**
   * This method stops a black hole at an instant on the monotonic clock of the VM. The injector
   * waits for that instant in the VM, thus the length of a stall does not include the latency of
   * a docker exec. Stamps bracket it, as for a fault.
   */
  heal(at: FaultPlace, when: number): Promise<{ t0: number; t1: number }>;
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
  /**
   * This method sends a signal to the server process of the target (`Target.program`), at once or
   * at an instant of the VM. A sidecar in the network and process namespaces of the target sends
   * it, and the injector stamps it. The lab starts that sidecar at the first signal.
   */
  signal(signal: "STOP" | "CONT" | "KILL", at?: number): Promise<{ t0: number; t1: number }>;
  /**
   * This method applies an event at a proxy hop (`HopEvent`), or its undo. A signal goes from a
   * sidecar in the network and process namespaces of the hop. The lab starts that sidecar at the
   * first signal of the hop. A query goes from the injector of the hop to its console on 127.0.0.1. The
   * injector stamps each one. An event with no undo gives null for its undo. A signal can wait for an
   * instant on CLOCK_MONOTONIC (`at`), as the thaw at the end of a hold does.
   */
  event(event: HopEvent, undo?: boolean, at?: number): Promise<{ t0: number; t1: number } | null>;
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

/** This function makes a container share the process namespace of another container, for example `container:<id>`. */
export const withPid = <T extends Testcontainers.GenericContainer>(container: T, mode: string): T => {
  (container as unknown as { hostConfig: { PidMode?: string } }).hostConfig.PidMode = mode;
  return container;
};

/** This container class can share the process namespace of another container. */
const shared = (Base: typeof Testcontainers.GenericContainer) =>
  class extends Base {
    withPidMode(mode: string): this {
      (this as unknown as { hostConfig: { PidMode?: string } }).hostConfig.PidMode = mode;
      return this;
    }
  };

/**
 * This function gives the content of a file of a proxy. Each {{next}} becomes the address and the
 * port of the next hop. Each {{next.host}} and {{next.port}} becomes one of the two.
 */
export const templated = (content: string, next: string): string => {
  const at = next.lastIndexOf(":");
  return content
    .replaceAll("{{next.host}}", next.slice(0, at))
    .replaceAll("{{next.port}}", next.slice(at + 1))
    .replaceAll("{{next}}", next);
};

/** This function gives the JSON body of a toxic for the API of Toxiproxy. Each toxic of a cell has the name `fault`. */
export const toxicBody = (toxic: Toxic): string =>
  JSON.stringify({
    name: "fault",
    type: toxic.type,
    stream: toxic.stream,
    toxicity: 1,
    attributes: toxic.attributes,
  });

/**
 * This function gives the routes of a chain: for each router, the networks after it, which the
 * element before it reaches through it. Element 0 is the client, and element k is hop k - 1. Network
 * j is the network between element j and element j + 1.
 */
export const routesOf = (
  hops: readonly Pick<Hop, "kind">[],
): Array<{ readonly from: number; readonly via: number; readonly networks: readonly number[] }> =>
  hops.flatMap((hop, at) =>
    hop.kind === "router"
      ? [
          {
            from: at,
            via: at + 1,
            networks: Array.from({ length: hops.length - at }, (_, k) => at + 1 + k),
          },
        ]
      : [],
  );

/**
 * This function gives the endpoint that an element connects to: the first element after it that
 * is not a router. Element 0 is the client, element k is hop k - 1, and the last element is the target.
 */
export const endpointAfter = (hops: readonly Pick<Hop, "kind">[], element: number): number => {
  let at = element + 1;
  while (at <= hops.length && hops[at - 1]!.kind === "router") at += 1;
  return at;
};

// each container here is a holder, a probe or the prober: nothing drains, thus the stop is immediate
export const STOP = { timeout: 0 };

/** These are the values of CONFIG_HZ that Linux offers. */
const RATES: readonly number[] = [100, 250, 300, 1000];

/**
 * This function gives HZ from two readings of /proc/timer_list, one second apart: its `now at`
 * time in ns and its jiffies. It gives the nearest rate that Linux offers, or null when the
 * measurement is more than 5 % from each of them.
 */
export const hzOf = (first: { now: number; jiffies: number }, second: { now: number; jiffies: number }): string | null => {
  const seconds = (second.now - first.now) / 1e9;
  if (!(seconds > 0)) return null;
  const rate = (second.jiffies - first.jiffies) / seconds;
  const nearest = RATES.reduce((best, each) => (Math.abs(each - rate) < Math.abs(best - rate) ? each : best));
  return Math.abs(nearest - rate) / nearest <= 0.05 ? String(nearest) : null;
};

/** This function measures HZ in a privileged container: jiffies against the time of the kernel, one second apart. */
const measuredHz = async (container: StartedTestContainer): Promise<string | null> => {
  const read = "awk '/^now at/ {now=$3} /^jiffies:/ {print now, $2; exit}' /proc/timer_list";
  const text = await output(container, ["sh", "-c", `${read}; sleep 1; ${read}`]).catch(() => "");
  const values = text.split(/\s+/).filter((each) => each !== "").map(Number);
  if (values.length !== 4 || values.some((each) => !Number.isFinite(each))) return null;
  return hzOf({ now: values[0]!, jiffies: values[1]! }, { now: values[2]!, jiffies: values[3]! });
};

export const output = async (container: StartedTestContainer, argv: string[]): Promise<string> => {
  const result = await container.exec(argv);
  if (result.exitCode !== 0)
    throw new Error(`${argv.join(" ")} exited ${result.exitCode}: ${result.output.trim()}`);
  return result.stdout.trim();
};

/** This function gives the inode of the network namespace of a container: net:[4026532583]. */
export const netnsOf = async (container: StartedTestContainer): Promise<number> => {
  const link = await output(container, ["readlink", "/proc/self/ns/net"]);
  const inode = /^net:\[(\d+)\]$/.exec(link)?.[1];
  if (inode === undefined) throw new Error(`not a network namespace: ${link}`);
  return Number(inode);
};

/**
 * This function gives the image and the command of the client of each run, its kind for the
 * manifest, and the source of its image. A client by its name is a client that the harness ships
 * (`SHIPPED_CLIENTS`). A client image gives its own image and command.
 */
export const clientOf = async (
  kind: Client | ClientImage,
): Promise<{ clientImage: string; command: readonly string[]; clientKind: Client | "image"; source?: ImageSource }> => {
  const client = typeof kind === "string" ? (Object.hasOwn(SHIPPED_CLIENTS, kind) ? SHIPPED_CLIENTS[kind] : undefined) : kind;
  if (client === undefined) throw new Error(`the harness ships no client ${String(kind)}`);
  return {
    clientImage: await imageOf(client.image),
    command: client.command,
    clientKind: typeof kind === "string" ? kind : "image",
    ...(typeof client.image === "string" ? {} : { source: client.image }),
  };
};

/** These are the containers of one hop of a lab, and the addresses that its rules and the measurement read. */
interface HopIn {
  readonly hop: Hop;
  /** This container is the hop itself: the router, or the stock proxy. */
  readonly box: StartedTestContainer;
  /** This sidecar shares the namespace of the hop: the injector of its faults and its toxics. */
  readonly injector: StartedTestContainer;
  /** This record is the address of the hop on the network of each of its sides. */
  readonly ip: { readonly client: string; readonly target: string };
  /** These are the peers of the hop: an address on the side of the client, and an address with its port toward the target. */
  readonly peer: { readonly client: string; readonly target: string };
  /** These are the devices of the hop toward each side, as its routes give them. The rules of a router and netem at a hop face one. */
  readonly devices: { readonly client: string; readonly target: string };
  readonly netns: number;
  sysctls: Record<string, string>;
}

/** This function gives the device of a route from its line in `ip -o route get`: "10.0.0.2 dev eth0 src …". */
export const deviceOf = (route: string): string => {
  const device = /\bdev (\S+)/.exec(route)?.[1];
  if (device === undefined) throw new Error(`no device in the route: ${route}`);
  return device;
};

/**
 * This function opens one environment:
 * - a chain of new networks, and the stock target on the last one. A direct pair has one network.
 * - a client that holds its own network namespace, with a privileged sidecar in it for its
 *   sysctls and its routes. Docker Desktop keeps /proc/sys read-only in a container that operates
 *   without privileges.
 * - each hop of the topology, on the network of each of its sides. A hop is a router, or a stock
 *   proxy with an injector sidecar in its namespace.
 * - an injector sidecar in the namespace of the target.
 * - the prober, a privileged container that loads the kernel program and watches the namespace of
 *   the client, of the target and of each hop.
 *
 * The client of each run is its own container in the namespace of the client. It is the TCP
 * client of the harness, a driver from its own image (ioredis on Node), or an image that the
 * caller gives. Each prints the same lines.
 *
 * The client reaches the networks after a router through that router, by a route that its
 * privileged sidecar adds. A router translates the address of the side of the client, thus the
 * target and each later hop see the router as the peer.
 */
export const openLab = async (
  target: Target,
  kind: Client | ClientImage = "tcp",
  topology?: Topology,
): Promise<Lab> => {
  const image = await harnessImage();
  const { clientImage, command, clientKind, source } = await clientOf(kind);
  const hops = topology?.hops ?? [];
  const { GenericContainer, Network, Wait, getContainerRuntimeClient } = await containers();
  const runtime = await getContainerRuntimeClient();
  const opened: StartedTestContainer[] = [];
  const networks: StartedNetwork[] = [];
  // the lines of a target that writes them, on the clock of the VM
  const serverLines = lines<ProbeEvent>();
  const close = async () => {
    for (const container of opened.reverse()) await container.stop(STOP).catch(() => undefined);
    for (const network of networks.reverse()) await network.stop().catch(() => undefined);
  };
  /** This function gives the address of a container on a network, as Docker has it at this time. A container can join a network after its start. */
  const ipOn = async (container: StartedTestContainer, network: StartedNetwork): Promise<string> => {
    const info = await runtime.container.inspect(runtime.container.getById(container.getId()));
    const ip = info.NetworkSettings.Networks[network.getName()]?.IPAddress;
    if (ip === undefined || ip === "") throw new Error(`${container.getName()} has no address on ${network.getName()}`);
    return ip;
  };
  const join = (container: StartedTestContainer, network: StartedNetwork) =>
    runtime.container.connectToNetwork(
      runtime.container.getById(container.getId()),
      runtime.network.getById(network.getId()),
      [],
    );
  const subnetOf = async (network: StartedNetwork): Promise<string> => {
    const info = await runtime.network.getById(network.getId()).inspect();
    const subnet = (info as { IPAM?: { Config?: Array<{ Subnet?: string }> } }).IPAM?.Config?.[0]?.Subnet;
    if (subnet === undefined) throw new Error(`${network.getName()} has no subnet`);
    return subnet;
  };
  try {
    // network j joins element j and element j + 1: 0 is the client, i + 1 is hop i, the last is the target
    for (let at = 0; at <= hops.length; at += 1) networks.push(await new Network().start());
    const last = networks[hops.length]!;
    // a stock image, or an image of the harness that holds the script of the server
    const targetImage = await targetImageOf(target);
    let stock = new GenericContainer(targetImage)
      .withNetwork(last)
      .withWaitStrategy(Wait.forLogMessage(target.ready));
    // the files of the target go in before it starts, for example the script of a server on a stock image
    if (target.files !== undefined)
      stock = stock.withCopyContentToContainer(
        Object.entries(target.files).map(([path, content]) => ({ content, target: path })),
      );
    if (target.lines === true) stock = stock.withLogConsumer(serverLines.consume);
    // a holder command keeps the container up when a fin fault kills the server process
    const server = await (
      target.command === undefined ? stock : stock.withCommand([...target.command])
    ).start();
    opened.push(server);
    const serverIp = await ipOn(server, last);

    // the hops, from the target to the client: each proxy gets the address of the endpoint after it
    const middlebox: MiddleboxEvent[] = [];
    // the last lines of the output of each proxy, and their count, for a write that the proxy confirms
    const hopOutput = new Map<string, { lines: string[]; total: number }>();
    const inChain: HopIn[] = [];
    const endpointOf = (element: number): string => {
      const at = endpointAfter(hops, element);
      if (at === hops.length + 1) return `${serverIp}:${target.port}`;
      const proxy = inChain[at - 1]!;
      return `${proxy.ip.client}:${(proxy.hop as ProxyHop).port}`;
    };
    for (let at = hops.length - 1; at >= 0; at -= 1) {
      const hop = hops[at]!;
      const [clientSide, targetSide] = [networks[at]!, networks[at + 1]!];
      if (hop.kind === "router") {
        const seen = lines<MiddleboxEvent>((line) => middlebox.push({ ...line, hop: hop.name }));
        // the router is privileged: it sets the sysctls of its own namespace, conntrack's among them
        const box = await new GenericContainer(await routerImage())
          .withNetwork(clientSide)
          .withPrivilegedMode()
          .withEnvironment({
            FORM: hop.form,
            IDLE: String(valueIn(hop.idle, "s")),
            PUMP: String(valueIn(hop.pump ?? PUMP, "s")),
            SLOW: String(valueIn(LISTING, "s")),
          })
          .withLogConsumer(seen.consume)
          .start();
        opened.push(box);
        // the router waits for the network of the side of the target, its eth1
        await join(box, targetSide);
        const ready = await seen.until(["mbx-ready"], 30_000, `router ${hop.name}`);
        await seen.until(hop.form === "reset-both" ? ["resetter"] : ["ct-watch"], 30_000, `router ${hop.name}`);
        // the injector of a fault at the router: FORWARD rules and netem in its namespace
        const injector = await new GenericContainer(image)
          .withNetworkMode(`container:${box.getId()}`)
          .withAddedCapabilities("NET_ADMIN", "NET_RAW")
          .start();
        opened.push(injector);
        inChain[at] = {
          hop,
          box,
          injector,
          ip: { client: await ipOn(box, clientSide), target: await ipOn(box, targetSide) },
          peer: { client: "", target: endpointOf(at + 1) },
          devices: { client: "", target: "" },
          netns: await netnsOf(box),
          sysctls: { "net.netfilter.nf_conntrack_tcp_timeout_established": String(ready["idle"]) },
        };
        continue;
      }
      const next = endpointOf(at + 1);
      let proxy = new GenericContainer(await imageOf(hop.image)).withNetwork(targetSide);
      if (hop.command !== undefined) proxy = proxy.withCommand([...hop.command]);
      if (hop.environment !== undefined) proxy = proxy.withEnvironment({ ...hop.environment });
      if (hop.files !== undefined)
        proxy = proxy.withCopyContentToContainer(
          Object.entries(hop.files).map(([path, content]) => ({ content: templated(content, next), target: path })),
        );
      if (hop.ready !== undefined) proxy = proxy.withWaitStrategy(Wait.forLogMessage(hop.ready));
      // the last lines of the output of the hop: a hop that does not start tells why
      const tail: string[] = [];
      const output = { lines: [] as string[], total: 0 };
      hopOutput.set(hop.name, output);
      proxy = proxy.withLogConsumer((stream) => {
        let rest = "";
        stream.on("data", (chunk: Buffer | string) => {
          const lines = (rest + chunk.toString()).split("\n");
          rest = lines.pop() ?? "";
          for (const line of lines) {
            tail.push(line);
            if (tail.length > TAIL_LINES) tail.shift();
            output.lines.push(line);
            output.total += 1;
            if (output.lines.length > OUTPUT_LINES) output.lines.shift();
          }
        });
      });
      const box = await proxy.start().catch((error: unknown) => {
        throw new Error(`the hop ${hop.name} did not start: ${error instanceof Error ? error.message : String(error)}. Its last lines:\n${tail.join("\n")}`);
      });
      opened.push(box);
      await join(box, clientSide);
      const injector = await new GenericContainer(image)
        .withNetworkMode(`container:${box.getId()}`)
        .withAddedCapabilities("NET_ADMIN", "NET_RAW")
        .start();
      opened.push(injector);
      inChain[at] = {
        hop,
        box,
        injector,
        ip: { client: await ipOn(box, clientSide), target: await ipOn(box, targetSide) },
        peer: { client: "", target: next },
        devices: { client: "", target: "" },
        netns: await netnsOf(injector),
        sysctls: {},
      };
    }

    const client = await new GenericContainer(image).withNetwork(networks[0]!).start();
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
    const clientIp = await ipOn(client, networks[0]!);
    // the peer of each hop on the side of the client: the element before it, on the network between them
    for (let at = 0; at < inChain.length; at += 1) {
      const before = at === 0 ? clientIp : inChain[at - 1]!.ip.target;
      inChain[at] = { ...inChain[at]!, peer: { ...inChain[at]!.peer, client: before } };
    }

    // a privileged sidecar for each proxy that needs one, for its sysctls and its routes
    const admins = new Map<number, StartedTestContainer>();
    const adminOf = async (element: number): Promise<StartedTestContainer> => {
      if (element === 0) return admin;
      const hop = inChain[element - 1]!;
      if (hop.hop.kind === "router") return hop.box;
      let found = admins.get(element);
      if (found === undefined) {
        found = await new GenericContainer(image)
          .withNetworkMode(`container:${hop.box.getId()}`)
          .withPrivilegedMode()
          .start();
        opened.push(found);
        admins.set(element, found);
      }
      return found;
    };
    for (const route of routesOf(hops)) {
      const where = await adminOf(route.from);
      const via = inChain[route.via - 1]!.ip.client;
      for (const network of route.networks)
        await output(where, ["ip", "route", "replace", await subnetOf(networks[network]!), "via", via]);
    }
    for (let at = 0; at < inChain.length; at += 1) {
      const hop = inChain[at]!;
      // the device toward each side, as the routes of the hop give it
      const toward = async (address: string) =>
        deviceOf(await output(hop.injector, ["ip", "-o", "route", "get", address.split(":")[0]!]));
      inChain[at] = { ...hop, devices: { client: await toward(hop.peer.client), target: await toward(hop.peer.target) } };
      if (hop.hop.sysctls === undefined) continue;
      // a router is privileged and sets its own sysctls. A proxy has a privileged sidecar for them
      const where = await adminOf(at + 1);
      const settings = Object.entries(hop.hop.sysctls).map(([key, value]) => `${key}=${value}`);
      await output(where, ["sysctl", "-q", "-w", ...settings]);
      for (const key of Object.keys(hop.hop.sysctls)) hop.sysctls[key] = await output(where, ["sysctl", "-n", key]);
    }

    const netns = {
      client: await netnsOf(admin),
      target: await netnsOf(injector),
      ...(inChain.length === 0
        ? {}
        : { hops: Object.fromEntries(inChain.map((hop) => [hop.hop.name, hop.netns])) }),
    };
    const records = lines<KernelRecord>();
    const prober = await new GenericContainer(image)
      .withPrivilegedMode()
      .withNetworkMode("none")
      .withCommand([
        "/opt/harness/prober",
        String(netns.client),
        String(netns.target),
        ...inChain.map((hop) => String(hop.netns)),
      ])
      .withLogConsumer(records.consume)
      .start();
    opened.push(prober);
    const begun = await records.until(["begin", "fail"], 30_000, "prober");
    if (begun.ev === "fail") throw new Error(`the prober failed: ${String(begun["why"])}`);
    const first = endpointAfter(hops, 0);
    const targetIp = first === hops.length + 1 ? serverIp : inChain[first - 1]!.ip.client;
    const targetPort = first === hops.length + 1 ? target.port : (inChain[first - 1]!.hop as ProxyHop).port;
    const targetPeer = inChain.length === 0 ? clientIp : inChain.at(-1)!.ip.target;
    const placed: RunTopology | null =
      inChain.length === 0
        ? null
        : {
            targetPeer,
            hops: Object.fromEntries(
              inChain.map((hop) => [hop.hop.name, { netns: hop.netns, client: hop.peer.client, target: hop.peer.target }]),
            ),
          };
    const paused = runtime.container.getById(server.getId());
    let targetAdmin: StartedTestContainer | undefined;
    let signaller: StartedTestContainer | undefined;
    // the sidecars that signal the program of a hop, by the name of the hop
    const hopSignallers = new Map<string, StartedTestContainer>();
    const hopNamed = (name: string): HopIn => {
      const found = inChain.find((hop) => hop.hop.name === name);
      if (found === undefined) throw new Error(`the topology has no hop ${name}`);
      return found;
    };
    /**
     * This function gives the namespace and the peer of the rules of a fault at a place, and the
     * other arguments of the injector. At a proxy, the rules are INPUT and OUTPUT rules, which act
     * on its sockets. A router forwards past INPUT and OUTPUT, thus its rules are FORWARD rules on
     * its device toward the side (`--via`).
     */
    const hopPlace = (at: FaultPlace): HopPlace => {
      if (!isHopPlace(at)) throw new Error(`a lab of a topology has no part ${JSON.stringify(at)}: a group cell opens a group lab`);
      return at;
    };
    const placeOf = (place: FaultPlace): [StartedTestContainer, string, string[]] => {
      if (place === "client") return [admin, targetIp, []];
      if (place === "target") return [injector, targetPeer, []];
      const at = hopPlace(place);
      const hop = hopNamed(at.hop);
      const peer = at.toward === "client" ? hop.peer.client : hop.peer.target.split(":")[0]!;
      const via = hop.hop.kind === "router" ? ["--via", hop.devices[at.toward]] : [];
      return [hop.injector, peer, via];
    };
    /** This function gives the namespace and the device of netem at a place: an end, or the device of a hop toward a side. */
    const deviceAt = (place: FaultPlace): [StartedTestContainer, string] => {
      if (place === "client") return [admin, "eth0"];
      if (place === "target") return [injector, "eth0"];
      const at = hopPlace(place);
      const hop = hopNamed(at.hop);
      return [hop.injector, hop.devices[at.toward]];
    };
    const toxiproxy = (): HopIn & { hop: ProxyHop & { api: { port: number; proxy: string } } } => {
      const found = inChain.find((hop) => hop.hop.kind === "proxy" && hop.hop.api !== undefined);
      if (found === undefined) throw new Error("the topology has no hop with the API of Toxiproxy");
      return found as HopIn & { hop: ProxyHop & { api: { port: number; proxy: string } } };
    };
    const stamped = async (where: StartedTestContainer, argv: string[]) => {
      const stamp = JSON.parse((await output(where, argv)).split("\n").at(-1)!) as { t0: number; t1: number };
      return { t0: stamp.t0, t1: stamp.t1 };
    };
    const proxies = inChain.filter((hop) => hop.hop.kind === "proxy");

    return {
      targetIp,
      targetPort,
      clientIp,
      netns,
      topology: placed,
      middlebox,
      server: serverLines.seen,
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
      async fault(kind, at = "target", options = {}) {
        const [where, peer, via] = placeOf(at);
        return stamped(where, ["/opt/harness/inject", kind, peer, ...optionArgs(options), ...via]);
      },
      async lift(kind, at = "target", options = {}) {
        const [where, peer, via] = placeOf(at);
        await output(where, ["/opt/harness/inject", LIFT[kind], peer, ...optionArgs(options), ...via]);
      },
      async netem(spec, at = "target") {
        const [where, device] = deviceAt(at);
        const args =
          spec === null
            ? ["/opt/harness/inject", "clear-netem", device]
            : ["/opt/harness/inject", "netem", device, ...spec.split(/\s+/)];
        return stamped(where, args);
      },
      async offload(on, at = "target") {
        // at a hop, the two devices: a router merges what it receives (GRO) and forwards it whole
        const devices = isHopPlace(at) ? Object.values(hopNamed(at.hop).devices) : [deviceAt(at)[1]];
        const [where] = deviceAt(at);
        for (const device of devices)
          await output(where, ["/opt/harness/inject", "offload", device, on ? "on" : "off"]);
      },
      async toxic(toxic) {
        const hop = toxiproxy();
        const api = `127.0.0.1:${hop.hop.api.port}`;
        const path = `/proxies/${hop.hop.api.proxy}/toxics`;
        return stamped(
          hop.injector,
          toxic === null
            ? ["/opt/harness/inject", "http", "DELETE", api, `${path}/fault`]
            : ["/opt/harness/inject", "http", "POST", api, path, toxicBody(toxic)],
        );
      },
      async serverClose() {
        if (target.close === undefined) throw new Error(`${target.image} names no way to close its clients`);
        await output(server, [...target.close]);
      },
      async agent(agentImage, argv, options = {}) {
        const Shared = shared(GenericContainer);
        const seen = lines<{ readonly ev: string }>();
        let started = new Shared(agentImage)
          .withNetworkMode(`container:${server.getId()}`)
          .withCommand([...argv])
          .withLogConsumer(seen.consume);
        if (options.pid === true) started = started.withPidMode(`container:${server.getId()}`);
        const container = await started.start();
        opened.push(container);
        return {
          lines: seen,
          exec: (args) => output(container, [...args]),
          stop: () =>
            container
              .stop(STOP)
              .then(() => undefined)
              .catch(() => undefined),
        };
      },
      async kill() {
        if (target.kill === undefined) throw new Error(`${target.image} names no way to kill its server`);
        await output(server, [...target.kill]);
      },
      async warm() {
        await output(admin, ["ping", "-c", "2", "-W", "2", targetIp]);
        await output(injector, ["ping", "-c", "2", "-W", "2", targetPeer]);
        for (const hop of proxies)
          await output(hop.injector, ["ping", "-c", "2", "-W", "2", hop.peer.target.split(":")[0]!]);
      },
      async setup(commands) {
        for (const argv of commands) await output(server, [...argv]);
      },
      async heal(at, when) {
        const [where, peer, via] = placeOf(at);
        return stamped(where, ["/opt/harness/inject", "clear", peer, "--at", String(Math.round(when)), ...via]);
      },
      async forget() {
        await output(admin, ["ip", "tcp_metrics", "flush", "all"]);
        await output(injector, ["ip", "tcp_metrics", "flush", "all"]);
        for (const hop of proxies) await output(hop.injector, ["ip", "tcp_metrics", "flush", "all"]);
      },
      freeze: () => paused.pause().then(() => undefined),
      thaw: () => paused.unpause().then(() => undefined),
      async signal(signal, at) {
        if (target.program === undefined) throw new Error(`${target.image} names no server process to signal`);
        // only when a cell asks for it: otherwise no sidecar shares the process namespace of the target
        signaller ??= await withPid(
          new GenericContainer(image).withNetworkMode(`container:${server.getId()}`).withAddedCapabilities("NET_ADMIN", "NET_RAW"),
          `container:${server.getId()}`,
        ).start();
        if (!opened.includes(signaller)) opened.push(signaller);
        const when = at === undefined ? [] : ["--at", String(Math.round(at))];
        return stamped(signaller, ["/opt/harness/inject", "signal", target.program, signal, ...when]);
      },
      async event(event, undo = false, at) {
        const hop = hopNamed(event.hop);
        if (hop.hop.kind !== "proxy") throw new Error(`the hop ${event.hop} is a router: an event goes to a proxy`);
        const program = hop.hop.program;
        // only when a cell asks for it: otherwise no sidecar shares the process namespace of the hop.
        // SYS_PTRACE lets a write reach the root of the program through /proc/PID/root
        const sidecarOf = async (): Promise<StartedTestContainer> => {
          let sidecar = hopSignallers.get(event.hop);
          if (sidecar === undefined) {
            sidecar = await withPid(
              new GenericContainer(image).withNetworkMode(`container:${hop.box.getId()}`).withAddedCapabilities("NET_ADMIN", "NET_RAW", "SYS_PTRACE"),
              `container:${hop.box.getId()}`,
            ).start();
            hopSignallers.set(event.hop, sidecar);
            opened.push(sidecar);
          }
          return sidecar;
        };
        if ("signal" in event) {
          if (undo) return null;
          if (program === undefined) throw new Error(`the hop ${event.hop} names no program to signal`);
          const when = at === undefined ? [] : ["--at", String(Math.round(at))];
          return stamped(await sidecarOf(), ["/opt/harness/inject", "signal", program, event.signal, ...when]);
        }
        if ("write" in event) {
          const content = undo ? event.write.undo : event.write.content;
          if (content === undefined) return null;
          if (program === undefined) throw new Error(`the hop ${event.hop} names no program whose root a write reaches`);
          const output = hopOutput.get(event.hop);
          const before = output?.total ?? 0;
          const stamp = await stamped(await sidecarOf(), ["/opt/harness/inject", "write", program, event.write.path, content]);
          const confirm = event.write.confirm;
          if (confirm !== undefined) {
            // the hop confirms the change by a new line of its output, for example the log line of its reload
            const started = Date.now();
            const confirmed = (): boolean => {
              if (output === undefined) return false;
              const fresh = Math.min(output.total - before, output.lines.length);
              return output.lines.slice(output.lines.length - fresh).some((line) => line.includes(confirm));
            };
            while (!confirmed()) {
              if (Date.now() - started > CONFIRM_MS)
                throw new Error(`the hop ${event.hop} did not confirm the write of ${event.write.path}: no line "${confirm}" in ${CONFIRM_MS / 1000} s`);
              await sleep(50);
            }
          }
          return stamp;
        }
        const query = undo ? event.console.undo : event.console.query;
        if (query === undefined) return null;
        const { port, user, database } = event.console;
        return stamped(hop.injector, ["/opt/harness/inject", "query", `127.0.0.1:${port}`, user, database, query]);
      },
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
          kill: () =>
            runtime.container
              .getById(container.getId())
              .kill({ signal: "SIGKILL" })
              .then(() => undefined),
          // a killed client has no container to stop
          stop: () =>
            container
              .stop(STOP)
              .then(() => undefined)
              .catch(() => undefined),
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
        const hopsOf = async (): Promise<ManifestHop[]> => {
          const out: ManifestHop[] = [];
          for (const hop of inChain) {
            const box = hop.hop;
            out.push({
              name: box.name,
              kind: box.kind,
              image: box.kind === "router" ? await routerImage() : await imageOf(box.image),
              id: (await inspect(hop.box)).Image,
              settings:
                box.kind === "router"
                  ? {
                      form: box.form,
                      idle: String(valueIn(box.idle, "s")),
                      pump: String(valueIn(box.pump ?? PUMP, "s")),
                      slow: String(valueIn(LISTING, "s")),
                      packages: (await output(hop.box, ["apk", "info", "-v"])).split("\n").sort().join(" "),
                    }
                  : { ...box.settings, ...box.files },
              sysctls: hop.sysctls,
            });
          }
          return out;
        };
        return {
          kernel: await output(client, ["uname", "-r"]),
          architecture: await output(client, ["uname", "-m"]),
          ...(await (async () => {
            const configured = /^CONFIG_HZ=(\d+)$/m.exec(config)?.[1];
            if (configured !== undefined) return { hz: configured, hzFrom: "config" as const };
            const measured = await measuredHz(admin);
            return measured === null ? { hz: null } : { hz: measured, hzFrom: "measured" as const };
          })()),
          boot_id: await output(client, ["cat", "/proc/sys/kernel/random/boot_id"]),
          docker: `${runtime.info.containerRuntime.serverVersion} on ${runtime.info.containerRuntime.operatingSystem}`,
          target: {
            image: targetImage,
            ...(target.subject !== undefined
              ? { subject: target.subject, base: target.image }
              : target.harness === undefined
                ? {}
                : { harness: target.harness, base: target.image }),
            id: (await inspect(server)).Image,
            settings,
            sysctls: targetSysctls,
            ...(target.files === undefined
              ? {}
              : {
                  files: Object.fromEntries(
                    Object.entries(target.files).map(([path, content]) => [path, createHash("sha256").update(content).digest("hex")]),
                  ),
                }),
            ...(serverLines.seen[0] === undefined ? {} : { first: serverLines.seen[0] }),
          },
          harness: {
            image,
            id: (await inspect(client)).Image,
            packages: (await output(client, ["apk", "info", "-v"])).split("\n").sort(),
          },
          client: { kind: clientKind, image: clientImage, ...(source === undefined ? {} : { source }) },
          netns,
          sysctls,
          ...(inChain.length === 0 ? {} : { hops: await hopsOf() }),
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
};
