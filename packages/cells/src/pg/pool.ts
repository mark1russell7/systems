import { timerOf, transitionOn } from "@mark1russell7/automata";
import type { Cell, DriverStep, LineMatch, Prediction } from "@mark1russell7/harness";
import { HIKARICP_PGJDBC } from "@mark1russell7/machines";
import { RTT_MS, given, ms, s, seconds } from "../catalog.ts";
import type { Span } from "../mongo/model.ts";
import { span } from "../mongo/model.ts";
import { hikariCell, hikariValues } from "./hikari.ts";
import { PG_RTT_MS } from "./t01.ts";
import { PGBOUNCER_LATENCY, pgbouncerFirst, pgbouncerHop } from "./t10.ts";

/**
 * The cells of a pool at its limit (Q19 of S3, SYS-65). A real HikariCP 7.1.0 over pgjdbc 42.7.13
 * has a fixed size, and a burst of slow statements goes above that size.
 *
 * The law comes from the source at the tag HikariCP-7.1.0, in src/main/java/com/zaxxer/hikari:
 * - A pool of a fixed size does not grow (HikariConfig.java:56, :120, :1137-1139). A borrow with no
 *   idle connection waits in the bag (util/ConcurrentBag.java:175-199).
 * - The bag gives each returned connection through a fair SynchronousQueue, the oldest wait first
 *   (ConcurrentBag.java:144, :192, :221-222). A query starts when the query `size` places before
 *   it ends. Thus the wait grows by one hold for each `size` places of the queue.
 * - One timeout bounds the whole borrow (pool/HikariPool.java:152-193). At its end, the borrow fails
 *   with SQLTransientConnectionException (:183-184, :700-721). It leaves the queue, and the next
 *   query gets the next connection. A failed borrow has no SQLState, as no creation failed.
 * - A return has no round trip at autocommit (pool/ProxyConnection.java:249-258, and
 *   PgConnection.java:940-947 of pgjdbc 42.7.13). A connection that a query returned has no check
 *   (:165-166). Only the first queries can take the check of a connection that was idle for 500 ms.
 *
 * The burst has one query each 50 ms, thus the order of the queue is the order of the numbers. Each
 * query starts on its own thread, and the pool has each connection idle before the first one.
 *
 * Q19.pool.6 to Q19.pool.10 are the PgBouncer half. HikariCP has one connection for each query, and
 * PgBouncer 1.26.1 in transaction pooling has the queue. The law comes from the source at the tag
 * pgbouncer_1_26_1:
 * - A pool has at most `default_pool_size` servers (src/main.c:284, src/server.c:294-303,
 *   src/objects.c:1927-1955). A query with no server waits in `waiting_client_list`, and the first
 *   client gets the server of each release at once (src/objects.c:805-817, :994-1014, :1314-1316).
 *   Thus the queue has the same law as the bag of HikariCP, with the servers as its size.
 * - In transaction pooling, a server goes back to the pool at the ReadyForQuery of the query, with
 *   the status I (src/server.c:433-448, :861-921).
 * - The pool opens a server only for a waiting client, and one at a time (src/janitor.c:166-169,
 *   src/objects.c:1884-1887). The first use of a server can thus add a login, or the check of a
 *   server that was idle for 30 s. The term `SERVER_LOGIN_MS` bounds both, on each server but the
 *   first. HikariCP opens its connections one by one, thus it keeps only one server busy.
 * - `query_wait_timeout` counts from the first packet of the query (src/client.c:1640-1643). The
 *   janitor tests it once in each pass of 333.333 ms (src/janitor.c:27-28, :313-347, :722-727). A
 *   late query ends with FATAL 08P01, and HikariCP evicts its connection, as class 08 is fatal to it
 *   (pool/ProxyConnection.java:151-186). Thus the counts of the pool at the end of such a burst are
 *   not a prediction. The refill can still be open.
 *
 * The check of HikariCP is the case that the law must name. A connection idle for more than
 * `aliveBypassWindowMs` (500 ms, pool/HikariPool.java:62) gets a check at its borrow (:160-181). The
 * check is the empty query of pgjdbc, in a Query message (PgConnection.java:1579-1621). In
 * PgBouncer it needs a server, and it joins the queue like a query (src/client.c:1465, :1655).
 * - Q19.pool.6 to Q19.pool.9 set the window to one hour with an option of the lab. No borrow has a
 *   check, thus they measure the queue alone.
 * - Q19.pool.10 keeps the default, and each connection is idle for longer than the window. The first
 *   release lets each queued check pass, one server step each. The query after each check then joins
 *   the queue at its end. Thus the wait of a query has two parts, and `query_wait_timeout` counts each
 *   part from zero. The same burst as Q19.pool.9 has no failure.
 *
 * In Q19.pool.10 the queued queries come back from their checks approximately one round trip apart.
 * That is less than the jitter of a thread, thus the order of those queries is not a prediction. The
 * band of each one is the whole set of the queued queries, and the end of the burst has the sharp band.
 * A failure in this cell is left out on purpose. A failed check is hidden: the borrow closes the
 * connection and tries the next one (pool/HikariPool.java:167-169). The law refuses such a spec.
 */

