import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Drill, ProbeEvent, ReplicaSet, Run, RunRoom } from "./cell.ts";
import type { Writes } from "./timeline.ts";

/**
 * This module holds the pure parts of a recovery drill. These are the scripts of the shell, the reader
 * of the output of `bsondump`, and the set check of a recovery. It has no container, thus unit tests
 * run it. `drill.ts` does the drill on a lab.
 *
 * A dump with `--oplog` reads the oplog from the start of the dump to its end. A slice reads the
 * oplog after the last entry of the backup before it. Thus the backups together hold each write up
 * to the last entry of the last backup, and no write after it. One writer sends the writes one at a
 * time, thus the highest sequence number is also the latest write.
 */

/** This size is one document of generated data. A tenant holds as many documents as its size needs. */
export const SEED_DOCUMENT = 65_536;
/** This count is how far the lost writes can be from the writes after the last backup: the writes in flight at the fault. */
export const LOSS_MARGIN = 2;
/** This time is how long a script waits for a server to stop, in tenths of a second. */
const STOP_TENTHS = 600;

/** This part of the free disk is the oplog of one member. A server with no setting takes 5 % of its free disk. */
const OPLOG_SHARE = 0.05;
/** This part of the data is the room for the journal, the indexes and the slices. */
const DISK_ROOM = 0.1;
/** This rate is the slowest first sync that a drill waits for, in bytes each second. */
const SLOWEST_FIRST_SYNC = 10_000_000;

/** This function gives the time of a drill from the start of the backups to the fault, in seconds. */
export const drillSpan = (drill: Drill): number => drill.slices * valueIn(drill.sliceEvery, "s") + valueIn(drill.age, "s");

/** This function gives the size of the generated data of a drill, in bytes. */
export const drillBytes = (drill: Drill): number => drill.tenants * valueIn(drill.perTenant, "B");

/**
 * This function gives the disk of a drill at its peak, in bytes. Each member holds the data, and the
 * dump holds it once more. Each member also keeps the seed in its oplog, up to the cap of that oplog.
 */
export const diskNeeded = (drill: Drill, members: number, usable: number): number => {
  const bytes = drillBytes(drill);
  return Math.ceil((members + 1) * bytes * (1 + DISK_ROOM) + members * Math.min(bytes, usable * OPLOG_SHARE));
};

/** This function gives the longest wait for the first sync of a drill after a restore, in ms. */
export const firstSyncWithin = (drill: Drill): number => Math.ceil((drillBytes(drill) / SLOWEST_FIRST_SYNC) * 1_000);

/** This script prints the free disk that holds the data of a box, in bytes. */
export const FREE_SCRIPT: string = "df -B1 --output=avail /data/db | tail -n 1";

/** This script prints the bytes that the data of a member holds. A file can go during the read, thus an error of `du` does not stop a run. */
export const HELD_SCRIPT: string = "du -sb /data/db 2>/dev/null || true";

/** This function gives the first number of the output of `df` or `du`. Output with no number gives zero. */
export const bytesIn = (text: string): number => {
  const found = /\d+/.exec(text);
  return found === null ? 0 : Number(found[0]);
};

/** This function gives the available memory from the text of `/proc/meminfo`, in bytes. */
export const availableMemory = (text: string): number => {
  const found = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  if (found === null) throw new Error("/proc/meminfo has no line MemAvailable");
  return Number(found[1]) * 1_024;
};

/** This function gives the reason that a run of a drill is void because of its runner, or null if the runner holds the drill. */
export const roomVoid = (room: RunRoom | undefined): string | null => {
  if (room === undefined) return null;
  const usable = valueIn(room.usable, "B");
  const needs = valueIn(room.needs, "B");
  return usable >= needs ? null : `the runner cannot hold the drill: ${usable} B of disk are usable, and the drill needs ${needs} B`;
};

/**
 * This script writes the generated data of each tenant into the collection `tenants`. Each write
 * waits for `copies` members, thus each member holds the data when the script ends.
 */
