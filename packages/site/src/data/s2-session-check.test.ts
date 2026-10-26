import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import checked from "./s2-session-check-2026-10-26.json";
import partition from "./s2-partition-session-check-2026-10-26.json";
import s2 from "./s2-2026-10-26.json";
import s2Partition from "./s2-partition-2026-10-26.json";

const MODES = ["iptables", "ipvs", "nftables"];
const SUFFIXES = ["endpoints", "lame-duck", "goaway", "session-check"];
const lastsOf = (cells: readonly { readonly lasts: readonly (number | null)[] }[]): number[] => cells.flatMap((cell) => cell.lasts.flatMap((last) => (last === null ? [] : [last])));

describe("the copies of D, the session check of an HTTP/2 client, hold the figures of kind run 40394320219", () => {
  it("have D in each mode of each incident: each cell holds in 3 counted runs", () => {
    for (const [copy, group, tail] of [
      [checked, "callers", ""],
      [partition, "partition", ".partition"],
    ] as const) {
      expect([copy.hz, copy.runs, copy.ranAt]).toEqual([1000, 3, "2026-10-26"]);
      expect(copy.cells.map((cell) => cell.id)).toEqual(MODES.map((mode) => `S2.T07.${mode}.session-check${tail}`));
      expect(copy.cells.every((cell) => cell.group === group && cell.decision === "holds" && cell.counted === 3 && cell.voided === 0 && cell.failed === 0)).toBe(true);
      expect(copy.cells.every((cell) => cell.candidate.label === "D")).toBe(true);
      // the predictions of the catalog: the four candidates of each mode
      expect(copy.predictions.map((each) => each.id)).toEqual(MODES.flatMap((mode) => SUFFIXES.map((suffix) => `S2.T07.${mode}.${suffix}${tail}`)));
      for (const cell of copy.cells) expect(copy.predictions.find((each) => each.id === cell.id)?.candidate, cell.id).toEqual(cell.candidate);
    }
    expect(checked.cells.map((cell) => cell.median)).toEqual([580, 1608, 572]);
    expect(partition.cells.map((cell) => cell.median)).toEqual([73, 158, 107]);
  });

  it("give each counted run a count of failed requests and a time of the last failure in the prediction", () => {
    for (const cell of [...checked.cells, ...partition.cells]) {
      expect(cell.lasts.length, cell.id).toBe(cell.counted);
      for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.expected.low);
      for (const value of cell.values) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.expected.high);
      expect(cell.candidate.end.from, cell.id).toBe("fault");
      for (const last of cell.lasts) {
        if (last === null) continue;
        expect(last, cell.id).toBeGreaterThanOrEqual(cell.candidate.end.low);
        expect(last, cell.id).toBeLessThanOrEqual(cell.candidate.end.high);
      }
    }
    // one run of D in nftables had no session on the target: no failure, thus no time
    expect(checked.cells.find((cell) => cell.id === "S2.T07.nftables.session-check")?.lasts).toEqual([11.5084731, null, 14.900025]);
    // in a partition, D learns at the PING of its check, in about 3 s at the most, and C learns only after the heal
    expect(Math.max(...lastsOf(partition.cells))).toBeLessThan(3.1);
    expect(Math.min(...lastsOf(s2Partition.cells.filter((cell) => cell.candidate.label === "C")))).toBeGreaterThan(26);
  });

  it("have the prediction of C for a pod that cannot serve, and the prediction of the session check for a partitioned pod", () => {
    // the target answers each stream at once, thus the check closes no session, and D is the same as C
    for (const mode of MODES) {
      const c = s2.predictions.find((each) => each.id === `S2.T07.${mode}.goaway`)?.candidate;
      const d = checked.predictions.find((each) => each.id === `S2.T07.${mode}.session-check`)?.candidate;
      expect([d?.expected, d?.end.low], mode).toEqual([c?.expected, c?.end.low]);
      expect(d?.expected, mode).toEqual({ low: 0, high: 2700 });
    }
    // in a partition, each session on the target closes in 1.5 s at the most. IPVS puts each session on the target
    const [iptables, ipvs] = partition.predictions.filter((each) => each.id.endsWith(".session-check.partition")).map((each) => each.candidate);
    expect([iptables?.expected, iptables?.end]).toEqual([{ low: 0, high: 534 }, { from: "fault", low: 0, high: 11.7 }]);
    expect([ipvs?.expected, ipvs?.end]).toEqual([{ low: 0, high: 228 }, { from: "fault", low: 0, high: 1.5 }]);
  });

  it("name no machine: no image digest, address, pod, user or path", () => {
    for (const name of ["./s2-session-check-2026-10-26.json", "./s2-partition-session-check-2026-10-26.json"]) {
      const text = readFileSync(new URL(name, import.meta.url), "utf8");
      expect(text, name).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
      expect(text, name).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
    }
  });
});
