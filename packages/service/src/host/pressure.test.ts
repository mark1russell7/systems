import { describe, expect, it } from "vitest";
import { fakeHost } from "./fakes.ts";
import { fullStallMicros, PRESSURE_FILES, readStallMark, stalledShare } from "./pressure.ts";

const psi = (some: number, full: number): string =>
  `some avg10=0.00 avg60=0.00 avg300=0.00 total=${some}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=${full}\n`;

describe("fullStallMicros", () => {
  it("gives the total of the line full", () => {
    expect(fullStallMicros(psi(1234, 567))).toBe(567);
  });

  it("gives null for a text with no line full or a bad total", () => {
    expect(fullStallMicros("some avg10=0.00 avg60=0.00 avg300=0.00 total=12\n")).toBeNull();
    expect(fullStallMicros("full avg10=0.00 total=-4\n")).toBeNull();
    expect(fullStallMicros("full avg10=0.00\n")).toBeNull();
    expect(fullStallMicros("")).toBeNull();
  });
});

describe("readStallMark", () => {
  it("reads the full totals of each pressure file on Linux", async () => {
    const host = fakeHost({ files: { [PRESSURE_FILES[0]!]: psi(9, 100), [PRESSURE_FILES[1]!]: psi(9, 250) } });
    expect(await readStallMark(host.ports)).toEqual({ at: host.clock.now(), totals: [100, 250] });
  });

  it("gives null without the files, with a bad file and on a host that is not Linux", async () => {
    expect(await readStallMark(fakeHost().ports)).toBeNull();
    expect(await readStallMark(fakeHost({ files: { [PRESSURE_FILES[0]!]: psi(1, 1), [PRESSURE_FILES[1]!]: "full total=x\n" } }).ports)).toBeNull();
    const files = { [PRESSURE_FILES[0]!]: psi(1, 1), [PRESSURE_FILES[1]!]: psi(1, 1) };
    expect(await readStallMark(fakeHost({ platform: "win32", files }).ports)).toBeNull();
  });
});

describe("stalledShare", () => {
  it("gives the largest share of the span in a full stall, not above 1", () => {
    expect(stalledShare({ at: 0, totals: [0, 0] }, { at: 1000, totals: [250_000, 600_000] })).toBe(0.6);
    expect(stalledShare({ at: 0, totals: [0] }, { at: 1000, totals: [5_000_000] })).toBe(1);
  });

  it("gives null for a span of zero, totals that go back and marks of different lengths", () => {
    expect(stalledShare({ at: 5, totals: [0] }, { at: 5, totals: [1] })).toBeNull();
    expect(stalledShare({ at: 0, totals: [10] }, { at: 1000, totals: [5] })).toBeNull();
    expect(stalledShare({ at: 0, totals: [0] }, { at: 1000, totals: [0, 0] })).toBeNull();
  });
});
