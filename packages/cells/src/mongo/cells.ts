import type { Fault, MiddleboxForm, RttRange, Target } from "@mark1russell7/harness";
import type { Extent, Quantity } from "@mark1russell7/quantity";
import type { DriverOptions, ReplSettings, Role } from "./model.ts";

/** This image is MongoDB 9.0.4, pinned by the digest of its index: each member of the cells. */
export const MONGO_IMAGE = "mongo:9.0.4@sha256:f90507905ce6e52e4a63d0ff8964fc254fa4d37ccbe56c56f4bc0186eb02edea";

/** This name is the name of the replica set of each cell. */
export const SET_NAME = "rs0";

/**
 * This target is one member of a replica set: mongod as the child of a shell. Thus a `fin` fault
 * can stop it, and the container stays up. The lab starts the set with the address of each member
 * as the client reaches it, and it waits for a primary.
 */
export const MONGO_TARGET: Target = {
  image: MONGO_IMAGE,
  port: 27017,
  ready: "Waiting for connections",
  command: [
    "sh",
    "-c",
    `mongod --replSet ${SET_NAME} --bind_ip_all & echo $! > /tmp/server.pid; while :; do sleep 3600; done`,
  ],
  kill: ["sh", "-c", 'kill -KILL "$(cat /tmp/server.pid)"'],
};

/** This text is the version of the driver that the client of each cell loads, as its lockfile pins it. */
export const DRIVER = "mongodb 7.7.0 on Node 24.21.0";

/**
 * A reference is the event that a band counts from:
 * - an event of one socket of the driver, as the kernel records it. The events are its last
 *   received segment, the send of the request, its first retransmission and the close of the peer.
 *   The socket `server` is the socket of mongod for the pool connection of the client.
 * - the commit of the fault, as the injector stamps it, or the start of the client.
 */
export type MongoReference =
  | { readonly socket: Role | "server"; readonly event: "last-received" | "request-sent" | "first-retransmission" | "peer-closed" }
  | { readonly event: "fault" | "start" };

/** A band is when one event of the client occurs, from its reference, with the name of its error or OK. */
export interface MongoBand {
  /** This text names the event, for example "the monitor writes the server off". */
  readonly what: string;
  /** This name is the error that the driver gives, the errno of the kernel, or OK. */
  readonly name: string;
  readonly labels?: readonly string[];
  readonly from: MongoReference;
  readonly low: Quantity;
  readonly high: Quantity;
}

/** A stage is one step of the timeline of a replica set after a fault. A log line of mongod or an event of the client marks it. */
export type MongoStage =
  | "member-down"
  | "election-start"
  | "elected"
  | "caught-up"
  | "writable"
  | "old-primary-steps-down"
  | "discovered"
  | "written-off"
  | "first-write";

/** These are the log lines of mongod and the events of the client that mark each stage. */
export const STAGE_MARKS: Readonly<Record<MongoStage, string>> = {
  "member-down": "mongod log 21216 (Member is now in state DOWN) at a secondary, for the old primary",
  "election-start": "mongod log 4615652 (Starting an election) or 21437 (Skipping dry run) at the new primary",
  elected: "mongod log 21450 (Election succeeded, assuming primary role)",
  "caught-up": "mongod log 21363 (Exited primary catch-up mode)",
  writable: "mongod log 21331 (Transition to primary complete; database writes are now permitted)",
  "old-primary-steps-down": "mongod log 21809, 21475 or 962660 at the old primary",
  discovered: "the client's serverDescriptionChanged: the new primary is RSPrimary",
  "written-off": "the client's serverHeartbeatFailed for the old primary",
  "first-write": "the client's ack of the first write on the new primary",
};

/** A stage band is when a stage first occurs, from the fault. A stage with more than one mode has the span of each. */
export interface StageBand {
  readonly stage: MongoStage;
  readonly low: Quantity;
  readonly high: Quantity;
  readonly modes?: ReadonlyArray<{ readonly low: Quantity; readonly high: Quantity }>;
}

/**
 * A group prediction tells what a replica set does after a fault:
 * - `lands` is the primary of the first write that a primary accepts after the fault: a new one or the same one.
 * - `failover` tells if a new primary is elected in the window.
 * - `stages` are the bands of the stages of the timeline.
 * - `errors` are the errors that the client meets on the way.
 * - `lost` is the count of acknowledged writes that the group does not keep, as a range.
 */
