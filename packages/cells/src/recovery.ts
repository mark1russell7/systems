import type { Cell, Drill, GroupReading } from "@mark1russell7/harness";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { LADDER_FORMAT, ladderVerdict, type Ladder, type LadderVerdict, type RungEvidence, type RungRecord } from "@mark1russell7/rigor-bench";
import { ms, s, sysctlsOf } from "./catalog.ts";
import { MONGO_IMAGE } from "./mongo/cells.ts";
import { MEMBER_STAMPS, SET_DEFAULTS, replicaSetOf } from "./mongo/harness.ts";
import { INTERVAL, linuxValues } from "./mongo/model.ts";

/**
 * The recovery drills (SYS-94). A drill stops the store during writes, removes its disk, and
 * recovers from a real backup. A set difference counts each lost write, and a timer runs from the
 * fault to the first accepted write. A restore that nobody tested is not a backup.
 *
 * A drill cannot wait 24 h. The loss of a backup depends on the age of the newest backup at the
 * fault. Thus a drill shortens the interval and it sets that age itself. Each rung has a schedule of
 * its own. The RPO of a rung is the interval of its schedule plus the excess that the drill measured.
 *
 * The band of a restore is a tenth of the budget of its rung. Nothing derives that time. A drill
 * measures it, and the band only says that a rung has room.
 *
 * The band of an election comes from the settings of the set. The members last heard the primary at
 * most one heartbeat before the fault, thus the first election starts after the election timeout
 * less a heartbeat. The upper end is the claim of the roadmap.
 */

/** This count is the number of runs of a drill. Each run reads each write, thus four runs are enough for a law with no exception. */
const DRILL_RUNS = 4;
/** This size is the generated data of one tenant. */
const TENANT: Quantity = { value: 1_048_576, unit: "B" };
/** This fraction of the budget of a rung is the band of a restore. */
const ROOM = 0.1;

/** A recovery rung is one rung of the ladder of recovery, with its schedule of backups and its drills. */
export interface RecoveryRung {
  readonly name: string;
  readonly tenants: number;
  /** This time is the most data that the rung can lose. */
  readonly rpo: Quantity;
  /** This time is the longest time to service. */
  readonly rto: Quantity;
  /** This time is the interval of the newest backup at this rung, in production. It stays under the RPO, with room for the time of the backup itself. */
  readonly schedule: Quantity;
  /** This name is the prefix of the drill that restores. */
  readonly drill: string;
  /** This name is the prefix of the drill with a copy of each write left: no write of it can go. */
  readonly kept: string;
}

/** These are the rungs of the ladder of recovery. */
export const RECOVERY_RUNGS: readonly RecoveryRung[] = [
  { name: "1", tenants: 1, rpo: s(86_400), rto: s(14_400), schedule: s(82_800), drill: "RD.1", kept: "RD.control" },
  { name: "100", tenants: 100, rpo: s(300), rto: s(1_800), schedule: s(240), drill: "RD.100.restore", kept: "RD.100.failover" },
  { name: "1000", tenants: 1_000, rpo: s(60), rto: s(900), schedule: s(45), drill: "RD.1000.restore", kept: "RD.1000.failover" },
];

const rungNamed = (name: string): RecoveryRung => {
  const found = RECOVERY_RUNGS.find((rung) => rung.name === name);
  if (found === undefined) throw new Error(`no recovery rung ${name}`);
  return found;
};

/** This function gives the band of a drill that restores, from the budget of its rung. */
const restoreBand = (rung: RecoveryRung): { readonly low: Quantity; readonly high: Quantity } => ({ low: s(0), high: s(valueIn(rung.rto, "s") * ROOM) });

/** This count is the most writes after the newest backup. A writer sends one write at each interval, and the writes in flight come after them. */
const writesIn = (age: Quantity): number => Math.ceil(valueIn(age, "s") / INTERVAL) + 2;

