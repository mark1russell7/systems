import { memcgSleepBounds, memcgThrottle } from "@mark1russell7/algebra";
import type { Cell, ClientImage, MemoryOomPrediction, MemoryThrottlePrediction } from "@mark1russell7/harness";
import { stepBand } from "@mark1russell7/harness";
import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { HZ } from "./catalog.ts";
import { BASE_MOST, growthTime, MEMORY_CELLS, MEMORY_SPECS, victimOf } from "./memory.ts";

const PAGE = 4096;
const MAX = 51_200;

const imageOf = (cell: Cell): ClientImage => {
  if (typeof cell.client !== "object") throw new Error(`${cell.name} has no client image`);
  return cell.client;
};

const cellOf = (plan: string) => {
  const cell = MEMORY_CELLS.find((each) => each.name.startsWith(`${plan} `));
  if (cell === undefined || cell.prediction.detects !== null || cell.prediction.memory === undefined) throw new Error(`${plan} has no law`);
  return { cell, prediction: cell.prediction, law: cell.prediction.memory };
};

const throttleOf = (plan: string): MemoryThrottlePrediction => {
  const { law } = cellOf(plan);
  if (law.kind !== "throttle") throw new Error(`${plan} is not a throttle`);
  return law;
};

const oomOf = (plan: string): MemoryOomPrediction => {
  const { law } = cellOf(plan);
  if (law.kind !== "oom") throw new Error(`${plan} is not an OOM cell`);
  return law;
};

describe("the cells of the memory controller", () => {
  it("joins the end of the catalog, four counted runs and one cell at a time, on an idle client", () => {
    expect(MEMORY_CELLS).toHaveLength(5);
    expect(ALL.slice(-MEMORY_CELLS.length)).toEqual(MEMORY_CELLS);
    for (const cell of MEMORY_CELLS) {
      expect(cell.runs).toBe(4);
      expect(cell.concurrency).toBe(1);
      expect(cell.probe).toEqual({ mode: "idle", keepalive: false });
      expect(cell.fault).toBe("none");
    }
  });

  it("writes memory.high or memory.max of the cgroup and no swap, in bytes", () => {
    expect(cellOf("MEM.1").cell.cgroup).toEqual({ "memory.high": String(25_600 * PAGE), "memory.swap.max": "0" });
    expect(cellOf("MEM.2").cell.cgroup).toEqual({ "memory.high": String(12_800 * PAGE), "memory.swap.max": "0" });
    for (const plan of ["MEM.3", "MEM.4", "MEM.5"]) expect(cellOf(plan).cell.cgroup).toEqual({ "memory.max": "209715200", "memory.swap.max": "0" });
  });

  it("gives the client its command, the lock of its pages to a throttle, and SYS_RESOURCE to a task below the adj of its parent", () => {
    const one = cellOf("MEM.1").cell;
    expect(imageOf(one).command).toEqual(["/opt/harness/memory", "grow", "--until-pages", String(throttleOf("MEM.1").until), "--step", "64"]);
    expect(imageOf(one).capabilities).toEqual(["IPC_LOCK"]);
    const three = cellOf("MEM.3").cell;
    expect(imageOf(three).command).toEqual(["/opt/harness/memory", "oom", "--task", "a:10000:0", "--task", "b:30000:0", "--task", "c:15000:0"]);
    expect(imageOf(three).capabilities).toBeUndefined();
    expect(imageOf(cellOf("MEM.4").cell).capabilities).toEqual(["SYS_RESOURCE"]);
    expect(imageOf(cellOf("MEM.5").cell).capabilities).toEqual(["SYS_RESOURCE"]);
  });
});

