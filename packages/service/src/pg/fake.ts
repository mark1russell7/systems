// A fake pg.Pool for the tests of the pg client, on a fake clock. It keeps the parts of pg 8.23.1
// and pg-pool 3.14.0 that the client depends on. These parts are in the document node-postgres of
// @mark1russell7/machines: the last idle client goes out first with no test, a full pool queues a
// checkout under connectionTimeoutMillis, query_timeout fails a query and keeps it active, a
// release with an error ends the client, and the pool emits remove only when the socket closes. A
// test changes what the server does: it answers, it refuses connections, it is silent, it is
// frozen, or it holds each statement.

import type { Cancel, Clock } from "../clock.ts";
import type { PgPool, PgPoolClient, PgPoolOptions, PgResult, PgSocket } from "./connection.ts";

/**
 * What the server does: it answers, it refuses (a reset), it is silent (a black hole), it is
 * frozen (its kernel accepts a connection, and nothing answers), or it holds each statement
 * (a stall). A held statement ends at `statement_timeout`, as the server ends it.
 */
export type PgServerMode = "up" | "refuse" | "silent" | "frozen" | "stall";

/** A database error, as pg-protocol gives an ErrorResponse. */
export class DatabaseError extends Error {
  constructor(
    text: string,
    readonly code: string,
    readonly severity: "ERROR" | "FATAL" = "ERROR",
  ) {
    super(text);
  }
}

type Listener = (...args: never[]) => void;

interface Query {
  readonly settle: (result: PgResult<never> | Error) => void;
}

/** A fake client of the pool. */
export interface FakePgClient extends PgPoolClient {
  readonly generation: number;
  /** True when the socket closed. */
  readonly closed: boolean;
  /** True when the client has a query that waits for its answer. */
  readonly busy: boolean;
}

/** A fake pool, with what a test must see and change. */
export interface FakePg extends PgPool {
  readonly options: PgPoolOptions;
  /** Each query that reached the server, in sequence. */
  readonly calls: ReadonlyArray<readonly [string, readonly unknown[]]>;
  /** The count of tries to connect. */
  readonly attempts: number;
  readonly clients: readonly FakePgClient[];
  mode: PgServerMode;
  /** The answer of the server to a query, when it answers. An error is an ErrorResponse. */
  reply: (text: string, values: readonly unknown[]) => PgResult<never> | Error;
  /** This method breaks each connection, as a reset or a FIN does. */
  breakConnections(kind: "rst" | "fin"): void;
}