/** A drill spec is what differs from one drill to another. */
interface DrillSpec {
  readonly name: string;
  readonly members: readonly string[];
  readonly drill: Drill;
  readonly lands: "same" | "new";
  readonly failover: boolean;
  readonly lost: { readonly low: number; readonly high: number };
  readonly band: { readonly low: Quantity; readonly high: Quantity };
  readonly what: string;
}

/** This function gives the cell of a drill. */
const drillCell = (spec: DrillSpec): Cell => ({
  name: spec.name,
  target: { image: MONGO_IMAGE, port: 27017, ready: "Waiting for connections" },
  sysctls: sysctlsOf(linuxValues()),
  probe: { mode: "stream", keepalive: false, interval: ms(INTERVAL * 1000) },
  fault: "fin",
  replicaSet: replicaSetOf({}, spec.members),
  writeConcern: "majority",
  drill: spec.drill,
  prediction: {
    detects: true,
    timer: spec.what,
    errno: "OK",
    from: "fault",
    low: spec.band.low,
    high: spec.band.high,
    group: {
      lands: spec.lands,
      failover: spec.failover,
      stages: [{ stage: "first-write", low: spec.band.low, high: spec.band.high }],
      stamps: MEMBER_STAMPS,
      lost: spec.lost,
    },
  },
  runs: DRILL_RUNS,
  environments: 2,
  // a set and its backup host read three schedulers: one cell at a time
  concurrency: 1,
});

const ONE_MEMBER: readonly string[] = ["m1"];
const THREE_MEMBERS: readonly string[] = ["m1", "m2", "m3"];
const WHOLE_RESTORE = "the time of a restore, from the fault to the first accepted write";
const AGE_OF_A_DUMP = s(60);
const AGE_OF_A_SLICE = s(10);
const AT_REST = s(5);
const { electionTimeoutMillis, heartbeatIntervalMillis } = SET_DEFAULTS as { readonly electionTimeoutMillis: number; readonly heartbeatIntervalMillis: number };

/** These are the recovery drills. */
export const RECOVERY_CELLS: readonly Cell[] = [
  drillCell({
    name: "RD.1 one node, disk lost, a dump with its oplog: each write after the dump goes, and no other",
    members: ONE_MEMBER,
    drill: { tenants: 1, perTenant: TENANT, slices: 0, sliceEvery: s(0), age: AGE_OF_A_DUMP, recovery: "restore" },
    lands: "same",
    failover: false,
    lost: { low: 1, high: writesIn(AGE_OF_A_DUMP) },
    band: restoreBand(rungNamed("1")),
    what: WHOLE_RESTORE,
  }),
  drillCell({
    name: "RD.100.failover three members, the disk of the primary lost: an election loses no accepted write",
    members: THREE_MEMBERS,
    drill: { tenants: 100, perTenant: TENANT, slices: 0, sliceEvery: s(0), age: AT_REST, recovery: "election" },
    lands: "new",
    failover: true,
    lost: { low: 0, high: 0 },
    band: { low: ms(electionTimeoutMillis - heartbeatIntervalMillis), high: s(15) },
    what: "an election after the loss of the primary, to the first accepted write",
  }),
  drillCell({
    name: "RD.100.restore three members, each disk lost, a dump and slices of the oplog: each write after the last slice goes, and no other",
    members: THREE_MEMBERS,
    drill: { tenants: 100, perTenant: TENANT, slices: 3, sliceEvery: AGE_OF_A_SLICE, age: AGE_OF_A_SLICE, recovery: "restore" },
    lands: "same",
    failover: false,
    lost: { low: 1, high: writesIn(AGE_OF_A_SLICE) },
    band: restoreBand(rungNamed("100")),
    what: WHOLE_RESTORE,
  }),
  drillCell({
    name: "RD.1000.failover three members, 1 GB, the disk of the primary lost: an election loses no accepted write at this size",
    members: THREE_MEMBERS,
    drill: { tenants: 1_000, perTenant: TENANT, slices: 0, sliceEvery: s(0), age: AT_REST, recovery: "election" },
    lands: "new",
    failover: true,
    lost: { low: 0, high: 0 },
    band: { low: ms(electionTimeoutMillis - heartbeatIntervalMillis), high: s(15) },
    what: "an election after the loss of the primary, to the first accepted write",
  }),
  drillCell({
    name: "RD.1000.restore three members, each disk lost, 1 GB, a dump and slices of the oplog: the time at a large size, and the same law",
    members: THREE_MEMBERS,
    drill: { tenants: 1_000, perTenant: TENANT, slices: 3, sliceEvery: AGE_OF_A_SLICE, age: AGE_OF_A_SLICE, recovery: "restore" },
    lands: "same",
    failover: false,
    lost: { low: 1, high: writesIn(AGE_OF_A_SLICE) },
    band: restoreBand(rungNamed("1000")),
    what: WHOLE_RESTORE,
  }),
  drillCell({
    name: "RD.control one node, disk lost after the dump with no later write: no write goes",
    members: ONE_MEMBER,
    drill: { tenants: 1, perTenant: TENANT, slices: 0, sliceEvery: s(0), age: AT_REST, recovery: "restore", quiet: true },
    lands: "same",
    failover: false,
    lost: { low: 0, high: 0 },
    band: restoreBand(rungNamed("1")),
    what: WHOLE_RESTORE,
  }),
];

