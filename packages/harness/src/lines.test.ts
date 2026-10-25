import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { lines } from "./lab.ts";

describe("the lines of a program", () => {
  it("keeps a text that starts with a brace but is not JSON as an other line, and reads the lines after it", async () => {
    const seen = lines<{ readonly ev: string }>();
    const stream = new PassThrough();
    seen.consume(stream);
    // an object that the program printed with console.log, between two lines of its own
    stream.end(`{"ev":"start"}\n{ code: 'ECONNRESET' }\n{"ev":"done"}\n`);
    await seen.until(["done"], 1_000, "program");
    expect(seen.seen.map((line) => line.ev)).toEqual(["start", "done"]);
    expect(seen.other).toEqual(["{ code: 'ECONNRESET' }"]);
  });
});
