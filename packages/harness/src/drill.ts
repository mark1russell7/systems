import { valueIn } from "@mark1russell7/quantity";
import type { Cell, Drill, DrillRoom, ProbeEvent, Run, RunBackup } from "./cell.ts";
import type { GroupClient, Stamp } from "./group.ts";
import { deadlineOf } from "./group.ts";
import type { OplogTime } from "./recovery.ts";
import {
  HASH_SCRIPT,
  hashOf,
  highestHeld,
  memAvailableOf,
  readOplog,
  roomNeeded,
  roomVoidOf,
  seedScript,
  sliceQuery,
  standaloneCommand,
  stopScript,
} from "./recovery.ts";
import type { ReplicaSetLab } from "./replset.ts";
import { STEADY, TAIL_MS, clockOffsetOf, droppedSoFar, initiateScript, onMonotonic, replicaSetArgs, sleep, waitFor } from "./replset.ts";

/**
 * This module does one run of a recovery drill on the lab of a replica set. A drill stops the store
 * during writes, removes its disk, and recovers from real backups, or by an election.
 *
 * A backup is a real `mongodump`, on a host of its own. The dump has the oplog of its own time, and
 * each slice has the oplog after the backup before it. The fault comes at the age of the newest
 * backup, on the clock of the VM. Thus a run measures the worst case of its interval by construction.
 *
 * A restore cannot have a client of the set: the client writes to any primary. So the restore writes
 * to a server with no set, on its own port. That server then stops, each member starts with an empty
 * set, and the old primary starts the set. Only that member has the data, thus it wins.
 *
 * The driver refuses a primary with an election id under the highest one that it saw, and a new
 * set starts its ids again. So a restore has two clients. The first one writes up to the fault, and
 * the second one starts after the restore, with the sequence numbers that follow the first.
 */

/** This folder is the store of the backups, on the backup host. */
const VAULT = "/backup";
/** This time is the longest wait for a server to answer, in ms. */
const STARTS_WITHIN = 60_000;

/** This function waits until a check holds, or it stops the run after `within` ms. */
const until = async (what: string, check: () => Promise<boolean>, within: number): Promise<void> => {
  const started = Date.now();
  while (!(await check().catch(() => false))) {
    if (Date.now() - started > within) throw new Error(`${what} did not come in ${within} ms`);
    await sleep(500);
  }
};

/** This function gives the time that the client sent a write. Zero is no write. */
const writeOf = (events: readonly ProbeEvent[], n: number): RunBackup["last"] => {
  const sent = n === 0 ? undefined : events.find((event) => event.ev === "sent" && Number(event["n"]) === n);
  return sent === undefined ? null : { n, t: sent.t };
};

/** This function gives the size of a folder of the backup host. */
const sizeOf = async (lab: ReplicaSetLab, path: string): Promise<RunBackup["size"]> => {
  const [bytes] = (await lab.vault(["du", "-sb", path])).split(/\s+/);
  return { value: Number(bytes), unit: "B" };
};

/**
 * This function reads the room of the runner before the seed. Each container writes to the same disk
 * of the runner, thus the free disk of the backup host is the free disk of the lab. The seed first
 * removes the data of the run before, thus the files of the members count as room too.
 */
const roomOf = async (lab: ReplicaSetLab, drill: Drill): Promise<DrillRoom> => {
  const [free] = (await lab.vault(["df", "-B1", "--output=avail", VAULT])).trim().split("\n").slice(-1);
  let held = 0;
  for (const name of lab.set.members) held += Number((await lab.exec(name, ["du", "-sb", "/data/db"])).split(/\s+/)[0]);
  const disk = { value: Number(free) + held, unit: "B" } as const;
  if (!Number.isFinite(disk.value)) throw new Error(`no free disk in the output of df: ${free}`);
  return { disk, memory: memAvailableOf(await lab.vault(["cat", "/proc/meminfo"])), need: roomNeeded(drill, lab.set.members.length, disk) };
};

