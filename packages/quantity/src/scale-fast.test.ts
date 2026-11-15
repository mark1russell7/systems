import { random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { formatOnScaleExact, formatOnScaleFast } from "./format.ts";
import { BYTES_1000, BYTES_1024, DURATION_MS, quantity } from "./index.ts";
import type { Scale } from "./index.ts";

/** The scales of the test: the three of the package, and scales with significant digits, fixed places and compounds. */
const SCALES: Readonly<Record<string, Scale>> = {
  DURATION_MS,
  BYTES_1024,
  BYTES_1000,
  fixed: { steps: [{ unit: "ms", digits: 1, fixed: true }, { unit: "s", digits: 3 }] },
  significant: { steps: [{ unit: "us", digits: 3, significant: 3 }, { unit: "ms", digits: 2, significant: 2 }] },
  compound3: { steps: [], compound: { units: ["d", "h", "min", "s"], parts: 3 } },
  compound1: { steps: [{ unit: "s", digits: 0 }], compound: { units: ["h", "min"], parts: 1 } },
};

/** The unit of the amounts of each scale. */
const UNIT: Readonly<Record<string, string>> = {
  DURATION_MS: "ms",
  BYTES_1024: "B",
  BYTES_1000: "B",
  fixed: "ms",
  significant: "ns",
  compound3: "ms",
  compound1: "s",
};

/** The values near each rounding half, each size of a step and each power of 10, where the doubles are close. */
const edges = (): number[] => {
  const values: number[] = [0, 1, 5, 9.5, 10, 99.5, 100, 999.5, 1000, 1024, 1048575, 1048576, 59999.5, 60000, 3599999.5];
  for (let k = -3; k <= 12; k++) {
    for (const base of [1, 1.005, 1.5, 2.5, 9.995, 9.9995, 9.95, 0.5, 0.05, 0.005]) {
      const value = base * 10 ** k;
      values.push(value, value * (1 + 2 ** -50), value * (1 - 2 ** -50), Number(value.toPrecision(15)));
    }
  }
  for (let v = 9990; v <= 10010; v++) values.push(v, v + 0.5, v - 0.5);
  return values;
};

describe("the fast path of formatOnScale", () => {
  for (const [name, scale] of Object.entries(SCALES)) {
    const unit = UNIT[name] as string;
    const rng = random(`quantity-scale-fast-${name}`);
    const draws = Array.from({ length: 4000 }, () => {
      const pick = rng.next();
      // a third whole, a third with a few decimals, a third any double, over 10 orders of size
      const raw = 10 ** (rng.next() * 10 - 2) * (rng.next() < 0.5 ? 1 : -1);
      return pick < 1 / 3 ? Math.round(raw) : pick < 2 / 3 ? Math.round(raw * 1000) / 1000 : raw;
    });
    const values = [...edges(), ...edges().map((v) => -v), ...draws];

    it(`gives the text of the exact path, or no text, on ${name} (seed ${rng.seed})`, () => {
      const wrong: string[] = [];
      for (const value of values) {
        const amount = quantity(value, unit);
        const fast = formatOnScaleFast(amount, scale);
        const exact = formatOnScaleExact(amount, scale);
        if (fast !== undefined && fast !== exact) wrong.push(`${value} ${unit}: fast ${fast}, exact ${exact}`);
      }
      expect(wrong).toEqual([]);
    });

    it(`decides 95% of the random amounts or more on ${name}`, () => {
      const decided = draws.filter((value) => formatOnScaleFast(quantity(value, unit), scale) !== undefined).length;
      expect(decided / draws.length).toBeGreaterThanOrEqual(0.95);
    });
  }

  it("leaves the cases that the doubles cannot decide to the exact path", () => {
    // 9995 ms is exactly 9.995 s, a half of the hundredths. The double 9.995 is below the half.
    expect(formatOnScaleFast(quantity(9995.000000000002, "ms"), DURATION_MS)).toBeUndefined();
    expect(formatOnScaleFast(quantity(1.005, "s"), { steps: [{ unit: "s", digits: 2 }] })).toBeUndefined();
    expect(formatOnScaleExact(quantity(1.005, "s"), { steps: [{ unit: "s", digits: 2 }] })).toBe("1.01 s");
  });

  it("decides a whole amount exactly, also at a half", () => {
    expect(formatOnScaleFast(quantity(9995, "ms"), DURATION_MS)).toBe("10 s");
    expect(formatOnScaleFast(quantity(1048575, "B"), BYTES_1024)).toBe("1 MiB");
    expect(formatOnScaleFast(quantity(3599500, "ms"), DURATION_MS)).toBe("1 h");
  });

  it("leaves a unit with an offset to the exact path", () => {
    const scale: Scale = { steps: [{ unit: "degC", digits: 1 }] };
    expect(formatOnScaleFast(quantity(300, "K"), scale)).toBeUndefined();
  });
});
