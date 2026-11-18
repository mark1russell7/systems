import { describe, expect, it } from "vitest";
import { type Cause, type Copy, type Placement, neverDownChances, placementProblems, sendChance } from "./availability.ts";

/** The chance of the query by the sum over each state of the causes and the copies. Each chance is a number. */
const byStates = (placement: Placement, atLeast: number, within = Number.POSITIVE_INFINITY): number => {
  const { causes, copies } = placement;
  const send = copies.map((copy) => {
    const t = within - (copy.wait ?? 0);
    let delay = t >= 0 ? 1 : 0;
    if (t >= 0 && copy.delay !== undefined && copy.delay.length > 0) {
      delay = 0;
      for (const point of copy.delay) if (point.within <= t) delay = point.chance as number;
    }
    return (1 - (copy.down as number)) * delay;
  });
  const bits = causes.length + copies.length;
  let total = 0;
  for (let state = 0; state < 2 ** bits; state++) {
    const on = (bit: number): boolean => (state & (1 << bit)) !== 0;
    let chance = 1;
    const down = new Map<string, boolean>();
    for (const [index, cause] of causes.entries()) {
      chance *= on(index) ? (cause.down as number) : 1 - (cause.down as number);
      down.set(cause.id, on(index) || (cause.within ?? []).some((outer) => down.get(outer) === true));
    }
    let count = 0;
    for (const [index, copy] of copies.entries()) {
      const sends = on(causes.length + index);
      chance *= sends ? (send[index] as number) : 1 - (send[index] as number);
      if (sends && copy.needs.every((need) => down.get(need) !== true)) count++;
    }
    if (count >= atLeast) total += chance;
  }
  return total;
};

const point = (placement: Placement, atLeast = 1, within?: number): number => {
  const { lo, hi } = sendChance(placement, within === undefined ? { atLeast } : { atLeast, within });
  expect(hi).toBe(lo);
  return lo;
};

