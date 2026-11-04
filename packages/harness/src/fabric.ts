import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valueIn } from "@mark1russell7/quantity";
import type { StartedTestContainer } from "testcontainers";
import type { Fabric, FabricManifest, RunRoute } from "./cell.ts";

/**
 * A fabric is a routed network between the client and the target, on layer E3 (docs/S7.md). Four
 * routers of FRRouting, two leaves and two spines, run real BGP over veth pairs that containerlab
 * makes. The client hangs off leaf1 and the target off leaf2. The path between them goes through
 * spine1 by a weight, and spine2 holds the other path. A cell silences spine1, and the routes of
 * the leaves move to spine2 when a detector of the routers fires.
 *
 * This file holds the plan of the fabric as pure functions, and `openFabric` that starts it. A lab
 * opens a fabric with `Topology.fabric`. Thus the client, the target, the prober and the verdict
 * stay the same as on layer E1. The fabric needs a Linux host with containerlab and sudo.
 */

/** This image is FRRouting 10.7.1, pinned by digest. */
export const FRR_IMAGE =
  "quay.io/frrouting/frr:10.7.1@sha256:e995beaa50fdc9edb35eadcfefa29b7f062cc06f2b812613789b68fa541554d2";

/** This device is the side of the fabric in the client and in the target. Docker keeps eth0. */
export const FABRIC_DEVICE = "eth1";
/** This address is the client on its network behind leaf1. */
export const FABRIC_CLIENT = "10.1.0.2";
/** This address is the target on its network behind leaf2. */
export const FABRIC_TARGET = "10.2.0.2";

/** This device of a leaf goes to spine1, thus a route on it is on the preferred path. */
const PREFERRED_DEVICE = "eth1";
/** This limit is the time that the sessions and the routes get to come back before a run. */
const READY_MS = 90_000;
const READY_POLL_MS = 250;

/** A router is one box of the fabric, as data. */
interface Router {
  readonly name: string;
  readonly as: number;
  readonly id: string;
  readonly interfaces: Readonly<Record<string, string>>;
  readonly neighbors: ReadonlyArray<{ readonly address: string; readonly as: number; readonly weight?: number }>;
  /** This prefix is the network behind a leaf, which its BGP advertises. */
  readonly network?: string;
  /** This prefix is the network behind the other leaf. A move is a change of its route. */
  readonly remote?: string;
}

const CLIENT_NET = "10.1.0.0/24";
const TARGET_NET = "10.2.0.0/24";

/** These are the routers. Each leaf prefers spine1 by a weight of 100, thus the path of each run is known. */
export const ROUTERS: readonly Router[] = [
  {
    name: "leaf1",
    as: 65001,
    id: "10.255.0.1",
    interfaces: { eth1: "10.0.1.0/31", eth2: "10.0.2.0/31", eth3: "10.1.0.1/24" },
    neighbors: [
      { address: "10.0.1.1", as: 65101, weight: 100 },
      { address: "10.0.2.1", as: 65102 },
    ],
    network: CLIENT_NET,
    remote: TARGET_NET,
  },
  {
    name: "leaf2",
    as: 65002,
    id: "10.255.0.2",
    interfaces: { eth1: "10.0.3.0/31", eth2: "10.0.4.0/31", eth3: "10.2.0.1/24" },
    neighbors: [
      { address: "10.0.3.1", as: 65101, weight: 100 },
      { address: "10.0.4.1", as: 65102 },
    ],
    network: TARGET_NET,
    remote: CLIENT_NET,
  },
  {
    name: "spine1",
    as: 65101,
    id: "10.255.1.1",
    interfaces: { eth1: "10.0.1.1/31", eth2: "10.0.3.1/31" },
    neighbors: [
      { address: "10.0.1.0", as: 65001 },
      { address: "10.0.3.0", as: 65002 },
    ],
  },
  {
    name: "spine2",
    as: 65102,
    id: "10.255.1.2",
    interfaces: { eth1: "10.0.2.1/31", eth2: "10.0.4.1/31" },
    neighbors: [
      { address: "10.0.2.0", as: 65001 },
      { address: "10.0.4.0", as: 65002 },
    ],
  },
];

