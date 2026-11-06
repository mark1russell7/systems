import { fileURLToPath } from "node:url";
import type { Cell, LineCount, Prediction, Target } from "@mark1russell7/harness";
import { ms, s } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";

/**
 * This module holds the lease cells of etcd (SYS-73): when does a lock holder lose its lease? The
 * subject is etcd v3.6.15 and `etcdctl lock`, thus each client is clientv3 and its concurrency
 * recipe. The stale write is T13 of the plan.
 *
 * The law comes from the source at the tag v3.6.15. Each term cites its file and line. The Jepsen
 * analysis of etcd 3.4.3 gives two claims on locks. A lease does not make a lock safe. The revision
 * of the lock key is a fencing token.
 *
 * The TTL has a floor:
 * - The floor is `(3 * ElectionTicks) / 2` heartbeats, rounded up to whole seconds
 *   (server/etcdserver/server.go:353, :358). The defaults are a tick of 100 ms and an election of
 *   1 s (server/embed/config.go:671-672, :1497). Thus the floor is 15 ticks, 1.5 s, then 2 s.
 * - A request below the floor gets the floor (server/lease/lessor.go:301-303), and the response
 *   gives that TTL (server/etcdserver/apply/apply.go:189-198).
 *
 * The end of a lease is a band, not a time:
 * - The primary sets the expiry to the grant or the renewal plus the TTL (lessor.go:305-309, :449,
 *   server/lease/lease.go:84-89). The test is strict (lessor.go:714).
 * - The loop looks for expired leases each 500 ms (lessor.go:620-636). It sends the revoke through
 *   raft (server.go:869-896), and the revoke deletes the keys in one transaction (lessor.go:343-351).
 * - Thus the end comes at least one TTL after the last renewal, and at most 500 ms later. The time
 *   of raft and of the watch adds to that. This time has no source, and `SLACK` holds it.
 *
 * The client gives the gap between two renewals:
 * - The first keepalive goes at once (client/v3/lease.go:297). The next one is due TTL/3 after a
 *   response (lease.go:542), and the send loop looks each 500 ms (lease.go:86, :609-610).
 * - Thus a gap is at most TTL/3 + 500 ms. A stop can come at any point in the gap, thus a stopped
 *   client that had renewed can lose the lease before one whole TTL.
 * - With a TTL of 3 s the keepalive of 1 s falls between two looks, thus the period is 1.5 s.
 *
 * A leader promotion resets the time:
 * - A member that starts again holds each lease with no expiry (lessor.go:815-829).
 * - At the first entry of a term the server promotes the lessor with the election timeout
 *   (server.go:1963-1973, server/config/config.go:334-335). Each lease then gets its whole TTL plus
 *   1 s (lessor.go:480-492). Checkpoints do not change this below 300 s (lessor.go:52, :758).
 *
 * The lock is the oldest key of a prefix:
 * - The key is the prefix and the lease of the session (client/v3/concurrency/mutex.go:115). The
 *   session keeps the lease alive (client/v3/concurrency/session.go:50, :58, :73).
 * - A waiter watches the deletion of the older keys (mutex.go:89), then it reads its own key
 *   (mutex.go:97-105). A lost key gives `ErrSessionExpired`, the fix of the Jepsen bug.
 *
 * `etcdctl lock NAME -- command` is the frozen holder of these cells:
 * - It starts the command with `ETCD_LOCK_KEY` and `ETCD_LOCK_REV`
 *   (etcdctl/ctlv3/command/lock_command.go:95-105, :125-130).
 * - It does not look at the session while the command operates (lock_command.go:99), thus the
 *   command gets no sign of the loss. Unlock deletes a missing key with no error (mutex.go:144),
 *   thus a holder that lost its lease ends with code 0.
 * - A stop of its process group stops the keepalive and the critical section together.
 *
 * Fencing is a compare in the transaction of the write:
 * - `c("KEY") = "REV"` compares the creation revision of the lock key
 *   (etcdctl/ctlv3/command/txn_command.go:179-231). A missing key has creation revision 0
 *   (server/etcdserver/txn/txn.go:581-587), thus a stale holder fails with no contender also.
 * - A failed compare is no error of etcdctl (txn_command.go:84-89), and it moves no revision
 *   (txn.go:319-323).
 * - `ETCD_LOCK_REV` is the header of the response. With no wait this is the creation revision
 *   (mutex.go:82-84). After a wait it is the header of the last read, the head (mutex.go:106). Thus
 *   a holder that waited and fences with `ETCD_LOCK_REV` fails on its own key. Only the creation
 *   revision of the key is the token (mutex.go:152-154).
 *
 * The store has no other writer, thus each revision is exact. Each scenario counts them from the
 * head at its start.
 */

