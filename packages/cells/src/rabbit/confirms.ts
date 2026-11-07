import type { Cell, GroupPlace, GroupPrediction } from "@mark1russell7/harness";
import { LINUX_TCP } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { q, s } from "../catalog.ts";
import { WRITERS, copiesOf } from "../resend.ts";
import { MEASURED_WINDOW } from "../t12.ts";
import { amqpValues } from "./t01.ts";
import type { ClusterSpec } from "./t11.ts";
import { HOLD, NODE_STAMPS, PARTS, clusterCell, heartbeatEnd } from "./t11.ts";

/**
 * This module holds the cells of SYS-60. The cluster and the records are the ones of T11. The final
 * read of the harness drains the quorum queue, thus it keeps each copy. The question: does a confirmed
 * publish survive a failure, and does a republish duplicate it?
 *
 * Each term comes from the source of rabbitmq-server v4.3.6, ra v3.1.10 and amqplib v2.2.0. The
 * document docs/S3.md gives each term with its lines.
 * - A confirm comes after the apply of a commit on a majority. A member counts only what it wrote
 *   and synced. Thus the law of the lost messages is 0.
 * - At a leader change, rabbit_fifo_client sends each pending command again with its number.
 *   rabbit_fifo drops a number that it applied. Thus a leader change adds no copy while the channel
 *   lives.
 * - A republish of the client goes on a new connection, thus on a new channel. The new process is a
 *   new enqueuer, and nothing drops its copy. Each unconfirmed publish with an applied first copy
 *   gives one copy.
 *
 * The law: with W publishes unconfirmed at one close, the extra copies are W if each first copy was
 * applied. The copies are 0 if no connection closes. A first copy in a frozen node can arrive after
 * its channel ended. Thus a freeze of the node of the client has the band [0, W].
 */

/** This time is the chosen heartbeat of the client, in seconds: it closes the connection inside the hold. It has no source. */
export const HEARTBEAT = 2;
/** This time is the chosen hold of the cut of the confirms, in seconds. It has no source, and `confirmCell` tests its bounds. */
export const CUT_HOLD = 10;
/** This count is the runs of a cell of SYS-60: the decision rule of the prediction reads 4. */
const CONFIRM_RUNS = 4;
/** This band is the law of the lost messages: a confirmed publish stays. */
const NONE = { low: 0, high: 0 };

/** This place is the cut of the confirms: the segments from the node of the leader to the client drop, and the publishes arrive. */
const CONFIRMS_CUT: GroupPlace = { role: "primary", cuts: "to-clients" };

/** A confirm spec is one cell of SYS-60, before its prediction. */
export interface ConfirmSpec extends ClusterSpec {
  /** This count is the writers of the client, which is W of the law. */
  readonly writers: number;
  /** This time is the heartbeat that the client asks for, in seconds. With null, the client takes the one of the broker. */
  readonly heartbeat: number | null;
  /** This band is the law of the extra copies in each run. */
  readonly copies: { readonly low: number; readonly high: number };
  /** This text is why the first confirm has no band, or null when the cell keeps the band of T11. */
  readonly why: string | null;
}

const NO_FIRST = "The first confirm has no band: it waits for the end of a connection, and the band of extra copies judges the cell";
const CLOSED_CUT = "the cut drops each confirm of the node of the leader. The heartbeat of amqplib ends the connection, and each unconfirmed publish goes again through the next node";

