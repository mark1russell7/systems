import type { Cell } from "@mark1russell7/harness";
import { s } from "../catalog.ts";
import type { MongoSpec } from "./cells.ts";
import { setCell } from "./harness.ts";
import { nameOfT11, predictT11 } from "./t11.ts";

/**
 * This module holds the MongoDB cells of the writes of S3 (SYS-59). The set, the client and the
 * records are the ones of T11. The question: which writes does a rollback take at each write
 * concern?
 *
 * The law: with `w: 1`, the set loses each write that the old primary acknowledges after the last
 * replicated one. That count comes from the timers of the step-down. With `w: "majority"`, the set
 * loses none. A cut that ends before the timers end loses none at `w: 1` too.
 *
 * Each term comes from the source of MongoDB r9.0.4, in src/mongo/db:
 * - `w: 1` waits for no other member (write_concern.cpp:428-431, write_concern_options.cpp:200-203).
 * - Each position from a secondary is an update of its member (repl/member_data.cpp:159-173).
 * - The primary sets a check at the stalest update plus electionTimeoutMillis
 *   (repl/replication_coordinator_impl_heartbeat.cpp:1158-1188).
 * - A member with no update for electionTimeoutMillis is stale. A primary without a majority steps
 *   down (repl/topology_coordinator.cpp:1440-1457).
 * - The primary accepts writes until `_stepDownFinish` holds the lock and stops them
 *   (repl/replication_coordinator_impl_heartbeat.cpp:547-641).
 * - A wait for the majority fails at the step-down (repl/replication_coordinator_impl.cpp:2449-2468).
 * - The step-down stops the writes that are in flight (repl/replication_coordinator_impl.cpp:3901-3917).
 * - A voter refuses a candidate that has less data (repl/topology_coordinator.cpp:3755).
 * - A heartbeat response from the primary moves the election timer
 *   (repl/replication_coordinator_impl_heartbeat.cpp:346-351).
 *
 * After the lift, the fetcher of the old primary finds a diverged oplog (repl/oplog_fetcher.cpp:1063-1070),
 * and that starts the rollback (repl/bgsync.cpp:551-554). The rollback finds the common point
 * (repl/rollback_impl.cpp:1208) and recovers to the stable timestamp (repl/rollback_impl.cpp:699).
 * Each write after the common point leaves the collection. It stays only in a rollback file on the
 * disk of that member (repl/rollback_impl.cpp:684), and the final read does not see that file.
 *
 * The record of T11 has the history and the final read, and `writesOf` gives the set check.
 */

/** This hold is the partition of T11, in seconds: past the win of the election. */
const HOLD = 40;

/** This hold ends before each timer of the election, in seconds. Contact comes back 6.2 s after the fault at most. */
const SHORT_HOLD = 3;

/**
 * This time is how much longer a short cut runs after its lift, in seconds. The run then reads the
 * set 15 s after the fault, past the latest win of an election in the band of `T11.writes.1`.
 */
export const WATCH = 10;

/** This count is the runs of a cell of SYS-59: the decision rule of the prediction reads 4. */
const WRITES_RUNS = 4;

/** This reason is why a failover has no band of time here. */
const TWO_MODES = "the first write on the new primary has two modes, and 4 runs do not place a median in one band. The band of lost writes judges the cell";

/** This reason is why a short cut has no band of time. The first write after the fault is not the question. */
const SAME_PRIMARY = "the first write goes to the same primary, and the question is what the set keeps. The band of lost writes judges the cell, with the stages that must not come";

/** This function gives a cut of the primary from the other members, with its clients on its side. */
const cut = (plan: string, hold: number, w: "majority" | 1): MongoSpec => ({
  plan,
  name: `partition:complete, the primary cut from the other members, not from the clients, ${hold} s, writes with w ${w}`,
  fault: "partition",
  mode: "stream",
  at: { role: "primary", cuts: "group" },
  hold,
  w,
});

/** These are the specs of the cells of SYS-59: the two concerns over a failover, and w 1 over a cut that ends first. */
export const T11_WRITES_SPECS: readonly MongoSpec[] = [cut("T11.writes.1", HOLD, 1), cut("T11.writes.2", HOLD, "majority"), cut("T11.writes.3", SHORT_HOLD, 1)];

/**
 * This function gives the cell of a spec, with the band of lost writes of its prediction. The band
 * judges the cell, and the time stays a measurement. The stages stay in the record of the group.
 */
export const t11WritesCell = (spec: MongoSpec): Cell => {
  const prediction = predictT11(spec);
  const cell = setCell({ spec, name: nameOfT11(spec), prediction });
  const group = cell.prediction.group;
  const lost = prediction.group?.lost;
  if (group === undefined || lost === undefined) throw new Error(`${spec.plan}: a cell of the writes has a group prediction`);
  const failover = group.lands === "new";
  return {
    ...cell,
    runs: WRITES_RUNS,
    ...(failover ? {} : { watch: s(WATCH) }),
    prediction: { detects: null, window: prediction.window, why: failover ? TWO_MODES : SAME_PRIMARY, from: "fault", group: { ...group, lost } },
  };
};

/** These are the cells of SYS-59. */
export const T11_WRITES_CELLS: readonly Cell[] = T11_WRITES_SPECS.map(t11WritesCell);