/** This folder is the build context of the target: its Dockerfile and its program. */
const CONTEXT = fileURLToPath(new URL("../targets/etcd-lease/", import.meta.url));

/** These are the files of the build context. */
const FILES = ["Dockerfile", "lease.ts"];

/** This port is the port of the program of the target. */
const PORT = 8080;

/** This count is the runs of a cell of SYS-73, as for the other count cells. */
const LEASE_RUNS = 4;

/** This time is the tick of etcd in ms (`TickMs`, server/embed/config.go:671). */
const TICK = 100;

/** This time is the election timeout of etcd in ms (`ElectionMs`, server/embed/config.go:672). */
export const ELECTION = 1_000;

/** This time is the period of the expiry loop in ms (server/lease/lessor.go:623). */
export const LOOP = 500;

/** This time is the period of the send loop of a keepalive in ms (`retryConnWait`, client/v3/lease.go:86). */
export const SEND = 500;

/** This time is the margin for raft, the watch and the pipes in ms. It has no source: it is a choice of the cell. */
export const SLACK = 300;

/** This count is the TTL of each cell with a client, in seconds. */
const TTL = 3;

/** This function gives the floor of a TTL in seconds (server/etcdserver/server.go:353, :358). */
export const floorOf = (): number => Math.ceil((Math.floor((3 * (ELECTION / TICK)) / 2) * TICK) / 1_000);

/** This function gives the TTL that a request gets in seconds. */
export const grantedOf = (ttl: number): number => Math.max(ttl, floorOf());

/** This function gives the longest gap of two renewals of a TTL in ms. */
export const gapOf = (ttl: number): number => (ttl * 1_000) / 3 + SEND;

/** A band gives the time of the end of a lease in ms, from the marks of its scenario. */
export interface Band {
  readonly low: number;
  readonly high: number;
}

/** A bare scenario grants a lease and writes one key on it, with no client. With `restart`, the member starts again that many ms later. */
export interface Bare {
  readonly kind: "bare";
  readonly ttl: number;
  readonly restart: number | null;
}

/** This type is the fence of a write: none, or the compare with a revision. */
export type Write = "none" | "plain" | "fenced";

/**
 * A hold has a holder that sleeps for `work` seconds in its section, then does its write. With
 * `frozen`, the program stops it `hold` ms after its lock. A contender comes after the stop, or
 * after the lock of a live holder, and it does its own write when it gets the lock.
 */
export interface Hold {
  readonly kind: "hold";
  readonly ttl: number;
  readonly hold: number;
  readonly work: number;
  readonly frozen: boolean;
  readonly contender: Write;
  readonly write: Write;
}

/** A waiter queues behind a live holder and stops. The holder ends after `work` seconds, and the waiter then starts again. */
export interface Waiter {
  readonly kind: "waiter";
  readonly ttl: number;
  readonly work: number;
}

/** A scenario is what the program of the target does for the logical request. */
export type Scenario = Bare | Hold | Waiter;

/** This function gives the band of a scenario. A mark is its first or its last sure time, thus only a stop after renewals gets the gap. */
export const bandOf = (spec: Scenario): Band => {
  const ttl = grantedOf(spec.ttl) * 1_000;
  const extra = spec.kind === "bare" && spec.restart !== null ? ELECTION : 0;
  const high = ttl + extra + LOOP + SLACK;
  if (spec.kind === "hold" && spec.hold > 0) return { low: ttl - gapOf(spec.ttl) - SLACK, high };
  return { low: ttl + extra, high };
};

/** A seat is a client with the revision of one of its lines, less the base of the scenario. */
export interface Seat {
  readonly who: string;
  readonly rev: number;
}

