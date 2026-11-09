import { describe, expect, it } from "vitest";
import { BYTES_1000, BYTES_1024, DURATION_MS, formatDuration, formatOnScale, quantity } from "./index.ts";
import type { Scale } from "./index.ts";

/* ---------- The copies that move here, word for word, as the references of the move ---------- */

const number1 = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const number2 = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

/** The copy of lag (`packages/site/src/lib/format.ts`). It selects the unit before it rounds. */
function lagFormatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "–";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${number1.format(value)} ${units[unit]}`;
}

/** The copy of lag (`packages/site/src/lib/format.ts`). It selects the unit before it rounds. */
function lagFormatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  const abs = Math.abs(ms);
  if (abs < 1) return `${number2.format(ms)} ms`;
  if (abs < 10) return `${number1.format(ms)} ms`;
  if (abs < 1000) return `${integer.format(ms)} ms`;
  if (abs < 59_995) return `${number2.format(ms / 1000)} s`;
  const totalSeconds = Math.round(abs / 1000);
  return `${ms < 0 ? "-" : ""}${Math.floor(totalSeconds / 60)} min ${totalSeconds % 60} s`;
}

/** The copy of AsyncBrowserContext (`site/src/lib/format.ts`). It rounds before it selects the unit. */
function abcFormatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "–";
  const units = ["B", "KB", "MB", "GB"];
  const rounded = (value: number): number => Math.round(Math.abs(value) * 10) / 10;
  let value = bytes;
  let unit = 0;
  while (rounded(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${number1.format(value)} ${units[unit]}`;
}

/** The copy of AsyncBrowserContext (`site/src/lib/format.ts`). It rounds before it selects the unit. */
function abcFormatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  if (abs < 1) return `${number2.format(ms)} ms`;
  if (abs < 10) return `${number1.format(ms)} ms`;
  if (Math.round(abs) < 1000) return `${integer.format(ms)} ms`;
  const seconds = Math.round(abs / 10) / 100;
  if (seconds < 60) return `${sign}${number2.format(seconds)} s`;
  const totalSeconds = Math.round(abs / 1000);
  return `${sign}${Math.floor(totalSeconds / 60)} min ${totalSeconds % 60} s`;
}

/** The copy of concat-src (`site/src/reasons.ts`). It has fixed digits and no step above MB. */
function concatFormatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/* ---------- The inputs ---------- */

const KI = 1024;
const MI = KI * KI;
const GI = MI * KI;
const TI = GI * KI;

/** The bytes: each power of 1024 and the values next to it, the steps of rounding, and a sweep. */
const BYTES: number[] = [0, 1, 7, 512, 999, 1000, 1023, 1023.5];
for (const base of [KI, MI, GI, TI]) {
  for (const f of [0.95, 0.9999, 0.99995, 0.99996, 0.99999, 1, 1.04, 1.05, 1.25, 1.5, 9.95, 10, 99.95, 512, 1000, 1023.94, 1023.96]) {
    BYTES.push(Math.round(base * f));
  }
}
for (let k = 0; k < 4000; k++) BYTES.push(Math.round(1.0071 ** k));
const SIGNED_BYTES = [...BYTES, ...BYTES.filter((b) => b > 0).map((b) => -b)];

/** The times in ms: the step edges, the rounding edges, and a sweep from 1 µs to 3 days. */
const TIMES: number[] = [0, 0.001, 0.004, 0.005, 0.42, 0.994, 0.995, 0.996, 1, 3.5, 9.94, 9.95, 9.96, 10, 120];
TIMES.push(999, 999.4, 999.5, 999.6, 1000, 1250, 59_994, 59_995, 59_999, 60_000, 61_000, 119_499, 119_500, 119_600);
TIMES.push(3_599_000, 3_599_499, 3_599_500, 3_600_000, 3_660_000, 7_200_000);
for (let k = 0; k < 3000; k++) TIMES.push(Number((0.001 * 1.0083 ** k).toPrecision(6)));
const SIGNED_TIMES = [...TIMES, ...TIMES.filter((t) => t > 0).map((t) => -t)];

