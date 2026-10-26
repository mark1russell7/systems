// The parts of the machine document of a client that each client has. Each client entry writes its
// own states and transitions, because the states are the states of its driver. The helpers, the
// knob shape, the timer of the bounded close and the events that the core records are the same.

import type { TransitionDef } from "@mark1russell7/algebra";

/** This function gives one transition of a machine document. */
export const transition = (
  id: string,
  from: string | readonly string[],
  on: string | readonly string[],
  to: string,
  extra: Partial<TransitionDef> = {},
): TransitionDef => ({
  id,
  from,
  on,
  to,
  ...extra,
});

/** A client knob is a knob of a client in a machine document: a time in seconds, with no default. */
export interface ClientKnob {
  readonly key: string;
  readonly scope: "client";
  readonly unit: "s";
  readonly default: null;
}

/** This function gives a knob of a client in a machine document, by the option of the driver that it sets. */
export const clientKnob = (key: string): ClientKnob => ({ key, scope: "client", unit: "s", default: null });

/** A close timer is the timer of the bounded close in a machine document. */
export interface CloseTimer {
  readonly duration: { readonly knob: "close_bound"; readonly unit: "s" };
  readonly arms: readonly ["close.request"];
  readonly cancels: readonly ["status.end"];
  readonly fires: "close.bound";
}

/** This timer is the bound of the close. The close request arms it, and the end cancels it. At its end, the driver destroys each socket. */
export const closeTimer = (): CloseTimer => ({
  duration: { knob: "close_bound", unit: "s" },
  arms: ["close.request"],
  cancels: ["status.end"],
  fires: "close.bound",
});

/**
 * These are the events that each machine document of a client declares. The core and the shared
 * parts of each client record them: a second try, a failed connect, and the steps of the bounded close.
 */
export const CLIENT_EVENTS = ["status.connecting", "connect.failed", "command.reissue", "close.request", "close.bound", "close.destroy", "status.end"] as const;
