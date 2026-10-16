import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import topologies from "./topologies-2026-10-16.json";

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
  it("has 42 cells: 29 hold, 8 are measurements only, 3 fail on one outlier run and 2 fail each time", () => {
    expect(topologies.cells).toHaveLength(42);
    const count = (catalog: string) => topologies.cells.filter((each) => each.catalog === catalog).length;
    expect([count("T03"), count("T02"), count("TOX"), count("T01")]).toEqual([13, 7, 12, 10]);
    expect(decisions("holds")).toHaveLength(29);
    expect(decisions("measured")).toHaveLength(8);
    expect(topologies.cells.filter((each) => each.prediction.kind === "measured")).toHaveLength(8);
    expect(decisions("fails")).toHaveLength(5);
    expect(topologies.cells.filter((each) => !["holds", "measured", "fails"].includes(each.verdict.decision))).toEqual([]);

    const outliers = decisions("fails").filter((each) => each.rerun !== null);
    expect(outliers.map((each) => `${each.catalog} ${each.name}`)).toEqual([
      "T01 client in flight, a 1 s stall",
      "T03 client in flight after 8 s idle, recreate",
      "TOX client idle, toxic timeout 2000 ms downstream",
    ]);
    for (const each of outliers) {
      expect(counted(each).filter((run) => run.finding !== null)).toHaveLength(1);
      expect(each.rerun?.verdict.decision).toBe("holds");
    }
    // the two Toxiproxy findings fail on every run, or on the median of all the runs
    const always = decisions("fails").filter((each) => each.rerun === null);
    expect(always.map((each) => each.name)).toEqual([
      "client in flight, toxic reset_peer 0 upstream on a live connection",
      "client in flight, toxic limit_data 1000 bytes downstream, a 500000-byte reply",
    ]);
    expect(topologies.cells.filter((each) => each.rerun !== null)).toHaveLength(3);
  });

  it("has 11 runs for each cell over 2 environments, after a warm-up in each environment", () => {
    expect(sets.every((each) => each.runs.length === 11 && each.verdict.counted + each.verdict.voided === 11)).toBe(true);
    expect(sets.every((each) => each.verdict.warmups === each.warmups.length)).toBe(true);
    // a fin ends its environment, thus each run of the fin cell has a new environment and a dry warm-up
    expect(sets.filter((each) => each.warmups.length !== 2).map((each) => each.verdict.warmups)).toEqual([11]);
    expect(cell("T01", "client idle, fin").warmups.every((run) => run.outcome === "silent")).toBe(true);
  });

  it("gives DV-12's three medians and bands at a keepalive of 6 s, and silence at 4 s", () => {
    expect(median("T03", "client idle, reset-both, keepidle 6 s")).toBe(5.02111);
    expect(median("T03", "client idle, reset-next, keepidle 6 s")).toBe(6.133678);
    expect(median("T03", "client idle, silent-drop, keepidle 6 s")).toBe(9.205499);
    expect(band("T03", "client idle, reset-both, keepidle 6 s")).toEqual([4.996, 5.094]);
    expect(band("T03", "client idle, reset-next, keepidle 6 s")).toEqual([5.992, 6.261]);
    expect(band("T03", "client idle, silent-drop, keepidle 6 s")).toEqual([8.992, 9.356]);
    for (const form of DV12) {
      const kept = cell("T03", `client idle, ${form}, keepidle 4 s`);
      expect(kept.verdict.decision).toBe("holds");
      expect(kept.prediction.kind).toBe("silent");
      expect(kept.runs.every((run) => run.outcome === "silent" && run.forgot === null)).toBe(true);
      expect(kept.o03).toEqual({ holds: true, refresh: 4.256, forget: 5 });
      const broken = cell("T03", `client idle, ${form}, keepidle 6 s`);
      expect(broken.verdict.decision).toBe("holds");
      expect(broken.o03).toEqual({ holds: false, refresh: 6.256, forget: 5 });
      expect(broken.topology.hops).toEqual([expect.objectContaining({ kind: "router", form, idle: 5 })]);
    }
    const forgot = DV12.flatMap((form) => counted(cell("T03", `client idle, ${form}, keepidle 6 s`)).map((run) => run.forgot ?? NaN));
    expect([Math.min(...forgot), Math.max(...forgot)]).toEqual([4.999316, 5.050165]);
    expect(median("T03", "server idle, reset-both, tcp-keepalive 6 s")).toBe(5.024902);
    expect(median("T03", "server idle, reset-next, tcp-keepalive 6 s")).toBe(12.135984);
    expect(median("T03", "server idle, none, tcp-keepalive 6 s")).toBe(6.157878);
    expect(outcomes("T03", "client in flight after 8 s idle, recreate")).toEqual(["answered"]);
  });

  it("closes the idle timeouts of HAProxy at approximately 5.003 s, with keepalive on each side", () => {
    expect(median("T02", "client idle, keepalive 2 s, HAProxy timeout client 5 s")).toBe(5.002895);
    expect(median("T02", "client idle, keepalive 2 s, HAProxy timeout server 5 s, Redis tcp-keepalive 2 s")).toBe(5.003478);
    expect(outcomes("T02", "client idle, keepalive 2 s, HAProxy timeout client 5 s")).toEqual(["EOF"]);
    expect(topologies.cells.filter((each) => each.catalog === "T02" && each.verdict.decision === "measured")).toHaveLength(3);
    expect(median("T02", "client idle, blackhole at the target")).toBe(6.232298);
    expect(median("T02", "HAProxy toward the target idle, blackhole at the target")).toBe(6.246605);
    expect(median("T02", "HAProxy toward the client idle, blackhole at the client")).toBe(6.178341);
    expect(median("T02", "client idle, keepalive 5 s, blackhole at HAProxy toward the client")).toBe(11.122255);
    expect(cell("T02", "client idle, keepalive 2 s, HAProxy timeout client 5 s").topology.hops[0]?.product).toBe("HAProxy 3.2.25");
  });

  it("gives a reset at the server to the client as an EOF at approximately 0.94 ms through Toxiproxy", () => {
    expect(median("TOX", "client in flight, rst at the server, through Toxiproxy")).toBe(0.000943);
    expect(outcomes("TOX", "client in flight, rst at the server, through Toxiproxy")).toEqual(["EOF"]);
    expect(median("TOX", "direct, client in flight, rst")).toBe(0.00018);
    expect(outcomes("TOX", "direct, client in flight, rst")).toEqual(["ECONNRESET"]);
    expect(median("TOX", "client in flight, blackhole at the server, through Toxiproxy with tcp_retries2 = 3")).toBe(6.788112);
    expect(outcomes("TOX", "client in flight, blackhole at the server, through Toxiproxy with tcp_retries2 = 3")).toEqual(["EOF"]);
    const reset = cell("TOX", "client in flight, toxic reset_peer 0 upstream on a live connection");
    expect(reset.prediction.errno).toBe("ECONNRESET");
    expect(outcomes("TOX", reset.name)).toEqual(["EOF"]);
    expect(reset.verdict.median).toBe(0.000828);
    expect(Math.max(...counted(reset).map((run) => run.elapsed ?? 0))).toBe(0.02571);
    const limit = cell("TOX", "client in flight, toxic limit_data 1000 bytes downstream, a 500000-byte reply");
    expect(limit.verdict.median).toBe(0.002518);
    expect(counted(limit).filter((run) => run.finding !== null)).toEqual([]);
    const times = counted(limit).map((run) => run.elapsed ?? NaN);
    expect([Math.min(...times), Math.max(...times)]).toEqual([0.001307, 0.004777]);
    expect(median("TOX", "client in flight, toxic slicer 100 bytes 10 ms downstream, a 5000-byte reply")).toBe(0.657386);
    expect(median("TOX", "client in flight, toxic bandwidth 100 KB/s downstream, a 500000-byte reply")).toBe(5.029172);
  });

  it("shows each outlier run, and the re-run of its cell", () => {
    const outlier = (catalog: string, name: string) =>
      counted(cell(catalog, name)).filter((run) => run.finding !== null).map((run) => run.elapsed);
    expect(outlier("T01", "client in flight, a 1 s stall")).toEqual([1.736498]);
    expect(cell("T01", "client in flight, a 1 s stall").rerun?.verdict.median).toBe(1.67047);
    expect(outlier("T03", "client in flight after 8 s idle, recreate")).toEqual([0.011536]);
    expect(cell("T03", "client in flight after 8 s idle, recreate").rerun?.verdict.median).toBe(0.000548);
    expect(outlier("TOX", "client idle, toxic timeout 2000 ms downstream")).toEqual([2.016815]);
    expect(cell("TOX", "client idle, toxic timeout 2000 ms downstream").verdict.voided).toBe(1);
    expect(cell("TOX", "client idle, toxic timeout 2000 ms downstream").rerun?.verdict.median).toBe(2.002326);
  });

  it("has three warm-up runs outside their bands, each the first toxic of an environment", () => {
    const outside = sets.flatMap((each) =>
      each.verdict.band === null
        ? []
        : each.warmups.flatMap((run) =>
            run.elapsed !== null && (run.elapsed < each.verdict.band!.low || run.elapsed > each.verdict.band!.high) ? [run.elapsed] : [],
          ),
    );
    expect(outside.sort()).toEqual([2.005031, 2.018418, 2.02667]);
  });

  it("voids the runs of a slow listing of the router, of a slow commit of a toxic, and of a timer that the VM delayed", () => {
    const voids = sets.flatMap((each) => each.runs.flatMap((run) => (run.void === null ? [] : [run.void])));
    const kind = (form: RegExp) => voids.filter((reason) => form.test(reason)).length;
    expect(voids).toHaveLength(10);
    expect(kind(/^a listing of the router took/)).toBe(5);
    expect(kind(/^the commit of the fault took/)).toBe(1);
    expect(kind(/behind its wheel slot: the VM delayed it/)).toBe(4);
    expect(cell("T03", "client idle, reset-both, keepidle 6 s").verdict.voided).toBe(1);
    expect(cell("T03", "server idle, reset-both, tcp-keepalive 6 s").verdict.voided).toBe(4);
  });

  it("gives the T01 slice the verdicts of the page of the network failures, and medians near its medians", () => {
    const slice = topologies.cells.filter((each) => each.catalog === "T01");
    for (const each of slice) expect((each.rerun ?? each).verdict.decision).toBe(each.faults?.decision);
    const moved = slice.flatMap((each) =>
      each.verdict.median === null || each.faults?.median == null || each.verdict.median < 1 ? [] : [Math.abs(each.verdict.median - each.faults.median)],
    );
    expect(moved).toHaveLength(7);
    expect(Math.max(...moved)).toBeLessThan(0.1);
    expect([median("T01", "client idle, fin"), cell("T01", "client idle, fin").faults?.median]).toEqual([0.000094, 0.000065]);
    expect([median("T01", "client stream, netem loss 5%"), cell("T01", "client stream, netem loss 5%").faults?.median]).toEqual([0.000447, 0.000226]);
  });

  it("names no machine: no boot id, image digest, container, namespace inode, user or path", () => {
    const text = readFileSync(new URL("./topologies-2026-10-16.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|cookie|container|docker|[0-9a-f]{12,}/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt)\/|AppData|WSL|microsoft/i);
  });
});
