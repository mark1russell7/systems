import type { Machine } from "@mark1russell7/algebra";
import { clientKnob as knob, closeTimer, transition as t } from "../client/machine.ts";

/** The states where a generation is open, and the states where the client can close. */
const OPEN = ["ready", "blocked"] as const;
const SERVING = ["connecting", ...OPEN, "failing"] as const;
const LIVE = [...SERVING, "closing"] as const;

/**
 * The RabbitMQ client of the service as a `mark1russell7.machine/1` document. It is one generation
 * at a time: one connection of amqplib and its confirm channel. The machines `amqplib` and
 * `rabbitmq-connection` of `@mark1russell7/machines` give the connection and its heartbeat. The states:
 * - `ready`: the channel is open, and the client sends each call.
 * - `blocked`: a resource alarm of the broker blocked the connection. Each call is not sent until the unblock.
 * - `failing`: no generation is open. The client tries the next node after its backoff.
 *
 * The end of the channel or of the connection ends the generation. A test records the transitions
 * of the client and replays them against this document.
 */
export const RABBIT_CLIENT_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "service.machine.rabbitmq-client",
  title: "The RabbitMQ client of the service, over amqplib 2",
  layer: "driver",
  version: "0.1.0",
  sources: [{ ref: "packages/service/src/rabbitmq (the client implements this document)", rung: "implemented" }],
  states: {
    none: { initial: true, note: "the client exists, and its first connection does not" },
    connecting: { note: "a connection, its handshake, and the open of its confirm channel, in connect_bound" },
    ready: { note: "the channel is open. A black hole stays hidden until the heartbeat or a timer of a call ends it" },
    blocked: { note: "a resource alarm blocked the connection: the broker does not read its socket" },
    failing: { note: "no generation is open. The client tries the next node after its backoff" },
    closing: { note: "connection.close, in close_bound, then a destroy of the socket" },
    end: { final: true, note: "the service closed the client" },
  },
  events: {
    "status.connecting": { kind: "local" },
    join: { kind: "rx", note: "the confirm channel is open: a new generation (D1)" },
    "connect.failed": { kind: "local", note: "the connection or its channel failed, or did not open in connect_bound" },
    "retry.connect": { kind: "timer", note: "the backoff ended: a try on the next node" },
    "connection.error": { kind: "rx", note: "an error event of the connection. Its close follows" },
    "connection.end": { kind: "rx", note: "the connection closed: a reset, a FIN, the heartbeat, or a close of the broker" },
    "channel.error": { kind: "rx", note: "the broker closed the channel with a reply code" },
    "channel.end": { kind: "rx", note: "the channel closed on a connection that stays: the client closes that connection too" },
    "connection.blocked": { kind: "rx", note: "connection.blocked of the broker: a resource alarm" },
    "connection.unblocked": { kind: "rx" },
    "command.reissue": { kind: "local" },
    "close.request": { kind: "local" },
    "close.bound": { kind: "timer", note: "connection.close got no close-ok in close_bound" },
    "close.destroy": { kind: "local", note: "the bound destroys a socket that a silent broker does not close" },
    "status.end": { kind: "local" },
  },
  knobs: {
    connect_bound: knob("socketOptions.timeout"),
    heartbeat_interval: knob("heartbeat"),
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
      note: "the bound of the wrapper on the connection and its channel. amqplib bounds the connect and the handshake with the same time",
    },
    heartbeat: {
      duration: { expr: "3 * heartbeat_interval", unit: "s" },
      arms: ["join"],
      cancels: ["connection.end", "close.request"],
      fires: "connection.end",
      note: "the heartbeat of amqplib ends a silent connection 2 to 3 heartbeats after the last data. Each frame that arrives starts it again",
    },
    retry: {
      duration: { expr: "min(retry_cap, retry_base * pow(2, fired)) + retry_base", unit: "s" },
      arms: ["connect.failed", "connection.end", "channel.end"],
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
    t("connection-end", [...OPEN], "connection.end", "failing", { timer: "heartbeat" }),
    t("channel-end", [...OPEN], "channel.end", "failing"),
    t("blocked", "ready", "connection.blocked", "blocked"),
    t("unblocked", "blocked", "connection.unblocked", "ready"),
    ...OPEN.map((state) => t(`connection-error-${state}`, state, "connection.error", state)),
    ...OPEN.map((state) => t(`channel-error-${state}`, state, "channel.error", state)),
    ...LIVE.map((state) => t(`reissue-${state}`, state, "command.reissue", state)),
    t("close", [...SERVING], "close.request", "closing"),
    t("close-bound", "closing", "close.bound", "closing", { timer: "close" }),
    t("close-destroy", "closing", "close.destroy", "closing"),
    t("end", "closing", "status.end", "end"),
  ],
};
