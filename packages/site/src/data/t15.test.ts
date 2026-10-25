import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import t15 from "./t15-2026-10-25.json";

type Cell = (typeof t15.cells)[number];

const cell = (id: string): Cell => {
  const found = t15.cells.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no cell ${id}`);
  return found;
};

describe("the copy of the T15 cells holds the figures of their two kind runs", () => {
  it("has 15 cells on Linux 6.17 at HZ 1000: 13 hold and 2 are calibrations, with 11 counted runs each", () => {
    expect([t15.kernel, t15.hz, t15.kubernetes, t15.kind]).toEqual(["6.17.0", 1000, "v1.37.0", "v0.33.0"]);
    expect(t15.cells).toHaveLength(15);
    expect(t15.cells.filter((each) => each.decision === "holds")).toHaveLength(13);
    expect(t15.cells.filter((each) => each.decision === "calibration").map((each) => each.id)).toEqual(["CAL.T15.sidecar", "CAL.T15.policy"]);
    expect(t15.cells.every((each) => each.counted === 11 && each.voided === 0 && each.failed === 0 && each.values.length === 11)).toBe(true);
    // the border of O22 waits for its run
    expect(t15.cells.some((each) => each.id === "T15.border-off.92")).toBe(false);
  });

  it("keeps the next run of the cells that failed first: the lab of .79 and the band of .77 changed", () => {
    expect(t15.cells.filter((each) => each.first !== null).map((each) => [each.id, each.first])).toEqual([
      ["T15.border-off.79", "fails"],
      ["T15.border-off.80", "holds"],
      ["T15.border-off.77", "fails"],
    ]);
    expect(cell("T15.border-off.79").name).toMatch(/stateful middlebox/);
    expect([cell("T15.border-off.77").median, Math.min(...cell("T15.border-off.77").values), Math.max(...cell("T15.border-off.77").values)]).toEqual([300.046, 300.02, 300.062]);
  });

  it("gives the propagation of each calibration of the sidecar flavor", () => {
    const propagation = t15.propagation as Readonly<Record<string, { readonly all: { readonly count: number; readonly min: number; readonly median: number; readonly max: number } | null }>>;
    expect(propagation["CAL.T15.sidecar"]?.all).toMatchObject({ count: 33, min: 0.121, median: 0.151, max: 0.193 });
    expect(propagation["CAL.T15.policy"]?.all).toMatchObject({ count: 22, min: 0.227, median: 0.266, max: 0.455 });
  });

  it("puts each socket that ends in its band, and ends no socket where the algebra says none ends", () => {
    for (const each of t15.cells.filter((one) => one.unit === "s")) {
      const band = each.prediction.band;
      if (band === null) throw new Error(`${each.id} has no band`);
      for (const t of each.values) expect(t >= band.low && t <= band.high, `${each.id} ${t}`).toBe(true);
    }
    expect(t15.cells.filter((each) => each.unit === "sockets").map((each) => [each.id, Math.max(...each.values)])).toEqual([
      ["T15.defaults.10", 0],
      ["T15.border-off.79", 0],
    ]);
    expect([cell("T15.defaults.2").median, cell("T15.border-off.87").median, cell("T15.border-off.88").median]).toEqual([20.897, 28.323, 15.305]);
    expect([cell("T15.border-off.85").median, cell("T15.border-off.86").median, cell("T15.border-off.80").median]).toEqual([29.028, 30.032, 38.852]);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./t15-2026-10-25.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
