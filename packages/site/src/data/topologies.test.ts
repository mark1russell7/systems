import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import topologies from "./topologies-2026-10-17.json";

type Cell = (typeof topologies.cells)[number];
type Run = Cell["runs"][number];

const cell = (catalog: string, name: string): Cell => {
  const found = topologies.cells.find((each) => each.catalog === catalog && each.name === name);
  if (found === undefined) throw new Error(`no cell ${catalog} ${name}`);
  return found;
};
const band = (catalog: string, name: string) => {
  const { verdict } = cell(catalog, name);
  return verdict.band === null ? null : [verdict.band.low, verdict.band.high];
};
const median = (catalog: string, name: string) => cell(catalog, name).verdict.median;
const outcomes = (catalog: string, name: string) => [...new Set(cell(catalog, name).runs.map((run) => run.outcome))];
const counted = (each: { readonly runs: readonly Run[] }): Run[] => each.runs.filter((run) => run.void === null);
const decisions = (decision: string) => topologies.cells.filter((each) => each.verdict.decision === decision);
/** Each set of runs: the first run of each cell, and each re-run. */
const sets = topologies.cells.flatMap((each) => [each, ...(each.rerun === null ? [] : [each.rerun])]);
const DV12 = ["reset-both", "reset-next", "silent-drop"] as const;

