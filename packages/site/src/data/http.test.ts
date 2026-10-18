import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import http from "./http-2026-10-17.json";

type Cell = (typeof http.cells)[number];

const cell = (plan: string | null, name: string): Cell => {
  const found = http.cells.find((each) => each.plan === plan && each.name === name);
  if (found === undefined) throw new Error(`no cell ${plan} ${name}`);
  return found;
};
const decisions = (decision: string) => http.cells.filter((each) => each.decision === decision);
const requests = (each: Cell) => Object.fromEntries(each.requests.map(({ outcome, count }) => [outcome, count]));

describe("the copy of the HTTP cells holds the figures of their CI runs", () => {
  it("has 39 cells on Linux 6.17 at HZ 1000: 38 hold and 1 is a measurement only", () => {
    expect([http.kernel, http.hz, http.target]).toEqual(["6.17.0", 1000, "node:24.21.0-alpine"]);
    expect(http.cells).toHaveLength(39);
    expect([decisions("holds").length, decisions("fails").length, decisions("measured").length]).toEqual([38, 0, 1]);
    const count = (group: string) => http.cells.filter((each) => each.group === group).length;
    expect([count("race"), count("faults"), count("router")]).toEqual([21, 8, 10]);
    expect(http.cells.reduce((sum, each) => sum + each.counted, 0)).toBe(429);
    expect(http.cells.reduce((sum, each) => sum + each.voided, 0)).toBe(0);
  });

  it("has 11 runs for each cell, and no void run", () => {
    for (const each of http.cells) {
      expect(each.counted + each.voided).toBe(11);
      expect(each.runs.flat()).toHaveLength(each.counted);
      expect(each.voids).toBeNull();
    }
  });

  it("holds the 4 cells of the pools of Node, with the time of handling in each band", () => {
    const late = cell("T01.border-off.124", "undici, keepAliveTimeoutThreshold 100 ms against a hint of 6 (outside O01), a GET 5.95 s after the reply");
    expect([late.decision, late.median, late.band]).toEqual(["holds", 5.912582, { low: 5.897, high: 5.920082 }]);
    expect([cell(null, "agent, keepAliveTimeout 1500 ms (a hint of 1), a GET 1 s after the reply").median, cell(null, "undici, keepAliveTimeout 2500 ms (a hint of 2), a GET 1 s after the reply").median]).toEqual([0.002505, 0.005623]);
    expect(cell(null, "undici, a GET 4 s after the reply, between C (3 s) and S (6 s)").median).toBe(3.007806);
    expect(cell(null, "agent, a GET 5 s after the reply, between C (4 s) and S (6 s)").median).toBe(4.006284);
  });

  it("races Go at the defaults, and gives the second requests of the gap of 6 s", () => {
    expect(cell("T01.defaults.77", "go, a GET 3 s after the reply").ordering).toBe("kept");
    expect(cell("T01.defaults.77", "go, a GET 6.5 s after the reply").median).toBe(6.000288);
    const crossing = cell("T01.defaults.77", "go, a GET 6 s after the reply");
    expect([crossing.decision, crossing.median]).toEqual(["measured", 6.000876]);
    expect(requests(crossing)).toEqual({ "new, a reply": 9, "reused, a retry, a reply": 2 });
    expect(requests(cell("T01.defaults.77", "go, a GET 5.95 s after the reply, 100 ms latency"))).toEqual({ "reused, a retry, a reply": 11 });
    expect(requests(cell("T01.defaults.77", "go, a POST 5.95 s after the reply, 100 ms latency"))).toEqual({ "reused, EOF": 11 });
  });

  it("holds each border of O01: a GET before C on the same connection, and a GET after C on a new one", () => {
    const borders = [...new Set(http.cells.flatMap((each) => (each.plan?.includes(".border-off.") === true ? [each.plan] : [])))];
    expect(borders).toEqual(["T01.border-off.129", "T01.border-off.130", "T01.border-off.121", "T01.border-off.122", "T01.border-off.123", "T01.border-off.124"]);
    for (const plan of borders) {
      const pair = http.cells.filter((each) => each.plan === plan);
      expect(pair.map((each) => each.ordering)).toEqual(["kept", "dropped"]);
      expect(requests(pair[0]!)).toEqual({ "reused, a reply": 11 });
      expect(requests(pair[1]!)).toEqual({ "new, a reply": 11 });
    }
  });

  it("gives one run of each cell, and Go sends a GET again after a reset on a reused connection", () => {
    expect(http.cells.filter((each) => each.first !== null)).toEqual([]);
    expect(requests(cell("T01.defaults.79", "go, a GET in flight, rst"))).toEqual({ "reused, a retry, ECONNREFUSED": 11 });
  });

  it("gives the timers of the clients before the keepalive of the kernel", () => {
    expect(cell("T03.defaults.63", "go idle, blackhole at the router toward the client, Go timers scaled by 10").median).toBe(9.007373);
    expect(cell("T01.defaults.34", "undici, a GET in flight, freeze-process, headersTimeout 10 s").median).toBe(10.187266);
    const held = cell("T01.defaults.80", "go, app-stall: a reply that the server holds for 60 s");
    expect([held.median, held.prediction.window, requests(held)]).toEqual([null, 20, { "reused, pending": 11 }]);
  });

  it("names no machine: no boot id, image digest, namespace inode, address, user or path", () => {
    const text = readFileSync(new URL("./http-2026-10-17.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft/i);
  });
});
