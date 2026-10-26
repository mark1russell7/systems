import type { Factory } from "../client/core.ts";

/** A document is a BSON document as the driver gives it: a command, or the reply of the server. */
export type MongoDocument = Record<string, unknown>;

/** A database is the part of a `Db` of the driver that the wrapper uses: `command` sends one command. */
export interface MongoDb {
  /** This method sends a command. Its signal ends the command, and an abort during the read closes the connection. */
  command(document: MongoDocument, options?: { readonly signal?: AbortSignal | undefined }): Promise<MongoDocument>;
}

/** A server is the part of a `ServerDescription` that the wrapper reads: its type, for example `RSPrimary`. */
export interface MongoServer {
  readonly type: string;
}

/** These are the events of the driver that the wrapper listens to, by name, with the fields that it reads. */
export interface MongoEvents {
  /** The view of the topology changed. A writable server is a primary, a standalone, a mongos or a load balancer. */
  topologyDescriptionChanged: { readonly newDescription: { readonly servers: ReadonlyMap<string, MongoServer> } };
  /** A connection of the pool finished its handshake. `connectionId` is the id that the pool gives. */
  connectionReady: { readonly connectionId: number | string; readonly address: string };
  /** A command went to a connection. `serverConnectionId` is the id that the server gave in its hello. */
  commandStarted: {
    readonly connectionId?: number | string | undefined;
    readonly address: string;
    readonly serverConnectionId?: bigint | number | null | undefined;
  };
  /** The pool of a server closed its connections, for example at the write-off of the server. */
  connectionPoolCleared: { readonly address: string; readonly interruptInUseConnections?: boolean | undefined };
  /** A hello of the monitor failed. `connectionId` is the address of the server. */
  serverHeartbeatFailed: { readonly connectionId: string; readonly failure: Error };
  /** An error of the topology. In Node, an error with no listener throws. */
  error: Error;
}

/** An event name is a name of `MongoEvents`. */
export type MongoEventName = keyof MongoEvents;

/**
 * A driver client is the part of a `MongoClient` that the wrapper uses. A `MongoClient` of the
 * driver 7 has each part. A fake for tests has them too. Thus the package depends on no type of the driver.
 */
export interface MongoDriverClient {
  /** This method opens the topology and waits for a server to select. A failure closes the topology, and a later command opens it again. */
  connect(): Promise<unknown>;
  /** This method fails the commands in flight, sends `endSessions` to a selectable server, and closes the topology. */
  close(): Promise<void>;
  db(name: string): MongoDb;
  on<E extends MongoEventName>(event: E, listener: (payload: MongoEvents[E]) => void): unknown;
  off<E extends MongoEventName>(event: E, listener: (payload: MongoEvents[E]) => void): unknown;
}

/**
 * These are the options that the wrapper gives `MongoClient`. Each one comes from the declaration.
 * The wrapper sets each option that has an effect on a timer, thus no default of the driver decides
 * one. A knob of the driver at 0 has no timer. The wrapper writes "infinite" as 0, and it refuses a bound of 0.
 */
export interface MongoDriverOptions {
  /** The server shows this name in `$currentOp` and in its log, thus the prober can join on it too. */
  readonly appName: string;
  readonly replicaSet?: string | undefined;
  readonly auth?: { readonly username: string; readonly password: string } | undefined;
  readonly authSource?: string | undefined;
  readonly maxPoolSize: number;
  readonly minPoolSize: number;
  /** This time bounds the TCP connect and the handshake of each connection, and of the monitor. */
  readonly connectTimeoutMS: number;
  /** This time bounds a read on a connection that has a command in flight. At its end, the driver closes the connection. */
  readonly socketTimeoutMS: number;
  /** This time bounds the wait for a server to select, for each command and for `connect`. */
  readonly serverSelectionTimeoutMS: number;
  /** This time is the period of the monitor, and the wait of its streaming hello. */
  readonly heartbeatFrequencyMS: number;
  /** This time bounds a checkout from a full pool. 0 is no bound. */
  readonly waitQueueTimeoutMS: number;
  /** A checkout ends an idle connection older than this time. 0 is no limit. The driver has no timer for it. */
  readonly maxIdleTimeMS: number;
  /** This time is the idle time of TCP keepalive. The driver always turns keepalive on. Node truncates the time to whole seconds. */
  readonly keepAliveInitialDelay: number;
  /** The monitor streams its hello, as in the cells. Thus a silent server is written off at `connectTimeoutMS + heartbeatFrequencyMS`. */
  readonly serverMonitoringMode: "stream";
  /** The driver does not send a command again by itself. The core sends again only an idempotent operation. */
  readonly retryReads: false;
  readonly retryWrites: false;
  /** The driver emits `commandStarted`, which gives the id of the server for each connection (D1). */
  readonly monitorCommands: true;
}

/** These are the arguments of `new MongoClient(url, options)`. The URL gives only the hosts. */
export interface MongoConnectOptions {
  readonly url: string;
  readonly options: MongoDriverOptions;
}

/** A driver factory makes the client of the driver from its options. */
export type MongoFactory = Factory<MongoConnectOptions, MongoDriverClient>;

/**
 * This factory makes a `MongoClient`. It loads the driver only when a client connects, thus a
 * service that does not use MongoDB does not need it. The specifier is a value, thus the package
 * needs no types of the driver. The driver gives `MongoClient` as a named export.
 */
export const nodeMongo: MongoFactory = async ({ url, options }) => {
  const specifier = "mongodb";
  const loaded = (await import(specifier)) as {
    readonly MongoClient: new (url: string, options: MongoDriverOptions) => MongoDriverClient;
  };
  return new loaded.MongoClient(url, options);
};
