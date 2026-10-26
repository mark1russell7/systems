import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RunResults, { CallersTable, KindResults, ModeTable, Propagation, RaceBorder, WritesTable } from "./RunResults.tsx";

describe("the components of the CI runs", () => {
  it("render each group that the pages of the CI runs name", () => {
    const parts = [
      <RunResults copy="sentinel" group="defaults" />,
      <RunResults copy="sentinel" group="border" />,
      <RunResults copy="sentinel" group="calibration" />,
      <RunResults copy="http" group="race" />,
      <RunResults copy="http" group="faults" />,
      <RunResults copy="http" group="router" />,
      <RunResults copy="mongodb" group="T01" stage="defaults" />,
      <RunResults copy="mongodb" group="T01" stage="border" />,
      <RunResults copy="mongodb" group="T03" stage="defaults" />,
      <RunResults copy="mongodb" group="T03" stage="border" />,
      <RunResults copy="mongodb" group="T11" stage="defaults" />,
      <RunResults copy="mongodb" group="T11" stage="border" />,
      <WritesTable copy="sentinel" />,
      <WritesTable copy="mongodb" group="T11" />,
      <RaceBorder />,
      <KindResults template="T07" group="calibration" />,
      <KindResults template="T07" group="deletion" />,
      <KindResults template="T07" group="pause" />,
      <KindResults template="T07" group="triggers" />,
      <KindResults template="T18" group="redis" />,
      <KindResults template="T18" group="liveness" />,
      <KindResults template="T18" group="other" />,
      <ModeTable />,
      <Propagation />,
      <RunResults copy="rabbitmq" group="T01" stage="defaults" />,
      <RunResults copy="rabbitmq" group="T01" stage="border" />,
      <RunResults copy="rabbitmq" group="T11" stage="defaults" />,
      <RunResults copy="pg" group="T01" pool="node-postgres" stage="defaults" />,
      <RunResults copy="pg" group="T01" pool="node-postgres" stage="border" />,
      <RunResults copy="pg" group="T01" pool="HikariCP" stage="defaults" />,
      <RunResults copy="pg" group="T01" pool="HikariCP" stage="border" />,
      <RunResults copy="pg" group="T03" via={null} stage="defaults" />,
      <RunResults copy="pg" group="T03" via="Supavisor" stage="defaults" />,
      <RunResults copy="pg" group="T10" via="PgBouncer" pool="node-postgres" stage="defaults" />,
      <RunResults copy="pg" group="T10" via="PgBouncer" pool="HikariCP" stage="defaults" />,
      <RunResults copy="pg" group="T10" via="PgBouncer" pool="node-postgres" stage="border" />,
      <RunResults copy="pg" group="T10" via="PgBouncer" pool="HikariCP" stage="border" />,
      <RunResults copy="pg" group="T10" via="Pgpool-II" />,
      <RunResults copy="pg" group="T10" via="Supavisor" />,
    ];
    const html = parts.map((part) => renderToString(part));
    const frames = html.slice(0, 12).map((each) => each.split('class="sy-frame').length - 1);
    expect(frames).toEqual([8, 4, 1, 21, 8, 10, 8, 18, 9, 6, 7, 10]);
    // the PostgreSQL cells: for each client in T01, 9 at the defaults and 8 at the borders. In T03, 7 through a router
    // and 7 through a router and Supavisor. In T10 through PgBouncer: 1 of node-postgres and 4 of HikariCP at the
    // defaults, and 2 of node-postgres and 10 of HikariCP at the borders. Then 6 through Pgpool-II and 4 through Supavisor
    expect(html.slice(-12).map((each) => each.split('class="sy-frame').length - 1)).toEqual([9, 8, 9, 8, 7, 7, 1, 4, 2, 10, 6, 4]);
    // the RabbitMQ cells: 8 of T01 at the defaults, 4 at the borders, and 9 of T11. A cell of T11 has its stages and its publishes
    expect(html.slice(24, 27).map((each) => each.split('class="sy-frame').length - 1)).toEqual([8, 4, 9]);
    expect(html[26]).toContain("The queue kept each publish that it confirmed.");
    expect(html[26]).toContain("old-leader-steps-down");
    // the border of undici at 100 ms closes 6.5 ms before the end of its band: the table gives 4 decimals from 1 s
    expect(html[14]).toContain("5.9126 s");
    expect(html[14]).toContain("5.9191 s");
    // the mode table: each cell gives its median run, and no run of the copy disagrees
    expect(html[22]).toContain("in the median run");
    expect(html[22]).not.toContain("disagree");
  });

  it("render the S2 candidates side by side, with the frame of each cell", () => {
    const table = renderToString(<CallersTable />);
    // the iptables run: the median of each candidate and its prediction
    expect(table).toContain("A: endpoints only");
    expect(table).toContain("B: in band (lame duck)");
    expect(table).toContain("2,542 failed requests in the median run");
    expect(table).toContain("1,095 failed requests in the median run");
    expect(table).toContain("The prediction: 2,250 to 2,712 failed requests.");
    expect(table).toContain("The prediction: 600 to 1,350 failed requests.");
    expect(table).not.toContain("disagree");
    expect(table).toContain("The copy has no run of ipvs or nftables yet.");
    const frames = renderToString(<KindResults template="T07" group="callers" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(2);
    expect(frames).toContain("Each failed request ends with an answer of 503.");
  });
});
