import type { Cell, CountBand, Outcomes, Pair } from "@mark1russell7/harness";
import { INSERT } from "@mark1russell7/harness";
import { ms, q, s, sysctlsOf } from "../catalog.ts";
import { linuxValues } from "../mongo/model.ts";
import { PG_TARGET } from "./t01.ts";
import { PGBOUNCER_HOP } from "./t10.ts";

/**
 * This module holds the cells of SYS-61, on T10: the client of node-postgres, one PgBouncer, a
 * PostgreSQL 17.11 primary, and one standby. The question: what is the outcome of a COMMIT with no
 * reply?
 *
 * Each term comes from REL_17_11 (src/backend):
 *
 * 1. A COMMIT flushes its WAL first (access/transam/xact.c:1491). It marks the commit log next
 *    (:1497), and it waits for the standby (:1546). The reply is last (tcop/postgres.c:1304, then
 *    :1343). The WAL sender can send only WAL that is flushed
 *    (replication/walsender.c:3249).
 * 2. The wait has no timeout (replication/syncrep.c:331). A reply from the standby ends it
 *    (replication/walsender.c:2540), and the standby replies after its flush
 *    (replication/walreceiver.c:1070, :1110). The timeout of the WAL sender does not end it
 *    (replication/walsender.c:2815).
 * 3. A cancel ends the wait with a WARNING, and the commit replies with success
 *    (replication/syncrep.c:317 to :325). The commit is on one server, and the client has an ack.
 * 4. Crash recovery finishes each commit that the wait held: the flush is before the wait
 *    (doc/src/sgml/high-availability.sgml:1344).
 *
 * Thus a write with no reply is in one of three sets, and two final reads tell which:
 *
 * - `kept`: the new primary holds it.
 * - `stranded`: only the old primary holds it, after its crash recovery.
 * - `absent`: no server holds it.
 *
 * Each writer stops at its first failure, and a write with no reply stops its writer. Thus the count
 * of writes with no reply is the count of writers. The time of the window at the fault does not
 * enter. A writer sends one write in each cycle, and the cycle is longer than the window.
 */

/** These are the writers of the client. A writer has one write at a time. */
export const WRITERS = 4;
/** This is the time from the reply of a write to the next write of its writer, in ms. */
export const INTERVAL_MS = 50;
/** This time is the hold of the fault, in s: shorter than `wal_sender_timeout` (replication/walsender.c:127), 60 s. */
export const HOLD_S = 10;
/** This is the most time of one commit through the pooler on the runner, in ms. No source gives it: it is an assumption. */
export const COMMIT_MS = 20;

const exactly = (count: number): CountBand => ({ low: count, high: count });

/**
 * This function gives the lost writes when only the standby is cut, with no synchronous standby.
 * Each writer writes each cycle in the hold, and the standby has none of them. A cycle is the
 * interval, and at most one commit more. A writer can be at either edge of the hold, thus each end
 * of the band has one write for each writer more.
 */
export const lostOfRate = (writers: number = WRITERS, holdS: number = HOLD_S): CountBand => {
  const cycles = (cycleMs: number): number => (writers * holdS * 1000) / cycleMs;
  return { low: Math.floor(cycles(INTERVAL_MS + COMMIT_MS)) - writers, high: Math.ceil(cycles(INTERVAL_MS)) + writers };
};

interface CommitSpec {
  /** This is the plan id of the cell. */
  readonly plan: string;
  /** This text ends the name of the cell. */
  readonly name: string;
  readonly synchronous: boolean;
  readonly cuts: Pair["cuts"];
  readonly cancels?: number;
  /** This band is the band of acknowledged writes that the new primary does not hold. */
  readonly lost: CountBand;
  readonly outcomes: Outcomes;
  readonly why: string;
}

/** These are the specs of the cells of SYS-61. */
const COMMIT_SPECS: readonly CommitSpec[] = [
  {
    plan: "T10.commit.1",
    name: "the primary cut from each peer, no synchronous standby",
    synchronous: false,
    cuts: "all",
    lost: { low: 0, high: WRITERS },
    outcomes: { unknown: exactly(WRITERS), missing: exactly(0), warnings: exactly(0) },
    why: "the WAL send follows the flush and the ack does not wait for it (xact.c:1491, walsender.c:3249): each writer can have one ack that the cut stops on its way to the standby",
  },
  {
    plan: "T10.commit.2",
    name: "the primary cut from each peer, a synchronous standby",
    synchronous: true,
    cuts: "all",
    lost: exactly(0),
    outcomes: { unknown: exactly(WRITERS), missing: exactly(0), warnings: exactly(0) },
    why: "an ack follows the flush of the standby (syncrep.c:285, walreceiver.c:1070, :1110): no ack is lost. The writes with no reply are measured: the sets depend on where the cut finds each write",
  },
  {
    plan: "T10.commit.3",
    name: "the primary cut from its standby, no synchronous standby",
    synchronous: false,
    cuts: "standby",
    lost: lostOfRate(),
    outcomes: { unknown: exactly(WRITERS), kept: exactly(0), missing: exactly(0), warnings: exactly(0) },
    why: "the primary acknowledges with no standby (syncrep.c:209): each write of the hold is lost, a count of the rate of the client",
  },
  {
    plan: "T10.commit.4",
    name: "the primary cut from its standby, a synchronous standby",
    synchronous: true,
    cuts: "standby",
    lost: exactly(0),
    outcomes: { unknown: exactly(WRITERS), absent: exactly(0), missing: exactly(0), warnings: exactly(0) },
    why: "each writer stops in the wait with its WAL flushed (xact.c:1491, :1546): a write with no reply is on a server, on the old primary after its crash recovery (high-availability.sgml:1344) or on the standby",
  },
  {
    plan: "T10.commit.5",
    name: "the primary cut from its standby, a synchronous standby, two cancels",
    synchronous: true,
    cuts: "standby",
    cancels: 2,
    lost: { low: WRITERS, high: 2 * WRITERS },
    outcomes: { unknown: exactly(WRITERS), absent: exactly(0), missing: exactly(0), warnings: exactly(2 * WRITERS) },
    why: "a cancel gives a WARNING and a reply with success (syncrep.c:317): the acks of the second cancel are on no standby, and the acks of the first can be on it from before the cut",
  },
];

/** This function gives the cell of a spec. */
const commitCell = (spec: CommitSpec): Cell => ({
  name: `${spec.plan} pg-8.23 to postgresql, ${spec.name}`,
  target: PG_TARGET,
  topology: { name: "T10", hops: [PGBOUNCER_HOP] },
  client: "pg",
  sysctls: sysctlsOf(linuxValues()),
  probe: { mode: "stream", keepalive: false, interval: ms(INTERVAL_MS), driver: { name: "pg", query: INSERT } },
  fault: "blackhole",
  hold: s(HOLD_S),
  pair: {
    synchronous: spec.synchronous,
    writers: WRITERS,
    interval: ms(INTERVAL_MS),
    cuts: spec.cuts,
    ...(spec.cancels === undefined ? {} : { cancels: spec.cancels }),
  },
  prediction: {
    detects: null,
    window: q(HOLD_S + 30),
    why: spec.why,
    from: "fault",
    group: { lands: "new", failover: true, stages: [], lost: spec.lost, outcomes: spec.outcomes },
  },
  runs: 4,
  // a run promotes the standby, thus each run has its own environment
  environments: 4,
  fresh: true,
  concurrency: 1,
});

/** These are the cells of SYS-61. */
export const COMMIT_CELLS: readonly Cell[] = COMMIT_SPECS.map(commitCell);