export const seedScript = (drill: Drill, copies: number): string => {
  const documents = Math.ceil(valueIn(drill.perTenant, "B") / SEED_DOCUMENT);
  const blob = `BinData(0, require("crypto").randomBytes(${SEED_DOCUMENT}).toString("base64"))`;
  return (
    'const c = db.getSiblingDB("cells"); ' +
    `c.tenants.drop({ writeConcern: { w: ${copies} } }); ` +
    `for (let t = 1; t <= ${drill.tenants}; t += 1) { const docs = []; ` +
    `for (let d = 1; d <= ${documents}; d += 1) docs.push({ _id: "t" + t + ".d" + d, tenant: t, blob: ${blob} }); ` +
    `c.tenants.insertMany(docs, { writeConcern: { w: ${copies}, wtimeout: 60000 } }); } ` +
    "print(JSON.stringify({ ok: true }))"
  );
};

/** This script prints the hash of the collection `tenants`. It takes locks, thus a run reads it with no writer. */
export const HASH_SCRIPT: string =
  'print(JSON.stringify({ hash: db.getSiblingDB("cells").runCommand({ dbHash: 1, collections: ["tenants"] }).collections.tenants }))';

/** This function gives the hash from the output of `HASH_SCRIPT`. */
export const hashOf = (text: string): string => {
  const line = text.split("\n").filter((each) => each.trim() !== "").at(-1) ?? "";
  const { hash } = JSON.parse(line) as { readonly hash?: unknown };
  if (typeof hash !== "string" || hash === "") throw new Error(`no hash of the tenants in: ${line}`);
  return hash;
};

/** This function gives the command of a server with no set, on its own port. A client of the set cannot reach that server, and a restore writes to it. */
export const standaloneCommand = (set: ReplicaSet, port: number): string =>
  `${set.programs.server} --bind_ip_all --port ${port} ${(set.args ?? []).join(" ")}`.trim();

/**
 * This script waits for the end of the server of a box, and it can stop the server first. `kill -0`
 * also succeeds on a zombie, and the shell of the box can leave its child as a zombie for a long
 * time. Thus the script reads the state of the process, and a zombie has ended.
 */
export const stopScript = (terminate: boolean): string =>
  "pid=$(cat /tmp/server.pid); " +
  (terminate ? 'kill -TERM "$pid"; ' : "") +
  `for i in $(seq 1 ${STOP_TENTHS}); do s=$(cut -d' ' -f3 /proc/$pid/stat 2>/dev/null); ` +
  'if [ -z "$s" ] || [ "$s" = Z ]; then exit 0; fi; sleep 0.1; done; exit 1';

/** This function gives a number from Extended JSON, in its relaxed form or in its canonical form, or null. */
const numberOf = (value: unknown): number | null => {
  if (typeof value === "number") return value;
  if (typeof value !== "object" || value === null) return null;
  const wrapped = value as { readonly $numberInt?: unknown; readonly $numberLong?: unknown; readonly $numberDouble?: unknown };
  const text = wrapped.$numberInt ?? wrapped.$numberLong ?? wrapped.$numberDouble;
  return typeof text === "string" && text !== "" && Number.isFinite(Number(text)) ? Number(text) : null;
};

