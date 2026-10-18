// A fake server of node:http for the unit tests: no socket and no port. It gives the events and the
// methods that the transport and the probe server use, as Node gives them. The tests that use real
// sockets run in CI only (HTTP_IT=1).

import { EventEmitter } from "node:events";
import type { Server } from "node:http";

/** A fake socket is the stream of one fake connection. Its close comes on the next tick, as in Node. */
export class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly written: string[] = [];
  write(data: string): boolean {
    if (!this.destroyed) this.written.push(data);
    return true;
  }
  end(data?: string): this {
    if (data !== undefined) this.write(data);
    this.destroy();
    return this;
  }
  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    process.nextTick(() => this.emit("close", false));
    return this;
  }
}

/** A fake response answers one fake request. It uses its own `writeHead` for implicit headers, as Node does. */
export class FakeResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  writableFinished = false;
  shouldKeepAlive = true;
  readonly headers: Map<string, string> = new Map();
  readonly chunks: string[] = [];
  constructor(readonly socket: FakeSocket) {
    super();
  }
  setHeader(name: string, value: string | number): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }
  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }
  hasHeader(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }
  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }
  /** This method takes the forms of Node: a status, a status message or not, and the headers as an object or a flat list. */
  writeHead(status: number, message?: string | Readonly<Record<string, string>> | readonly string[], given?: Readonly<Record<string, string>> | readonly string[]): this {
    if (this.headersSent) throw new Error("the headers went already");
    this.statusCode = status;
    const headers = typeof message === "string" ? given : message;
    if (Array.isArray(headers)) for (let at = 0; at + 1 < headers.length; at += 2) this.setHeader(headers[at]!, headers[at + 1]!);
    else for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value as string);
    // Node closes the connection after the response when it cannot keep it
    if (!this.shouldKeepAlive) this.setHeader("connection", "close");
    this.headersSent = true;
    return this;
  }
  write(chunk: string | Uint8Array): boolean {
    if (!this.headersSent) this.writeHead(this.statusCode);
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }
  end(chunk?: string | Uint8Array): this {
    if (this.writableEnded) return this;
    if (chunk !== undefined) this.write(chunk);
    else if (!this.headersSent) this.writeHead(this.statusCode);
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("finish");
    process.nextTick(() => this.emit("close"));
    return this;
  }
  destroy(): this {
    this.socket.destroy();
    return this;
  }
  /** This flag tells if the socket of the response is destroyed. */
  get destroyed(): boolean {
    return this.socket.destroyed;
  }
  /** This flag tells if the connection closes after the response. */
  get last(): boolean {
    return !this.shouldKeepAlive || this.getHeader("connection") === "close";
  }
}

