import { describe, expect, it, vi } from "vitest";

// The root entry must not import zod: a bundle that uses only the amounts does not get it.
// Thus an import of zod in this file fails.
vi.mock("zod", () => {
  throw new Error("The root entry of the package imported zod");
});

describe("the root entry", () => {
  it("does not import zod", async () => {
    const root = await import("./index.ts");
    expect(root.format(root.convert(root.quantity(7875, "s"), "min"))).toBe("131.25 min");
    expect("quantitySchema" in root).toBe(false);
  });
});
