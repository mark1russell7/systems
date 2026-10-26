import type { ClientSocket, Factory } from "../client/core.ts";

/** A pg socket is the socket of a client in the core: the join of the prober and the bounded close read it. */
export type PgSocket = ClientSocket;

/** A query result is the part of a result of pg that the wrapper gives back. */
export interface PgResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

/**
 * A pool client is the part of a `pg.PoolClient` that the wrapper uses. A pg 8 client has each part.
 * A fake for tests has them too. Thus the package depends on no type of pg.
 */
export interface PgPoolClient {
  /** This number is the id of the backend from BackendKeyData, which the server sends at the startup. */
  readonly processID?: number | null | undefined;
  /** This connection holds the socket of the client. */
  readonly connection?: { readonly stream?: PgSocket | undefined } | undefined;
  query(text: string, values?: readonly unknown[]): Promise<PgResult<never>>;
  /** This method gives the client back to the pool. With an error, the pool ends the client. */
  release(error?: Error | boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** A pool is the part of a `pg.Pool` that the wrapper uses. */
export interface PgPool {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  on(event: "connect" | "remove", listener: (client: PgPoolClient) => void): unknown;
  on(event: "error", listener: (error: Error, client: PgPoolClient) => void): unknown;
  off(event: "connect" | "remove", listener: (client: PgPoolClient) => void): unknown;
  off(event: "error", listener: (error: Error, client: PgPoolClient) => void): unknown;
}

/**
 * These are the options that the wrapper gives `pg.Pool`. Each one comes from the declaration. The
 * wrapper sets each option that has an effect on a timer, thus no default of pg decides one. A knob
 * of pg at 0 has no timer. The wrapper writes "infinite" as 0, and it refuses a bound of 0.
 */
export interface PgPoolOptions {
  readonly host: string;
  readonly port: number;
  readonly database?: string | undefined;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  /** The server shows this name in `pg_stat_activity`, thus the prober can join on it too. */
  readonly application_name: string;
  readonly max: number;
  readonly min: number;
  /** This time bounds the TCP connect, the startup and the authentication. It also bounds a checkout from a full pool. */
  readonly connectionTimeoutMillis: number;
  /** This time bounds each query on the client, from `client.query`. The client sends no cancel at its end. */
  readonly query_timeout: number;
  /** This time is the deadline of each statement on the server. The client sends it in the startup message. Undefined does not send it. */
  readonly statement_timeout: number | undefined;
  /** This time ends an idle client of the pool. 0 is no idle timer. */
  readonly idleTimeoutMillis: number;
  /** This time ends a client at this age from its connect, in whole seconds. 0 is no age. */
  readonly maxLifetimeSeconds: number;
  readonly keepAlive: boolean;
  /** This time is the idle time of TCP keepalive. Node truncates it to whole seconds. */
  readonly keepAliveInitialDelayMillis: number;
  /** The idle timer and the idle sockets do not keep the process alive (A14). The lifecycle holds the process. */
  readonly allowExitOnIdle: true;
}

/** A pool factory makes the pool of the client from its options. */
export type PoolFactory = Factory<PgPoolOptions, PgPool>;

/**
 * This factory makes a `pg.Pool`. It loads pg only when a client connects, thus a service that does
 * not use PostgreSQL does not need pg. The specifier is a value, thus the package needs no types of pg.
 */
export const nodePostgres: PoolFactory = async (options) => {
  const specifier = "pg";
  const loaded = (await import(specifier)) as { readonly default: { readonly Pool: new (options: PgPoolOptions) => PgPool } };
  return new loaded.default.Pool(options);
};