describe("the chance that copies send", () => {
  it("gives one copy its own chance and the chance of its delay", () => {
    const delay = [
      { within: 10, chance: 0.5 },
      { within: 60, chance: 0.9 },
    ];
    const one = (copy: Partial<Copy>): Placement => ({ causes: [], copies: [{ id: "a", needs: [], down: 0.1, ...copy }] });
    expect(point(one({}))).toBeCloseTo(0.9, 15);
    expect(point(one({ delay }), 1, 5)).toBe(0);
    expect(point(one({ delay }), 1, 10)).toBeCloseTo(0.45, 15);
    expect(point(one({ delay }), 1, 59)).toBeCloseTo(0.45, 15);
    expect(point(one({ delay }), 1, 60)).toBeCloseTo(0.81, 15);
    expect(point(one({ delay }))).toBeCloseTo(0.81, 15);
    // the rank wait moves the distribution of the delay
    expect(point(one({ wait: 30, delay: [{ within: 10, chance: 1 }] }), 1, 20)).toBe(0);
    expect(point(one({ wait: 30, delay: [{ within: 10, chance: 1 }] }), 1, 40)).toBeCloseTo(0.9, 15);
  });

  it("gives two copies in one region a smaller chance than two copies in two regions", () => {
    const copies: Copy[] = [
      { id: "a", needs: ["r1"], down: 0.1 },
      { id: "b", needs: ["r1"], down: 0.1 },
    ];
    const shared: Placement = { causes: [{ id: "r1", down: 0.01 }], copies };
    expect(point(shared)).toBeCloseTo(0.99 * (1 - 0.01), 15);
    const apart: Placement = {
      causes: [
        { id: "r1", down: 0.01 },
        { id: "r2", down: 0.01 },
      ],
      copies: [copies[0] as Copy, { id: "b", needs: ["r2"], down: 0.1 }],
    };
    expect(point(apart)).toBeCloseTo(1 - (1 - 0.99 * 0.9) ** 2, 15);
    expect(point(apart)).toBeGreaterThan(point(shared));
  });

  it("fails each region of a provider when the provider fails", () => {
    const placement: Placement = {
      causes: [
        { id: "provider", down: 0.02 },
        { id: "r1", down: 0.01, within: ["provider"] },
        { id: "r2", down: 0.03, within: ["provider"] },
      ],
      copies: [
        { id: "a", needs: ["r1"], down: 0.1 },
        { id: "b", needs: ["r2"], down: 0.2 },
      ],
    };
    const a = 0.99 * 0.9;
    const b = 0.97 * 0.8;
    expect(point(placement)).toBeCloseTo(0.98 * (1 - (1 - a) * (1 - b)), 15);
    expect(point(placement, 2)).toBeCloseTo(0.98 * a * b, 15);
  });

  it("agrees with the sum over each state, for each structure of 3 causes and 3 copies", () => {
    const withins: (readonly (readonly string[])[])[] = [
      [[], [], []],
      [[], ["c0"], []],
      [[], ["c0"], ["c1"]],
      [[], [], ["c0", "c1"]],
    ];
    const downs = [0.1, 0.27, 0.43];
    const copyDowns = [0.05, 0.2, 0.33];
    let checked = 0;
    for (const within of withins) {
      const causes: Cause[] = downs.map((down, index) => ({ id: `c${String(index)}`, down, within: within[index] ?? [] }));
      for (let needs = 0; needs < 8 ** 3; needs++) {
        const copies: Copy[] = copyDowns.map((down, index) => {
          const mask = (needs >> (3 * index)) & 7;
          return { id: `k${String(index)}`, down, needs: causes.filter((_, bit) => (mask & (1 << bit)) !== 0).map((cause) => cause.id) };
        });
        const placement = { causes, copies };
        for (const atLeast of [1, 2, 3]) {
          expect(point(placement, atLeast)).toBeCloseTo(byStates(placement, atLeast), 12);
          checked++;
        }
      }
    }
    expect(checked).toBe(4 * 512 * 3);
  });

  it("agrees with the sum over each state, for overlaps of 5 causes, 5 copies, waits and delays", () => {
    const delay = [
      { within: 5, chance: 0.6 },
      { within: 20, chance: 0.95 },
    ];
    const placement: Placement = {
      causes: [
        { id: "provider", down: 0.01 },
        { id: "west", down: 0.02, within: ["provider"] },
        { id: "grid", down: 0.05 },
        { id: "site", down: 0.1, within: ["grid"] },
        { id: "push", down: 0.003 },
      ],
      copies: [
        { id: "a", needs: ["west", "push"], down: 0.01, delay },
        { id: "b", needs: ["site", "push"], down: 0.05, wait: 30, delay },
        { id: "c", needs: ["west"], down: 0.01, wait: 60, delay },
        { id: "d", needs: ["grid", "push"], down: 0.3, wait: 90 },
        { id: "e", needs: ["provider", "site"], down: 0.2, wait: 120, delay },
      ],
    };
    for (const within of [0, 10, 40, 100, 200, Number.POSITIVE_INFINITY])
      for (const atLeast of [1, 2, 3, 5]) expect(point(placement, atLeast, within)).toBeCloseTo(byStates(placement, atLeast, within), 12);
  });

  it("gives k of n copies with no shared cause the Poisson binomial law", () => {
    const p = 0.8;
    const placement: Placement = { causes: [], copies: ["a", "b", "c"].map((id) => ({ id, needs: [], down: 1 - p })) };
    expect(point(placement, 2)).toBeCloseTo(3 * p ** 2 * (1 - p) + p ** 3, 15);
    expect(point(placement, 3)).toBeCloseTo(p ** 3, 15);
    expect(point(placement, 4)).toBe(0);
  });

  it("solves 40 causes that each copy shares in one step for each cause", () => {
    const channels: Cause[] = Array.from({ length: 40 }, (_, index) => ({ id: `ch${String(index)}`, down: 0.001 * (index + 1) }));
    const regions: Cause[] = Array.from({ length: 10 }, (_, index) => ({ id: `r${String(index)}`, down: 0.01 }));
    const copies: Copy[] = regions.map((region, index) => ({ id: `k${String(index)}`, needs: [region.id, ...channels.map((channel) => channel.id)], down: 0.1 }));
    const all = channels.reduce((chance, channel) => chance * (1 - (channel.down as number)), 1);
    expect(point({ causes: [...channels, ...regions], copies })).toBeCloseTo(all * (1 - (1 - 0.99 * 0.9) ** 10), 12);
  });

  it("gives a cause of chance 1 no copy, and a cause of chance 0 no effect", () => {
    const copies: Copy[] = [
      { id: "a", needs: ["x"], down: 0.1 },
      { id: "b", needs: ["x"], down: 0.1 },
    ];
    expect(point({ causes: [{ id: "x", down: 1 }], copies })).toBe(0);
    expect(point({ causes: [{ id: "x", down: 0 }], copies })).toBeCloseTo(0.99, 15);
  });

  it("gives the ends of the interval from the ends of each chance", () => {
    const placement: Placement = {
      causes: [{ id: "r", down: { lo: 0.01, hi: 0.04 } }],
      copies: [
        { id: "a", needs: ["r"], down: { lo: 0.05, hi: 0.2 }, delay: [{ within: 10, chance: { lo: 0.7, hi: 0.9 } }] },
        { id: "b", needs: [], down: 0.1 },
      ],
    };
    const low: Placement = {
      causes: [{ id: "r", down: 0.04 }],
      copies: [
        { id: "a", needs: ["r"], down: 0.2, delay: [{ within: 10, chance: 0.7 }] },
        { id: "b", needs: [], down: 0.1 },
      ],
    };
    const high: Placement = {
      causes: [{ id: "r", down: 0.01 }],
      copies: [
        { id: "a", needs: ["r"], down: 0.05, delay: [{ within: 10, chance: 0.9 }] },
        { id: "b", needs: [], down: 0.1 },
      ],
    };
    for (const atLeast of [1, 2]) {
      const { lo, hi } = sendChance(placement, { atLeast, within: 15 });
      expect(lo).toBe(point(low, atLeast, 15));
      expect(hi).toBe(point(high, atLeast, 15));
      expect(lo).toBeLessThan(hi);
    }
  });
});