const bytes1024 = (b: number): string => formatOnScale(quantity(b, "B"), BYTES_1024);
const ms = (t: number): string => formatOnScale(quantity(t, "ms"), DURATION_MS);

/** The labels of the copies are JEDEC: "KB" is 1024 bytes there. In quantity, "KB" is 1000 bytes, so the scale says "KiB". */
const toIec = (text: string): string => text.replace(/ KB$/, " KiB").replace(/ MB$/, " MiB").replace(/ GB$/, " GiB");

/** The compound of the copies always names minutes and seconds: "2 min 0 s", "60 min 0 s". */
const minutesSeconds = /^(-?)(\d+) min (\d+) s$/;

/**
 * The compound of the scale names at most 2 whole units from days to seconds, and drops a 0: "2 min", "1 h", "1 h 1 min".
 * Below 1 h, with seconds that are not 0, it is the text of the copy.
 */
const sameAsCopy = (old: string): boolean => {
  const match = minutesSeconds.exec(old);
  return match !== null && Number(match[2]) < 60 && Number(match[3]) > 0;
};

/* ---------- The moves, with each expected difference ---------- */

describe("formatOnScale and the copy of lag formatBytes", () => {
  it("gives its text, with KiB for KB, except where lag selects the unit before it rounds", () => {
    let roundFirst = 0;
    let tebibytes = 0;
    for (const b of SIGNED_BYTES) {
      const old = lagFormatBytes(b);
      const text = bytes1024(b);
      if (text === toIec(old)) continue;
      if (Math.abs(b) >= GI * 1023.95) {
        // the copy has no step above GB: "1,024 GB" is "1 TiB" here
        expect(text, `${b} B`).toMatch(/ TiB$/);
        tebibytes++;
        continue;
      }
      // the fault of lag: 1,048,575 B gives "1,024 KB". The rounded value fills the next step, so here it is "1 MiB"
      expect(old, `${b} B`).toMatch(/^-?1,024 (KB|MB)$/);
      expect(text, `${b} B`).toMatch(/^-?1 (MiB|GiB)$/);
      roundFirst++;
    }
    expect(roundFirst).toBeGreaterThan(0);
    expect(tebibytes).toBeGreaterThan(0);
  });

  it("gives the known fault of lag the new text", () => {
    expect(lagFormatBytes(1_048_575)).toBe("1,024 KB");
    expect(bytes1024(1_048_575)).toBe("1 MiB");
  });
});

describe("formatOnScale and the copy of AsyncBrowserContext formatBytes", () => {
  it("gives its text, with KiB for KB, except above its last step", () => {
    let tebibytes = 0;
    for (const b of SIGNED_BYTES) {
      const text = bytes1024(b);
      const old = toIec(abcFormatBytes(b));
      if (text === old) continue;
      // the copy has no step above GB
      expect(Math.abs(b), `${b} B`).toBeGreaterThanOrEqual(GI * 1023.95);
      expect(text).toMatch(/ TiB$/);
      tebibytes++;
    }
    expect(tebibytes).toBeGreaterThan(0);
  });

  it("gives the examples of its doc comment", () => {
    expect(bytes1024(512)).toBe("512 B");
    expect(bytes1024(1536)).toBe("1.5 KiB");
    expect(bytes1024(MI)).toBe("1 MiB");
  });
});

