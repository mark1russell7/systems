import type { Machine } from "@mark1russell7/algebra";
import { clientKnob as knob, closeTimer, transition as t } from "../client/machine.ts";

/** The states where the client can close, and the states where a call can start its second try. */
const SERVING = ["connecting", "ready", "idle", "failing"] as const;
const LIVE = [...SERVING, "closing"] as const;

/**
 * The gRPC client of the service as a `mark1russell7.machine/1` document. It is one channel of
 * grpc-js 1.14 for the life of the client. Each READY of the channel is one generation. The states:
 * - `ready`: the channel is READY, and the client sends each call. The keepalive sends a PING each keepalive_time.
 * - `idle`: the transport ended, or the channel had no call in client_idle_timeout. The client connects again at once.
 * - `failing`: the channel is in TRANSIENT_FAILURE. The grpc-js driver connects again after its backoff.
 * - `closing`: the calls in flight, in `close_bound`. At the bound, each call gets RST_STREAM CANCEL.
 *
 * A test records the transitions of the client and replays them against this document.
 */
export const GRPC_CLIENT_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "service.machine.grpc-client",
  title: "The gRPC client of the service, over grpc-js 1.14",
  layer: "driver",
  version: "0.1.0",
  sources: [{ ref: "packages/service/src/grpc (the client implements this document)", rung: "implemented" }],
  states: {
    none: { initial: true, note: "the client exists, and its channel does not" },
    connecting: { note: "the channel is CONNECTING: the TCP connect and the HTTP/2 preface. The grpc-js driver has no connect timeout" },
    ready: { note: "the channel is READY. The deadline ends a call that waits, and the keepalive finds a silent transport" },
    idle: { note: "the channel is IDLE. The client asks it to connect at once" },
    failing: { note: "the channel is in TRANSIENT_FAILURE. The grpc-js driver connects again after its backoff, and each call fails as not sent" },
    closing: { note: "the calls in flight, in close_bound. At the bound, each call gets RST_STREAM CANCEL, then the channel closes" },
    end: { final: true, note: "the service closed the client" },
  },
  events: {
    "status.connecting": { kind: "local" },
    join: { kind: "rx", note: "the channel became READY: a new generation (D1)" },
    "connect.failed": { kind: "rx", note: "the channel went to TRANSIENT_FAILURE: a connect failed" },
    "channel.connecting": { kind: "rx", note: "the channel started a new connect" },
    "channel.idle": { kind: "rx", note: "the channel went to IDLE before it was READY" },
    "connection.end": {
      kind: "rx",
      note: "the transport ended: a GOAWAY, a reset, a FIN, the keepalive, or client_idle_timeout. The grpc-js driver ends each call in flight with UNAVAILABLE",
    },
    "command.reissue": { kind: "local" },
    "close.request": { kind: "local" },
    "close.bound": { kind: "timer", note: "the calls in flight did not end in close_bound" },
    "close.destroy": { kind: "local", note: "the client cancels each call in flight, then closes the channel" },
    "status.end": { kind: "local" },
  },
  knobs: {
    keepalive_time: knob("grpc.keepalive_time_ms"),
    keepalive_timeout: knob("grpc.keepalive_timeout_ms"),
    client_idle_timeout: knob("grpc.client_idle_timeout_ms"),
    retry_base: knob("grpc.initial_reconnect_backoff_ms"),
    retry_cap: knob("grpc.max_reconnect_backoff_ms"),
    close_bound: knob("close.bound"),
  },
  timers: {
    keepalive: {
      duration: { expr: "keepalive_time + keepalive_timeout", unit: "s" },
      arms: ["join"],
      cancels: ["connection.end", "close.request"],
      fires: "connection.end",
      note: "a timer of grpc-js: one PING each keepalive_time, and the end of the transport at keepalive_timeout with no ACK",
    },
    idle: {
      duration: { knob: "client_idle_timeout", unit: "s" },
      arms: ["join"],
      cancels: ["connection.end", "close.request"],
      fires: "connection.end",
      note: "a timer of grpc-js: client_idle_timeout with no call puts the channel in IDLE",
    },
    retry: {
      duration: { expr: "min(retry_cap, retry_base * pow(1.6, fired)) * 1.2", unit: "s" },
      arms: ["connect.failed"],
      cancels: ["close.request"],
      fires: "join",
      backoff: { resets: ["join"] },
      note: "a timer of grpc-js, the most delay: the backoff grows by 1.6 from retry_base to retry_cap, with a jitter of 20 %. The first delay has no jitter",
    },
    close: closeTimer(),
  },
  transitions: [
    t("connect", "none", "status.connecting", "connecting"),
    t("join", ["connecting", "idle", "failing"], "join", "ready"),
    t("connect-failed", ["connecting", "idle", "ready"], "connect.failed", "failing"),
    t("retry", "failing", "join", "ready", { timer: "retry" }),
    t("channel-connecting", ["idle", "failing"], "channel.connecting", "connecting"),
    t("channel-idle", ["connecting", "failing"], "channel.idle", "idle"),
    t("connection-end", "ready", "connection.end", "idle"),
    t("keepalive", "ready", "connection.end", "idle", { timer: "keepalive" }),
    t("idle-timeout", "ready", "connection.end", "idle", { timer: "idle" }),
    ...LIVE.map((state) => t(`reissue-${state}`, state, "command.reissue", state)),
    t("close", [...SERVING], "close.request", "closing"),
    t("close-bound", "closing", "close.bound", "closing", { timer: "close" }),
    t("close-destroy", "closing", "close.destroy", "closing"),
    t("end", "closing", "status.end", "end"),
  ],
};
