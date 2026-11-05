import { describe, expect, it } from "vitest";
import { conntrackFloor } from "./conntrack.ts";

describe("the floor of a conntrack scan under pressure", () => {
  it("stops at the cap of the drops when that cap comes first", () => {
    expect(conntrackFloor(1024, 1000)).toBe(959);
    expect(conntrackFloor(1099, 1000)).toBe(1034);
  });

  it("stops at the point of 95 hundredths, in integer arithmetic, when that point comes first", () => {
    expect(conntrackFloor(1000, 1000)).toBe(949);
    expect(conntrackFloor(1024, 250)).toBe(949);
  });

  it("does not take 95 percent of the limit itself", () => {
    expect(conntrackFloor(1024, 1000)).not.toBe(Math.floor(1024 * 0.95) - 1);
  });
});
