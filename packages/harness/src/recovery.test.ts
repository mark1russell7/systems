import { describe, expect, it } from "vitest";
import type { Cell, Drill, ProbeEvent, ReplicaSet, Run, RunDrill } from "./cell.ts";
import {
  LOSS_MARGIN,
  drillSpan,
  hashOf,
  highestHeld,
  memAvailableOf,
  readOplog,
  recoveryFindings,
  recoveryOf,
  roomNeeded,
  roomVoidOf,
  seedScript,
  sliceQuery,
  standaloneCommand,
  stopScript,
} from "./recovery.ts";
import type { Writes } from "./timeline.ts";
import { measureGroup } from "./timeline.ts";

const DRILL: Drill = {
  tenants: 2,
  perTenant: { value: 131_072, unit: "B" },
  slices: 3,
  sliceEvery: { value: 10, unit: "s" },
  age: { value: 10, unit: "s" },
  recovery: "restore",
};

const SECOND = 1e9;
const ack = (n: number, t: number): ProbeEvent => ({ ev: "ack", n, t }) as unknown as ProbeEvent;

/** This function gives a run of a drill: each write of the list is acknowledged at `n` seconds. */
const runOf = (accepted: readonly number[], holds: readonly number[] | null, drill: Partial<RunDrill> = {}): Run =>
  ({
    events: accepted.map((n) => ack(n, n * SECOND)),
    group: {
      holds,
      drill: {
        tool: "100.19.1",
        seed: "generated",
        backups: [{ kind: "dump", started: 0, ended: 1, last: { n: 5, t: 5 * SECOND }, size: { value: 1, unit: "B" } }],
        before: "h",
        after: "h",
        restored: { started: 0, ended: 1 },
        second: null,
        ...drill,
      },
    },
  }) as unknown as Run;

const WRITES: Writes = { sent: 10, acked: 10, old: 0, lost: [6, 7, 8], unknown: [] };

describe("the pure parts of a drill", () => {
  it("adds the slices and the age to the time of a drill", () => {
    expect(drillSpan(DRILL)).toBe(40);
  });

  it("writes each tenant, with the documents that its size needs and the copies of the set", () => {
    const script = seedScript(DRILL, 3);
    expect(script).toContain("t <= 2");
    expect(script).toContain("d <= 2");
    expect(script).toContain("w: 3");
  });

  it("reads the hash from the last line, and refuses an answer with no hash", () => {
    expect(hashOf('noise\n{"hash":"abc"}\n')).toBe("abc");
    expect(() => hashOf('{"hash":""}')).toThrow("no hash");
  });

  it("starts a server with no set on its own port", () => {
    const set = { programs: { server: "mongod" }, args: ["--quiet"] } as unknown as ReplicaSet;
    expect(standaloneCommand(set, 27018)).toBe("mongod --bind_ip_all --port 27018 --quiet");
    expect(standaloneCommand({ programs: { server: "mongod" } } as unknown as ReplicaSet, 1)).toBe("mongod --bind_ip_all --port 1");
  });

  it("stops the server only when a caller asks, and it counts a zombie as ended", () => {
    expect(stopScript(true)).toContain("kill -TERM");
    expect(stopScript(false)).not.toContain("kill");
    expect(stopScript(false)).toContain('"$s" = Z');
  });

  it("reads the last entry and the highest write of an oplog, in each form of a number", () => {
    const text = [
      '{"ts":{"$timestamp":{"t":10,"i":1}},"op":"i","ns":"cells.w","o":{"n":3}}',
      '{"ts":{"$timestamp":{"t":10,"i":2}},"op":"i","ns":"cells.w","o":{"n":{"$numberLong":"7"}}}',
      '{"ts":{"$timestamp":{"t":11,"i":1}},"op":"i","ns":"cells.other","o":{"n":99}}',
      '{"ts":{"$timestamp":{"t":11,"i":2}},"op":"n","ns":"","o":{"msg":"periodic noop"}}',
      "not a document",
      "{ a torn line",
    ].join("\n");
    expect(readOplog(text)).toEqual({ last: { t: 11, i: 2 }, highest: 7 });
    expect(readOplog("")).toEqual({ last: null, highest: null });
  });

  it("reads the highest write of a dump in each form of a number", () => {
    expect(highestHeld('{"n":{"$numberInt":"4"}}\n{"n":9}\n{"n":{"$numberDouble":"6.0"}}\n{"m":1}')).toBe(9);
    expect(highestHeld("")).toBeNull();
  });

  it("asks a slice for each entry after an oplog time", () => {
    expect(JSON.parse(sliceQuery({ t: 5, i: 2 }))).toEqual({ ts: { $gt: { $timestamp: { t: 5, i: 2 } } } });
  });
});