/** A written value is a client, the fence of its write, and its result. The token `create` is the true creation revision of the key. */
export interface Written extends Seat {
  readonly token: "none" | "lock" | "create";
  readonly applied: boolean;
}

/** An exit is the end of a client that goes on to its own end. */
export interface Exit {
  readonly who: string;
  readonly code: number;
  readonly expired: boolean;
}

/** The law of a scenario is each line that the program prints, with its exact count and revisions. */
export interface LeaseLaw {
  readonly granted: number | null;
  readonly locks: readonly Seat[];
  readonly queued: Seat | null;
  readonly ends: readonly Seat[];
  readonly deleted: number;
  readonly writes: readonly Written[];
  readonly exits: readonly Exit[];
  readonly value: Seat | null;
  readonly head: number;
}

/** This law is the empty start of the other laws. */
const NOTHING: LeaseLaw = { granted: null, locks: [], queued: null, ends: [], deleted: 0, writes: [], exits: [], value: null, head: 0 };

/** This function gives the law of a scenario `bare`: its put, then its end. */
const bareLaw = (spec: Bare): LeaseLaw => ({ ...NOTHING, granted: grantedOf(spec.ttl), ends: [{ who: "bare", rev: 2 }], deleted: 1, head: 2 });

/** This function gives the one write of a client at the next revision: a live fence holds, and `stale` fails it. */
const writeOf = (who: string, write: Write, top: number, stale: boolean): readonly Written[] => {
  if (write === "none") return [];
  if (write === "plain") return [{ who, token: "none", applied: true, rev: top + 1 }];
  return [{ who, token: "lock", applied: !stale, rev: stale ? top : top + 1 }];
};

/** This function gives the value and the head of a law from its writes. */
const finalOf = (writes: readonly Written[], top: number): Pick<LeaseLaw, "value" | "head"> => {
  const last = writes.filter((each) => each.applied).at(-1);
  return last === undefined ? { value: null, head: top } : { value: { who: last.who, rev: last.rev }, head: last.rev };
};

/** This function gives the law of a holder that stays alive: no lease ends, and the contender stays in the queue. */
const liveLaw = (spec: Hold): LeaseLaw => {
  const queued = spec.contender === "none" ? null : { who: "contender", rev: 2 };
  const writes = writeOf("holder", spec.write, queued === null ? 1 : 2, false);
  return { ...NOTHING, locks: [{ who: "holder", rev: 1 }], queued, writes, ...finalOf(writes, queued === null ? 1 : 2) };
};

/**
 * This function gives the writes of a contender. A contender waited, thus its `ETCD_LOCK_REV` is the
 * head and not its creation revision. Its fence with that number fails, and the true one holds.
 */
const contenderWrites = (write: Write, end: number): readonly Written[] => {
  if (write !== "fenced") return writeOf("contender", write, end, false);
  return [
    { who: "contender", token: "lock", applied: false, rev: end },
    { who: "contender", token: "create", applied: true, rev: end + 1 },
  ];
};

/** This function gives the law of a frozen holder. Revision 1 is its lock, and the end of its lease comes after the key of a contender. */
const frozenLaw = (spec: Hold): LeaseLaw => {
  const rival = spec.contender !== "none";
  const end = rival ? 3 : 2;
  const before = contenderWrites(spec.contender, end);
  const top = before.length === 0 ? end : end + 1;
  const writes = [...before, ...writeOf("holder", spec.write, top, true)];
  return {
    ...NOTHING,
    locks: [{ who: "holder", rev: 1 }, ...(rival ? [{ who: "contender", rev: end }] : [])],
    queued: rival ? { who: "contender", rev: 2 } : null,
    ends: [{ who: "holder", rev: end }],
    deleted: 1,
    writes,
    exits: [{ who: "holder", code: 0, expired: false }],
    ...finalOf(writes, top),
  };
};

/** This function gives the law of a waiter: its lease ends in the queue, the holder ends, and the waiter gets `ErrSessionExpired`. */
const waiterLaw = (): LeaseLaw => ({
  ...NOTHING,
  locks: [{ who: "holder", rev: 1 }],
  queued: { who: "waiter", rev: 2 },
  ends: [{ who: "waiter", rev: 3 }],
  deleted: 2,
  exits: [
    { who: "holder", code: 0, expired: false },
    { who: "waiter", code: 1, expired: true },
  ],
  head: 4,
});

