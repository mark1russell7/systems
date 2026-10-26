// A fake MongoClient for the tests of the MongoDB client, on a fake clock. It keeps the parts of the
// driver 7.7.0 that the client depends on. These parts are in the document mongodb-node of
// @mark1russell7/machines: a command waits for a writable server in serverSelectionTimeoutMS, a
// full pool queues a checkout under waitQueueTimeoutMS, socketTimeoutMS fails a read and closes its
// connection, and the monitor writes off a silent server at connectTimeoutMS + heartbeatFrequencyMS
// after its last answer. The write-off clears the pool and fails the commands in flight. A test
// changes what the server does: it answers, it refuses connections, it is silent, it is frozen, or
// it holds each command.

import type { Cancel, Clock } from "../clock.ts";
import type { MongoConnectOptions, MongoDb, MongoDocument, MongoDriverClient, MongoEventName } from "./connection.ts";

/**
 * What the server does: it answers, it refuses (a reset), it is silent (a black hole), it is frozen
 * (its kernel accepts a connection, and nothing answers), or it holds each command (a stall). The
 * monitor gets its answers in a stall. A held command ends at its `maxTimeMS`, as the server ends it.
 */
export type MongoServerMode = "up" | "refuse" | "silent" | "frozen" | "stall";

/** An error of the driver. The client reads only its name, its code, and `beforeHandshake`. */
export class FakeMongoError extends Error {
  readonly code?: number | undefined;
  readonly beforeHandshake?: boolean | undefined;

  constructor(kind: string, text: string, extra: { readonly code?: number; readonly beforeHandshake?: boolean } = {}) {
    super(text);
    this.name = kind;
    this.code = extra.code;
    this.beforeHandshake = extra.beforeHandshake;
  }
}

type Listener = (payload: never) => void;

/** A fake connection of the pool. */
export interface FakeMongoConnection {
  readonly id: number;
  readonly serverConnectionId: number;
  /** True when the connection has a command that waits for its answer. */
  readonly busy: boolean;
}

/** A fake MongoClient, with what a test must see and change. */
export interface FakeMongo extends MongoDriverClient {
  readonly given: MongoConnectOptions;
  /** Each command that reached the server, in sequence, with the database. */
  readonly calls: ReadonlyArray<readonly [string, MongoDocument]>;
  readonly connections: readonly FakeMongoConnection[];
  /** True while the view of the topology has a writable server. */
  readonly writable: boolean;
  mode: MongoServerMode;
  /** The answer of the server to a command, when it answers. An error is an error of the server. */
  reply: (document: MongoDocument) => MongoDocument | Error;
  /** This method breaks each connection and the stream of the monitor, as a reset or a FIN does. */
  breakConnections(kind: "rst" | "fin"): void;
  /** This method emits an error event of the topology. In Node, an error with no listener throws. */
  emitError(error: Error): void;
}

