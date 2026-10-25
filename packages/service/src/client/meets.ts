// The manifestations that a client can meet, and their detectors (E9). The shapes and the two
// queries are the same for each client. Each client entry gives its own list of meetings.

import type { Extent, Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";

/** A situation is what the connection did when the failure started: a command in flight, or idle. */
export type Situation = "in flight" | "idle";

/** A detector is a mechanism that finds a failure, and the most time that it takes. */
export interface Detector {
  /** This name identifies the mechanism: a knob of the declaration, or the kernel. */
  readonly by: string;
  /** This time is the most that the detector takes, after the failure starts. "infinite" tells that it does not find the failure. */
  readonly within: Extent;
  readonly situation: Situation;
  /** This text tells what the detector does, for example that it fails a command without a change of state. */
  readonly effect: string;
}

/**
 * A meeting is a manifestation that the client can meet, and its detectors (E9). The names of the
 * manifestations are the names of the vocabulary of the harness and the corpus. `app-stall` is a
 * server whose process is alive and does not answer, a proposal of the vocabulary.
 */
export interface Meeting {
  readonly manifestation: string;
  /** This text tells the failure in words. */
  readonly what: string;
  readonly detectors: readonly Detector[];
}

const seconds = (amount: Extent): number =>
  amount.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(amount as Quantity, "s");

/** This function gives the first detector of a manifestation in a situation, or null when no detector has an end (C3). */
export const firstDetector = (meeting: Meeting, situation: Situation): Detector | null => {
  const ranked = meeting.detectors
    .filter((detector) => detector.situation === situation && detector.within.value !== "infinite")
    .sort((a, b) => seconds(a.within) - seconds(b.within));
  return ranked[0] ?? null;
};

/** This function gives each manifestation and situation that no detector of the client finds: the standing rule, as a query (C3, E9). */
export const unwatched = (meets: readonly Meeting[]): Array<{ readonly manifestation: string; readonly situation: Situation }> =>
  meets.flatMap((meeting) =>
    (["in flight", "idle"] as const).flatMap((situation) =>
      firstDetector(meeting, situation) === null ? [{ manifestation: meeting.manifestation, situation }] : [],
    ),
  );