describe("formatOnScale and the copy of concat-src formatBytes", () => {
  it("gives the same amount in the same unit, with the digits and the grouping of the scale", () => {
    for (const b of BYTES) {
      if (b >= GI * 1023.95) continue;
      const old = concatFormatBytes(b);
      const text = bytes1024(b);
      const [oldValue, oldUnit] = old.split(" ") as [string, string];
      const [value, unit] = text.split(" ") as [string, string];
      const parsed = Number(value.replaceAll(",", ""));
      // the expected differences: KiB for KB, 1 decimal place at most, "1,000 B" for "1000 B", GiB above 1,024 MiB,
      // and the rounded value can fill the next step: "1024.0 KB" is "1 MiB" here
      const unitOfOld = toIec(`0 ${oldUnit}`).slice(2);
      const sizes: Record<string, number> = { B: 1, KiB: KI, MiB: MI, GiB: GI };
      const amount = Number(oldValue) * (sizes[unitOfOld] as number);
      const next = parsed * (sizes[unit] as number);
      // the two texts show the same amount, to the rounding of the coarser text
      const step = Math.max(sizes[unit] as number, sizes[unitOfOld] as number) * 0.1;
      expect(Math.abs(next - amount), `${b} B: ${old} and ${text}`).toBeLessThanOrEqual(step);
      expect(Math.abs(next - b), `${b} B: ${text}`).toBeLessThanOrEqual((sizes[unit] as number) * 0.05 * (1 + 1e-9));
    }
  });

  it("gives the listed text changes", () => {
    const changes: readonly (readonly [number, string, string])[] = [
      [1000, "1000 B", "1,000 B"],
      [1024, "1.0 KB", "1 KiB"],
      [1536, "1.5 KB", "1.5 KiB"],
      [1_048_575, "1024.0 KB", "1 MiB"],
      [1_572_864, "1.50 MB", "1.5 MiB"],
      [1_300_000, "1.24 MB", "1.2 MiB"],
      [5 * GI, "5120.00 MB", "5 GiB"],
    ];
    for (const [b, old, text] of changes) {
      expect(concatFormatBytes(b)).toBe(old);
      expect(bytes1024(b)).toBe(text);
    }
  });
});

describe("formatOnScale and the copy of AsyncBrowserContext formatMs", () => {
  it("gives its text below 1 min, and its compound with the zeros dropped and hours from 60 min", () => {
    let compound = 0;
    for (const t of SIGNED_TIMES) {
      const old = abcFormatMs(t);
      const text = ms(t);
      if (text === old) continue;
      if (old === "-0 ms") {
        // an amount that rounds to 0 has no sign here
        expect(text).toBe("0 ms");
        continue;
      }
      // the compound: the copy says "2 min 0 s" and "61 min 40 s", the scale says "2 min" and "1 h 2 min"
      expect(old, `${t} ms`).toMatch(minutesSeconds);
      expect(sameAsCopy(old), `${t} ms: ${old}`).toBe(false);
      expect(text, `${t} ms`).toBe(`${t < 0 ? "-" : ""}${formatDuration(quantity(Math.abs(t), "ms"), 2)}`);
      compound++;
    }
    expect(compound).toBeGreaterThan(0);
  });

  it("gives the examples of its doc comment", () => {
    expect([0.42, 3.5, 120, 1250, 125_000].map(ms)).toEqual(["0.42 ms", "3.5 ms", "120 ms", "1.25 s", "2 min 5 s"]);
    expect(ms(59_999)).toBe("1 min");
    expect(ms(3_700_000)).toBe("1 h 2 min");
    expect(abcFormatMs(3_700_000)).toBe("61 min 40 s");
    expect(abcFormatMs(59_999)).toBe("1 min 0 s");
  });
});

describe("formatOnScale and the copy of lag formatMs", () => {
  it("gives the text of the copy of AsyncBrowserContext, except where lag selects the unit before it rounds", () => {
    let roundFirst = 0;
    for (const t of SIGNED_TIMES) {
      const old = lagFormatMs(t);
      if (old === abcFormatMs(t)) continue;
      // the fault of lag: 999.6 ms gives "1,000 ms". The rounded value fills the next step, so here it is "1 s"
      expect(old, `${t} ms`).toMatch(/^-?1,000 ms$/);
      expect(ms(t), `${t} ms`).toMatch(/^-?1 s$/);
      roundFirst++;
    }
    expect(roundFirst).toBeGreaterThan(0);
  });
});

