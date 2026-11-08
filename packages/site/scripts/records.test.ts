import { describe, expect, it } from "vitest";
import { commitOf } from "./records.ts";

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
