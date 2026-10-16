import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "@mark1russell7/harness";
import { measure, spreadOf } from "@mark1russell7/harness";
import { quantity, valueIn } from "@mark1russell7/quantity";
import { describe, expect, it } from "vitest";
import { HTTP_CAL_CELLS } from "./cells.ts";
import { HANDLING } from "./race.ts";

/**
 * The reader of the calibration of the handling time. It starts only with HANDLING_RECORDS, the
 * folder of the artifacts of a run of the CAL cells (`gh run download`). It measures each counted
 * run of each CAL record with the band of the catalog: the time from the last received segment of
 * the first reply to the FIN of the client. Then it prints the spread of each client and of each
 * runner, and it checks that `HANDLING` bounds each time.
 */
const FOLDER = process.env["HANDLING_RECORDS"];

/** A record is the raw record of a cell, as `run.test.ts` writes it. */
interface CellRecord {
  readonly format: string;
  readonly cell: { readonly name: string };
  readonly runs: readonly Run[];
}

/** This function gives each file under a folder. */
const filesOf = (folder: string): string[] =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesOf(path) : [path];
  });

describe.skipIf(FOLDER === undefined)("the calibration of the handling time, from the records of a run", () => {
  it("gives the spread of each Node client, and HANDLING bounds each counted run", () => {
    const times: Record<"agent" | "undici", number[]> = { agent: [], undici: [] };
    for (const path of filesOf(FOLDER!).filter((each) => each.endsWith(".json"))) {
      const record = JSON.parse(readFileSync(path, "utf8")) as CellRecord;
      const cell = HTTP_CAL_CELLS.find((each) => each.name === record.cell.name);
      if (record.format !== "loom.cell-record/1" || cell === undefined) continue;
      const client = cell.client === "http-agent" ? "agent" : "undici";
      const counted = record.runs
        .map((run) => measure(cell, run))
        .filter((read) => read.void === null && read.elapsed !== null && read.outcome.kind === "closed")
        .map((read) => valueIn(read.elapsed!, "s"));
      times[client].push(...counted);
      const runner = readFileSync(join(path, "..", "runner.txt"), "utf8").match(/^cpu: (.*)$/m)?.[1] ?? "an unknown CPU";
      const spread = spreadOf(counted.map((each) => quantity(each, "s")));
      console.log(`${cell.name} on ${runner}: ${counted.length} runs, median ${spread?.median.value} s, max ${spread?.max.value} s`);
    }
    for (const client of ["agent", "undici"] as const) {
      const spread = spreadOf(times[client].map((each) => quantity(each, "s")));
      console.log(`${client}: ${JSON.stringify(spread)}, HANDLING ${HANDLING[client]} s`);
      expect(times[client].length, client).toBeGreaterThan(0);
      expect(Math.max(...times[client]), client).toBeLessThanOrEqual(HANDLING[client]);
    }
  });
});
