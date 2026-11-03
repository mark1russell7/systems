import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ALL } from "../all.ts";
import { POOL_CELLS, POOL_GAP_MS, POOL_SPECS, poolCell, poolPrediction, turnsOf } from "./pool.ts";

const spec = (plan: string) => {
  const found = POOL_SPECS.find((each) => each.plan === plan);
  if (found === undefined) throw new Error(`no spec ${plan}`);
  return found;
};

/** the nominal end of each query, from the low end of its band: a hold for each round, and its own arrival */
const lows = (plan: string): readonly number[] => turnsOf(spec(plan)).map((turn) => turn.low);

describe("a pool at its limit", () => {
  it("gives the hold to each query at the size of the pool", () => {
    expect(turnsOf(spec("Q19.pool.1")).map((turn) => turn.ends)).toEqual(["ack", "ack"]);
    expect(lows("Q19.pool.1")).toEqual([1, 1 + POOL_GAP_MS / 1000 - 0.01]);
  });

  it("adds one hold for each size of the pool in the queue", () => {
    expect(lows("Q19.pool.2")).toEqual([1, 1.04, 2, 2.04, 3, 3.04]);
    expect(lows("Q19.pool.3")).toEqual([1, 1.04, 1.09, 2, 2.04, 2.09, 3]);
  });

  it("fails a borrow at its timeout when the queue is longer than the timeout, and serves the queries before it", () => {
    const turns = turnsOf(spec("Q19.pool.4"));
    expect(turns.map((turn) => turn.ends)).toEqual(["ack", "ack", "ack", "ack", "ack", "ack", "fail", "fail"]);
    expect(turns[6]).toEqual({ n: 8, ends: "fail", low: 2.54, high: 2.57 });
    expect(turns[7]).toEqual({ n: 9, ends: "fail", low: 2.59, high: 2.62 });
  });

  it("reads the default of connectionTimeout from the document", () => {
    const turns = turnsOf(spec("Q19.pool.5"));
    expect(turns.slice(-2).map((turn) => turn.low)).toEqual([30.29, 30.34]);
    expect(turns[5]).toMatchObject({ ends: "ack", low: 36.04 });
  });

  it("refuses a query near the timeout of its borrow", () => {
    expect(() => turnsOf({ plan: "edge", name: "edge", size: 2, queries: 8, hold: 1, timeout: 2.7 })).toThrow(/within 0.25 s/);
  });

  it("refuses a hold that ends before the last query arrives", () => {
    expect(() => poolPrediction({ plan: "short", name: "short", size: 2, queries: 8, hold: 0.2 })).toThrow(/not its deepest/);
  });

  it("names each band of a query from the send of the first one, in the order of the numbers", () => {
    const { driver } = poolPrediction(spec("Q19.pool.4"));
    expect(driver?.ends).toEqual({ ev: "ack", where: { n: 2 } });
    expect(driver?.then?.map((step) => step.ends.where?.["n"])).toEqual([3, 4, 5, 6, 7, 8, 9, undefined, undefined]);
    for (const step of driver?.then ?? []) expect(step.from).toBe("request-sent");
    const failure = driver?.then?.find((step) => step.ends.ev === "fail");
    expect(failure).toMatchObject({ name: "SQLTransientConnectionException", ends: { name: "name" } });
  });

  it("sees the deepest queue and the end of the burst with its counts", () => {
    const { driver } = poolPrediction(spec("Q19.pool.4"));
    const steps = driver?.then ?? [];
    expect(steps.at(-2)?.ends).toEqual({ ev: "pool", where: { total: 2, active: 2, idle: 0, waiting: 6 } });
    expect(steps.at(-1)?.ends).toEqual({ ev: "burst", where: { acks: 6, fails: 2, total: 2, active: 0, idle: 2, waiting: 0 } });
    expect(driver?.quiet).toEqual([{ ev: "pool", where: { total: 3 } }]);
  });

  it("says that no query waits at the size of the pool, and that none fails below the timeout", () => {
    expect(poolPrediction(spec("Q19.pool.1")).driver?.quiet).toEqual([{ ev: "pool", where: { total: 3 } }, { ev: "pool", where: { waiting: 1 } }, { ev: "fail" }]);
    expect(poolPrediction(spec("Q19.pool.2")).driver?.quiet).toEqual([{ ev: "pool", where: { total: 3 } }, { ev: "fail" }]);
  });

  it("gives the longest band to the end of the burst", () => {
    const prediction = poolPrediction(spec("Q19.pool.5"));
    const highs = prediction.driver?.then?.map((step) => valueIn(step.high, "s")) ?? [];
    expect(Math.max(...highs)).toBe(highs.at(-1));
    expect(prediction.timer).toBe("connection_timeout");
  });

  it("makes a cell of HikariCP with a burst and the options of its pool", () => {
    const cell = poolCell(spec("Q19.pool.4"));
    expect(cell.name).toBe("Q19.pool.4 hikaricp-pgjdbc to postgresql, 8 queries at a pool of 2, connectionTimeout 2.25 s: the last 2 fail at the timeout");
    expect(cell.fault).toBe("app-stall");
    expect(cell.probe).toMatchObject({ mode: "inflight", driver: { name: "hikari", inflight: "SELECT pg_sleep(1)", burst: { count: 8, gap: { value: 50, unit: "ms" } } } });
    expect(cell.driverOptions).toEqual({ maximumPoolSize: 2, connectionTimeout: 2250 });
    expect(poolCell(spec("Q19.pool.5")).driverOptions).toEqual({ maximumPoolSize: 2 });
  });

  it("is in the catalog", () => {
    for (const cell of POOL_CELLS) expect(ALL).toContain(cell);
  });
});
