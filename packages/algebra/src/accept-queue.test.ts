import { describe, expect, it } from "vitest";
import { acceptQueueHeld, acceptQueueLimit } from "./accept-queue.ts";

describe("the count of the accept queue", () => {
  it("keeps a backlog at or below somaxconn", () => {
    expect(acceptQueueLimit(4, 4096)).toBe(4);
    expect(acceptQueueLimit(0, 4096)).toBe(0);
    expect(acceptQueueLimit(8, 8)).toBe(8);
  });

  it("clamps a backlog above somaxconn, and a negative backlog, to somaxconn", () => {
    expect(acceptQueueLimit(511, 8)).toBe(8);
    expect(acceptQueueLimit(-1, 4096)).toBe(4096);
  });

  it("holds the limit plus one, because the queue is full only above its limit", () => {
    expect(acceptQueueHeld(4, 4096)).toBe(5);
    expect(acceptQueueHeld(511, 8)).toBe(9);
    expect(acceptQueueHeld(0, 4096)).toBe(1);
  });

  it("refuses a count that is not a whole number, and a negative somaxconn", () => {
    expect(() => acceptQueueLimit(1.5, 4096)).toThrow("the backlog is not a whole number: 1.5");
    expect(() => acceptQueueLimit(4, Number.NaN)).toThrow("somaxconn is not a whole number");
    expect(() => acceptQueueLimit(4, -1)).toThrow("somaxconn is less than 0: -1");
  });
});
