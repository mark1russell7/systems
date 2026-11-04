import type { Cell, GroupPlace } from "@mark1russell7/harness";
import type { Quantity } from "@mark1russell7/quantity";
import { q, seconds } from "./catalog.ts";
import type { T12Spec } from "./t12.ts";
import { GROUP_RTT_MS, HOLD, INTERVAL_MS, MEMBER_SETTINGS, PINNED, ioredisValues, t12Cell } from "./t12.ts";

/**
 * This module holds the first cells of S3 (SYS-58). The group, the client and the records are the
 * ones of T12. The question: how many accepted writes does a failover lose, and does
 * `min-replicas-to-write` bound that count?
 *
 * With no setting, the old primary accepts each write of a pinned client up to its conversion. That
 * count grows with the hold, and with a time after the lift that no document gives. With
 * `min-replicas-to-write 1`, the old primary refuses writes when no replica is good. Thus the count
 * must not depend on the hold.
 *
 * Each term comes from the source of Valkey 9.1.2:
 * - A replica sends `REPLCONF ACK` from `replicationCron`, each 1 s (src/replication.c:5296,
 *   src/server.c:1664).
 * - The primary stores `server.unixtime` as the time of the acknowledgment, in whole seconds
 *   (src/replication.c:1462).
 * - A replica is good while `lag <= min-replicas-max-lag`, in whole seconds (src/replication.c:4933-4935).
 * - The primary refreshes the count of good replicas at the end of `replicationCron`
 *   (src/replication.c:5439), and when a replica client goes (src/replication.c:1334).
 * - `processCommand` refuses a write with NOREPLICAS while the count is below the setting
 *   (src/server.c:4550).
 * - An EOF frees a client after the current batch of events (src/networking.c:3183).
 *
 * The harness record has the history: `sent`, then `ack` or `fail` for each write, and the keys that
 * the group kept. Their difference is the set check of Jepsen, and `writesOf` gives it.
 */

/** This time is the period of `replicationCron`, in seconds. */
const CRON = 1;
/** This time is the tick of the server, in seconds: 1000 / hz, with hz at its default of 10 (src/server.h:139). */
const TICK = 0.1;
/** This count is `min-replicas-max-lag`, at its default, in seconds. */
export const MAX_LAG = 10;
/** These are the settings of each member of these cells: one replica must be good for a write. */
export const BOUNDED_MEMBERS: Readonly<Record<string, string>> = { ...MEMBER_SETTINGS, "min-replicas-to-write": "1", "min-replicas-max-lag": String(MAX_LAG) };

/** The name of the error of a refused write in the lines of the client: ioredis gives each error reply this name. */
const REFUSED = "ReplyError";

interface Span {
  readonly lo: number;
  readonly hi: number;
}

/** This function rounds a time in seconds to the microsecond of the stamps. */
export const rounded = (value: number): number => Math.round(value * 1e6) / 1e6;

/**
 * This function gives the first refusal after a cut of each replica, from the fault, in seconds:
 * - The last acknowledgment reached the primary up to one period and one tick before the fault.
 * - In whole seconds, the first refresh that fails comes more than L s after that acknowledgment.
 *   It comes up to L + 2 s after it, and one tick later at most.
 * - The cached clock of the server can move the low edge one more tick.
 */
export const refusalOf = (maxLag = MAX_LAG): Span => ({ lo: rounded(maxLag - CRON - 2 * TICK), hi: rounded(maxLag + 2 * CRON + TICK) });

/** This function gives the time from one write to the next, in seconds: the pause, a round trip and a step of the event loop. */
export const cycleOf = (): Span => {
  const slack = seconds(ioredisValues(GROUP_RTT_MS)("slack") as Quantity, "slack");
  return { lo: INTERVAL_MS / 1000, hi: rounded((INTERVAL_MS + GROUP_RTT_MS) / 1000 + slack) };
};

/**
 * This function gives the band of lost writes of a cut of each replica. The accepted writes from the
 * fault to the first refusal are the lost writes. The low edge is the short window at the slow cycle,
 * less one for the phase. The high edge is the long window at the fast cycle, plus one write in flight at
 * the fault and one at the refusal.
 */
export const lostOfCut = (maxLag = MAX_LAG): { readonly low: number; readonly high: number } => {
  const refusal = refusalOf(maxLag);
  const cycle = cycleOf();
  return { low: Math.floor(rounded(refusal.lo / cycle.hi)) - 1, high: Math.ceil(rounded(refusal.hi / cycle.lo)) + 2 };
};

/**
 * This band is the lost writes of a freeze that outlasts the failover. Each replica closed its link in
 * the failover, and the frozen kernel holds each FIN. At the thaw, the event loop frees each replica
 * after its batch of events. The primary can accept the write that waited through the freeze, and one
 * more write can have missed its replication at the freeze.
 */
export const LOST_OF_FREEZE = { low: 0, high: 2 } as const;

const AT_GROUP: GroupPlace = { role: "primary", cuts: "group" };
const WHY = `the first write on the new primary has no band: ${PINNED}. The band of lost writes judges the cell`;

/** This function gives a partition of the primary from its group, with its clients, at a hold. */
const partition = (plan: string, hold: number): T12Spec => ({
  plan,
  name: `partition:partial, the primary cut from the Sentinels and the replicas, its clients with it, ${hold} s, min-replicas-to-write 1`,
  fault: "partition",
  at: AT_GROUP,
  hold,
  member: BOUNDED_MEMBERS,
  why: WHY,
});

/** These are the specs of the cells of SYS-58: a partition at two holds, and a freeze. */
export const WRITES_SPECS: readonly T12Spec[] = [
  partition("T12.writes.1", HOLD),
  partition("T12.writes.2", 2 * HOLD),
  {
    plan: "T12.writes.3",
    name: `freeze-process at the primary, ${HOLD} s, min-replicas-to-write 1`,
    fault: "freeze-process",
    at: { role: "primary" },
    hold: HOLD,
    member: BOUNDED_MEMBERS,
  },
];

/** This count is the runs of a cell of SYS-58: the decision rule of the prediction reads 4. */
const WRITES_RUNS = 4;

/** This function gives the cell of a spec, with its band of lost writes and the band of the first refusal at the client. */
export const writesCell = (spec: T12Spec): Cell => {
  const cell = t12Cell(spec);
  const cycle = cycleOf();
  const refused = spec.fault === "freeze-process" ? { lo: spec.hold!, hi: spec.hold! } : refusalOf();
  const prediction = cell.prediction;
  return {
    ...cell,
    runs: WRITES_RUNS,
    prediction: {
      ...prediction,
      group: {
        ...prediction.group!,
        errors: [{ name: REFUSED, low: q(refused.lo), high: q(rounded(refused.hi + cycle.hi)) }],
        lost: spec.fault === "freeze-process" ? LOST_OF_FREEZE : lostOfCut(),
      },
    },
  };
};

/** These are the cells of SYS-58. */
export const WRITES_CELLS: readonly Cell[] = WRITES_SPECS.map(writesCell);
