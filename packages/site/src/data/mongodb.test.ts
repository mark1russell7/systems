import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import mongodb from "./mongodb-2026-10-18.json";

type Cell = (typeof mongodb.cells)[number];

const cell = (plan: string, name: string): Cell => {
  const found = mongodb.cells.find((each) => each.plan === plan && each.name === name);
  if (found === undefined) throw new Error(`no cell ${plan} ${name}`);
  return found;
};
const decisions = (decision: string) => mongodb.cells.filter((each) => each.decision === decision);
/** This function gives the times of the counted runs of a cell outside its band. */
const outside = (each: Cell): number[] =>
  each.runs.flat().flatMap((t) => (t === null || each.band === null || (t >= each.band.low && t <= each.band.high) ? [] : [t])).sort((a, b) => a - b);

describe("the copy of the MongoDB cells holds the figures of their CI run", () => {
  it("has 58 cells on Linux 6.17 at HZ 1000, each holds, with 638 counted runs and no void run", () => {
    expect([mongodb.kernel, mongodb.hz, mongodb.target, mongodb.client]).toEqual(["6.17.0", 1000, "mongo:9.0.4", "mongodb 7.7.0 on Node 24.21.0"]);
    expect(mongodb.cells).toHaveLength(58);
    expect([decisions("holds").length, decisions("fails").length]).toEqual([58, 0]);
    expect(mongodb.cells.reduce((sum, each) => sum + each.counted, 0)).toBe(638);
    expect(mongodb.cells.reduce((sum, each) => sum + each.voided, 0)).toBe(0);
    const count = (group: string, stage: string) => mongodb.cells.filter((each) => each.group === group && each.stage === stage).length;
    expect([count("T01", "defaults"), count("T01", "border"), count("T03", "defaults"), count("T03", "border"), count("T11", "defaults"), count("T11", "border")]).toEqual([8, 18, 9, 6, 7, 10]);
  });

  it("gives the write-off of the monitor after an ICMP host unreachable as a later band, with each time in its band", () => {
    const direct = cell("T01.defaults.42", "unreachable-host, idle");
    const router = cell("T03.defaults.3", "unreachable-host at the router, idle, Azure LB with TCP reset");
    expect([direct.median, router.median]).toEqual([133.039225, 133.145687]);
    for (const each of [direct, router]) {
      expect(outside(each)).toEqual([]);
      expect(each.prediction.text).toMatch(/Then the monitor writes the server off at the timeout of its stream with MongoNetworkTimeoutError: 49\.999 s to 50\.033 s after the last segment on its socket\.$/);
    }
  });

  it("holds the 5 cells that the first run refuted, each in the band of its new model", () => {
    const bands = [
      cell("T11.defaults.10", "partition:complete, the primary cut from the other members, not from the clients, 40 s"),
      cell("T11.border-off.24", "freeze-process at the primary, 60 s, heartbeatFrequencyMS 2000 and connectTimeoutMS 5000: the write-off before the election"),
      cell("T11.border-off.68", "partition:complete, the primary cut from the other members, 40 s, catchUpTimeoutMillis 0"),
      cell("T11.defaults.1", "event:stepdown, replSetStepDown at the primary"),
      cell("T03.border-off.8", "middlebox-forget, an idle pool connection, keepAliveInitialDelay 13 s, reset-both at 12 s"),
    ];
    expect(bands.map((each) => [each.decision, each.median, each.band?.high, outside(each)])).toEqual([
      ["holds", 17.543638, 26.58, []],
      ["holds", 21.230992, 26.58, []],
      ["holds", 18.332206, 22.365, []],
      ["holds", 0.02769, 1.184, []],
      ["holds", 12.080388, 12.132, []],
    ]);
  });

  it("loses accepted writes only with w 1", () => {
    const lost = mongodb.cells.filter((each) => each.writes !== null && each.writes.lost.total > 0);
    expect(lost.map((each) => [each.plan, each.writes?.lost.median])).toEqual([["T11.border-off.66", 195]]);
    expect(mongodb.cells.filter((each) => each.group === "T11").every((each) => each.writes !== null && each.stages !== null)).toBe(true);
    expect(mongodb.cells.filter((each) => each.group !== "T11").every((each) => each.writes === null && each.stages === null)).toBe(true);
  });

  it("gives the write-off of the monitor, and the kernel before it", () => {
    expect(cell("T01.defaults.1", "blackhole, a write in flight").median).toBe(40.001754);
    expect(cell("T01.border-off.215", "freeze-process 60 s, a write in flight, connectTimeoutMS 1000: the monitor's hello has a timeout").median).toBe(11.002337);
    expect(cell("T01.border-off.216", "freeze-process 60 s, a write in flight, connectTimeoutMS 0: the monitor's hello has no timeout").prediction.kind).toBe("silent");
    expect(cell("T01.border-off.51", "blackhole, a write in flight, tcp_retries2 = 5: the kernel gives up before the monitor's write-off").median).toBe(12.936053);
    expect(cell("T01.border-off.21", "blackhole, a write in flight, keepAliveInitialDelay 27 s: the keepalive ends the monitor's stream before its write-off").median).toBe(37.255034);
  });

  it("has 11 runs for each cell, and no void run", () => {
    for (const each of mongodb.cells) {
      expect(each.counted + each.voided).toBe(11);
      expect(each.runs.flat()).toHaveLength(each.counted);
      expect(each.voids).toBeNull();
    }
  });

  it("names no machine: no boot id, image digest, namespace inode, address, user or path", () => {
    const text = readFileSync(new URL("./mongodb-2026-10-18.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|WSL|microsoft/i);
  });
});
