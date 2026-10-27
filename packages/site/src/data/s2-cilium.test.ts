import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Cell {
  readonly id: string;
  readonly group: string;
  readonly decision: "holds" | "fails";
  readonly counted: number;
  readonly voided: number;
  readonly failed: number;
  readonly median: number;
  readonly values: readonly number[];
  readonly failures?: readonly number[];
  readonly lasts?: readonly (number | null)[];
  readonly knows?: readonly (number | null)[];
  readonly pings?: readonly number[];
  readonly prediction: { readonly band?: { readonly low: number; readonly high: number } };
}
interface Copy {
  readonly hz: number;
  readonly runs: number;
  readonly kernel: string;
  readonly cells: readonly Cell[];
}

// the 7 copies of kind run 40558968382: the Cilium column of each incident that the run has cells of
const NAMES = ["s2-cilium", "s2-partition-cilium", "s2-stall-cilium", "s2-prober-cilium", "s2-dependency-cilium", "s2-flapping-cilium", "s2-gate-cilium"] as const;
const textOf = (name: string): string => readFileSync(new URL(`./${name}-2026-10-27.json`, import.meta.url), "utf8");
const copies = Object.fromEntries(NAMES.map((name) => [name, JSON.parse(textOf(name)) as Copy])) as Record<(typeof NAMES)[number], Copy>;
const cellOf = (name: (typeof NAMES)[number], id: string): Cell => {
  const found = copies[name].cells.find((cell) => cell.id === id);
  if (found === undefined) throw new Error(`${name}: no cell ${id}`);
  return found;
};
const four = (tail: string): string[] => ["endpoints", "lame-duck", "goaway", "session-check"].map((suffix) => `S2.T07.cilium.${suffix}${tail}`);

