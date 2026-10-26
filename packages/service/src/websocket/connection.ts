import type { ClientSocket, Factory } from "../client/core.ts";

/**
 * These are the listeners of one connection. The connection holds each event until the client
 * listens. Thus an event that comes between the creation and the listen does not go away.
 */
export interface WsListeners {
  /** This event tells that the upgrade ended with 101, and the connection can send. */
  open(): void;
  /** This event gives one message of the server. A text message is UTF-8 in the buffer. */
  message(data: Buffer, binary: boolean): void;
  /** This event gives the payload of one pong frame. */
  pong(data: Buffer): void;
  /** This event tells that the connection closed, with the code and the reason of the close frame. Code 1006 tells that no close frame came. */
  close(code: number, reason: string): void;
  /** This event gives an error of the connection. A close follows it. */
  error(error: Error): void;
}

/**
 * A connection is the part of a `WebSocket` of ws 8 that the wrapper uses. A fake for tests has
 * each part too. Thus the package depends on no type of ws.
 */
export interface WsConnection {
  /** This method gives the listeners of the connection. The connection then gives each event that it holds. */
  listen(listeners: WsListeners): void;
  /** This method writes one message. The callback gets an error when the write fails. It throws while the connection is not open. */
  send(data: string | Buffer, callback: (error?: Error) => void): void;
  /** This method writes one ping frame with this payload. It throws while the connection is not open. */
  ping(data: Buffer): void;
  /** This method writes a close frame, and waits for the close frame of the server. It destroys nothing. */
  close(code: number, reason: string): void;
  /** This method destroys the socket at once. The cells measured 0.3 ms to 1 ms from the call to the close of the socket. */
  terminate(): void;
  /** This field holds the socket after the upgrade, or undefined before it. The join reads its addresses. */
  readonly socket: ClientSocket | undefined;
  /** This text is the subprotocol that the server chose, or "" when it chose none. */
  readonly protocol: string;
}

/**
 * These are the options that the wrapper gives `new WebSocket(url, protocols, options)` of ws. Each
 * time comes from the declaration. ws gives the options that it does not read to `net.connect`.
 */
export interface WsDriverOptions {
  /** This time bounds the TCP connect and the upgrade, in milliseconds. */
  readonly handshakeTimeout: number;
  /** ws answers each ping of the server with a pong. The heartbeat of the server then finds the client alive. */
  readonly autoPong: true;
  /** This time bounds the close handshake of ws, in milliseconds. The wrapper gives its own bound, `close_bound`. */
  readonly closeTimeout: number;
  /** ws sets no keepalive on its socket. The wrapper turns it on only when the declaration gives an idle time. */
  readonly keepAlive: boolean;
  /** This time is the idle time of TCP keepalive, in milliseconds. Node truncates it to whole seconds. */
  readonly keepAliveInitialDelay?: number | undefined;
  /** These headers go with the upgrade request, for example `authorization`. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** These are the arguments of `new WebSocket(url, protocols, options)`. */
export interface WsConnectOptions {
  readonly url: string;
  readonly protocols: readonly string[];
  readonly options: WsDriverOptions;
}

/** A connection factory makes one connection from its options. The connection opens later, and tells it with the event `open`. */
export type WsFactory = Factory<WsConnectOptions, WsConnection>;

/** This type is the part of a `WebSocket` of ws 8 that the adapter uses. */
interface WsDriver {
  on(event: string, listener: (...args: never[]) => void): unknown;
  send(data: string | Buffer, callback: (error?: Error | null) => void): void;
  ping(data: Buffer): void;
  close(code: number, reason: string): void;
  terminate(): void;
  readonly protocol: string;
}

/** This function gives a message of ws as one buffer. At the default `binaryType` of ws, a message is a buffer already. */
const asBuffer = (data: unknown): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.from(data as ArrayBuffer);
};

/**
 * This function adapts a `WebSocket` of ws to a connection. It listens to `error` at once, because
 * in Node an error with no listener throws. It takes the socket from the event `upgrade`.
 */
export const adaptWs = (ws: WsDriver): WsConnection => {
  let socket: ClientSocket | undefined;
  let listeners: WsListeners | null = null;
  const held: Array<(given: WsListeners) => void> = [];
  const deliver = (event: (given: WsListeners) => void): void => {
    if (listeners === null) held.push(event);
    else event(listeners);
  };
  ws.on("upgrade", (response: { readonly socket?: ClientSocket }) => {
    socket = response.socket;
  });
  ws.on("open", () => deliver((given) => given.open()));
  ws.on("message", (data: unknown, binary: boolean) => deliver((given) => given.message(asBuffer(data), binary)));
  ws.on("pong", (data: Buffer) => deliver((given) => given.pong(data)));
  ws.on("close", (code: number, reason: Buffer) => deliver((given) => given.close(code, reason.toString("utf8"))));
  ws.on("error", (error: Error) => deliver((given) => given.error(error)));
  return {
    listen(given) {
      listeners = given;
      for (const event of held.splice(0)) event(given);
    },
    send: (data, callback) => ws.send(data, (error) => callback(error ?? undefined)),
    ping: (data) => ws.ping(data),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
    get socket() {
      return socket;
    },
    get protocol() {
      return ws.protocol;
    },
  };
};

/**
 * This factory makes a `WebSocket` of ws. It loads ws only when a client connects, thus a service
 * that does not use WebSocket does not need it. The specifier is a value, thus the package needs no types of ws.
 */
export const nodeWs: WsFactory = async ({ url, protocols, options }) => {
  const specifier = "ws";
  type Constructor = new (url: string, protocols: string[], options: WsDriverOptions) => WsDriver;
  const loaded = (await import(specifier)) as { readonly WebSocket?: Constructor; readonly default?: Constructor };
  const WebSocket = loaded.WebSocket ?? loaded.default;
  if (WebSocket === undefined) throw new Error("ws gives no WebSocket class");
  return adaptWs(new WebSocket(url, [...protocols], options));
};
