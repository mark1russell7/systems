// A fake gRPC server for the tests of the client, on a fake clock. It opens no socket. Each channel
// follows the states of a channel of grpc-js 1.14: IDLE, CONNECTING, READY, TRANSIENT_FAILURE and SHUTDOWN.

import type { Cancel, Clock } from "../clock.ts";
import type { GrpcCallHandle, GrpcChannel, GrpcConnectOptions, GrpcState, GrpcStatus } from "./connection.ts";

/**
 * The mode of the server, read at each step:
 * - `up`: the server takes each connect, answers each call through `answer`, and answers each PING.
 * - `refuse`: the server refuses each connect. The channel goes to TRANSIENT_FAILURE, and stays there until a connect passes.
 * - `silent`: the network drops each segment. A connect stays CONNECTING, and no reply and no PING ACK come.
 * - `stall`: the server holds each reply, and its library still answers each PING.
 */
export type FakeGrpcMode = "up" | "refuse" | "silent" | "stall";

/** An answer is the reply to one call: the bytes of a response message, a status that is not OK, or null for no reply. */
export type FakeGrpcAnswer = Buffer | GrpcStatus | null;

/** A fake call is one unary call on a fake channel, and its end. */
export interface FakeGrpcCall {
  readonly method: string;
  readonly request: Buffer;
  readonly metadata: Readonly<Record<string, string>>;
  readonly timeout: number;
  readonly at: number;
  /** This status is the end of the call, or null while the call is in flight. */
  readonly status: GrpcStatus | null;
  /** True tells that the client cancelled the call: grpc-js then writes RST_STREAM CANCEL. */
  readonly cancelled: boolean;
}

/** A fake channel is one channel of the fake server, and the record of what the client did on it. */
export interface FakeGrpcChannel extends GrpcChannel {
  readonly options: GrpcConnectOptions;
  readonly calls: FakeGrpcCall[];
  /** These times are the start of each try to connect, on the clock. */
  readonly connects: number[];
  /** These times are the PING frames of keepalive, on the clock. */
  readonly pings: number[];
  /** This method resets the transport: each call in flight fails with UNAVAILABLE "Connection dropped", and the channel goes IDLE. */
  reset(): void;
  /** This method sends GOAWAY: the channel goes IDLE, and each call in flight continues on the old transport. */
  goaway(): void;
}

/** A fake server makes the channels of a client, and holds its mode. */
export interface FakeGrpcServer {
  mode: FakeGrpcMode;
  /** This function gives the reply to a call. The default answers the health Check with SERVING, and sends each other request back. */
  answer: (method: string, request: Buffer) => FakeGrpcAnswer;
  /** This time is the delay of each reply, in milliseconds on the clock. */
  replyDelay: number;
  readonly channels: FakeGrpcChannel[];
  /** This method makes one channel. It is the `create` option of the client. */
  create(options: GrpcConnectOptions): FakeGrpcChannel;
  /** This method gives the latest channel. */
  latest(): FakeGrpcChannel;
}

/** These are the bytes of a HealthCheckResponse with the status SERVING. */
export const SERVING_REPLY: Buffer = Buffer.from([0x08, 0x01]);

/** This function gives the seconds of a time, as grpc-js writes them in the details of DEADLINE_EXCEEDED. */
const seconds = (ms: number): string => `${(ms / 1000).toFixed(3)}s`;