describe("the copy of the topology cells holds the figures of their runs", () => {
  it("has 46 cells on Linux 6.17 at HZ 1000: 39 hold and 7 are measurements only, each of a proxy", () => {
    expect([topologies.kernel, topologies.hz, topologies.target]).toEqual(["6.17.0", 1000, "redis:7.4"]);
    expect(topologies.cells).toHaveLength(46);
    const count = (catalog: string) => topologies.cells.filter((each) => each.catalog === catalog).length;
    expect([count("T03"), count("T02"), count("TOX")]).toEqual([27, 7, 12]);
    expect(decisions("holds")).toHaveLength(39);
    expect(decisions("measured")).toHaveLength(7);
    expect(topologies.cells.filter((each) => each.prediction.kind === "measured")).toHaveLength(7);
    expect(decisions("measured").every((each) => each.topology.hops.some((hop) => hop.kind === "proxy"))).toBe(true);
    expect(topologies.cells.filter((each) => !["holds", "measured"].includes(each.verdict.decision))).toEqual([]);
    expect(topologies.cells.filter((each) => each.rerun !== null)).toEqual([]);
  });

  it("has 11 counted runs for each cell over 2 environments, after a warm-up in each environment, and no finding", () => {
    expect(sets.every((each) => each.runs.length === 11 && each.verdict.counted === 11 && each.verdict.voided === 0)).toBe(true);
    expect(sets.every((each) => each.verdict.warmups === 2 && each.warmups.length === 2)).toBe(true);
    expect(sets.flatMap((each) => each.runs.filter((run) => run.void !== null || run.finding !== null))).toEqual([]);
    const outside = sets.flatMap((each) =>
      each.verdict.band === null
        ? []
        : each.warmups.flatMap((run) =>
            run.elapsed !== null && (run.elapsed < each.verdict.band!.low || run.elapsed > each.verdict.band!.high) ? [run.elapsed] : [],
          ),
    );
    expect(outside).toEqual([]);
  });

  it("gives DV-12's three medians and bands at a keepalive of 6 s, and silence at 4 s", () => {
    expect(median("T03", "client idle, reset-both, keepidle 6 s")).toBe(5.039044);
    expect(median("T03", "client idle, reset-next, keepidle 6 s")).toBe(6.305474);
    expect(median("T03", "client idle, silent-drop, keepidle 6 s")).toBe(9.32165);
    expect(band("T03", "client idle, reset-both, keepidle 6 s")).toEqual([4.999, 5.132]);
    expect(band("T03", "client idle, reset-next, keepidle 6 s")).toEqual([5.998, 6.514]);
    expect(band("T03", "client idle, silent-drop, keepidle 6 s")).toEqual([8.998, 9.705]);
    for (const form of DV12) {
      const kept = cell("T03", `client idle, ${form}, keepidle 4 s`);
      expect(kept.verdict.decision).toBe("holds");
      expect(kept.prediction.kind).toBe("silent");
      expect(kept.runs.every((run) => run.outcome === "silent" && run.forgot === null)).toBe(true);
      expect(kept.o03).toEqual({ holds: true, refresh: 4.064, forget: 5 });
      const broken = cell("T03", `client idle, ${form}, keepidle 6 s`);
      expect(broken.verdict.decision).toBe("holds");
      expect(broken.o03).toEqual({ holds: false, refresh: 6.512, forget: 5 });
      expect(broken.topology.hops).toEqual([expect.objectContaining({ kind: "router", form, idle: 5 })]);
    }
    const forgot = DV12.flatMap((form) => counted(cell("T03", `client idle, ${form}, keepidle 6 s`)).map((run) => run.forgot ?? NaN));
    expect([Math.min(...forgot), Math.max(...forgot)]).toEqual([4.999807, 5.050737]);
    expect(median("T03", "server idle, reset-both, tcp-keepalive 6 s")).toBe(5.0272);
    expect(median("T03", "server idle, reset-next, tcp-keepalive 6 s")).toBe(12.439666);
    expect(median("T03", "server idle, none, tcp-keepalive 6 s")).toBe(6.239848);
    expect(outcomes("T03", "client in flight after 8 s idle, recreate")).toEqual(["answered"]);
  });

  it("gives a fault at the router the band of the same fault on the direct pair", () => {
    const router = topologies.cells.filter((each) => each.group.startsWith("router "));
    expect([router.filter((each) => each.group === "router idle").length, router.filter((each) => each.group === "router inflight").length]).toEqual([3, 11]);
    expect(router.every((each) => each.verdict.decision === "holds" && each.o03 === null)).toBe(true);
    expect(band("T03", "client in flight, unreachable-host at the router toward the client, tcp_retries2 = 3")).toEqual([2.999, 3.33]);
    expect(median("T03", "client in flight, unreachable-host at the router toward the client, tcp_retries2 = 3")).toBe(3.119994);
    expect(outcomes("T03", "client in flight, unreachable-net at the router toward the client, tcp_retries2 = 3")).toEqual(["ENETUNREACH"]);
    expect(band("T03", "client in flight, blackhole at the router, tcp_retries2 = 3, none")).toEqual([2.999, 6.417]);
    expect(median("T03", "client in flight, blackhole at the router, tcp_retries2 = 3, none")).toBe(6.175995);
    expect(median("T03", "client idle, blackhole at the router, keepidle 5 s, none")).toBe(11.340287);
    expect(median("T03", "client in flight, rst at the router toward the client")).toBe(0.000122);
    expect(median("T03", "client in flight, netem delay 100 ms at the router toward the client")).toBe(0.10023);
  });

  it("forgets a flow behind the black hole of its router one idle timeout after the last retransmission", () => {
    const inFlight = cell("T03", "client in flight, blackhole at the router, tcp_retries2 = 8, reset-both, the router forgets the flow");
    expect([inFlight.prediction.timer, inFlight.prediction.from, inFlight.verdict.median, outcomes("T03", inFlight.name)]).toEqual([
      "expire_established",
      "request-sent",
      11.601665,
      ["ECONNRESET"],
    ]);
    expect(band("T03", inFlight.name)).toEqual([11.425, 11.739]);
    expect(median("T03", "client idle, blackhole at the router, keepidle 6 s, reset-both, the router forgets the flow")).toBe(5.035429);
    const plain = cell("T03", "client idle, blackhole at the router, keepidle 6 s, none, the router forgets the flow");
    expect([plain.prediction.timer, plain.verdict.median]).toEqual(["keepalive", 9.398616]);
  });

  it("closes the idle timeouts of HAProxy at approximately 5.003 s, with keepalive on each side", () => {
    expect(median("T02", "client idle, keepalive 2 s, HAProxy timeout client 5 s")).toBe(5.003242);
    expect(median("T02", "client idle, keepalive 2 s, HAProxy timeout server 5 s, Redis tcp-keepalive 2 s")).toBe(5.002772);
    expect(outcomes("T02", "client idle, keepalive 2 s, HAProxy timeout client 5 s")).toEqual(["EOF"]);
    expect(topologies.cells.filter((each) => each.catalog === "T02" && each.verdict.decision === "measured")).toHaveLength(3);
    expect(median("T02", "client idle, blackhole at the target")).toBe(6.111946);
    expect(median("T02", "HAProxy toward the target idle, blackhole at the target")).toBe(6.104554);
    expect(median("T02", "HAProxy toward the client idle, blackhole at the client")).toBe(6.111185);
    expect(median("T02", "client idle, keepalive 5 s, blackhole at HAProxy toward the client")).toBe(11.317973);
    expect(cell("T02", "client idle, keepalive 2 s, HAProxy timeout client 5 s").topology.hops[0]?.product).toBe("HAProxy 3.2.25");
  });

  it("gives a reset at the server to the client as an EOF through Toxiproxy, and each toxic in its band", () => {
    expect(median("TOX", "client in flight, rst at the server, through Toxiproxy")).toBe(0.000437);
    expect(outcomes("TOX", "client in flight, rst at the server, through Toxiproxy")).toEqual(["EOF"]);
    expect(median("TOX", "direct, client in flight, rst")).toBe(0.000096);
    expect(outcomes("TOX", "direct, client in flight, rst")).toEqual(["ECONNRESET"]);
    expect(median("TOX", "client in flight, blackhole at the server, through Toxiproxy with tcp_retries2 = 3")).toBe(6.572579);
    expect(outcomes("TOX", "client in flight, blackhole at the server, through Toxiproxy with tcp_retries2 = 3")).toEqual(["EOF"]);
    // the catalog predicts the FIN of reset_peer on a live connection from the source of Toxiproxy
    const reset = cell("TOX", "client in flight, toxic reset_peer 0 upstream on a live connection");
    expect([reset.prediction.errno, outcomes("TOX", reset.name), reset.verdict.decision, reset.verdict.median]).toEqual(["EOF", ["EOF"], "holds", 0.000512]);
    // each band through Toxiproxy adds its own time for each crossing
    const limit = cell("TOX", "client in flight, toxic limit_data 1000 bytes downstream, a 500000-byte reply");
    expect([limit.verdict.decision, limit.verdict.median, band("TOX", limit.name)]).toEqual(["holds", 0.000913, [-0.001, 0.00273]]);
    expect(median("TOX", "client in flight, toxic slicer 100 bytes 10 ms downstream, a 5000-byte reply")).toBe(0.641551);
    expect(median("TOX", "client in flight, toxic bandwidth 100 KB/s downstream, a 500000-byte reply")).toBe(5.014015);
    expect(median("TOX", "client idle, toxic timeout 2000 ms downstream")).toBe(2.001385);
  });

  it("names no machine: no boot id, image digest, container, namespace inode, user or path", () => {
    const text = readFileSync(new URL("./topologies-2026-10-17.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|cookie|container|docker|[0-9a-f]{12,}/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt)\/|AppData|azure|WSL|microsoft/i);
  });
});
