// A fake WebSocket server for the tests of the client, on a fake clock. It opens no socket. Each
// connection gives its events in a later microtask, as ws does, and holds them until the client listens.

import type { Clock } from "../clock.ts";
import type { ClientSocket } from "../client/core.ts";
import type { WsConnectOptions, WsConnection, WsListeners } from "./connection.ts";

/**
 * The mode of the server, read at each step:
 * - `up`: the server takes the upgrade, answers each request through `answer`, and answers each ping and each close frame.
 * - `refuse`: the server refuses each new connection.
 * - `silent`: the network drops each segment. No open, no reply, no pong and no close frame come.
 * - `stall`: the server holds each reply, and its library still answers each ping and each close frame.
 */
export type FakeWsMode = "up" | "refuse" | "silent" | "stall";

/** A fake connection is one connection of the fake server, and the record of what the client wrote on it. */
export interface FakeWsConnection extends WsConnection {
  readonly options: WsConnectOptions;
  /** These are the messages that the client wrote, in sequence. */
  readonly sent: Array<string | Buffer>;
  /** These are the payloads of the ping frames that the client wrote, in sequence. */
  readonly pings: Buffer[];
  /** These are the close frames that the client wrote. */
  readonly closes: Array<{ readonly code: number; readonly reason: string }>;
  readonly terminated: boolean;
  /** True tells that the connection gave its close event. */
  readonly ended: boolean;
  /** This method sends one message of the server. */
  push(data: string | Buffer, binary?: boolean): void;
  /** This method sends one pong frame of the server, for example a pong for the latest ping only. */
  pong(data: Buffer): void;
  /** This method resets the connection: an error ECONNRESET, then a close with code 1006. */
  reset(): void;
  /** This method ends the connection with a FIN and no close frame: a close with code 1006. */
  fin(): void;
}

/** A fake server makes the connections of a client, and holds its mode. */
export interface FakeWsServer {
  mode: FakeWsMode;
  /** This function gives the reply to a message, or null for no reply. The default sends the message back. */
  answer: (data: Buffer) => string | Buffer | null;
  /** This time is the delay of each reply, in milliseconds on the clock. */
  replyDelay: number;
  /** This time is the delay of each pong, in milliseconds on the clock. */
  pongDelay: number;
  /** This text is the subprotocol that the server chooses. */
  protocol: string;
  readonly connections: FakeWsConnection[];
  /** This method makes one connection. It is the `create` option of the client. */
  create(options: WsConnectOptions): FakeWsConnection;
  /** This method gives the latest connection. */
  latest(): FakeWsConnection;
}

/** This function makes a fake WebSocket server on a clock. */
export const fakeWsServer = (clock: Clock): FakeWsServer => {
  const server: FakeWsServer = {
    mode: "up",
    answer: (data) => data,
    replyDelay: 0,
    pongDelay: 0,
    protocol: "",
    connections: [],
    latest: () => {
      const last = server.connections.at(-1);
      if (last === undefined) throw new Error("the fake server has no connection");
      return last;
    },
    create(options) {
      const index = server.connections.length;
      let listeners: WsListeners | null = null;
      const held: Array<(given: WsListeners) => void> = [];
      let socket: ClientSocket | undefined;
      let opened = false;
      let ended = false;
      let terminated = false;
      const sent: Array<string | Buffer> = [];
      const pings: Buffer[] = [];
      const closes: Array<{ code: number; reason: string }> = [];
      const emit = (event: (given: WsListeners) => void): void => {
        queueMicrotask(() => {
          if (listeners === null) held.push(event);
          else event(listeners);
        });
      };
      const later = (delay: number, run: () => void): void => {
        if (delay > 0) clock.after(delay, run);
        else run();
      };
      const end = (code: number, reason: string): void => {
        if (ended) return;
        ended = true;
        emit((given) => given.close(code, reason));
      };
      const connection: FakeWsConnection = {
        options,
        sent,
        pings,
        closes,
        get terminated() {
          return terminated;
        },
        get ended() {
          return ended;
        },
        get socket() {
          return socket;
        },
        get protocol() {
          return server.protocol;
        },
        listen(given) {
          listeners = given;
          for (const event of held.splice(0)) event(given);
        },
        send(data, callback) {
          if (!opened) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
          if (ended) {
            queueMicrotask(() => callback(new Error("WebSocket is not open: readyState 3 (CLOSED)")));
            return;
          }
          sent.push(data);
          queueMicrotask(() => callback());
          if (server.mode !== "up") return;
          const reply = server.answer(typeof data === "string" ? Buffer.from(data, "utf8") : data);
          if (reply === null) return;
          later(server.replyDelay, () => {
            if (!ended && server.mode === "up") emit((given) => given.message(typeof reply === "string" ? Buffer.from(reply, "utf8") : reply, typeof reply !== "string"));
          });
        },
        ping(data) {
          if (!opened) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
          if (ended) return;
          pings.push(data);
          if (server.mode !== "up" && server.mode !== "stall") return;
          later(server.pongDelay, () => {
            if (!ended && (server.mode === "up" || server.mode === "stall")) emit((given) => given.pong(data));
          });
        },
        close(code, reason) {
          if (ended) return;
          closes.push({ code, reason });
          if (server.mode === "up" || server.mode === "stall") end(code, reason);
        },
        terminate() {
          terminated = true;
          end(1006, "");
        },
        push(data, binary = typeof data !== "string") {
          if (!ended) emit((given) => given.message(typeof data === "string" ? Buffer.from(data, "utf8") : data, binary));
        },
        pong(data) {
          if (!ended) emit((given) => given.pong(data));
        },
        reset() {
          if (ended) return;
          emit((given) => given.error(new Error("read ECONNRESET")));
          end(1006, "");
        },
        fin() {
          end(1006, "");
        },
      };
      server.connections.push(connection);
      if (server.mode === "refuse") {
        emit((given) => given.error(new Error("connect ECONNREFUSED")));
        end(1006, "");
      } else if (server.mode !== "silent") {
        socket = { localAddress: "127.0.0.1", localPort: 40000 + index, remoteAddress: "127.0.0.1", remotePort: 8080 };
        opened = true;
        emit((given) => given.open());
      }
      return connection;
    },
  };
  return server;
};
