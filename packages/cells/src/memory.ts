import type { OomTask } from "@mark1russell7/algebra";
import { memcgSleepBounds, memcgThrottle, oomVictim } from "@mark1russell7/algebra";
import type {
  Cell,
  ClientCapability,
  MemoryLimits,
  MemoryOomPrediction,
  MemoryPrediction,
  MemoryStep,
  MemoryThrottlePrediction,
  QueueBand,
  Target,
} from "@mark1russell7/harness";
import { stepBand } from "@mark1russell7/harness";
import { valueIn } from "@mark1russell7/quantity";
import { HZ, s } from "./catalog.ts";

/**
 * The cells of the memory controller of cgroup v2 (SYS-123) have one client in its container, the real
 * kernel and the limits of its cgroup. The harness writes those limits from the
 * cgroup namespace of the host before the client starts. The law is in the algebra (`memcg.ts`), from
 * the sources of Linux v7.0.
 *
 * - The throttle. The client grows in steps of one batch of 64 pages, from below `memory.high` to
 *   above the cap of the sleep. Each step charges one batch. When the charge leaves the usage above
 *   the high, the task pays a debt of that batch before it goes back to user space. A step near the
 *   high adds one event `high` and no sleep. A step after the start of the sleep reclaims 17 times,
 *   and it sleeps for the delay of its overage, up to 2 s. The client locks its own pages and the
 *   cgroup has no swap, thus a reclaim frees no page. A few file pages of the start of the container
 *   can go at the first reclaims. Those reclaims are near the high, where no sleep and no retry follow.
 * - The OOM killer. Three tasks grow in order under `memory.max`, and the last one meets the limit.
 *   The OOM killer takes the task with the most points: its resident pages and its page tables, plus
 *   `oom_score_adj` times a thousandth of `memory.max`. It does not take a task at −1000. After one
 *   kill the other tasks fit.
 */

/** This image is the stock base of the image of the harness, for the record. */
const BASE = "alpine:3.23@sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62";
/** This port is the listener of the target. The client of a memory cell does not connect to it. */
const PORT = 6392;
/** This size is the page of the runners, in bytes. A run on another page size is void. */
const PAGE = 4096;
/** This count is the pages of one charge (`MEMCG_CHARGE_BATCH`), and of one step of the client. */
const BATCH = 64;
/**
 * This time holds the touch of one step, its reclaims and the wake of the client, in seconds. It has
 * no source: it is a first value, and the first records of CI give it its band (SYS-123 part 3).
 */
const SLACK = 0.02;
/**
 * This count is the pages that kernel memory can add to the usage of one step, or take from it. A
 * page table comes for each 512 pages, and the stock of the CPU takes freed kernel pages back. A step whose usage rose by
 * one batch less or more than this count is not read.
 */
const DRIFT = 16;
/** This share is the least share of the steps above the high that a run reads. */
const READ = 0.9;
/** This count is the steps of the cap after the usage where the cap starts. */
const CAP_STEPS = 4;
/** This time is the wait of the run after the sum of the bands of its steps, in seconds. */
const MARGIN = 30;

const TARGET: Target = {
  image: BASE,
  subject: { kind: "shipped", name: "harness" },
  command: ["/opt/harness/ports", "target", String(PORT)],
  port: PORT,
  ready: "listening",
  lines: true,
};

const band = (low: number, high: number): QueueBand => ({
  low: s(Math.round(low * 1e6) / 1e6),
  high: s(Math.round(high * 1e6) / 1e6),
});

const QUIET = band(0, SLACK);

/**
 * This function gives the entry of the table at a usage after a charge: the time band of its step and
 * its events `high`. A step whose debt gives no sleep is quiet. A sleep ends up to one jiffy early,
 * because its first jiffy is a part of a jiffy. It ends up to one granularity of the timer wheel late.
 */
const entryOf = (usage: number, high: number): MemoryStep => {
  const law = memcgThrottle([{ usage: usage - BATCH, high }], 1, HZ, BATCH);
  if (law.sleeps === 0) return { usage, band: QUIET, high: law.high };
  return { usage, band: band(Math.max(0, law.jiffies - 1) / HZ, (law.jiffies + law.late) / HZ + SLACK), high: law.high };
};