/** This time is the gap between two queries of a burst, in ms: longer than the jitter of a thread, so that the order holds. */
export const POOL_GAP_MS = 50;

/** This time is the period of the line `pool` of the client, in ms (ClientHikari.java, watchPool). */
const SAMPLE_MS = 5;

/** This time is the least distance of a wait from the timeout of its borrow, in seconds. A smaller distance is not a prediction. */
const MARGIN = 0.25;

/**
 * This time is the most that the first use of a server adds, in ms. It bounds a connect, a login, a
 * SET of the parameters of the client, or one check. It is an assumption of this file, not a value
 * of a source.
 */
export const SERVER_LOGIN_MS = 30;

/** This window turns off the check of a borrow, in ms: one hour, longer than each cell. It is a setting of the lab. */
const NO_CHECK_MS = 3_600_000;

/** This time is how long the pool stays idle before a burst with checks, in s. It is above the 500 ms of the window, after the pool has filled. */
const CHECK_IDLE_S = 2;

/**
 * This count of waiters is a real queue in HikariCP, behind a pooler. Each borrow counts as a waiter
 * for some microseconds (util/ConcurrentBag.java:175-199), and a sample can see that one. The
 * arrivals are 50 ms apart, thus only a real queue shows 2.
 */
const TRUE_WAIT = 2;

/** A pooler spec is PgBouncer between the pool and the server. The time is in seconds. */
export interface PoolerSpec {
  /** This count is `default_pool_size`. */
  readonly size: number;
  /** This time is `query_wait_timeout`. Without it, the timeout is the default of the document. */
  readonly queryWait?: number;
  /** With this flag, the check of a borrow stays at its default. Without it, the lab turns off the check. */
  readonly checks?: true;
}

/** A pool spec is one cell. It has its plan, the size of the pool, the count of queries, their hold, the timeout of a borrow, and a pooler. The times are in seconds. */
export interface PoolSpec {
  readonly plan: string;
  readonly name: string;
  readonly size: number;
  readonly queries: number;
  readonly hold: number;
  /** This time is `connectionTimeout`, in seconds. Without it, the timeout is the default of the document. */
  readonly timeout?: number;
  /** This pooler has the queue. Without it, the pool of the client has the queue. */
  readonly pooler?: PoolerSpec;
}

/** A turn is what one query of a burst does: its number in the client, how it ends, and the band of its end. The band counts from the send of the first query, in seconds. */
export interface Turn {
  readonly n: number;
  readonly ends: "ack" | "fail";
  readonly low: number;
  readonly high: number;
}

/**
 * These are the specs. For HikariCP alone: a burst at the size, the queue of a pool of 2 and of 3,
 * and the failures at each timeout. Behind PgBouncer: the same three, and the check of a borrow.
 */
