import { describe, expect, it } from "vitest";
import { rightFor } from "./flip.ts";

describe("the rule of a read of a flip", () => {
  it("passes a clean read only when it exits with 0", () => {
    expect(rightFor({ status: 0, output: "held: each of the 4 cells holds\n" }, null)).toBe(true);
    expect(rightFor({ status: 1, output: "not held: 1 cell of 4 did not hold\n" }, null)).toBe(false);
  });

  it("passes a red read only when it exits with 1 and names its cause", () => {
    expect(rightFor({ status: 1, output: "not held: 1 cell of 4 did not hold\n" }, "did not hold")).toBe(true);
    expect(rightFor({ status: 1, output: "not held: 1 cell of 4 did not hold\n" }, "had no record")).toBe(false);
    expect(rightFor({ status: 0, output: "did not hold" }, "did not hold")).toBe(false);
  });

  it("does not pass a crash as red", () => {
    const crash = { status: 1, output: "TypeError: Cannot read properties of undefined (reading 'cell')\n" };
    expect(rightFor(crash, "with no pin of the programs")).toBe(false);
    expect(rightFor({ status: null, output: "" }, "did not hold")).toBe(false);
  });
});
