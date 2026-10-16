import { algebraProblems, machineProblems, timerOf } from "@mark1russell7/algebra";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { HZ } from "./catalog.ts";
import { IOREDIS_SENTINEL } from "./ioredis-sentinel.ts";
import { SENTINEL } from "./sentinel.ts";
import {
  SENTINEL_DEFAULTS,
  T12_CAL,
  T12_CELLS,
  T12_SPECS,
  T12_WAITING,
  VALKEY_IMAGE,
  failoverOf,
  firstAfter,
  flushOf,
  ioredisValues,
  ladderOf,
  sentinelValues,
} from "./t12.ts";

const named = (name: string) => {
  const found = T12_CELLS.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};
const round = (value: number) => Math.round(value * 1e6) / 1e6;

describe("the machine documents of T12", () => {
  it("parses each document, and each has no problem for the checker or for the algebra", () => {
    for (const doc of [SENTINEL, IOREDIS_SENTINEL]) {
      expect(machineProblems(doc), doc.id).toEqual([]);
      expect(algebraProblems(doc), doc.id).toEqual([]);
    }
  });

  it("gives the timers of Valkey 9.1's Sentinel at its defaults, from src/sentinel.c", () => {
    const values = sentinelValues(SENTINEL_DEFAULTS);
    const timer = (name: string) => {
      const bounds = timerOf(SENTINEL, name, values);
      return [bounds.duration, bounds.early ?? null, bounds.lateness ?? null].map((each) => (each === null || "unknown" in each ? null : each.value));
    };
    // a tick is 1000 / hz ms with hz from 10 to 19: 52 to 100 ms
    expect(timer("tick")).toEqual([100, 48, null]);
    expect(timer("ping")).toEqual([1000, null, 100]);
    expect(timer("down_after")).toEqual([30000, null, 101]);
    expect(timer("info")).toEqual([10000, null, 100]);
    expect(timer("info_failover")).toEqual([1000, null, 100]);
    expect(timer("election")).toEqual([10000, null, 100]);
    expect(timer("retry")).toEqual([360000, null, null]);
    expect(timer("convert")).toEqual([8000, null, null]);
    expect(timer("low_activity")).toEqual([15000, null, 100]);
  });

  it("gives the reconnect ladder of ioredis 6.0.0, and the give-up of its offline queue at the 21st close", () => {
    const values = ioredisValues(0);
    const waits = Array.from({ length: 20 }, (_, fired) => timerOf(IOREDIS_SENTINEL, "retry_delay", values, fired).duration);
    expect(waits.slice(0, 9).map((each) => ("unknown" in each ? null : each.value))).toEqual([0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 5, 5]);
    // the sum of the first 20 waits: the queue goes 71.35 s after the first close at the earliest, and 75.9 s at the latest
    const flush = flushOf(ladderOf({ lo: 0, hi: 0 }, 0, 64), 0);
    expect(round(flush.lo)).toBe(71.35);
    // each wait can be 199 ms and a step of the event loop late, and each of the 20 connects that fail a step late too
    expect(round(flush.hi)).toBe(round(71.35 + 20 * 0.209 + 20 * 0.01));
  });
});

