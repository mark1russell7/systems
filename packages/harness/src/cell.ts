import type { KernelRecord } from "@mark1russell7/prober";
import type { Quantity } from "@mark1russell7/quantity";

export type { KernelRecord };

/**
 * A fault is a failure that the harness injects, by the name of its manifestation. Each name is
 * the last segment of the identifier of the manifestation in the corpus:
 * - `blackhole` is two DROP rules in the network namespace of the target. Thus the measurement
 *   gets the kernel timers of the client.
 * - `freeze-process` is the cgroup freezer on the target, while its kernel stays up.
 * - `rst` answers the next segment of the client with a reset, from the namespace of the target.
 *   It is the reference for the noise of the harness itself.
 * - `stall` is a black hole that stops by itself, `Cell.stall` after the client sends its
 *   request. The VM times it. It shows what recovers, and when.
 * - `fin` stops the process of the peer with SIGKILL, while its kernel stays up. The kernel closes its sockets
 *   with a FIN, or with a reset when unread data is in the queue.
 * - `unreachable` answers each segment from the observer with an ICMP unreachable (`Cell.icmp`).
 *   Linux keeps it as a soft error on an established socket, and it continues to retransmit.
 * - `simplex` drops the segments in one direction only (`Cell.drops`).
 * - `mtu-blackhole` drops each segment to the observer that is longer than `Cell.mtu` bytes.
 * - `netem` is tc netem on the egress of the target (`Cell.netem`): loss, duplication,
 *   reordering or corruption. Its outcome is a distribution.
 *
 * These faults are of a topology (`Cell.topology`):
 * - `middlebox-forget` injects nothing. The router of the topology forgets an idle flow at its own
 *   idle timeout, and its form tells what a late packet then meets.
 * - `proxy-idle` injects nothing. The proxy of the topology closes an idle connection at its own
 *   timeout.
 * - `toxic` adds a toxic of Toxiproxy (`Cell.toxic`) through its HTTP API.
 * - `server-close` makes the server close the connection of its peer, with the command of the
 *   target (`Target.close`): `CLIENT KILL` in Redis.
 */
export type Fault =
  | "blackhole"
  | "freeze-process"
  | "rst"
  | "stall"
  | "fin"
  | "unreachable"
  | "simplex"
  | "mtu-blackhole"
  | "netem"
  | "middlebox-forget"
  | "proxy-idle"
  | "toxic"
  | "server-close";

/**
 * A middlebox form tells what a router does with a flow that it forgot, when a late packet comes:
 * - `reset-both` sends a reset to the two ends when it forgets the flow.
 * - `reset-next` answers the next packet from inside with a reset to its sender, and drops a late
 *   packet from outside.
 * - `silent-drop` drops each late packet, in each direction.
 * - `recreate` lets a late packet from inside through, and the flow starts again. It drops a late
 *   packet from outside.
 * - `none` is a plain NAT router. A late packet from inside starts the flow again, and the stack of
 *   the router answers a late packet from outside with a reset.
 */
export type MiddleboxForm = "reset-both" | "reset-next" | "silent-drop" | "recreate" | "none";

/**
 * A router is a hop that forwards and translates the addresses of the side of the client (NAT),
 * with conntrack. It is the router image of the harness.
 */
export interface RouterHop {
  readonly name: string;
  readonly kind: "router";
  readonly form: MiddleboxForm;
  /** This time is the idle timeout of an established flow: nf_conntrack_tcp_timeout_established, in whole seconds. */
  readonly idle: Quantity;
  /**
   * This time is the interval of the listing that evicts each expired flow. Without it, the
   * interval is 0.1 s. The DESTROY event of an expired flow waits for that listing.
   */
  readonly pump?: Quantity;
}

/**
 * A proxy is a hop that ends each TCP connection from the side of the client and opens its own to
 * the next hop. It is a stock image, pinned by digest.
 */
export interface ProxyHop {
  readonly name: string;
  readonly kind: "proxy";
  readonly image: string;
  /** This port is the port that the proxy listens on for the side of the client. */
  readonly port: number;
  readonly command?: readonly string[];
  /** These files go into the proxy before it starts, by their path. In their content, {{next}} is the address and port of the next hop. */
  readonly files?: Readonly<Record<string, string>>;
  /** This text is the log line that tells that the proxy serves. */
  readonly ready?: string;
  /** This record is the HTTP API of Toxiproxy: its port, and the name of the proxy that gets the toxics. */
  readonly api?: { readonly port: number; readonly proxy: string };
  /** These are the sysctls of the namespace of the proxy. A privileged sidecar sets them before each run. */
  readonly sysctls?: Readonly<Record<string, string>>;
  /** These are the settings of the proxy, for the manifest: for example its idle timeouts. */
  readonly settings?: Readonly<Record<string, string>>;
}

