import type { ClientSocket, Factory } from "../client/core.ts";

/**
 * A Redis connection is the part of an ioredis client that the wrapper uses. An ioredis 6 client has
 * each part. A fake for tests has them too. Thus the package depends on no type of ioredis.
 */
export interface RedisConnection {
  /** This text is the state of the client: wait, connecting, connect, ready, close, reconnecting or end. */
  readonly status: string;
  /** This socket is the socket of the current connection, when there is one. */
  readonly stream?: RedisSocket | undefined;
  connect(): Promise<void>;
  /** This method sends one command, and gives the reply. */
  call(command: string, ...args: Array<string | number>): Promise<unknown>;
  quit(): Promise<unknown>;
  /** This method closes the connection at once. With `true`, the client then connects again. */
  disconnect(reconnect?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** A Redis socket is the socket of a client in the core: the join of the prober and the bounded close read it. */
export type RedisSocket = ClientSocket;

/**
 * These are the options that the wrapper gives ioredis. Each one comes from the declaration. The
 * wrapper sets each option that has an effect on a timer or on a send again, thus no default of
 * ioredis decides one.
 */
export interface RedisConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly db?: number | undefined;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  /** The wrapper connects in its own step of the startup. */
  readonly lazyConnect: true;
  readonly connectTimeout: number;
  readonly commandTimeout: number;
  /** This time destroys a socket that gives no data while a command waits. Undefined is no bound. */
  readonly socketTimeout: number | undefined;
  /** This time is the idle time of TCP keepalive. False is no keepalive. */
  readonly keepAlive: number | false;
  /** A command while the client is not ready fails at once: it did not reach the server. */
  readonly enableOfflineQueue: false;
  /** The client does not send again a command that can have reached the server. */
  readonly autoResendUnfulfilledCommands: false;
  readonly maxRetriesPerRequest: null;
  readonly enableReadyCheck: true;
  readonly connectionName: string;
  /** This function gives the delay before the next try to connect, or null to stop. */
  readonly retryStrategy: (times: number) => number | null;
}

/** A connection factory makes the connection of the client from its options. */
export type ConnectionFactory = Factory<RedisConnectionOptions, RedisConnection>;

/**
 * This factory makes an ioredis client. It loads ioredis only when a client connects, thus a
 * service that does not use Redis does not need ioredis.
 */
export const ioredis: ConnectionFactory = async (options) => {
  const loaded = (await import("ioredis")) as unknown as {
    readonly default: new (options: RedisConnectionOptions) => RedisConnection;
  };
  return new loaded.default(options);
};