describe("the T12 catalog", () => {
  it("names each cell by the plan's cell that it stands for, once, and pins the group's image", () => {
    expect(new Set(ALL.map((each) => each.name)).size).toBe(ALL.length);
    for (const cell of T12_CELLS) {
      expect(cell.name, cell.name).toMatch(/^T12\.(defaults|border-off)\.\d+ /);
      expect(cell.group?.image).toBe(VALKEY_IMAGE);
      expect(cell.group?.quorum).toBe(2);
      expect(cell.prediction.group, cell.name).toBeDefined();
    }
    expect(VALKEY_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(T12_CAL.calibrates).toBe("sentinels");
    // each trigger of the plan's T12 cells over valkey-9.1-sentinel: a cell, or a reason to wait
    const triggers = new Set(T12_SPECS.filter((spec) => spec.plan.startsWith("T12.defaults")).map((spec) => spec.plan));
    expect([...triggers].sort()).toEqual(["T12.defaults.1", "T12.defaults.10", "T12.defaults.6", "T12.defaults.7", "T12.defaults.8", "T12.defaults.9"]);
    expect(T12_WAITING.map((each) => each.plan)).toEqual(["T12.defaults.11"]);
  });

  it("composes a failover of 30 to 33 s at the defaults: down-after, the agreement, the election and the promotion", () => {
    const silence = failoverOf("silence", SENTINEL_DEFAULTS, 1);
    expect(round(silence.sdown!.lo)).toBe(30);
    expect(round(silence.advertised.hi)).toBe(32.807);
    // a primary that closes its links: its Sentinels reconnect at their next tick, and the failover ends a ping period sooner
    expect(round(failoverOf("closes", SENTINEL_DEFAULTS, 1).advertised.hi)).toBe(31.808);
    // a request needs no down state and no votes
    expect(round(failoverOf("request", SENTINEL_DEFAULTS, 1).promoted.hi)).toBe(1.403);
  });

  it("predicts each band from the documents, and makes the pinned cells measurement-only with their reason", () => {
    const band = (name: string) => {
      const p = named(name).prediction;
      return p.detects === true ? [p.low.value, p.high.value] : p.detects === false ? [p.recovers!.low.value, p.recovers!.high.value] : p.why;
    };
    expect(band("T12.defaults.8 fin at the primary")).toEqual([31.35, 39.347]);
    expect(band("T12.defaults.10 rst at the primary: each peer refused")).toEqual([31.35, 39.397]);
    expect(band("T12.defaults.7 freeze-process at the primary, 40 s")).toEqual([50.05, 50.403]);
    expect(band("T12.defaults.9 event:planned, SENTINEL FAILOVER")).toEqual([10.154, 12.013]);
    // the stall reads the RTO ladder of the kernel, rounded on its timer wheel: it moves with HZ.
    // The bands of the Sentinels and of ioredis read no HZ of the kernel
    const stall = band("T12.defaults.1 partition:partial, the primary cut from the clients, a 40 s stall");
    if (HZ === 250) expect(stall).toEqual([52.188, 55.145]);
    if (HZ === 1000) expect(stall).toEqual([51.447, 53.209]);
    expect(band("T12.defaults.6 blackhole at the primary, 40 s")).toMatch(/^the client stays on the old primary/);
    expect(band("T12.defaults.1 partition:partial, the primary cut from the Sentinels and the replicas, its clients with it, 40 s")).toMatch(/^a split brain/);
    // the partition from the clients does not fail over, and the client stays on the same primary
    expect(named("T12.defaults.1 partition:partial, the primary cut from the clients, a 40 s stall").prediction.group).toMatchObject({ lands: "same", failover: false });
  });

  it("puts a primary silence on each side of down-after-milliseconds", () => {
    const inside = named("T12.border-off.1 freeze-process at the primary, 29 s, inside down-after-milliseconds 30 s").prediction;
    expect(inside).toMatchObject({ detects: true, low: { value: 29 }, group: { lands: "same", failover: false, stages: [] } });
    const outside = named("T12.border-off.2 freeze-process at the primary, 33 s, outside down-after-milliseconds 30 s").prediction;
    expect(outside).toMatchObject({ detects: true, low: { value: 43.05 }, group: { lands: "new", failover: true } });
  });

  it("puts the failover on each side of the give-up of the offline queue: 69 s keeps the queue, 76 s fails it first", () => {
    const inside = named("T12.border-off.15 fin at the primary, down-after-milliseconds 69 s, inside the give-up of the offline queue").prediction;
    expect(inside.group?.errors).toBeUndefined();
    const outside = named("T12.border-off.16 fin at the primary, down-after-milliseconds 76 s, outside the give-up of the offline queue").prediction;
    expect(outside.group?.errors).toEqual([{ name: "MaxRetriesPerRequestError", low: { value: 71.35, unit: "s" }, high: { value: 75.942, unit: "s" } }]);
    // the defaults: a failover of 30 to 33 s against a give-up at 71.35 s, so the queue survives the failover
    const ladder = ladderOf({ lo: 0, hi: 0.011 }, 1, 64);
    const { last } = firstAfter(ladder, failoverOf("closes", SENTINEL_DEFAULTS, 1).advertised, 1);
    expect(last).toBeLessThan(20);
  });
});