/** This function gives the law of a scenario. */
export const lawOf = (spec: Scenario): LeaseLaw => {
  if (spec.kind === "bare") return bareLaw(spec);
  if (spec.kind === "waiter") return waiterLaw();
  return spec.frozen ? frozenLaw(spec) : liveLaw(spec);
};

/** This function gives the target of a scenario, with the scenario and its band as its argument. */
export const leaseTarget = (spec: Scenario): Target => ({
  image: NODE_IMAGE,
  subject: { kind: "build", name: "etcd-lease", context: CONTEXT, files: FILES },
  port: PORT,
  ready: '"ev":"listening"',
  lines: true,
  command: ["node", "/srv/lease.ts", "--port", String(PORT), "--scenario", JSON.stringify({ ...spec, ...bandOf(spec) })],
});

/** This function gives the count of each line of a law with its fields. It also gives a total for each kind, thus an extra line is a finding. */
export const countsOf = (spec: Scenario): readonly LineCount[] => {
  const law = lawOf(spec);
  const final = law.value === null ? { head: law.head } : { head: law.head, value: law.value.who, rev: law.value.rev };
  return [
    ...(law.granted === null ? [] : [{ what: "the TTL of the grant", match: { ev: "granted", where: { ttl: law.granted } }, count: 1 }]),
    ...law.locks.map(({ who, rev }) => ({ what: `the lock of the ${who}`, match: { ev: "locked", where: { who, rev, after: true } }, count: 1 })),
    { what: "the locks", match: { ev: "locked" }, count: law.locks.length },
    ...(law.queued === null ? [] : [{ what: "the key in the queue", match: { ev: "queued", where: { who: law.queued.who, rev: law.queued.rev } }, count: 1 }]),
    ...law.ends.map(({ who, rev }) => ({ what: `the end of the lease of the ${who}, in its band`, match: { ev: "lease-end", where: { who, rev, within: true } }, count: 1 })),
    { what: "the ends of a lease", match: { ev: "lease-end" }, count: law.ends.length },
    { what: "the deleted keys", match: { ev: "deleted" }, count: law.deleted },
    ...law.writes.map(({ who, token, applied, rev }) => ({ what: `the write of the ${who} with the token ${token}`, match: { ev: "write", where: { who, token, applied, rev } }, count: 1 })),
    { what: "the writes", match: { ev: "write" }, count: law.writes.length },
    ...law.exits.map(({ who, code, expired }) => ({ what: `the exit of the ${who}`, match: { ev: "exit", where: { who, code, expired } }, count: 1 })),
    { what: "the exits", match: { ev: "exit" }, count: law.exits.length },
    { what: "the value and the head at the end", match: { ev: "final", where: final }, count: 1 },
    { what: "the scenarios that ended", match: { ev: "end", where: { reached: true } }, count: 1 },
  ];
};

/** A lease spec is one cell: its plan, its scenario, what it shows, and the longest time of a run in seconds. */
export interface LeaseSpec {
  readonly plan: string;
  readonly scenario: Scenario;
  readonly name: string;
  readonly window: number;
}

/** This time is the window of each cell, in seconds. */
const WINDOW = 60;

/** This time is the section of a holder that the program stops at its lock, in seconds. */
const SHORT_WORK = 2;

/** This time is the wait of a holder after its lock before the program stops it, in ms. It falls 1 s into a gap of 1.5 s, by the period above. */
const HOLD = 5_500;

/** This time is the section of a holder that the program stops after renewals, in seconds. */
const LONG_WORK = 8;

/** This time is the section of the live holder: three TTLs, in seconds. */
const LIVE_WORK = 3 * TTL;

/** This time is the section of the holder before a waiter that lost its lease, in seconds. */
const WAITER_WORK = 5;

/** This function gives a holder that the program stops at its lock. */
const frozen = (contender: Write, write: Write): Hold => ({ kind: "hold", ttl: TTL, hold: 0, work: SHORT_WORK, frozen: true, contender, write });

