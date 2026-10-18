import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import kind from "./kind-2026-10-18.json";

type Cell = (typeof kind.cells)[number];

const cell = (template: string, name: string): Cell => {
  const found = kind.cells.find((each) => each.template === template && each.name === name);
  if (found === undefined) throw new Error(`no cell ${template} ${name}`);
  return found;
};
const decisions = (decision: string) => kind.cells.filter((each) => each.decision === decision);
const MODES = ["iptables", "ipvs", "nftables"] as const;
const PAUSE = "pod deletion while kube-proxy pauses 5 s on one node";

describe("the copy of the kind cells holds the figures of their CI run", () => {
  it("has 31 cells on Linux 6.17 at HZ 1000: 26 hold, 3 calibrations and 2 measurements only", () => {
    expect([kind.kernel, kind.hz, kind.kubernetes, kind.kind]).toEqual(["6.17.0", 1000, "v1.37.0", "v0.33.0"]);
    expect(kind.cells).toHaveLength(31);
    expect([decisions("holds").length, decisions("fails").length, decisions("calibration").length, decisions("measured").length]).toEqual([26, 0, 3, 2]);
    expect([kind.cells.filter((each) => each.template === "T07").length, kind.cells.filter((each) => each.template === "T18").length]).toEqual([21, 10]);
    expect(kind.cells.every((each) => each.counted === 11 && each.voided === 0 && each.values.length === 11)).toBe(true);
  });

  it("gives the propagation of a deletion in each mode of kube-proxy", () => {
    const propagation = kind.propagation as Readonly<Record<string, (typeof kind.propagation)["iptables"]>>;
    expect(MODES.map((mode) => propagation[mode]?.all?.median)).toEqual([0.053, 0.128, 0.051]);
    expect(MODES.map((mode) => propagation[mode]?.all?.p99)).toEqual([0.092, 0.241, 0.131]);
    expect(MODES.map((mode) => propagation[mode]?.values.length)).toEqual([33, 33, 33]);
    expect(MODES.map((mode) => propagation[mode]?.intake?.median)).toEqual([12.011, 12.01, 12.008]);
  });

  it("decides a deletion with O04 and the hold of the service, in each mode", () => {
    for (const mode of MODES) {
      const kept = cell("T07", `${mode}, pod deletion, the design's hold of 2 s`);
      expect([kept.decision, kept.median, Math.max(...kept.values)]).toEqual(["holds", 0, 0]);
    }
    const lost = MODES.map((mode) => cell("T07", `${mode}, pod deletion, no hold and no preStop`));
    expect(lost.map((each) => [each.decision, each.median, each.failed])).toEqual([
      ["holds", 2, 0],
      ["holds", 13, 0],
      ["holds", 2, 0],
    ]);
    // in iptables and nftables, a reset leaves a CLOSE entry with the NAT to the pod, and a reused port meets it
    expect(lost.map((each) => /a reset of the same client closed up to 10 s before it/.test(each.prediction.text))).toEqual([true, false, true]);
  });

  it("holds the pause cells in their window, and no request fails with a hold of 8 s", () => {
    const paused = MODES.map((mode) => cell("T07", `${mode}, ${PAUSE}, the design's hold of 2 s`));
    expect(paused.map((each) => [each.decision, each.median, each.failed])).toEqual([
      ["holds", 57, 0],
      ["holds", 58, 0],
      ["holds", 58, 0],
    ]);
    const held = MODES.map((mode) => cell("T07", `${mode}, ${PAUSE}, a hold of 8 s`));
    expect(held.map((each) => [each.decision, each.values.reduce((sum, value) => sum + value, 0)])).toEqual([
      ["holds", 0],
      ["holds", 0],
      ["holds", 0],
    ]);
  });

  it("holds the rolling update: no request failed", () => {
    const update = cell("T07", "iptables, rolling update, the design's hold of 2 s");
    expect([update.decision, update.failed, update.values.reduce((sum, value) => sum + value, 0)]).toEqual(["holds", 0, 0]);
  });

  it("empties the Service of T18 in its band after each fault of Redis", () => {
    const faults = [
      "rst from Redis to each replica, the round trip gates readiness",
      "Redis frozen with SIGSTOP, the round trip gates readiness",
      "blackhole between Redis and each replica, the round trip gates readiness",
      "Redis gone without a close, the round trip gates readiness",
    ].map((name) => cell("T18", name));
    expect(faults.map((each) => each.median)).toEqual([43.194, 33.89, 42.948, 41.413]);
    const times = faults.flatMap((each) => each.values);
    expect([Math.min(...times), Math.max(...times)]).toEqual([33.042, 43.736]);
    for (const each of faults) for (const t of each.values) expect(t >= (each.prediction.band?.low ?? NaN) && t <= (each.prediction.band?.high ?? NaN)).toBe(true);
    expect(cell("T18", "blackhole between Redis and each replica, the round trip gates nothing").median).toBe(8574);
  });

  it("gives the liveness, the stall, the rollout and the two measurements", () => {
    expect(cell("T18", "blackhole of Redis, readiness fails liveness").median).toBe(39.225);
    const uncoupled = cell("T18", "blackhole of Redis for 60 s, liveness reads only the event loop");
    expect([uncoupled.unit, Math.max(...uncoupled.values)]).toEqual(["replicas", 0]);
    expect(cell("T18", "the event loop of one replica blocked for 40 s").median).toBe(29.07);
    expect(cell("T18", "rolling update while Redis has no endpoint").median).toBe(6.471);
    expect(decisions("measured").map((each) => [each.id, each.median])).toEqual([
      ["T07.defaults.25", 21],
      ["T18.defaults.9", 1282],
    ]);
    expect(cell("T07", "ipvs, liveness restart, liveness does not fail readiness").median).toBe(22);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./kind-2026-10-18.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
