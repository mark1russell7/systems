import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import s2 from "./s2-2026-10-26.json";

describe("the copy of the S2 cells holds the figures of their kind run", () => {
  it("has the two candidates in iptables on Linux 6.17 at HZ 1000: each one holds in 3 counted runs", () => {
    expect([s2.kernel, s2.hz, s2.kubernetes, s2.kind, s2.runs]).toEqual(["6.17.0", 1000, "v1.37.0", "v0.33.0", 3]);
    expect(s2.cells.map((cell) => [cell.id, cell.group, cell.decision, cell.counted, cell.voided, cell.failed])).toEqual([
      ["S2.T07.iptables.endpoints", "callers", "holds", 3, 0, 0],
      ["S2.T07.iptables.lame-duck", "callers", "holds", 3, 0, 0],
    ]);
  });

  it("gives each candidate its window and its expected failed requests, against the median run", () => {
    const [a, b] = s2.cells;
    expect([a?.candidate.label, a?.candidate.end, a?.candidate.expected, a?.median]).toEqual(["A", { from: "heal", low: 0, high: 6.16 }, { low: 2250, high: 2712 }, 2542]);
    expect([b?.candidate.label, b?.candidate.end, b?.candidate.expected, b?.median]).toEqual(["B", { from: "fault", low: 8, high: 24.265 }, { low: 600, high: 1350 }, 1095]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./s2-2026-10-26.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
