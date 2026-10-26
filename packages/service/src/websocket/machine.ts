import type { Machine } from "@mark1russell7/algebra";
import { clientKnob as knob, closeTimer, transition as t } from "../client/machine.ts";

/** The states where the client can close, and the states where a call can start its second try. */
const SERVING = ["connecting", "ready", "failing"] as const;
const LIVE = [...SERVING, "closing"] as const;

/**
 * The WebSocket client of the service as a `mark1russell7.machine/1` document. It is one generation
 * at a time: one `WebSocket` of ws 8. The states:
 * - `ready`: the upgrade ended with 101, and the client sends each call. Its heartbeat sends a ping frame each interval.
 * - `failing`: no generation is open. The client connects again after its backoff.
 * - `closing`: the calls in flight, then the close handshake, in `close_bound`. At the bound, `terminate()`.
 *
 * The end of the connection and the last miss of the heartbeat end the generation. A test records
 * the transitions of the client and replays them against this document.
 */
export const WS_CLIENT_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "service.machine.websocket-client",
  title: "The WebSocket client of the service, over ws 8",
  layer: "driver",
  version: "0.1.0",
  sources: [{ ref: "packages/service/src/websocket (the client implements this document)", rung: "implemented" }],
  states: {
    none: { initial: true, note: "the client exists, and its first connection does not" },
    connecting: { note: "the TCP connect and the upgrade, in connect_bound" },
    ready: { note: "the connection is open. The heartbeat finds a silent server, and the timer of a call ends a call that waits" },
    failing: { note: "no generation is open. The client connects again after its backoff" },
    closing: { note: "the calls in flight, then the close handshake, in close_bound. At the bound, terminate() destroys the socket" },
    end: { final: true, note: "the service closed the client" },
  },
  events: {
    "status.connecting": { kind: "local" },
    join: { kind: "rx", note: "the upgrade ended with 101: a new generation (D1)" },
    "connect.failed": { kind: "local", note: "the connect or the upgrade failed, or did not end in connect_bound" },
    "retry.connect": { kind: "timer", note: "the backoff ended: a new try" },
    "connection.error": { kind: "rx", note: "an error event of the connection. Its close follows" },
    "connection.end": { kind: "rx", note: "the connection closed: a reset, a FIN, a close frame of the server, or the kernel" },
    "heartbeat.miss": { kind: "timer", note: "a ping frame got no pong in heartbeat_timeout" },
    "heartbeat.dead": { kind: "local", note: "the last miss in sequence: terminate() destroys the socket at once" },
    "command.reissue": { kind: "local" },
    "close.request": { kind: "local" },
    "close.bound": { kind: "timer", note: "the calls in flight or the close handshake did not end in close_bound" },
    "close.destroy": { kind: "local", note: "terminate() destroys a socket that a silent server does not close" },
    "status.end": { kind: "local" },
  },
  knobs: {
    connect_bound: knob("handshakeTimeout"),
    heartbeat_interval: knob("heartbeat.interval"),
    heartbeat_timeout: knob("heartbeat.timeout"),
    retry_base: knob("retry.base"),
    retry_cap: knob("retry.cap"),
    close_bound: knob("close.bound"),
  },
  timers: {
    connect_timeout: {
      duration: { knob: "connect_bound", unit: "s" },
      arms: ["enter:connecting"],
      cancels: ["join", "connect.failed"],
      fires: "connect.failed",
      note: "the bound of the wrapper on the open. ws bounds the connect and the upgrade with the same time",
    },
    heartbeat: {
      duration: { expr: "heartbeat_interval + heartbeat_timeout", unit: "s" },
      arms: ["join", "heartbeat.miss"],
      cancels: ["connection.end", "heartbeat.dead", "close.request"],
      fires: "heartbeat.miss",
      note: "one ping at a time: a ping frame each interval, and a miss at its timeout with no pong. Each pong starts it again",
    },
    retry: {
      duration: { expr: "min(retry_cap, retry_base * pow(2, fired)) + retry_base", unit: "s" },
      arms: ["connect.failed", "connection.end", "heartbeat.dead"],
      cancels: ["close.request"],
      fires: "retry.connect",
      backoff: { resets: ["join"] },
      note: "the most delay: the backoff doubles from retry_base to retry_cap, with a jitter up to retry_base",
    },
    close: closeTimer(),
  },
  transitions: [
    t("connect", "none", "status.connecting", "connecting"),
    t("join", "connecting", "join", "ready"),
    t("connect-failed", "connecting", "connect.failed", "failing", { timer: "connect_timeout" }),
    t("retry", "failing", "retry.connect", "connecting", { timer: "retry" }),
    t("connection-end", "ready", "connection.end", "failing"),
    t("heartbeat-miss", "ready", "heartbeat.miss", "ready", { timer: "heartbeat" }),
    t("heartbeat-dead", "ready", "heartbeat.dead", "failing"),
    t("connection-error-ready", "ready", "connection.error", "ready"),
    t("connection-error-closing", "closing", "connection.error", "closing"),
    ...LIVE.map((state) => t(`reissue-${state}`, state, "command.reissue", state)),
    t("close", [...SERVING], "close.request", "closing"),
    t("close-bound", "closing", "close.bound", "closing", { timer: "close" }),
    t("close-destroy", "closing", "close.destroy", "closing"),
    t("end", "closing", "status.end", "end"),
  ],
};