const LEAVES = ROUTERS.filter((router) => router.remote !== undefined);

/** These are the links between the routers. The links to the client and the target come from `topologyOf`. */
const LINKS: ReadonlyArray<readonly [string, string]> = [
  ["leaf1:eth1", "spine1:eth1"],
  ["leaf1:eth2", "spine2:eth1"],
  ["leaf2:eth1", "spine1:eth2"],
  ["leaf2:eth2", "spine2:eth2"],
];

/** This text is the `daemons` file of each router: BGP and BFD, on top of what FRRouting always starts. */
export const DAEMONS = [
  "bgpd=yes",
  "bfdd=yes",
  "vtysh_enable=yes",
  'zebra_options="  -A 127.0.0.1 -s 90000000"',
  'mgmtd_options="  -A 127.0.0.1"',
  'bgpd_options="   -A 127.0.0.1"',
  'bfdd_options="   -A 127.0.0.1"',
  'staticd_options="-A 127.0.0.1"',
  "",
].join("\n");

/**
 * This function gives the configuration of a router. Graceful restart is off: after a hold expiry,
 * a helper can keep the stale routes, and the move that a cell measures does not come.
 * `maximum-paths 1` keeps one path, thus a move is one change of one route.
 */
export const frrConf = (router: Router, fabric: Fabric): string => {
  const keepalive = valueIn(fabric.keepalive, "s");
  const hold = valueIn(fabric.hold, "s");
  const out = ["frr defaults traditional", `hostname ${router.name}`, "ip forwarding", "!"];
  for (const [name, address] of Object.entries(router.interfaces))
    out.push(`interface ${name}`, ` ip address ${address}`, "!");
  if (fabric.bfd !== null) {
    const interval = valueIn(fabric.bfd.interval, "ms");
    out.push(
      "bfd",
      " profile fast",
      `  receive-interval ${interval}`,
      `  transmit-interval ${interval}`,
      `  detect-multiplier ${fabric.bfd.multiplier}`,
      " exit",
      "exit",
      "!",
    );
  }
  out.push(
    `router bgp ${router.as}`,
    ` bgp router-id ${router.id}`,
    " no bgp ebgp-requires-policy",
    " no bgp network import-check",
    " bgp graceful-restart-disable",
  );
  for (const neighbor of router.neighbors) {
    out.push(
      ` neighbor ${neighbor.address} remote-as ${neighbor.as}`,
      ` neighbor ${neighbor.address} timers ${keepalive} ${hold}`,
      ` neighbor ${neighbor.address} timers connect 1`,
      ` neighbor ${neighbor.address} advertisement-interval 0`,
    );
    if (fabric.bfd !== null) out.push(` neighbor ${neighbor.address} bfd profile fast`);
  }
  out.push(" !", " address-family ipv4 unicast");
  if (router.network !== undefined) out.push(`  network ${router.network}`);
  out.push("  maximum-paths 1");
  for (const neighbor of router.neighbors)
    if (neighbor.weight !== undefined) out.push(`  neighbor ${neighbor.address} weight ${neighbor.weight}`);
  out.push(" exit-address-family", "exit", "");
  return out.join("\n");
};

/**
 * This function gives the topology file of containerlab. The client and the target are containers
 * of the lab, and the fabric adds a device to each. Each link has the MTU of a Docker network, thus
 * a segment is as long as on layer E1. The default of containerlab is 9500. The management network
 * belongs to the lab, and Docker chooses its subnet.
 */