/**
 * A hop is one box between the client and the target. Each hop is on two networks: the network
 * of the side of the client, and the network of the side of the target.
 */
export type Hop = RouterHop | ProxyHop;

/**
 * A topology is the chain of hops between the client and the target, in sequence from the client.
 * Without hops, the client and the target are a direct pair.
 */
export interface Topology {
  readonly name: string;
  readonly hops: readonly Hop[];
}

/** A toxic is one toxic of Toxiproxy, as its API takes it. Its toxicity is 1. */
export interface Toxic {
  readonly type:
    | "latency"
    | "timeout"
    | "reset_peer"
    | "slow_close"
    | "bandwidth"
    | "limit_data"
    | "slicer";
  readonly stream: "downstream" | "upstream";
  readonly attributes: Readonly<Record<string, number>>;
}

/**
 * A reference is the event that the time of a detector counts from: the event that arms the
 * timer in its machine document. Keepalive counts from the last received segment. The give-up of
 * the retransmissions counts from the first retransmission of the RTO timer, not from the tail
 * loss probe one RTO before it. The request itself meets a reset, thus a reset counts from the
 * send of the client. A FIN counts from the change of state of the socket of the peer when its
 * process dies (`peer-closed`). A toxic of Toxiproxy counts from the start of its commit, as the
 * injector stamps it (`fault`).
 */
export type Reference =
  | "last-received"
  | "first-retransmission"
  | "request-sent"
  | "peer-closed"
  | "fault";

/**
 * This prediction tells when a connection moves again after a stall. That occurs at the first
 * firing of its retransmission timer after the stall stops, and its reply comes back one round
 * trip later.
 */
export interface Recovers {
  /** This count identifies the firing that gets through: the number of firings before it. */
  readonly firing: number;
  /** This time is the earliest return of the reply, from the send of the request. */
  readonly low: Quantity;
  /** This time is the latest return of the reply, from the send of the request. */
  readonly high: Quantity;
  /**
   * This range is where the stall must stop, from the send, so that this firing is the first
   * after it. The range starts after the latest time of the firing before, and it stops before
   * the earliest time of this firing.
   */
  readonly heal: { readonly low: Quantity; readonly high: Quantity };
}

/**
 * This prediction tells when the reply to the request comes back, from the send of the request.
 * For example, the reply comes after the latency of a toxic, or after a forgotten flow starts again.
 */
export interface Replies {
  readonly low: Quantity;
  readonly high: Quantity;
}

/**
 * A prediction is what a cell predicts. Either a detection occurs in an interval [T_lo, T_hi]
 * after the reference event, or nothing detects the fault in a window. Nothing detects a stall
 * that is shorter than the give-up, and the connection recovers from it. The prediction then also
 * tells when. A silent prediction can also tell when the reply to the request comes back
 * (`replies`).
 *
 * A cell whose outcome is a distribution, for example under netem loss, has no band. Its
 * prediction is `detects: null` with the reason, and its runs are measurements only. A
 * measurement-only cell that names a reference (`from`) also records the time from it to the end
 * of the connection, or to the last data.
 */
export type Prediction =
  | {
      readonly detects: true;
      /** This name is the timer of the machine that fires first, or the event that detects the fault, with its errno. */
      readonly timer: string;
      /** This name is the errno of the detection, or EOF for an end of file without an error. */
      readonly errno: string;
      readonly from: Reference;
      /** This time is the closed form, less the most that the timer can fire early. */
      readonly low: Quantity;
      /** This time is the closed form, plus the most that the timer can fire late. */
      readonly high: Quantity;
    }
  | {
      readonly detects: false;
      readonly window: Quantity;
      readonly recovers?: Recovers;
      readonly replies?: Replies;
    }
  | {
      readonly detects: null;
      readonly window: Quantity;
      readonly why: string;
      readonly from?: Reference;
    };

