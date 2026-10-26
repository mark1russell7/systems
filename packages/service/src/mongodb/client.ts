import type { Extent, Quantity } from "@mark1russell7/quantity";
import { realClock } from "../clock.ts";
import type { Attempt, CheckOptions, Client, ClientJoin, ClientKnobs, ClientOptions, ClientSpec, ClientStep, DialFn, SendOptions, Sent } from "../client/core.ts";
import {
  attachClient,
  clientBounds,
  clientProblems,
  clientRecorder,
  deadlineProblem,
  dialCheck,
  finiteMs,
  inFlight,
  localStateCheck,
  message,
  ms,
  notSent,
  operationTable,
  orZero,
  poolProblems,
  roundTripCheck,
  sendWithReissue,
  stepChecks,
  timeProblems,
  wholeProblems,
  withinBound,
  zeroProblems,
} from "../client/core.ts";
import type { Judge } from "../client/dial.ts";
import { helloDial } from "../client/dial.ts";
import type { Dependency } from "../description.ts";
import type { DependencyHandle } from "../lifecycle.ts";
import type { Operation } from "../operation.ts";
import type { MongoConnectOptions, MongoDocument, MongoDriverClient, MongoEventName, MongoEvents, MongoFactory } from "./connection.ts";
import { nodeMongo } from "./connection.ts";
import { mongoMeetings } from "./meets.ts";

/**
 * These are the knobs of the client, each a time, by the names of the ordering law where the law
 * has them. The runtime has no defaults, thus each knob is necessary. A bound that nobody gives is
 * "infinite", not zero. `MONGO_STARTING_KNOBS` gives a declaration from the cells of S1. The knobs
 * that each client has come from the core.
 */
export interface MongoKnobs extends ClientKnobs {
  /** This time bounds the TCP connect and the handshake of each connection (`connectTimeoutMS`). It also bounds the wait of the startup. */
  readonly connect_bound: Quantity;
  /** This time bounds a read of a command in flight (`socketTimeoutMS`). At its end, the driver closes the connection. */
  readonly request_timeout: Quantity;
  /**
   * This time is the deadline of each command on the server (`maxTimeMS`). The wrapper writes it in
   * each command. The server then ends the command with error 50, a certain outcome. "infinite" sends no deadline.
   */
  readonly statement_timeout: Extent;
  /** This time is the period of the monitor (`heartbeatFrequencyMS`). The driver takes 500 ms at least. */
  readonly heartbeat_interval: Quantity;
  /**
   * This time bounds the wait for a writable server (`serverSelectionTimeoutMS`). A command waits
   * through a failover in this time, thus it is the retry window of the client (O29).
   */
  readonly client_retry_window: Quantity;
  /** This time bounds a checkout from a full pool (`waitQueueTimeoutMS`). */
  readonly checkout_timeout: Extent;
  /** A checkout ends an idle connection older than this time (`maxIdleTimeMS`). The driver checks it only at a checkout. */
  readonly pool_idle_expiry: Extent;
  /** This time is the idle time of TCP keepalive (`keepAliveInitialDelay`), in whole seconds. The driver always turns keepalive on. */
  readonly keepalive_idle: Extent;
  /** The driver has no age for a connection, thus this knob must be "infinite". */
  readonly max_connection_age: Extent;
  /** This time bounds the close of the client at the shutdown. */
  readonly close_bound: Quantity;
}

/** A seed is one more host that the driver connects to first, for example a member of a replica set. */
export interface MongoSeed {
  readonly host: string;
  readonly port: number;
}

/** A MongoDB client spec is the declaration of one MongoDB client: where it connects, its pool, and its knobs. */
export interface MongoClientSpec extends ClientSpec<MongoKnobs> {
  /** This name is the database of the commands of the client. */
  readonly database: string;
  readonly username?: string | undefined;
  /** This name is the database of the user. The default of the driver is `database`, or `admin`. */
  readonly authSource?: string | undefined;
  readonly replicaSet?: string | undefined;
  /** These hosts are more seeds of the topology, after `host` and `port`. */
  readonly seeds?: readonly MongoSeed[] | undefined;
  /** These counts are the sizes of the pool of each server: at most `max` connections, and `min` that the driver keeps open. */
  readonly pool: { readonly max: number; readonly min: number };
  /**
   * These operations are the commands of the service, by name, with their idempotency. A command
   * name does not tell if a command changes a state, for example an `aggregate` with `$merge`. Thus
   * the client sends again only a command that this table names.
   */
  readonly operations?: Readonly<Record<string, Operation>> | undefined;
}

