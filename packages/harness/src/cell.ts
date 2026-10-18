import type { KernelRecord } from "@mark1russell7/prober";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";

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
 * - `none` injects nothing. A calibration cell measures the path itself: for example the time of a
 *   proxy between its two sockets (`Cell.calibrates`).
 *
 * A fault at a router of the topology (`Cell.faultAt`) acts on what the router forwards toward
 * one side. It is a black hole, a reset or an ICMP unreachable. It can also be a simplex drop, an
 * MTU drop or netem.
 *
 * These faults are of a replicated group (`Cell.group` or `Cell.replicaSet`), on the part that `Cell.faultAt` names:
 * - `blackhole` drops each segment between the part and each of its peers. `rst` answers each
 *   segment from a peer with a reset, thus the part refuses each connection.
 * - `partition` is a black hole between the part and some of its peers only (`GroupPlace.cuts`).
 * - `freeze-process` stops the server process of the part with SIGSTOP, and SIGCONT thaws it. Its
 *   kernel stays up. `fin` stops the process with SIGKILL.
 * - `planned-failover` asks a Sentinel for a failover: `SENTINEL FAILOVER <group>`.
 *
 * This fault is of an HTTP server or of PostgreSQL:
 * - `app-stall` injects nothing. The server process holds the reply to the request, because the
 *   request asks for that, while its kernel stays up. An HTTP request asks with `HttpProbe.hold`,
 *   and a query of PostgreSQL with its text, for example `SELECT pg_sleep(20)`.
 *
 * This fault is of a replica set (`Cell.replicaSet`):
 * - `step-down` sends `replSetStepDown` to the primary, as a client sends a command.
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
  | "server-close"
  | "partition"
  | "planned-failover"
  | "app-stall"
  | "step-down"
  | "none";

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
  /**
   * These are the sysctls of the namespace of the router, which the router sets itself: it is
   * privileged. An example is `net.ipv4.icmp_ratelimit` for the ICMP errors of a fault at the router.
   */
  readonly sysctls?: Readonly<Record<string, string>>;
}

/**
 * A proxy is a hop that ends each TCP connection from the side of the client and opens its own to
 * the next hop. It is a stock image, pinned by digest, or an image that the harness ships, for
 * example PgBouncer (`{ kind: "shipped", name: "pgbouncer" }`).
 */