/** These are the specs of SYS-73. */
export const LEASE_SPECS: readonly LeaseSpec[] = [
  {
    plan: "EL.1",
    name: "a bare lease asks for a TTL of 1 s: it gets the floor of 2 s, and it ends in that band",
    scenario: { kind: "bare", ttl: 1, restart: null },
    window: WINDOW,
  },
  {
    plan: "EL.2",
    name: "a bare lease with a TTL of 3 s: the control of the floor, it ends in its band",
    scenario: { kind: "bare", ttl: TTL, restart: null },
    window: WINDOW,
  },
  {
    plan: "EL.3",
    name: "a bare lease, and the member starts again 1 s later: the promotion gives it a whole TTL plus 1 s",
    scenario: { kind: "bare", ttl: TTL, restart: 1_000 },
    window: WINDOW,
  },
  {
    plan: "EL.4",
    name: "a holder frozen at its lock: its lease ends in the band of the TTL and the expiry loop",
    scenario: frozen("none", "none"),
    window: WINDOW,
  },
  {
    plan: "EL.5",
    name: "a holder frozen after renewals: the band opens by the gap of two renewals",
    scenario: { kind: "hold", ttl: TTL, hold: HOLD, work: LONG_WORK, frozen: true, contender: "none", write: "none" },
    window: WINDOW,
  },
  {
    plan: "EL.6",
    name: "a live holder for three TTLs with a contender in the queue: the control, it keeps the lock and its fence holds",
    scenario: { kind: "hold", ttl: TTL, hold: 0, work: LIVE_WORK, frozen: false, contender: "plain", write: "fenced" },
    window: WINDOW,
  },
  {
    plan: "EL.7",
    name: "a frozen holder and a contender: the contender gets the lock only after the end of the lease",
    scenario: frozen("plain", "none"),
    window: WINDOW,
  },
  {
    plan: "EL.8",
    name: "the frozen holder thaws and writes with no fence: the stale write is applied after the write of the contender (T13)",
    scenario: frozen("plain", "plain"),
    window: WINDOW,
  },
  {
    plan: "EL.9",
    name: "the frozen holder thaws and writes with its lock revision as a fence: the compare fails, and the value stays",
    scenario: frozen("plain", "fenced"),
    window: WINDOW,
  },
  {
    plan: "EL.10",
    name: "a contender fences with ETCD_LOCK_REV: that number is the head and not the revision of its key, thus only the true revision holds",
    scenario: frozen("fenced", "none"),
    window: WINDOW,
  },
  {
    plan: "EL.11",
    name: "a frozen waiter loses its lease in the queue: at the release it gets the session error and no lock, the fix of the Jepsen bug",
    scenario: { kind: "waiter", ttl: TTL, work: WAITER_WORK },
    window: WINDOW,
  },
];

/** This function says a law in words, for the prediction. */
const wordsOf = (spec: Scenario): string => {
  const law = lawOf(spec);
  const { low, high } = bandOf(spec);
  const ends = law.ends.length === 0 ? "no lease ends" : `the lease ends from ${low} to ${high} ms after its marks`;
  return `${ends}, ${law.locks.length} locks, ${law.writes.filter((each) => each.applied).length} applied writes, head at ${law.head}. Only the time has a band: each revision is exact, because the store has no other writer`;
};

/** This function gives the prediction of a spec: the counts of its law. */
export const leasePrediction = (spec: LeaseSpec): Prediction => ({
  detects: null,
  window: s(spec.window),
  from: "request-sent",
  why: wordsOf(spec.scenario),
  counts: countsOf(spec.scenario),
});

/** This function gives the cell of a spec. */
export const leaseCell = (spec: LeaseSpec): Cell => ({
  name: `${spec.plan} etcd-3.6 lease, ${spec.name}`,
  target: leaseTarget(spec.scenario),
  sysctls: {},
  client: "undici",
  // the hold only names the logical request: the program answers it at the end of its scenario
  probe: { mode: "gap", keepalive: false, http: { method: "GET", gap: s(0), hold: ms(1), options: {} } },
  fault: "none",
  prediction: leasePrediction(spec),
  runs: LEASE_RUNS,
  environments: 2,
});

/** These are the cells of SYS-73. */
export const LEASE_CELLS: readonly Cell[] = LEASE_SPECS.map(leaseCell);
