import { valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { ALL } from "../all.ts";
import { CLASSIC_SESSION_MS, PAUSE_CELLS, PAUSE_RUNS, PAUSE_SPECS, SHORT_SESSION_MS, classicFenceOf, fenceOf, pauseCell, takeoverOf } from "./pause.ts";

const cellOf = (plan: string) => {
  const found = PAUSE_CELLS.find((each) => each.name.startsWith(`${plan} `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};
const specOf = (plan: string) => {
  const found = PAUSE_SPECS.find((each) => each.plan === plan);
  if (found === undefined) throw new Error(`no spec ${plan}`);
  return found;
};

describe("the terms of the law of SYS-72", () => {
  it("fences the member 39.9 s to 46 s after the stop at the defaults", () => {
    expect(fenceOf()).toEqual({ lo: 39.9, hi: 46 });
  });

  it("gives the partition to the other member 39.9 s to 51.5 s after the stop at the defaults", () => {
    expect(takeoverOf()).toEqual({ lo: 39.9, hi: 51.5 });
  });

  it("moves both bands with the session of the broker", () => {
    expect(fenceOf(SHORT_SESSION_MS)).toEqual({ lo: 9.9, hi: 16 });
    expect(takeoverOf(SHORT_SESSION_MS)).toEqual({ lo: 9.9, hi: 21.5 });
  });

  it("fences a classic member 11.9 s to 16 s after the stop", () => {
    expect(CLASSIC_SESSION_MS).toBe(15_000);
    expect(classicFenceOf()).toEqual({ lo: 11.9, hi: 16 });
  });
});

describe("the cells of SYS-72", () => {
  it("has five cells in the catalog, each with four runs and one at a time", () => {
    expect(PAUSE_CELLS.map((each) => each.name.split(" ")[0])).toEqual(["K2.pause.long", "K2.pause.short", "K2.pause.setting", "K2.pause.rejoin", "K2.pause.classic"]);
    for (const each of PAUSE_CELLS) {
      expect(ALL.some((cell) => cell.name === each.name)).toBe(true);
      expect(each.runs).toBe(PAUSE_RUNS);
      expect(each.concurrency).toBe(1);
      expect(each.fault).toBe("freeze-process");
    }
  });

  it("sets the session of the broker only in its cell, and over its minimum", () => {
    const settings = cellOf("K2.pause.setting").kafka!.settings;
    expect(settings["group.consumer.session.timeout.ms"]).toBe("15000");
    expect(Number(settings["group.consumer.min.session.timeout.ms"])).toBeLessThanOrEqual(15_000);
    expect(cellOf("K2.pause.long").kafka!.settings["group.consumer.session.timeout.ms"]).toBeUndefined();
  });

  it("gives the classic session to the client, not to the broker", () => {
    expect(cellOf("K2.pause.classic").driverOptions).toMatchObject({ "session.timeout.ms": 15_000, "heartbeat.interval.ms": 3000 });
    expect(cellOf("K2.pause.classic").kafka!.settings["session.timeout.ms"]).toBeUndefined();
    expect(cellOf("K2.pause.classic").kafka!.pause!.protocol).toBe("classic");
  });

  it("has a law of no fence only below the fence, and a law of a fence only above it", () => {
    expect(specOf("K2.pause.short").law).toMatchObject({ fence: null, takeover: null, thaw: "acknowledged" });
    expect(() => pauseCell({ ...specOf("K2.pause.short"), hold: 40 })).toThrow("the session can end in the stop");
    expect(() => pauseCell({ ...specOf("K2.pause.long"), hold: 45 })).toThrow("the stop can end before the fence");
    expect(() => pauseCell({ ...specOf("K2.pause.setting"), hold: 15 })).toThrow("the stop can end before the fence");
    expect(() => pauseCell({ ...specOf("K2.pause.classic"), hold: 15 })).toThrow("the stop can end before the fence");
  });

  it("has a commit after a poll only in the cell of the rejoin", () => {
    const rejoin = PAUSE_CELLS.filter((each) => each.kafka!.pause!.afterPause === "rejoin");
    expect(rejoin.map((each) => each.name.split(" ")[0])).toEqual(["K2.pause.rejoin"]);
    const prediction = rejoin[0]!.prediction;
    if (prediction.detects !== null || prediction.pause === undefined) throw new Error("no law");
    expect(prediction.pause.thaw).toBe("rejoin");
    expect(valueIn(prediction.pause.rejoinWithin!, "s")).toBe(2);
  });
});