describe("the chance when an item does not fail on its own", () => {
  it("shows the shared channel as the limit of the gain of more copies", () => {
    const placement: Placement = {
      causes: [
        { id: "push", down: 0.05 },
        { id: "r1", down: 0.01 },
        { id: "r2", down: 0.01 },
        { id: "r3", down: 0.01 },
      ],
      copies: ["r1", "r2", "r3"].map((region, index) => ({ id: `k${String(index)}`, needs: [region, "push"], down: 0.1 })),
    };
    const base = point(placement);
    expect(base).toBeLessThanOrEqual(0.95);
    const rows = neverDownChances(placement);
    expect(rows.map((row) => `${row.of} ${row.id}`)).toEqual(["cause push", "cause r1", "cause r2", "cause r3", "copy k0", "copy k1", "copy k2"]);
    const withoutPush = point({ causes: placement.causes.slice(1), copies: placement.copies.map((copy) => ({ ...copy, needs: copy.needs.filter((need) => need !== "push") })) });
    expect(rows[0]?.chance.lo).toBeCloseTo(withoutPush, 15);
    // a perfect channel gains more than a perfect region or a perfect copy
    for (const row of rows.slice(1)) {
      expect(row.chance.lo).toBeGreaterThanOrEqual(base);
      expect(row.chance.lo).toBeLessThan(rows[0]?.chance.lo ?? 0);
    }
  });

  it("keeps a cause down when a cause that contains it fails", () => {
    const placement: Placement = {
      causes: [
        { id: "provider", down: 0.1 },
        { id: "region", down: 0.2, within: ["provider"] },
      ],
      copies: [{ id: "a", needs: ["region"], down: 0 }],
    };
    const [provider, region, copy] = neverDownChances(placement);
    expect(provider?.chance.lo).toBeCloseTo(0.8, 15);
    expect(region?.chance.lo).toBeCloseTo(0.9, 15);
    expect(copy?.chance.lo).toBeCloseTo(0.72, 15);
  });
});

describe("the problems of a placement and a query", () => {
  it("names each problem", () => {
    const placement: Placement = {
      causes: [
        { id: "a", down: 0.1, within: ["b"] },
        { id: "b", down: 1.5 },
        { id: "b", down: { lo: 0.3, hi: 0.2 } },
        { id: "c", down: { lo: -1, hi: 0.2 }, within: ["c"] },
      ],
      copies: [
        { id: "x", needs: ["a", "z"], down: Number.NaN, wait: -1 },
        {
          id: "x",
          needs: [],
          down: 0,
          wait: Number.POSITIVE_INFINITY,
          delay: [
            { within: 10, chance: 0.5 },
            { within: 10, chance: 0.6 },
            { within: 20, chance: 0.4 },
            { within: Number.NaN, chance: 2 },
          ],
        },
      ],
    };
    expect(placementProblems(placement)).toEqual([
      "cause a: within b, which is not a cause before it",
      "cause b: down: the chance 1.5 is not from 0 to 1",
      "cause b: the name is not unique",
      "cause b: down: the low end 0.3 is above the high end 0.2",
      "cause c: within c, which is not a cause before it",
      "cause c: down: the interval -1 to 0.2 is not from 0 to 1",
      "copy x: needs z, which is not a cause",
      "copy x: down: the chance NaN is not from 0 to 1",
      "copy x: the wait -1 is not a time of 0 or more",
      "copy x: the name is not unique",
      "copy x: the wait Infinity is not a time of 0 or more",
      "copy x: delay point 1: within 10 is not after the point before it",
      "copy x: delay point 2: the chance is less than the chance of the point before it",
      "copy x: delay point 3: within NaN is not a time of 0 or more",
      "copy x: delay point 3: the chance 2 is not from 0 to 1",
    ]);
    expect(placementProblems({ causes: [], copies: [] })).toEqual([]);
  });

  it("refuses a placement or a query with a problem", () => {
    const good: Placement = { causes: [], copies: [{ id: "a", needs: [], down: 0.1 }] };
    expect(() => sendChance({ causes: [], copies: [{ id: "a", needs: ["z"], down: 0.1 }] })).toThrow(RangeError);
    expect(() => sendChance(good, { atLeast: 0 })).toThrow("sendChance: atLeast 0 is not a whole number of 1 or more");
    expect(() => sendChance(good, { atLeast: 1.5 })).toThrow(RangeError);
    expect(() => sendChance(good, { within: -1 })).toThrow("within -1 is not a time of 0 or more");
    expect(() => sendChance(good, { within: Number.NaN })).toThrow(RangeError);
    expect(() => neverDownChances(good, { atLeast: 0 })).toThrow("neverDownChances: atLeast 0");
    expect(point(good, 2)).toBe(0);
    expect(point({ causes: [], copies: [] })).toBe(0);
  });
});
