import type { Fault, Topology } from "./cell.ts";

// This module imports no `node:` module, thus a page in a browser can read the layers (`@mark1russell7/harness/layers`).

/**
 * A layer is a rung of the laboratory (`docs/S7.md`). E1 is containers on one kernel, and E2 is a
 * cluster of containers on one kernel. A lab with `Topology.fabric` writes E3: routers in containers.
 * A lab in a guest of QEMU writes E4 (`substrateHere`). The other layers do not have a runner at this
 * time.
 */
export const LAYERS = ["E0", "E1", "E2", "E3", "E4", "E5", "E6"] as const;
export type Layer = (typeof LAYERS)[number];

/** A layer state is the column "State" of the table of the layers in `docs/S7.md`, by its first word. */
export type LayerState = "today" | "new" | "later" | "waiting";

/**
 * A limit is a resource that the load of a cell fills, with no fault. The four limits are the accept
 * queue, the port range, the conntrack table and the memory of a cgroup. The name of a limit is the key
 * of its law in `Prediction`.
 */
export const LIMITS = ["queue", "ports", "conntrack", "memory"] as const;
export type Limit = (typeof LIMITS)[number];

/**
 * The layer facts are one row of the table of the layers in `docs/S7.md`, and what the cells of the
 * harness apply on the layer. A test holds each text equal to the table. A test of the cells holds
 * `faults` and `limits` equal to the cells of each layer.
 */
export interface LayerFacts {
  /** This text is the column "What it is". */
  readonly name: string;
  /** This text is the column "What it proves". */
  readonly proves: string;
  /** These texts are the column "What it cannot prove", one for each thing. The list is empty for "Nothing that this plan covers". */
  readonly cannot: readonly string[];
  /** These names are the column "Tools". */
  readonly tools: readonly string[];
  readonly state: LayerState;
  /**
   * These names are the faults that the cells of the layer inject, each one time. A name is in the
   * vocabulary of the lab of the layer. The cells of E1 and E3 name a `Fault` of the harness. The cells of
   * E2 are in `@mark1russell7/kind`, and they name the kind of their trigger (`TriggerKind`). The two
   * vocabularies share the names of the faults that they share, for example `blackhole` and `rst`.
   */
  readonly faults: readonly string[];
  /** These limits are the resources that the load of the cells of the layer fills, in the order of `LIMITS`. */
  readonly limits: readonly Limit[];
}

/** These are the faults of a cell of one kernel: each fault of the harness except the silence of a fabric. */
const ONE_KERNEL: readonly Fault[] = [
  "blackhole",
  "freeze-process",
  "rst",
  "stall",
  "fin",
  "unreachable",
  "simplex",
  "mtu-blackhole",
  "netem",
  "fin-ack",
  "middlebox-forget",
  "proxy-idle",
  "toxic",
  "server-close",
  "partition",
  "planned-failover",
  "app-stall",
  "step-down",
  "drain",
  "hop-event",
];

/** These are the faults of a cell of kind: each kind of a trigger of `@mark1russell7/kind`, in the order of `TriggerKind`. */
const ON_KIND: readonly string[] = [
  "pod-deletion",
  "rolling-update",
  "node-drain",
  "scale-in",
  "crash",
  "liveness-restart",
  "freeze-process",
  "rst",
  "blackhole",
  "peer-gone-without-close",
  "app-stall",
  "rollout",
  "cpu-throttle",
  "authorization-policy",
  "idle",
  "ztunnel-restart",
  "certificate-expiry",
  "cannot-serve",
  "zone-loss",
  "latency",
  "dns-blackhole",
];

/** These are the facts of each layer. The texts come from the table of the layers in `docs/S7.md`. */
export const LAYER_FACTS: Readonly<Record<Layer, LayerFacts>> = {
  E0: {
    name: "Code on a false clock",
    proves: "The logic of a state machine and each order of its events",
    cannot: ["Any real time"],
    tools: ["algebra", "the service conformance kit"],
    state: "today",
    faults: [],
    limits: [],
  },
  E1: {
    name: "Processes and containers on one kernel",
    proves: "Linux TCP timers, stock servers and their clients, proxies, conntrack",
    cannot: ["A second kernel", "A separate clock", "A reboot", "A loss of power"],
    tools: ["The harness"],
    state: "today",
    faults: ONE_KERNEL,
    limits: LIMITS,
  },
  E2: {
    name: "A cluster of containers on one kernel",
    proves: "The control plane, Service rules, CNI and the lifecycle of a pod",
    cannot: ["A kernel for each node", "A loss of a node with no signal"],
    tools: ["kind", "k3d"],
    state: "today",
    faults: ON_KIND,
    limits: [],
  },
  E3: {
    name: "A routed fabric of containers on one kernel",
    proves: "Routing protocol timers, equal-cost paths, a change of route, sites with real delay",
    cannot: ["The kernel or the forwarding hardware of a router"],
    tools: ["containerlab with FRR"],
    state: "new",
    faults: ["blackhole", "stall", "silence"] satisfies readonly Fault[],
    limits: [],
  },
  E4: {
    name: "Virtual machines, each with its own kernel",
    proves: "A chosen kernel and HZ, a clock for each node, a loss of power, a disk, a reboot",
    cannot: ["A physical NIC", "Real zones"],
    tools: ["QEMU", "k3s in a VM"],
    state: "new",
    faults: [],
    limits: [],
  },
  E5: {
    name: "Images of vendor routers in virtual machines",
    proves: "The defaults and the state machines of a vendor's control plane",
    cannot: ["The forwarding chip of the router"],
    tools: ["vrnetlab"],
    state: "later",
    faults: [],
    limits: [],
  },
  E6: {
    name: "Real hardware and clouds",
    proves: "A physical NIC, firmware, managed load balancers, real zones",
    cannot: [],
    tools: ["HW-1"],
    state: "waiting",
    faults: [],
    limits: [],
  },
};

/** This function gives the layer of a lab of the harness from its topology: E3 with a fabric, E1 without one. */
export const layerOf = (topology: Topology | undefined): Layer => (topology?.fabric === undefined ? "E1" : "E3");

/**
 * This function gives the limits that the prediction of a cell names, in the order of `LIMITS`. It reads
 * a cell of the harness or of `@mark1russell7/kind`.
 */
export const limitsOf = (cell: { readonly prediction: object }): readonly Limit[] => {
  const laws = new Map(Object.entries(cell.prediction));
  return LIMITS.filter((limit) => laws.get(limit) !== undefined);
};
