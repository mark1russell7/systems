// A fake broker and a fake amqplib 2 for the tests of the RabbitMQ client, on a fake clock. It keeps
// the parts of amqplib that the client depends on. A confirm channel calls the callback of each publish
// one time. The end of a channel fails its confirms and its RPCs, and the end of a connection closes
// its channels first. A close of the broker gives a reply code. The heartbeat ends a silent connection
// at 3 heartbeats. A connection.close waits for its close-ok, and a silent broker never sends it.
// A test changes what the broker does: it answers, it refuses, or it is silent.

import type { Cancel, Clock } from "../clock.ts";
import type {
  RabbitChannel,
  RabbitChannelEvent,
  RabbitConnectOptions,
  RabbitConnection,
  RabbitConnectionEvent,
  RabbitFactory,
  RabbitMessage,
  RabbitPublishOptions,
} from "./connection.ts";

/** What the broker does: it answers, it refuses each new connection, or it is silent (a black hole or a freeze). */
export type BrokerMode = "up" | "refuse" | "silent";

/** What the broker does with each publish: it confirms it with an ack or a nack, or it holds the confirm. */
export type ConfirmMode = "ack" | "nack" | "hold";

/** The error that amqplib throws for a call on a closed or closing channel. */
export class IllegalOperationError extends Error {
  override readonly name = "IllegalOperationError";
}

type Listener = (detail?: unknown) => void;

/** This function makes an emitter that throws on an error with no listener, as Node does. */
const emitter = () => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
    },
    emit(event: string, detail?: unknown) {
      const set = listeners.get(event);
      if (event === "error" && (set === undefined || set.size === 0)) throw detail;
      for (const listener of [...(set ?? [])]) listener(detail);
    },
  };
};

/** A publish that reached the broker. */
export interface Published {
  readonly connection: number;
  readonly exchange: string;
  readonly routingKey: string;
  readonly content: string;
  readonly options: RabbitPublishOptions;
}

/** A settle of a delivery that reached the broker. */
export interface Settled {
  readonly kind: "ack" | "requeue" | "reject";
  readonly content: string;
}

/** A fake channel, with what a test must see and change. */
export interface FakeChannel extends RabbitChannel {
  readonly closed: boolean;
  /** This method closes the channel from the broker, with a reply code, as a refused call does. */
  closeByBroker(code: number, text: string): void;
}

/** A fake connection, with what a test must see and change. */
export interface FakeConnection extends RabbitConnection {
  readonly id: number;
  readonly options: RabbitConnectOptions;
  readonly closed: boolean;
  readonly channels: readonly FakeChannel[];
  /** This method breaks the connection, as a reset or a FIN does. */
  reset(detail?: string): void;
  block(reason: string): void;
  unblock(): void;
}

/** A fake broker, its factory of connections, and what a test must see and change. */
export interface FakeBroker {
  mode: BrokerMode;
  confirm: ConfirmMode;
  /** The messages of each queue. A queue that is absent gives a close of the channel with 404. */
  readonly queues: Map<string, Array<{ readonly content: string; readonly redelivered: boolean; readonly headers?: Record<string, unknown> }>>;
  readonly connections: readonly FakeConnection[];
  readonly published: readonly Published[];
  readonly settled: readonly Settled[];
  /** The count of the RPCs that wait for a reply of a silent broker. */
  readonly waiting: number;
  /** This factory makes a connection, as `connect` of amqplib does. */
  readonly create: RabbitFactory;
  /** The latest connection that opened. */
  latest(): FakeConnection;
  /** This method confirms each publish that the broker holds, with an ack. */
  release(): void;
  /** This method answers each RPC that waits, late, as a broker does at the end of a stall. */
  answerWaiting(): void;
}

const heartbeatOf = (url: string): number => Number(new URL(url).searchParams.get("heartbeat") ?? "0");