export interface MongoGroupPrediction {
  readonly lands: "new" | "same";
  readonly failover: boolean;
  readonly stages: readonly StageBand[];
  readonly errors?: ReadonlyArray<{ readonly name: string; readonly low: Quantity; readonly high: Quantity }>;
  readonly lost: { readonly low: number; readonly high: number };
}

/**
 * A prediction of a MongoDB cell:
 * - `detects: true`: the bands occur in their sequence, and the first band is the band of the cell.
 * - `detects: false`: nothing that `quiet` names occurs in the window. A band can tell when the reply comes.
 * - `detects: null`: a measurement, with its reason.
 * Each prediction names the events that must not occur in its window (`quiet`).
 */
export interface MongoPrediction {
  readonly detects: boolean | null;
  readonly bands: readonly MongoBand[];
  readonly window: Quantity;
  readonly quiet: readonly string[];
  readonly why?: string;
  readonly rtt?: RttRange;
  readonly group?: MongoGroupPrediction;
}

/** A router of a MongoDB cell: the form of the router of the harness and its idle timeout, in whole seconds. */
export interface MongoRouter {
  readonly form: MiddleboxForm;
  readonly idle: number;
  /** This text is the cloud preset that the form and the timeout stand for. */
  readonly preset: string;
}

/** A spec is one MongoDB cell before its prediction. */
export interface MongoSpec {
  /** This identifier is the cell of the plan that this cell stands for, for example `T01.defaults.1`. */
  readonly plan: string;
  /** This text is the rest of the name: the trigger, its position and its settings. */
  readonly name: string;
  readonly fault: Fault | "step-down" | "partition";
  /** This mode is the workload: idle after one write, one write into the fault, or a stream of writes. */
  readonly mode: "idle" | "inflight" | "stream";
  /** This operation is what the client sends: a write by default, or a read of a long document. */
  readonly op?: "write" | "read-long";
  /** These are the options of the driver over its defaults. */
  readonly options?: DriverOptions;
  /** These are the knobs of Linux TCP at the client over Linux 6.6. */
  readonly linux?: Readonly<Record<string, Extent>>;
  /** This time is how long the fault holds, in seconds, for a freeze or a cut that lifts. */
  readonly hold?: number;
  /** This time is the length of a stall from the send of the request, in seconds. */
  readonly stall?: number;
  readonly icmp?: "host" | "net" | "port" | "admin";
  readonly drops?: "to-server" | "to-client";
  readonly mtu?: number;
  /** This flag marks a fault that holds before the client starts: the client meets it at its first selection. */
  readonly before?: boolean;
  /** This router is between the client and the set, for a cell of T03. */
  readonly router?: MongoRouter;
  /** This side is the side of the router that the rules face, for a fault at the router. */
  readonly toward?: "client" | "target";
  /** This side is the observer: the client, or mongod's socket for the client's pool connection. */
  readonly observer?: "client" | "server";
  /** These are the settings of the replica set over the defaults, for a cell of T11. */
  readonly settings?: ReplSettings;
  /** This write concern is the w of each write. The default is majority. */
  readonly w?: "majority" | 1;
  /** This place is the part of the set that the fault acts on, for a cell of T11. */
  readonly at?: GroupPlace;
  /** This text is the reason that the cell is measurement-only. */
  readonly why?: string;
}

/**
 * A group place is the part of a replica set of three members that a fault acts on:
 * - `all`: the primary and each of its peers, the clients too.
 * - `group`: the primary and the other members, but not the clients.
 * - `clients`: the primary and the clients, but not the members.
 * - `one`: the primary and one secondary, in both directions.
 * - `one-way`: the segments from the primary to one secondary only.
 */
export interface GroupPlace {
  readonly role: "primary";
  readonly cuts: "all" | "group" | "clients" | "one" | "one-way";
}

/** A waiting cell is a cell of the plan that this catalog does not start, with the reason. */
export interface Waiting {
  readonly plan: string;
  readonly trigger: string;
  readonly why: string;
}

/** An alias is a cell of the plan whose systems, trigger and settings are those of another cell of this catalog. */
export interface Alias {
  readonly plan: string;
  readonly is: string;
  readonly why: string;
}

/** A cell of a MongoDB catalog: its spec, its name and its prediction. */
export interface MongoCell {
  readonly spec: MongoSpec;
  readonly name: string;
  readonly prediction: MongoPrediction;
}

/** This function gives an amount in seconds, rounded to the nanosecond. */
export const sec = (value: number): Quantity => ({ value: Math.round(value * 1e9) / 1e9, unit: "s" });