describe("the law of a growth above memory.high", () => {
  it("starts the sleep and the cap where the algebra says, and ends the growth four batches into the cap", () => {
    for (const [plan, high] of [
      ["MEM.1", 25_600],
      ["MEM.2", 12_800],
    ] as const) {
      const law = throttleOf(plan);
      const bounds = memcgSleepBounds(high, 64, HZ);
      expect(law).toMatchObject({ limits: { high, max: null, swap: 0, page: PAGE }, hz: HZ, batch: 64, sleepFrom: bounds.first, capFrom: bounds.capped });
      expect(law.until % 64).toBe(0);
      expect(law.until).toBeGreaterThanOrEqual(bounds.capped + 4 * 64);
      expect(law.until).toBeLessThan(bounds.capped + 5 * 64);
    }
    // a high of 100 MiB at HZ 1000: 1.3% over starts the sleep, and 17.7% over starts the cap
    if (HZ === 1000) expect([throttleOf("MEM.1").sleepFrom, throttleOf("MEM.1").capFrom, throttleOf("MEM.1").until]).toEqual([25_936, 30_126, 30_400]);
  });

  it("has an entry for each batch from one page above the high, with one event near the high and 17 at each sleep", () => {
    const law = throttleOf("MEM.1");
    const first = law.steps[0]!;
    expect(first).toEqual({ usage: 25_601, band: law.quiet, high: 1 });
    const last = law.steps.at(-1)!;
    expect(last.usage).toBeGreaterThanOrEqual(law.capFrom);
    expect(last.usage - 64).toBeLessThan(law.capFrom);
    expect(valueIn(last.band.low, "s")).toBeCloseTo(2 - 1 / HZ, 6);
    expect(last.high).toBe(17);
    for (const [at, step] of law.steps.entries()) {
      expect(step.usage).toBe(25_601 + at * 64);
      expect(step.high).toBe(step.usage >= law.sleepFrom ? 17 : 1);
      const before = law.steps[at - 1];
      if (before !== undefined) expect(valueIn(step.band.low, "s")).toBeGreaterThanOrEqual(valueIn(before.band.low, "s"));
    }
  });

  it("gives each step a band that holds the sleep of each usage from the step to its drift", () => {
    for (const plan of ["MEM.1", "MEM.2"]) {
      const law = throttleOf(plan);
      const high = law.limits.high!;
      for (let usage = high - 100; usage <= law.until + 100; usage += 7) {
        const { band, high: events } = stepBand(law, usage);
        for (const at of [usage, usage + law.drift]) {
          const charge = memcgThrottle([{ usage: at - 64, high }], 1, HZ);
          const slept = charge.jiffies / HZ;
          expect(valueIn(band.low, "s")).toBeLessThanOrEqual(Math.max(0, slept - 1 / HZ) + 1e-9);
          expect(valueIn(band.high, "s")).toBeGreaterThanOrEqual((charge.jiffies + charge.late) / HZ - 1e-9);
          expect(charge.high).toBeGreaterThanOrEqual(events.low);
          expect(charge.high).toBeLessThanOrEqual(events.high);
        }
      }
    }
  });

  it("waits for the longest growth and a margin", () => {
    for (const plan of ["MEM.1", "MEM.2"]) {
      const { prediction } = cellOf(plan);
      const law = throttleOf(plan);
      let sleeps = 0;
      for (let usage = law.limits.high! + 1; usage <= law.until; usage += 64) sleeps += memcgThrottle([{ usage: usage - 64, high: law.limits.high! }], 1, HZ).jiffies / HZ;
      expect(growthTime(law)).toBeGreaterThan(sleeps);
      expect(valueIn(prediction.window, "s")).toBe(Math.ceil(growthTime(law)) + 30);
    }
  });
});

describe("the law of the OOM killer of a cgroup", () => {
  const victims: Record<string, string> = { "MEM.3": "b", "MEM.4": "b", "MEM.5": "b" };

  it("takes one task, and holds each other task", () => {
    for (const [plan, victim] of Object.entries(victims)) {
      const law = oomOf(plan);
      expect(law.limits).toEqual({ high: null, max: MAX, swap: 0, page: PAGE });
      expect(law.kills).toBe(1);
      expect(law.tasks.filter((task) => task.outcome === "killed").map((task) => task.name)).toEqual([victim]);
    }
  });

  it("takes the same task at each count of the other pages of the cgroup up to the most, and the tasks fit before the last and after the kill", () => {
    for (const spec of MEMORY_SPECS) {
      if (spec.law.kind !== "oom") continue;
      const tasks = spec.law.tasks;
      const chosen = victimOf(tasks, 0);
      for (let base = 0; base <= BASE_MOST; base += 250) expect(victimOf(tasks, base)).toBe(chosen);
      const all = tasks.reduce((sum, task) => sum + task.pages, 0);
      expect(all).toBeGreaterThan(MAX);
      expect(all - tasks.at(-1)!.pages + BASE_MOST).toBeLessThan(MAX);
      expect(all - tasks[chosen!]!.pages + BASE_MOST).toBeLessThan(MAX);
    }
  });

  it("moves the choice with oom_score_adj: the largest task goes when its adj is 0", () => {
    const four = MEMORY_SPECS.find((spec) => spec.plan === "MEM.4")!.law as MemoryOomPrediction;
    expect(victimOf(four.tasks.map((task) => ({ ...task, adj: 0 })), 2_000)).toBe(0);
    const five = MEMORY_SPECS.find((spec) => spec.plan === "MEM.5")!.law as MemoryOomPrediction;
    expect(victimOf(five.tasks.map((task) => ({ ...task, adj: 0 })), 2_000)).toBe(0);
  });
});
