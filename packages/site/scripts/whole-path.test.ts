/**
 * The page of the whole path puts the stages of one connection on one timeline. These tests hold the
 * combinator of the stages, the exit of each preset, the times of each stage on the whole timeline, and
 * the knobs of the page. Each stage has the lenses of its own page, thus its lanes are the lanes of that page.
 */
import { valueIn, type Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { bandOf, controlsOf, lanesOf, sequence, shiftBand, shiftExit, shiftLane, type Band, type Lane, type Stage } from "../src/model/lens.ts";
import { QUEUE_LENSES } from "../src/model/lenses/accept-queue.ts";
import { PORT_LENSES } from "../src/model/lenses/ports.ts";
import { s } from "../src/model/path.ts";
import { LENSES } from "../src/model/request.ts";
import { LINKED_KNOBS, STAGES, WHOLE_DEFAULTS, WHOLE_PRESETS, linked, wholePath, type WholeSettings } from "../src/model/whole-path.ts";

const sec = (q: Quantity): number => valueIn(q, "s");
const ends = (band: Band | null): [number, number] | null => (band === null ? null : [sec(band.low), sec(band.high)]);

const preset = (id: string): WholeSettings => {
  const found = WHOLE_PRESETS.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found.settings;
};

/** This function gives a lane with one band and one mark, for the tests of the combinator. */
const lane = (id: string, at: number): Lane => ({
  id,
  verdict: "detects",
  band: bandOf(s(at), s(at + 0.5)),
  summary: `${id} acts`,
  facts: [],
  marks: [{ t: s(at), kind: "send", label: "send" }],
  measured: [],
  warning: null,
});

/** This function gives a stage of one lane that passes or ends at `at`. */
const stage = (id: string, at: number, kind: "pass" | "end"): Stage<null> => ({
  id,
  title: id,
  short: id,
  lenses: [{ id, names: { title: id, label: id, short: id, term: null }, knobs: [], lanes: () => [lane(id, at)] }],
  exit: () => (kind === "pass" ? { kind, at: bandOf(s(at), s(at + 1)), label: `${id} passes` } : { kind, at: bandOf(s(at)), label: `${id} ends` }),
});

describe("the combinator of the stages", () => {
  it("moves a band by each end of a band", () => {
    expect(ends(shiftBand(bandOf(s(1), s(2)), bandOf(s(10), s(20))))).toEqual([11, 22]);
  });

  it("moves a mark by the low end of the start, and keeps an end with no time", () => {
    const moved = shiftLane(lane("a", 1), bandOf(s(10), s(12)));
    expect(ends(moved.band)).toEqual([11, 13.5]);
    expect(sec(moved.marks[0]!.t)).toBe(11);
    expect(shiftExit({ kind: "end", at: null, label: "never" }, bandOf(s(10)))).toEqual({ kind: "end", at: null, label: "never" });
  });

  it("starts the first stage at 0 s and each next stage at the pass of the stage before", () => {
    const [a, b, c] = sequence([stage("a", 1, "pass"), stage("b", 2, "pass"), stage("c", 3, "pass")], null);
    expect(ends(a!.start)).toEqual([0, 0]);
    expect(ends(b!.start)).toEqual([1, 2]);
    expect(ends(c!.start)).toEqual([3, 5]);
    // the own lanes keep the time of the stage, and the lanes on the whole timeline move
    expect(ends(c!.own[0]!.band)).toEqual([3, 3.5]);
    expect(ends(c!.lanes[0]!.band)).toEqual([6, 8.5]);
    expect(c!.exit?.kind === "pass" ? ends(c!.exit.at) : null).toEqual([6, 9]);
  });

  it("gives no start and no lanes to the stages after an end", () => {
    const [a, b, c] = sequence([stage("a", 1, "pass"), stage("b", 2, "end"), stage("c", 3, "pass")], null);
    expect(a!.exit?.kind).toBe("pass");
    expect(b!.exit?.kind).toBe("end");
    expect(c).toEqual({ stage: expect.objectContaining({ id: "c" }), start: null, own: [], lanes: [], exit: null });
  });
});

describe("the exits of the presets", () => {
  it("defaults: the connection reaches the request, and the fault starts at its start", () => {
    const result = wholePath(preset("defaults"));
    const [ports, queue, request] = result.stages;
    expect(ports!.exit?.kind).toBe("pass");
    expect(queue!.exit?.kind).toBe("pass");
    expect(request!.start).not.toBeNull();
    expect(result.fault).not.toBeNull();
    expect(sec(result.fault!.start)).toBe(sec(request!.start!.low));
  });

  it("ports: the connect gets EADDRNOTAVAIL, and the later stages have no lanes", () => {
    const result = wholePath(preset("ports"));
    const [ports, queue, request] = result.stages;
    expect(ports!.exit).toMatchObject({ kind: "end", label: expect.stringContaining("EADDRNOTAVAIL") });
    expect(queue!.start).toBeNull();
    expect(request!.start).toBeNull();
    expect(result.fault).toBeNull();
    expect(result.lanes).toEqual(ports!.lanes);
    expect(result.headline).toContain("never reaches the target");
  });

  it.each([
    ["syn", "ETIMEDOUT"],
    ["abort", "ECONNRESET"],
  ])("%s: the queue ends the connect with %s", (id, error) => {
    const result = wholePath(preset(id));
    const [, queue, request] = result.stages;
    expect(queue!.exit).toMatchObject({ kind: "end", label: expect.stringContaining(error) });
    expect(request!.start).toBeNull();
    expect(result.headline).toContain("The request never starts");
  });

  it("drain: the queue passes after the accept at 2.5 s, and the request starts then", () => {
    const result = wholePath(preset("drain"));
    const [, queue, request] = result.stages;
    expect(queue!.exit?.kind).toBe("pass");
    expect(sec(request!.start!.low)).toBeGreaterThanOrEqual(2.5);
    expect(result.headline).toContain("the fault starts then");
  });

  it("partition: the reply comes after the partition heals", () => {
    const result = wholePath(preset("partition"));
    const [, , request] = result.stages;
    expect(request!.exit?.kind).toBe("pass");
    expect(sec(result.fault!.end!) - sec(result.fault!.start)).toBeCloseTo(3.5, 9);
  });
});

describe("each stage on the whole timeline", () => {
  it.each(WHOLE_PRESETS.map((p) => [p.id, p.settings] as const))("%s: the lanes of each stage are the lanes of its page, moved by its start", (_, settings) => {
    const pages = [Object.values(PORT_LENSES), Object.values(QUEUE_LENSES), LENSES];
    const result = wholePath(settings);
    result.stages.forEach((staged, n) => {
      expect(staged.stage.lenses).toEqual(pages[n]);
      if (staged.start === null) return;
      expect(staged.own).toEqual(lanesOf(pages[n]!, linked(settings)));
      expect(staged.lanes).toEqual(staged.own.map((own) => shiftLane(own, staged.start!)));
    });
    expect(result.lanes).toEqual(result.stages.flatMap((staged) => staged.lanes));
  });

  it("sends at once with a request in flight, and sends nothing on an idle connection", () => {
    expect(linked({ ...WHOLE_DEFAULTS, inFlight: true }).send).toBe("connected");
    expect(linked({ ...WHOLE_DEFAULTS, inFlight: false }).send).toBe("never");
  });
});

describe("the knobs of the page", () => {
  const controls = controlsOf(STAGES.flatMap((staged) => staged.lenses));
  const knobs = [...controls.values()].flat();

  it("shows each knob on one card only", () => {
    expect(new Set(knobs).size).toBe(knobs.length);
  });

  it("names each linked setting as a knob of a lens, thus the page has a knob to hide", () => {
    for (const name of LINKED_KNOBS) expect(knobs).toContain(name);
  });
});