export const topologyOf = (lab: string, dir: string, client: string, target: string): string => {
  const nodes = ROUTERS.flatMap((router) => [
    `    ${router.name}:`,
    "      kind: linux",
    `      image: ${FRR_IMAGE}`,
    "      binds:",
    `        - ${dir}/${router.name}.conf:/etc/frr/frr.conf`,
    `        - ${dir}/daemons:/etc/frr/daemons`,
    "      sysctls:",
    "        net.ipv4.ip_forward: 1",
    "        net.ipv4.conf.all.rp_filter: 0",
    "        net.ipv4.conf.default.rp_filter: 0",
  ]);
  const links = [...LINKS, ["leaf1:eth3", `${client}:${FABRIC_DEVICE}`], ["leaf2:eth3", `${target}:${FABRIC_DEVICE}`]];
  return [
    `name: ${lab}`,
    "mgmt:",
    `  network: clab-${lab}`,
    "  ipv4-subnet: auto",
    "topology:",
    "  nodes:",
    ...nodes,
    `    ${client}:`,
    "      kind: ext-container",
    `    ${target}:`,
    "      kind: ext-container",
    "  links:",
    ...links.flatMap(([a, b]) => [`    - endpoints: ["${a}", "${b}"]`, "      mtu: 1500"]),
    "",
  ].join("\n");
};

/** A route line is one line of `ip -ts -o monitor route`, with its time on the wall clock in ms. */
export interface RouteLine {
  readonly wall: number;
  readonly deleted: boolean;
  readonly prefix: string;
  readonly via: string | null;
  readonly dev: string | null;
}

/** This function reads a line of `ip -ts -o monitor route`, or it gives null for another line. The clock of a container is UTC. */
export const routeLine = (text: string): RouteLine | null => {
  const found = /^\[(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.(\d{6})\] (?:(Deleted|Replaced) )?(\S+)(.*)$/.exec(text.trim());
  if (found === null) return null;
  const [, year, month, day, hour, minute, second, micro, change, prefix, rest] = found;
  return {
    wall:
      Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) +
      Number(micro) / 1_000,
    deleted: change === "Deleted",
    prefix: prefix!,
    via: / via (\S+)/.exec(rest!)?.[1] ?? null,
    dev: / dev (\S+)/.exec(rest!)?.[1] ?? null,
  };
};

/** A clock pair is one instant on the monotonic clock in ns and on the wall clock in ms. */
export interface ClockPair {
  readonly mono: number;
  readonly wall: number;
}

/**
 * This function takes a time on the wall clock to the monotonic clock. The harness runs on the host
 * of the containers, thus `process.hrtime` reads the CLOCK_MONOTONIC of the injector and the
 * prober. The error of the pair is approximately 1 ms, the step of `Date.now`.
 */
export const monotonicAt = (wall: number, pair: ClockPair): number => pair.mono + (wall - pair.wall) * 1e6;

/** This function gives the state of the BGP sessions from `show bgp neighbors json`. */
export const sessionsOf = (json: string): { readonly up: number; readonly established: number } => {
  const views = Object.values(JSON.parse(json) as Record<string, { bgpState?: string; connectionsEstablished?: number }>);
  return {
    up: views.filter((view) => view.bgpState === "Established").length,
    established: views.reduce((sum, view) => sum + (view.connectionsEstablished ?? 0), 0),
  };
};

/** These are the views of a leaf that tell if a run can start on it. */
export interface LeafViews {
  readonly neighbors: string;
  /** This text is the kernel's route to the far network, from `ip -o route show`. */
  readonly route: string;
  /** This text is `show bgp ipv4 unicast PREFIX json`. */
  readonly paths: string;
  /** This text is `show bfd peers json`, or null when the fabric has no BFD. */
  readonly bfd: string | null;
}

/**
 * This function tells what a leaf still lacks before a run, or it gives null. The two sessions must
 * be up and the route must be on spine1. Spine2 must hold the other path. Without these, the fault
 * of a run acts on another path, or nothing can take over.
 */
