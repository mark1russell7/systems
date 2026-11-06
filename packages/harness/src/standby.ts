import { valueIn } from "@mark1russell7/quantity";
import type { Cell, KernelRecord, Pair, Run } from "./cell.ts";
import { targetImageOf } from "./image.ts";
import type { Lab, Probe, Sibling } from "./lab.ts";

/**
 * This module is the second server of a pair (`Cell.pair`). The lab of the cell has the primary, the
 * topology in front of it, the injector and the prober. This module adds one standby on the network
 * of the primary, and it does one run:
 *
 * 1. The client writes a stream of sequence numbers through the topology.
 * 2. The fault cuts the primary from the standby, or from each peer. The cut stays to the end.
 * 3. At the end of the hold, the injector stops each process of the primary with SIGKILL.
 * 4. The harness promotes the standby, and reads what it holds.
 * 5. The harness starts the old primary, and reads what its crash recovery gives.
 *
 * The standby has no way to the WAL of the old primary, because the primary stops under the cut. A
 * promotion cannot be undone, thus each run has its own environment (`Cell.fresh`).
 */

/** This table holds one row for each write of the client. */
const TABLE = "writes";
/** This time bounds each wait of the setup of the pair, in ms. */
const SETUP_MS = 60_000;
/** This count is the acknowledged writes before the fault: the stream is steady. */
const STEADY = 20;
/** This time is the wait after the stop of the primary, in ms: each writer sends its last write in it. */
const LAST_WRITE_MS = 2_000;
/** This time bounds the wait for the last line of the client, in ms. */
const STOP_MS = 5_000;

/** This text is the line of the log of a standby that serves reads (src/backend/postmaster/postmaster.c:3740). */
export const STANDBY_READY: string = "database system is ready to accept read-only connections";
/** This text is the write of the client, with its sequence number. */
export const INSERT: string = `INSERT INTO ${TABLE} VALUES ($n)`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** This function gives the argv of one statement in psql, on the server in the same container. */
export const psql = (statement: string): string[] => ["psql", "-h", "127.0.0.1", "-U", "postgres", "-At", "-c", statement];

/** This function gives the command of a standby: a base backup of the primary, then the server in recovery. */
export const standbyCommand = (primary: string): string[] => [
  "sh",
  "-c",
  `chown postgres:postgres "$PGDATA"; chmod 0700 "$PGDATA"; until gosu postgres pg_basebackup -h ${primary} -U postgres -D "$PGDATA" -X stream -c fast -R; do gosu postgres sh -c 'rm -rf "$PGDATA"/*'; sleep 0.5; done; exec gosu postgres postgres`,
];

/** This command starts the old primary again, after the stop of each of its processes. Its crash recovery runs before the wait ends. */
export const RESTART: readonly string[] = ["sh", "-c", 'exec gosu postgres pg_ctl -D "$PGDATA" -l /tmp/restart.log -w -t 60 start'];

