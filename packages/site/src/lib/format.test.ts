import { describe, expect, it } from "vitest";
import { duration, ticks, ticksBetween } from "./format.ts";

describe("the formats of the site", () => {
  it("writes a time with the units of its size, and no zeros at the end", () => {
    expect(duration(0.5)).toBe("500 µs");
    expect(duration(4)).toBe("4 ms");
    expect(duration(1)).toBe("1 ms");
    expect(duration(5000)).toBe("5 s");
    expect(duration(6340)).toBe("6.34 s");
    expect(duration(11_352)).toBe("11.352 s");
    expect(duration(7_875_000)).toBe("2 h 11 min 15 s");
    expect(duration(Infinity)).toBe("never");
  });

  it("puts the ticks of an axis on round values", () => {
    expect(ticks(11.4)).toEqual([0, 5, 10]);
    expect(ticks(11.4, 10)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("puts the ticks of a zoomed axis on round values in a unit that suits the span", () => {
    const zoom = ticksBetween(10_900, 11_450, 5);
    expect(zoom.unit.name).toBe("s");
    expect(zoom.values).toEqual([11_000, 11_200, 11_400]);
    const wide = ticksBetween(0, 30_000, 3);
    expect(wide.unit.name).toBe("s");
    expect(wide.values).toEqual([0, 10_000, 20_000, 30_000]);
  });
});
