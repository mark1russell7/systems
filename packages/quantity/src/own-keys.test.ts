import { describe, expect, it } from "vitest";
import { convertible, format, formatUnit, kindOf, parseUnit, quantity, tryParseUnit } from "./index.ts";

// Each name that a plain object inherits. None is a unit, so each lookup must miss it.
const INHERITED = Object.getOwnPropertyNames(Object.prototype);

describe("a spelling that an object inherits is no unit", () => {
  it.each(INHERITED)("%s: parseUnit throws a UnitError, not a TypeError", (name) => {
    let error: unknown;
    try {
      parseUnit(name);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as Error).name).toBe("UnitError");
  });

  it.each(INHERITED)("%s: tryParseUnit gives undefined", (name) => {
    expect(tryParseUnit(name)).toBeUndefined();
  });
});

describe("the kind of a unit ignores what it counts", () => {
  it("gives mass for g/{each}, and the two units do not convert", () => {
    expect(kindOf("g/{each}")).toBe("mass");
    expect(kindOf("kg")).toBe("mass");
    expect(convertible("g/{each}", "kg")).toBe(false);
  });
});

describe("the words of a unit are own keys only", () => {
  it("formats day and week as words, and a plain unit with no inherited word", () => {
    expect(format(quantity(2, "d"))).toBe("2 days");
    expect(formatUnit("kg")).not.toMatch(/function|\[object/);
  });
});