export const POOL_SPECS: readonly PoolSpec[] = [
  { plan: "Q19.pool.1", name: "2 queries at a pool of 2: no wait", size: 2, queries: 2, hold: 1 },
  { plan: "Q19.pool.2", name: "6 queries at a pool of 2: each 2 places of the queue wait one more hold", size: 2, queries: 6, hold: 1 },
  { plan: "Q19.pool.3", name: "7 queries at a pool of 3: each 3 places of the queue wait one more hold", size: 3, queries: 7, hold: 1 },
  { plan: "Q19.pool.4", name: "8 queries at a pool of 2, connectionTimeout 2.25 s: the last 2 fail at the timeout", size: 2, queries: 8, hold: 1, timeout: 2.25 },
  { plan: "Q19.pool.5", name: "8 queries at a pool of 2 with holds of 12 s: the last 2 fail at the default connectionTimeout of 30 s", size: 2, queries: 8, hold: 12 },
  { plan: "Q19.pool.6", name: "PgBouncer with 2 servers, no check, 2 queries: no wait", size: 2, queries: 2, hold: 1, pooler: { size: 2 } },
  { plan: "Q19.pool.7", name: "PgBouncer with 2 servers, no check, 6 queries: each 2 places of the queue wait one more hold", size: 6, queries: 6, hold: 1, pooler: { size: 2 } },
  { plan: "Q19.pool.8", name: "PgBouncer with 3 servers, no check, 7 queries: each 3 places of the queue wait one more hold", size: 7, queries: 7, hold: 1, pooler: { size: 3 } },
  { plan: "Q19.pool.9", name: "PgBouncer with 2 servers, no check, 6 queries, query_wait_timeout 2 s: the last 2 end with FATAL 08P01", size: 6, queries: 6, hold: 1.5, pooler: { size: 2, queryWait: 2 } },
  { plan: "Q19.pool.10", name: "PgBouncer with 2 servers, the check at its default, 6 queries, query_wait_timeout 2 s: each wait has two parts, and no query fails", size: 6, queries: 6, hold: 1.5, pooler: { size: 2, queryWait: 2, checks: true } },
];

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** This function gives the options of the pool of a spec, by the knobs of the document and in their units. */
const optionsOf = (spec: PoolSpec): Readonly<Record<string, number>> => ({
  maximumPoolSize: spec.size,
  ...(spec.timeout === undefined ? {} : { connectionTimeout: spec.timeout * 1000 }),
  ...(spec.pooler === undefined || spec.pooler.checks === true ? {} : { aliveBypassWindowMs: NO_CHECK_MS }),
});

/** This function gives the settings of PgBouncer for a spec, by the knobs of its documents and in their units. */
const settingsOf = (pooler: PoolerSpec): Readonly<Record<string, number>> => ({
  default_pool_size: pooler.size,
  ...(pooler.queryWait === undefined ? {} : { query_wait_timeout: pooler.queryWait }),
});

/** This function gives the timer that ends a wait in PgBouncer, with its band from the first packet of the query. */
const queueTimer = (pooler: PoolerSpec): { readonly timer: string; readonly errno: string; readonly band: Span } => {
  const own = pgbouncerFirst("waiting", settingsOf(pooler));
  if (own === null) throw new Error("pgbouncer-client has no timer for a waiting client");
  return own;
};

/**
 * This function gives the end of each query for one set of times, or null for a wait that times
 * out. The queue has the order of arrival. Each lane is a connection of the pool or a server of
 * PgBouncer. Its first use costs `opens`.
 */
const served = (lanes: number, queries: number, arrival: (k: number) => number, step: number, wait: number, opens: (lane: number) => number = () => 0): ReadonlyArray<number | null> => {
  const free: number[] = Array.from({ length: lanes }, () => 0);
  const used = new Set<number>();
  const ends: Array<number | null> = [];
  for (let k = 0; k < queries; k += 1) {
    const at = arrival(k);
    const soonest = Math.min(...free);
    const lane = free.indexOf(soonest);
    const start = Math.max(at, soonest) + (used.has(lane) ? 0 : opens(lane));
    if (start - at > wait) ends.push(null);
    else {
      used.add(lane);
      free[lane] = start + step;
      ends.push(start + step);
    }
  }
  return ends;
};

/** This is what the law gives for a spec: the turn of each query, and the band of the end of the burst. */
interface Law {
  readonly turns: readonly Turn[];
  readonly last: { readonly low: number; readonly high: number };
}

/** These are the times of the law for a spec, in seconds. */
const timesOf = (spec: PoolSpec) => {
  const values = given(hikariValues(RTT_MS, optionsOf(spec)));
  const timer = timerOf(HIKARICP_PGJDBC, "connection_timeout", values);
  const slack = seconds(timer.lateness, "the slack of the JVM");
  const borrow = seconds(timer.duration, "connectionTimeout");
  const validation = seconds(timerOf(HIKARICP_PGJDBC, "validation_timeout", values).duration, "validationTimeout");
  const limit = spec.pooler === undefined ? span(borrow, borrow) : queueTimer(spec.pooler).band;
  const rtt = PG_RTT_MS / 1000;
  const gap = POOL_GAP_MS / 1000;
  const hop = spec.pooler === undefined ? 0 : PGBOUNCER_LATENCY;
  return {
    slack,
    validation,
    limit,
    rtt,
    hop,
    step: spec.hold + rtt + slack + hop,
    tail: rtt + slack + hop,
    early: (k: number): number => (k === 0 ? 0 : k * gap - slack),
    late: (k: number): number => (k === 0 ? 0 : k * gap + slack),
  };
};