/** This name is the measure of the data that a rung loses: the interval of its schedule plus the excess that a drill measured. */
export const RPO = "rpo";
/** This name is the measure of the time to service. */
export const RTO = "rto";
/** This name is the measure of each accepted write that a restore lost, below a write that it kept. */
export const HOLES = "accepted writes lost below a kept write";
/** This name is the measure of the lost writes that the backups do not explain. */
export const UNEXPLAINED = "lost writes that the last backup does not explain";
/** This name is the measure of a recovery that changed the data of a tenant. */
export const CHANGED = "drills that changed the data of a tenant";
/** This name is the measure of the accepted writes that a store lost with a copy of them left. */
export const LOST_WITH_A_COPY = "accepted writes lost with a copy left";

/** This count is the number of drills that a rung needs: each budget is a worst case. */
const MIN_DRILLS = DRILL_RUNS;
/** This count is how many lost writes a run can leave unexplained: the writes in flight at the fault. */
const IN_FLIGHT = 2;

/**
 * This ladder is the recovery of a store of tenants. A rung holds only with a record of its drills.
 * Each rung is locked: a weekly run of the workflow Cells fails when a rung is not within its budgets.
 */
export const RECOVERY_LADDER: Ladder = {
  format: LADDER_FORMAT,
  subject: "the recovery of a store of tenants",
  dimensions: [{ name: "tenants", describe: "one tenant, with 1 MB of generated data in one store" }],
  rungs: RECOVERY_RUNGS.map((rung) => ({
    name: rung.name,
    at: { tenants: rung.tenants },
    budgets: [
      { kind: "worst", measure: RPO, unit: "s", limit: valueIn(rung.rpo, "s"), minDrills: MIN_DRILLS },
      { kind: "worst", measure: RTO, unit: "s", limit: valueIn(rung.rto, "s"), minDrills: MIN_DRILLS },
      { kind: "worst", measure: HOLES, unit: "writes", limit: 0, minDrills: MIN_DRILLS },
      { kind: "worst", measure: UNEXPLAINED, unit: "writes", limit: IN_FLIGHT, minDrills: MIN_DRILLS },
      { kind: "worst", measure: CHANGED, unit: "drills", limit: 0, minDrills: MIN_DRILLS },
      { kind: "worst", measure: LOST_WITH_A_COPY, unit: "writes", limit: 0, minDrills: MIN_DRILLS },
    ],
    test: `cells ${rung.drill} and ${rung.kept}`,
    locked: true,
  })),
};

/** This time is the size of the fault of the flip test: one drill takes this time more than the RTO of its rung. */
export const RTO_FAULT: Quantity = s(1);