/** This function makes a fake pool on a clock. Each connection gets the backend pid `firstPid + generation - 1`. */
export const fakePg = (options: PgPoolOptions, clock: Clock, firstPid = 4000): FakePg => {
  const listeners = new Map<string, Set<Listener>>();
  const calls: Array<readonly [string, readonly unknown[]]> = [];
  const clients: Client[] = [];
  const idle: Client[] = [];
  const waiting: Array<{ readonly give: (client: Client) => void; readonly cancel: Cancel }> = [];
  let attempts = 0;
  let ending = false;
  const ended: Array<() => void> = [];

  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) (listener as (...a: unknown[]) => void)(...args);
  };

  class Client implements FakePgClient {
    readonly processID: number;
    readonly generation: number;
    readonly connection: { readonly stream: PgSocket };
    closed = false;
    dead = false;
    removing = false;
    active: Query | null = null;
    idleTimer: Cancel = () => {};
    private readonly own = new Set<(error: Error) => void>();

    constructor(generation: number) {
      this.generation = generation;
      this.processID = firstPid + generation - 1;
      this.connection = {
        stream: {
          localAddress: "10.0.0.2",
          localPort: 50000 + generation,
          remoteAddress: "10.0.0.4",
          remotePort: options.port,
          destroy: () => this.socketClosed(new Error("Connection terminated unexpectedly")),
        },
      };
    }

    get busy(): boolean {
      return this.active !== null;
    }

    query(text: string, values: readonly unknown[] = []): Promise<PgResult<never>> {
      if (this.dead) return Promise.reject(new Error("Client has encountered a connection error and is not queryable"));
      return new Promise((resolve, reject) => {
        let timer: Cancel = () => {};
        let statement: Cancel = () => {};
        const query: Query = {
          settle: (result) => {
            timer();
            statement();
            if (this.active === query) this.active = null;
            if (result instanceof Error) reject(result);
            else resolve(result);
          },
        };
        this.active = query;
        calls.push([text, values]);
        if (options.query_timeout > 0) {
          // pg fails the query to its caller, and keeps it active: the client sends no cancel
          timer = clock.after(options.query_timeout, () => reject(new Error("Query read timeout")));
        }
        if (fake.mode === "up") {
          const answer = fake.reply(text, values);
          void Promise.resolve().then(() => query.settle(answer));
        } else if (fake.mode === "stall" && options.statement_timeout !== undefined) {
          statement = clock.after(options.statement_timeout, () =>
            query.settle(new DatabaseError("canceling statement due to statement timeout", "57014")),
          );
        }
      });
    }

    release(error?: Error | boolean): void {
      const held = clients.includes(this) && !idle.includes(this);
      if (!held) return;
      if (error !== undefined && error !== false) {
        this.end();
        return;
      }
      if (this.dead || ending) {
        this.end();
        return;
      }
      const next = waiting.shift();
      if (next !== undefined) {
        next.cancel();
        next.give(this);
        return;
      }
      idle.push(this);
      if (options.idleTimeoutMillis > 0 && clients.length > options.min)
        this.idleTimer = clock.after(options.idleTimeoutMillis, () => {
          idle.splice(idle.indexOf(this), 1);
          this.end();
        });
    }

    /** The end of pg: with an active query or a dead socket it destroys the socket, else it sends `Terminate` and half-closes. */
    end(): void {
      if (this.removing) return;
      this.removing = true;
      this.idleTimer();
      if (this.active !== null || this.dead || fake.mode === "up" || fake.mode === "stall" || fake.mode === "refuse")
        this.socketClosed(new Error("Connection terminated"));
      // behind a black hole or a frozen server, the FIN gets no answer and the socket stays open
    }

    socketClosed(error: Error): void {
      if (this.closed) return;
      this.closed = true;
      this.dead = true;
      this.active?.settle(error);
      const at = idle.indexOf(this);
      if (at >= 0) idle.splice(at, 1);
      this.idleTimer();
      clients.splice(clients.indexOf(this), 1);
      emit("remove", this);
      if (ending && clients.length === 0) for (const done of ended.splice(0)) done();
    }

    /** A failure of the connection: a reset or a FIN. */
    fail(error: Error): void {
      if (this.closed) return;
      const wasIdle = idle.includes(this);
      this.dead = true;
      this.active?.settle(error);
      // in Node, an error event with no listener throws
      if (wasIdle) {
        this.socketClosed(error);
        if ((listeners.get("error")?.size ?? 0) === 0) throw error;
        emit("error", error, this);
      } else {
        this.socketClosed(error);
        if (this.own.size === 0) throw error;
        for (const listener of [...this.own]) listener(error);
      }
    }

    on(_event: "error", listener: (error: Error) => void): unknown {
      this.own.add(listener);
      return this;
    }

    off(_event: "error", listener: (error: Error) => void): unknown {
      this.own.delete(listener);
      return this;
    }
  }

  /** A new client: the TCP connect and the startup, under connectionTimeoutMillis. */
  const open = (): Promise<Client> => {
    attempts += 1;
    return new Promise((resolve, reject) => {
      const timeout = clock.after(options.connectionTimeoutMillis, () =>
        reject(new Error("Connection terminated due to connection timeout")),
      );
      if (fake.mode === "refuse") {
        timeout();
        void Promise.resolve().then(() => reject(Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:5432"), { code: "ECONNREFUSED" })));
        return;
      }
      if (fake.mode !== "up" && fake.mode !== "stall") return;
      void Promise.resolve().then(() => {
        timeout();
        const client = new Client(attempts);
        clients.push(client);
        emit("connect", client);
        resolve(client);
      });
    });
  };

  const fake: FakePg = {
    options,
    calls,
    get attempts() {
      return attempts;
    },
    get clients() {
      return clients;
    },
    mode: "up",
    reply: () => ({ rows: [], rowCount: 0 }),
    get totalCount() {
      return clients.length;
    },
    get idleCount() {
      return idle.length;
    },
    get waitingCount() {
      return waiting.length;
    },
    connect() {
      if (ending) return Promise.reject(new Error("Cannot use a pool after calling end on the pool"));
      const last = idle.pop();
      if (last !== undefined) {
        last.idleTimer();
        return Promise.resolve(last);
      }
      if (clients.length < options.max) return open();
      return new Promise((resolve, reject) => {
        const cancel = clock.after(options.connectionTimeoutMillis, () => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(new Error("timeout exceeded when trying to connect"));
        });
        const entry = { give: resolve, cancel };
        waiting.push(entry);
      });
    },
    end() {
      ending = true;
      for (const client of idle.splice(0)) client.end();
      if (clients.length === 0) return Promise.resolve();
      return new Promise((resolve) => ended.push(resolve));
    },
    breakConnections(kind) {
      const error =
        kind === "rst"
          ? Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
          : new Error("Connection terminated unexpectedly");
      for (const client of [...clients]) client.fail(error);
    },
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return fake;
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return fake;
    },
  } as FakePg;
  return fake;
};
