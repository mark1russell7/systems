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

  it("shares the cap with the entries of other namespaces that expired by their own timeout", () => {
    expect(conntrackFloor(1024, 1000, 0)).toBe(959);
    expect(conntrackFloor(1024, 1000, 5)).toBe(964);
    expect(conntrackFloor(1024, 1000, 65)).toBe(1024);
    expect(conntrackFloor(1024, 1000, 100)).toBe(1024);
    // at a limit of 1000 the point of 95 hundredths stops the scan after 51 drops, thus 14 expired entries change nothing
    expect(conntrackFloor(1000, 1000, 14)).toBe(949);
    expect(conntrackFloor(1000, 1000, 15)).toBe(950);
  });

  it("does not take 95 percent of the limit itself", () => {
    expect(conntrackFloor(1024, 1000)).not.toBe(Math.floor(1024 * 0.95) - 1);
  });
});