/**
 * This function gives the law of a growth above a high of `high` pages. The table has one entry for
 * each batch from one page above the high to the first entry at the cap. The growth ends `CAP_STEPS`
 * batches after the start of the cap.
 */
export const throttleLaw = (high: number): MemoryThrottlePrediction => {
  const { first, capped } = memcgSleepBounds(high, BATCH, HZ);
  const steps: MemoryStep[] = [];
  for (let usage = high + 1; ; usage += BATCH) {
    steps.push(entryOf(usage, high));
    if (usage >= capped) break;
  }
  return {
    kind: "throttle",
    limits: { high, max: null, swap: 0, page: PAGE },
    hz: HZ,
    batch: BATCH,
    until: Math.ceil((capped + CAP_STEPS * BATCH) / BATCH) * BATCH,
    sleepFrom: first,
    capFrom: capped,
    drift: DRIFT,
    quiet: QUIET,
    steps,
    read: READ,
  };
};

/** This function gives the longest time of a growth from no page to its end: the sum of the high ends of its step bands. */
export const growthTime = (law: MemoryThrottlePrediction): number => {
  let total = 0;
  for (let usage = BATCH; usage <= law.until + BATCH; usage += BATCH) total += valueIn(stepBand(law, usage).band.high, "s");
  return total;
};

/** This count is `memory.max` of each OOM cell: 200 MiB. */
const MAX = 51_200;
/** This count is the resident pages of the parent of the tasks: the program, its libraries and its stack. It has no source. */
const PARENT = 500;
/**
 * This count is the other pages of the cgroup: the parent, the code that the tasks share, page tables
 * and kernel memory. It has no source. The test of the cells holds each
 * victim from no such page to `BASE_MOST`.
 */
export const BASE_PAGES = 2_000;
export const BASE_MOST = 4_000;

/** This record is one task of an OOM cell: its name, the pages that it touches, and its `oom_score_adj`. */
export interface OomSpecTask {
  readonly name: string;
  readonly pages: number;
  readonly adj: number;
}

/**
 * This function gives the index of the task that the OOM killer takes, when the other pages of the
 * cgroup are `base`. The scan sees the parent first, then each task in the order of its start. The
 * last task has what is left under the max when the OOM killer operates. A task of N pages has one page
 * table for each 512 pages.
 */
export const victimOf = (tasks: readonly OomSpecTask[], base: number): number | undefined => {
  const before = tasks.slice(0, -1).reduce((sum, task) => sum + task.pages, 0);
  const left = Math.max(0, MAX - before - base);
  const scored: OomTask[] = [
    { rss: PARENT, swap: 0, pageTables: PAGE, adj: 0 },
    ...tasks.map((task, index) => {
      const rss = index === tasks.length - 1 ? Math.min(task.pages, left) : task.pages;
      return { rss, swap: 0, pageTables: Math.ceil(rss / 512) * PAGE, adj: task.adj };
    }),
  ];
  const chosen = oomVictim(scored, MAX, PAGE);
  return chosen === undefined || chosen === 0 ? undefined : chosen - 1;
};

const oomLaw = (tasks: readonly OomSpecTask[]): MemoryOomPrediction => {
  const victim = victimOf(tasks, BASE_PAGES);
  return {
    kind: "oom",
    limits: { high: null, max: MAX, swap: 0, page: PAGE },
    tasks: tasks.map((task, index) => ({ ...task, outcome: index === victim ? "killed" : "held" })),
    kills: victim === undefined ? 0 : 1,
  };
};

/** These are the settings of a cell: its plan, its law, the command of its client and the files of its cgroup. */
export interface MemorySpec {
  readonly plan: string;
  readonly name: string;
  readonly why: string;
  readonly law: MemoryPrediction;
}

/** This function gives the bytes of a limit in pages, as the cgroup takes it. */
const bytes = (pages: number): string => String(pages * PAGE);