/** This function takes the dump with its oplog, and each slice of the oplog at its interval. It gives each backup in sequence. */
const backupsOf = async (lab: ReplicaSetLab, drill: Drill, primary: string, writer: GroupClient): Promise<RunBackup[]> => {
  const host = `${lab.members[primary]!.ip}:${lab.set.port}`;
  const started = Date.now();
  await lab.vault(["mongodump", "--host", host, "--oplog", "--out", `${VAULT}/dump-0`]);
  const ended = Date.now();
  const oplog = readOplog(await lab.vault(["bsondump", "--quiet", `${VAULT}/dump-0/oplog.bson`]));
  const held = highestHeld(await lab.vault(["bsondump", "--quiet", `${VAULT}/dump-0/cells/w.bson`]));
  if (oplog.last === null) throw new Error("the oplog of the dump has no entry");
  let highest = Math.max(oplog.highest ?? 0, held ?? 0);
  let from: OplogTime = oplog.last;
  const backups: RunBackup[] = [{ kind: "dump", started, ended, last: writeOf(writer.events, highest), size: await sizeOf(lab, `${VAULT}/dump-0`) }];
  const every = valueIn(drill.sliceEvery, "s") * 1_000;
  for (let slice = 1; slice <= drill.slices; slice += 1) {
    await sleep(Math.max(0, ended + slice * every - Date.now()));
    const out = `${VAULT}/slice-${slice}`;
    const begun = Date.now();
    await lab.vault(["mongodump", "--host", host, "--db", "local", "--collection", "oplog.rs", "--query", sliceQuery(from), "--out", out]);
    const finished = Date.now();
    const read = readOplog(await lab.vault(["bsondump", "--quiet", `${out}/local/oplog.rs.bson`]));
    highest = Math.max(highest, read.highest ?? 0);
    from = read.last ?? from;
    backups.push({ kind: "slice", started: begun, ended: finished, last: writeOf(writer.events, highest), size: await sizeOf(lab, out) });
  }
  return backups;
};

/**
 * This function stops the server of each member that the drill loses, and it removes each disk. A
 * restore loses each member, and an election loses the primary. The fault comes at the age of the
 * drill after the last write of the newest backup. A control has no later write, and an election
 * has no backup: their age counts from this point. The stamp is the one of the primary.
 */
const lose = async (lab: ReplicaSetLab, drill: Drill, primary: string, last: RunBackup["last"]): Promise<Stamp> => {
  const parts = drill.recovery === "restore" ? [primary, ...lab.set.members.filter((name) => name !== primary)] : [primary];
  const age = valueIn(drill.age, "s");
  const at = last === null || drill.quiet === true ? undefined : last.t + age * 1e9;
  if (at === undefined) await sleep(age * 1_000);
  const stamps = await Promise.all(parts.map((part) => lab.signal(part, "KILL", at)));
  for (const part of parts) {
    await lab.exec(part, ["sh", "-c", stopScript(false)]);
    await lab.exec(part, ["find", "/data/db", "-mindepth", "1", "-delete"]);
  }
  return stamps[0]!;
};

/**
 * This function restores the old primary from the backups and starts the set again:
 * - The slices go after the oplog of the dump, in their sequence, thus one replay does the whole restore.
 * - The restore writes to a server of the old primary with no set, on its own port.
 * - Each member that lost its disk starts before the set, because `rs.initiate` asks each member.
 * - The old primary starts the set. It has the data, and the other members make their first sync from it.
 */
const restore = async (lab: ReplicaSetLab, drill: Drill, primary: string): Promise<{ started: number; ended: number }> => {
  const { set } = lab;
  const started = Date.now();
  const port = set.port + 1;
  const slices = Array.from({ length: drill.slices }, (_, at) => `${VAULT}/slice-${at + 1}/local/oplog.rs.bson`);
  if (slices.length > 0) await lab.vault(["sh", "-c", `cat ${slices.join(" ")} >> ${VAULT}/dump-0/oplog.bson`]);
  await lab.exec(primary, ["sh", "-c", `${standaloneCommand(set, port)} > /proc/1/fd/1 2>&1 & echo $! > /tmp/server.pid`]);
  await until("the server of the restore", async () => (await lab.script(primary, "print(db.hello().ok)", port)).includes("1"), STARTS_WITHIN);
  await lab.vault(["mongorestore", "--host", `${lab.members[primary]!.ip}:${port}`, "--oplogReplay", `${VAULT}/dump-0`]);
  await lab.exec(primary, ["sh", "-c", stopScript(true)]);
  for (const name of set.members) if (name !== primary) await lab.restart(name);
  await lab.restart(primary);
  const ips = Object.fromEntries(Object.entries(lab.members).map(([name, at]) => [name, at.ip]));
  const initiated = await lab.script(primary, initiateScript(set, ips));
  if (!initiated.includes('"ok":1')) throw new Error(`rs.initiate failed after the restore: ${initiated}`);
  await until("the primary after the restore", async () => (await lab.script(primary, "print(db.hello().isWritablePrimary)")).includes("true"), STARTS_WITHIN);
  return { started, ended: Date.now() };
};

