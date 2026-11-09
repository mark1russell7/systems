import { describe, expect, it, vi } from "vitest";

// The root entry must not import zod: a bundle that uses only the algebra does not get it.
// Thus an import of zod in this file fails.
vi.mock("zod", () => {
  throw new Error("The root entry of the package imported zod");
});

describe("the root entry", () => {
  it("does not import zod", async () => {
    const root = await import("./index.ts");
    const keepalive = { expr: "idle + interval * probes", unit: "s" };
    expect(root.exprKnobs(keepalive)).toEqual(["idle", "interval", "probes"]);
    expect(typeof root.parseExpr(keepalive.expr)).toBe("object");
    expect("machineSchema" in root).toBe(false);
  });
});