export interface ProxyHop {
  readonly name: string;
  readonly kind: "proxy";
  readonly image: string | ImageSource;
  /** This port is the port that the proxy listens on for the side of the client. */
  readonly port: number;
  readonly command?: readonly string[];
  /**
   * These files go into the proxy before it starts, by their path. In their content, {{next}} is
   * the address and port of the next hop, and {{next.host}} and {{next.port}} are each part.
   */
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

/**
 * A group is a replicated group under an external failover authority, as data. It is a primary and
 * its replicas, and the Sentinels that decide which member is the primary. Each member and each
 * Sentinel is a container from the same stock image, pinned by digest. Each has its own network
 * namespace, thus a fault can act on one part. The client finds the primary through the
 * Sentinels, and the parts and the client share one network.
 */
export interface Group {
  /** This name is the name of the group that the Sentinels monitor, for example `mymaster`. */
  readonly name: string;
  /** This image is the stock image of each member and each Sentinel, pinned by digest. */
  readonly image: string;
  /** These are the programs of the image: the server, the Sentinel and the command line client. */
  readonly programs: { readonly server: string; readonly sentinel: string; readonly cli: string };
  readonly port: number;
  readonly sentinelPort: number;
  /** These are the names of the members. The first one is the primary when the environment starts. */
  readonly members: readonly string[];
  readonly sentinels: readonly string[];
  /** This count is how many Sentinels must agree that the primary is down. */
  readonly quorum: number;
  /** These are the settings of each member, as its configuration file spells them. The harness adds `replicaof` for each replica. */
  readonly memberSettings: Readonly<Record<string, string>>;
  /**
   * These are the settings of each Sentinel for the group, as `sentinel <setting> <group> <value>`
   * spells them: `down-after-milliseconds`, `failover-timeout` and `parallel-syncs`.
   */
  readonly sentinelSettings: Readonly<Record<string, string>>;
  /** These lines tell that a member and a Sentinel serve. */
  readonly ready: { readonly member: string; readonly sentinel: string };
}

/**
 * A replica set is a replicated group with no external authority, as data: its members elect their
 * own primary. Each member is a container from the same stock image, pinned by digest, in its own
 * network namespace. The client finds the primary by its own monitors. The harness starts the set
 * with the address of each member, and it waits for a primary.
 */
export interface ReplicaSet {
  /** This name is the name of the set, for example `rs0`. */
  readonly name: string;
  /** This image is the stock image of each member, pinned by digest. */
  readonly image: string;
  /** These are the programs of the image: the server and its shell. */
  readonly programs: { readonly server: string; readonly shell: string };
  /** These are the options of the server of each member, after the name of the set: for example the size of its cache. */
  readonly args?: readonly string[];
  readonly port: number;
  /** These are the names of the members. The first one starts the set. */
  readonly members: readonly string[];
  /** These are the settings of the configuration of the set, as `rs.initiate` takes them: for example `electionTimeoutMillis`. */
  readonly settings: Readonly<Record<string, number>>;
  /** This line tells that a member serves. */
  readonly ready: string;
}

/** A group role is a part of a group by its role at the start of a run: the primary, a replica, or a Sentinel. */
export type GroupRole = "primary" | "replica" | "sentinel";

/**
 * A group place is the part of a group that a fault acts on. A network fault cuts the part from
 * some of its peers:
 * - `all`: each other part of the group, and each client. This is the default.
 * - `group`: the other members and the Sentinels, but not the clients.
 * - `clients`: the clients, but not the group.
 * - `one`: one other member, in both directions.
 * - `one-way`: one other member, for the segments from the part only.
 */
export interface GroupPlace {
  readonly role: GroupRole;
  readonly cuts?: "all" | "group" | "clients" | "one" | "one-way";
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
 *
 * A client that starts into a fault counts from its `connecting` line, or from its first line
 * without one (`client-start`).
 *
 * A heartbeat of a program counts from its first ping that got no answer (`ping-sent`). The
 * program writes a `ping` line before each ping, and the kernel stamps the write (`tx`). No
 * segment with data reaches the socket after that write, up to the detection.
 *
 * A check of a pool on an idle connection counts from the first segment with data that the socket
 * sends after the fault (`first-sent`). The keepalive of HikariCP comes at a phase from the
 * creation of its connection, thus no line of the client gives its time. The kernel stamps it.
 */
export type Reference =
  | "last-received"
  | "first-retransmission"
  | "request-sent"
  | "peer-closed"
  | "fault"
  | "client-start"
  | "ping-sent"
  | "first-sent";

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
 * An RTT range is the range of the first round trip of the observer that a band assumes. The
 * models read a round trip, for example 1 ms. The band at that value holds within the noise for
 * each round trip in the range. A run whose first round trip is above the range is void.
 */
export interface RttRange {
  readonly low: Quantity;
  readonly high: Quantity;
}

/**
 * A proxy time is the time of one proxy in one direction that a band includes. It is an upper
 * quantile of the times that a calibration cell of the proxy measured. Each time goes from an
 * arrival on one socket of the proxy to its write on the other. `up` goes toward the target, and
 * `down` toward the client.
 */
export interface ProxyTime {
  readonly hop: string;
  readonly direction: "up" | "down";
  /** This fraction is the quantile of the calibration, for example 0.99. */
  readonly quantile: number;
  readonly time: Quantity;
}

/**
 * A stage is one step of the timeline of a group after a fault, by the event that a Sentinel
 * publishes for it. The stages are the subjective down, the objective down, the start of a
 * failover and the election. Then the selection of a replica, the promotion, the switch to the new
 * primary, and the conversion of the old primary into a replica.
 */
export type SentinelStage =
  | "+sdown"
  | "+odown"
  | "+try-failover"
  | "+elected-leader"
  | "+selected-slave"
  | "+promoted-slave"
  | "+switch-master"
  | "+convert-to-slave";

/**
 * A replica set stage is one step of the timeline of a replica set after a fault. A line of the log
 * of a member marks it, or a line of the client. The stages are a member that marks the primary
 * DOWN, the start of an election and its win, and the end of the catch-up. Then come the first
 * write of the new primary and the step-down of the old one. The client's lines give its discovery
 * of the new primary, the write-off of the old one, and the first write that a primary accepts.
 */
export type ReplicaSetStage =
  | "member-down"
  | "election-start"
  | "elected"
  | "caught-up"
  | "writable"
  | "old-primary-steps-down"
  | "discovered"
  | "written-off"
  | "first-write";

/** A stage is one step of the timeline of a group: of a group under Sentinels, or of a replica set. */
export type Stage = SentinelStage | ReplicaSetStage;

/** A stage band is when the first part announces a stage, from the reference of the cell. */
export interface StageBand {
  readonly stage: Stage;
  readonly low: Quantity;
  readonly high: Quantity;
}

/**
 * A group prediction tells what a group does after the fault, beside the band of its cell:
 * - `lands` is the primary that the first accepted write after the fault lands on: a new one, or the same one.
 * - `failover` tells if a Sentinel announces a switch to a new primary in the window.
 * - `stages` are the bands of the stages of the timeline. Each band includes the error of the
 *   stamps of the observer (`stamps`).
 * - `errors` are the errors that the client must meet on the way, each with the band of its
 *   first occurrence. An example is the error of the offline queue when it gives up.
 * - `quiet` are the stages that must not occur after the fault. Each one that a run shows is a finding.
 */
export interface GroupPrediction {
  readonly lands: "new" | "same";
  readonly failover: boolean;
  readonly stages: readonly StageBand[];
  readonly stamps?: Quantity;
  readonly errors?: ReadonlyArray<{ readonly name: string; readonly low: Quantity; readonly high: Quantity }>;
  readonly quiet?: readonly Stage[];
}

/**
 * A middlebox expectation tells what the router of a topology does with the flow in the window of
 * a silent prediction. Without it, the router keeps the flow. With `forgets`, the router forgets
 * the flow in that band after the last segment of the client, and nothing detects it.
 */
export interface MiddleboxExpectation {
  readonly forgets: { readonly low: Quantity; readonly high: Quantity };
}

/**
 * A request prediction tells what the second request of an HTTP client meets, beside the band of
 * its cell. The client writes it in its lines: the connection of each try, and the outcome.
 * - `connection` is the connection of its first try: the one that the first request used
 *   (`reused`), or a new one.
 * - `retried` tells that the client sent it again on a new connection by itself.
 * - `error` is the error that reaches the caller, or null for a reply.
 * - `pending` tells that nothing ends the request in the window of the cell.
 */
export interface RequestPrediction {
  readonly connection: "reused" | "new";
  readonly retried: boolean;
  readonly error: string | null;
  readonly pending?: true;
}

/**
 * A line match is a line of the client that a driver band waits for. It has the `ev` of the line,
 * and the value of each field that it names. A dotted name is a field in a field, for example
 * `failure.name`. `name` is the field that names the error of the line, for its outcome.
 */
export interface LineMatch {
  readonly ev: string;
  readonly where?: Readonly<Record<string, string | number | boolean>>;
  readonly name?: string;
}

/**
 * A driver step is one more band of a driver after the band of its cell. An example is the error
 * of the retry after the interruption. It has its own reference on a socket of the driver, its
 * line, and its band. A run whose step is outside its band, or absent, has a finding.
 */
export interface DriverStep {
  readonly what: string;
  /** This name is the name of the error of the line, or OK. */
  readonly name: string;
  /** This role is the socket of the reference. Without it, the socket is the socket of the band of the cell. */
  readonly socket?: string;
  readonly from: Reference;
  readonly ends: LineMatch;
  readonly low: Quantity;
  readonly high: Quantity;
}

/**
 * A driver band is a band of a cell whose client is a driver with more than one socket, for
 * example the MongoDB driver. It names the socket of the reference, and the line that ends the
 * band:
 * - `socket` is the role of the socket, as the client names it in its `socket` lines. The socket
 *   `server` is the socket of the target for the first connection of the pool.
 * - `ends` is the line of the client that marks the detection. Without it, the detection is the
 *   report of the kernel on the socket: an error, or the end of the file.
 * - `reply` is the line of a reply that a silent prediction times (`replies`), with its reference.
 * - `quiet` are the lines that must not occur after the fault, in the window of the prediction.
 * - `then` are the later bands, each one a test of its own.
 *
 * A band whose line ends it is a timer of the driver. Its `last-received` is the last segment with
 * data that its socket received or sent. The idle timer of a Node socket starts again at each read
 * and each write. A band of the kernel counts from the last segment of any kind that the socket
 * received.
 */
export interface DriverBand {
  readonly socket: string;
  readonly ends?: LineMatch;
  readonly reply?: { readonly from: Reference; readonly ends: LineMatch };
  readonly quiet?: readonly LineMatch[];
  readonly then?: readonly DriverStep[];
}

/**
 * A reconnect prediction tells when the program of the client tries a new connection after the
 * detection. Each wait counts from the start of the reconnect timer of the program (a
 * `reconnecting` line) to the try (a `dial` line). The first wait follows the detection, and each
 * next wait follows the failure of the try before it.
 */
export interface Reconnects {
  readonly waits: ReadonlyArray<{ readonly low: Quantity; readonly high: Quantity }>;
}

/**
 * A prediction is what a cell predicts. Either a detection occurs in an interval [T_lo, T_hi]
 * after the reference event, or nothing detects the fault in a window. Nothing detects a stall
 * that is shorter than the give-up, and the connection recovers from it. The prediction then also
 * tells when. A silent prediction can also tell when the reply to the request comes back
 * (`replies`), and what a router does with the flow (`middlebox`).
 *
 * A band can name the first round trip that it assumes (`rtt`), and the proxy times that it
 * includes (`through`).
 *
 * A cell whose outcome is a distribution, for example under netem loss, has no band. Its
 * prediction is `detects: null` with the reason, and its runs are measurements only. A
 * measurement-only cell that names a reference (`from`) also records the time from it to the end
 * of the connection, or to the last data. It can also give the waits of the reconnect after that
 * end (`reconnects`).
 *
 * For a group cell, the band is the first write that a primary accepts after the fault, and its
 * errno is `OK`. `group` tells which primary, and the stages of the group on the way.
 *
 * For an HTTP cell, `request` tells what the second request meets. The errno `CLOSED` is a close
 * of the observer itself: its pool closes an idle connection, a FIN that it sends.
 *
 * A band of a driver (`driver`) counts from a socket of the driver to a line of the client.
 *
 * The errno `DROPPED` is a drop by the program of the observer itself. Its own timer gave up, and
 * it closed its socket or wrote a close frame. A detection can also tell when the client tries a
 * new connection (`reconnects`).
 */
export type Prediction =
  | {
      readonly detects: true;
      /** This name is the timer of the machine that fires first, or the event that detects the fault, with its errno. */
      readonly timer: string;
      /**
       * This name is the errno of the detection, or EOF for an end of file without an error. It is
       * OK for a write that a primary accepts, and CLOSED for a close of the observer itself. It is
       * DROPPED for a drop by the program of the observer.
       */
      readonly errno: string;
      readonly from: Reference;
      /** This time is the closed form, less the most that the timer can fire early. */
      readonly low: Quantity;
      /** This time is the closed form, plus the most that the timer can fire late, plus each proxy time. */
      readonly high: Quantity;
      /**
       * This time is the latest reference of the band after the reply of the client. It is for a
       * reference that can come late, for example the first ping without an answer of a server
       * heartbeat. The run then waits that much longer for the detection.
       */
      readonly startsBy?: Quantity;
      readonly rtt?: RttRange;
      readonly through?: readonly ProxyTime[];
      readonly group?: GroupPrediction;
      readonly request?: RequestPrediction;
      readonly driver?: DriverBand;
      readonly reconnects?: Reconnects;
      /**
       * This name tells how the program drops the connection, for the errno DROPPED. A close frame
       * leaves its socket ESTABLISHED below (`frame`). A close of its socket takes it out of
       * ESTABLISHED at once (`close`).
       */
      readonly drop?: "frame" | "close";
      /**
       * This flag tells that the program of the observer is the client process, which ends at the
       * end of the run. Its kernel then closes each socket that is still open. A close of the
       * socket at that end is not a close by the program, thus `left` stays null for it (`exited`).
       */
      readonly exits?: true;
    }
  | {
      readonly detects: false;
      readonly window: Quantity;
      readonly recovers?: Recovers;
      readonly replies?: Replies;
      readonly middlebox?: MiddleboxExpectation;
      readonly rtt?: RttRange;
      readonly through?: readonly ProxyTime[];
      readonly group?: GroupPrediction;
      readonly request?: RequestPrediction;
      readonly driver?: DriverBand;
    }
  | {
      readonly detects: null;
      readonly window: Quantity;
      readonly why: string;
      readonly from?: Reference;
      /**
       * This choice ends the measured time at the close of the socket by the observer itself, the
       * change from ESTABLISHED to FIN_WAIT1. Without it, the time ends at a report of the kernel or
       * at the last data. Then an idle pool that closes its own socket gives no end.
       */
      readonly ends?: "own-close";
      readonly group?: GroupPrediction;
      readonly request?: RequestPrediction;
      /**
       * These are the waits of the reconnect after the end of the connection, from the document of
       * the client. The end has no band, but each wait has one. A wait outside its band is a finding of its run.
       */
      readonly reconnects?: Reconnects;
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
  /**
   * These files go into the target before it starts, by their path, for example the script of a
   * server on a stock Node image. The image stays stock.
   */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * This flag tells that the target writes JSON lines with an `ev` and a `t` on its standard
   * output, on CLOCK_MONOTONIC. Each run then keeps its lines (`Run.server`).
   */
  readonly lines?: true;
  /**
   * This name is the server process, as /proc/PID/comm holds it. With it, a freeze of the target
   * stops this process with SIGSTOP from a sidecar in its process namespace, and the injector
   * stamps it. SIGCONT then thaws it. Without it, the freeze is the cgroup freezer, with no stamps.
   */
  readonly program?: string;
  /**
   * This source is the image of a subject that the target operates in place of `image`. It is an
   * image pinned by digest, a build context, or an image that the harness ships. `image` is then
   * the stock base of that image, for the record. An example is a subject that holds a client
   * and the script of its server.
   */
  readonly subject?: ImageSource;
  /**
   * This name is an image of the harness that the target operates in place of `image`. It is a
   * short form: `harness: "procedures"` is `subject: { kind: "shipped", name: "procedures" }`.
   * `subject` replaces it.
   */
  readonly harness?: HarnessImage;
}

/**
 * A harness image is an image of the harness that a target can operate by its name (`Target.harness`).
 * `procedures` is the image of `@procedures/client` on Node: its WebSocket client and its server script.
 */
export type HarnessImage = "procedures";

/**
 * A shipped image is an image that the harness ships, by its name. Its build context is in the
 * package of the harness, and in the package of the prober for `harness`.
 */
export type Shipped = "harness" | "node" | "go-http" | "node-http" | "mongo" | "pg" | "hikari" | "procedures" | "router" | "pgbouncer";

/**
 * An image source tells where an image comes from, as data. The harness resolves each kind to an
 * image that it can start:
 * - `pinned`: an image of a registry, pinned by its digest. The lab pulls it.
 * - `build`: a build context that the caller gives. The harness builds it, with a tag from its content.
 * - `shipped`: an image that the harness ships, by its name. The harness builds it from its package.
 */
export type ImageSource = PinnedImage | BuildImage | ShippedImage;

/** A pinned image is an image of a registry, pinned by its digest: `name@sha256:<64 hex digits>`. */
export interface PinnedImage {
  readonly kind: "pinned";
  readonly image: string;
}

/**
 * A build image is a build context that the caller gives. The harness copies its files into a new
 * context and builds it. Each `FROM` of its Dockerfile names a digest, and each `package.json` or
 * `Cargo.toml` has a lockfile beside it. Thus a build gives the same programs each time.
 */
export interface BuildImage {
  readonly kind: "build";
  /** This name is the repository of the tag. The tag is the name, then 12 digits of the sha256 of the context. */
  readonly name: string;
  /** This folder is the root of the context. A relative path starts at the working folder of the process. */
  readonly context: string;
  /** This path is the Dockerfile, in the context. Without it, the path is `Dockerfile`. */
  readonly dockerfile?: string | undefined;
  /** These paths are the files and the folders that the Dockerfile reads, in the context. Without them, the context is all of its folder. */
  readonly files?: readonly string[] | undefined;
}

/** A shipped image source names an image that the harness ships (`Shipped`). */
export interface ShippedImage {
  readonly kind: "shipped";
  readonly name: Shipped;
}

/**
 * A subject is a program under test, as data: the image that holds its programs, and the command
 * of each program. A catalog of cells takes a subject. Thus another repository can give its own
 * subject, with its own release in it. The harness ships some (`SUBJECTS`).
 */
export interface Subject {
  /** This name is the name of the subject in a catalog and in the records: `procedures`. */
  readonly name: string;
  /** This source is the image that holds the programs of the subject. */
  readonly image: ImageSource;
  /** This image is the stock base of the image, pinned by digest. A target of the subject names it (`Target.image`). */
  readonly base: string;
  /**
   * These are the commands of the programs of the image by their role, each as argv: for example
   * `client` and `server`. A run adds its arguments after the command.
   */
  readonly programs: Readonly<Record<string, readonly string[]>>;
}

/**
 * A client is what the runs of a cell use: the TCP client of the harness, or a driver on its
 * socket. The HTTP clients are the `http.Transport` of Go (`go-http`), the `http.Agent` of Node
 * (`http-agent`) and an HTTP/1.1 `Client` of undici (`undici`). The MongoDB driver is `mongodb`, node-postgres is `pg`, HikariCP over pgjdbc is `hikari`, and
 * the WebSocket client of `@procedures/client` is `procedures-ws`.
 */
export type Client = "tcp" | "ioredis" | "go-http" | "http-agent" | "undici" | "mongodb" | "pg" | "hikari" | "procedures-ws";

/**
 * A WebSocket probe is the workload and the settings of the WebSocket client of
 * `@procedures/client` (`procedures-ws`). The cell gives each setting, thus the client takes
 * nothing from a default.
 */
export interface WsProbe {
  /**
   * This name is the class of the sockets of the client: the global `WebSocket` of Node (`global`),
   * or the `WebSocket` of the `ws` package (`ws`, the option `webSocket`).
   */
  readonly socket: "global" | "ws";
  /**
   * These are the settings of the heartbeat: a ping each interval, the wait for its pong, and the
   * misses in sequence that drop the connection. Null turns the heartbeat off.
   */
  readonly heartbeat: { readonly interval: Quantity; readonly timeout: Quantity; readonly misses: number } | null;
  /**
   * These are the settings of the reconnect: the first delay, the multiplier of each next delay,
   * the longest delay and the most tries. `jitter` is the random part of each delay, from 0 to 1.
   * Null turns the reconnect off.
   */
  readonly reconnect: {
    readonly initialDelay: Quantity;
    readonly multiplier: number;
    readonly maxDelay: Quantity;
    readonly attempts: number;
    readonly jitter: number;
  } | null;
  /** This time is how long a call waits for its first frame. */
  readonly requestTimeout: Quantity;
  /** This time is how long a call waits for a connection. */
  readonly connectionTimeout: Quantity;
  /** This time is how long the server holds the reply to the call in flight. Without it, the server replies at once. */
  readonly hold?: Quantity;
}

/**
 * An HTTP probe is the workload of an HTTP client. The first request is a GET of the root. The
 * second request follows the mode of the probe: after the signal (`inflight`), or after a gap
 * (`gap`).
 */
export interface HttpProbe {
  /** This method is the method of the second request. */
  readonly method: "GET" | "POST";
  /** This time is the gap of a `gap` workload: from the end of the first reply to the second request. */
  readonly gap?: Quantity;
  /** This time is how long the server holds the reply to the second request (`/hold?ms=`). */
  readonly hold?: Quantity;
  /** This length is the length of the body of the reply to the second request, in bytes (`/big?bytes=`). */
  readonly bytes?: number;
  /** These are settings of the client over its defaults, by the names of its flags: for example `idle-conn-timeout-ms`. */
  readonly options?: Readonly<Record<string, number>>;
}

/**
 * A client image is a process that a lab starts as the client of each run, in the network
 * namespace of the client. An example is an agent of an application on Node. Its command gets the
 * arguments of the TCP client of the harness. These are the address and the port of the target, then
 * the options of the cell. It writes JSON lines with an `ev` and a `t` (CLOCK_MONOTONIC in
 * nanoseconds) on its standard output, as the client of the harness does.
 */
export interface ClientImage {
  /** This image is a stock image by its name, pinned by digest, or the source of the image of a subject. */
  readonly image: string | ImageSource;
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
     * An HTTP client in a `gap` sends its second request a gap after its first reply, by itself.
     */
    readonly mode: "idle" | "inflight" | "stream" | "gap";
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
     * This driver replaces the TCP client of the harness, with its own options. The driver then
     * ignores `keepalive` and `userTimeout`:
     * - ioredis 6 on Node, whose keepAlive is the keepalive delay of the socket.
     * - the MongoDB driver on Node, against the replica set `set`. Its operation is a write, or
     *   the read of a long document (`read-long`). `Cell.driverOptions` are its options.
     * - node-postgres on Node, as a `pg.Pool` against one server. Its operation is `query`, or
     *   `SELECT 1`. `Cell.driverOptions` are the options of its pool.
     * - HikariCP over pgjdbc on Java, as a `HikariDataSource` against one server. Its operation is
     *   `query`, or `SELECT 1`. `Cell.driverOptions` are the properties of HikariConfig, and a name
     *   with the prefix `dataSource.` is a property of pgjdbc.
     *
     * A pg or hikari driver can send a different text in flight (`inflight`): the second query of
     * an in-flight run. The first query then makes the pool ready at once, and only the query in
     * flight is slow, for example `SELECT pg_sleep(20)`.
     */
    readonly driver?:
      | { readonly name: "ioredis"; readonly keepAlive: Quantity }
      | { readonly name: "mongodb"; readonly set: string; readonly op?: "write" | "read-long" }
      | { readonly name: "pg"; readonly query?: string; readonly inflight?: string }
      | { readonly name: "hikari"; readonly query?: string; readonly inflight?: string };
    /** This workload is the workload of an HTTP client (`Cell.client` is an HTTP client). The client then ignores `keepalive` and `userTimeout`. */
    readonly http?: HttpProbe;
    /** These are the settings of the WebSocket client (`Cell.client` is `procedures-ws`). The client then ignores `keepalive` and `userTimeout`. */
    readonly ws?: WsProbe;
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
  /**
   * This specification is the tc netem of a `netem` fault, for example "loss 5%". It is on the
   * egress of the target, or at a hop (`faultAt`) on the egress of its device toward one side.
   */
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
  /** This place is where the fault goes, when it is not the peer of the observer: for example one side of a hop. */
  readonly faultAt?: FaultPlace;
  /** This time is how long an in-flight client stays idle after the fault holds, before it sends its request. */
  readonly idleBefore?: Quantity;
  /** This toxic is the toxic of a `toxic` fault, which the Toxiproxy hop gets. */
  readonly toxic?: Toxic;
  /** This image, or this client of the harness, replaces the TCP client of the harness for each run. An HTTP client is one. */
  readonly client?: ClientImage | Client;
  /**
   * This name is the proxy hop whose own time a calibration cell measures. The time of a request
   * (`up`) starts at its arrival on the socket of the proxy toward the client. It stops at the
   * write on the socket toward the target. The time of its reply (`down`) goes the other way.
   *
   * For a group cell, `sentinels` makes the prober watch the namespace of each Sentinel too. Each
   * stamp of the observer then gets the write of its Sentinel that it read (`lags`).
   */
  readonly calibrates?: string;
  /**
   * This group replaces the target: a replicated group under its Sentinels. The client is then
   * ioredis in Sentinel mode, and it writes a stream of sequence numbers. `target` stays for the
   * record, and the group does not read it.
   */
  readonly group?: Group;
  /**
   * This replica set replaces the target: a replicated group whose members elect their own
   * primary. The client is then the MongoDB driver, and it writes a stream of sequence numbers.
   * `target` stays for the record, and the set does not read it.
   */
  readonly replicaSet?: ReplicaSet;
  /**
   * This time is how long a fault on a group holds after its commit. The injector then lifts it at
   * that instant, on the clock of the VM. On a direct pair, a frozen target thaws after it.
   */
  readonly hold?: Quantity;
  /** This flag makes a planned failover coordinated: `SENTINEL FAILOVER <group> COORDINATED`. */
  readonly coordinated?: boolean;
  /**
   * These are options of the driver over its defaults: of ioredis for the client of a group, or of
   * the MongoDB driver for its client. A cell at the defaults has none.
   */
  readonly driverOptions?: Readonly<Record<string, unknown>>;
  /** This write concern is the w of each write of the MongoDB client. Without it, it is majority. */
  readonly writeConcern?: "majority" | 1;
  /** This flag makes the fault hold before the client starts. The client then meets it at its first selection. */
  readonly before?: boolean;
  /** This count is the number of runs of the cell (11), across new environments (two at least). */
  readonly runs: number;
  readonly environments: number;
  /**
   * This count is the number of environments at the same time, each with its own prober. Without
   * it, the count is one. The calibration does its reference cells at 1, 4 and 8, to find how
   * many environments the machine holds before its noise increases.
   */
  readonly concurrency?: number;
  /**
   * This time is δ_abs of the environment of the cell: the noise of the pipeline. Each band includes
   * it, and a timer must be at least that late to make a run void. Stage 0 measures it in each
   * environment. Without it, the cell gets `NOISE`, the δ_abs of the first environment (4 ms).
   */
  readonly noise?: Quantity;
}

/** A hop place is a hop of a topology, with the side that the rules of a fault face. */
export interface HopPlace {
  readonly hop: string;
  readonly toward: "client" | "target";
}

/**
 * A fault place is the namespace that gets the rules of a fault. "target" and "client" are the two
 * ends. A hop place is a hop, with the side that the rules face. That side is the next hop toward
 * the client, or the next hop toward the target. The rules of a proxy act on its sockets. The
 * rules of a router act on what it forwards, by its device toward that side: the FORWARD chain.
 *
 * A group place is a part of a group, by its role.
 */
export type FaultPlace = "target" | "client" | HopPlace | GroupPlace;

/** This function tells if a fault place is a hop of a topology. */
export const isHopPlace = (place: FaultPlace | undefined): place is HopPlace =>
  typeof place === "object" && "hop" in place;

/**
 * This function gives the latest end of a band in seconds, from the reply of the client. It is
 * the high bound, after the latest reference of the band (`startsBy`).
 */
export const latestEndOf = (prediction: Extract<Prediction, { readonly detects: true }>): number =>
  valueIn(prediction.high, "s") + (prediction.startsBy === undefined ? 0 : valueIn(prediction.startsBy, "s"));

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
  /**
   * This rate is the HZ of the kernel of the environment, from its manifest. With it, the rule of a
   * late timer is in time. A run without it keeps the rule in jiffies, as the runs before 0.9.0.
   */
  readonly hz?: number;
  /** These are the addresses and the namespaces of a topology, which the measurement of a run reads. */
  readonly topology?: RunTopology;
  /** These are the lines of the routers of a topology from the start to the end of the run. */
  readonly middlebox?: readonly MiddleboxEvent[];
  /** This record is the group of a group cell: its parts, and what it did in the run. */
  readonly group?: RunGroup;
  /** These are the lines of a target that writes them (`Target.lines`), from the start to the end of the run. */
  readonly server?: readonly ProbeEvent[];
}

/** A Sentinel event is one line of the observer of a group: an event that a Sentinel published, on the clock of the VM. */
export interface SentinelEvent {
  readonly ev: string;
  readonly t: number;
  /** This text is the address and port of the Sentinel. */
  readonly sentinel?: string;
  /** This name is the event, for example `+switch-master`. */
  readonly event?: string;
  /** This text is the detail of the event, as the Sentinel wrote it. */
  readonly detail?: string;
  readonly [field: string]: unknown;
}

/** A part is one member or Sentinel of a group, as a run found it: its address and its network namespace. */
export interface RunPart {
  readonly ip: string;
  readonly netns: number;
}

/** A run group is the group of a run: its parts, the primary before and after, the timeline, and the writes that it kept. */
export interface RunGroup {
  readonly members: Readonly<Record<string, RunPart>>;
  readonly sentinels: Readonly<Record<string, RunPart>>;
  /** This name is the member that was the primary at the start of the run. */
  readonly primary: string;
  /** This name is the part that got the fault, or null for a fault on the whole group. */
  readonly at: string | null;
  /**
   * These are the lines of the timeline from the start to the end of the run. For a group under
   * Sentinels, they are the lines of the observer of the Sentinels. For a replica set, they are
   * the log lines of the members (`ev` "mongod"), with their times on the monotonic clock.
   */
  readonly timeline: readonly SentinelEvent[];
  /** This name is the member that was the primary when the group converged after the run, or null when it did not converge. */
  readonly after: string | null;
  /** These are the sequence numbers that the group holds after the run, when it converged, or null. */
  readonly holds: readonly number[] | null;
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