/** This function makes a fake gRPC server on a clock. */
export const fakeGrpcServer = (clock: Clock): FakeGrpcServer => {
  const server: FakeGrpcServer = {
    mode: "up",
    answer: (method, request) => (method === "/grpc.health.v1.Health/Check" ? SERVING_REPLY : request),
    replyDelay: 0,
    channels: [],
    latest: () => {
      const last = server.channels.at(-1);
      if (last === undefined) throw new Error("the fake server has no channel");
      return last;
    },
    create(options) {
      const { options: given } = options;
      const keepaliveTime = given["grpc.keepalive_time_ms"];
      const keepaliveTimeout = given["grpc.keepalive_timeout_ms"];
      const withoutCalls = given["grpc.keepalive_permit_without_calls"] === 1;
      const idleTimeout = Math.max(given["grpc.client_idle_timeout_ms"], 1000);
      let backoff = given["grpc.initial_reconnect_backoff_ms"];
      let state: GrpcState = "IDLE";
      let watchers: Array<{ readonly current: GrpcState; readonly changed: () => void }> = [];
      const calls: Array<FakeGrpcCall & { status: GrpcStatus | null; cancelled: boolean }> = [];
      const ends = new Map<FakeGrpcCall, (status: GrpcStatus, response: Buffer | undefined) => void>();
      // The calls that wait for a pick: they start at READY, and fail at TRANSIENT_FAILURE
      let queued: Array<() => void> = [];
      const connects: number[] = [];
      const pings: number[] = [];
      let timers: Cancel[] = [];
      let idleTimer: Cancel | null = null;
      let retryTimer: Cancel | null = null;

      // The calls that started on the current transport
      const started = new Set<FakeGrpcCall>();
      const set = (next: GrpcState): void => {
        if (state === next) return;
        state = next;
        const fire = watchers.filter((watcher) => watcher.current !== next);
        watchers = watchers.filter((watcher) => watcher.current === next);
        for (const watcher of fire) watcher.changed();
      };
      const end = (call: FakeGrpcCall, status: GrpcStatus, response?: Buffer): void => {
        const done = ends.get(call);
        if (done === undefined) return;
        ends.delete(call);
        started.delete(call);
        (call as { status: GrpcStatus | null }).status = status;
        done(status, response);
        armIdle();
      };
      const stopTransport = (): void => {
        for (const cancel of timers) cancel();
        timers = [];
        idleTimer?.();
        idleTimer = null;
      };
      // The grpc-js driver puts the channel in IDLE when no call is in flight for client_idle_timeout
      const armIdle = (): void => {
        idleTimer?.();
        idleTimer = null;
        if (state !== "READY" || started.size > 0) return;
        idleTimer = clock.after(idleTimeout, () => {
          idleTimer = null;
          if (state === "READY" && started.size === 0) {
            stopTransport();
            set("IDLE");
          }
        });
      };
      const drop = (details: string): void => {
        stopTransport();
        const dropped = [...started];
        started.clear();
        set("IDLE");
        for (const call of dropped) end(call, { code: 14, details });
      };
      const keepalive = (): void => {
        if (keepaliveTime === undefined) return;
        const tick = clock.after(keepaliveTime, () => {
          if (state !== "READY") return;
          if (started.size === 0 && !withoutCalls) {
            keepalive();
            return;
          }
          pings.push(clock.now());
          if (server.mode === "up" || server.mode === "stall") keepalive();
          else timers.push(clock.after(keepaliveTimeout, () => state === "READY" && drop("Connection dropped")));
        });
        timers.push(tick);
      };
      const ready = (): void => {
        backoff = given["grpc.initial_reconnect_backoff_ms"];
        set("READY");
        keepalive();
        for (const start of queued.splice(0)) start();
        armIdle();
      };
      const fail = (): void => {
        const failing = queued.splice(0);
        set("TRANSIENT_FAILURE");
        for (const start of failing) start();
        const delay = backoff;
        backoff = Math.min(backoff * 1.6, given["grpc.max_reconnect_backoff_ms"]);
        retryTimer = clock.after(delay, () => {
          retryTimer = null;
          attempt();
        });
      };
      const attempt = (): void => {
        if (state === "SHUTDOWN") return;
        connects.push(clock.now());
        // A channel in TRANSIENT_FAILURE stays there until a connect passes (sticky)
        if (state !== "TRANSIENT_FAILURE") set("CONNECTING");
        if (server.mode === "up" || server.mode === "stall") queueMicrotask(() => state !== "SHUTDOWN" && ready());
        else if (server.mode === "refuse") queueMicrotask(() => state !== "SHUTDOWN" && fail());
      };
      const exitIdle = (): void => {
        if (state === "IDLE") queueMicrotask(() => state === "IDLE" && attempt());
      };

      const channel: FakeGrpcChannel = {
        options,
        calls,
        connects,
        pings,
        state(connect) {
          const now = state;
          if (connect) exitIdle();
          return now;
        },
        watch(current, changed) {
          if (state === "SHUTDOWN") throw new Error("Channel has been shut down");
          if (current !== state) queueMicrotask(changed);
          else watchers.push({ current, changed });
        },
        unary(method, request, metadata, timeout, done): GrpcCallHandle {
          if (state === "SHUTDOWN") throw new Error("Channel has been shut down");
          const call = { method, request, metadata, timeout, at: clock.now(), status: null, cancelled: false } as FakeGrpcCall & {
            status: GrpcStatus | null;
            cancelled: boolean;
          };
          calls.push(call);
          ends.set(call, done);
          let picked = false;
          const deadline = clock.after(timeout, () =>
            end(call, {
              code: 4,
              details: picked ? `Deadline exceeded after ${seconds(timeout)},LB pick: 0.000s,remote_addr=127.0.0.1:50051` : `Deadline exceeded after ${seconds(timeout)},Waiting for LB pick`,
            }),
          );
          const start = (): void => {
            if (!ends.has(call)) return;
            if (state === "TRANSIENT_FAILURE") {
              deadline();
              queueMicrotask(() => end(call, { code: 14, details: "No connection established. Last error: connect ECONNREFUSED" }));
              return;
            }
            picked = true;
            started.add(call);
            idleTimer?.();
            idleTimer = null;
            if (server.mode !== "up") return;
            const reply = server.answer(method, request);
            if (reply === null) return;
            const send = (): void => {
              if (!ends.has(call) || server.mode !== "up") return;
              deadline();
              if (Buffer.isBuffer(reply)) end(call, { code: 0, details: "" }, reply);
              else end(call, reply);
            };
            if (server.replyDelay > 0) clock.after(server.replyDelay, send);
            else queueMicrotask(send);
          };
          if (state === "READY" || state === "TRANSIENT_FAILURE") start();
          else {
            queued.push(start);
            exitIdle();
          }
          return {
            cancel() {
              if (!ends.has(call)) return;
              call.cancelled = true;
              deadline();
              end(call, { code: 1, details: "Cancelled on client" });
            },
          };
        },
        close() {
          stopTransport();
          retryTimer?.();
          retryTimer = null;
          queued = [];
          set("SHUTDOWN");
        },
        reset: () => {
          if (state === "READY") drop("Connection dropped");
        },
        goaway() {
          if (state !== "READY") return;
          stopTransport();
          set("IDLE");
        },
      };
      server.channels.push(channel);
      return channel;
    },
  };
  return server;
};
