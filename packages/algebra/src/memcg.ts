/**
 * These functions give the law of the memory controller of cgroup v2 for the tasks of one cgroup. The
 * sources are Linux v7.0, `mm/memcontrol.c`, unless a line names another file. Each count is in pages:
 * `page_counter_memparse` divides the bytes of a limit by the page size and rounds down
 * (`mm/page_counter.c`, line 287).
 *
 * - A charge takes `max(64, pages)` pages from the counter (`MEMCG_CHARGE_BATCH`,
 *   `include/linux/memcontrol.h`, line 332, and line 2358). The pages that the charge did not ask
 *   for go to the stock of the CPU, and the next charges on that CPU take the stock first (line 2371).
 * - A charge that leaves the usage above `memory.high` adds its batch to the debt of the task
 *   (lines 2521-2534). The task pays the debt when it goes back to user space (lines 2265-2353).
 * - The overage of one level is `((usage − high) << 20) / max(high, 1)`, and 0 at or below high
 *   (lines 2176-2192). The cgroup and each ancestor below the root give one overage, and the delay
 *   takes the largest (lines 2194-2206).
 * - The delay is `overage² × HZ >> 20 >> 14`, times `debt / 64` (lines 2228-2258), in 64-bit
 *   unsigned arithmetic. The delay of the swap overage adds to it (lines 2307-2311).
 * - The sleep is the delay with a cap of `2 × HZ` (lines 2128 and 2318). A delay of `HZ / 100`
 *   jiffies or less gives no sleep (line 2326).
 * - Before a sleep the task reclaims 17 times: once, then again while the reclaim frees pages, and
 *   16 more times (`MAX_RECLAIM_RETRIES`, `mm/internal.h`, line 610, and lines 2334-2337). Each
 *   reclaim of a cgroup above its high adds one event `high` to its `memory.events` (line 2101).
 * - The sleep is `schedule_timeout_killable` (line 2348) on the timer wheel
 *   (`kernel/time/sleep_timeout.c`, line 93). The wheel puts the end on the next boundary of its
 *   level (`kernel/time/timer.c`, lines 524-539). Thus a sleep ends up to one granularity late, and
 *   not early.
 */

import { granularity } from "./wheel.ts";

const PRECISION = 20n;
const SCALING = 14n;
const BATCH = 64n;
const RETRIES = 16;

/** This function gives the value of a 64-bit unsigned variable of the kernel, which wraps. */
const u64 = (value: bigint): bigint => BigInt.asUintN(64, value);