/** This function reads the output of a query for sequence numbers into a sorted list. */
export const numbersOf = (text: string): number[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map(Number)
    .sort((a, b) => a - b);

/** This function gives the arguments of the client of a run. */
export const pairArgs = (cell: Cell, lab: Pick<Lab, "targetIp" | "targetPort">): string[] => {
  const pair = cell.pair!;
  const hold = cell.hold === undefined ? 0 : valueIn(cell.hold, "s");
  return [
    lab.targetIp,
    String(lab.targetPort),
    "--mode",
    "stream",
    "--interval-ms",
    String(valueIn(pair.interval, "ms")),
    "--writers",
    String(pair.writers),
    "--query",
    INSERT,
    "--max-s",
    String(Math.ceil(hold) + 60),
    ...(cell.driverOptions === undefined ? [] : ["--options", JSON.stringify(cell.driverOptions)]),
  ];
};

/** This function gives the peers of the cut of a pair: the standby, or the standby and the peer of the primary in the topology. */
export const peersOf = (pair: Pair, standby: string, lab: Pick<Lab, "topology" | "clientIp">): string[] =>
  pair.cuts === "standby" ? [standby] : [standby, lab.topology?.targetPeer ?? lab.clientIp];

/** This function gives the instants of the cancels of a hold, in ns from the fault: equal parts of the hold. */
export const cancelsOf = (pair: Pair, holdNs: number): number[] => {
  const count = pair.cancels ?? 0;
  return Array.from({ length: count }, (_, at) => ((at + 1) * holdNs) / (count + 1));
};

/** This function asks until the primary reports the standby in a state of replication. */
const untilStreaming = async (lab: Lab, state: string): Promise<void> => {
  const started = Date.now();
  for (;;) {
    const seen = await lab.exec(psql("SELECT sync_state FROM pg_stat_replication WHERE state = 'streaming'"));
    if (seen === state) return;
    if (Date.now() - started > SETUP_MS) throw new Error(`the standby did not stream as ${state} in ${SETUP_MS} ms: it reports "${seen}"`);
    await sleep(100);
  }
};

/**
 * This function opens the pair of an environment. The table comes first and the standby next: the
 * base backup has it. A synchronous standby is named last, thus no setup step waits for it.
 */
export const openStandby = async (lab: Lab, cell: Cell): Promise<Sibling> => {
  const pair = cell.pair!;
  await lab.exec(["sh", "-c", 'echo "host replication all all trust" >> "$PGDATA/pg_hba.conf"']);
  await lab.exec(psql("SELECT pg_reload_conf()"));
  await lab.exec(psql(`CREATE TABLE ${TABLE} (n integer PRIMARY KEY)`));
  const standby = await lab.sibling(await targetImageOf(cell.target), standbyCommand(lab.serverIp), STANDBY_READY);
  await untilStreaming(lab, "async");
  if (pair.synchronous) {
    await lab.exec(psql("ALTER SYSTEM SET synchronous_standby_names = '*'"));
    await lab.exec(psql("SELECT pg_reload_conf()"));
    await untilStreaming(lab, "sync");
  }
  return standby;
};

/** This function waits for a count of acknowledged writes. */
const untilSteady = async (probe: Probe): Promise<void> => {
  const started = Date.now();
  while (probe.events.filter((event) => event.ev === "ack").length < STEADY) {
    if (Date.now() - started > SETUP_MS) throw new Error(`the client did not write ${STEADY} times in ${SETUP_MS} ms`);
    await sleep(10);
  }
};

/** This function gives the count of lost records in the latest clock line of the prober. */
const droppedSoFar = (records: readonly KernelRecord[]): number => {
  for (let at = records.length - 1; at >= 0; at -= 1)
    if (records[at]!.ev === "clock") return Number(records[at]!["lost"] ?? 0);
  return 0;
};

/**
 * This function does one run of a pair. A dry run writes and stops, with no fault: the warm-up of the
 * environment. It removes its rows, thus the numbers of the run start on an empty table.
 */
export const pairOnce = async (lab: Lab, standby: Sibling, cell: Cell, environment: number, index: number, dry = false): Promise<Run> => {
  const pair = cell.pair!;
  await lab.forget();
  const from = lab.kernel.length;
  const lostBefore = droppedSoFar(lab.kernel);
  const probe = await lab.probe(pairArgs(cell, lab));
  const holdNs = cell.hold === undefined ? 0 : valueIn(cell.hold, "s") * 1e9;
  let fault: Run["fault"] = null;
  let heal: Run["heal"] = null;
  try {
    await probe.until(["ready"], 15_000);
    await untilSteady(probe);
    if (!dry) {
      fault = await lab.fault("blackhole", "target", { peers: peersOf(pair, standby.ip, lab) });
      const started = Date.now();
      for (const at of cancelsOf(pair, holdNs)) {
        await sleep(Math.max(0, at / 1e6 - (Date.now() - started)));
        await lab.exec(psql("SELECT count(pg_cancel_backend(pid)) FROM pg_stat_activity WHERE wait_event = 'SyncRep'"));
      }
      heal = await lab.signal("KILL", fault.t0 + holdNs);
      await sleep(LAST_WRITE_MS);
      // the injector lists its processes before its wait: a backend that started in the wait is here
      if (cell.target.kill !== undefined) await lab.exec(cell.target.kill);
    }
    // a client whose writers each failed is gone already, and its done line tells it
    await probe.go().catch(() => undefined);
    await probe.until(["done"], STOP_MS);
  } finally {
    await probe.stop();
  }
  if (dry) await lab.exec(psql(`TRUNCATE ${TABLE}`));
  const settled = await lab.settle();
  const lost = settled === null ? null : settled - lostBefore;
  const read = `SELECT n FROM ${TABLE} ORDER BY n`;
  let holds: readonly number[] | null = null;
  let oldHolds: readonly number[] = [];
  if (!dry) {
    await standby.exec(psql("SELECT pg_promote(true, 60)"));
    holds = numbersOf(await standby.exec(psql(read)));
    await lab.exec([...RESTART]);
    oldHolds = numbersOf(await lab.exec(psql(read)));
  }
  return {
    environment,
    index,
    events: [...probe.events],
    fault,
    ...(heal === null ? {} : { heal }),
    kernel: lab.kernel.slice(from),
    netns: lab.netns.client,
    targetNetns: lab.netns.target,
    lost,
    ...(lab.topology === null ? {} : { topology: lab.topology, middlebox: [] }),
    group: {
      members: { primary: { ip: lab.serverIp, netns: lab.netns.target }, standby: { ip: standby.ip, netns: standby.netns } },
      sentinels: {},
      primary: "primary",
      at: "primary",
      timeline: [],
      after: dry ? "primary" : "standby",
      holds,
      oldHolds,
    },
  };
};
