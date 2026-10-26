import type { Machine } from "@mark1russell7/algebra";
import { clientKnob as knob, closeTimer, transition as t } from "../client/machine.ts";

/** The states where the agent exists and serves. */
const SERVING = ["connecting", "ready", "failing"] as const;
const OPEN = [...SERVING, "closing"] as const;

/**
 * The HTTP client of the service as a `mark1russell7.machine/1` document. It is the agent as the
 * wrapper sees it, not one socket: the document `node-http-agent` of `@mark1russell7/machines`
 * gives each socket of the agent. The state is the outcome of the last connect of a socket:
 * - `ready`: the last connect succeeded.
 * - `failing`: the last connect failed, or did not end in connect_bound. The agent does not connect
 *   again by itself. The next request tries again.
 *
 * A free socket that the agent closes does not change the state. A request on a reused socket that
 * fails records `reuse.failed`, and the state stays. A test records the transitions of the client
 * and replays them against this document.
 */
export const HTTP_CLIENT_MACHINE: Machine = {
  format: "mark1russell7.machine/1",
  id: "service.machine.http-client",
  title: "The HTTP client of the service, over an http.Agent of Node",
  layer: "driver",
  version: "0.1.0",
  sources: [{ ref: "packages/service/src/http-client (the client implements this document)", rung: "implemented" }],
  states: {
    none: { initial: true, note: "the client exists, and its agent does not" },
    connecting: { note: "the check request of the startup opens the first socket" },
    ready: { note: "the last connect succeeded. A dead free socket stays hidden until the free socket timer or a request meets it" },
    failing: { note: "the last connect failed. A request that waits for a socket of a full pool does not change the state" },
    closing: { note: "the client waits for its calls in flight in close_bound, then destroys each socket of the agent" },
    end: { final: true, note: "the service closed the client" },
  },
  events: {
    "status.connecting": { kind: "local" },
    join: { kind: "rx", note: "a new socket of the agent connected: the request on it leaves the client (D1)" },
    "connect.failed": { kind: "local", note: "a connect failed: its error, or connect_bound" },
    "reuse.failed": { kind: "rx", note: "a request on a free socket that the agent reused failed: the server closed that socket" },
    "command.reissue": { kind: "local" },
    "close.request": { kind: "local" },
    "close.bound": { kind: "timer", note: "a call in flight did not end in close_bound" },
    "close.destroy": { kind: "local", note: "the bound destroys each socket of the agent, and each call in flight is indeterminate" },
    "status.end": { kind: "local" },
  },
  knobs: {
    connect_bound: knob("connect.bound"),
    request_timeout: knob("request.bound"),
    pool_idle_expiry: knob("timeout"),
    hint_buffer: knob("agentKeepAliveTimeoutBuffer"),
    keepalive_idle: knob("keepAliveMsecs"),
    close_bound: knob("close.bound"),
  },
  timers: {
    connect_timeout: {
      duration: { knob: "connect_bound", unit: "s" },
      arms: ["enter:connecting"],
      cancels: ["join", "connect.failed"],
      fires: "connect.failed",
      note: "the timer of the wrapper on the connect of a new socket. The agent has no connect timer",
    },
    close: closeTimer(),
  },
  transitions: [
    t("connect", "none", "status.connecting", "connecting"),
    t("join", [...SERVING], "join", "ready"),
    t("connect-failed", [...SERVING], "connect.failed", "failing", { timer: "connect_timeout" }),
    // a request that is in flight at the close can still connect, or fail
    t("join-closing", "closing", "join", "closing"),
    t("connect-failed-closing", "closing", "connect.failed", "closing"),
    ...OPEN.map((state) => t(`reuse-failed-${state}`, state, "reuse.failed", state)),
    ...OPEN.map((state) => t(`reissue-${state}`, state, "command.reissue", state)),
    t("close", [...SERVING], "close.request", "closing"),
    t("close-bound", "closing", "close.bound", "closing", { timer: "close" }),
    t("close-destroy", "closing", "close.destroy", "closing"),
    t("end", "closing", "status.end", "end"),
  ],
};