/**
 * This function gives the law of a spec. The low end has the exact hold. The high end adds one round
 * trip and one step of the JVM to each hold, and one check to the end of each query. A pooler adds
 * its own latency to each. The start of a thread is up to one step of the JVM from its time.
 *
 * The band counts from the send of the first query. The function stops with an error if a query is
 * near the timeout. A query must have one outcome at each end of the times and at a margin on each
 * side of the timeout.
 *
 * With checks, the lanes first serve their first queries. Each other query waits in its check until
 * the first release. Then all queued checks pass, and those queries join the queue again in an order
 * that is not a prediction. Thus they arrive together, and each one has the band of the whole set.
 */
const lawOf = (spec: PoolSpec): Law => {
  const { slack, validation, limit, rtt, hop, step, tail, early, late } = timesOf(spec);
  const lanes = spec.pooler?.size ?? spec.size;
  const checks = spec.pooler?.checks === true;
  const check = checks ? tail : 0;
  const opens = (lane: number): number => check + (spec.pooler !== undefined && lane > 0 ? SERVER_LOGIN_MS / 1000 : 0);
  const release = step + opens(0);
  const chain = checks ? (spec.queries - lanes) * hop + rtt + slack : 0;
  if (checks && release + chain - early(lanes) > Math.min(limit.lo, validation) - MARGIN) throw new Error(`${spec.plan}: a check waits too long, and a failed check is hidden from the client`);
  const queued = (k: number): boolean => checks && k >= lanes;
  const soon = served(lanes, spec.queries, (k) => (queued(k) ? spec.hold : early(k)), spec.hold, limit.hi + MARGIN);
  const slow = served(lanes, spec.queries, (k) => (queued(k) ? release + chain : late(k)), step, limit.lo - MARGIN, opens);
  const waited = (ends: ReadonlyArray<number | null>): readonly number[] => ends.flatMap((end, k) => (end !== null && queued(k) ? [end] : []));
  const turns = soon.map((low, k): Turn => {
    const high = slow[k] ?? null;
    if ((low === null) !== (high === null)) throw new Error(`${spec.plan}: query ${k + 2} is within ${MARGIN} s of the timeout of its wait`);
    if (low === null || high === null) {
      if (checks) throw new Error(`${spec.plan}: query ${k + 2} would fail after its check, and this law has no band for it`);
      return { n: k + 2, ends: "fail", low: round(early(k) + limit.lo), high: round(late(k) + limit.hi + hop + slack) };
    }
    if (queued(k)) return { n: k + 2, ends: "ack", low: round(Math.min(...waited(soon))), high: round(Math.max(...waited(slow)) + tail) };
    return { n: k + 2, ends: "ack", low: round(low), high: round(high + tail) };
  });
  const lastLow = Math.max(...turns.map((turn) => turn.low), ...soon.flatMap((end) => (end === null ? [] : [end])));
  return { turns, last: { low: round(lastLow), high: round(Math.max(...turns.map((turn) => turn.high)) + slack) } };
};

/** This function gives the turn of each query of a spec. */
export const turnsOf = (spec: PoolSpec): readonly Turn[] => lawOf(spec).turns;

/** This function gives the line of the end of a query. A failure names its error: the class of HikariCP, or the SQLSTATE of PgBouncer. */
const lineOf = (spec: PoolSpec, turn: Turn): LineMatch => ({ ev: turn.ends, where: { n: turn.n }, ...(turn.ends === "fail" ? { name: spec.pooler === undefined ? "name" : "sqlState" } : {}) });

/**
 * This function gives the prediction of a spec. The band of the cell is the first query. Each other
 * query is a later band from the same send. Thus the bands are the curve of the wait against the
 * place in the queue. One more band is the deepest queue, from the line `pool`. The last band is
 * the end of the burst, with its counts and each connection idle. The pool does not grow.
 *
 * Behind PgBouncer, the deepest line has each connection of HikariCP in use and none waiting, thus
 * the queue is not in HikariCP. After a FATAL, the end of the burst does not name the size of the pool.
 */
