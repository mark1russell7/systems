/**
 * This test holds the two labs to the same results after their arithmetic moved into the algebra and
 * their documents into the machines package. The golden files hold the results of the code before
 * the move, for a grid of inputs. `GOLDEN=write` writes them again.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { quantity, valueIn, type Quantity } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { LINUX_66, detection, keepalive, retransmission, type Knobs, type Situation } from "./linux.ts";
import { PRESETS, requestPath, say, sayBand, type Settings } from "./request.ts";

const s = (value: number): Quantity => quantity(value, "s");
const ms = (value: number): Quantity => quantity(value, "ms");

// ---------------------------------------------------------------------------------------------
// the grid of the page of one request: each preset, and each knob changed one at a time
// ---------------------------------------------------------------------------------------------

const CHANGES: ReadonlyArray<Partial<Settings>> = [
  { fault: "blackhole" },
  { fault: "stall" },
  { fault: "partition" },
  { inFlight: true },
  { inFlight: false },
  { heal: s(1) },
  { heal: s(30) },
  { timeout: ms(0) },
  { timeout: ms(500) },
  { timeout: s(45) },
  { retries: 0 },
  { retries: 5 },
  { backoff: s(1), backoffCap: ms(1500) },
  { keepaliveOn: false },
  { keepidle: s(5), keepintvl: s(2), keepcnt: 3 },
  { keepidle: s(60), keepcnt: 1 },
  { retries2: 3 },
  { retries2: 8 },
  { userTimeout: s(5) },
  { userTimeout: s(30) },
  { rtt: ms(0.1) },
  { rtt: ms(50) },
  { hz: 100 },
  { hz: 250 },
  { dataplane: "ipvs" },
  { dataplane: "cilium" },
  { period: s(1) },
  { period: s(5), threshold: 1 },
  { threshold: 6 },
  { probeTimeout: s(5) },
  { ctEstablished: s(600) },
];

/** These changes go on each preset of a cell: the faults, the place of the request, and a knob of each layer. */
const SHORT: ReadonlyArray<Partial<Settings>> = [
  { fault: "blackhole" },
  { fault: "stall" },
  { fault: "partition" },
  { inFlight: false },
  { inFlight: true },
  { retries2: 5 },
  { timeout: s(2), retries: 1 },
  { heal: s(1) },
  { userTimeout: s(2) },
  { period: s(3), threshold: 2 },
];

/** The defaults get each change, and each other preset gets the short list. */
const grid = (): Array<{ id: string; settings: Settings }> =>
  PRESETS.flatMap((preset) => [
    { id: preset.id, settings: preset.settings },
    ...(preset.id === "defaults" ? CHANGES : SHORT).map((change, n) => ({ id: `${preset.id}+${n}`, settings: { ...preset.settings, ...change } })),
  ]);

const t = (q: Quantity): number => valueIn(q, "s");

const pathOf = (settings: Settings) => {
  const path = requestPath(settings);
  return {
    headline: path.headline,
    first: path.first === null ? null : { layer: path.first.layer, band: [t(path.first.band.low), t(path.first.band.high)], text: sayBand(path.first.band) },
    heal: path.heal === null ? null : t(path.heal),
    layers: path.layers.map((layer) => ({
      id: layer.id,
      verdict: layer.verdict,
      band: layer.band === null ? null : [t(layer.band.low), t(layer.band.high)],
      text: layer.band === null ? null : sayBand(layer.band),
      summary: layer.summary,
      facts: layer.facts.map((fact) => `${fact.label}: ${fact.value}`),
      marks: layer.marks.map((mark) => [t(mark.t), `${mark.kind} ${say(mark.t)} ${mark.label}`]),
      measured: layer.measured.map((m) => [m.at === null ? null : t(m.at), `${m.cell} | ${m.measured} | ${m.computed} | ${m.href}`]),
      warning: layer.warning,
    })),
  };
};

// ---------------------------------------------------------------------------------------------
// the grid of the detection lab: two bases, each knob changed one at a time, and retries × rtt × HZ
// ---------------------------------------------------------------------------------------------

