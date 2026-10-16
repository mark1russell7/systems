import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import http from "./http-2026-10-16.json";

type Cell = (typeof http.cells)[number];

const cell = (plan: string | null, name: string): Cell => {
  const found = http.cells.find((each) => each.plan === plan && each.name === name);
  if (found === undefined) throw new Error(`no cell ${plan} ${name}`);
  return found;
};
const decisions = (decision: string) => http.cells.filter((each) => each.decision === decision);
const requests = (each: Cell) => Object.fromEntries(each.requests.map(({ outcome, count }) => [outcome, count]));

describe("the copy of the HTTP cells holds the figures of their CI runs", () => {
  it("has 39 cells on Linux 6.17 at HZ 1000: 34 hold, 4 fail and 1 is a measurement only", () => {
    expect([http.kernel, http.hz, http.target]).toEqual(["6.17.0", 1000, "node:24.21.0-alpine"]);
    expect(http.cells).toHaveLength(39);
    expect([decisions("holds").length, decisions("fails").length, decisions("measured").length]).toEqual([34, 4, 1]);
    const count = (group: string) => http.cells.filter((each) => each.group === group).length;
    expect([count("race"), count("faults"), count("router")]).toEqual([21, 8, 10]);
    expect(http.cells.reduce((sum, each) => sum + each.counted, 0)).toBe(422);
    expect(http.cells.reduce((sum, each) => sum + each.voided, 0)).toBe(7);
  });

  it("has 11 runs for each cell, and the void runs only through the router, each a timer that the VM delayed", () => {
    for (const each of http.cells) {
      expect(each.counted + each.voided).toBe(11);
      expect(each.runs.flat()).toHaveLength(each.counted);
      expect(each.voids === null).toBe(each.voided === 0);
    }
    expect(http.cells.filter((each) => each.voided > 0).map((each) => each.plan)).toEqual(["T03.defaults.33", "T03.defaults.37", "T03.defaults.63", "T03.defaults.64"]);
    expect(http.cells.every((each) => each.voids === null || /behind its wheel slot\. Thus the VM delayed/.test(each.voids))).toBe(true);
  });

  it("fails 4 cells on the late idle timer of the pools of Node", () => {
    expect(decisions("fails").map((each) => [each.client, each.median])).toEqual([
      ["undici", 5.912431],
      ["undici", 3.008559],
      ["agent", 0.004337],
      ["undici", 0.0044],
    ]);
    const late = cell("T01.border-off.124", "undici, keepAliveTimeoutThreshold 100 ms against a hint of 6 (outside O01), a GET 5.95 s after the reply");
    expect(late.band).toEqual({ low: 5.894, high: 5.9119 });
    expect(late.why).toMatch(/^3 of the 11 counted runs are in the band/);
    // a pool whose C is 0 closes in its band, but its median is outside the prediction with its margin
    expect(cell(null, "agent, keepAliveTimeout 1500 ms (a hint of 1), a GET 1 s after the reply").why).toMatch(/Thus the cell fails on its median\.$/);
    expect(cell(null, "agent, a GET 5 s after the reply, between C (4 s) and S (6 s)").median).toBe(4.008944);
  });

  it("races Go at the defaults, and gives the second requests of the gap of 6 s", () => {
    expect(cell("T01.defaults.77", "go, a GET 3 s after the reply").ordering).toBe("kept");
    expect(cell("T01.defaults.77", "go, a GET 6.5 s after the reply").median).toBe(6.000134);
    const crossing = cell("T01.defaults.77", "go, a GET 6 s after the reply");
    expect([crossing.decision, crossing.median]).toEqual(["measured", 6.001201]);
    expect(requests(crossing)).toEqual({ "reused, a reply": 3, "new, a reply": 6, "reused, a retry, a reply": 2 });
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

  it("shows the second run of the 5 cells of Go that the harness repeated after its fix", () => {
    const repeated = http.cells.filter((each) => each.first !== null);
    expect(repeated.map((each) => each.plan)).toEqual(["T01.defaults.4", "T01.defaults.79", "T03.defaults.30", "T03.defaults.63", "T03.defaults.64"]);
    for (const each of repeated) expect([each.client, each.first, each.decision, each.repeated === null]).toEqual(["go", "fails", "holds", false]);
    expect(requests(cell("T01.defaults.79", "go, a GET in flight, rst"))).toEqual({ "reused, a retry, ECONNREFUSED": 11 });
  });

  it("gives the timers of the clients before the keepalive of the kernel", () => {
    expect(cell("T03.defaults.63", "go idle, blackhole at the router toward the client, Go timers scaled by 10").median).toBe(9.008236);
    expect(cell("T01.defaults.34", "undici, a GET in flight, freeze-process, headersTimeout 10 s").median).toBe(10.187242);
    const held = cell("T01.defaults.80", "go, app-stall: a reply that the server holds for 60 s");
    expect([held.median, held.prediction.window, requests(held)]).toEqual([null, 20, { "reused, pending": 11 }]);
  });

  it("names no machine: no boot id, image digest, namespace inode, address, user or path", () => {
    const text = readFileSync(new URL("./http-2026-10-16.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft/i);
  });
});