describe("the copies of the Cilium column hold the figures of kind run 40558968382", () => {
  it("have the 21 cells of the run: 20 hold in each counted run, and C of the stall fails in 1 of 3", () => {
    expect(NAMES.map((name) => [copies[name].hz, copies[name].runs])).toEqual([[1000, 11], ...Array.from({ length: 6 }, () => [1000, 3])]);
    expect(NAMES.map((name) => copies[name].cells.map((cell) => cell.id))).toEqual([
      four(""),
      four(".partition"),
      four(".stall"),
      four(".prober"),
      ["S2.T07.cilium.lame-duck.dependency"],
      ["S2.T07.cilium.lame-duck.flapping"],
      ["S2.T07.cilium.shared-gate.dependency", "S2.T07.cilium.shared-gate.flapping", "S2.T07.cilium.shared-gate"],
    ]);
    const cells = NAMES.flatMap((name) => copies[name].cells.map((cell) => [name, cell] as const));
    expect(cells.length).toBe(21);
    for (const [name, cell] of cells) {
      const stall = cell.id === "S2.T07.cilium.goaway.stall";
      expect([cell.decision, cell.counted, cell.voided, cell.failed], cell.id).toEqual([stall ? "fails" : "holds", copies[name].runs, 0, stall ? 1 : 0]);
    }
  });

  it("give the failed requests of the median run: B and C beat A, and D beats C", () => {
    const counts = (name: (typeof NAMES)[number]): number[] => copies[name].cells.map((cell) => cell.median);
    expect(counts("s2-cilium")).toEqual([2810, 956, 622, 734]);
    expect(counts("s2-partition-cilium")).toEqual([19, 21, 1318, 421]);
    expect(counts("s2-stall-cilium")).toEqual([20, 22, 1001, 111]);
    const [a, b, c] = counts("s2-cilium");
    expect([b! < a!, c! < a!]).toEqual([true, true]);
    expect(counts("s2-partition-cilium")[3]!).toBeLessThan(counts("s2-partition-cilium")[2]!);
    expect(counts("s2-stall-cilium")[3]!).toBeLessThan(counts("s2-stall-cilium")[2]!);
    // D learns at the PING of its session check, long before C learns at the retransmission or the resume
    expect(cellOf("s2-partition-cilium", "S2.T07.cilium.session-check.partition").pings).toEqual([2, 2, 2]);
    expect(cellOf("s2-stall-cilium", "S2.T07.cilium.session-check.stall").pings).toEqual([1, 2, 3]);
  });

  it("give the gap of C in the stall: the backlog of the target after the resume, with more sessions on the target", () => {
    const c = cellOf("s2-stall-cilium", "S2.T07.cilium.goaway.stall");
    // the band of the commit before the run: 0 to 1503 failed requests, and the last failure 9.98 s to 10 s after the fault
    expect(c.values).toEqual([1001, 499, 1507]);
    expect(c.lasts).toEqual([10.0941555, 10.0452413, 10.1656767]);
    // each run ends after the band. The run with 3 sessions on the target is over the band of the count too
    for (const last of c.lasts ?? []) expect(last ?? 0).toBeGreaterThan(10);
    expect(Math.max(...c.values)).toBeGreaterThan(1503);
  });

  it("give a failed prober: B, C and D fail fewer requests than A, and each false removal is after the fault", () => {
    const cells = four(".prober").map((id) => cellOf("s2-prober-cilium", id));
    expect(cells.map((cell) => cell.median)).toEqual([20.023, 18.528, 18.927, 19.227]);
    expect(cells.map((cell) => cell.failures)).toEqual([
      [1220, 1506, 1567],
      [13, 27, 22],
      [2, 3, 4],
      [5, 3, 2],
    ]);
    for (const cell of cells) for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(12);
  });

  it("give B on a black-holed and a flapping dependency: Cilium refuses a connect to the empty Service at once", () => {
    const shared = cellOf("s2-dependency-cilium", "S2.T07.cilium.lame-duck.dependency");
    expect([shared.median, shared.failures]).toEqual([18.273, [4541, 4568, 5091]]);
    // B knows near the removal of the target, not at the heal: the fast refusals end the slow failures
    for (const value of shared.knows ?? []) expect(value ?? Number.NaN, shared.id).toBeLessThan(15);
    const flapping = cellOf("s2-flapping-cilium", "S2.T07.cilium.lame-duck.flapping");
    expect([flapping.median, flapping.failures]).toEqual([18.707, [14165, 14150, 13655]]);
    // the gap: each of the 9 faults ends before the band of 24.98 s that the fault of kube-proxy gave
    expect(flapping.knows?.length).toBe(9);
    for (const value of flapping.knows ?? []) expect(value ?? Number.NaN, flapping.id).toBeLessThan(24.98);
  });

  it("give the shared gate (E) the failed requests of B on a dependency, and the removal of B on a pod: the gate stays out of the service", () => {
    const shared = cellOf("s2-gate-cilium", "S2.T07.cilium.shared-gate.dependency");
    const flapping = cellOf("s2-gate-cilium", "S2.T07.cilium.shared-gate.flapping");
    // (a) fails: E is above half the median of B (4568 and 14150)
    expect([shared.median, flapping.median]).toEqual([4342, 13980]);
    expect(shared.median).toBeGreaterThan(4568 / 2);
    expect(flapping.median).toBeGreaterThan(14150 / 2);
    // (b) holds: the removal of the target and the failed requests are in the bands of B
    const pod = cellOf("s2-gate-cilium", "S2.T07.cilium.shared-gate");
    expect([pod.median, pod.failures]).toEqual([15.001, [751, 855, 1501]]);
    for (const value of pod.values) expect(value).toBeGreaterThanOrEqual(pod.prediction.band?.low ?? Number.NaN);
    for (const value of pod.values) expect(value).toBeLessThanOrEqual(pod.prediction.band?.high ?? Number.NaN);
    for (const value of pod.failures ?? []) expect(value).toBeGreaterThanOrEqual(350);
    for (const value of pod.failures ?? []) expect(value).toBeLessThanOrEqual(1913);
  });

  it("name no machine: no image digest, address, pod, user or path", () => {
    for (const name of NAMES) {
      const text = textOf(name);
      expect(text, name).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
      expect(text, name).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
    }
  });
});