export const leafLacks = (views: LeafViews): string | null => {
  const { up } = sessionsOf(views.neighbors);
  if (up < 2) return `${up} of 2 BGP sessions are up`;
  if (!views.route.includes(` dev ${PREFERRED_DEVICE} `)) return `the route is not on spine1: ${views.route || "no route"}`;
  const paths = (JSON.parse(views.paths) as { paths?: unknown[] }).paths?.length ?? 0;
  if (paths < 2) return `BGP holds ${paths} of 2 paths`;
  if (views.bfd !== null) {
    const peers = JSON.parse(views.bfd) as Array<{ status?: string }>;
    const live = peers.filter((peer) => peer.status === "up").length;
    if (live < 2) return `${live} of 2 BFD peers are up`;
  }
  return null;
};

/**
 * This function gives the later move of the leaves after an instant: for each leaf, the first route
 * to its far network that leaves spine1. It gives null when a leaf has no move. The later move ends
 * the outage in the two directions.
 */
export const laterMove = (routes: readonly RunRoute[], after: number): number | null => {
  const firsts = LEAVES.map(
    (leaf) =>
      routes.find(
        (route) =>
          route.leaf === leaf.name && route.prefix === leaf.remote && route.t > after && !route.deleted && route.dev !== PREFERRED_DEVICE,
      )?.t,
  );
  return firsts.every((t) => t !== undefined) ? Math.max(...(firsts as number[])) : null;
};

/** A fabric lab is the open fabric of a lab. */
export interface FabricLab {
  /** These are the lines of the route monitors of the leaves, on the monotonic clock. */
  readonly routes: readonly RunRoute[];
  /** This method drops each packet of spine1 in one commit, and the links stay up. */
  silence(): Promise<{ t0: number; t1: number }>;
  /** This method ends a silence. */
  clear(): Promise<{ t0: number; t1: number }>;
  /** This method waits until each leaf is on spine1 with each session up. */
  ready(): Promise<void>;
  /** This method gives the count of established sessions of each leaf so far. */
  sessions(): Promise<Readonly<Record<string, number>>>;
  /** This method gives the record of the fabric for a manifest. */
  manifest(): FabricManifest;
  /** This method destroys the routers. */
  close(): Promise<void>;
}

/** These are the parts of a lab that a fabric uses. */
export interface FabricParts {
  readonly fabric: Fabric;
  readonly image: string;
  readonly client: StartedTestContainer;
  readonly server: StartedTestContainer;
  readonly admin: StartedTestContainer;
  readonly injector: StartedTestContainer;
  readonly opened: StartedTestContainer[];
  readonly output: (container: StartedTestContainer, argv: string[]) => Promise<string>;
}

/** This function runs a program on the host and gives its output. Its error holds the stderr of the program. */
const host = (program: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(program, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`${program} ${args.join(" ")}: ${error.message}\n${stderr}`));
    });
  });

