import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogs, SCHEDULED_CELLS, selectedOf } from "./all.ts";
import { REFRESH_CELLS, REFRESH_CRON, REFRESH_EPOCH, REFRESH_SHARDS, REFRESHES, ROUNDS, refreshOf, roundAt, UNSCHEDULED } from "./refresh.ts";

const workflow = readFileSync(new URL("../../../.github/workflows/cells.yml", import.meta.url), "utf8");

/** The seconds of each cell in the original runs of the studies (refresh-cost.json names the runs). */
const cost = JSON.parse(readFileSync(new URL("./refresh-cost.json", import.meta.url), "utf8")) as {
  readonly runs: readonly number[];
  readonly seconds: Readonly<Record<string, number>>;
};

/** A job of the workflow Cells stops after 340 minutes. A shard keeps 40 minutes for its setup and its images. */
const SHARD_BUDGET = 300 * 60;

const DAY = 86_400_000;
const at = (days: number): Date => new Date(Date.parse(`${REFRESH_EPOCH}T12:00:00Z`) + days * DAY);

describe("the studies of the refresh", () => {
  const all = new Set(catalogs().map((cell) => cell.name));

  it("are cells of the catalogs, each cell in one study only", () => {
    const seen = new Map<string, string>();
    for (const study of REFRESHES) {
      expect(study.cells.length, study.page).toBeGreaterThan(0);
      for (const cell of study.cells) {
        expect(all.has(cell.name), `${study.page}: ${cell.name}`).toBe(true);
        expect(seen.get(cell.name), cell.name).toBeUndefined();
        seen.set(cell.name, study.page);
      }
    }
  });

  it("each have an exporter in the scripts of the site, and one round", () => {
    for (const study of REFRESHES) {
      expect(existsSync(new URL(`../../site/scripts/${study.exporter}.ts`, import.meta.url)), study.exporter).toBe(true);
      expect(Number.isInteger(study.round) && study.round >= 0 && study.round < ROUNDS, study.page).toBe(true);
    }
    const pages = [...REFRESHES, ...UNSCHEDULED].map((each) => each.page);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it("give each round a selection of exactly the cells of its studies", () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const want = REFRESHES.filter((each) => each.round === round).flatMap((each) => each.cells.map((cell) => cell.name));
      const got = selectedOf(catalogs(), refreshOf(round), 0, 1).map((cell) => cell.name);
      expect(new Set(got), `round ${round}`).toEqual(new Set(want));
      expect(SCHEDULED_CELLS[`refresh-${round}`]).toBe(REFRESH_CELLS[`refresh-${round}`]);
    }
  });

  it("fit each shard of each round inside the time of one job, from the measured seconds of each cell", () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const studies = REFRESHES.filter((each) => each.round === round);
      // a cell with no measure gets the mean of the measured cells of its study
      const secondsOf = new Map<string, number>();
      for (const study of studies) {
        const measured = study.cells.flatMap((cell) => (cost.seconds[cell.name] === undefined ? [] : [cost.seconds[cell.name]!]));
        expect(measured.length / study.cells.length, `${study.page}: the share of its cells with a measure`).toBeGreaterThanOrEqual(0.9);
        const mean = measured.reduce((sum, each) => sum + each, 0) / measured.length;
        for (const cell of study.cells) secondsOf.set(cell.name, cost.seconds[cell.name] ?? mean);
      }
      for (let shard = 0; shard < REFRESH_SHARDS; shard += 1) {
        const seconds = selectedOf(catalogs(), refreshOf(round), shard, REFRESH_SHARDS).reduce((sum, cell) => sum + secondsOf.get(cell.name)!, 0);
        expect(seconds, `round ${round}, shard ${shard}`).toBeLessThan(SHARD_BUDGET);
      }
    }
  });
});

describe("the round of a day", () => {
  it("is round 0 in the first week, and each study comes again after 28 days", () => {
    expect(roundAt(at(0))).toBe(0);
    expect(roundAt(at(6))).toBe(0);
    expect(roundAt(at(7))).toBe(1);
    expect(roundAt(at(21))).toBe(3);
    expect(roundAt(at(28))).toBe(0);
    expect(roundAt(at(28 * 13 + 14))).toBe(2);
    expect(() => roundAt(at(-1))).toThrow("no round operates before");
  });

  it("starts on a Wednesday, the day of the cron of the rounds, thus 28 days are under the limit of 30", () => {
    expect(new Date(`${REFRESH_EPOCH}T00:00:00Z`).getUTCDay()).toBe(3);
    expect(REFRESH_CRON.split(" ")[4]).toBe("3");
    expect(7 * ROUNDS).toBeLessThan(30);
  });
});

describe("the workflow Cells", () => {
  it("has the schedule, the first day, the shards and the count of the rounds of the plan", () => {
    expect(workflow).toContain(`- cron: "${REFRESH_CRON}"`);
    expect(workflow).toContain(`"${REFRESH_CRON}")`);
    expect(workflow).toContain(`REFRESH_EPOCH: ${REFRESH_EPOCH}`);
    expect(workflow).toContain(`REFRESH_SHARDS: ${REFRESH_SHARDS}`);
    expect(workflow).toContain(`SELECTION="refresh-$(( days / 7 % ${ROUNDS} ))"`);
    expect(workflow).toContain('pnpm exec tsx packages/site/scripts/refresh.ts "$SELECTION"');
  });

  it("refuses in its plan each selection that is not a scheduled selection", () => {
    const names = Object.keys(SCHEDULED_CELLS).filter((name) => !name.startsWith("refresh-"));
    expect(workflow).toContain(`''|${names.join("|")}|refresh-[0-${ROUNDS - 1}]) ;;`);
  });

  it("names the runs of the measured seconds", () => {
    expect(cost.runs.length).toBeGreaterThan(0);
    expect(Object.keys(cost.seconds).length).toBeGreaterThan(0);
  });
});