const count = (value: number, what: string): bigint => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} is not a count: ${value}`);
  return BigInt(value);
};

const hzOf = (hz: number): bigint => {
  const value = count(hz, "HZ");
  if (value === 0n) throw new Error("HZ is 0");
  return value;
};

/** This record is one counter of the memory controller: the usage of a cgroup and its limit `memory.high`, in pages. */
export interface MemcgLevel {
  readonly usage: number;
  readonly high: number;
}

const overage = (usage: bigint, high: bigint): bigint => {
  if (usage <= high) return 0n;
  const floor = high > 1n ? high : 1n;
  return u64(u64(usage - floor) << PRECISION) / floor;
};

const maxOverage = (levels: readonly MemcgLevel[]): bigint => {
  let most = 0n;
  for (const level of levels) {
    const value = overage(count(level.usage, "the usage"), count(level.high, "memory.high"));
    if (value > most) most = value;
  }
  return most;
};

const delay = (most: bigint, debt: bigint, hz: bigint): bigint => {
  if (most === 0n) return 0n;
  const penalty = u64(u64(most * most) * hz) >> PRECISION >> SCALING;
  return u64(penalty * debt) / BATCH;
};

const delayOf = (
  memory: readonly MemcgLevel[],
  debt: bigint,
  hz: bigint,
  swap: readonly MemcgLevel[],
): bigint => u64(delay(maxOverage(memory), debt, hz) + delay(maxOverage(swap), debt, hz));

const sleepOf = (
  memory: readonly MemcgLevel[],
  debt: bigint,
  hz: bigint,
  swap: readonly MemcgLevel[],
): bigint => {
  const total = delayOf(memory, debt, hz, swap);
  const capped = total < 2n * hz ? total : 2n * hz;
  return capped <= hz / 100n ? 0n : capped;
};

/**
 * This function gives the delay of a debt of `debt` pages, in jiffies, before the cap and the skip:
 * the delay of the largest overage of memory plus the delay of the largest overage of swap. The table
 * in the comment of the source gives this delay (lines 2145-2171): 6 ms at 1% over a high of 100 MiB.
 */
export const memcgHighDelay = (
  memory: readonly MemcgLevel[],
  debt: number,
  hz: number,
  swap: readonly MemcgLevel[] = [],
): number => {
  const total = delayOf(memory, count(debt, "the debt"), hzOf(hz), swap);
  const value = Number(total);
  if (!Number.isSafeInteger(value)) throw new Error(`the delay is not a safe count: ${total}`);
  return value;
};

/**
 * This function gives the jiffies that a task sleeps when it pays a debt of `debt` pages: the delay
 * of the largest overage of memory, plus the delay of the largest overage of swap, with the cap of
 * 2 s, and 0 when the delay is 10 ms or less. `memory` is the cgroup of the task, then each ancestor
 * below the root. `swap` gives the same for `memory.swap.high`.
 */
export const memcgHighSleep = (
  memory: readonly MemcgLevel[],
  debt: number,
  hz: number,
  swap: readonly MemcgLevel[] = [],
): number => Number(sleepOf(memory, count(debt, "the debt"), hzOf(hz), swap));

/**
 * This record gives the usage, in pages, where the sleep of one cgroup at one debt starts, and where
 * it reaches its cap of 2 s.
 */
export interface MemcgSleepBounds {
  readonly first: number;
  readonly capped: number;
}

/**
 * This function gives the lowest usage above `high` whose debt of `debt` pages gives a sleep, and the
 * lowest usage whose sleep is the cap of 2 s. The sleep does not go down as the usage goes up, thus a
 * search finds each bound. For a high of 25,600 pages (100 MiB) at HZ 1000 and a debt of 64, the
 * sleep starts at 25,936 pages (1.3% over) and its cap at 30,126 (17.7% over).
 */
export const memcgSleepBounds = (high: number, debt: number, hz: number): MemcgSleepBounds => {
  const limit = count(high, "memory.high");
  const pages = count(debt, "the debt");
  const freq = hzOf(hz);
  if (pages === 0n) throw new Error("a debt of 0 pages gives no sleep");
  const sleep = (usage: bigint) => sleepOf([{ usage: Number(usage), high: Number(limit) }], pages, freq, []);
  const lowest = (reaches: (jiffies: bigint) => boolean): number => {
    let over = 1n;
    while (!reaches(sleep(limit + over))) {
      over *= 2n;
      if (limit + over > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("no safe usage reaches the bound");
    }
    let below = over / 2n;
    while (over - below > 1n) {
      const mid = (below + over) / 2n;
      if (reaches(sleep(limit + mid))) over = mid;
      else below = mid;
    }
    return Number(limit + over);
  };
  return { first: lowest((jiffies) => jiffies > 0n), capped: lowest((jiffies) => jiffies === 2n * freq) };
};

/** This record gives the throttle of the growth of one task, in charges of one batch each. */
export interface MemcgThrottle {
  /** These are the charges that left the cgroup above its high: each one sends the task to reclaim. */
  readonly over: number;
  /** These are the charges whose debt put the task to sleep. */
  readonly sleeps: number;
  /** This is the sum of the sleeps, in jiffies. */
  readonly jiffies: number;
  /** This is how late the timer wheel can end those sleeps, in jiffies: one granularity of the level of each. */
  readonly late: number;
  /** These are the events `high` of the cgroup of the task: one at each reclaim of a charge, 17 at a charge that sleeps. */
  readonly high: number;
}

/**
 * This function gives the throttle of a task that grows by `charges` charges of `batch` pages each,
 * from the usage of each level in `levels`: the cgroup of the task, then each ancestor below the root.
 * Each charge adds `batch` pages to each level, and the task pays its debt of `batch` pages before
 * the next charge. A task that touches one page at a time charges a batch of 64 at each 64th page.
 *
 * The model takes a reclaim that frees no page: anonymous memory with no swap. Thus the usage does
 * not go down, and a charge that sleeps reclaims 17 times. The sleep of a level that is not the
 * first, and the debt of a level that is not above its high, follow the same law.
 */
export const memcgThrottle = (
  levels: readonly MemcgLevel[],
  charges: number,
  hz: number,
  batch = 64,
): MemcgThrottle => {
  const steps = count(charges, "the count of charges");
  const pages = count(batch, "the batch");
  const freq = hzOf(hz);
  if (levels.length === 0) throw new Error("the task has no cgroup");
  const usages = levels.map((level) => count(level.usage, "the usage"));
  const highs = levels.map((level) => count(level.high, "memory.high"));
  let over = 0;
  let sleeps = 0;
  let jiffies = 0n;
  let late = 0n;
  let high = 0;
  for (let step = 0n; step < steps; step += 1n) {
    for (let index = 0; index < usages.length; index += 1) usages[index]! += pages;
    if (!usages.some((usage, index) => usage > highs[index]!)) continue;
    over += 1;
    const now = usages.map((usage, index) => ({ usage: Number(usage), high: Number(highs[index]!) }));
    const sleep = sleepOf(now, pages, freq, []);
    const first = usages[0]! > highs[0]!;
    if (sleep === 0n) {
      if (first) high += 1;
      continue;
    }
    sleeps += 1;
    jiffies += sleep;
    late += granularity(sleep);
    if (first) high += 1 + RETRIES;
  }
  return { over, sleeps, jiffies: Number(jiffies), late: Number(late), high };
};

/** This record is one task as the OOM killer of a cgroup scores it (`mm/oom_kill.c`, lines 202-240). */
export interface OomTask {
  /** This count is the resident pages of the task: its anonymous, file and shared memory pages. */
  readonly rss: number;
  /** This count is the swap entries of the task. */
  readonly swap: number;
  /** This count is the bytes of the page tables of the task. */
  readonly pageTables: number;
  /** This value is the `oom_score_adj` of the task, from −1000 to 1000. */
  readonly adj: number;
}

/**
 * This function gives the points of a task for the OOM killer: its resident pages, its swap entries
 * and the pages of its page tables, plus `oom_score_adj` times `totalPages / 1000` in integer
 * arithmetic. A task at −1000 gives undefined, because the OOM killer does not take it.
 *
 * For the OOM of a cgroup, `totalPages` is `memory.max` in pages, plus the smaller of
 * `memory.swap.max` and the swap of the host when the swappiness is not 0 (`mm/memcontrol.c`,
 * lines 1623-1640), and 1 when that sum is 0 (`mm/oom_kill.c`, line 261).
 */
export const oomBadness = (task: OomTask, totalPages: number, pageSize = 4096): number | undefined => {
  if (!Number.isSafeInteger(task.adj) || task.adj < -1000 || task.adj > 1000)
    throw new Error(`oom_score_adj is not from -1000 to 1000: ${task.adj}`);
  if (task.adj === -1000) return undefined;
  const size = count(pageSize, "the page size");
  if (size === 0n) throw new Error("the page size is 0");
  const points =
    count(task.rss, "the resident pages") +
    count(task.swap, "the swap entries") +
    count(task.pageTables, "the bytes of the page tables") / size +
    BigInt(task.adj) * (count(totalPages, "the total pages") / 1000n);
  const value = Number(points);
  if (!Number.isSafeInteger(value)) throw new Error(`the points are not a safe count: ${points}`);
  return value;
};

/**
 * This function gives the index of the task that the OOM killer of a cgroup takes: the task with the
 * most points. Of tasks with equal points, the last one in the order of the scan wins, because a task
 * replaces the choice unless its points are less (`mm/oom_kill.c`, lines 342-351). It gives undefined
 * when the OOM killer can take no task.
 */
export const oomVictim = (
  tasks: readonly OomTask[],
  totalPages: number,
  pageSize = 4096,
): number | undefined => {
  let chosen: number | undefined;
  let most = Number.NEGATIVE_INFINITY;
  tasks.forEach((task, index) => {
    const points = oomBadness(task, totalPages, pageSize);
    if (points === undefined || points < most) return;
    chosen = index;
    most = points;
  });
  return chosen;
};
