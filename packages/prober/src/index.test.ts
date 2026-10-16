import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RECORD_KINDS } from "./index.ts";

const at = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

/**
 * The record contract is written three times: the C enum that the kernel side stamps, the names of
 * the Rust decoder, and these. They must agree in sequence, or a record reads as the wrong kind.
 */
describe("the record contract, the same in C, in Rust and here", () => {
  it("names each kind of record in the C enum's order", async () => {
    const header = await readFile(at("bpf/prober.h"), "utf8");
    const enumBody = /enum \{\s*(EV_STATE[\s\S]*?)\};/.exec(header)?.[1] ?? "";
    const c = [...enumBody.matchAll(/EV_([A-Z0-9_]+)/g)].map((match) => match[1]!);
    const rust = await readFile(at("native/src/record.rs"), "utf8");
    const listed = /const KINDS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(rust)?.[1] ?? "";
    const names = [...listed.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]!);
    expect(c).toHaveLength(RECORD_KINDS.length);
    expect(names).toEqual([...RECORD_KINDS]);
    // the C names, lowercased, are the kinds where the two spell them alike
    expect(c.map((name) => name.toLowerCase())).toEqual([
      "state",
      "accept",
      "retrans",
      "rst_tx",
      "rst_rx",
      "error",
      "destroy",
      "tw_enter",
      "tw_kill",
      "req_new",
      "rst_v4",
      "probe",
      "rx",
      "timer",
      "tx",
    ]);
  });
});
