import { describe, expect, it } from "vitest";
import { PORT_SEARCH_CHAIN_LARGEST, portSearchChain, portSearchShares, portSearchSpan } from "./port-search.ts";

describe("the search for a local port", () => {
  it("rounds the size of the range down to an even number", () => {
    expect([1, 2, 3, 4, 5, 16, 17, 28232].map(portSearchSpan)).toEqual([1, 2, 2, 4, 4, 16, 16, 28232]);
  });

  it("gives an even range its size in each round, and the exact chain agrees", () => {
    for (const size of [2, 4, 6, 16]) {
      expect([...portSearchShares(size)]).toEqual([[size, 1]]);
      expect([...portSearchChain(size).keys()]).toEqual([size]);
      expect(portSearchChain(size).get(size)).toBeCloseTo(1, 9);
    }
    expect([...portSearchShares(28232)]).toEqual([[28232, 1]]);
  });

  it("gives a range of 1 its port, and a range of 3 two ports: the top port stays free", () => {
    expect([...portSearchShares(1)]).toEqual([[1, 1]]);
    expect([...portSearchShares(3).keys()]).toEqual([2]);
    expect(portSearchShares(3).get(2)).toBeCloseTo(1, 9);
  });

  it("gives a larger odd range its size or one less, by the random step of each connect", () => {
    // a seeded simulation of the kernel code gave 35447 rounds of 4 in 200000 rounds of a range of 5
    expect(portSearchShares(5).get(4)).toBeCloseTo(45 / 256, 9);
    expect(portSearchShares(5).get(5)).toBeCloseTo(211 / 256, 9);
    expect(portSearchShares(7).get(6)).toBeCloseTo(0.0612, 3);
    expect(portSearchShares(9).get(8)).toBeCloseTo(0.0968, 3);
    for (const size of [5, 7, 9]) {
      const shares = portSearchShares(size);
      expect([...shares.keys()]).toEqual([size - 1, size]);
      expect([...shares.values()].reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 9);
    }
  });

  it("refuses a size or a count of rounds that is not a whole number above 0, and a chain past its limit", () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() => portSearchSpan(bad)).toThrow(/not a whole number above 0/);
      expect(() => portSearchShares(bad)).toThrow(/not a whole number above 0/);
    }
    expect(() => portSearchShares(5, 0)).toThrow(/the count of rounds/);
    expect(() => portSearchShares(PORT_SEARCH_CHAIN_LARGEST + 1)).toThrow(/at most/);
    expect(() => portSearchChain(PORT_SEARCH_CHAIN_LARGEST + 2)).toThrow(/at most/);
  });
});
