import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-2026-10-26.json";

describe("the copy of the S2 cells holds the figures of their kind run", () => {
  it("has the two candidates in each mode on Linux 6.17 at HZ 1000: each one holds in 3 counted runs", () => {
    expect([s2.kernel, s2.hz, s2.kubernetes, s2.kind, s2.runs]).toEqual(["6.17.0", 1000, "v1.37.0", "v0.33.0", 3]);
    const ids = ["iptables", "ipvs", "nftables"].flatMap((mode) => [`S2.T07.${mode}.endpoints`, `S2.T07.${mode}.lame-duck`]);
    expect(s2.cells.map((cell) => cell.id)).toEqual(ids);
    expect(s2.cells.every((cell) => cell.group === "callers" && cell.decision === "holds" && cell.counted === 3 && cell.voided === 0 && cell.failed === 0)).toBe(true);
    expect(s2.cells.map((cell) => cell.median)).toEqual([2119, 738, 2462, 900, 2547, 795]);
  });

  it("gives each candidate its window and its expected failed requests, and each counted run is in that count", () => {
    const [a, b] = s2.cells;
    expect([a?.candidate.label, a?.candidate.end, a?.candidate.expected, a?.candidate.connections]).toEqual(["A", { from: "heal", low: 0, high: 6.16 }, { low: 1313, high: 3842 }, { low: 7, high: 17, of: 24 }]);
    expect([b?.candidate.label, b?.candidate.end, b?.candidate.expected]).toEqual(["B", { from: "fault", low: 8, high: 24.265 }, { low: 350, high: 1913 }]);
    // IPVS selects in turn, thus its band of connections is one count
    expect(s2.cells.filter((cell) => cell.mode === "ipvs").map((cell) => [cell.candidate.connections, cell.candidate.expected])).toEqual([
      [{ low: 12, high: 12, of: 24 }, { low: 2250, high: 2712 }],
      [{ low: 12, high: 12, of: 24 }, { low: 600, high: 1350 }],
    ]);
    for (const cell of s2.cells) for (const value of cell.values) expect(value, cell.id).toBeGreaterThanOrEqual(cell.candidate.expected.low);
    for (const cell of s2.cells) for (const value of cell.values) expect(value, cell.id).toBeLessThanOrEqual(cell.candidate.expected.high);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-2026-10-26.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