/* ---------- The scale itself ---------- */

describe("formatOnScale", () => {
  it("gives the steps of 1000 with the symbols of quantity", () => {
    const bytes1000 = (b: number) => formatOnScale(quantity(b, "B"), BYTES_1000);
    expect([999, 1000, 1500, 999_960, 2_500_000_000, 3e12].map(bytes1000)).toEqual([
      "999 B",
      "1 kB",
      "1.5 kB",
      "1 MB",
      "2.5 GB",
      "3 TB",
    ]);
  });

  it("starts from an amount in any unit of the kind of the scale", () => {
    expect(formatOnScale(quantity(1.5, "KiB"), BYTES_1024)).toBe("1.5 KiB");
    expect(formatOnScale(quantity(2048, "MiB"), BYTES_1024)).toBe("2 GiB");
    expect(formatOnScale(quantity(8, "bit"), BYTES_1024)).toBe("1 B");
    expect(formatOnScale(quantity(1.25, "s"), DURATION_MS)).toBe("1.25 s");
    expect(formatOnScale(quantity(90, "min"), DURATION_MS)).toBe("1 h 30 min");
  });

  it("keeps the fixed digits of a step", () => {
    const fixed: Scale = { steps: [{ unit: "B", digits: 0 }, { unit: "KiB", digits: 1, fixed: true }] };
    expect(formatOnScale(quantity(1024, "B"), fixed)).toBe("1.0 KiB");
    expect(formatOnScale(quantity(1023, "B"), fixed)).toBe("1,023 B");
  });

  it("refuses an amount of another kind, and a scale with no step", () => {
    expect(() => formatOnScale(quantity(1, "s"), BYTES_1024)).toThrow(/cannot show s/);
    expect(() => formatOnScale(quantity(1, "B"), { steps: [] })).toThrow(RangeError);
  });

  it("rounds the exact amount of a step, with a half going up: 9995 ms is 10 s, 1005 ms is 1.01 s", () => {
    // the double 9.995 * 100 is 999.4999999999999, thus a rounding of the double gave "9.99 s" (quantity 0.3.1)
    expect(ms(9995)).toBe("10 s");
    expect(ms(1005)).toBe("1.01 s");
    for (let t = 1000; t < 60_000; t++) {
      // the hundredths of a second, rounded with integers only: floor((t + 5) / 10)
      const hundredths = Math.floor((t + 5) / 10);
      const expected = hundredths < 6000 ? `${number2.format(hundredths / 100)} s` : "1 min";
      expect(ms(t), `${t} ms`).toBe(expected);
    }
  });

  it("rounds the exact amount on the steps of 1000 bytes", () => {
    const bytes1000 = (b: number) => formatOnScale(quantity(b, "B"), BYTES_1000);
    for (let b = 1000; b < 100_000; b++) {
      const tenths = Math.floor((b + 50) / 100);
      expect(bytes1000(b), `${b} B`).toBe(`${number1.format(tenths / 10)} kB`);
    }
  });

  it("rounds the exact amount of the smallest unit of a compound", () => {
    expect(formatOnScale(quantity(62_500, "ms"), DURATION_MS)).toBe("1 min 3 s");
    expect(formatOnScale(quantity(62_499, "ms"), DURATION_MS)).toBe("1 min 2 s");
    expect(formatOnScale(quantity(0.0125, "h"), DURATION_MS)).toBe("45 s");
  });

  it("is formatDuration for a compound with no step", () => {
    for (const s of [1, 59.6, 61, 3599.6, 7875, 86_400, 97_200]) {
      const compound: Scale = { steps: [], compound: { units: ["d", "h", "min", "s"], parts: 3 } };
      expect(formatOnScale(quantity(s, "s"), compound)).toBe(formatDuration(quantity(s, "s")));
    }
  });
});
