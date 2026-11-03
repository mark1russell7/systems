import { timerOf, transitionOn } from "@mark1russell7/algebra";
import type { Cell, DriverStep, LineMatch, Prediction } from "@mark1russell7/harness";
import { HIKARICP_PGJDBC } from "@mark1russell7/machines";
import { RTT_MS, given, ms, s, seconds } from "../catalog.ts";
import { hikariCell, hikariValues } from "./hikari.ts";
import { PG_RTT_MS } from "./t01.ts";

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
 * The cells are the HikariCP half of the row of S3. PgBouncer 1.26 is not here. Its documents have
 * no knob for `default_pool_size`. The janitor bounds a wait only to one pass. The empty query of a
 * check of HikariCP also joins the queue of PgBouncer.
 */

/** This time is the gap between two queries of a burst, in ms: longer than the jitter of a thread, so that the order holds. */
export const POOL_GAP_MS = 50;

/** This time is the period of the line `pool` of the client, in ms (ClientHikari.java, watchPool). */
const SAMPLE_MS = 5;

/** This time is the least distance of a wait from the timeout of its borrow, in seconds. A smaller distance is not a prediction. */
const MARGIN = 0.25;

/** A pool spec is one cell: its plan, the size of the pool, the count of queries, their hold, and the timeout of a borrow. The times are in seconds. */
export interface PoolSpec {
  readonly plan: string;
  readonly name: string;
  readonly size: number;
  readonly queries: number;
  readonly hold: number;
  /** This time is `connectionTimeout`, in seconds. Without it, the timeout is the default of the document. */
  readonly timeout?: number;
}

/** A turn is what one query of a burst does: its number in the client, how it ends, and the band of its end. The band counts from the send of the first query, in seconds. */
export interface Turn {
  readonly n: number;
  readonly ends: "ack" | "fail";
  readonly low: number;
  readonly high: number;
}

/** These are the specs: a burst at the size, the queue of a pool of 2 and of 3, and the failures at each timeout. */
export const POOL_SPECS: readonly PoolSpec[] = [
  { plan: "Q19.pool.1", name: "2 queries at a pool of 2: no wait", size: 2, queries: 2, hold: 1 },
  { plan: "Q19.pool.2", name: "6 queries at a pool of 2: each 2 places of the queue wait one more hold", size: 2, queries: 6, hold: 1 },
  { plan: "Q19.pool.3", name: "7 queries at a pool of 3: each 3 places of the queue wait one more hold", size: 3, queries: 7, hold: 1 },
  { plan: "Q19.pool.4", name: "8 queries at a pool of 2, connectionTimeout 2.25 s: the last 2 fail at the timeout", size: 2, queries: 8, hold: 1, timeout: 2.25 },
  { plan: "Q19.pool.5", name: "8 queries at a pool of 2 with holds of 12 s: the last 2 fail at the default connectionTimeout of 30 s", size: 2, queries: 8, hold: 12 },
];

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** This function gives the options of the pool of a spec, by the knobs of the document and in their units. */
const optionsOf = (spec: PoolSpec): Readonly<Record<string, number>> => ({
  maximumPoolSize: spec.size,
  ...(spec.timeout === undefined ? {} : { connectionTimeout: spec.timeout * 1000 }),
});

/** This function gives the end of each query for one set of times, or null for a borrow that times out. The queue has the order of arrival. */
const served = (spec: PoolSpec, arrival: (k: number) => number, step: number, wait: number): ReadonlyArray<number | null> => {
  const free: number[] = Array.from({ length: spec.size }, () => 0);
  const ends: Array<number | null> = [];
  for (let k = 0; k < spec.queries; k += 1) {
    const at = arrival(k);
    const soonest = Math.min(...free);
    const start = Math.max(at, soonest);
    if (start - at > wait) ends.push(null);
    else {
      free[free.indexOf(soonest)] = start + step;
      ends.push(start + step);
    }
  }
  return ends;
};

/**
 * This function gives the turn of each query of a spec. The low end has the exact hold. The high
 * end adds one round trip and one step of the JVM to each hold, and one check to the end of each
 * query. The start of a thread is up to one step of the JVM from its time. The band counts from the
 * send of the first query. The function stops with an error if a query is near the timeout.
 * A query must have one outcome at each end of the times and at a margin on each side of the timeout.
 */
export const turnsOf = (spec: PoolSpec): readonly Turn[] => {
  const timer = timerOf(HIKARICP_PGJDBC, "connection_timeout", given(hikariValues(RTT_MS, optionsOf(spec))));
  const wait = seconds(timer.duration, "connectionTimeout");
  const slack = seconds(timer.lateness, "the slack of the JVM");
  const rtt = PG_RTT_MS / 1000;
  const gap = POOL_GAP_MS / 1000;
  const early = (k: number): number => (k === 0 ? 0 : k * gap - slack);
  const late = (k: number): number => (k === 0 ? 0 : k * gap + slack);
  const soon = served(spec, early, spec.hold, wait + MARGIN);
  const slow = served(spec, late, spec.hold + rtt + slack, wait - MARGIN);
  return soon.map((low, k) => {
    const high = slow[k] ?? null;
    if ((low === null) !== (high === null)) throw new Error(`${spec.plan}: query ${k + 2} is within ${MARGIN} s of the timeout of its borrow`);
    if (low === null || high === null) return { n: k + 2, ends: "fail", low: round(early(k) + wait), high: round(late(k) + wait + slack) };
    return { n: k + 2, ends: "ack", low: round(low), high: round(high + rtt + slack) };
  });
};

