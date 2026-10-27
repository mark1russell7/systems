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
    // C and D of Cilium have the prediction of C in iptables too
    expect(table.split("The prediction: 0 to 2,700 failed requests, with 0 to 3 of the 3 connections on the target.").length - 1).toBe(8);
    // the Cilium column: its own run, and its median runs
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40558968382");
    expect(table).toContain("2,810 failed requests in the median run");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40394320219");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40358038728");
    expect(table.split("<tr>").length - 1).toBe(5);
    const frames = renderToString(<KindResults template="T07" group="callers" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(16);
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
    expect(table.split("<tr>").length - 1).toBe(5);
    const frames = renderToString(<KindResults template="T07" group="partition" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(16);
  });

  it("render the S2 candidates of a stalled pod side by side, with the frame of each cell", () => {
    const table = renderToString(<CallersTable incident="stall" />);
    expect(table).toContain("22 failed requests in the median run");
    expect(table).toContain("1,498 failed requests in the median run");
    expect(table).toContain("The prediction: 12 to 39 failed requests, with 7 to 17 of the 24 connections on the target.");
    expect(table).toContain("The prediction: 0 to 1,503 failed requests, with 0 to 3 of the 3 connections on the target.");
    // C of Cilium failed in 1 of 3 runs, and each other cell held
    expect(table.split("disagree").length - 1).toBe(1);
    expect(table).toContain("1 of 3 runs disagrees.");
    expect(table).not.toContain("No run in the copy yet.");
    // D: the removal ends each chain of the session check
    expect(table).toContain("191 failed requests in the median run");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40406199754");
    expect(table.split("<tr>").length - 1).toBe(5);
    const frames = renderToString(<KindResults template="T07" group="stall" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(16);
  });

  it("render the S2 candidates of a failed prober side by side, with the failed requests and the false removal of the median run", () => {
    const table = renderToString(<CallersTable incident="prober" />);
    expect(table).toContain("1,690 failed requests, and the false removal 16.855 s after the fault, in the median run");
    expect(table).toContain("The prediction: 525 to 2,992 failed requests, with 7 to 17 of the 24 connections on the target.");
    expect(table).toContain("The false removal comes 12 s to 24.105 s after the fault.");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40419289511");
    expect(table).not.toContain("disagree");
    expect(table).not.toContain("No run in the copy yet.");
    expect(table.split("<tr>").length - 1).toBe(5);
    const frames = renderToString(<KindResults template="T07" group="prober" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(16);
  });

  it("render the S2 candidates of a black-holed shared dependency side by side, with the failed requests and the empty Service of the median run", () => {
    const table = renderToString(<CallersTable incident="dependency" />);
    expect(table).toContain("4,173 failed requests, and the empty Service 17.524 s after the fault, in the median run");
    expect(table).toContain("The Service is empty 12 s to 26.105 s after the fault.");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40430856093");
    // the run of Cilium has only B, thus A, C and D of Cilium have no run
    expect(table.split("No run in the copy yet.").length - 1).toBe(3);
    expect(table.split("<tr>").length - 1).toBe(5);
    const frames = renderToString(<KindResults template="T07" group="dependency" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(13);
  });

  it("render the S2 candidates of a flapping dependency side by side, with the empty Service after the first fault and the band of each fault", () => {
    const table = renderToString(<CallersTable incident="flapping" />);
    expect(table).toContain("12,274 failed requests, and the empty Service 17.721 s after the first fault, in the median run");
    expect(table).toContain("The prediction: 10,701 to 17,505 failed requests");
    expect(table).toContain("The Service is empty 12 s to 26.105 s after the fault, for each fault.");
    expect(table).toContain("Each fault has 3,567 to 5,835 failed requests.");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40464814086");
    // the run of Cilium has only B, thus A, C and D of Cilium have no run
    expect(table.split("No run in the copy yet.").length - 1).toBe(3);
    expect(table.split("<tr>").length - 1).toBe(5);
    const frames = renderToString(<KindResults template="T07" group="flapping" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(13);
  });

  it("render the S2 candidates of a lost zone side by side, with the removal of the target and its return after the heal", () => {
    const table = renderToString(<CallersTable incident="zone" />);
    expect(table).toContain("21 failed requests, and the removal of the target 50.393 s after the fault, in the median run");
    expect(table).toContain("The removal comes 39.6 s to 55.355 s after the fault.");
    expect(table).toContain("The target is ready again 0 s to 26.85 s after the heal.");
    expect(table).not.toContain("false removal");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40500297695");
    expect(table).not.toContain("No run in the copy yet.");
    expect(table.split("<tr>").length - 1).toBe(4);
    const frames = renderToString(<KindResults template="T07" group="zone" />);
    expect(frames.split('class="sy-frame').length - 1).toBe(12);
  });

  it("render the S2 candidates of a slow dependency side by side, with the last failure of A and B before the heal", () => {
    const table = renderToString(<CallersTable incident="slow" />);
    expect(table).toContain("3,487 failed requests in the median run");
    expect(table).toContain("The prediction: 3,240 to 3,744 failed requests, with 24 of the 24 connections on the target. The last one starts 1.74 s to 2.02 s before the heal.");
    // C and D fail no request, thus their prediction has no window
    expect(table.split("The prediction: no failed request.").length - 1).toBe(6);
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40521784305");
    expect(table).not.toContain("No run in the copy yet.");
    expect(table.split("<tr>").length - 1).toBe(4);
    const frames = renderToString(<KindResults template="T07" group="slow" />);
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
    // in the stall, B in iptables and nftables, and A in IPVS (a tie); for the failed prober, D in iptables and C in IPVS (a tie) and nftables.
    // In the shared dependency and in the flapping one, B has the fewest in each mode. In the lost zone, D in iptables, C in IPVS and A in nftables.
    // In the slow dependency, C and D tie at 0 in each mode, and C is the first
    expect.soft(table.split("The fewest in this mode.").length - 1).toBe(30);
    // in each of the three incidents, three criteria have no number in each mode, and the complexity has its own reason for each of the 4 candidates.
    // The failed prober measures its false removals, thus it has one criterion with no number less.
    // The shared dependency, the flapping one and the lost zone each have one criterion with no number, and the complexity of each of the 4 candidates
    // The slow dependency has three criteria with no number, the complexity of each of the 4 candidates, and the time to recover of C and D in each mode
    // The Cilium column adds its own rows. A, C and D of the two dependencies of Cilium have no cell in the run, thus each criterion of each one has no number
    expect.soft(table.split("Not measured.").length - 1).toBe(139);
    expect(table).toContain("T07 has no blip");
    // A, B and C send no PING by their code, and the run 40440516571 counts the PINGs of D in each mode of each incident. The flapping run, the lost zone and the slow dependency count their own
    // Cilium adds A, B and C of four incidents, and B of the two dependencies
    expect.soft(table.split("0 PINGs, by the code").length - 1).toBe(86);
    expect(table).toContain("123 PINGs in the median run");
    expect.soft(table.match(/The prediction: 9 to 378\. The counted runs: \d+, \d+, \d+\./g)?.length).toBe(3);
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40440516571");
    expect(table).toContain("45 PINGs in the median run");
    expect(table).toContain("The prediction: 3 to 126. The counted runs: 33, 44, 51.");
    // the partitioned pod: its own run, and the time until callers know is measured from the fault
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40380943331");
    expect(table).toContain("S2.T07.ipvs.goaway.partition");
    // the copies of D have the time of the last failure in each incident: 3 of a pod that cannot serve, 12 of the partition and 12 of the stall.
    // The failed prober gives 9: B, C and D in each mode, and A learns only after the heal.
    // The lost zone gives 11: D in iptables has no failed request in a counted run
    expect.soft(table.match(/the last failure [\d.]+ (?:ms|s) after the fault in the median run/g)?.length).toBe(61);
    // Cilium adds 14: B, C and D of a pod that cannot serve and of the failed prober, and each candidate of the partition and of the stall
    expect(table).toContain("the last failure 26.4");
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40394320219");
    expect(table).toContain("S2.T07.ipvs.session-check.partition");
    // the stalled pod: its own run for each candidate, and C learns only at the resume
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40406199754");
    expect(table).toContain("S2.T07.ipvs.session-check.stall");
    expect(table).toMatch(/the last failure 10\.0\d* s after the fault in the median run/);
    expect(table).not.toContain("Not measured yet: a lost zone");
    expect(table).not.toContain("Not measured yet: a black-holed shared dependency");
    expect(table).not.toContain("a flapping dependency: No cell");
    // the failed prober: its own run for each candidate, and the false removal of each one
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40419289511");
    expect.soft(table.match(/the false removal [\d.]+ s after the fault in the median run/g)?.length).toBe(16);
    // the shared dependency: its own run, the empty Service, the last slow failure and the last failure after the heal
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40430856093");
    expect(table).toContain("S2.T07.nftables.lame-duck.dependency");
    // the flapping dependency: its own run, and the same 3 times, from the values of each fault
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40464814086");
    expect(table).toContain("S2.T07.nftables.lame-duck.flapping");
    expect.soft(table.match(/the empty Service [\d.]+ s after the fault in the median run/g)?.length).toBe(26);
    expect.soft(table.match(/the last slow failure [\d.]+ s after the fault in the median run/g)?.length).toBe(26);
    expect.soft(table.match(/the last failure [\d.]+ (?:ms|s) after the heal in the median run/g)?.length).toBe(26);
    // B of Cilium adds one to each of the three, in each dependency
    // the lost zone: its own run, and the removal of the target by the node lifecycle controller
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40500297695");
    expect(table).toContain("S2.T07.nftables.session-check.zone");
    expect(table).not.toContain("a lost zone: No copy");
    // the slow dependency: its own run, and the last failure of A and B before the heal, after its band
    expect(table).toContain("https://github.com/mark1russell7/systems/actions/runs/40521784305");
    expect(table).toContain("S2.T07.nftables.session-check.slow");
    expect(table).not.toContain("a slow dependency (gray failure): No copy");
    expect.soft(table.match(/the last failure [\d.]+ s before the heal in the median run/g)?.length).toBe(6);
    expect(table).toContain("The prediction: 1.74 s to 2.02 s before the heal.");
  });
});