/** A target is the server that a cell connects to: a stock image. */
export interface Target {
  /** This image is a stock image, pinned by digest. */
  readonly image: string;
  readonly port: number;
  /** This text is the log line that tells that the target serves. */
  readonly ready: string;
  /**
   * These commands set and read one setting of the target, as argv in it. The name and the value
   * come after them: `redis-cli CONFIG SET` and `CONFIG GET` for Redis. Without them, the target
   * has no settings to set.
   */
  readonly settings?: { readonly set: readonly string[]; readonly get: readonly string[] };
  /**
   * This command replaces the command of the image, for example a shell that holds the server
   * process as its child. Then a `fin` fault can stop the server, and the container stays up.
   */
  readonly command?: readonly string[];
  /** This command stops the server process in the target with SIGKILL, as argv, for a `fin` fault. */
  readonly kill?: readonly string[];
  /** This command makes the server close the connection of each client, as argv, for a `server-close` fault. */
  readonly close?: readonly string[];
}

/** A client is what the runs of a cell use: the TCP client of the harness, or a driver on its socket. */
export type Client = "tcp" | "ioredis";

/**
 * A client image is a process that a lab starts as the client of each run, in the network
 * namespace of the client. An example is an agent of an application on Node. Its command gets the
 * arguments of the TCP client of the harness. These are the address and the port of the target, then
 * the options of the cell. It writes JSON lines with an `ev` and a `t` (CLOCK_MONOTONIC in
 * nanoseconds) on its standard output, as the client of the harness does.
 */
export interface ClientImage {
  readonly image: string;
  readonly command: readonly string[];
}

/**
 * An observer is the side whose detection a cell measures. The client is one observer. The
 * server is another observer. It is the hold of the target on the connection of the client, at
 * its server socket in its namespace. The fault is on the peer of the observer. Thus
 * freeze-process freezes the target for the client, and the client for the server.
 *
 * A proxy of a topology is the third observer: its socket toward the client, or its socket toward
 * the target.
 */
export type Observer =
  | "client"
  | "server"
  | { readonly hop: string; readonly toward: "client" | "target" };

/** A cell is one cell of the matrix: a topology, its settings, a workload, a fault and the prediction. */
export interface Cell {
  readonly name: string;
  readonly target: Target;
  /** These are the sysctls of the network namespace of the client, as the kernel spells them. The harness sets them before the client connects. */
  readonly sysctls: Readonly<Record<string, string>>;
  readonly probe: {
    /**
     * This mode tells if the client is idle after its first reply, or sends a request into the
     * fault. In a stream, it sends `count` requests into it, each `interval` after the reply before.
     */
    readonly mode: "idle" | "inflight" | "stream";
    /** This count is the number of requests of a stream. */
    readonly count?: number;
    /** This time is the pause after each reply of a stream, before the next request. */
    readonly interval?: Quantity;
    /** This flag sets SO_KEEPALIVE without overrides for the socket: the keepalive sysctls of the namespace apply. */
    readonly keepalive: boolean;
    /** This time sets TCP_USER_TIMEOUT. Without it, the default of the kernel (off) applies. */
    readonly userTimeout?: Quantity;
    /**
     * This text is the request that an in-flight run sends, as a Redis inline command. Without it,
     * the request is PING. BLPOP with a timeout makes the server answer only at the timeout. Thus
     * a cell on the server side has a reply in flight when the fault occurs.
     */
    readonly request?: string;
    /**
     * This driver replaces the TCP client of the harness, with its own options. It is ioredis 6 on
     * Node, whose keepAlive is the keepalive delay of the socket. The driver then ignores `keepalive`
     * and `userTimeout`.
     */
    readonly driver?: { readonly name: "ioredis"; readonly keepAlive: Quantity };
  };
  readonly fault: Fault;
  /** This time is the length of a stall, from the send of the request. */
  readonly stall?: Quantity;
  /** This code is the ICMP unreachable of an `unreachable` fault. */
  readonly icmp?: "host" | "net" | "port" | "admin";
  /** This direction is the one that a `simplex` fault drops: the segments to the server, or to the client. */
  readonly drops?: "to-server" | "to-client";
  /** This length is the longest segment, in bytes, that an `mtu-blackhole` fault lets through to the observer. */
  readonly mtu?: number;
  /** This specification is the tc netem of a `netem` fault, on the egress of the target: for example "loss 5%". */
  readonly netem?: string;
  /**
   * This delay goes on the egress of the target before the client connects, with tc netem. Thus
   * each round trip is longer by the delay, and so is the RTO.
   */
  readonly latency?: Quantity;
  /** These commands run in the target before a client connects, each as argv: for example, a large value to read. */
  readonly targetSetup?: readonly (readonly string[])[];
  readonly prediction: Prediction;
  /** This side is the side whose detection the cell measures. Without it, the side is the client. */
  readonly observer?: Observer;
  /** These are the settings of the target. The harness sets them in each environment before a client connects. */
  readonly targetSettings?: Readonly<Record<string, string>>;
  /** These are the sysctls of the network namespace of the target, for a cell on the server side: its tcp_retries2. */
  readonly targetSysctls?: Readonly<Record<string, string>>;
  /** This topology puts hops between the client and the target. Without it, the client and the target are a direct pair. */
  readonly topology?: Topology;
  /** This place is where the fault goes, when it is not the peer of the observer: for example one side of a proxy. */
  readonly faultAt?: FaultPlace;
  /** This time is how long an in-flight client stays idle after the fault holds, before it sends its request. */
  readonly idleBefore?: Quantity;
  /** This toxic is the toxic of a `toxic` fault, which the Toxiproxy hop gets. */
  readonly toxic?: Toxic;
  /** This image replaces the TCP client of the harness for each run. */
  readonly client?: ClientImage;
  /** This count is the number of runs of the cell (11), across new environments (two at least). */
  readonly runs: number;
  readonly environments: number;
  /**
   * This count is the number of environments at the same time, each with its own prober. Without
   * it, the count is one. The calibration does its reference cells at 1, 4 and 8, to find how
   * many environments the machine holds before its noise increases.
   */
  readonly concurrency?: number;
}

