import { describe, expect, it } from "vitest";
import pg from "./pg-2026-10-18.json";

type Cell = (typeof pg.cells)[number];

const cell = (plan: string): Cell => {
  const found = pg.cells.find((each) => each.plan === plan);
  if (found === undefined) throw new Error(`no cell ${plan}`);
  return found;
};
/** This function gives the times of the counted runs of a cell outside its band. */
const outside = (each: Cell): number[] =>
  each.runs.flat().flatMap((t) => (t === null || each.band === null || (t >= each.band.low && t <= each.band.high) ? [] : [t])).sort((a, b) => a - b);

describe("the copy of the PostgreSQL cells holds the figures of their CI run", () => {
  it("has 65 cells on Linux 6.17 at HZ 1000, each holds, with 715 counted runs and no void run", () => {
    expect([pg.kernel, pg.hz, pg.target]).toEqual(["6.17.0", 1000, "postgres:17.11"]);
    expect(pg.clients).toEqual({ "node-postgres": "pg 8.23.1 with pg-pool 3.14.0 on Node 24.21.0", HikariCP: "HikariCP 7.1.0 over pgjdbc 42.7.13 on Temurin 21.0.12.1" });
    expect(pg.cells).toHaveLength(65);
    expect(pg.cells.every((each) => each.decision === "holds")).toBe(true);
    expect(pg.cells.reduce((sum, each) => sum + each.counted, 0)).toBe(715);
    expect(pg.cells.reduce((sum, each) => sum + each.voided, 0)).toBe(0);
    const count = (group: string, client: string, stage: string) => pg.cells.filter((each) => each.group === group && each.client === client && each.stage === stage).length;
    expect([count("T01", "node-postgres", "defaults"), count("T01", "node-postgres", "border")]).toEqual([9, 8]);
    expect([count("T01", "HikariCP", "defaults"), count("T01", "HikariCP", "border")]).toEqual([9, 8]);
    expect([count("T03", "HikariCP", "defaults"), count("T10", "HikariCP", "defaults"), count("T10", "HikariCP", "border")]).toEqual([7, 5, 12]);
    expect([count("T10", "node-postgres", "defaults"), count("T10", "node-postgres", "border")]).toEqual([5, 2]);
    // each cell of T10 names its pooler, and no other cell names one
    const via = (name: string) => pg.cells.filter((each) => each.via === name).length;
    expect([via("PgBouncer"), via("Pgpool-II"), via("Supavisor")]).toEqual([15, 5, 4]);
    expect(pg.cells.every((each) => (each.group === "T10") === (each.via !== undefined))).toBe(true);
  });

  it("places the borders through PgBouncer on each side of its timers", () => {
    const [connect, giveUp] = ["T10.border-off.83", "T10.border-off.84"].map(cell);
    // the connect timer of PgBouncer closes its socket in SYN_SENT, and at 140 s the kernel gives up on the SYNs first
    expect(connect!.median).toBeGreaterThan(127.99);
    expect(connect!.median).toBeLessThan(128.01);
    expect(connect!.prediction.text).toMatch(/in SYN_SENT, with no error and no FIN. The band is 127.99 s to 128.01 s after the SYN of the connect of PgBouncer.$/);
    expect(giveUp!.median).toBeGreaterThan(131);
    expect(giveUp!.median).toBeLessThan(140);
    const [inside, outside] = ["T10.border-off.91", "T10.border-off.92"].map(cell);
    // O01: the idle timer of the pool at 10 s comes before client_idle_timeout at 12 s, and at 14 s PgBouncer closes the client first
    expect(inside!.median).toBeLessThan(12);
    expect(outside!.median).toBeGreaterThan(12);
    expect(outside!.prediction.text).toMatch(/^The algebra predicts that client_idle_timeout of PgBouncer closes the idle client/);
  });

  it("gives no timer of Supavisor to an idle client or to a query", () => {
    const idle = cell("T10.defaults.27");
    expect(idle.client).toBe("node-postgres");
    expect(idle.median).toBeGreaterThan(10);
    expect(idle.median).toBeLessThan(10.01);
    for (const plan of ["T10.defaults.28", "T10.defaults.30"]) expect(cell(plan).band, plan).toBeNull();
    expect(cell("T10.defaults.31").median).toBeGreaterThan(5);
  });

  it("gives the idle timer of node-postgres at 10 s, with and without a fault, each run in its band", () => {
    for (const plan of ["T01.defaults.122", "T01.defaults.128"]) {
      const each = cell(plan);
      expect(each.client, plan).toBe("node-postgres");
      expect(each.median, plan).toBeGreaterThan(10);
      expect(each.median, plan).toBeLessThan(10.01);
      expect(outside(each), plan).toEqual([]);
      expect(each.prediction.text, plan).toMatch(/the pool closes its idle client at its idle timer, and the kernel stamps its FIN\. The band is 10 s to 10\.01 s after the last segment on the socket\.$/);
    }
  });

  it("places the borders of O13 and O15 of node-postgres on each side of the slowest poll and of the startup budget", () => {
    const [in13, out13, in15, out15] = ["T01.border-off.179", "T01.border-off.180", "T01.border-off.191", "T01.border-off.192"].map(cell);
    expect(in13!.median).toBeLessThan(10);
    expect(out13!.median).toBeGreaterThan(10);
    expect(in15!.median).toBeLessThan(30);
    expect(out15!.median).toBeGreaterThan(30);
    expect(in15!.prediction.text).toMatch(/after the start of the first connect\.$/);
  });

  it("places the borders of O13 and O07 of HikariCP with the read timeout of pgjdbc", () => {
    const [in13, out13, in07, out07] = ["T01.border-off.187", "T01.border-off.188", "T01.border-off.173", "T01.border-off.174"].map(cell);
    expect(in13!.median).toBeLessThan(10);
    expect(out13!.median).toBeGreaterThan(10);
    // inside O07 the statement timer of the server ends the query, and outside the read timeout closes the socket first
    expect(in07!.median).toBeGreaterThan(10);
    expect(in07!.prediction.text).toMatch(/the statement timer of the server ends the query with 57014\./);
    expect(out07!.median).toBeLessThan(10);
    expect(out07!.prediction.text).toMatch(/the read timeout of pgjdbc closes the socket/);
  });

  it("gives the keepalive of HikariCP 5 s after its empty query, on the direct pair, through a router and through PgBouncer", () => {
    for (const plan of ["T01.defaults.52", "T01.border-off.152", "T03.defaults.6", "T10.defaults.1"]) {
      const each = cell(plan);
      expect(each.client, plan).toBe("HikariCP");
      expect(each.median, plan).toBeGreaterThan(5);
      expect(each.median, plan).toBeLessThan(5.01);
      expect(outside(each), plan).toEqual([]);
      expect(each.prediction.text, plan).toMatch(/after the empty query of the check, the first segment after the fault\.$/);
    }
  });

  it("holds each cell with no detector in its window: no run has a time", () => {
    const quiet = pg.cells.filter((each) => each.band === null);
    expect(quiet.map((each) => each.plan).sort()).toEqual(
      [
        "T01.defaults.126",
        "T01.border-off.158",
        "T01.defaults.55",
        "T01.defaults.57",
        "T01.border-off.151",
        "T03.defaults.8",
        "T03.defaults.42",
        "T03.defaults.51",
        "T10.defaults.45",
        "T10.defaults.2",
        "T10.defaults.28",
        "T10.defaults.30",
      ].sort(),
    );
    for (const each of quiet) expect(each.runs.flat().every((t) => t === null), each.plan).toBe(true);
  });
});