const SCALED: Knobs = { ...LINUX_66, keepidle: 5000, keepintvl: 2000, keepcnt: 3, rtt: 1 };
const SITUATIONS: readonly Situation[] = ["idle", "in-flight", "frozen"];

const labGrid = (): Array<{ id: string; knobs: Knobs }> => {
  const out: Array<{ id: string; knobs: Knobs }> = [];
  const singles: ReadonlyArray<Partial<Knobs>> = [
    { keepidle: 1000 },
    { keepidle: 60_000 },
    { keepintvl: 1000 },
    { keepintvl: 75_000 },
    { keepcnt: 1 },
    { keepcnt: 9 },
    { retries: 1 },
    { retries: 15 },
    { rtt: 0.1 },
    { rtt: 300 },
    { hz: 100 },
    { hz: 300 },
    { hz: 1000 },
  ];
  for (const [name, base] of [["linux", LINUX_66], ["scaled", SCALED]] as const) {
    out.push({ id: name, knobs: base });
    singles.forEach((change, n) => out.push({ id: `${name}+${n}`, knobs: { ...base, ...change } }));
  }
  for (const retries of [1, 3, 5, 15])
    for (const rtt of [0.1, 1, 20, 0.12])
      for (const hz of [100, 250, 300, 1000]) out.push({ id: `r${retries}-rtt${rtt}-hz${hz}`, knobs: { ...SCALED, retries, rtt, hz } });
  return out;
};

const labOf = (knobs: Knobs) => ({
  keepalive: keepalive(knobs),
  retransmission: retransmission(knobs),
  // the bounds of a detection are the bounds of its timer above: each case keeps only its duration
  detection: SITUATIONS.flatMap((situation) =>
    [true, false].map((on) => {
      const found = detection(knobs, situation, on);
      return [situation, on, found.timer, found.bounds?.duration ?? null, found.held.join(" ")];
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
// the comparison
// ---------------------------------------------------------------------------------------------

const REQUEST = new URL("./golden/request.json", import.meta.url);
const LAB = new URL("./golden/lab.json", import.meta.url);

/** This function compares two results: each string the same, and each number within a part in 10^9. */
const same = (actual: unknown, expected: unknown, where: string): void => {
  if (typeof expected === "number" && typeof actual === "number") {
    expect(Math.abs(actual - expected), where).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    expect(actual.length, `${where}: length`).toBe(expected.length);
    expected.forEach((value, n) => same(actual[n], value, `${where}[${n}]`));
    return;
  }
  if (expected !== null && typeof expected === "object" && actual !== null && typeof actual === "object") {
    expect(Object.keys(actual).sort(), `${where}: keys`).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) same((actual as Record<string, unknown>)[key], value, `${where}.${key}`);
    return;
  }
  expect(actual, where).toEqual(expected);
};

/** JSON writes no infinity: a time without an end is the text "never". */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_, v: unknown) => (v === Infinity ? "never" : v)));

describe("the labs give the results of the code before the move", () => {
  const request = Object.fromEntries(grid().map(({ id, settings }) => [id, plain(pathOf(settings))]));
  const lab = Object.fromEntries(labGrid().map(({ id, knobs }) => [id, plain(labOf(knobs))]));
  if (process.env["GOLDEN"] === "write") {
    writeFileSync(REQUEST, `${JSON.stringify(request)}\n`);
    writeFileSync(LAB, `${JSON.stringify(lab)}\n`);
  }

  it("gives the same path of one request for each case of the grid", () => {
    const golden = JSON.parse(readFileSync(REQUEST, "utf8")) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(Object.keys(golden).sort());
    for (const [id, expected] of Object.entries(golden)) same(request[id], expected, id);
  });

  it("gives the same detection lab for each case of the grid", () => {
    const golden = JSON.parse(readFileSync(LAB, "utf8")) as Record<string, unknown>;
    expect(Object.keys(lab).sort()).toEqual(Object.keys(golden).sort());
    for (const [id, expected] of Object.entries(golden)) same(lab[id], expected, id);
  });
});
