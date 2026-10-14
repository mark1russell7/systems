// A fake ioredis 6 for the tests of the Redis client, on a fake clock. It keeps the parts of ioredis
// that the client depends on: the sequence of states, a command that fails at once when the client is
// not ready (no offline queue), the timeout of each command, the destroy of a silent socket, the
// commands that a close leaves without an answer (ioredis does not send them again and does not
// settle them), and the connection attempts of the retry strategy. A test changes what the server
// does: it answers, it refuses connections, or it is silent.

import type { Clock } from "../clock.ts";
import type { RedisConnection, RedisConnectionOptions } from "./connection.ts";

/**
 * What the server does with the next segment: it answers, it refuses (a reset), it is silent (a
 * black hole), or it is frozen. The kernel of a frozen process accepts a new connection, and its
 * handshake gets no answer.
 */
export type ServerMode = "up" | "refuse" | "silent" | "frozen";

type Listener = (...args: unknown[]) => void;

/** A reply error, as ioredis gives for an error of the server. */
export class ReplyError extends Error {
  override readonly name = "ReplyError";
}

/** A fake connection, with what a test must see and change. */
export interface FakeRedis extends RedisConnection {
  readonly options: RedisConnectionOptions;
  /** Each command that reached the server, in sequence. */
  readonly calls: ReadonlyArray<readonly [string, ReadonlyArray<string | number>]>;
  /** The count of commands without an answer, which only their timeout can end. */
  readonly unanswered: number;
  /** The count of tries to connect. */
  readonly attempts: number;
  mode: ServerMode;
  /** The answer of the server to a command, when it answers. */
  reply: (command: string, args: ReadonlyArray<string | number>) => unknown;
  /** This method breaks the current connection, as a reset or a FIN does. */
  breakConnection(): void;
  /** This method answers each command that waits on the current connection, late, as a server does at the end of a stall. */
  answerWaiting(): void;
}

