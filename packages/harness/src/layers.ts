import type { Cell, Fault, Topology } from "./cell.ts";

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
   * These faults are the faults that a cell of the harness injects on the layer, in the order of
   * `Fault`. The labs of E2 are in `@mark1russell7/kind`, and their steps are not faults of the harness.
   */
  readonly faults: readonly Fault[];
  /** These limits are the resources that a cell of the harness fills on the layer, in the order of `LIMITS`. */
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
    faults: [],
    limits: [],
  },
  E3: {
    name: "A routed fabric of containers on one kernel",
    proves: "Routing protocol timers, equal-cost paths, a change of route, sites with real delay",
    cannot: ["The kernel or the forwarding hardware of a router"],
    tools: ["containerlab with FRR"],
    state: "new",
    faults: ["blackhole", "stall", "silence"],
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

/** This function gives the limits that the law of a cell names, in the order of `LIMITS`. */
export const limitsOf = (cell: Pick<Cell, "prediction">): readonly Limit[] => {
  const laws: Readonly<Record<string, unknown>> = cell.prediction;
  return LIMITS.filter((limit) => laws[limit] !== undefined);
};