/** This function makes a fake MongoClient on a clock. Each connection gets the server id `firstId + id - 1`. */
export const fakeMongo = (given: MongoConnectOptions, clock: Clock, firstId = 100): FakeMongo => {
  const { options } = given;
  const address = given.url.slice("mongodb://".length).split(",")[0]!.replace(/\/$/, "");
  const listeners = new Map<string, Set<Listener>>();
  const calls: Array<readonly [string, MongoDocument]> = [];
  const all: Connection[] = [];
  const idle: Connection[] = [];
  const queue: Array<{ readonly give: (connection: Connection) => void; readonly cancel: Cancel }> = [];
  const waiters = new Set<{ readonly wake: () => void; readonly fail: (error: Error) => void }>();
  let opened = 0;
  let started = false;
  let closed = false;
  let writable = false;
  let lastAnswer = 0;
  let loop: Cancel = () => {};
  let writeoffTimer: Cancel | null = null;

  const emit = (event: string, payload: unknown): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) (listener as (payload: unknown) => void)(payload);
  };

  class Connection implements FakeMongoConnection {
    readonly id: number;
    readonly serverConnectionId: number;
    idleSince: number;
    fail: ((error: Error) => void) | null = null;

    constructor(id: number) {
      this.id = id;
      this.serverConnectionId = firstId + id - 1;
      this.idleSince = clock.now();
    }

    get busy(): boolean {
      return this.fail !== null;
    }

    /** The driver destroys the socket, and fails the command on it. */
    close(error: Error): void {
      const at = all.indexOf(this);
      if (at >= 0) all.splice(at, 1);
      const resting = idle.indexOf(this);
      if (resting >= 0) idle.splice(resting, 1);
      const fail = this.fail;
      this.fail = null;
      fail?.(error);
    }

    release(): void {
      this.fail = null;
      if (!all.includes(this)) return;
      const next = queue.shift();
      if (next !== undefined) {
        next.cancel();
        next.give(this);
        return;
      }
      this.idleSince = clock.now();
      idle.push(this);
    }
  }

  const servers = (type: string) => new Map([[address, { type }]]);
  const setWritable = (value: boolean): void => {
    if (writable === value) return;
    writable = value;
    emit("topologyDescriptionChanged", { newDescription: { servers: servers(value ? "RSPrimary" : "Unknown") } });
    if (value) for (const waiter of [...waiters]) waiter.wake();
  };

  /** The write-off of the server: the monitor marks it unknown, clears the pool, and fails each command in flight. */
  const writeOff = (failure: Error): void => {
    writeoffTimer?.();
    writeoffTimer = null;
    emit("serverHeartbeatFailed", { connectionId: address, failure });
    setWritable(false);
    emit("connectionPoolCleared", { address, interruptInUseConnections: true });
    for (const connection of [...all])
      connection.close(new FakeMongoError("PoolClearedOnNetworkError", `Connection to ${address} interrupted due to server monitor timeout`));
  };

  /** One check of the monitor. A server that answers is writable. A silent one is written off after its last answer. */
  const check = (): void => {
    if (closed) return;
    const mode = fake.mode;
    if (mode === "up" || mode === "stall") {
      lastAnswer = clock.now();
      writeoffTimer?.();
      writeoffTimer = null;
      setWritable(true);
    } else if (mode === "refuse") {
      const refused = new FakeMongoError("MongoNetworkError", `connect ECONNREFUSED ${address}`);
      if (writable) writeOff(refused);
      else emit("serverHeartbeatFailed", { connectionId: address, failure: refused });
    } else if (writable && writeoffTimer === null && options.connectTimeoutMS > 0) {
      // the stream of the monitor times out at connectTimeoutMS + heartbeatFrequencyMS after its last answer
      const at = lastAnswer + options.connectTimeoutMS + options.heartbeatFrequencyMS;
      writeoffTimer = clock.after(at - clock.now(), () => {
        writeoffTimer = null;
        if (fake.mode === "silent" || fake.mode === "frozen")
          writeOff(new FakeMongoError("MongoNetworkTimeoutError", `connection timed out to ${address}`));
      });
    }
  };
  const tick = (): void => {
    check();
    if (!closed) loop = clock.after(options.heartbeatFrequencyMS, tick);
  };
  const start = (): void => {
    if (started) return;
    started = true;
    void Promise.resolve().then(check);
    loop = clock.after(options.heartbeatFrequencyMS, tick);
  };

  /** This function waits for a writable server, for serverSelectionTimeoutMS at most. */
  const selected = (signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
      if (writable) {
        resolve();
        return;
      }
      const end = (): void => {
        timer();
        waiters.delete(waiter);
        signal?.removeEventListener("abort", aborted);
      };
      const waiter = {
        wake: () => {
          end();
          resolve();
        },
        fail: (error: Error) => {
          end();
          reject(error);
        },
      };
      const aborted = (): void => waiter.fail(new FakeMongoError("AbortError", "This operation was aborted"));
      const timer = clock.after(options.serverSelectionTimeoutMS, () =>
        waiter.fail(new FakeMongoError("MongoServerSelectionError", `Server selection timed out after ${options.serverSelectionTimeoutMS} ms`)),
      );
      waiters.add(waiter);
      signal?.addEventListener("abort", aborted, { once: true });
    });

  /** This function opens a new connection: the TCP connect and the handshake, under connectTimeoutMS. */
  const open = (): Promise<Connection> =>
    new Promise((resolve, reject) => {
      const mode = fake.mode;
      if (mode === "refuse") {
        void Promise.resolve().then(() => reject(new FakeMongoError("MongoNetworkError", `connect ECONNREFUSED ${address}`, { beforeHandshake: true })));
        return;
      }
      if (mode === "silent" || mode === "frozen") {
        if (options.connectTimeoutMS > 0)
          clock.after(options.connectTimeoutMS, () =>
            reject(new FakeMongoError("MongoNetworkTimeoutError", `connection timed out to ${address}`, { beforeHandshake: true })),
          );
        return;
      }
      opened += 1;
      const connection = new Connection(opened);
      all.push(connection);
      void Promise.resolve().then(() => {
        emit("connectionReady", { connectionId: connection.id, address });
        resolve(connection);
      });
    });

  /** This function checks out a connection: an idle one, a new one, or one from the queue of a full pool. */
  const checkout = (): Promise<Connection> => {
    for (;;) {
      const last = idle.pop();
      if (last === undefined) break;
      // the driver checks the idle time only at a checkout, with no timer
      if (options.maxIdleTimeMS > 0 && clock.now() - last.idleSince > options.maxIdleTimeMS) last.close(new Error("idle"));
      else return Promise.resolve(last);
    }
    if (all.length < options.maxPoolSize) return open();
    return new Promise((resolve, reject) => {
      const cancel =
        options.waitQueueTimeoutMS > 0
          ? clock.after(options.waitQueueTimeoutMS, () => {
              queue.splice(queue.indexOf(entry), 1);
              reject(new FakeMongoError("MongoWaitQueueTimeoutError", "Timed out while checking out a connection from connection pool"));
            })
          : () => {};
      const entry = { give: resolve, cancel };
      queue.push(entry);
    });
  };

  /** This function sends a command on a connection, and gives its reply. */
  const send = (connection: Connection, database: string, document: MongoDocument, signal: AbortSignal | undefined): Promise<MongoDocument> =>
    new Promise((resolve, reject) => {
      let socket: Cancel = () => {};
      let deadline: Cancel = () => {};
      const done = (): void => {
        socket();
        deadline();
        signal?.removeEventListener("abort", aborted);
      };
      connection.fail = (error) => {
        done();
        reject(error);
      };
      // an abort during the read closes the connection
      const aborted = (): void => connection.close(new FakeMongoError("AbortError", "This operation was aborted"));
      signal?.addEventListener("abort", aborted, { once: true });
      calls.push([database, document]);
      emit("commandStarted", { connectionId: connection.id, address, serverConnectionId: BigInt(connection.serverConnectionId) });
      if (options.socketTimeoutMS > 0)
        socket = clock.after(options.socketTimeoutMS, () =>
          connection.close(new FakeMongoError("MongoNetworkTimeoutError", `connection ${connection.id} to ${address} timed out`)),
        );
      const answer = (result: MongoDocument | Error): void => {
        done();
        connection.release();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      if (fake.mode === "up") {
        const result = fake.reply(document);
        void Promise.resolve().then(() => {
          if (connection.fail !== null) answer(result);
        });
      } else if (fake.mode === "stall" && typeof document["maxTimeMS"] === "number") {
        deadline = clock.after(document["maxTimeMS"], () =>
          answer(new FakeMongoError("MongoServerError", "operation exceeded time limit", { code: 50 })),
        );
      }
    });

  const db = (database: string): MongoDb => ({
    async command(document, sendOptions = {}) {
      const { signal } = sendOptions;
      if (closed) throw new FakeMongoError("MongoClientClosedError", "Operation interrupted because client was closed");
      // a command opens the topology again after a failed connect
      start();
      await selected(signal);
      if (signal?.aborted) throw new FakeMongoError("AbortError", "This operation was aborted");
      const connection = await checkout();
      return send(connection, database, document, signal);
    },
  });

  const fake: FakeMongo = {
    given,
    calls,
    get connections() {
      return all;
    },
    get writable() {
      return writable;
    },
    mode: "up",
    reply: () => ({ ok: 1 }),
    connect() {
      start();
      return selected(undefined);
    },
    async close() {
      closed = true;
      loop();
      writeoffTimer?.();
      for (const waiter of [...waiters]) waiter.fail(new FakeMongoError("MongoTopologyClosedError", "Topology is closed"));
      // the driver first fails the commands of each checked-out connection
      for (const connection of [...all]) connection.close(new FakeMongoError("MongoNetworkError", `connection ${connection.id} to ${address} closed`));
      // then it waits for endSessions on a server that it can still select. A silent server does not answer
      if (writable && (fake.mode === "silent" || fake.mode === "frozen"))
        await new Promise<void>((resolve) => {
          if (options.socketTimeoutMS > 0) clock.after(options.socketTimeoutMS, resolve);
        });
    },
    db,
    breakConnections(kind) {
      const error = new FakeMongoError("MongoNetworkError", kind === "rst" ? `read ECONNRESET` : `connection to ${address} closed`);
      for (const connection of [...all]) connection.close(error);
      // the stream of the monitor breaks too, and the monitor checks again at once
      if (writable) writeOff(error);
      if (started && !closed) void Promise.resolve().then(check);
    },
    emitError(error) {
      if ((listeners.get("error")?.size ?? 0) === 0) throw error;
      emit("error", error);
    },
    on(event: MongoEventName, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return fake;
    },
    off(event: MongoEventName, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return fake;
    },
  } as FakeMongo;
  return fake;
};