/** A fake answer is what the client of a fake request gets. */
export interface FakeAnswer {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** A fake connection is one client connection to the fake server. */
export class FakeConnection {
  idle = true;
  upgraded = false;
  /** This response is the response of the last request on the connection, for a test that reads a stream as it comes. */
  response: FakeResponse | null = null;
  constructor(
    readonly server: FakeServer,
    readonly socket: FakeSocket,
  ) {}
  /** This method sends a request on the connection, and gives the answer, or an error when the connection closes first. */
  request(url: string, method = "GET"): Promise<FakeAnswer> {
    if (this.socket.destroyed) return Promise.reject(new Error("ECONNRESET: the connection is closed"));
    this.idle = false;
    const req = Object.assign(new EventEmitter(), { url, method, headers: {} });
    const res = new FakeResponse(this.socket);
    this.response = res;
    return new Promise<FakeAnswer>((resolve, reject) => {
      const lost = (): void => reject(new Error("ECONNRESET: the connection closed before the answer"));
      this.socket.once("close", lost);
      res.once("finish", () => {
        this.socket.off("close", lost);
        resolve({ status: res.statusCode, headers: new Map(res.headers), body: res.chunks.join("") });
        if (res.last) this.socket.destroy();
        else this.idle = true;
      });
      this.socket.once("close", () => {
        if (!res.writableEnded) res.emit("close");
      });
      this.server.emit("request", req, res);
    });
  }
  /** This method sends an upgrade request on the connection. The server then owns the socket. */
  upgrade(url: string): FakeSocket {
    this.idle = false;
    this.upgraded = true;
    const req = Object.assign(new EventEmitter(), { url, method: "GET", headers: { upgrade: "websocket" } });
    this.server.emit("upgrade", req, this.socket, Buffer.alloc(0));
    return this.socket;
  }
}

/** A fake server is a server of `node:http` with no socket. A test connects to it and sends requests. */
export class FakeServer extends EventEmitter {
  listening = false;
  keepAliveTimeout = 5000;
  keepAliveTimeoutBuffer = 1000;
  readonly listens: unknown[] = [];
  readonly connections: Set<FakeConnection> = new Set();
  failListen: Error | null = null;
  private closing = false;
  listen(options: unknown): this {
    this.listens.push(options);
    process.nextTick(() => {
      if (this.failListen !== null) {
        this.emit("error", this.failListen);
        return;
      }
      this.listening = true;
      this.closing = false;
      this.emit("listening");
    });
    return this;
  }
  close(done?: (error?: Error) => void): this {
    if (done !== undefined) this.once("close", () => done());
    this.listening = false;
    this.closing = true;
    this.closeIdleConnections();
    this.closeIfDrained();
    return this;
  }
  closeIdleConnections(): void {
    for (const connection of this.connections) if (connection.idle && !connection.upgraded) connection.socket.destroy();
  }
  /** This method destroys each connection of HTTP. As in Node, an upgraded connection is not in the list. */
  closeAllConnections(): void {
    for (const connection of this.connections) if (!connection.upgraded) connection.socket.destroy();
  }
  /** This method opens a connection, or it throws a refusal when the listener is closed. */
  connect(): FakeConnection {
    if (!this.listening) throw Object.assign(new Error("ECONNREFUSED: the listener is closed"), { code: "ECONNREFUSED" });
    const socket = new FakeSocket();
    const connection = new FakeConnection(this, socket);
    this.connections.add(connection);
    socket.once("close", () => {
      this.connections.delete(connection);
      this.closeIfDrained();
    });
    this.emit("connection", socket);
    return connection;
  }
  /** This method sends one request on a new connection. */
  async request(url: string, method = "GET"): Promise<FakeAnswer> {
    return this.connect().request(url, method);
  }
  private closeIfDrained(): void {
    if (!this.closing || this.listening || this.connections.size > 0) return;
    this.closing = false;
    process.nextTick(() => this.emit("close"));
  }
  /** This value is the fake server with the type of a server of `node:http`, for the code under test. */
  get asServer(): Server {
    return this as unknown as Server;
  }
}

/** A pushed source is an async iterable whose items, end and failure a test gives. Its `return()` ends it. */
export interface PushedSource<T> {
  readonly iterable: AsyncIterable<T>;
  push(value: T): void;
  finish(): void;
  fail(error: unknown): void;
  /** This flag tells if a reader stopped the source through `return()`. */
  readonly returned: boolean;
}

/** This function makes a pushed source, a stream of a work for the tests of a stream. */
export const pushedSource = <T>(): PushedSource<T> => {
  const queue: Array<IteratorResult<T>> = [];
  let wake: (() => void) | null = null;
  let failure: unknown = null;
  let returned = false;
  const poke = (): void => {
    wake?.();
    wake = null;
  };
  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<T>> {
        for (;;) {
          if (failure !== null) throw failure;
          if (returned) return { value: undefined, done: true };
          const step = queue.shift();
          if (step !== undefined) return step;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
      async return(): Promise<IteratorResult<T>> {
        returned = true;
        poke();
        return { value: undefined, done: true };
      },
    }),
  };
  return {
    iterable,
    push: (value) => {
      queue.push({ value, done: false });
      poke();
    },
    finish: () => {
      queue.push({ value: undefined, done: true });
      poke();
    },
    fail: (error) => {
      failure = error;
      poke();
    },
    get returned() {
      return returned;
    },
  };
};
