import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Borders, { bordersOf, onAxis } from "./Borders.tsx";
import CellMap, { rowsOf } from "./CellMap.tsx";
import RunResults, { COPIES, cellId, type Copy } from "./RunResults.tsx";

const ids = (html: string, pattern: RegExp): string[] => [...html.matchAll(pattern)].map((match) => match[1]!);

describe("the map of the cells", () => {
  it("has a tile for each cell, and each tile links to the frame of its cell", () => {
    for (const copy of ["sentinel", "http", "mongodb", "pg", "r3"] as const satisfies readonly Copy[]) {
      const cells = COPIES[copy];
      const html = renderToString(<CellMap copy={copy} />);
      const links = ids(html, /class="sy-tile" href="#([^"]+)"/g);
      expect(links).toHaveLength(cells.length);
      // one ID for each cell: two cells of one plan ID (a border of HTTP) still have their own frame.
      // The rows go by client, thus the tiles of a copy whose clients alternate come in another sequence
      expect(new Set(links).size).toBe(cells.length);
      expect([...links].sort()).toEqual(cells.map(cellId).sort());
    }
  });

  it("gives the frames the IDs that the tiles link to", () => {
    const html = renderToString(<RunResults copy="pg" group="T01" pool="HikariCP" stage="border" />);
    const frames = ids(html, /<section class="sy-frame not-content" id="([^"]+)"/g);
    expect(frames).toEqual(COPIES.pg.filter((cell) => cell.group === "T01" && cell.client === "HikariCP" && cell.stage === "border").map(cellId));
  });

  it("puts the cells in rows by group, client and pooler, in clusters by stage", () => {
    const rows = rowsOf(COPIES.pg);
    expect(rows.map((row) => `${row.group} ${row.client ?? ""} ${row.via ?? ""}`.trim())).toEqual([
      "T01 node-postgres",
      "T01 HikariCP",
      "T03 HikariCP",
      "T10 node-postgres PgBouncer",
      "T10 node-postgres Pgpool-II",
      "T10 node-postgres Supavisor",
      "T10 HikariCP PgBouncer",
      "T10 HikariCP Pgpool-II",
    ]);
    // through PgBouncer, HikariCP has 3 cells at the defaults and 10 at the borders
    expect(rows[6]!.clusters.map((cluster) => [cluster.stage, cluster.cells.length])).toEqual([
      ["defaults", 3],
      ["border", 10],
    ]);
    const html = renderToString(<CellMap copy="pg" />);
    // React puts a comment between the two parts of the label
    expect(html).toMatch(/class="sy-map-via">through (?:<!-- -->)?Supavisor</);
    expect(rows[0]!.clusters.map((cluster) => [cluster.stage, cluster.cells.length])).toEqual([
      ["defaults", 9],
      ["border", 8],
    ]);
  });
});

describe("the charts of the borders", () => {
  it("finds the 8 borders of PostgreSQL, two cells each", () => {
    const borders = bordersOf(COPIES.pg);
    expect(borders.map((border) => `${border.client} ${border.rule} ${border.setting} ${border.inside.value}/${border.outside.value} against ${border.against} ${border.at}`)).toEqual([
      "node-postgres O07 query_timeout 10.5/9.5 against statement_timeout 10",
      "node-postgres O03 idleTimeoutMillis 10/14 against silent-drop router 12",
      "node-postgres O13 query_timeout 9.5/10.5 against poll 10",
      "node-postgres O15 connectionTimeoutMillis 29/31 against startup budget 30",
      "HikariCP O03 keepaliveTime 55/80 against silent-drop router 60",
      "HikariCP O13 socketTimeout 9/11 against poll 10",
      "HikariCP O07 socketTimeout 11/9 against statement_timeout 10",
      "HikariCP O15 connectTimeout 28/30 against budget 30",
    ]);
  });

  it("puts a run on the axis only when its band counts from the event of its setting", () => {
    const [o07, , , , o03] = bordersOf(COPIES.pg);
    // the statement timer and query_timeout both count from the send of the query
    expect([onAxis(o07!.inside, o07!.at), onAxis(o07!.outside, o07!.at)]).toEqual([true, true]);
    // the read timeout of the check counts from its empty query, which comes at a phase of the keepalive: the chart gives it as text
    expect(onAxis(o03!.outside, o03!.at)).toBe(false);
    const html = renderToString(<Borders copy="pg" />);
    expect(html).toContain("it ended 5.0034 s after the empty query of the check");
    expect(html).toContain("nothing ended it in the window of 30 s");
    expect(html.split('class="sy-border"').length - 1).toBe(8);
  });
});