/** These options make a client. Without them, it uses the driver, the real clock, and a dial with a hello. */
export type MongoClientOptions = ClientOptions<MongoFactory>;

/**
 * A join is one connection of the pool, when its handshake is done (D1, D2). The prober joins its
 * kernel records to the server's view of the connection through it. The driver gives no socket,
 * thus the local address and port are null. The server's view is the connection id of its hello.
 */
export interface MongoJoin extends ClientJoin {
  /** This text is the address of the server, as `host:port`. */
  readonly address: string;
  /** This number is the connection id that the server gave, from the first command on the connection. Null until that command. */
  readonly serverConnectionId: number | null;
}

/** The steps that the MongoDB client gives a check for. A pool of the driver has no checkout that the wrapper can use. */
export type MongoStep = ClientStep;

/** A MongoDB client is a dependency of a service: its declaration, its handle, its checks and its commands. */
export interface MongoClient extends Client<MongoStep, MongoJoin> {
  /** This text is the state of the client, as `MONGO_CLIENT_MACHINE` names it. */
  readonly status: string;
  /**
   * This method sends a command to the database of the spec, and gives its outcome in three values.
   * `operation` names the command in the table of operations. The client sends again only an
   * idempotent operation, one time at most, after an outcome that is not certain.
   */
  command(operation: string, document: MongoDocument, options?: SendOptions): Promise<Sent<MongoDocument>>;
}

/** The driver takes a period of the monitor of 500 ms at least. */
const LEAST_HEARTBEAT_MS = 500;

/** This function gives the problems of a spec: the knobs that the driver cannot use. */
export const specProblems = (name: string, spec: MongoClientSpec): string[] => {
  const { knobs } = spec;
  const problems = [
    ...timeProblems(name, knobs),
    // the driver reads 0 as no timer, thus a bound of 0 is not a bound
    ...zeroProblems(name, "the driver", knobs, {
      bounded: ["connect_bound", "request_timeout", "heartbeat_interval", "client_retry_window", "close_bound"],
      open: ["statement_timeout", "checkout_timeout", "pool_idle_expiry"],
    }),
    // the options are whole milliseconds, and Node truncates the keepalive delay to whole seconds
    ...wholeProblems(name, knobs, {
      millis: ["connect_bound", "request_timeout", "statement_timeout", "heartbeat_interval", "client_retry_window", "checkout_timeout", "pool_idle_expiry"],
      seconds: ["keepalive_idle"],
    }),
    ...poolProblems(name, spec.pool),
  ];
  if (ms(knobs.heartbeat_interval) < LEAST_HEARTBEAT_MS)
    problems.push(`${name}'s heartbeat_interval is below 500 ms, the least that the driver takes`);
  if (!(ms(knobs.keepalive_idle) > 0) || !Number.isFinite(ms(knobs.keepalive_idle)))
    problems.push(`${name}'s keepalive_idle is not a finite time above zero: the driver always turns keepalive on`);
  if (knobs.max_connection_age.value !== "infinite") problems.push(`${name}'s max_connection_age is not "infinite": the driver has no age for a connection`);
  return problems;
};