/** This function makes a fake ioredis on a clock. Each connection gets the client id `firstId + generation - 1`. */
export const fakeRedis = (options: RedisConnectionOptions, clock: Clock, firstId = 7): FakeRedis => {
  const listeners = new Map<string, Set<Listener>>();
  const calls: Array<readonly [string, ReadonlyArray<string | number>]> = [];
  let status = "wait";
  let generation = 0;
  let attempts = 0;
  let retries = 0;
  let manual = false;
  let socketTimer: (() => void) | null = null;
  // the next connection attempt, which a disconnect stops, as ioredis does
  let reconnect: (() => void) | null = null;
  // the commands written on the current connection, without an answer
  const waiting = new Set<{ readonly generation: number; readonly settle: (value: unknown, error?: Error) => void }>();
  let unanswered = 0;

  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };
  const setStatus = (to: string): void => {
    status = to;
    emit(to);
  };

  const closed = (): void => {
    socketTimer?.();
    socketTimer = null;
    // ioredis keeps these commands, and without autoResendUnfulfilledCommands it drops them: they stay without an answer
    waiting.clear();
    setStatus("close");
    if (manual) {
      manual = false;
      setStatus("end");
      return;
    }
    const delay = options.retryStrategy((retries += 1));
    if (delay === null) {
      setStatus("end");
      return;
    }
    setStatus("reconnecting");
    reconnect = clock.after(delay, () => {
      reconnect = null;
      void fake.connect().catch(() => {});
    });
  };

  const fake: FakeRedis = {
    options,
    calls,
    get unanswered() {
      return unanswered;
    },
    get attempts() {
      return attempts;
    },
    mode: "up",
    reply: (command) => (command.toUpperCase() === "PING" ? "PONG" : command.toUpperCase() === "CLIENT" ? firstId + generation - 1 : "OK"),
    get status() {
      return status;
    },
    get stream() {
      return status === "ready" || status === "connect"
        ? {
            localAddress: "10.0.0.2",
            localPort: 40000 + generation,
            remoteAddress: "10.0.0.3",
            remotePort: options.port,
            // a destroy closes the socket at once, whatever the server does
            destroy: () => {
              if (status === "ready" || status === "connect") closed();
            },
          }
        : undefined;
    },
    connect() {
      if (status !== "wait" && status !== "reconnecting" && status !== "end")
        return Promise.reject(new Error("Redis is already connecting/connected"));
      attempts += 1;
      setStatus("connecting");
      return new Promise<void>((resolve, reject) => {
        if (fake.mode === "up") {
          generation += 1;
          retries = 0;
          setStatus("connect");
          setStatus("ready");
          resolve();
          return;
        }
        if (fake.mode === "refuse") {
          emit("error", new Error("connect ECONNREFUSED"));
          closed();
          reject(new Error("Connection is closed."));
          return;
        }
        if (fake.mode === "frozen") {
          // the kernel accepts the connection, and the ready check gets no answer until its command timeout
          setStatus("connect");
          clock.after(options.commandTimeout, () => {
            if (status !== "connect") return;
            emit("error", new Error("Command timed out"));
            closed();
            reject(new Error("Connection is closed."));
          });
          return;
        }
        // a silent server: the connect timeout ends the attempt
        clock.after(options.connectTimeout, () => {
          emit("error", new Error("connect ETIMEDOUT"));
          closed();
          reject(new Error("Connection is closed."));
        });
      });
    },
    call(command, ...args) {
      if (status !== "ready") return Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
      calls.push([command, args]);
      if (fake.mode === "refuse") {
        // the next segment gets a reset: the connection breaks, and the command stays without an answer
        unanswered += 1;
        const result = new Promise((_resolve, reject) => {
          clock.after(options.commandTimeout, () => reject(new Error("Command timed out")));
        });
        clock.after(0, () => fake.breakConnection());
        return result;
      }
      if (fake.mode === "up") {
        const value = fake.reply(command, args);
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      }
      unanswered += 1;
      return new Promise((resolve, reject) => {
        const entry = {
          generation,
          settle: (value: unknown, error?: Error) => (error === undefined ? resolve(value) : reject(error)),
        };
        waiting.add(entry);
        clock.after(options.commandTimeout, () => {
          waiting.delete(entry);
          reject(new Error("Command timed out"));
        });
        // ioredis destroys a socket that gives no data while a command waits
        if (options.socketTimeout !== undefined && socketTimer === null) {
          const at = generation;
          socketTimer = clock.after(options.socketTimeout, () => {
            socketTimer = null;
            if (generation === at && status === "ready") {
              emit("error", new Error(`Socket timeout. Expecting data, but didn't receive any in ${options.socketTimeout}ms.`));
              closed();
            }
          });
        }
      });
    },
    quit() {
      if (status !== "ready") return Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
      if (fake.mode !== "up") return new Promise(() => {});
      manual = true;
      closed();
      return Promise.resolve("OK");
    },
    disconnect(again = false) {
      if (status === "end") return;
      manual = !again;
      if (!again) {
        reconnect?.();
        reconnect = null;
      }
      if (status === "reconnecting" && !again) {
        setStatus("end");
        manual = false;
        return;
      }
      // ioredis only half-closes the socket (stream.end). A silent or frozen server never closes its half, thus the socket stays
      if ((status === "ready" || status === "connect") && (fake.mode === "silent" || fake.mode === "frozen")) return;
      closed();
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return fake;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
      return fake;
    },
    breakConnection() {
      if (status !== "ready" && status !== "connect") return;
      emit("error", new Error("read ECONNRESET"));
      closed();
    },
    answerWaiting() {
      for (const entry of [...waiting]) {
        waiting.delete(entry);
        if (entry.generation === generation) entry.settle(fake.reply("PING", []));
      }
      socketTimer?.();
      socketTimer = null;
    },
  };
  return fake;
};
