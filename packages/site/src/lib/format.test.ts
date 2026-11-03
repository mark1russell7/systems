import { describe, expect, it } from "vitest";
import { count, countTicks, duration, reading, spacedLabels, ticks, ticksBetween } from "./format.ts";

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
    expect(duration(-4)).toBe("−4 ms");
    expect(duration(0)).toBe("0 s");
  });

  it("keeps 4 decimals in a readout from 1 s to 120 s, and the units of its size elsewhere", () => {
    expect(reading(3008.6)).toBe("3.0086 s");
    expect(reading(52_855.355)).toBe("52.8554 s");
    expect(reading(5000)).toBe("5 s");
    expect(reading(0.828)).toBe("828 µs");
    expect(reading(7_875_000)).toBe("2 h 11 min 15 s");
    expect(count(11_462)).toBe("11,462");
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

  it("puts the ticks of an axis of counts on round values", () => {
    expect(countTicks(0, 1600, 4)).toEqual([0, 500, 1000, 1500]);
    expect(countTicks(1400, 1600, 4)).toEqual([1400, 1450, 1500, 1550, 1600]);
    expect(countTicks(0, 3, 10)).toEqual([0, 1, 2, 3]);
  });

  it("drops a label of an axis that would touch the label before it, and ends a label at the edge of the chart", () => {
    // the log axis of the path of a request: 10 min and 20 min are 52 px apart, and 20 min ends at the edge
    const labels = spacedLabels(
      [
        { x: 700, width: 40.2 },
        { x: 752, width: 40.2 },
      ],
      760,
    );
    expect(labels.map((label) => [label.x, label.anchor])).toEqual([[700, "middle"]]);
    const apart = spacedLabels(
      [
        { x: 5, width: 20 },
        { x: 400, width: 40 },
        { x: 790, width: 40 },
      ],
      800,
    );
    expect(apart.map((label) => [label.anchor, label.at])).toEqual([
      ["start", 0],
      ["middle", 400],
      ["end", 800],
    ]);
  });
});