/** This function makes a fake broker on a clock. */
export const fakeBroker = (clock: Clock): FakeBroker => {
  const connections: FakeConnection[] = [];
  const published: Published[] = [];
  const settled: Settled[] = [];
  const held: Array<{ readonly channel: FakeChannel; readonly callback: (error: Error | null) => void }> = [];
  const pending = new Set<{ readonly channel: FakeChannel; readonly answer: () => void; readonly fail: (error: Error) => void }>();
  const queues: FakeBroker["queues"] = new Map();
  let mode: BrokerMode = "up";
  // the heartbeat end of each open connection while the broker is silent
  const silences = new Map<FakeConnection, Cancel>();

  const silence = (c: FakeConnection): void => {
    const beat = heartbeatOf(c.options.url);
    if (beat === 0 || c.closed || silences.has(c)) return;
    silences.set(
      c,
      clock.after(3 * beat * 1000, () => {
        silences.delete(c);
        c.reset("Heartbeat timeout");
      }),
    );
  };

  const makeChannel = (owner: () => FakeConnection): FakeChannel => {
    const events = emitter();
    const unconfirmed: Array<(error: Error | null) => void> = [];
    let closed = false;
    let tag = 0;
    const unacked = new Map<number, { readonly content: string }>();
    const usable = (): void => {
      if (closed) throw new IllegalOperationError("Channel closed");
    };
    const rpc = <T>(answer: () => T): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        usable();
        if (broker.mode !== "silent") {
          try {
            resolve(answer());
          } catch (error) {
            reject(error as Error);
          }
          return;
        }
        const entry = {
          channel,
          answer: () => {
            pending.delete(entry);
            try {
              resolve(answer());
            } catch (error) {
              reject(error as Error);
            }
          },
          fail: (error: Error) => {
            pending.delete(entry);
            reject(error);
          },
        };
        pending.add(entry);
      });
    /** The channel moves to closed: its RPCs fail, its confirms fail, and it emits its close. */
    const toClosed = (): void => {
      if (closed) return;
      closed = true;
      for (const entry of [...pending]) if (entry.channel === channel) entry.fail(new Error("Channel ended, no reply will be forthcoming"));
      for (const callback of unconfirmed.splice(0)) callback(new Error("channel closed"));
      for (let at = held.length - 1; at >= 0; at -= 1) if (held[at]!.channel === channel) held.splice(at, 1);
      events.emit("close");
    };
    const channel: FakeChannel & { toClosed(): void } = {
      get closed() {
        return closed;
      },
      publish(exchange, routingKey, content, options, callback) {
        usable();
        published.push({ connection: owner().id, exchange, routingKey, content: content.toString("utf8"), options });
        const done = (error: Error | null): void => {
          const at = unconfirmed.indexOf(once);
          if (at >= 0) unconfirmed.splice(at, 1);
          callback(error);
        };
        const once = (error: Error | null): void => done(error);
        unconfirmed.push(once);
        if (broker.mode === "silent" || broker.confirm === "hold") held.push({ channel, callback: once });
        else void Promise.resolve().then(() => once(broker.confirm === "ack" ? null : new Error("message nacked")));
        return true;
      },
      get(queue) {
        return rpc(() => {
          const messages = queues.get(queue);
          if (messages === undefined) {
            const error = Object.assign(new Error(`Operation failed: BasicGet; 404 (NOT-FOUND) with message "NOT_FOUND - no queue '${queue}'"`), {
              code: 404,
            });
            // the broker closes the channel after the reply of the RPC
            void Promise.resolve().then(() => channel.closeByBroker(404, `NOT_FOUND - no queue '${queue}'`));
            throw error;
          }
          const next = messages.shift();
          if (next === undefined) return false;
          tag += 1;
          unacked.set(tag, next);
          const message: RabbitMessage = {
            content: Buffer.from(next.content, "utf8"),
            fields: { deliveryTag: tag, redelivered: next.redelivered, exchange: "", routingKey: queue, messageCount: messages.length },
            properties: next.headers === undefined ? {} : { headers: next.headers },
          };
          return message;
        });
      },
      checkExchange() {
        return rpc(() => ({}));
      },
      ack(message) {
        usable();
        const entry = unacked.get(message.fields.deliveryTag);
        unacked.delete(message.fields.deliveryTag);
        settled.push({ kind: "ack", content: entry?.content ?? "" });
      },
      nack(message, _allUpTo, requeue = true) {
        usable();
        const entry = unacked.get(message.fields.deliveryTag);
        unacked.delete(message.fields.deliveryTag);
        settled.push({ kind: requeue ? "requeue" : "reject", content: entry?.content ?? "" });
        if (requeue && entry !== undefined) queues.get(message.fields.routingKey)?.unshift({ content: entry.content, redelivered: true });
      },
      close() {
        toClosed();
        return Promise.resolve();
      },
      on(event: RabbitChannelEvent, listener) {
        events.on(event, listener as Listener);
        return channel;
      },
      off(event: RabbitChannelEvent, listener) {
        events.off(event, listener as Listener);
        return channel;
      },
      closeByBroker(code, text) {
        if (closed) return;
        events.emit("error", Object.assign(new Error(`Channel closed by server: ${code} (${text})`), { code }));
        toClosed();
      },
      toClosed,
    };
    return channel;
  };

  const makeConnection = (options: RabbitConnectOptions): FakeConnection => {
    const events = emitter();
    const channels: Array<FakeChannel & { toClosed(): void }> = [];
    const id = connections.length + 1;
    let closed = false;
    const toClosed = (error?: Error): void => {
      if (closed) return;
      closed = true;
      silences.get(connection)?.();
      silences.delete(connection);
      // amqplib closes each channel first, then emits the close of the connection, in the same turn
      for (const channel of channels) channel.toClosed();
      events.emit("close", error);
    };
    const connection: FakeConnection = {
      id,
      options,
      get closed() {
        return closed;
      },
      channels,
      connection: {
        stream: {
          localAddress: "10.0.0.2",
          localPort: 50000 + id,
          remoteAddress: "10.0.0.3",
          remotePort: Number(new URL(options.url).port),
          // a destroy closes the socket at once, whatever the broker does
          destroy: () => toClosed(new Error("Socket closed abruptly during opening handshake")),
        },
      },
      createConfirmChannel() {
        if (closed) return Promise.reject(new IllegalOperationError("Connection closed"));
        const channel = makeChannel(() => connection) as FakeChannel & { toClosed(): void };
        channels.push(channel);
        if (broker.mode === "silent") return new Promise(() => {});
        return Promise.resolve(channel);
      },
      close() {
        if (closed) return Promise.reject(new IllegalOperationError("Connection closed"));
        // a silent broker never sends close-ok
        if (broker.mode === "silent") return new Promise(() => {});
        toClosed();
        return Promise.resolve();
      },
      on(event: RabbitConnectionEvent, listener) {
        events.on(event, listener);
        return connection;
      },
      off(event: RabbitConnectionEvent, listener) {
        events.off(event, listener);
        return connection;
      },
      reset(detail = "read ECONNRESET") {
        if (closed) return;
        const error = new Error(detail);
        events.emit("error", error);
        toClosed(error);
      },
      block(reason) {
        events.emit("blocked", reason);
      },
      unblock() {
        events.emit("unblocked");
      },
    };
    return connection;
  };

  const broker: FakeBroker = {
    get mode() {
      return mode;
    },
    set mode(to: BrokerMode) {
      mode = to;
      if (to === "silent") for (const c of connections) silence(c);
      else {
        for (const stop of silences.values()) stop();
        silences.clear();
      }
    },
    confirm: "ack",
    queues,
    connections,
    published,
    settled,
    get waiting() {
      return pending.size;
    },
    create: (options) => {
      if (mode === "refuse") return Promise.reject(new Error(`connect ECONNREFUSED ${new URL(options.url).host}`));
      if (mode === "silent")
        // amqplib bounds the connect and the handshake with its socket timeout
        return new Promise((_resolve, reject) => {
          clock.after(options.socketOptions.timeout, () => reject(new Error("connect ETIMEDOUT")));
        });
      const connection = makeConnection(options);
      connections.push(connection);
      return Promise.resolve(connection);
    },
    latest: () => connections.at(-1)!,
    release() {
      for (const entry of held.splice(0)) entry.callback(null);
    },
    answerWaiting() {
      for (const entry of [...pending]) entry.answer();
    },
  };
  return broker;
};
