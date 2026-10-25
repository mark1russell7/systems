import type { Machine, TransitionDef } from "@mark1russell7/algebra";

const t = (id: string, from: string | readonly string[], on: string | readonly string[], to: string, extra: Partial<TransitionDef> = {}): TransitionDef => ({
  id,
  from,
  on,
  to,
  ...extra,
});
const knob = (key: string) => ({ key, scope: "client", unit: "s", default: null }) as const;

/** The states where the pool exists and serves. */
const SERVING = ["connecting", "ready", "failing"] as const;
const OPEN = [...SERVING, "closing"] as const;

/**
 * The pg client of the service as a `mark1russell7.machine/1` document. It is the pool as the
 * wrapper sees it, not one connection: the document `node-postgres` of `@mark1russell7/machines`
 * gives each client of the pool. The state is the outcome of the last connect:
 * - `ready`: the last connect of the pool succeeded.
 * - `failing`: the last connect failed. pg does not connect again by itself. The next checkout tries again.
 *
 * An idle client that fails and a client that the pool removes do not change the state. The pool
 * removed that client, and the next checkout opens a new connection. A test records the transitions
 * of the client and replays them against this document.
 */
export const PG_CLIENT_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "service.machine.pg-client",
  title: "The PostgreSQL client of the service, over a pool of node-postgres 8",
  layer: "driver",
  version: "0.1.0",
  sources: [{ ref: "packages/service/src/pg (the client implements this document)", rung: "implemented" }],
  states: {
    none: { initial: true, note: "the client exists, and its pool does not" },
    connecting: { note: "the first checkout of the startup opens the first connection" },
    ready: { note: "the last connect succeeded. A dead idle client stays hidden until the pool ends it or a query meets it" },
    failing: { note: "the last connect failed. A checkout of a full pool that times out does not change the state" },
    closing: { note: "the end of the pool: each idle client sends Terminate, and each held client goes at its release" },
    end: { final: true, note: "the service closed the client" },
  },
  events: {
    "status.connecting": { kind: "local" },
    join: { kind: "rx", note: "the first ReadyForQuery of a new connection, with the process id of its backend (D1)" },
    "connect.failed": { kind: "local", note: "a connect failed: its error, a close, a FATAL of the server, or connect_bound" },
    "checkout.timeout": { kind: "timer", note: "a checkout of a full pool waited connect_bound" },
    "client.error": { kind: "rx", note: "an error of an idle client, or of a client that the service holds" },
    "client.removed": { kind: "local", note: "the socket of a client of the pool closed" },
    "command.reissue": { kind: "local" },
    "close.request": { kind: "local" },
    "close.bound": { kind: "timer" },
    "close.destroy": { kind: "local", note: "the bound destroys each socket that a silent server does not close" },
    "status.end": { kind: "local" },
  },
  knobs: {
    connect_bound: knob("connectionTimeoutMillis"),
    close_bound: knob("close.bound"),
  },
  timers: {
    connect_timeout: {
      duration: { knob: "connect_bound", unit: "s" },
      arms: ["enter:connecting"],
      cancels: ["join", "connect.failed"],
      fires: "connect.failed",
      note: "pg-pool destroys the socket of the attempt: 'Connection terminated due to connection timeout'",
    },
    close: {
      duration: { knob: "close_bound", unit: "s" },
      arms: ["close.request"],
      cancels: ["status.end"],
      fires: "close.bound",
    },
  },
  transitions: [
    t("connect", "none", "status.connecting", "connecting"),
    t("join", [...SERVING], "join", "ready"),
    t("connect-failed", [...SERVING], "connect.failed", "failing", { timer: "connect_timeout" }),
    // a checkout that is in flight at the close can still connect, or fail
    t("join-closing", "closing", "join", "closing"),
    t("connect-failed-closing", "closing", "connect.failed", "closing"),
    ...OPEN.map((state) => t(`checkout-timeout-${state}`, state, "checkout.timeout", state)),
    ...OPEN.map((state) => t(`client-error-${state}`, state, "client.error", state)),
    ...OPEN.map((state) => t(`removed-${state}`, state, "client.removed", state)),
    ...OPEN.map((state) => t(`reissue-${state}`, state, "command.reissue", state)),
    t("close", [...SERVING], "close.request", "closing"),
    t("close-bound", "closing", "close.bound", "closing", { timer: "close" }),
    t("close-destroy", "closing", "close.destroy", "closing"),
    t("end", "closing", "status.end", "end"),
  ],
};
