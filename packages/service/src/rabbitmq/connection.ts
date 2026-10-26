import type { ClientSocket, Factory } from "../client/core.ts";

/** A message is a message of the broker, as amqplib gives it from `get`. The wrapper reads only these fields. */
export interface RabbitMessage {
  readonly content: Buffer;
  readonly fields: {
    readonly deliveryTag: number;
    readonly redelivered: boolean;
    readonly exchange: string;
    readonly routingKey: string;
    /** This count is the number of messages that stay on the queue after this one. */
    readonly messageCount?: number | undefined;
  };
  readonly properties: { readonly headers?: Readonly<Record<string, unknown>> | undefined; readonly [property: string]: unknown };
}

/** These are the properties of a publish that amqplib takes, for example `persistent`, `messageId` and `headers`. */
export type RabbitPublishOptions = Readonly<Record<string, unknown>>;

/** These are the events of a channel that the wrapper listens to. */
export type RabbitChannelEvent = "error" | "close";

/**
 * A channel is the part of a `ConfirmChannel` of amqplib 2 that the wrapper uses. A confirm channel
 * gives one result to the callback of each publish. The result is null for a `basic.ack`. It is an
 * error for a `basic.nack` and for the end of the channel.
 */
export interface RabbitChannel {
  /** This method writes one message. It throws when the channel is closed or closing. */
  publish(exchange: string, routingKey: string, content: Buffer, options: RabbitPublishOptions, callback: (error: Error | null) => void): boolean;
  /** This method takes one message (`basic.get`), or gives false when the queue is empty. It has no timer of its own. */
  get(queue: string, options?: { readonly noAck?: boolean | undefined }): Promise<RabbitMessage | false>;
  /** This method declares an exchange in passive mode: an RPC that changes nothing. The round-trip check uses it. */
  checkExchange(exchange: string): Promise<unknown>;
  /** This method acknowledges one message. It is one frame, with no reply. */
  ack(message: RabbitMessage): void;
  /** This method gives one message back to the broker, to the queue or to its dead-letter route. It is one frame, with no reply. */
  nack(message: RabbitMessage, allUpTo?: boolean, requeue?: boolean): void;
  close(): Promise<void>;
  on(event: RabbitChannelEvent, listener: (error?: Error) => void): unknown;
  off(event: RabbitChannelEvent, listener: (error?: Error) => void): unknown;
}

/** These are the events of a connection that the wrapper listens to. The event `blocked` gives the reason of the broker. */
export type RabbitConnectionEvent = "error" | "close" | "blocked" | "unblocked";

/**
 * A connection is the part of a `ChannelModel` of amqplib 2 that the wrapper uses. A `ChannelModel`
 * has each part. A fake for tests has them too. Thus the package depends on no type of amqplib.
 */
export interface RabbitConnection {
  /** This method opens a channel with confirms (`confirm.select`). */
  createConfirmChannel(): Promise<RabbitChannel>;
  /** This method sends `connection.close`, and waits for `connection.close-ok`. Behind a black hole, it waits with no bound. */
  close(): Promise<void>;
  on(event: RabbitConnectionEvent, listener: (detail?: unknown) => void): unknown;
  off(event: RabbitConnectionEvent, listener: (detail?: unknown) => void): unknown;
  /** This field holds the socket. The join reads its addresses, and the bounded close destroys it. */
  readonly connection: { readonly stream?: ClientSocket | undefined };
}

/**
 * These are the socket options that the wrapper gives amqplib. Each one comes from the declaration.
 * At its defaults, amqplib sets no connect timeout, no keepalive and no TCP_NODELAY.
 */
export interface RabbitSocketOptions {
  /** This time bounds the TCP connect and the handshake. The timer stops when the connection opens. A time of 0 is no bound. */
  readonly timeout: number;
  /** The library turns Nagle off only when the caller asks. A confirm and a reply then do not wait for a delayed ACK. */
  readonly noDelay: true;
  readonly keepAlive: boolean;
  /** This time is the idle time of TCP keepalive, in milliseconds. Node truncates it to whole seconds. */
  readonly keepAliveDelay?: number | undefined;
  /** The broker shows `connection_name` in its management view and its log, thus the prober can join on it too. */
  readonly clientProperties: { readonly connection_name: string };
}

/** These are the arguments of `connect(url, socketOptions)`. The URL gives the host, the vhost, the user and the heartbeat. */
export interface RabbitConnectOptions {
  readonly url: string;
  readonly socketOptions: RabbitSocketOptions;
}

/** A connection factory makes one connection of amqplib from its options. A failure to open rejects. */
export type RabbitFactory = Factory<RabbitConnectOptions, RabbitConnection>;

/**
 * This factory opens a connection of amqplib. It loads amqplib only when a client connects, thus a
 * service that does not use RabbitMQ does not need it. The specifier is a value, thus the package
 * needs no types of amqplib. The built-in recovery of amqplib stays off, because the wrapper connects again by itself.
 */
export const nodeAmqp: RabbitFactory = async ({ url, socketOptions }) => {
  const specifier = "amqplib";
  type Connect = (url: string, options: RabbitSocketOptions) => Promise<RabbitConnection>;
  const loaded = (await import(specifier)) as { readonly connect?: Connect; readonly default?: { readonly connect: Connect } };
  const connect = loaded.connect ?? loaded.default?.connect;
  if (connect === undefined) throw new Error("amqplib gives no connect function");
  return connect(url, socketOptions);
};