/** This function gives the line of the end of a query. A failure names its error. */
const lineOf = (turn: Turn): LineMatch => ({ ev: turn.ends, where: { n: turn.n }, ...(turn.ends === "fail" ? { name: "name" } : {}) });

/**
 * This function gives the prediction of a spec. The band of the cell is the first query. Each other
 * query is a later band from the same send. Thus the bands are the curve of the wait against the
 * place in the queue. One more band is the deepest queue, from the line `pool`. The last band is
 * the end of the burst, with its counts and each connection idle. The pool does not grow.
 */
export const poolPrediction = (spec: PoolSpec): Extract<Prediction, { readonly detects: true }> => {
  const turns = turnsOf(spec);
  const [first, ...others] = turns;
  if (first === undefined || first.ends !== "ack") throw new Error(`${spec.plan}: the first query has an idle connection`);
  const timedOut = transitionOn(HIKARICP_PGJDBC, "waiting", "timer.connection-timeout")?.errno;
  if (timedOut === undefined) throw new Error("hikaricp-pgjdbc has no error for the timeout of a borrow");
  const timer = timerOf(HIKARICP_PGJDBC, "connection_timeout", given(hikariValues(RTT_MS, optionsOf(spec))));
  const slack = seconds(timer.lateness, "the slack of the JVM");
  const queue = Math.max(0, spec.queries - spec.size);
  const lastArrival = ((spec.queries - 1) * POOL_GAP_MS) / 1000;
  if (lastArrival >= spec.hold) throw new Error(`${spec.plan}: a connection comes back before the last query arrives, thus the queue is not its deepest`);
  const failed = turns.filter((turn) => turn.ends === "fail").length;
  const ends: readonly DriverStep[] = others.map((turn) => ({
    what: turn.ends === "ack" ? `query ${turn.n} gets its reply` : `query ${turn.n} times out in the queue`,
    name: turn.ends === "ack" ? "OK" : timedOut,
    from: "request-sent",
    ends: lineOf(turn),
    low: s(turn.low),
    high: s(turn.high),
  }));
  const deepest: readonly DriverStep[] =
    queue === 0
      ? []
      : [
          {
            what: `the queue reaches ${queue}, with each connection in use`,
            name: "OK",
            from: "request-sent",
            ends: { ev: "pool", where: { total: spec.size, active: spec.size, idle: 0, waiting: queue } },
            low: s(round(lastArrival - slack)),
            high: s(round(lastArrival + slack + SAMPLE_MS / 1000 + slack)),
          },
        ];
  const end: DriverStep = {
    what: "the burst ends, and each connection is idle",
    name: "OK",
    from: "request-sent",
    ends: { ev: "burst", where: { acks: turns.length - failed, fails: failed, total: spec.size, active: 0, idle: spec.size, waiting: 0 } },
    low: s(Math.max(...turns.map((turn) => turn.low))),
    high: s(round(Math.max(...turns.map((turn) => turn.high)) + slack)),
  };
  const quiet: readonly LineMatch[] = [
    { ev: "pool", where: { total: spec.size + 1 } },
    ...(queue === 0 ? [{ ev: "pool", where: { waiting: 1 } }] : []),
    ...(failed === 0 ? [{ ev: "fail" }] : []),
  ];
  return {
    detects: true,
    timer: failed > 0 ? "connection_timeout" : `the hold of ${spec.size} connections`,
    errno: "OK",
    from: "request-sent",
    low: s(first.low),
    high: s(first.high),
    driver: { socket: "pool", ends: lineOf(first), then: [...ends, ...deepest, end], quiet },
  };
};

/** This function gives the cell of a spec: a cell of HikariCP against the target of the catalog, with a burst and its prediction. */
export const poolCell = (spec: PoolSpec): Cell => {
  const inflight = `SELECT pg_sleep(${spec.hold})`;
  const base = hikariCell({ plan: spec.plan, name: spec.name, fault: "app-stall", mode: "inflight", inflight, options: optionsOf(spec) });
  return {
    ...base,
    probe: { ...base.probe, driver: { name: "hikari", inflight, burst: { count: spec.queries, gap: ms(POOL_GAP_MS) } } },
    prediction: poolPrediction(spec),
  };
};

/** These are the cells of a pool at its limit, for the harness. */
export const POOL_CELLS: readonly Cell[] = POOL_SPECS.map(poolCell);
