import { describe, expect, it } from "vitest";
import { countsOf, fitsWindow, HELD, lawOf, LONG, QUOTA, SHORT, stopsSend, WATCH_CELLS, WATCH_SPECS, WINDOW, type Scenario, type Stall } from "./etcd-watch.ts";

const stall = (writes: number, bytes: number, over: Partial<Stall> = {}): Stall => ({ kind: "stall", writes, bytes, stopped: true, compact: true, ...over });

describe("the law of a watch after a compaction", () => {
  it("cancels a watch below the compact revision, and the test is strict at it", () => {
    const at = (offset: number): Scenario => ({ kind: "resume", before: 5, after: 5, at: offset });
    expect(lawOf(at(-1))).toEqual({ events: 0, canceled: true });
    expect(lawOf(at(0))).toEqual({ events: 6, canceled: false });
    expect(lawOf(at(1))).toEqual({ events: 5, canceled: false });
  });

  it("holds 131 events, and the strict test puts the border between 132 and 133 writes", () => {
    expect(HELD).toBe(131);
    expect(lawOf(stall(HELD, LONG))).toEqual({ events: 131, canceled: false });
    expect(lawOf(stall(HELD + 1, LONG))).toEqual({ events: 132, canceled: false });
    expect(lawOf(stall(HELD + 2, LONG))).toEqual({ events: 131, canceled: true });
    expect(lawOf(stall(300, LONG))).toEqual({ events: 131, canceled: true });
  });

  it("needs the stall and the compaction together", () => {
    const whole = { events: 300, canceled: false };
    expect(lawOf(stall(300, LONG, { compact: false }))).toEqual(whole);
    expect(lawOf(stall(300, LONG, { stopped: false }))).toEqual(whole);
  });

  it("lets the bytes decide: the same count of short writes fits in the window", () => {
    expect(fitsWindow(stall(300, SHORT))).toBe(true);
    expect(fitsWindow(stall(300, LONG))).toBe(false);
    expect(lawOf(stall(300, SHORT))).toEqual({ events: 300, canceled: false });
  });

  it("stops Send only with a value above the quota and the window, and it has no term between the two sizes", () => {
    expect(stopsSend(stall(1, QUOTA + WINDOW))).toBe(true);
    expect(stopsSend(stall(1, QUOTA + WINDOW - 1))).toBe(false);
    expect(stopsSend(stall(1, LONG))).toBe(true);
    expect(() => lawOf(stall(300, 4096))).toThrow(/no term for 300 writes of 4096 bytes/);
  });
});

describe("the counts of a scenario", () => {
  it("gives the events, the error, each cancel and the end", () => {
    const [events, errors, cancels, ends] = countsOf(stall(133, LONG));
    expect(events).toEqual({ what: "the events of the watcher", match: { ev: "event" }, count: 131 });
    expect(errors).toMatchObject({ count: 1, match: { ev: "canceled", where: { offset: 0, compacted: true } } });
    expect(cancels).toMatchObject({ count: 1, match: { ev: "canceled" } });
    expect(ends).toMatchObject({ count: 1, match: { ev: "end", where: { reached: true } } });
    const [whole, none] = countsOf(stall(132, LONG));
    expect(whole).toMatchObject({ count: 132 });
    expect(none).toMatchObject({ count: 0 });
  });
});

describe("the cells of SYS-74", () => {
  it("has one cell for each spec, with the plan first and one target program", () => {
    expect(WATCH_CELLS).toHaveLength(WATCH_SPECS.length);
    expect(new Set(WATCH_CELLS.map((cell) => cell.name)).size).toBe(WATCH_CELLS.length);
    for (const [at, cell] of WATCH_CELLS.entries()) {
      expect(cell.name.startsWith(`WC.${at + 1} `)).toBe(true);
      expect(cell.fault).toBe("none");
      expect(cell.target.command?.slice(0, 2)).toEqual(["node", "/srv/watch.ts"]);
    }
  });

  it("puts WC.4 and WC.5 on the two sides of the border, and passes the scenario to the program", () => {
    const scenarioOf = (at: number) => JSON.parse(WATCH_CELLS[at]!.target.command!.at(-1)!) as Scenario;
    expect(scenarioOf(3)).toEqual({ kind: "stall", writes: 132, bytes: LONG, stopped: true, compact: true });
    expect(scenarioOf(4)).toEqual({ kind: "stall", writes: 133, bytes: LONG, stopped: true, compact: true });
  });
});
