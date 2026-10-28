import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Ledger } from "../lib/ci.ts";
import { keyOf, ratesOf } from "../lib/ci.ts";
import cells from "./ci/cells.json";
import kind from "./ci/kind.json";

const LEDGERS = [kind as Ledger, cells as Ledger];

describe("the CI ledgers", () => {
  it("have one ledger for each workflow of cells, with each event in a run of the ledger", () => {
    expect(LEDGERS.map((ledger) => [ledger.workflow, ledger.file, ledger.idle])).toEqual([
      ["kind", ".github/workflows/kind.yml", 0.6],
      ["cells", ".github/workflows/cells.yml", 0.6],
    ]);
    for (const ledger of LEDGERS) {
      const runs = new Set(ledger.runs.map((run) => run.run));
      expect(runs.size).toBe(ledger.runs.length);
      expect(ledger.events.every((event) => runs.has(event.run))).toBe(true);
      expect(new Set(ledger.events.map(keyOf)).size).toBe(ledger.events.length);
      expect(ledger.events.every((event) => event.link.startsWith(`https://github.com/mark1russell7/systems/actions/runs/${event.run}/job/`))).toBe(true);
    }
  });

  it("hold the hang of run 40591832542: the shard of 6 sessions waited for a quiet VM on Cilium", () => {
    const hang = kind.events.find((event) => event.run === 40591832542);
    expect(hang).toMatchObject({ shard: 3, kind: "hung", cause: "quiet", cell: "S2.T07.cilium.goaway.backlog-band.n6", dataplane: "cilium", step: "The cells", duration: { value: 5166, unit: "s" } });
    expect(hang?.idle).toEqual({ low: 0.46, high: 0.59 });
  });

  it("hold the void run of run 40608863500: the wait for a quiet VM stopped after 300 s at 59% idle", () => {
    const voids = kind.events.filter((event) => event.run === 40608863500);
    expect(voids).toEqual([
      expect.objectContaining({ shard: 3, kind: "void", cause: "quiet", cell: "S2.T07.cilium.goaway.backlog-drain.n6", env: 1, index: 0, duration: { value: 300, unit: "s" }, idle: { low: 0.59, high: 0.59 } }),
    ]);
  });

  it("give a flake rate for each workflow and each dataplane", () => {
    for (const ledger of LEDGERS) {
      const rates = ratesOf(ledger);
      expect(rates.rate).toBeGreaterThanOrEqual(0);
      expect(rates.rate).toBeLessThanOrEqual(1);
      expect(rates.dataplanes.every((each) => each.rate >= 0 && each.quiet <= each.events)).toBe(true);
    }
    expect(ratesOf(kind as Ledger).dataplanes.map((each) => each.dataplane)).toContain("cilium");
  });

  it("keep no name of a person, no machine path and no address", () => {
    for (const name of ["kind", "cells"]) {
      const text = readFileSync(new URL(`./ci/${name}.json`, import.meta.url), "utf8");
      expect(text).not.toMatch(/@[\w-]+|[A-Z]:[\\/]|\/home\/|\b\d{1,3}(\.\d{1,3}){3}\b/);
    }
  });
});
