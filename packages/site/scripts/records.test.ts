import { describe, expect, it } from "vitest";
import { commitOf, voidsOf } from "./records.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("the commit of a copy", () => {
  it("gives the one commit of the records", () => {
    expect(commitOf([{ code: { commit: A, dirty: false } }, { code: { commit: A, dirty: false } }])).toEqual({ commit: A });
  });

  it("gives no field for the records of the old form", () => {
    expect(commitOf([{ cell: "x" }, { cell: "y" }])).toEqual({});
  });

  it("stops at two commits", () => {
    expect(() => commitOf([{ code: { commit: A, dirty: false } }, { code: { commit: B, dirty: false } }])).toThrow("the records disagree on the commit of the code");
  });

  it("stops at a mix of the two forms", () => {
    expect(() => commitOf([{ code: { commit: A, dirty: false } }, { cell: "old" }])).toThrow("the record has no commit of the code that operated");
  });

  it("stops at a checkout with changes and at a local debug run", () => {
    expect(() => commitOf([{ code: { commit: A, dirty: true } }])).toThrow("the checkout has changes to tracked files");
    expect(() => commitOf([{ code: { commit: A, dirty: false }, debug: true }])).toThrow("local debug run");
  });

  it("stops at a commit that is not 40 hex digits", () => {
    expect(() => commitOf([{ code: { commit: "abc", dirty: false } }])).toThrow("which is not 40 hex digits");
  });
});

const delayed = (timer: string, jiffies: number): string => `its ${timer} timer ran ${jiffies} jiffies behind its wheel slot: the VM delayed it, not the kernel`;
const commit = (ms: number): string => `the commit of the fault took ${ms} ms, longer than the noise of the pipeline: its start is not known`;

describe("the text of the void runs of a cell", () => {
  it("gives null for no void run", () => {
    expect(voidsOf([])).toBeNull();
  });

  it("keeps the text of the timers that the VM delayed, as the copies on the page have it", () => {
    expect(voidsOf([delayed("retransmit", 3)])).toBe("One run is void: its retransmit timer was 3 jiffies behind its wheel slot. Thus the VM delayed it, not the kernel.");
    expect(voidsOf([delayed("retransmit", 5), delayed("keepalive", 2)])).toBe(
      "2 runs are void: in each, the keepalive or the retransmit timer was 2 to 5 jiffies behind its wheel slot. Thus the VM delayed them, not the kernel.",
    );
  });

  // the scheduled run of the RD cells on 2026-11-08 stopped at this reason, and the lock of the rungs did not operate
  it("tells a fault whose commit was longer than the noise of the pipeline", () => {
    expect(voidsOf([commit(8.4)])).toBe("One run is void: the commit of the fault took 8.4 ms, longer than the noise of the pipeline: its start is not known.");
    expect(voidsOf([commit(13.3), commit(8.4), commit(9)])).toBe(
      "3 runs are void: in each, the commit of the fault took 8.4 to 13.3 ms, longer than the noise of the pipeline: its start is not known.",
    );
  });

  it("gives the range at each place of a reason with two numbers", () => {
    const rtt = (ms: number): string => `rtt-over-assumption: its first round trip was ${ms} ms, above the 4 ms that the prediction assumes`;
    expect(voidsOf([rtt(9), rtt(5)])).toBe("2 runs are void: in each, rtt-over-assumption: its first round trip was 5 to 9 ms, above the 4 ms that the prediction assumes.");
  });

  it("groups the reasons by shape, in the order of the first run of each shape", () => {
    expect(voidsOf([commit(8.4), "the fault never lifted", delayed("retransmit", 3), commit(10)])).toBe(
      [
        "2 runs are void: in each, the commit of the fault took 8.4 to 10 ms, longer than the noise of the pipeline: its start is not known.",
        "One run is void: the fault never lifted.",
        "One run is void: its retransmit timer was 3 jiffies behind its wheel slot. Thus the VM delayed it, not the kernel.",
      ].join(" "),
    );
  });

  it("keeps a digit inside a word as part of the shape", () => {
    expect(voidsOf(["the environment cannot do this cell: ip6tables", "the environment cannot do this cell: ip4tables"])).toBe(
      "One run is void: the environment cannot do this cell: ip6tables. One run is void: the environment cannot do this cell: ip4tables.",
    );
  });
});