/** This function gives the arguments of `new MongoClient` from a spec. Each timer of the driver comes from the declaration. */
export const mongoOptions = (name: string, spec: MongoClientSpec): MongoConnectOptions => {
  const { knobs } = spec;
  const hosts = [{ host: spec.host, port: spec.port }, ...(spec.seeds ?? [])].map((seed) => `${seed.host}:${seed.port}`);
  return {
    url: `mongodb://${hosts.join(",")}/`,
    options: {
      appName: name,
      ...(spec.replicaSet === undefined ? {} : { replicaSet: spec.replicaSet }),
      ...(spec.username === undefined ? {} : { auth: { username: spec.username, password: spec.password ?? "" } }),
      ...(spec.authSource === undefined ? {} : { authSource: spec.authSource }),
      maxPoolSize: spec.pool.max,
      minPoolSize: spec.pool.min,
      connectTimeoutMS: ms(knobs.connect_bound),
      socketTimeoutMS: ms(knobs.request_timeout),
      serverSelectionTimeoutMS: ms(knobs.client_retry_window),
      heartbeatFrequencyMS: ms(knobs.heartbeat_interval),
      waitQueueTimeoutMS: orZero(knobs.checkout_timeout),
      maxIdleTimeMS: orZero(knobs.pool_idle_expiry),
      keepAliveInitialDelay: ms(knobs.keepalive_idle),
      serverMonitoringMode: "stream",
      retryReads: false,
      retryWrites: false,
      monitorCommands: true,
    },
  };
};

/**
 * The bytes of an OP_MSG with the command `{ hello: 1, $db: "admin" }`. They are a header of 16
 * bytes with the op code 2013, the flags, a section of kind 0, and the BSON document. The server answers a
 * hello before the authentication, thus the dial needs no password.
 */
export const HELLO: Uint8Array = Uint8Array.of(
  // the header: the length 52, the request id 1, the response to 0, the op code 2013
  52, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0xdd, 0x07, 0, 0,
  // the flags, and the section of kind 0
  0, 0, 0, 0, 0,
  // the document: its length 31, the int32 `hello` 1, the string `$db` "admin", and its end
  31, 0, 0, 0,
  0x10, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0, 1, 0, 0, 0,
  0x02, 0x24, 0x64, 0x62, 0, 6, 0, 0, 0, 0x61, 0x64, 0x6d, 0x69, 0x6e, 0,
  0,
);

/** The sizes of the values of the BSON types that a hello reply holds, by type. A null size has a length prefix. */
const FIXED: Readonly<Record<number, number>> = { 0x01: 8, 0x07: 12, 0x08: 1, 0x09: 8, 0x0a: 0, 0x10: 4, 0x11: 8, 0x12: 8, 0x13: 16 };

/** This function gives the value of `ok` at the top of a BSON document, or an error. */
const okOf = (doc: Buffer): number | Error => {
  let at = 4;
  while (at < doc.length - 1) {
    const type = doc[at]!;
    const end = doc.indexOf(0, at + 1);
    if (end < 0) return new Error("the hello reply has a field with no end");
    const key = doc.toString("latin1", at + 1, end);
    at = end + 1;
    if (key === "ok") {
      if (type === 0x01) return doc.readDoubleLE(at);
      if (type === 0x10) return doc.readInt32LE(at);
      return new Error(`the ok of the hello reply has the BSON type ${type}`);
    }
    const fixed = FIXED[type];
    if (fixed !== undefined) at += fixed;
    else if (type === 0x02) at += 4 + doc.readInt32LE(at);
    else if (type === 0x03 || type === 0x04) at += doc.readInt32LE(at);
    else if (type === 0x05) at += 5 + doc.readInt32LE(at);
    else return new Error(`the hello reply has the BSON type ${type}, which the dial does not read`);
  }
  return new Error("the hello reply has no ok");
};

/**
 * This judge reads the answer to the hello. It waits for the whole message. The message must be an
 * OP_MSG with a section of kind 0, and its document must have `ok` 1.
 */
export const helloJudge: Judge = (received) => {
  if (received.length < 4) return "more";
  const length = received.readInt32LE(0);
  if (length < 26 || length > 48 * 1024 * 1024) return new Error(`the answer to the hello has a length of ${length}`);
  if (received.length < length) return "more";
  const opCode = received.readInt32LE(12);
  if (opCode !== 2013) return new Error(`the answer to the hello has the op code ${opCode}, not 2013`);
  if (received[20] !== 0) return new Error("the answer to the hello has no section of kind 0");
  const ok = okOf(received.subarray(21, length));
  if (ok instanceof Error) return ok;
  return ok === 1 ? null : new Error(`the hello reply has ok ${ok}`);
};

