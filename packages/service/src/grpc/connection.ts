import type { Factory } from "../client/core.ts";

/** A state is the connectivity state of a channel of grpc-js, by the names of its enum `connectivityState`. */
export type GrpcState = "IDLE" | "CONNECTING" | "READY" | "TRANSIENT_FAILURE" | "SHUTDOWN";

/** These states are in the sequence of the enum of grpc-js: the index of a state is its value. */
export const GRPC_STATES: readonly GrpcState[] = ["IDLE", "CONNECTING", "READY", "TRANSIENT_FAILURE", "SHUTDOWN"];

/** A status is the end of one call: its code (0 is OK) and its details. */
export interface GrpcStatus {
  readonly code: number;
  readonly details: string;
}

/** A call handle stops one call in flight. The grpc-js driver then writes RST_STREAM with the code CANCEL. */
export interface GrpcCallHandle {
  cancel(): void;
}

/**
 * A channel is the part of a `Client` of grpc-js 1.14 that the wrapper uses. A fake for tests has
 * each part too. Thus the package depends on no type of grpc-js.
 */
export interface GrpcChannel {
  /** This method gives the state of the channel. True also starts a connect when the channel is IDLE. */
  state(connect: boolean): GrpcState;
  /** This method starts `changed` one time, when the state of the channel is no longer `current`. */
  watch(current: GrpcState, changed: () => void): void;
  /**
   * This method sends one unary call: the method path and the bytes of its request message. `done`
   * gets the status of the call, and the bytes of the response message when the status is OK. The
   * call ends at `timeout` milliseconds with DEADLINE_EXCEEDED, and grpc-js sends the header `grpc-timeout`.
   */
  unary(
    method: string,
    request: Buffer,
    metadata: Readonly<Record<string, string>>,
    timeout: number,
    done: (status: GrpcStatus, response: Buffer | undefined) => void,
  ): GrpcCallHandle;
  /** This method closes the channel. Its state becomes SHUTDOWN, and it does not connect again. */
  close(): void;
}

/**
 * These are the options of the channel that the wrapper gives `new Client(target, credentials, options)`.
 * Each time comes from the declaration, in milliseconds.
 */
export interface GrpcChannelOptions {
  /** The wrapper turns off the retries of grpc-js, the transparent retry too. Only the core decides a second send. */
  readonly "grpc.enable_retries": 0;
  /** The wrapper reads no service config from the resolver. Thus no record of DNS changes the policy of a call. */
  readonly "grpc.service_config_disable_resolution": 1;
  /** This time is the interval of the HTTP/2 PING of keepalive. Without it, grpc-js sends no PING. */
  readonly "grpc.keepalive_time_ms"?: number | undefined;
  /** This time bounds the ACK of each PING. Without an ACK in this time, grpc-js ends the transport. */
  readonly "grpc.keepalive_timeout_ms": number;
  /** 1 sends the PING with no call in flight too. The server must permit that, or it answers with GOAWAY too_many_pings (O26). */
  readonly "grpc.keepalive_permit_without_calls": 0 | 1;
  /** This time with no call puts the channel in IDLE, and closes its connection. */
  readonly "grpc.client_idle_timeout_ms": number;
  /** This time is the first delay of grpc-js before a new try to connect. */
  readonly "grpc.initial_reconnect_backoff_ms": number;
  /** This time is the most that one delay of grpc-js can be, before its jitter of 20 %. */
  readonly "grpc.max_reconnect_backoff_ms": number;
}

/** These are the arguments of `new Client(target, credentials, options)`. The credentials are insecure: the client speaks h2c. */
export interface GrpcConnectOptions {
  readonly target: string;
  readonly options: GrpcChannelOptions;
}

/** A channel factory makes one channel from its options. The channel connects later, when the wrapper asks it. */
export type GrpcFactory = Factory<GrpcConnectOptions, GrpcChannel>;

/** This type is the part of a `Client` of grpc-js 1.14 that the adapter uses. */
interface GrpcDriverClient {
  getChannel(): {
    getConnectivityState(connect: boolean): number;
    watchConnectivityState(current: number, deadline: number, callback: (error?: Error) => void): void;
  };
  makeUnaryRequest(
    method: string,
    serialize: (value: Buffer) => Buffer,
    deserialize: (bytes: Buffer) => Buffer,
    argument: Buffer,
    metadata: unknown,
    options: { readonly deadline: number },
    callback: (error: { readonly code?: number; readonly details?: string; readonly message?: string } | null, value?: Buffer) => void,
  ): GrpcCallHandle;
  close(): void;
}

/** This type is the part of the module of grpc-js that the adapter uses. */
interface GrpcDriver {
  readonly Client: new (target: string, credentials: unknown, options: GrpcChannelOptions) => GrpcDriverClient;
  readonly credentials: { createInsecure(): unknown };
  readonly Metadata: new () => { add(key: string, value: string): void };
}

/** These functions give the bytes of a message as they are. The caller encodes and decodes its messages. */
const identity = (bytes: Buffer): Buffer => bytes;

/** This function gives the state of a value of the enum of grpc-js. */
const stateOf = (value: number): GrpcState => GRPC_STATES[value] ?? "SHUTDOWN";

/**
 * This function adapts a `Client` of grpc-js to a channel. The deadline of grpc-js is a time of the
 * wall clock, thus the adapter adds the timeout to `Date.now()`.
 */
export const adaptGrpc = (grpc: GrpcDriver, client: GrpcDriverClient): GrpcChannel => {
  const channel = client.getChannel();
  return {
    state: (connect) => stateOf(channel.getConnectivityState(connect)),
    watch(current, changed) {
      try {
        channel.watchConnectivityState(GRPC_STATES.indexOf(current), Number.POSITIVE_INFINITY, (error) => {
          if (error === undefined) changed();
        });
      } catch {
        // The grpc-js driver throws when the channel is shut down: no state comes after SHUTDOWN
      }
    },
    unary(method, request, metadata, timeout, done) {
      const sent = new grpc.Metadata();
      for (const [key, value] of Object.entries(metadata)) sent.add(key, value);
      const deadline = Number.isFinite(timeout) ? Date.now() + timeout : Number.POSITIVE_INFINITY;
      return client.makeUnaryRequest(method, identity, identity, request, sent, { deadline }, (error, value) => {
        if (error === null) done({ code: 0, details: "" }, value ?? Buffer.alloc(0));
        else done({ code: error.code ?? 2, details: error.details ?? error.message ?? "" }, undefined);
      });
    },
    close: () => client.close(),
  };
};

/**
 * This factory makes a `Client` of grpc-js. It loads grpc-js only when a client connects, thus a
 * service that does not use gRPC does not need it. The specifier is a value, thus the package needs no types of grpc-js.
 */
export const nodeGrpc: GrpcFactory = async ({ target, options }) => {
  const specifier = "@grpc/grpc-js";
  const loaded = (await import(specifier)) as Partial<GrpcDriver> & { readonly default?: GrpcDriver };
  const grpc = loaded.Client === undefined ? loaded.default : (loaded as GrpcDriver);
  if (grpc?.Client === undefined) throw new Error("@grpc/grpc-js gives no Client class");
  return adaptGrpc(grpc, new grpc.Client(target, grpc.credentials.createInsecure(), options));
};