/** This function gives each document of the output of `bsondump`. A line that is not a document does not count. */
const documentsOf = (text: string): Array<Record<string, unknown>> =>
  text.split("\n").flatMap((line) => {
    if (!line.trim().startsWith("{")) return [];
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

/** An oplog time is the `ts` of an oplog entry: a time in seconds, and the count of the entry in that second. */
export interface OplogTime {
  readonly t: number;
  readonly i: number;
}

/** This function gives the `ts` of an oplog entry, or null. */
const timeOf = (entry: Record<string, unknown>): OplogTime | null => {
  const stamp = (entry["ts"] as { readonly $timestamp?: { readonly t?: unknown; readonly i?: unknown } } | undefined)?.$timestamp;
  const t = numberOf(stamp?.t);
  const i = numberOf(stamp?.i);
  return t === null || i === null ? null : { t, i };
};

/** An oplog read is what an oplog file holds: its last entry, and the highest sequence number that it inserts. */
export interface OplogRead {
  readonly last: OplogTime | null;
  readonly highest: number | null;
}

/** This function reads an oplog file from the output of `bsondump`. Only an insert into `cells.w` is a write of a client. */
export const readOplog = (text: string): OplogRead => {
  let last: OplogTime | null = null;
  let highest: number | null = null;
  for (const entry of documentsOf(text)) {
    const time = timeOf(entry);
    if (time !== null && (last === null || time.t > last.t || (time.t === last.t && time.i > last.i))) last = time;
    if (entry["op"] !== "i" || entry["ns"] !== "cells.w") continue;
    const n = numberOf((entry["o"] as { readonly n?: unknown } | undefined)?.n);
    if (n !== null && (highest === null || n > highest)) highest = n;
  }
  return { last, highest };
};

/** This function gives the highest sequence number of the file of the writes in a dump, from the output of `bsondump`, or null. */
export const highestHeld = (text: string): number | null => {
  const held = documentsOf(text).flatMap((document) => {
    const n = numberOf(document["n"]);
    return n === null ? [] : [n];
  });
  return held.length === 0 ? null : Math.max(...held);
};

/** This function gives the query of a slice of the oplog: each entry after an oplog time, in Extended JSON. */
export const sliceQuery = (after: OplogTime): string => JSON.stringify({ ts: { $gt: { $timestamp: { t: after.t, i: after.i } } } });

/** A recovery measurement is what a drill found, beside the writes of the run. */
export interface RecoveryMeasured {
  /** This time is from the reply to the last accepted write that the store kept to the fault, or null with no such write. */
  readonly rpo: Quantity | null;
  /** This time is `rpo` less the age of the drill: what a schedule adds to its interval. It is null for a control and for an election. */
  readonly excess: Quantity | null;
  /** These are the accepted writes that the store lost, below a write that it kept. A restore must leave none. */
  readonly holes: readonly number[];
  /** This count is the number of accepted writes after the last write of the last backup, or null without a backup. */
  readonly afterBackup: number | null;
  /** This flag tells if the tenants have the same data after the recovery, or null when that is not known. */
  readonly sameData: boolean | null;
}

const rounded = (value: number): number => Math.round(value * 1e6) / 1e6;

/** This function gives the acknowledgement time of each accepted write of the first client of a run. */
const firstAcks = (events: readonly ProbeEvent[], second: number | null): Map<number, number> => {
  const acks = new Map<number, number>();
  for (const event of events) {
    const n = Number(event["n"]);
    if (event.ev === "ack" && (second === null || n < second)) acks.set(n, event.t);
  }
  return acks;
};

/** This function gives the measurement of a drill, from its run. `t0` is the fault. */
export const recoveryOf = (drill: Drill, run: Run, t0: number): RecoveryMeasured => {
  const record = run.group?.drill;
  const sameData = record === undefined || record.after === null ? null : record.after === record.before;
  if (drill.recovery === "election" || record === undefined) return { rpo: null, excess: null, holes: [], afterBackup: null, sameData };
  const acks = firstAcks(run.events, record.second);
  const accepted = [...acks.keys()].sort((a, b) => a - b);
  const cutoff = record.backups.at(-1)?.last?.n ?? 0;
  const afterBackup = accepted.filter((n) => n > cutoff).length;
  const holds = run.group?.holds ?? null;
  if (holds === null) return { rpo: null, excess: null, holes: [], afterBackup, sameData };
  const kept = new Set(holds);
  const ownKept = holds.filter((n) => record.second === null || n < record.second);
  const highest = ownKept.length === 0 ? 0 : Math.max(...ownKept);
  const holes = accepted.filter((n) => n < highest && !kept.has(n));
  const lastKept = accepted.filter((n) => kept.has(n)).at(-1);
  const rpo = lastKept === undefined ? null : rounded((t0 - acks.get(lastKept)!) / 1e9);
  return {
    rpo: rpo === null ? null : { value: rpo, unit: "s" },
    excess: rpo === null || drill.quiet === true ? null : { value: rounded(rpo - valueIn(drill.age, "s")), unit: "s" },
    holes,
    afterBackup,
    sameData,
  };
};

/** This function gives the findings of a drill: each rule of a recovery that its run broke. */
export const recoveryFindings = (measured: RecoveryMeasured, writes: Writes): string[] => {
  const findings: string[] = [];
  if (measured.sameData === null) findings.push("the set did not converge, thus nothing compared the data of the tenants");
  else if (!measured.sameData) findings.push("the data of the tenants changed in the recovery");
  if (measured.holes.length > 0)
    findings.push(`the restore lost ${measured.holes.length} accepted writes below a write that it kept, the first at ${measured.holes[0]}`);
  const lost = writes.lost?.length ?? null;
  if (measured.afterBackup !== null && lost !== null && Math.abs(lost - measured.afterBackup) > LOSS_MARGIN)
    findings.push(`the restore lost ${lost} accepted writes, and ${measured.afterBackup} came after the last backup`);
  return findings;
};