export const poolPrediction = (spec: PoolSpec): Extract<Prediction, { readonly detects: true }> => {
  const { turns, last } = lawOf(spec);
  const [first, ...others] = turns;
  if (first === undefined || first.ends !== "ack") throw new Error(`${spec.plan}: the first query has an idle connection`);
  const timedOut = spec.pooler === undefined ? transitionOn(HIKARICP_PGJDBC, "waiting", "timer.connection-timeout")?.errno : queueTimer(spec.pooler).errno;
  if (timedOut === undefined) throw new Error("hikaricp-pgjdbc has no error for the timeout of a borrow");
  const { slack } = timesOf(spec);
  const queue = Math.max(0, spec.queries - spec.size);
  const lastArrival = ((spec.queries - 1) * POOL_GAP_MS) / 1000;
  if (lastArrival >= spec.hold) throw new Error(`${spec.plan}: a connection comes back before the last query arrives, thus the queue is not its deepest`);
  const failed = turns.filter((turn) => turn.ends === "fail").length;
  const evicts = spec.pooler !== undefined && failed > 0;
  const ends: readonly DriverStep[] = others.map((turn) => ({
    what: turn.ends === "ack" ? `query ${turn.n} gets its reply` : `query ${turn.n} times out in the queue`,
    name: turn.ends === "ack" ? "OK" : timedOut,
    from: "request-sent",
    ends: lineOf(spec, turn),
    low: s(turn.low),
    high: s(turn.high),
  }));
  const deepest: readonly DriverStep[] =
    queue === 0 && spec.pooler === undefined
      ? []
      : [
          {
            what: spec.pooler === undefined ? `the queue reaches ${queue}, with each connection in use` : "each connection of HikariCP is in use, and no query waits in HikariCP",
            name: "OK",
            from: "request-sent",
            ends: { ev: "pool", where: { total: spec.size, active: spec.size, idle: 0, waiting: queue } },
            low: s(round(lastArrival - slack)),
            high: s(round(lastArrival + slack + SAMPLE_MS / 1000 + slack)),
          },
        ];
  const end: DriverStep = {
    what: evicts ? "the burst ends with its counts" : "the burst ends, and each connection is idle",
    name: "OK",
    from: "request-sent",
    ends: { ev: "burst", where: { acks: turns.length - failed, fails: failed, ...(evicts ? {} : { total: spec.size }), active: 0, ...(evicts ? {} : { idle: spec.size }), waiting: 0 } },
    low: s(last.low),
    high: s(last.high),
  };
  const holders = spec.pooler === undefined ? `${spec.size} connections` : `${spec.pooler.size} servers`;
  const timedOutBy = spec.pooler === undefined ? "connection_timeout" : queueTimer(spec.pooler).timer;
  const quiet: readonly LineMatch[] = [
    { ev: "pool", where: { total: spec.size + 1 } },
    ...(queue === 0 ? [{ ev: "pool", where: { waiting: spec.pooler === undefined ? 1 : TRUE_WAIT } }] : []),
    ...(failed === 0 ? [{ ev: "fail" }] : []),
  ];
  return {
    detects: true,
    timer: failed > 0 ? timedOutBy : `the hold of ${holders}`,
    errno: "OK",
    from: "request-sent",
    low: s(first.low),
    high: s(first.high),
    driver: { socket: "pool", ends: lineOf(spec, first), then: [...ends, ...deepest, end], quiet },
  };
};

/**
 * This function gives the cell of a spec: a cell of HikariCP against the target of the catalog, with
 * a burst and its prediction. A spec with a pooler has the hop of PgBouncer. A spec with checks stays
 * idle before the burst, so that each connection has its check.
 */
export const poolCell = (spec: PoolSpec): Cell => {
  const inflight = `SELECT pg_sleep(${spec.hold})`;
  const pooler = spec.pooler === undefined ? {} : { pooler: pgbouncerHop(settingsOf(spec.pooler)), poolerLatency: PGBOUNCER_LATENCY };
  const base = hikariCell({ plan: spec.plan, name: spec.name, fault: "app-stall", mode: "inflight", inflight, options: optionsOf(spec), ...pooler });
  return {
    ...base,
    ...(spec.pooler?.checks === true ? { idleBefore: s(CHECK_IDLE_S) } : {}),
    probe: { ...base.probe, driver: { name: "hikari", inflight, burst: { count: spec.queries, gap: ms(POOL_GAP_MS) } } },
    prediction: poolPrediction(spec),
  };
};

/** These are the cells of a pool at its limit, for the harness. */
export const POOL_CELLS: readonly Cell[] = POOL_SPECS.map(poolCell);
