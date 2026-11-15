import { describe, expect, it } from "vitest";
import * as root from "./index.ts";
import * as time from "./time.ts";

const q = root.rationals;

describe("the entry of the times", () => {
  it("converts times, rates and counts exactly", () => {
    expect(q.toNumber(time.convertExact(q.fromDecimal("1.5"), "min", "ms"))).toBe(90_000);
    expect(q.toNumber(time.convertExact(q.fromNumber(250), "count/s", "count/ms"))).toBe(0.25);
    expect(q.toNumber(time.convertExact(q.fromNumber(3), "jiffy", "ms", { hz: 250 }))).toBe(12);
    expect(time.convertible("hr", "s")).toBe(true);
    expect(time.convertible("count", "s")).toBe(false);
    expect(time.canonicalUnit("beats/min")).toBe("bpm");
    expect(time.kindOf("count/s")).toBe("frequency");
  });

  it("refuses a unit outside its table, with the error class of the root entry", () => {
    expect(() => time.parseUnit("m")).toThrow(root.UnitError);
    expect(time.tryParseUnit("kB")).toBeUndefined();
    expect(time.isCanonicalUnit("USD")).toBe(false);
    expect(root.isCanonicalUnit("USD")).toBe(true);
  });

  it("agrees with the root entry on each pair of units of its table", () => {
    const spellings = time.TIME_UNITS.atoms.flatMap((a) => [a.symbol, ...(a.aliases ?? [])]);
    const value = q.fromDecimal("7.25");
    for (const from of spellings) {
      const a = time.parseUnit(from);
      const b = root.parseUnit(from);
      expect({ ...a, factor: q.toString(a.factor) }).toEqual({ ...b, factor: q.toString(b.factor) });
      for (const to of spellings) {
        expect(time.whyNotConvertible(from, to)).toBe(root.whyNotConvertible(from, to));
        if (time.convertible(from, to) && a.param === undefined && time.parseUnit(to).param === undefined) {
          expect(q.toString(time.convertExact(value, from, to))).toBe(
            q.toString(root.convertExact(value, from, to)),
          );
        }
      }
    }
  });

  it("uses the same atoms as the root table", () => {
    for (const atom of time.TIME_UNITS.atoms) expect(root.atomBySymbol.get(atom.symbol)).toBe(atom);
  });
});

describe("unitSystem", () => {
  it("refuses a spelling that names two atoms", () => {
    const s = time.TIME_ATOMS.find((a) => a.symbol === "s");
    const ms = time.TIME_ATOMS.find((a) => a.symbol === "ms");
    if (s === undefined || ms === undefined) throw new Error("the table has no s or ms");
    expect(() => root.unitSystem([s, { ...ms, aliases: ["sec"] }])).toThrow(/names both/);
  });

  it("makes a system of a chosen table", () => {
    const seconds = root.unitSystem(time.TIME_ATOMS);
    expect(seconds.canonicalUnit("hours")).toBe("h");
    expect(seconds.tryParseUnit("count")).toBeUndefined();
  });
});
