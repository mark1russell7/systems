import { IOREDIS_SENTINEL } from "@mark1russell7/machines";
import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import type { ResendSpec } from "./resend.ts";
import { COMMAND_TIMEOUT, RESEND_CELLS, RESEND_SPECS, SOCKET_TIMEOUT, WRITERS, closesBy, copiesOf, firstCloseOf, latestReadyOf, resendCell } from "./resend.ts";
import { GROUP_RTT_MS, HOLD, MEMBER_SETTINGS, SENTINEL_DEFAULTS, VALKEY_IMAGE, failoverOf } from "./t12.ts";

const cellOf = (plan: string) => {
  const found = RESEND_CELLS.find((each) => each.name.startsWith(`${plan} `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};
const specOf = (plan: string): ResendSpec => {
  const found = RESEND_SPECS.find((each) => each.plan === plan);
  if (found === undefined) throw new Error(`no spec ${plan}`);
  return found;
};

describe("the law of the copies of a resend", () => {
  it("counts W copies at each close from ready, and none when the first copies do not survive", () => {
    expect(copiesOf(1, 1, true)).toEqual({ low: 1, high: 1 });
    expect(copiesOf(4, 1, true)).toEqual({ low: 4, high: 4 });
    expect(copiesOf(4, 2, true)).toEqual({ low: 8, high: 8 });
    expect(copiesOf(4, 1, false)).toEqual({ low: 0, high: 0 });
    expect(copiesOf(4, 0, true)).toEqual({ low: 0, high: 0 });
  });

  it("gives the first close at the socket timer, within a cycle of the fault", () => {
    expect(firstCloseOf()).toEqual({ lo: 0.938, hi: 1.072 });
    expect(firstCloseOf(2)).toEqual({ lo: 1.938, hi: 2.072 });
  });

  it("stays below the 21st close at each hold, thus the flush of the queue does not come", () => {
    expect(closesBy(29)).toBe(10);
    expect(closesBy(HOLD)).toBe(12);
    expect(closesBy(0.5)).toBe(0);
    const max = Number(IOREDIS_SENTINEL.knobs["maxRetriesPerRequest"]!.default);
    for (const spec of RESEND_SPECS) expect(closesBy(spec.hold), spec.plan).toBeLessThanOrEqual(max);
    // a short timer closes more often: the law of closesBy reads the timer
    expect(closesBy(HOLD, 0.1)).toBeGreaterThan(closesBy(HOLD));
  });

  it("gives the last ready after a thaw before commandTimeout, thus the queue goes first", () => {
    expect(latestReadyOf(29)).toBeLessThan(COMMAND_TIMEOUT);
    expect(latestReadyOf(29)).toBeGreaterThan(29 + SOCKET_TIMEOUT + 5);
  });

  it("ends each connect to the old primary before the thaw of the failover cell", () => {
    expect(failoverOf("silence", SENTINEL_DEFAULTS, GROUP_RTT_MS).advertised.hi + SOCKET_TIMEOUT).toBeLessThan(HOLD);
  });
});

describe("the cells of SYS-62", () => {
  it("are in the joined catalog, each with the group of T12 at its defaults and a list", () => {
    expect(RESEND_CELLS).toHaveLength(5);
    for (const cell of RESEND_CELLS) {
      expect(ALL.some((each) => each.name === cell.name), cell.name).toBe(true);
      expect(cell.name).toMatch(/^T12\.resend\.\d+ freeze-process at the primary, .*RPUSH, /);
      expect(cell.group?.image).toBe(VALKEY_IMAGE);
      expect(cell.group?.memberSettings).toBe(MEMBER_SETTINGS);
      expect(cell.probe.driver).toMatchObject({ name: "ioredis", op: "rpush" });
      expect(cell.runs).toBe(4);
      expect(cell.environments).toBe(2);
      expect(cell.concurrency).toBe(1);
    }
  });

  it("gives W copies inside the failover timer, at one writer and at four", () => {
    for (const [plan, writers] of [["T12.resend.1", 1], ["T12.resend.2", WRITERS]] as const) {
      const cell = cellOf(plan);
      expect(cell.probe.driver).toMatchObject({ window: writers });
      expect(cell.driverOptions).toEqual({ socketTimeout: 1000 });
      expect(cell.prediction).toMatchObject({ detects: null, from: "fault" });
      expect(cell.prediction.group).toMatchObject({
        lands: "same",
        failover: false,
        stages: [],
        duplicates: { low: writers, high: writers },
        errors: [{ name: "Error", low: { value: 0.938, unit: "s" }, high: { value: 1.072, unit: "s" } }],
      });
    }
  });

  it("gives no copy when the first copies die with the old primary, and keeps the stages of the failover", () => {
    const cell = cellOf("T12.resend.3");
    expect(cell.prediction).toMatchObject({ detects: null, from: "fault" });
    expect(cell.prediction.group).toMatchObject({ lands: "new", failover: true, duplicates: { low: 0, high: 0 } });
    expect(cell.prediction.group?.stages.length).toBeGreaterThan(0);
  });

  it("keeps the band of T12.border-off.1 for the control with no close", () => {
    const control = cellOf("T12.resend.4");
    const recorded = ALL.find((each) => each.name.startsWith("T12.border-off.1 "));
    expect(control.driverOptions).toBeUndefined();
    expect(control.prediction).toMatchObject({ detects: true, low: { value: 29 } });
    expect(control.prediction).toMatchObject({ low: recorded?.prediction.detects === true ? recorded.prediction.low : null });
    expect(control.prediction.group).toMatchObject({ lands: "same", failover: false, duplicates: { low: 0, high: 0 } });
    expect(control.prediction.group?.errors).toBeUndefined();
  });

  it("gives no copy with the resend off, and a timer that frees the writers", () => {
    const cell = cellOf("T12.resend.5");
    expect(cell.driverOptions).toEqual({ socketTimeout: 1000, autoResendUnfulfilledCommands: false, commandTimeout: 40_000 });
    expect(cell.prediction.group).toMatchObject({ lands: "same", failover: false, duplicates: { low: 0, high: 0 } });
  });

  it("refuses a spec where a term of the law does not hold", () => {
    expect(() => resendCell({ ...specOf("T12.resend.5"), options: { socketTimeout: 1000, commandTimeout: 30_000 } })).toThrow(/commandTimeout can come before/);
    expect(() => resendCell({ ...specOf("T12.resend.3"), hold: 33.5 })).toThrow(/outlast the freeze/);
  });

  it("leaves the T12 catalog with its keys and one writer", () => {
    const t12 = ALL.filter((each) => /^T12\.(defaults|border-off|writes)\./.test(each.name));
    expect(t12.length).toBeGreaterThan(0);
    for (const cell of t12) expect(cell.probe.driver).toEqual({ name: "ioredis", keepAlive: { value: 30, unit: "s" } });
  });
});