/** This dial function opens a TCP connection, sends a hello, and waits for its reply. The server opens no session for it. */
export const helloCommandDial: DialFn = helloDial(HELLO, helloJudge);

/** These errors tell that the command did not leave the client: no server, a full pool, a cleared pool, or a closed client. */
const NOT_SENT = new Set([
  "MongoServerSelectionError",
  "MongoWaitQueueTimeoutError",
  "MongoPoolClearedError",
  "MongoPoolClosedError",
  "MongoServerClosedError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
  "MongoClientClosedError",
]);

/**
 * These codes of the server tell that the server interrupted the command. The causes are its
 * shutdown, a step down, or a change of the state of the replica set. A part of the command can have applied.
 */
const INTERRUPTED = new Set([91, 189, 11600, 11602]);

/** The writable servers: a primary, a standalone, a mongos, and a load balancer. */
const WRITABLE = new Set(["RSPrimary", "Standalone", "Mongos", "LoadBalancer"]);

/** This function gives the outcome of a reply. A write concern error tells that the write can roll back, thus it is not certain. */
const replyOutcome = (reply: MongoDocument): Attempt<MongoDocument> => {
  const concern = reply["writeConcernError"] as { code?: unknown; errmsg?: unknown } | undefined;
  if (concern === undefined || concern === null) return { outcome: "ok", value: reply };
  return { outcome: "indeterminate", error: `write concern ${String(concern.code)} ${String(concern.errmsg)}` };
};

/**
 * This function gives the outcome of a failure of the driver. The driver names each error class,
 * thus the wrapper reads the name, and depends on no class of the driver:
 * - A failure before the command left the client is certain: it did not apply.
 * - An error of the server is certain, except an interruption, which can leave a part applied.
 * - A write concern error, a network error after the handshake, and a timeout of the socket are not certain.
 */
export const failureOutcome = (error: unknown): Attempt<never> => {
  const text = message(error);
  const { name, code, beforeHandshake } = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    code?: unknown;
    beforeHandshake?: unknown;
  };
  if (typeof name === "string" && NOT_SENT.has(name)) return notSent(text);
  // a network error of a new connection, before its handshake: the command did not go to it
  if (name === "MongoNetworkError" && beforeHandshake === true) return notSent(text);
  if (name === "MongoServerError" && typeof code === "number") {
    const said = `${code} ${text}`;
    return INTERRUPTED.has(code) ? { outcome: "indeterminate", error: said } : { outcome: "error", error: said, reply: true };
  }
  return { outcome: "indeterminate", error: text };
};

/** This function gives the host and the port of an address `host:port`. */
const endsOf = (address: string): { readonly host: string | null; readonly port: number | null } => {
  const at = address.lastIndexOf(":");
  const port = Number(address.slice(at + 1));
  return at < 0 || !Number.isInteger(port) ? { host: address, port: null } : { host: address.slice(0, at), port };
};

/**
 * This function makes a MongoDB client, a dependency of a service over a `MongoClient`.
 * - It sets each timer of the driver from the declaration, and it turns off the retries of the driver.
 *   The client sends again only an idempotent operation of its table.
 * - It tells the outcome of a command in three values, from the name of each error of the driver.
 * - It writes the deadline of the server in each command (`maxTimeMS`), thus the server ends a slow command first (O07).
 * - It gives the state from the view of the topology: ready while a server is writable.
 * - It listens to each error of the driver. In Node, an error with no listener throws, and library code does not end the process (A5).
 * - It records the connection id of the server for each connection of the pool (D1).
 *
 * The outcomes, the second try, the commands in flight, the bounded close and the checks come from
 * the core of the clients. This entry gives what the driver does in its own way.
 */
