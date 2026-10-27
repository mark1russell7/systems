import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RunResults, { CallersScores, CallersTable, KindResults, ModeTable, Propagation, RaceBorder, WritesTable } from "./RunResults.tsx";

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
    // the median of each candidate in each mode, and its prediction
    expect(table).toContain("A: endpoints only");
    expect(table).toContain("B: in band (lame duck)");
    expect(table).toContain("3,044 failed requests in the median run");
    expect(table).toContain("983 failed requests in the median run");
    expect(table).toContain("The prediction: 1,313 to 3,842 failed requests, with 7 to 17 of the 24 connections on the target.");
    expect(table).toContain("The prediction: 600 to 1,350 failed requests, with 12 of the 24 connections on the target.");
    expect(table).not.toContain("disagree");
    // C has a column with its median run in each mode
    expect(table).toContain("C: in band on HTTP/2 (GOAWAY)");
    expect(table).toContain("1,087 failed requests in the median run");
    expect(table).not.toContain("No run in the copy yet.");
    expect(table).toContain("The prediction: 0 to 2,700 failed requests, with 0 to 3 of the 3 connections on the target.");
    // D has the prediction of C, and its column links its own run
    expect(table).toContain("D: in band on HTTP/2 with a session check");
    expect(table).toContain("580 failed requests in the median run");
    expect(table.split("The prediction: 0 to 2,700 failed requests, with 0 to 3 of the 3 connections on the target.").length - 1).toBe(6);
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40394320219");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40358038728");
    expect(table.split("<tr>").length - 1).toBe(4);
    const frames = renderToString(<KindResults template="T07" group="callers" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(12);
    expect(frames).toContain("Each failed request ends with an answer of 503.");
  });

  it("render the S2 candidates of a partitioned pod side by side, with the frame of each cell", () => {
    const table = renderToString(<CallersTable incident="partition" />);
    expect(table).toContain("27 failed requests in the median run");
    expect(table).toContain("3,953 failed requests in the median run");
    expect(table).toContain("The prediction: 12 to 39 failed requests, with 7 to 17 of the 24 connections on the target.");
    expect(table).toContain("The prediction: 0 to 4,048 failed requests, with 0 to 3 of the 3 connections on the target.");
    expect(table).not.toContain("disagree");
    expect(table).not.toContain("No run in the copy yet.");
    // D: the session check closes each session on the target at its PING
    expect(table).toContain("158 failed requests in the median run");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40394320219");
    expect(table.split("<tr>").length - 1).toBe(4);
    const frames = renderToString(<KindResults template="T07" group="partition" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(12);
  });

  it("render the S2 candidates of a stalled pod side by side, with the frame of each cell", () => {
    const table = renderToString(<CallersTable incident="stall" />);
    expect(table).toContain("22 failed requests in the median run");
    expect(table).toContain("1,498 failed requests in the median run");
    expect(table).toContain("The prediction: 12 to 39 failed requests, with 7 to 17 of the 24 connections on the target.");
    expect(table).toContain("The prediction: 0 to 1,503 failed requests, with 0 to 3 of the 3 connections on the target.");
    expect(table).not.toContain("disagree");
    expect(table).not.toContain("No run in the copy yet.");
    // D: the removal ends each chain of the session check
    expect(table).toContain("191 failed requests in the median run");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40406199754");
    expect(table.split("<tr>").length - 1).toBe(4);
    const frames = renderToString(<KindResults template="T07" group="stall" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(12);
  });

  it("render the S2 candidates of a failed prober side by side, with the failed requests and the false removal of the median run", () => {
    const table = renderToString(<CallersTable incident="prober" />);
    expect(table).toContain("1,690 failed requests, and the false removal 16.855 s after the fault, in the median run");
    expect(table).toContain("The prediction: 525 to 2,992 failed requests, with 7 to 17 of the 24 connections on the target.");
    expect(table).toContain("The false removal comes 12 s to 24.105 s after the fault.");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40419289511");
    expect(table).not.toContain("disagree");
    expect(table).not.toContain("No run in the copy yet.");
    expect(table.split("<tr>").length - 1).toBe(4);
    const frames = renderToString(<KindResults template="T07" group="prober" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(12);
  });

  it("render the scores of S6 side by side, with the run of the evidence and the reason for each criterion with no number", () => {
    const table = renderToString(<CallersScores />);
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40358038728");
    expect(table).toContain("S2.T07.nftables.goaway");
    expect(table).toContain("3,044 failed requests in the median run");
    expect(table).toContain("The prediction: 1,313 to 3,842. The counted runs: 3,044, 3,333, 2,104.");
    expect(table).toContain("The prediction: the last failure 8 s to 24.265 s after the fault.");
    // the fewest in each mode: D in iptables and nftables, B in IPVS; in the partition, B in iptables and A in IPVS (a tie) and nftables;
    // in the stall, B in iptables and nftables, and A in IPVS (a tie); for the failed prober, D in iptables and C in IPVS (a tie) and nftables
    expect(table.split("The fewest in this mode.").length - 1).toBe(12);
    // in each of the three incidents, four criteria have no number in each mode, and the complexity has its own reason for each of the 4 candidates
    // the failed prober measures its false removals, thus it has one criterion with no number less
    expect(table.split("Not measured.").length - 1).toBe(31);
    expect(table).toContain("T07 has no blip");
    // the partitioned pod: its own run, and the time until callers know is measured from the fault
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40380943331");
    expect(table).toContain("S2.T07.ipvs.goaway.partition");
    // the copies of D have the time of the last failure in each incident: 3 of a pod that cannot serve, 12 of the partition and 12 of the stall.
    // The failed prober gives 9: B, C and D in each mode, and A learns only after the heal
    expect(table.match(/the last failure [\d.]+ (?:ms|s) after the fault in the median run/g)?.length).toBe(36);
    expect(table).toContain("the last failure 26.4");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40394320219");
    expect(table).toContain("S2.T07.ipvs.session-check.partition");
    // the stalled pod: its own run for each candidate, and C learns only at the resume
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40406199754");
    expect(table).toContain("S2.T07.ipvs.session-check.stall");
    expect(table).toMatch(/the last failure 10\.0\d* s after the fault in the median run/);
    expect(table).toContain("Not measured yet: a black-holed shared dependency, a lost zone");
    // the failed prober: its own run for each candidate, and the false removal of each one
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40419289511");
    expect(table.match(/the false removal [\d.]+ s after the fault in the median run/g)?.length).toBe(12);
    // each incident with no cell gives its own reason
    expect(table).toContain("a lost zone: No cell measures the candidates in this incident yet. The kind cluster of T07 has no zones");
  });
});