const cgroupOf = (limits: MemoryLimits): Readonly<Record<string, string>> => ({
  ...(limits.high === null ? {} : { "memory.high": bytes(limits.high) }),
  ...(limits.max === null ? {} : { "memory.max": bytes(limits.max) }),
  "memory.swap.max": bytes(limits.swap),
});

const commandOf = (law: MemoryPrediction): readonly string[] =>
  law.kind === "throttle"
    ? ["/opt/harness/memory", "grow", "--until-pages", String(law.until), "--step", String(law.batch)]
    : ["/opt/harness/memory", "oom", ...law.tasks.flatMap((task) => ["--task", `${task.name}:${task.pages}:${task.adj}`])];

const capabilitiesOf = (law: MemoryPrediction): readonly ClientCapability[] => {
  // the lock of the pages of the client is above the default RLIMIT_MEMLOCK of a container
  if (law.kind === "throttle") return ["IPC_LOCK"];
  // a value below the oom_score_adj of the parent
  return law.tasks.some((task) => task.adj < 0) ? ["SYS_RESOURCE"] : [];
};

const windowOf = (law: MemoryPrediction): number => (law.kind === "throttle" ? Math.ceil(growthTime(law)) + MARGIN : MARGIN * 2);

const memoryCell = (spec: MemorySpec): Cell => {
  const capabilities = capabilitiesOf(spec.law);
  return {
    name: `${spec.plan} ${spec.name}`,
    target: TARGET,
    sysctls: {},
    client: {
      image: { kind: "shipped", name: "harness" },
      command: commandOf(spec.law),
      ...(capabilities.length === 0 ? {} : { capabilities }),
    },
    cgroup: cgroupOf(spec.law.limits),
    probe: { mode: "idle", keepalive: false },
    fault: "none",
    prediction: { detects: null, window: s(windowOf(spec.law)), why: spec.why, memory: spec.law },
    runs: 4,
    environments: 2,
    concurrency: 1,
  };
};

/** These are the laws that the cells check, one cell for each. */
export const MEMORY_SPECS: readonly MemorySpec[] = [
  {
    plan: "MEM.1",
    name: "a growth above memory.high of 100 MiB sleeps for the square of its overage, up to 2 s for each batch",
    why: "each charge above the high is a debt, and the task pays it on its way back to user space: 17 reclaims, then a sleep of the delay of the overage",
    law: throttleLaw(25_600),
  },
  {
    plan: "MEM.2",
    name: "a growth above memory.high of 50 MiB keeps the same law at half the pages",
    why: "the overage is a share of the high, thus a lower high gives the same sleeps at a lower usage",
    law: throttleLaw(12_800),
  },
  {
    plan: "MEM.3",
    name: "the OOM killer of a cgroup at memory.max takes the task with the most resident pages",
    why: "the points of a task are its resident pages and its page tables, and the task with the most points goes",
    law: oomLaw([
      { name: "a", pages: 10_000, adj: 0 },
      { name: "b", pages: 30_000, adj: 0 },
      { name: "c", pages: 15_000, adj: 0 },
    ]),
  },
  {
    plan: "MEM.4",
    name: "an oom_score_adj of -500 moves the choice of the OOM killer from the largest task to the next one",
    why: "the kernel adds the adj times a thousandth of memory.max to the points: -500 takes 25,500 points from the largest task",
    law: oomLaw([
      { name: "a", pages: 25_000, adj: -500 },
      { name: "b", pages: 15_000, adj: 0 },
      { name: "c", pages: 15_000, adj: 0 },
    ]),
  },
  {
    plan: "MEM.5",
    name: "the OOM killer does not take a task at oom_score_adj -1000, even the largest",
    why: "a task at -1000 has no points, thus the OOM killer takes the largest of the others",
    law: oomLaw([
      { name: "a", pages: 30_000, adj: -1000 },
      { name: "b", pages: 12_000, adj: 0 },
      { name: "c", pages: 15_000, adj: 0 },
    ]),
  },
];

export const MEMORY_CELLS: readonly Cell[] = MEMORY_SPECS.map(memoryCell);
