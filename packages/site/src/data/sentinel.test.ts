import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sentinel from "./sentinel-2026-10-17.json";

type Cell = (typeof sentinel.cells)[number];

const cell = (plan: string | null, name: string): Cell => {
  const found = sentinel.cells.find((each) => each.plan === plan && each.name === name);
  if (found === undefined) throw new Error(`no cell ${plan} ${name}`);
  return found;
};
const stage = (each: Cell, name: string) => each.stages.find((one) => one.stage === name);
const decisions = (decision: string) => sentinel.cells.filter((each) => each.decision === decision);
const FIN = cell("T12.defaults.8", "fin at the primary");
const PLANNED = cell("T12.defaults.9", "event:planned, SENTINEL FAILOVER");
const COORDINATED = cell("T12.defaults.9", "event:planned, SENTINEL FAILOVER COORDINATED");
const FREEZE = cell("T12.defaults.7", "freeze-process at the primary, 40 s");
const SPLIT = cell("T12.defaults.1", "partition:partial, the primary cut from the Sentinels and the replicas, its clients with it, 40 s");
const CALIBRATION = cell(null, "the stamps of the observer of the Sentinels, event:planned SENTINEL FAILOVER");

describe("the copy of the T12 cells holds the figures of their CI runs", () => {
  it("has 13 cells on Linux 6.17 at HZ 1000: 9 hold and 4 are measurements only", () => {
    expect([sentinel.kernel, sentinel.hz, sentinel.target, sentinel.quorum]).toEqual(["6.17.0", 1000, "valkey/valkey:9.1", 2]);
    expect(sentinel.cells).toHaveLength(13);
    expect(decisions("holds")).toHaveLength(9);
    expect(decisions("measured").map((each) => each.plan ?? each.catalog)).toEqual(["T12.defaults.1", "T12.defaults.6", "T12.defaults.9", "CAL"]);
    expect(sentinel.cells.filter((each) => each.prediction.kind === "measured")).toHaveLength(4);
    const count = (group: string) => sentinel.cells.filter((each) => each.group === group).length;
    expect([count("defaults"), count("border"), count("calibration")]).toEqual([8, 4, 1]);
  });

  it("has 11 counted runs for each cell over 2 environments, after a warm-up in each environment, and no void run", () => {
    for (const each of sentinel.cells) {
      expect(each.runs.flat()).toHaveLength(11);
      expect([each.counted, each.voided, each.voids]).toEqual([11, 0, null]);
      expect(each.runs).toHaveLength(2);
      expect(each.warmups.filter((t) => t !== null)).toHaveLength(2);
    }
  });

  it("gives the failover of a crash, a refusal and a planned failover in their bands", () => {
    expect([FIN.median, FIN.band]).toEqual([32.574067, { low: 31.349, high: 39.348 }]);
    expect(stage(FIN, "+sdown")?.median).toBe(30.05415);
    expect(stage(FIN, "+switch-master")?.median).toBe(30.915655);
    expect(cell("T12.defaults.10", "rst at the primary: each peer refused").median).toBe(32.668267);
    expect(PLANNED.median).toBe(11.409228);
    expect(stage(PLANNED, "+switch-master")?.median).toBe(1.176676);
    expect(stage(PLANNED, "+convert-to-slave")?.median).toBe(11.235746);
    expect(COORDINATED.median).toBe(1.24868);
    // each stage that has a band holds, in each cell
    expect(sentinel.cells.flatMap((each) => each.stages.filter((one) => one.decision !== null && one.decision !== "holds"))).toEqual([]);
  });

  it("keeps a frozen primary until its conversion, and loses the writes that it accepts after the thaw", () => {
    expect(FREEZE.median).toBe(50.205055);
    expect(stage(FREEZE, "+convert-to-slave")?.median).toBe(50.029507);
    expect(FREEZE.writes.lost).toEqual({ runs: 11, total: 2189, median: 199, max: 199 });
    expect(cell("T12.border-off.2", "freeze-process at the primary, 33 s, outside down-after-milliseconds 30 s").writes.lost.median).toBe(199);
    const inside = cell("T12.border-off.1", "freeze-process at the primary, 29 s, inside down-after-milliseconds 30 s");
    expect([inside.median, inside.writes.lost.total, inside.writes.moved]).toEqual([29.003193, 0, 0]);
  });

  it("loses writes in a plain failover and in a split brain, and none in a coordinated failover", () => {
    expect(PLANNED.writes.lost.median).toBe(219);
    expect(COORDINATED.writes.lost.total).toBe(0);
    expect([SPLIT.median, SPLIT.writes.lost.median, SPLIT.writes.moved]).toEqual([52.780188, 1041, 11]);
    expect(cell("T12.defaults.6", "blackhole at the primary, 40 s").writes.lost.total).toBe(8);
    expect(cell("T12.defaults.1", "partition:partial, the primary cut from the clients, a 40 s stall").median).toBe(52.736977);
  });

  it("meets MaxRetriesPerRequestError only outside the give-up of the offline queue", () => {
    const inside = cell("T12.border-off.15", "fin at the primary, down-after-milliseconds 69 s, inside the give-up of the offline queue");
    const outside = cell("T12.border-off.16", "fin at the primary, down-after-milliseconds 76 s, outside the give-up of the offline queue");
    expect([inside.median, outside.median]).toEqual([73.464973, 78.640692]);
    expect(inside.writes.errors.map((each) => each.name)).not.toContain("MaxRetriesPerRequestError");
    expect(outside.writes.errors.find((each) => each.name === "MaxRetriesPerRequestError")).toEqual({ name: "MaxRetriesPerRequestError", runs: 11, first: 73.494415 });
  });

  it("gives the delay of the stamps, and the error of the first calibration that the stage bands include", () => {
    expect(sentinel.stamps).toEqual({ count: 402, median: 0.000254, p99: 0.000815, max: 0.001003 });
    expect(sentinel.stampBound).toBe(0.000705);
    expect(CALIBRATION.decision).toBe("measured");
    expect(sentinel.cells.filter((each) => each.first !== null)).toEqual([]);
  });

  it("names no machine: no boot id, image digest, namespace inode, address, user or path", () => {
    const text = readFileSync(new URL("./sentinel-2026-10-17.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft/i);
  });
});
