// @mark1russell7/algebra/replay: the replay of a trace against a machine document. A machine of
// any name, with its own states and events, replays here. The entry does not import zod. Thus
// a client in a browser can replay its own transitions.

import type { Machine } from "./machine.ts";
import { arr, fromStates } from "./states.ts";

/**
 * A transition is one change of state that a running machine reports. A lifecycle event of
 * `@mark1russell7/service` is a transition, and so is a report of any other machine.
 */
export interface Transition {
  /** This name identifies the machine that reported. Each program names its own machines. */
  readonly machine?: string | undefined;
  /** This name identifies one machine among others of its kind: a connection, a check. */
  readonly instance: string;
  readonly from: string;
  readonly on: string;
  readonly to: string;
  /** This time is when the transition occurred, in milliseconds. The replay does not read it. */
  readonly at?: number | undefined;
}

/** These are the parts of a machine document that a replay reads. */
export type Replayable = Pick<Machine, "id" | "states" | "transitions">;

/** These options tell which transitions of a trace replay. */
export interface ReplayOptions {
  /** Only the transitions of this machine replay. Without it, each transition of the trace replays. */
  readonly machine?: string | undefined;
}

/**
 * This function replays a trace against a machine document, and it gives each disagreement:
 * - Each instance starts in the state that its first transition leaves.
 * - Each transition must leave the state where the replay of its instance is, and that state must be in the document.
 * - The document must have a transition from that state, on that event, to that state. The state "*" is each state that is not final.
 */
export const replay = (doc: Replayable, transitions: readonly Transition[], options: ReplayOptions = {}): string[] => {
  const problems: string[] = [];
  const at = new Map<string, string>();
  for (const event of transitions) {
    if (options.machine !== undefined && event.machine !== options.machine) continue;
    const where = at.get(event.instance) ?? event.from;
    if (doc.states[where] === undefined) problems.push(`${event.instance}: the state ${where} is not in ${doc.id}`);
    if (event.from !== where)
      problems.push(`${event.instance}: the runtime left ${event.from} on ${event.on}, but the replay is in ${where}`);
    const allowed = doc.transitions.some(
      (each) => fromStates(doc, each.from).includes(event.from) && arr(each.on).includes(event.on) && each.to === event.to,
    );
    if (!allowed) problems.push(`${event.instance}: ${doc.id} has no transition from ${event.from} on ${event.on} to ${event.to}`);
    at.set(event.instance, event.to);
  }
  return problems;
};
