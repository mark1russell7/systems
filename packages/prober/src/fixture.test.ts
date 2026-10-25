import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CASES, RECORD_SIZE, fixture } from "./fixture.ts";

describe("the identity fixture every collector decodes", () => {
  it("is exactly what the generator makes, never hand-edited", async () => {
    const committed = await readFile(new URL("../fixtures/records.bin", import.meta.url));
    expect(Buffer.from(fixture()).equals(committed)).toBe(true);
  });

  it("holds every case as one whole record, and ends with one cut short", () => {
    const bytes = fixture();
    expect(bytes.length).toBe(CASES.length * RECORD_SIZE + 12);
    // every kind of the contract, and two it does not know
    const kinds = new Set(
      CASES.map((_, index) => new DataView(bytes.buffer).getUint32(index * RECORD_SIZE + 56, true)),
    );
    for (let kind = 1; kind <= 15; kind += 1) expect(kinds.has(kind), `kind ${kind}`).toBe(true);
    expect(kinds.has(0) && kinds.has(99)).toBe(true);
  });

  it("has the record size of the comparison script, which cuts the fixture into whole records", async () => {
    // a script at an old size cut a record in two, thus each copy of its throughput fixture started inside a record
    const script = await readFile(new URL("../image/compare.sh", import.meta.url), "utf8");
    expect(script).toContain(`\nSIZE=${RECORD_SIZE}\n`);
    expect(script).not.toMatch(/head -c \$\(\(\d/);
  });
});
