// The manifestations that a client can meet, and their detectors (E9). The shapes, the two queries,
// the detectors of the kernel and the words of each manifestation are the same for each client.
// Each client entry gives its own list of meetings, because the timers of each driver differ.

import type { Extent, Quantity } from "@mark1russell7/quantity";
import { quantity, valueIn } from "@mark1russell7/quantity";

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

/** These are the manifestations that each client gives a meeting for, in this sequence. */
export const MANIFESTATIONS = ["rst", "fin", "blackhole", "freeze-host", "freeze-process", "app-stall"] as const;

/** A manifestation is one name of `MANIFESTATIONS`. */
export type Manifestation = (typeof MANIFESTATIONS)[number];

/**
 * These words tell each manifestation that does not depend on the driver. The words of `app-stall`
 * name an example, and the example is a fact of each server, thus each client gives them.
 */
export const WHAT: Readonly<Record<Exclude<Manifestation, "app-stall">, string>> = {
  rst: "the server answers each segment with a reset, and refuses each new connection",
  fin: "the process of the server ends, and its kernel closes the connection",
  blackhole: "the network drops each segment in the two directions",
  "freeze-host": "the host of the server stops, without a close: the death without a close",
  "freeze-process": "the process of the server stops, and its kernel stays up",
};

/** This amount is a detector that does not find the failure. */
export const NEVER: Extent = { value: "infinite", unit: "s" };

const s = (value: number): Quantity => quantity(Math.round(value * 1e6) / 1e6, "s");
const seconds = (amount: Extent): number =>
  amount.value === "infinite" ? Number.POSITIVE_INFINITY : valueIn(amount as Quantity, "s");

/** Node gives keepalive 10 probes, 1 s apart, after its idle time: a silent peer is found 10 s after the idle time. */
const NODE_PROBES = 10;
const NODE_INTERVAL = 1;

/** This function gives the time at which Node's TCP keepalive gives up a silent peer: the idle time, then 10 probes 1 s apart. */
export const keepaliveGiveUp = (idle: Extent): Extent => (idle.value === "infinite" ? NEVER : s(seconds(idle) + NODE_PROBES * NODE_INTERVAL));

/** This detector is a segment that arrives at once: a reset or a FIN. */
export const immediate = (situation: Situation, effect: string): Detector => ({ by: "the next segment", within: s(0), situation, effect });

/** This detector is TCP keepalive on a silent peer. It gives up after its probes, and the socket closes. */
export const keepaliveSilent = (idle: Extent): Detector => ({
  by: "keepalive_idle",
  within: keepaliveGiveUp(idle),
  situation: "idle",
  effect: "TCP keepalive gives up, and the socket closes",
});

/** This detector is TCP keepalive on a peer whose kernel stays up. That kernel answers each probe, thus keepalive does not find the failure. */
export const keepaliveAnswered = (): Detector => ({
  by: "keepalive_idle",
  within: NEVER,
  situation: "idle",
  effect: "the kernel of the server answers each probe",
});

/** This detector is TCP keepalive on a peer that resets: the first probe gets the reset. */
export const keepaliveReset = (idle: Extent): Detector => ({
  by: "keepalive_idle",
  within: idle.value === "infinite" ? NEVER : idle,
  situation: "idle",
  effect: "the first probe gets a reset",
});

/** This detector is the kernel, which gives up the retransmissions of a segment in flight. A driver can add what follows. */
export const kernelGiveUp = (within: Extent, after?: string): Detector => ({
  by: "retrans_giveup_time",
  within,
  situation: "in flight",
  effect: `the kernel gives up the retransmissions and closes the socket${after === undefined ? "" : `, and ${after}`}`,
});

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