describe("the room of a drill on its runner", () => {
  const MB = 1_048_576;
  const GB = 1_073_741_824;
  const big: Drill = { ...DRILL, tenants: 8_000, perTenant: { value: MB, unit: "B" } };
  const data = 8_000 * MB;

  it("needs the data on each member and the dump, and an oplog of 5% of the disk on each member, up to the data", () => {
    // 5% of 100 GB is 5 GB, thus each oplog is smaller than the data
    expect(roomNeeded(big, 3, { value: 100 * GB, unit: "B" })).toEqual({ value: 4 * data + 3 * 5 * GB, unit: "B" });
    // an oplog has at least 990 MB, and the seed fills it only up to the data
    expect(roomNeeded(DRILL, 1, { value: GB, unit: "B" })).toEqual({ value: 2 * 262_144 + 262_144, unit: "B" });
    expect(roomNeeded(big, 3, { value: 10 * GB, unit: "B" })).toEqual({ value: 4 * data + 3 * 990 * MB, unit: "B" });
    // with no limit on the disk, each oplog holds the whole data: the bound of the needs of a shard
    expect(roomNeeded(big, 3, { value: Infinity, unit: "B" })).toEqual({ value: 7 * data, unit: "B" });
  });

  it("reads MemAvailable from /proc/meminfo, and refuses a text with no such line", () => {
    expect(memAvailableOf("MemTotal:       16374028 kB\nMemFree:         1000 kB\nMemAvailable:   12000000 kB\n")).toEqual({ value: 12_000_000 * 1024, unit: "B" });
    expect(() => memAvailableOf("MemTotal: 1 kB")).toThrow("no line MemAvailable");
  });

  it("is void only when the disk is under the need, and a record with no room is not void for this reason", () => {
    const room = { disk: { value: 30e9, unit: "B" }, memory: { value: 12e9, unit: "B" }, need: { value: 42e9, unit: "B" } } as const;
    expect(roomVoidOf(room)).toBe("the runner has 30.0 GB of disk for the drill, and the drill needs 42.0 GB: the data on each member, the dump and the oplogs");
    expect(roomVoidOf({ ...room, disk: { value: 42e9, unit: "B" } })).toBeNull();
    expect(roomVoidOf(undefined)).toBeNull();
  });

  it("makes the run of a drill with no room void with its reason, before it reads the client", () => {
    const room = { disk: { value: 1e9, unit: "B" }, memory: { value: 1e9, unit: "B" }, need: { value: 2e9, unit: "B" } } as const;
    const cell = { drill: big, prediction: { group: undefined } } as unknown as Cell;
    const run = { events: [], kernel: [], fault: null, lost: 0, group: { primary: "m0", drill: { backups: [], room } } } as unknown as Run;
    expect(measureGroup(cell, run).void).toBe("the runner has 1.0 GB of disk for the drill, and the drill needs 2.0 GB: the data on each member, the dump and the oplogs");
    const before = { ...run, group: { primary: "m0", drill: { backups: [] } } } as unknown as Run;
    expect(measureGroup(cell, before).void).toBe("the client never became ready");
  });
});

describe("the measurement of a drill", () => {
  it("counts the writes after the backup, and it reads the age of the last kept write", () => {
    const measured = recoveryOf(DRILL, runOf([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5]), 16 * SECOND);
    expect(measured.afterBackup).toBe(3);
    expect(measured.holes).toEqual([]);
    expect(measured.rpo).toEqual({ value: 11, unit: "s" });
    expect(measured.excess).toEqual({ value: 1, unit: "s" });
    expect(measured.sameData).toBe(true);
  });

  it("finds an accepted write that a restore lost below a write that it kept", () => {
    const measured = recoveryOf(DRILL, runOf([1, 2, 3, 4, 5], [1, 2, 4, 5]), 6 * SECOND);
    expect(measured.holes).toEqual([3]);
  });

  it("does not count the writes of the second client as writes of the first", () => {
    const measured = recoveryOf(DRILL, runOf([1, 2, 3, 4, 5, 6, 100, 101], [1, 2, 3, 4, 5, 100, 101], { second: 100 }), 7 * SECOND);
    expect(measured.afterBackup).toBe(1);
    expect(measured.holes).toEqual([]);
    expect(measured.rpo).toEqual({ value: 2, unit: "s" });
  });

  it("gives no excess to a control: its age is not the age of a write", () => {
    const measured = recoveryOf({ ...DRILL, quiet: true }, runOf([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]), 20 * SECOND);
    expect(measured.afterBackup).toBe(0);
    expect(measured.excess).toBeNull();
    expect(measured.rpo).toEqual({ value: 15, unit: "s" });
  });

  it("reads only the data of the tenants after an election", () => {
    const measured = recoveryOf({ ...DRILL, recovery: "election" }, runOf([1, 2], [1, 2], { backups: [], after: "other" }), SECOND);
    expect(measured).toEqual({ rpo: null, excess: null, holes: [], afterBackup: null, sameData: false });
  });

  it("does not know the data of a set that did not converge", () => {
    expect(recoveryOf(DRILL, runOf([1], [1], { after: null }), SECOND).sameData).toBeNull();
  });
});

describe("the findings of a drill", () => {
  const clean = { rpo: null, excess: null, holes: [], afterBackup: 3, sameData: true };

  it("finds nothing in a clean drill", () => {
    expect(recoveryFindings(clean, WRITES)).toEqual([]);
  });

  it("finds each broken rule", () => {
    expect(recoveryFindings({ ...clean, sameData: false }, WRITES)[0]).toContain("changed");
    expect(recoveryFindings({ ...clean, sameData: null }, WRITES)[0]).toContain("did not converge");
    expect(recoveryFindings({ ...clean, holes: [4] }, WRITES)[0]).toContain("at 4");
  });

  it("allows the writes in flight, and no more", () => {
    expect(recoveryFindings({ ...clean, afterBackup: 3 + LOSS_MARGIN }, WRITES)).toEqual([]);
    expect(recoveryFindings({ ...clean, afterBackup: 3 + LOSS_MARGIN + 1 }, WRITES)[0]).toContain("came after the last backup");
  });
});