export const mongoClient = (name: string, spec: MongoClientSpec, options: MongoClientOptions = {}): MongoClient => {
  const problems = specProblems(name, spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { knobs } = spec;
  const clock = options.clock ?? realClock;
  const create = options.create ?? nodeMongo;
  const dial = options.dial ?? helloCommandDial;
  const operations = operationTable({}, spec.operations);
  const deadline = finiteMs(knobs.statement_timeout);
  // a command waits for a writable server in the retry window, then it reads in the request bound
  const callBound = ms(knobs.client_retry_window) + ms(knobs.request_timeout);

  let driver: MongoDriverClient | null = null;
  let status = "none";
  const joins: MongoJoin[] = [];
  // the index in `joins` of each connection, by its address and the id that the pool gives
  const joined = new Map<string, number>();
  const flight = inFlight();

  const emit = clientRecorder(options.record, clock, name);
  const record = (on: string, to: string = status, detail?: string): void => {
    const from = status;
    status = to;
    emit(from, to, on, detail);
  };
  const closing = (): boolean => status === "closing" || status === "end";

  // the state is the view of the topology: a writable server makes the client ready. The close ignores the topology
  const onTopology = (event: MongoEvents["topologyDescriptionChanged"]): void => {
    const writable = [...event.newDescription.servers.values()].some((server) => WRITABLE.has(server.type));
    if (writable && (status === "connecting" || status === "failing")) record("topology.writable", "ready");
    else if (!writable && status === "ready") record("topology.unwritable", "failing");
  };
  const onReady = (event: MongoEvents["connectionReady"]): void => {
    const generation = joins.length + 1;
    const { host, port } = endsOf(event.address);
    joined.set(`${event.address}#${String(event.connectionId)}`, joins.length);
    joins.push({
      generation,
      at: clock.now(),
      address: event.address,
      serverConnectionId: null,
      localAddress: null,
      localPort: null,
      remoteAddress: host,
      remotePort: port,
    });
    record("join", status, `generation ${generation}, ${event.address}`);
  };
  // the hello of a connection gives the id of the server, and the driver gives it only in the events of a command
  const onStarted = (event: MongoEvents["commandStarted"]): void => {
    const index = joined.get(`${event.address}#${String(event.connectionId)}`);
    const id = event.serverConnectionId;
    if (index === undefined || id === null || id === undefined) return;
    joined.delete(`${event.address}#${String(event.connectionId)}`);
    joins[index] = { ...joins[index]!, serverConnectionId: Number(id) };
  };
  const onCleared = (event: MongoEvents["connectionPoolCleared"]): void =>
    record("pool.cleared", status, `${event.address}${event.interruptInUseConnections === true ? ", with the commands in flight" : ""}`);
  const onHeartbeat = (event: MongoEvents["serverHeartbeatFailed"]): void =>
    record("heartbeat.failed", status, `${event.connectionId}: ${message(event.failure)}`);
  // after the end, the listener only keeps the error from a throw
  const onError = (error: Error): void => {
    if (status !== "end") record("client.error", status, message(error));
  };
  const listeners: ReadonlyArray<readonly [MongoEventName, (payload: never) => void]> = [
    ["topologyDescriptionChanged", onTopology],
    ["connectionReady", onReady],
    ["commandStarted", onStarted],
    ["connectionPoolCleared", onCleared],
    ["serverHeartbeatFailed", onHeartbeat],
  ];

  /** This function makes one try of a command. The driver selects a server, checks out a connection, and sends the command. */
  const attempt = (document: MongoDocument, signal: AbortSignal | undefined): Promise<Attempt<MongoDocument>> => {
    const c = driver;
    if (c === null) return Promise.resolve(notSent(`${name} has not connected`));
    if (closing()) return Promise.resolve(notSent(`${name} is ${status}: the command did not leave the client`));
    if (signal?.aborted) return Promise.resolve(notSent("the caller aborted the command before it left the client"));
    // the deadline of the server goes in the command. The driver adds maxTimeMS only with timeoutMS, which the wrapper does not use
    const sent = deadline === undefined || "maxTimeMS" in document ? document : { ...document, maxTimeMS: deadline };
    return flight.track(signal, "the caller abandoned the command after it went to the driver", (settle) => {
      c.db(spec.database)
        .command(sent, signal === undefined ? {} : { signal })
        .then(
          (reply) => settle(replyOutcome(reply)),
          (error: unknown) => settle(failureOutcome(error)),
        );
    });
  };

  const command = (operation: string, document: MongoDocument, sendOptions: SendOptions = {}): Promise<Sent<MongoDocument>> =>
    sendWithReissue({
      clock,
      bound: callBound,
      operation: operations[operation],
      options: sendOptions,
      // the second try waits in the selection of a server, thus it needs no wait before it
      attempt: (signal) => attempt(document, signal),
      onReissue: () => record("command.reissue", status, operation),
    });

  const handle: DependencyHandle = {
    async connect(signal) {
      record("status.connecting", "connecting");
      const c = await create(mongoOptions(name, spec));
      driver = c;
      for (const [event, listener] of listeners) c.on(event, listener as never);
      c.on("error", onError);
      if (signal.aborted) throw new Error(`${name}: the service stopped before the connect`);
      // the driver waits for a server in client_retry_window. The startup waits connect_bound at most, and the connect goes on.
      // A server that is down does not stop the startup: the checks keep readiness tripped until a server is writable
      const connecting = c.connect().then(
        () => undefined,
        (error: unknown) => {
          if (!closing() && status !== "ready") record("connect.failed", "failing", message(error));
        },
      );
      await withinBound(clock, ms(knobs.connect_bound), connecting);
      if (status === "connecting") record("connect.failed", "failing", "no writable server in connect_bound");
    },
    async close() {
      const c = driver;
      if (c === null || closing()) return;
      record("close.request", "closing");
      // the close of the driver fails the commands in flight, then waits for endSessions. Behind a
      // black hole that wait has no bound. The driver gives no socket, thus the bound cannot destroy one
      if (!(await withinBound(clock, ms(knobs.close_bound), c.close()))) record("close.bound", status, "the close of the driver goes on");
      flight.settleAll("the client closed with the command in flight");
      for (const [event, listener] of listeners) c.off(event, listener as never);
      // the error listener stays: a socket that closes later can emit an error, and with no listener it throws
      record("status.end", "end");
    },
  };

  const declaration: Omit<Dependency, "name"> = {
    system: spec.system,
    knobs: {
      connect_bound: knobs.connect_bound,
      request_timeout: knobs.request_timeout,
      statement_timeout: knobs.statement_timeout,
      heartbeat_interval: knobs.heartbeat_interval,
      client_retry_window: knobs.client_retry_window,
      // the stream of the monitor times out at connectTimeoutMS + heartbeatFrequencyMS: the driver then
      // marks the server unknown, clears its pool and fails the commands in flight. The cells measured 7 s for 5 s + 2 s
      driver_writeoff_time: { value: (ms(knobs.connect_bound) + ms(knobs.heartbeat_interval)) / 1000, unit: "s" },
      checkout_timeout: knobs.checkout_timeout,
      pool_idle_expiry: knobs.pool_idle_expiry,
      keepalive_idle: knobs.keepalive_idle,
      // the driver sends nothing on an idle connection of the pool, thus its keepalive is the only refresh of an idle flow (O03)
      idle_refresh_interval: knobs.keepalive_idle,
      max_connection_age: knobs.max_connection_age,
      close_bound: knobs.close_bound,
      retrans_giveup_time: knobs.retrans_giveup_time,
    },
    operations,
  };

  const checks = (checkOptions: CheckOptions<MongoStep>) =>
    stepChecks<MongoStep>(name, checkOptions, {
      // the view of the topology, without a round trip: the monitor keeps it current
      "local-state": localStateCheck(() => status === "ready"),
      // a ping through the pool of the application
      "round-trip": roundTripCheck((sendOptions) => command("check", { ping: 1 }, sendOptions)),
      // a new connection each time, with a hello and no session
      dial: dialCheck(dial, spec.host, spec.port),
    });

  return {
    name,
    declaration,
    handle,
    meets: mongoMeetings(name, knobs),
    get status() {
      return status;
    },
    joins,
    command,
    checks,
    attach: (svc, checkOptions) => attachClient(svc, name, declaration, handle, checks(checkOptions)),
    problems(description) {
      // O07: the server must end a slow command first, with a certain error
      const late = deadlineProblem(name, knobs.request_timeout, knobs.statement_timeout, "command");
      return [...clientProblems(name, description, clientBounds(knobs)), ...(late === null ? [] : [late])];
    },
  };
};
