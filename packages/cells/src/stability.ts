import type { Cell, LoadBand, LoadPrediction, Target } from "@mark1russell7/harness";
import { constant } from "@mark1russell7/rigor-chaos";
import { REDIS, RUNS, ms, q } from "./catalog.ts";

/**
 * These cells are the border of a stable system (SYS-69).
 *
 * Huang and others (OSDI 2022) give the border in their Theorem 2. A system is stable if and only
 * if `L < C / (wL · wC)` is true. L is the load, and C is the capacity. The factor wL
 * is the work that one arrival adds, and wC is the loss of capacity under that work.
 *
 * Each request of these cells is `DEBUG SLEEP 0.01`. Redis does one command at a time, thus each
 * request holds the server for 10 ms, and C is 100 requests each second. The client does not retry,
 * thus wL is 1. The service time does not change with the queue, thus wC is 1. The border is at
 * L = 100 requests each second. One cell is at 0.8 of C, and one cell is at 1.2 of C.
 */

/** This time is the service time of one request: `DEBUG SLEEP` holds the one thread of Redis for this time. */
export const SERVICE = 0.01;

/** This time is the longest service time that the bands accept: the sleep, the command and a late wake of the thread. */
export const SERVICE_HIGH = 0.0106;

/** These are the terms of Theorem 2: the load and the capacity in requests each second, and the two factors of work. */
export interface Terms {
  readonly load: number;
  readonly capacity: number;
  readonly wL: number;
  readonly wC: number;
}

/** This function tells if a system is stable by Theorem 2: its load is less than its capacity over its two factors of work. */
export const stable = (terms: Terms): boolean => terms.load < terms.capacity / (terms.wL * terms.wC);

/**
 * This function gives the latency of the arrival of rank `rank` (from 0). The arrivals come at
 * `rate` each second at even gaps, to one server with the service time `service` in s. The latency
 * counts from the planned time of the arrival. Under the border, each arrival finds the server idle. Over the
 * border, each arrival waits for each arrival before it, thus each latency is longer by
 * `service - 1 / rate` than the latency before it.
 */
export const latencyOf = (rank: number, rate: number, service: number): number =>
  service + Math.max(0, rank * (service - 1 / rate));

/** This function gives the rank (from 0) of the arrival at the quantile `quantile` of `count` arrivals. */
export const rankOf = (quantile: number, count: number): number => Math.ceil(quantile * count) - 1;

/**
 * This function gives the band of a quantile. Its low end is the latency at the service time. Its
 * high end is the latency at the longest service time, plus a margin of 10 ms.
 */
export const bandOf = (quantile: number, rate: number, count: number): LoadBand => {
  const rank = rankOf(quantile, count);
  return { quantile, low: q(latencyOf(rank, rate, SERVICE)), high: q(latencyOf(rank, rate, SERVICE_HIGH) + 0.01) };
};

/** This target is Redis with the command `DEBUG`. Redis 7 refuses that command, unless its start enables it. */
const REDIS_DEBUG: Target = { ...REDIS, command: ["redis-server", "--enable-debug-command", "yes"] };

/** This time is the length of the schedule of each cell, in ms. */
const LENGTH = 20_000;

/** This time is the longest run of a cell: the schedule, then the queue at the end of the cell over the border. */
const WINDOW = q(40);

/** This time is the longest lag of a send behind its time on a hosted runner. A later send is a finding of its run. */
const LAG = ms(50);

/** This function gives a cell at `rate` requests each second. */
const cellAt = (label: string, rate: number, why: string): Cell => {
  const count = (rate * LENGTH) / 1000;
  const load: LoadPrediction = { lag: LAG, bands: [bandOf(0.5, rate, count), bandOf(0.99, rate, count)] };
  return {
    name: `SB.${label}, ${rate} requests each second for 20 s at even gaps, each request holds Redis for 10 ms: ${rate / 100} of its capacity`,
    target: REDIS_DEBUG,
    fault: "none",
    sysctls: {},
    runs: RUNS,
    environments: 2,
    concurrency: 1,
    probe: { mode: "schedule", keepalive: false, request: `DEBUG SLEEP ${SERVICE}`, plan: { profile: constant(rate, LENGTH), options: { arrivals: "uniform" } } },
    prediction: { detects: null, window: WINDOW, why, load },
  };
};

/** These are the two cells of the border: one cell on each side of it. */
export const BORDER_CELLS: readonly Cell[] = [
  cellAt("under", 80, "under the border: each arrival finds the server idle, thus each latency is the service time"),
  cellAt("over", 120, "over the border: the queue grows by 20 requests each second, thus each latency grows with the length of the run"),
];
