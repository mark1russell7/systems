/**
 * The lenses of the egress queue agree with the cells EQ.1 to EQ.7. Each preset of a cell gives the
 * qdisc and the bursts of the cell. The page sends each datagram that the cell sends. The page drops
 * each datagram that the cell drops, for the same reason. The cell adds the jitter of its sends and the
 * noise of the machine. Thus its band of each departure holds the departure of the page.
 */
import { convert, quantity, valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { EGRESS_SPECS, lawsOf, type EgressSpec } from "../../cells/src/egress.ts";
import { controlsOf, lanesOf } from "../src/model/lens.ts";
import { EGRESS_DEFAULTS, EGRESS_LENSES, EGRESS_PRESETS, egressModel, headlineOf, netemOf, tbfOf, type EgressSettings } from "../src/model/lenses/egress.ts";

const MS = 1_000_000;

/** This function gives the preset of the page for a cell. */
const presetOf = (spec: EgressSpec): EgressSettings => {
  const preset = EGRESS_PRESETS.find((p) => p.cell === spec.plan);
  if (preset === undefined) throw new Error(`no preset for the cell ${spec.plan}`);
  return preset.settings;
};

/** This function gives the outcome of a datagram in words: sent, or dropped and why. */
const word = (outcome: { readonly kind: string; readonly why?: string }): string => (outcome.kind === "sent" ? "sent" : `dropped at the ${outcome.why}`);

const lanes = (settings: EgressSettings) => lanesOf(Object.values(EGRESS_LENSES), settings);
const verdictOf = (settings: EgressSettings, id: string): string | undefined => lanes(settings).find((lane) => lane.id === id)?.verdict;

describe("the lenses of the egress queue and the cells", () => {
  it("has one preset for each cell, and the cells set IP_RECVERR", () => {
    expect(EGRESS_PRESETS.flatMap((p) => (p.cell === null ? [] : [p.cell]))).toEqual(EGRESS_SPECS.map((spec) => spec.plan));
    for (const spec of EGRESS_SPECS) expect(presetOf(spec).recverr).toBe(true);
  });

  it.each(EGRESS_SPECS.map((spec) => [spec.plan, spec] as const))("%s: the preset gives the qdisc and the bursts of the cell", (_, spec) => {
    const settings = presetOf(spec);
    expect(settings.qdisc).toBe(spec.queue.kind);
    if (spec.queue.kind === "netem") expect(netemOf(settings)).toEqual({ latency: 0, ...spec.queue.netem });
    else expect(tbfOf(settings)).toEqual(spec.queue.tbf);
    expect(settings.train.map((burst) => ({ at: valueIn(burst.at, "ms"), count: burst.frames, payload: valueIn(burst.payload, "B") }))).toEqual(spec.bursts);
  });

  it.each(EGRESS_SPECS.map((spec) => [spec.plan, spec] as const))("%s: each datagram has the outcome of the cell, and each departure is inside the band of the cell", (_, spec) => {
    const model = egressModel(presetOf(spec));
    const laws = lawsOf(spec);
    expect(model.frames.map((frame) => word(frame.outcome))).toEqual(laws.map(word));
    model.frames.forEach((frame, index) => {
      const law = laws[index]!;
      if (frame.outcome.kind !== "sent" || law.kind !== "sent") return;
      const start = spec.bursts[frame.burst - 1]!.at * MS;
      const left = (frame.outcome.at - start) / 1e9;
      expect(left).toBeGreaterThanOrEqual(valueIn(law.left.low, "s"));
      expect(left).toBeLessThanOrEqual(valueIn(law.left.high, "s"));
    });
  });

  it("gives the times of EQ.1: one full frame each 12.112 ms", () => {
    const model = egressModel(presetOf(EGRESS_SPECS[0]!));
    expect(model.frameTime).toBe(12_112_000);
    expect(model.drain).toBe(10 * 12_112_000);
    expect(model.peak.packets).toBe(10);
  });

  it("knows a drop at the program only with IP_RECVERR", () => {
    const eq2 = presetOf(EGRESS_SPECS[1]!);
    const silent = EGRESS_PRESETS.find((p) => p.id === "silent")!.settings;
    expect(egressModel(silent).limitDrops).toBe(10);
    expect(verdictOf(eq2, "program")).toBe("detects");
    expect(verdictOf(silent, "program")).toBe("silent");
    expect(verdictOf(eq2, "qdisc")).toBe("detects");
    expect(verdictOf(silent, "qdisc")).toBe("detects");
    expect(headlineOf(eq2)).toContain("ENOBUFS");
    expect(headlineOf(silent)).toContain("does not know");
  });

  it("drops a frame longer than the bucket of tbf before its queue", () => {
    const model = egressModel(presetOf(EGRESS_SPECS[6]!));
    expect(model.sizeDrops).toBe(1);
    expect(model.limitDrops).toBe(0);
    expect(model.maxSize).toBe(1500);
  });

  it("sends each datagram of the defaults of Linux, with no drop and a silent program", () => {
    const model = egressModel(EGRESS_DEFAULTS);
    expect(model.sent).toBe(10);
    expect(model.firstDrop).toBeNull();
    expect(lanes(EGRESS_DEFAULTS).map((lane) => [lane.id, lane.verdict])).toEqual([
      ["program", "silent"],
      ["qdisc", "silent"],
      ["device", "recovers"],
    ]);
  });

  it("warns on the device when a payload is larger than the MTU less the headers of UDP and IP", () => {
    const big = { ...EGRESS_DEFAULTS, train: [{ ...EGRESS_DEFAULTS.train[0]!, payload: quantity(1473, "B") }] };
    expect(lanes(EGRESS_DEFAULTS).find((lane) => lane.id === "device")?.warning).toBeNull();
    expect(lanes(big).find((lane) => lane.id === "device")?.warning).not.toBeNull();
  });

  it("converts the rate of the qdisc in bytes", () => {
    expect(netemOf(EGRESS_DEFAULTS).rate).toBe(125_000);
    expect(valueIn(convert(quantity(10, "Mbit/s"), "B/s"), "B/s")).toBe(1_250_000);
  });

  it("shows each knob of the settings on one lens", () => {
    const controls = controlsOf<EgressSettings>(Object.values(EGRESS_LENSES));
    const shown = [...controls.values()].flat();
    expect(new Set(shown).size).toBe(shown.length);
    expect([...shown].sort()).toEqual(Object.keys(EGRESS_DEFAULTS).sort());
  });
});