/** This function gives the record of a rung with the fault of the flip test. The other drills of the record do not change. */
export const faultedRecord = (rung: RecoveryRung, record: RungRecord): RungRecord => ({
  ...record,
  evidence: record.evidence.map((each) =>
    each.kind === "worst" && each.measure === RTO ? { ...each, values: [valueIn(rung.rto, "s") + valueIn(RTO_FAULT, "s"), ...each.values.slice(1)] } : each,
  ),
});

/** This function gives the verdict of the ladder of recovery, with `now` as the time of the verdict in ISO 8601. */
export const recoveryVerdict = (records: readonly RungRecord[], now: string): LadderVerdict => ladderVerdict(RECOVERY_LADDER, records, { now });

/** This list states what a drill does not do. A rung shows it beside its verdict. */
const SYNTHETIC: readonly string[] = [
  "the interval of the backups is shortened: the record adds the interval of the rung to the measured excess",
  "the data of the tenants is generated",
  "the recovery starts at the fault: the RTO has no detection time and no human time",
  "each member is a container on one runner, thus no network separates them",
];

/** This function tells what a drill did for real. */
const realOf = (cell: Cell): string[] => {
  const drill = cell.drill!;
  return [
    "a client that writes during the backups",
    "a stop of each server, and the removal of each disk",
    `a real mongodump of ${(drill.tenants * valueIn(drill.perTenant, "B")) / 1_048_576} MB with its oplog`,
    ...(drill.slices === 0 ? [] : [`${drill.slices} real slices of the oplog`]),
    "a real mongorestore with a replay of the oplog",
    "a set difference over each accepted write",
  ];
};

/** This function gives the numbers of each counted run that has them. A run with no number leaves fewer drills than a budget needs, and that budget cannot decide. */
const valuesOf = (runs: readonly GroupReading[], read: (run: GroupReading) => number | null | undefined): number[] =>
  runs.flatMap((run) => {
    const value = run.void === null ? read(run) : null;
    return value === null || value === undefined ? [] : [value];
  });

/** These are the drills of one rung, by the prefix of the name of their cell. */
export type DrillRuns = Readonly<Record<string, readonly GroupReading[]>>;

/**
 * This function gives the record of a rung from the measurements of its drills. The RPO of each run
 * is the interval of the schedule of the rung plus the excess of the run. Thus the shortened
 * interval of a drill is not its result. `commit` and `at` tell which run this was.
 */
export const recoveryRecord = (rung: RecoveryRung, drills: DrillRuns, commit: string, at: string): RungRecord => {
  const restores = drills[rung.drill] ?? [];
  const kept = drills[rung.kept] ?? [];
  const interval = valueIn(rung.schedule, "s");
  const worst = (measure: string, values: readonly number[]): RungEvidence => ({ kind: "worst", measure, values });
  const cell = RECOVERY_CELLS.find((each) => each.name.startsWith(`${rung.drill} `));
  if (cell === undefined) throw new Error(`no cell ${rung.drill}`);
  return {
    rung: rung.name,
    commit,
    at,
    real: realOf(cell),
    synthetic: SYNTHETIC,
    evidence: [
      worst(
        RPO,
        valuesOf(restores, (run) => {
          const excess = run.group.recovery?.excess;
          return excess === undefined || excess === null ? null : interval + valueIn(excess, "s");
        }),
      ),
      worst(
        RTO,
        valuesOf(restores, (run) => (run.elapsed === null ? null : valueIn(run.elapsed, "s"))),
      ),
      worst(
        HOLES,
        valuesOf(restores, (run) => run.group.recovery?.holes.length),
      ),
      worst(
        UNEXPLAINED,
        valuesOf(restores, (run) => {
          const lost = run.group.writes.lost;
          const after = run.group.recovery?.afterBackup;
          return lost === null || after === undefined || after === null ? null : Math.abs(lost.length - after);
        }),
      ),
      worst(
        CHANGED,
        valuesOf(restores, (run) => {
          const same = run.group.recovery?.sameData;
          return same === undefined || same === null ? null : same ? 0 : 1;
        }),
      ),
      worst(
        LOST_WITH_A_COPY,
        valuesOf(kept, (run) => run.group.writes.lost?.length),
      ),
    ],
  };
};