/**
 * This function does one run of a recovery drill:
 * - The set converges, and it loses its writes. The tenants get their data, and a hash reads it.
 * - The client writes until its stream is steady. A control stops it here.
 * - The backups go, each at its interval. The fault comes at the age of the newest backup.
 * - An election continues the same client. A restore stops the client, and it starts a second one.
 * - The set converges again. The writes that it then holds tell which writes it kept, and a second
 *   hash tells if the tenants have the same data.
 */
export const drillOnce = async (lab: ReplicaSetLab, cell: Cell, environment: number, index: number): Promise<Run> => {
  const drill = cell.drill!;
  const { set } = lab;
  const primary = await lab.converge();
  await lab.flush(primary);
  await lab.unfreeze(primary);
  await lab.forget();
  await lab.vault(["sh", "-c", `rm -rf ${VAULT} && mkdir -p ${VAULT}`]);
  const tool = (await lab.vault(["mongodump", "--version"])).split("\n")[0]!.trim();
  const room = await roomOf(lab, drill);
  // a drill with no room does no seed: its run is void, and its record tells the room (roomVoidOf)
  if (roomVoidOf(room) !== null)
    return {
      environment,
      index,
      events: [],
      fault: null,
      kernel: [],
      netns: lab.netns.client,
      targetNetns: lab.members[primary]!.netns,
      lost: 0,
      group: {
        members: lab.members,
        sentinels: {},
        primary,
        at: primary,
        timeline: [],
        after: primary,
        holds: null,
        drill: { tool, seed: "generated", backups: [], before: "", after: null, restored: null, second: null, room },
      },
    };
  const seeded = await lab.script(primary, seedScript(drill, set.members.length));
  if (!seeded.includes('"ok":true')) throw new Error(`the seed failed: ${seeded}`);
  const before = hashOf(await lab.script(primary, HASH_SCRIPT));
  const from = lab.kernel.length;
  const logFrom = lab.log.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const writer = await lab.client(replicaSetArgs(cell, lab.members));
  const restores = drill.recovery === "restore";
  let successor: GroupClient | null = null;
  let second: number | null = null;
  let fault: Run["fault"] = null;
  let restored: { started: number; ended: number } | null = null;
  const backups: RunBackup[] = [];
  try {
    await writer.until(["ready"], 60_000);
    const steady = await waitFor(writer, (event) => event.ev === "ack" && Number(event["n"]) >= STEADY, 30_000);
    if (steady === undefined) throw new Error(`the client did not write ${STEADY} times in 30 s`);
    if (drill.quiet === true) await writer.stop();
    if (restores) backups.push(...(await backupsOf(lab, drill, primary, writer)));
    const stamp = await lose(lab, drill, primary, backups.at(-1)?.last ?? null);
    fault = stamp;
    if (restores) {
      await writer.stop();
      restored = await restore(lab, drill, primary);
      second = Math.max(0, ...writer.events.filter((event) => event.ev === "sent").map((event) => Number(event["n"]))) + 1;
      successor = await lab.client([...replicaSetArgs(cell, lab.members), "--from", String(second)]);
      const answered = await waitFor(successor, (event) => event.ev === "ack", deadlineOf(cell));
      if (answered !== undefined) await sleep(TAIL_MS);
    } else {
      const old = `${lab.members[primary]!.ip}:${set.port}`;
      const sentAt = (n: number): number => writer.events.find((event) => event.ev === "sent" && Number(event["n"]) === n)?.t ?? -Infinity;
      const answered = await waitFor(
        writer,
        (event) => event.ev === "ack" && sentAt(Number(event["n"])) > stamp.t1 && typeof event["at"] === "string" && event["at"] !== old,
        deadlineOf(cell),
      );
      if (answered !== undefined) await sleep(TAIL_MS);
      await lab.restart(primary);
    }
  } finally {
    await writer.stop();
    await successor?.stop();
  }
  const settled = await lab.settle();
  const lost = settled === null ? null : settled - lostBefore;
  const after = await lab.converge().catch(() => null);
  const holds = after === null ? null : await lab.holds(after);
  const hash = after === null ? null : hashOf(await lab.script(after, HASH_SCRIPT));
  const events = [...writer.events, ...(successor?.events ?? [])].sort((a, b) => a.t - b.t);
  return {
    environment,
    index,
    events,
    fault,
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.members[primary]!.netns,
    lost,
    group: {
      members: lab.members,
      sentinels: {},
      primary,
      at: primary,
      timeline: onMonotonic(lab.log.slice(logFrom), clockOffsetOf(events)),
      after,
      holds,
      drill: { tool, seed: "generated", backups, before, after: hash, restored, second, room },
    },
  };
};
