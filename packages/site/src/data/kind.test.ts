import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import kind from "./kind-2026-10-16.json";

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
  it("has 31 cells on Linux 6.17 at HZ 1000: 21 hold, 5 fail, 3 calibrations and 2 measurements only", () => {
    expect([kind.kernel, kind.hz, kind.kubernetes, kind.kind]).toEqual(["6.17.0", 1000, "v1.37.0", "v0.33.0"]);
    expect(kind.cells).toHaveLength(31);
    expect([decisions("holds").length, decisions("fails").length, decisions("calibration").length, decisions("measured").length]).toEqual([21, 5, 3, 2]);
    expect([kind.cells.filter((each) => each.template === "T07").length, kind.cells.filter((each) => each.template === "T18").length]).toEqual([21, 10]);
    expect(kind.cells.every((each) => each.counted === 11 && each.voided === 0 && each.values.length === 11)).toBe(true);
  });

  it("gives the propagation of a deletion in each mode of kube-proxy", () => {
    const propagation = kind.propagation as Readonly<Record<string, (typeof kind.propagation)["iptables"]>>;
    expect(MODES.map((mode) => propagation[mode]?.all?.median)).toEqual([0.059, 0.192, 0.045]);
    expect(MODES.map((mode) => propagation[mode]?.all?.p99)).toEqual([0.105, 0.309, 0.079]);
    expect(MODES.map((mode) => propagation[mode]?.values.length)).toEqual([33, 33, 33]);
    expect(MODES.map((mode) => propagation[mode]?.intake?.median)).toEqual([12.011, 12.01, 12.009]);
  });

  it("decides a deletion with O04 and the hold of the service, in each mode", () => {
    for (const mode of MODES) {
      const kept = cell("T07", `${mode}, pod deletion, the design's hold of 2 s`);
      expect([kept.decision, kept.median, Math.max(...kept.values)]).toEqual(["holds", 0, 0]);
    }
    const lost = MODES.map((mode) => cell("T07", `${mode}, pod deletion, no hold and no preStop`));
    expect(lost.map((each) => [each.decision, each.median, each.failed])).toEqual([
      ["fails", 3, 1],
      ["holds", 13, 0],
      ["holds", 1, 0],
    ]);
  });

  it("fails the three pause cells after their window, and holds them with a hold of 8 s", () => {
    const paused = MODES.map((mode) => cell("T07", `${mode}, ${PAUSE}, the design's hold of 2 s`));
    expect(paused.map((each) => [each.decision, each.median, each.failed])).toEqual([
      ["fails", 61, 8],
      ["fails", 65, 7],
      ["fails", 60, 6],
    ]);
    for (const each of paused) expect(each.why).toMatch(/failed outside the window of −100 ms to 2\.\d+ s after the stop of the intake/);
    for (const mode of MODES) expect(cell("T07", `${mode}, ${PAUSE}, a hold of 8 s`).values.every((value) => value === 0)).toBe(true);
  });

  it("fails the rolling update on one timeout of one request", () => {
    const update = cell("T07", "iptables, rolling update, the design's hold of 2 s");
    expect([update.decision, update.failed, update.values.reduce((sum, value) => sum + value, 0)]).toEqual(["fails", 1, 1]);
    expect(update.why).toMatch(/1 request failed with a timeout/);
  });

  it("empties the Service of T18 in its band after each fault of Redis", () => {
    const faults = [
      "rst from Redis to each replica, the round trip gates readiness",
      "Redis frozen with SIGSTOP, the round trip gates readiness",
      "blackhole between Redis and each replica, the round trip gates readiness",
      "Redis gone without a close, the round trip gates readiness",
    ].map((name) => cell("T18", name));
    expect(faults.map((each) => each.median)).toEqual([34.244, 43.12, 42.277, 42.143]);
    const times = faults.flatMap((each) => each.values);
    expect([Math.min(...times), Math.max(...times)]).toEqual([32.312, 44.948]);
    for (const each of faults) for (const t of each.values) expect(t >= (each.prediction.band?.low ?? NaN) && t <= (each.prediction.band?.high ?? NaN)).toBe(true);
    expect(cell("T18", "blackhole between Redis and each replica, the round trip gates nothing").median).toBe(8507);
  });

  it("gives the liveness, the stall, the rollout and the two measurements", () => {
    expect(cell("T18", "blackhole of Redis, readiness fails liveness").median).toBe(38.043);
    const uncoupled = cell("T18", "blackhole of Redis for 60 s, liveness reads only the event loop");
    expect([uncoupled.unit, Math.max(...uncoupled.values)]).toEqual(["replicas", 0]);
    expect(cell("T18", "the event loop of one replica blocked for 40 s").median).toBe(26.383);
    expect(cell("T18", "rolling update while Redis has no endpoint").median).toBe(6.954);
    expect(decisions("measured").map((each) => [each.id, each.median])).toEqual([
      ["T07.defaults.25", 67],
      ["T18.defaults.9", 1530],
    ]);
    expect(cell("T07", "ipvs, liveness restart, liveness does not fail readiness").median).toBe(22);
  });

  it("names no machine: no image digest, address, pod, user or path", () => {
    const text = readFileSync(new URL("./kind-2026-10-16.json", import.meta.url), "utf8");
    expect(text).not.toMatch(/boot_id|sha256|digest|netns|inode|[0-9a-f]{12,}|\b\d{1,3}(\.\d{1,3}){3}\b/i);
    expect(text).not.toMatch(/@|[A-Za-z]:[\\/]|\\\\|\/(home|Users|tmp|var|mnt|opt)\/|AppData|azure|WSL|microsoft|kubeconfig|lab-\w+-\d/i);
  });
});
