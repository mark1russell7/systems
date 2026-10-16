import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import mongodb from "./mongodb-2026-10-16.json";

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
  it("has 58 cells on Linux 6.17 at HZ 1000: 51 hold and 7 fail, with 617 counted runs and 21 void runs", () => {
    expect([mongodb.kernel, mongodb.hz, mongodb.target, mongodb.client]).toEqual(["6.17.0", 1000, "mongo:9.0.4", "mongodb 7.7.0 on Node 24.21.0"]);
    expect(mongodb.cells).toHaveLength(58);
    expect([decisions("holds").length, decisions("fails").length]).toEqual([51, 7]);
    expect(mongodb.cells.reduce((sum, each) => sum + each.counted, 0)).toBe(617);
    expect(mongodb.cells.reduce((sum, each) => sum + each.voided, 0)).toBe(21);
    const count = (group: string, stage: string) => mongodb.cells.filter((each) => each.group === group && each.stage === stage).length;
    expect([count("T01", "defaults"), count("T01", "border"), count("T03", "defaults"), count("T03", "border"), count("T11", "defaults"), count("T11", "border")]).toEqual([8, 18, 9, 6, 7, 10]);
  });

  it("fails 7 cells, each a finding about a model of the catalog", () => {
    expect(decisions("fails").map((each) => each.plan)).toEqual([
      "T01.defaults.42",
      "T03.defaults.3",
      "T03.border-off.8",
      "T11.defaults.1",
      "T11.defaults.10",
      "T11.border-off.24",
      "T11.border-off.68",
    ]);
  });

  it("finds the monitor not quiet under an ICMP host unreachable, with each time in its band", () => {
    const direct = cell("T01.defaults.42", "unreachable-host, idle");
    const router = cell("T03.defaults.3", "unreachable-host at the router, idle, Azure LB with TCP reset");
    expect([direct.median, router.median]).toEqual([133.071908, 133.149183]);
    for (const each of [direct, router]) {
      expect(outside(each)).toEqual([]);
      expect(each.why).toMatch(/Each counted run has a finding: the monitor reported heartbeat-failed 49\.7\d* s after the fault/);
    }
  });

  it("gives the tail of an election, the band of catchUpTimeoutMillis 0, and the two edges", () => {
    expect(outside(cell("T11.defaults.10", "partition:complete, the primary cut from the other members, not from the clients, 40 s"))).toEqual([22.497182, 24.620293]);
    expect(outside(cell("T11.border-off.24", "freeze-process at the primary, 60 s, heartbeatFrequencyMS 2000 and connectTimeoutMS 5000: the write-off before the election"))).toEqual([
      22.112022, 22.38523, 23.23009,
    ]);
    expect(outside(cell("T11.border-off.68", "partition:complete, the primary cut from the other members, 40 s, catchUpTimeoutMillis 0"))).toEqual([
      18.006457, 18.164855, 18.343454, 18.678798, 18.797454,
    ]);
    expect(outside(cell("T11.defaults.1", "event:stepdown, replSetStepDown at the primary"))).toEqual([0.524981]);
    expect(outside(cell("T03.border-off.8", "middlebox-forget, an idle pool connection, keepAliveInitialDelay 13 s, reset-both at 12 s"))).toEqual([12.094537]);
  });

  it("loses accepted writes only with w 1", () => {
    const lost = mongodb.cells.filter((each) => each.writes !== null && each.writes.lost.total > 0);
    expect(lost.map((each) => [each.plan, each.writes?.lost.median])).toEqual([["T11.border-off.66", 195]]);
    expect(mongodb.cells.filter((each) => each.group === "T11").every((each) => each.writes !== null && each.stages !== null)).toBe(true);
    expect(mongodb.cells.filter((each) => each.group !== "T11").every((each) => each.writes === null && each.stages === null)).toBe(true);
  });

  it("gives the write-off of the monitor, and the kernel before it", () => {
    expect(cell("T01.defaults.1", "blackhole, a write in flight").median).toBe(40.002161);
    expect(cell("T01.border-off.215", "freeze-process 60 s, a write in flight, connectTimeoutMS 1000: the monitor's hello has a timeout").median).toBe(11.002408);
    expect(cell("T01.border-off.216", "freeze-process 60 s, a write in flight, connectTimeoutMS 0: the monitor's hello has no timeout").prediction.kind).toBe("silent");
    expect(cell("T01.border-off.51", "blackhole, a write in flight, tcp_retries2 = 5: the kernel gives up before the monitor's write-off").median).toBe(12.824001);
    expect(cell("T01.border-off.21", "blackhole, a write in flight, keepAliveInitialDelay 27 s: the keepalive ends the monitor's stream before its write-off").median).toBe(37.25804);
  });

  it("has each void run through the router, each a timer that the VM delayed", () => {
    for (const each of mongodb.cells) {
      expect(each.counted + each.voided).toBe(11);
      expect(each.runs.flat()).toHaveLength(each.counted);
    }
    const voided = mongodb.cells.filter((each) => each.voided > 0);
    expect(voided.every((each) => each.group === "T03" && each.voids !== null && /behind its wheel slot\. Thus the VM delayed/.test(each.voids))).toBe(true);
    expect(voided.map((each) => each.voided)).toEqual([3, 5, 5, 1, 7]);
  });

  it("names no machine: no boot id, image digest, namespace inode, address, user or path", () => {
    const text = readFileSync(new URL("./mongodb-2026-10-16.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|WSL|microsoft/i);
  });
});
