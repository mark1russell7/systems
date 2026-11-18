import { describe, expect, it, vi } from "vitest";

// The entry of the times must not import the full table of units: a bundle that converts only
// times does not get it. Thus an import of the full table in this file fails.
vi.mock("./units.ts", () => {
  throw new Error("The entry of the times imported the full table of units");
});
vi.mock("./format.ts", () => {
  throw new Error("The entry of the times imported the formats");
});

describe("the entry of the times", () => {
  it("does not import the full table of units", async () => {
    const time = await import("./time.ts");
    expect(time.canonicalUnit("minutes")).toBe("min");
    expect("ATOMS" in time).toBe(false);
  });
});