/**
 * A fault place is the namespace that gets the rules of a fault. "target" and "client" are the two
 * ends. A hop place is a hop, with the side that the rules face. That side is the next hop toward
 * the client, or the next hop toward the target.
 */
export type FaultPlace =
  | "target"
  | "client"
  | { readonly hop: string; readonly toward: "client" | "target" };

/** A middlebox event is one line of the router: a change of a conntrack entry, or a reset that it sent. `t` is CLOCK_MONOTONIC in nanoseconds. */
export interface MiddleboxEvent {
  readonly ev: string;
  readonly t: number;
  readonly [field: string]: unknown;
}

/** A probe event is one line that the client wrote. `t` is CLOCK_MONOTONIC in nanoseconds: an instant, not an amount. */
export interface ProbeEvent {
  readonly ev: string;
  readonly t: number;
  readonly [field: string]: unknown;
}

/** A run is one run of a cell, as the harness records it. */
export interface Run {
  readonly environment: number;
  readonly index: number;
  /**
   * This flag marks the warm-up of an environment. It occurs before the counted runs, and the
   * verdict does not count it. On a loaded machine, a new environment is sometimes slow at first.
   */
  readonly warmup?: true;
  readonly events: readonly ProbeEvent[];
  /** This bracket is the time of the injector around the commit of the fault, on the same clock. It is null for a freeze. */
  readonly fault: { readonly t0: number; readonly t1: number } | null;
  /** This bracket is the time around the commit that stopped a stall. */
  readonly heal?: { readonly t0: number; readonly t1: number } | null;
  /** These are the records of the prober from the start to the end of the run, in the two namespaces. */
  readonly kernel: readonly KernelRecord[];
  /** This inode identifies the network namespace of the client, thus the records of the client. */
  readonly netns: number;
  /** This inode identifies the namespace of the target, where the records of its server socket are. */
  readonly targetNetns: number;
  /**
   * This count is the number of records that the prober lost in the run. One lost record makes
   * the run void. Null also makes the run void: no clock line came after the run to tell the count.
   */
  readonly lost: number | null;
  /** These are the addresses and the namespaces of a topology, which the measurement of a run reads. */
  readonly topology?: RunTopology;
  /** These are the lines of the routers of a topology from the start to the end of the run. */
  readonly middlebox?: readonly MiddleboxEvent[];
}

/**
 * A run topology tells where each socket of a run is, in a topology:
 * - `targetPeer` is the address of the peer of the target, as the target sees it: the address of
 *   the last hop.
 * - `hops` are the network namespaces of the hops, by their names, with the address of the peer of
 *   each hop on each side.
 */
export interface RunTopology {
  readonly targetPeer: string;
  readonly hops: Readonly<
    Record<string, { readonly netns: number; readonly client: string; readonly target: string }>
  >;
}
