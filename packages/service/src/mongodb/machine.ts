import type { Machine } from "@mark1russell7/algebra";
import { clientKnob as knob, closeTimer, transition as t } from "../client/machine.ts";

/** The states where the driver exists and serves. */
const SERVING = ["connecting", "ready", "failing"] as const;
const OPEN = [...SERVING, "closing"] as const;

/**
 * The MongoDB client of the service as a `mark1russell7.machine/1` document. It is the topology as
 * the wrapper sees it, not one connection: the document `mongodb-node` of `@mark1russell7/machines`
 * gives the monitor and each connection. The state is the view of the topology:
 * - `ready`: a server is writable: a primary, a standalone, a mongos, or a load balancer.
 * - `failing`: no server is writable, or the startup found none in `connect_bound`. The monitor
 *   goes on, and a command waits for a writable server in `client_retry_window`.
 *
 * A connection that closes and a pool that the driver clears do not change the state by themselves.
 * The write-off of a server changes the view of the topology, and that changes the state. A test
 * records the transitions of the client and replays them against this document.
 */
export const MONGO_CLIENT_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "service.machine.mongodb-client",
  title: "The MongoDB client of the service, over a MongoClient of the driver 7",
  layer: "driver",
  version: "0.1.0",
  sources: [{ ref: "packages/service/src/mongodb (the client implements this document)", rung: "implemented" }],
  states: {
    none: { initial: true, note: "the client exists, and its MongoClient does not" },
    connecting: { note: "the monitor looks for the servers of the topology" },
    ready: { note: "a server is writable. A dead idle connection stays hidden until the monitor writes the server off" },
    failing: { note: "no server is writable. A command waits for one in client_retry_window" },
    closing: { note: "the close of the driver: it fails the commands in flight, sends endSessions, and closes the topology" },
    end: { final: true, note: "the service closed the client" },
  },
  events: {
    "status.connecting": { kind: "local" },
    "topology.writable": { kind: "rx", note: "the view of the topology has a writable server" },
    "topology.unwritable": { kind: "rx", note: "the view of the topology has no writable server, for example after a write-off or a step down" },
    join: { kind: "rx", note: "a connection of the pool finished its handshake (D1). The id of the server comes with its first command" },
    "connect.failed": { kind: "local", note: "the startup found no writable server in connect_bound, or the connect of the driver failed" },
    "pool.cleared": { kind: "rx", note: "the driver cleared the pool of a server, and with a write-off also failed its commands in flight" },
    "heartbeat.failed": { kind: "rx", note: "a hello of the monitor failed" },
    "client.error": { kind: "rx", note: "an error event of the driver" },
    "command.reissue": { kind: "local" },
    "close.request": { kind: "local" },
    "close.bound": { kind: "timer", note: "the close of the driver goes on after the bound, in the background" },
    "close.destroy": { kind: "local", note: "the client never records it: the driver gives no socket that the bound can destroy" },
    "status.end": { kind: "local" },
  },
  knobs: {
    connect_bound: knob("connectTimeoutMS"),
    close_bound: knob("close.bound"),
  },
  timers: {
    connect_timeout: {
      duration: { knob: "connect_bound", unit: "s" },
      arms: ["enter:connecting"],
      cancels: ["topology.writable", "connect.failed"],
      fires: "connect.failed",
      note: "the startup stops its wait, and the connect of the driver goes on in client_retry_window",
    },
    close: closeTimer(),
  },
  transitions: [
    t("connect", "none", "status.connecting", "connecting"),
    t("writable", ["connecting", "failing"], "topology.writable", "ready"),
    t("unwritable", "ready", "topology.unwritable", "failing"),
    t("connect-failed", ["connecting", "failing"], "connect.failed", "failing", { timer: "connect_timeout" }),
    ...OPEN.map((state) => t(`join-${state}`, state, "join", state)),
    ...OPEN.map((state) => t(`pool-cleared-${state}`, state, "pool.cleared", state)),
    ...OPEN.map((state) => t(`heartbeat-failed-${state}`, state, "heartbeat.failed", state)),
    ...OPEN.map((state) => t(`client-error-${state}`, state, "client.error", state)),
    ...OPEN.map((state) => t(`reissue-${state}`, state, "command.reissue", state)),
    t("close", [...SERVING], "close.request", "closing"),
    t("close-bound", "closing", "close.bound", "closing", { timer: "close" }),
    t("end", "closing", "status.end", "end"),
  ],
};