const nameOf = (container: StartedTestContainer): string => container.getName().replace(/^\//, "");

/** This function gives a clock pair at this instant. */
const clockPair = (): ClockPair => ({ mono: Number(process.hrtime.bigint()), wall: Date.now() });

/**
 * This function deploys the routers of a lab and joins the client and the target to them. It also
 * starts the sidecars: the injector of spine1 and a route monitor on each leaf. The caller stops the
 * sidecars with the other containers of the lab, and it calls `close` first.
 */
export const openFabric = async (parts: FabricParts): Promise<FabricLab> => {
  const { fabric, image, admin, injector, opened, output } = parts;
  const { GenericContainer } = await import("testcontainers");
  const lab = `e3-${randomBytes(4).toString("hex")}`;
  const dir = await mkdtemp(join(tmpdir(), "fabric-"));
  const file = join(dir, "lab.clab.yml");
  await writeFile(join(dir, "daemons"), DAEMONS);
  for (const router of ROUTERS) await writeFile(join(dir, `${router.name}.conf`), frrConf(router, fabric));
  await writeFile(file, topologyOf(lab, dir, nameOf(parts.client), nameOf(parts.server)));
  const close = async (): Promise<void> => {
    await host("sudo", ["containerlab", "destroy", "-t", file, "--cleanup"]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  const node = (name: string) => `clab-${lab}-${name}`;
  try {
    await host("sudo", ["containerlab", "deploy", "-t", file]);
    const version = /version:\s*(\S+)/.exec(await host("containerlab", ["version"]))?.[1] ?? "unknown";
    await output(admin, ["ip", "addr", "add", `${FABRIC_CLIENT}/24`, "dev", FABRIC_DEVICE]);
    await output(admin, ["ip", "route", "replace", TARGET_NET, "via", "10.1.0.1", "dev", FABRIC_DEVICE]);
    await output(injector, ["ip", "addr", "add", `${FABRIC_TARGET}/24`, "dev", FABRIC_DEVICE]);
    await output(injector, ["ip", "route", "replace", CLIENT_NET, "via", "10.2.0.1", "dev", FABRIC_DEVICE]);

    const silencer = await new GenericContainer(image)
      .withNetworkMode(`container:${node("spine1")}`)
      .withAddedCapabilities("NET_ADMIN", "NET_RAW")
      .start();
    opened.push(silencer);
    const routes: RunRoute[] = [];
    const monitors = new Map<string, StartedTestContainer>();
    for (const leaf of LEAVES) {
      const monitor = await new GenericContainer(image)
        .withNetworkMode(`container:${node(leaf.name)}`)
        .withCommand(["ip", "-ts", "-o", "monitor", "route"])
        .withLogConsumer((stream) => {
          let rest = "";
          stream.on("data", (chunk: Buffer | string) => {
            const text = (rest + chunk.toString()).split("\n");
            rest = text.pop() ?? "";
            for (const each of text) {
              const line = routeLine(each);
              if (line === null) continue;
              const { wall, ...route } = line;
              routes.push({ ...route, leaf: leaf.name, t: monotonicAt(wall, clockPair()) });
            }
          });
        })
        .start();
      opened.push(monitor);
      monitors.set(leaf.name, monitor);
    }
    const stamp = async (action: string): Promise<{ t0: number; t1: number }> => {
      const last = (await output(silencer, ["/opt/harness/inject", action])).split("\n").at(-1)!;
      const { t0, t1 } = JSON.parse(last) as { t0: number; t1: number };
      return { t0, t1 };
    };
    const vtysh = (leaf: string, view: string) => host("docker", ["exec", node(leaf), "vtysh", "-c", view]);
    return {
      routes,
      silence: () => stamp("silence"),
      clear: () => stamp("clear-silence"),
      async ready() {
        const deadline = Date.now() + READY_MS;
        for (;;) {
          const lacks: string[] = [];
          for (const leaf of LEAVES) {
            const prefix = leaf.remote!;
            // a daemon that still starts refuses vtysh: that is one more reason to wait
            const lacking = await (async () =>
              leafLacks({
                neighbors: await vtysh(leaf.name, "show bgp neighbors json"),
                route: `${await output(monitors.get(leaf.name)!, ["ip", "-o", "route", "show", prefix])} `,
                paths: await vtysh(leaf.name, `show bgp ipv4 unicast ${prefix} json`),
                bfd: fabric.bfd === null ? null : await vtysh(leaf.name, "show bfd peers json"),
              }))().catch((error: unknown) => String(error));
            if (lacking !== null) lacks.push(`${leaf.name}: ${lacking}`);
          }
          if (lacks.length === 0) return;
          if (Date.now() > deadline) throw new Error(`the fabric is not ready: ${lacks.join("; ")}`);
          await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
        }
      },
      async sessions() {
        const out: Record<string, number> = {};
        for (const leaf of LEAVES) out[leaf.name] = sessionsOf(await vtysh(leaf.name, "show bgp neighbors json")).established;
        return out;
      },
      manifest: () => ({ ...fabric, image: FRR_IMAGE, containerlab: version }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
};
