import { describe, expect, it } from "vitest";
import { ALL } from "../all.ts";
import { ACKS_CELLS, ACKS_RUNS, ACKS_SPECS, KAFKA_IMAGE, REQUEST_TIMEOUT, WRITERS, acksCell, cycleOf, fenceOf, heartbeatBackOf, lostOf, stepDownOf } from "./acks.ts";

const cellOf = (plan: string) => {
  const found = ACKS_CELLS.find((each) => each.name.startsWith(`${plan} `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};
const specOf = (plan: string) => {
  const found = ACKS_SPECS.find((each) => each.plan === plan);
  if (found === undefined) throw new Error(`no spec ${plan}`);
  return found;
};

describe("the terms of the law of SYS-71", () => {
  it("fences the leader 7 s to 10.125 s after the fault", () => {
    expect(fenceOf()).toEqual({ lo: 7, hi: 10.125 });
  });

  it("gives the step-down inside 1.9 s of the lift, at a setup timeout of 1 s", () => {
    expect(stepDownOf().lo).toBe(0);
    expect(stepDownOf().hi).toBeCloseTo(1.9, 9);
  });

  it("gives one cycle from the interval to the interval and its reply", () => {
    expect(cycleOf()).toEqual({ lo: 0.05, hi: 0.062 });
  });

  it("reads the hold in the band of lost writes", () => {
    expect(lostOf(20)).toEqual({ low: 321, high: 440 });
    expect(lostOf(40)).toEqual({ low: 644, high: 840 });
  });

  it("keeps a heartbeat inside the session for the short hold only", () => {
    expect(heartbeatBackOf(3)).toBe(8.2);
    expect(heartbeatBackOf(4)).toBeGreaterThan(9);
  });
});

describe("the cells of SYS-71", () => {
  it("are in the joined catalog, each with the group of 4.3.2 and one cell at a time", () => {
    expect(ACKS_CELLS).toHaveLength(5);
    for (const cell of ACKS_CELLS) {
      expect(ALL.some((each) => each.name === cell.name), cell.name).toBe(true);
      expect(cell.name).toMatch(/^K1\.acks\.\d kafka-clients-4\.3 to kafka-4\.3 group, /);
      expect(cell.kafka?.image).toBe(KAFKA_IMAGE);
      expect(cell.kafka?.brokers).toHaveLength(3);
      expect(cell.fault).toBe("partition");
      expect(cell.faultAt).toEqual({ role: "primary", cuts: "group" });
      expect(cell.runs).toBe(ACKS_RUNS);
      expect(cell.environments).toBe(2);
      expect(cell.concurrency).toBe(1);
      expect(cell.prediction).toMatchObject({ detects: null, from: "fault" });
    }
  });

  it("has an id of the cluster of 16 bytes", () => {
    expect(Buffer.from(ACKS_CELLS[0]!.kafka!.clusterId, "base64url")).toHaveLength(16);
  });

  it("fixes the setup timeout at one value, thus a failed setup does not double it", () => {
    const { settings } = ACKS_CELLS[0]!.kafka!;
    expect(settings["socket.connection.setup.timeout.ms"]).toBe(settings["socket.connection.setup.timeout.max.ms"]);
  });

  it("predicts the writes of the hold at acks=1, and none at a hold under the fence", () => {
    expect(cellOf("K1.acks.1").prediction.group).toMatchObject({ failover: true, lost: lostOf(20) });
    expect(cellOf("K1.acks.2").prediction.group).toMatchObject({ failover: true, lost: lostOf(40) });
    expect(cellOf("K1.acks.3").prediction.group).toMatchObject({ failover: false, lost: { low: 0, high: 0 } });
    for (const plan of ["K1.acks.1", "K1.acks.2", "K1.acks.3"]) {
      expect(cellOf(plan).driverOptions).toEqual({ acks: "1", "linger.ms": 0 });
      expect(cellOf(plan).prediction.group?.duplicates, plan).toBeUndefined();
    }
  });

  it("predicts no lost write and no copy at acks=all, at a minimum of 2 and of 1", () => {
    expect(cellOf("K1.acks.4").kafka?.minInsync).toBe(2);
    expect(cellOf("K1.acks.5").kafka?.minInsync).toBe(1);
    for (const plan of ["K1.acks.4", "K1.acks.5"]) {
      const cell = cellOf(plan);
      expect(cell.driverOptions).toEqual({ acks: "all", "linger.ms": 0 });
      expect(cell.kafka?.writers).toBe(WRITERS);
      expect(cell.prediction.group).toMatchObject({ failover: true, lost: { low: 0, high: 0 }, duplicates: { low: 0, high: 0 } });
    }
  });

  it("refuses a spec that a term of the law does not hold for", () => {
    expect(() => acksCell({ ...specOf("K1.acks.1"), hold: 10 })).toThrow(/before the fence/);
    expect(() => acksCell({ ...specOf("K1.acks.3"), hold: 5 })).toThrow(/session can expire/);
    expect(() => acksCell({ ...specOf("K1.acks.4"), hold: REQUEST_TIMEOUT - 1 })).toThrow(/request timer/);
  });
});
