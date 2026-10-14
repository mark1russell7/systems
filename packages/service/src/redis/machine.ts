import type { Machine, TransitionDef } from "@mark1russell7/algebra";

const t = (id: string, from: string | readonly string[], on: string | readonly string[], to: string, extra: Partial<TransitionDef> = {}): TransitionDef => ({
  id,
  from,
  on,
  to,
  ...extra,
});
const knob = (key: string) => ({ key, scope: "client", unit: "s", default: null }) as const;

/** The states where the connection exists or tries to exist, thus where it can close. */
const LIVE = ["connecting", "connect", "ready", "reconnecting"] as const;
const ANY = ["none", "connecting", "connect", "ready", "close", "reconnecting", "end"] as const;

/**
 * The Redis client as a `mark1russell7.machine/1` document. Its states are the states of ioredis.
 * The wrapper adds its own events: the join at each `ready`, and the misses of its watchdog. It also
 * adds a command that it sends again, and the bound of its close. A test records the transitions of the
 * client and replays them against this document.
 *
 * The state `ready` hides states that the client cannot see (D4). In a black hole, ioredis stays
 * `ready` while the kernel retransmits, until `driver_writeoff_time` or the watchdog ends that
 * hidden interval. A timer of this document bounds each hidden interval.
 */
export const REDIS_CLIENT_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "service.machine.redis-client",
  title: "The Redis client of the service, over ioredis 6",
  layer: "driver",
  version: "0.2.0",
  sources: [{ ref: "packages/service/src/redis (the client implements this document)", rung: "implemented" }],
  states: {
    none: { initial: true, note: "the client exists, and its connection does not" },
    connecting: { note: "a TCP connection attempt" },
    connect: { note: "the handshake: HELLO, then the ready check (INFO)" },
    ready: { note: "it can hide a black hole or a frozen server, until a timer of the client ends it" },
    close: { note: "the socket closed. Each command in flight settles as indeterminate" },
    reconnecting: { note: "the delay of the retry strategy, which doubles to its cap" },
    end: { note: "the retry window ended, or the service closed the client. The watchdog starts it again" },
  },
  events: {
    "status.connecting": { kind: "local" },
    "status.connect": { kind: "rx" },
    "status.ready": { kind: "rx" },
    "status.close": { kind: "rx" },
    "status.reconnecting": { kind: "timer" },
    "status.end": { kind: "local" },
    join: { kind: "rx", note: "the reply of CLIENT ID at ready (D1)" },
    error: { kind: "rx" },
    "connect.failed": { kind: "local" },
    "command.written": { kind: "tx" },
    "command.reissue": { kind: "local" },
    data: { kind: "rx" },
    heartbeat: { kind: "timer" },
    "watchdog.miss": { kind: "local" },
    "watchdog.reconnect": { kind: "local" },
    "watchdog.revive": { kind: "local" },
    "retry.window-ended": { kind: "local" },
    "close.request": { kind: "local" },
    "close.bound": { kind: "timer" },
    "close.destroy": { kind: "local", note: "the bound destroys a socket that a silent server does not close" },
  },
  knobs: {
    connect_bound: knob("connectTimeout"),
    driver_writeoff_time: knob("socketTimeout"),
    heartbeat_interval: knob("watchdog.interval"),
    close_bound: knob("close.bound"),
  },
  timers: {
    connect_timeout: {
      duration: { knob: "connect_bound", unit: "s" },
      arms: ["enter:connecting"],
      cancels: ["status.connect", "status.close"],
      fires: "status.close",
      note: "ioredis destroys the attempt",
    },
    writeoff: {
      duration: { knob: "driver_writeoff_time", unit: "s" },
      arms: ["command.written"],
      cancels: ["data", "status.close"],
      fires: "status.close",
      note: "ioredis destroys a socket that gives no data while a command waits: it ends the hidden interval of a black hole",
    },
    heartbeat: {
      duration: { knob: "heartbeat_interval", unit: "s" },
      arms: ["enter:ready", "heartbeat"],
      cancels: ["status.close", "status.end"],
      fires: "heartbeat",
      note: "a PING on the connection of the application",
    },
    close: {
      duration: { knob: "close_bound", unit: "s" },
      arms: ["close.request"],
      cancels: ["status.end"],
      fires: "close.bound",
    },
  },
  transitions: [
    t("connect", ["none", "reconnecting", "end", "close"], "status.connecting", "connecting"),
    t("tcp", "connecting", "status.connect", "connect"),
    t("ready", "connect", "status.ready", "ready"),
    t("close", [...LIVE], "status.close", "close"),
    t("retry", "close", "status.reconnecting", "reconnecting"),
    t("end", [...LIVE, "close"], "status.end", "end"),
    t("join", "ready", "join", "ready"),
    t("miss", "ready", "watchdog.miss", "ready"),
    t("watchdog-reconnect", "ready", "watchdog.reconnect", "ready"),
    t("revive", "end", "watchdog.revive", "end"),
    // the retry strategy answers in `close`, before ioredis moves to `reconnecting` or `end`
    t("window-ended", "close", "retry.window-ended", "close"),
    ...ANY.map((state) => t(`error-${state}`, state, "error", state)),
    ...ANY.map((state) => t(`connect-failed-${state}`, state, "connect.failed", state)),
    ...ANY.map((state) => t(`reissue-${state}`, state, "command.reissue", state)),
    ...ANY.map((state) => t(`close-bound-${state}`, state, "close.bound", state, { timer: "close" })),
    ...ANY.map((state) => t(`close-destroy-${state}`, state, "close.destroy", state)),
  ],
};
