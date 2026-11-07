import { LINUX_TCP } from "@mark1russell7/machines";
import { describe, expect, it } from "vitest";
import { ALL } from "../all.ts";
import { WRITERS, copiesOf } from "../resend.ts";
import type { ConfirmSpec } from "./confirms.ts";
import { CONFIRM_CELLS, CONFIRM_SPECS, CUT_HOLD, HEARTBEAT, confirmCell } from "./confirms.ts";
import { amqpValues } from "./t01.ts";
import { PARTS, RABBIT_CLUSTER, heartbeatEnd } from "./t11.ts";

const cellOf = (plan: string) => {
  const found = CONFIRM_CELLS.find((each) => each.name.startsWith(`${plan} `));
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};
const specOf = (plan: string): ConfirmSpec => {
  const found = CONFIRM_SPECS.find((each) => each.plan === plan);
  if (found === undefined) throw new Error(`no spec ${plan}`);
  return found;
};

describe("the terms of the law of the confirms", () => {
  it("ends the connection at the heartbeat of the client, and after the cut at the default heartbeat", () => {
    const chosen = heartbeatEnd(amqpValues({ heartbeat: HEARTBEAT }));
    expect(chosen.lo).toBeGreaterThan(3);
    expect(chosen.hi).toBeLessThan(CUT_HOLD);
    expect(heartbeatEnd().lo).toBeGreaterThan(2 * CUT_HOLD);
  });

  it("wakes each writer before the first retransmission timeout, thus each publish reaches the leader", () => {
    expect(PARTS.gap.hi + PARTS.commit).toBeLessThan(Number(LINUX_TCP.knobs["tcp_rto_min"]!.default) / 1000);
  });

  it("refuses a hold that ends before the heartbeat, and a default heartbeat inside the backoff", () => {
    expect(() => confirmCell({ ...specOf("T11.confirms.4"), hold: 3 })).toThrow(/no connection closes/);
    expect(() => confirmCell({ ...specOf("T11.confirms.5"), hold: 60 })).toThrow(/before the confirms after the lift/);
  });
});

describe("the cells of SYS-60", () => {
  it("are in the joined catalog, each on the cluster of T11, with four runs on two environments, one at a time", () => {
    expect(CONFIRM_CELLS).toHaveLength(6);
    for (const cell of CONFIRM_CELLS) {
      expect(ALL.some((each) => each.name === cell.name), cell.name).toBe(true);
      expect(cell.name).toMatch(/^T11\.confirms\.\d amqplib-2\.2 to rabbitmq-4\.3 cluster, /);
      expect(cell.cluster).toBe(RABBIT_CLUSTER);
      expect(cell.runs).toBe(4);
      expect(cell.environments).toBe(2);
      expect(cell.concurrency).toBe(1);
    }
  });

  it("gives each cell the band 0 of lost messages, and the writers of its spec with no delay of Nagle", () => {
    for (const spec of CONFIRM_SPECS) {
      const cell = cellOf(spec.plan);
      expect(cell.prediction.group?.lost, spec.plan).toEqual({ low: 0, high: 0 });
      expect(cell.prediction.group?.duplicates, spec.plan).toEqual(spec.copies);
      expect(cell.driverOptions?.["window"], spec.plan).toBe(spec.writers);
      expect(cell.driverOptions?.["noDelay"], spec.plan).toBe(true);
    }
  });

  it("keeps the band of T11 at a leader change with no close: the channel lives, thus no copy", () => {
    for (const plan of ["T11.confirms.1", "T11.confirms.2"]) {
      const { prediction, driverOptions } = cellOf(plan);
      expect(prediction.detects, plan).toBe(true);
      expect(prediction.group?.duplicates, plan).toEqual(copiesOf(WRITERS, 0, true));
      expect(prediction.group?.failover, plan).toBe(true);
      expect(prediction.group?.stages.map((each) => each.stage), plan).toEqual(["elected", "first-write"]);
      expect(driverOptions?.["heartbeat"], plan).toBeUndefined();
    }
  });

  it("counts W copies at the close of the cut of the confirms, with no election, inside the band of the heartbeat", () => {
    const end = heartbeatEnd(amqpValues({ heartbeat: HEARTBEAT }));
    for (const [plan, writers] of [
      ["T11.confirms.3", 1],
      ["T11.confirms.4", WRITERS],
    ] as const) {
      const cell = cellOf(plan);
      const group = cell.prediction.group!;
      expect(cell.prediction.detects, plan).toBeNull();
      expect(cell.faultAt, plan).toEqual({ role: "primary", cuts: "to-clients" });
      expect(cell.clientAt, plan).toBe("leader");
      expect(cell.driverOptions?.["heartbeat"], plan).toBe(HEARTBEAT);
      expect(group.duplicates, plan).toEqual({ low: writers, high: writers });
      expect(group.failover, plan).toBe(false);
      expect(group.quiet, plan).toEqual(["elected"]);
      expect(group.errors?.[0]?.name, plan).toBe("Error");
      expect(group.errors?.[0]?.low.value, plan).toBeCloseTo(end.lo);
      expect(group.errors?.[0]?.high.value, plan).toBeCloseTo(end.hi);
    }
  });

  it("gives the control no close, thus no copy and no error", () => {
    const { prediction, driverOptions } = cellOf("T11.confirms.5");
    expect(driverOptions?.["heartbeat"]).toBeUndefined();
    expect(prediction.group?.duplicates).toEqual({ low: 0, high: 0 });
    expect(prediction.group?.errors).toBeUndefined();
  });

  it("gives the freeze of the node of the client only the bounds of the race, and keeps the band of the election", () => {
    const { prediction } = cellOf("T11.confirms.6");
    expect(prediction.detects).toBeNull();
    expect(prediction.group?.duplicates).toEqual({ low: 0, high: WRITERS });
    expect(prediction.group?.failover).toBe(true);
    expect(prediction.group?.stages.map((each) => each.stage)).toEqual(["elected"]);
  });
});