/** These are the specs of SYS-60: two leader changes, the law at two values of W, its control, and the race of a freeze. */
export const CONFIRM_SPECS: readonly ConfirmSpec[] = [
  {
    plan: "T11.confirms.1",
    name: `event:stepdown, transfer_leadership to a follower, ${WRITERS} writers`,
    fault: "step-down",
    at: { role: "primary" },
    writers: WRITERS,
    heartbeat: null,
    copies: copiesOf(WRITERS, 0, true),
    why: null,
  },
  {
    plan: "T11.confirms.2",
    name: `freeze-process at the node of the leader, ${HOLD} s, ${WRITERS} writers`,
    fault: "freeze-process",
    at: { role: "primary" },
    hold: HOLD,
    writers: WRITERS,
    heartbeat: null,
    copies: copiesOf(WRITERS, 0, true),
    why: null,
  },
  {
    plan: "T11.confirms.3",
    name: `partition:simplex, the segments from the node of the leader to the client dropped, the client on it, ${CUT_HOLD} s, heartbeat ${HEARTBEAT} s, one writer`,
    fault: "partition",
    at: CONFIRMS_CUT,
    hold: CUT_HOLD,
    clientAt: "leader",
    writers: 1,
    heartbeat: HEARTBEAT,
    copies: copiesOf(1, 1, true),
    why: `${CLOSED_CUT}. ${NO_FIRST}`,
  },
  {
    plan: "T11.confirms.4",
    name: `partition:simplex, the segments from the node of the leader to the client dropped, the client on it, ${CUT_HOLD} s, heartbeat ${HEARTBEAT} s, ${WRITERS} writers`,
    fault: "partition",
    at: CONFIRMS_CUT,
    hold: CUT_HOLD,
    clientAt: "leader",
    writers: WRITERS,
    heartbeat: HEARTBEAT,
    copies: copiesOf(WRITERS, 1, true),
    why: `${CLOSED_CUT}. ${NO_FIRST}`,
  },
  {
    plan: "T11.confirms.5",
    name: `partition:simplex, the segments from the node of the leader to the client dropped, the client on it, ${CUT_HOLD} s, default heartbeat, ${WRITERS} writers`,
    fault: "partition",
    at: CONFIRMS_CUT,
    hold: CUT_HOLD,
    clientAt: "leader",
    writers: WRITERS,
    heartbeat: null,
    copies: copiesOf(WRITERS, 0, true),
    why: "the cut ends before the heartbeat of the broker, thus no connection closes. TCP sends the confirms again after the lift, at a time that its backoff sets, and the band of extra copies judges the cell",
  },
  {
    plan: "T11.confirms.6",
    name: `freeze-process at the node of the leader, the client on it, ${HOLD} s, heartbeat ${HEARTBEAT} s, ${WRITERS} writers`,
    fault: "freeze-process",
    at: { role: "primary" },
    hold: HOLD,
    clientAt: "leader",
    writers: WRITERS,
    heartbeat: HEARTBEAT,
    copies: { low: 0, high: WRITERS },
    why: `the frozen node holds each first copy that it did not read, and the end of the old channel races them after the thaw. Thus the law gives only the bounds of the copies. ${NO_FIRST}`,
  },
];

/** This function gives the values of amqplib for a heartbeat of the client. */
const valuesOf = (heartbeat: number | null): Record<string, Extent> => amqpValues(heartbeat === null ? {} : { heartbeat });

/** This function gives the group of a cell that has no band for its first confirm. */
const measuredGroup = (spec: ConfirmSpec, base: GroupPrediction): GroupPrediction => {
  if (spec.fault === "partition") return { lands: "same", failover: false, stages: [], stamps: NODE_STAMPS, quiet: ["elected"] };
  return { ...base, stages: (base.stages ?? []).filter((each) => each.stage === "elected") };
};

/** This function gives the cell of a spec. It throws if a term of the law does not hold for the spec. */
export const confirmCell = (spec: ConfirmSpec): Cell => {
  const cell = clusterCell(spec);
  const { prediction } = cell;
  const hold = spec.hold ?? 0;
  const end = heartbeatEnd(valuesOf(spec.heartbeat));
  const closes = spec.heartbeat !== null;
  if (closes && end.hi >= hold) throw new Error(`${spec.plan}: the heartbeat can come after the lift, thus no connection closes`);
  if (spec.fault === "partition") {
    // after a retransmission timeout, the kernel of the client holds each new segment behind the first one
    const rtoMin = (LINUX_TCP.knobs["tcp_rto_min"]?.default ?? 0) / 1000;
    if (PARTS.gap.hi + PARTS.commit >= rtoMin) throw new Error(`${spec.plan}: a writer can wake after the first retransmission timeout`);
    // the retransmissions of the broker back off by doubling, thus the next one comes before twice the hold
    if (!closes && end.lo <= 2 * hold) throw new Error(`${spec.plan}: the heartbeat can come before the confirms after the lift`);
  }
  const base = prediction.group!;
  const group: GroupPrediction = {
    ...(spec.why === null ? base : measuredGroup(spec, base)),
    lost: NONE,
    duplicates: spec.copies,
    ...(closes ? { errors: [{ name: "Error", low: s(end.lo), high: s(end.hi) }] } : {}),
  };
  return {
    ...cell,
    driverOptions: { window: spec.writers, noDelay: true, ...(spec.heartbeat === null ? {} : { heartbeat: spec.heartbeat }) },
    runs: CONFIRM_RUNS,
    prediction: spec.why === null ? { ...prediction, group } : { detects: null, window: q(MEASURED_WINDOW), why: spec.why, from: "fault", group },
  };
};

/** These are the cells of SYS-60. */
export const CONFIRM_CELLS: readonly Cell[] = CONFIRM_SPECS.map(confirmCell);
