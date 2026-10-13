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
 */
export type Fault = "blackhole" | "freeze-process" | "rst" | "stall";

/**
 * A reference is the event that the time of a detector counts from: the event that arms the
 * timer in its machine document. Keepalive counts from the last received segment. The give-up of
 * the retransmissions counts from the first retransmission of the RTO timer, not from the tail
 * loss probe one RTO before it. The request itself meets a reset, thus a reset counts from the
 * send of the client.
 */
export type Reference = "last-received" | "first-retransmission" | "request-sent";

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
 * A prediction is what a cell predicts. Either a detection occurs in an interval [T_lo, T_hi]
 * after the reference event, or nothing detects the fault in a window. Nothing detects a stall
 * that is shorter than the give-up, and the connection recovers from it. The prediction then also
 * tells when.
 */
export type Prediction =
  | {
      readonly detects: true;
      /** This name is the timer of the machine that fires first, or the event that detects the fault, with its errno. */
      readonly timer: string;
      readonly errno: string;
      readonly from: Reference;
      /** This time is the closed form, less the most that the timer can fire early. */
      readonly low: Quantity;
      /** This time is the closed form, plus the most that the timer can fire late. */
      readonly high: Quantity;
    }
  | { readonly detects: false; readonly window: Quantity; readonly recovers?: Recovers };

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
}

/** A client is what the runs of a cell use: the TCP client of the harness, or a driver on its socket. */
export type Client = "tcp" | "ioredis";

/**
 * An observer is the side whose detection a cell measures. The client is one observer. The
 * server is the other observer. It is the hold of the target on the connection of the client, at
 * its server socket in its namespace. The fault is on the peer of the observer. Thus
 * freeze-process freezes the target for the client, and the client for the server.
 */
export type Observer = "client" | "server";

/** A cell is one cell of the matrix: a topology, its settings, a workload, a fault and the prediction. */
export interface Cell {
  readonly name: string;
  readonly target: Target;
  /** These are the sysctls of the network namespace of the client, as the kernel spells them. The harness sets them before the client connects. */
  readonly sysctls: Readonly<Record<string, string>>;
  readonly probe: {
    /** This mode tells if the client is idle after its first reply, or sends a request into the fault. */
    readonly mode: "idle" | "inflight";
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
  readonly prediction: Prediction;
  /** This side is the side whose detection the cell measures. Without it, the side is the client. */
  readonly observer?: Observer;
  /** These are the settings of the target. The harness sets them in each environment before a client connects. */
  readonly targetSettings?: Readonly<Record<string, string>>;
  /** These are the sysctls of the network namespace of the target, for a cell on the server side: its tcp_retries2. */
  readonly targetSysctls?: Readonly<Record<string, string>>;
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
}
