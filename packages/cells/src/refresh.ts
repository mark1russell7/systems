import type { Cell } from "@mark1russell7/harness";
import { CELLS } from "./catalog.ts";
import { T01_GRPC } from "./grpc/t01.ts";
import { T02_GRPC } from "./grpc/t02.ts";
import { T03_GRPC } from "./grpc/t03.ts";
import { HTTP_HARNESS_CELLS } from "./http/cells.ts";
import { MONGO_CELLS } from "./mongo/harness.ts";
import { T01_HIKARI } from "./pg/hikari.ts";
import { T01_PG } from "./pg/t01.ts";
import { T03_HIKARI } from "./pg/t03.ts";
import { T10_HIKARI, T10_PG } from "./pg/t10.ts";
import { T01_AMQP } from "./rabbit/t01.ts";
import { T11_RABBIT } from "./rabbit/t11.ts";
import { T02_CELLS } from "./t02.ts";
import { T03_CELLS } from "./t03.ts";
import { T12_CAL, T12_CELLS } from "./t12.ts";
import { TOX_CELLS } from "./toxiproxy.ts";

/**
 * A refresh operates the cells of a study of the site again, inside the age limit of its page (SYS-101, issue 368).
 * `page` is the path of the page in the stamps of the site, and `cells` are the cells of its copy. `exporter` is the
 * script in packages/site/scripts that writes its copy. `round` is the round of the schedule that operates the study.
 */
export interface Refresh {
  readonly page: string;
  readonly cells: readonly Cell[];
  readonly exporter: string;
  readonly round: number;
}

/** A study with a limit that no round operates yet, with what it needs first. */
export interface Unscheduled {
  readonly page: string;
  readonly needs: string;
}

/** The schedule has 4 rounds, one each week. Thus each study operates again each 28 days, inside its limit of 30 days. */
export const ROUNDS = 4;

/** Round 0 operated first on this day, a Wednesday. The workflow Cells has the same day as `REFRESH_EPOCH`. */
export const REFRESH_EPOCH = "2026-11-11";

/** The schedule of the rounds in the workflow Cells: each Wednesday at 12:30 UTC. */
export const REFRESH_CRON = "30 12 * * 3";

/** Each round operates on this count of shards. The workflow Cells has the same count as `REFRESH_SHARDS`. */
export const REFRESH_SHARDS = 8;

/**
 * These are the studies that the rounds operate. The file refresh-cost.json gives the measured seconds of each cell.
 * Round 0 takes approximately 15 runner hours, round 1 13, round 2 17 and round 3 19.
 */
export const REFRESHES: readonly Refresh[] = [
  { page: "results/mongodb/index.html", cells: MONGO_CELLS, exporter: "mongodb", round: 0 },
  { page: "results/faults/index.html", cells: CELLS, exporter: "faults", round: 0 },
  { page: "results/rabbitmq/index.html", cells: [...T01_AMQP, ...T11_RABBIT], exporter: "rabbitmq", round: 1 },
  { page: "results/sentinel/index.html", cells: [...T12_CELLS, T12_CAL], exporter: "sentinel", round: 1 },
  { page: "results/topologies/index.html", cells: [...T03_CELLS, ...T02_CELLS, ...TOX_CELLS], exporter: "topologies", round: 1 },
  { page: "results/http/index.html", cells: HTTP_HARNESS_CELLS, exporter: "http", round: 1 },
  { page: "results/pg/index.html", cells: [...T01_PG, ...T01_HIKARI, ...T03_HIKARI, ...T10_PG, ...T10_HIKARI], exporter: "pg", round: 2 },
  { page: "results/grpc/index.html", cells: [...T01_GRPC, ...T03_GRPC, ...T02_GRPC], exporter: "grpc", round: 3 },
];

/** These studies have a limit, but no round operates them yet. Each one gets its round before 2026-12-07. */
export const UNSCHEDULED: readonly Unscheduled[] = [
  { page: "results/r3/index.html", needs: "its cells are compiled from the corpus into a file at a ref, thus a round needs that file on a branch" },
  { page: "results/kind/index.html", needs: "the check of SYS-99 in kind.yml, then a schedule in kind.yml" },
  { page: "results/mesh/index.html", needs: "the check of SYS-99 in kind.yml, then a schedule in kind.yml" },
  { page: "results/calibration/index.html", needs: "a study on the runners of GitHub in place of the records of one lab machine" },
  { page: "results/timers/index.html", needs: "a study on the runners of GitHub in place of the records of one lab machine" },
  { page: "lab/detection/index.html", needs: "a study on the runners of GitHub in place of the records of one lab machine" },
  { page: "index.html", needs: "the study of lab/detection: the home page shows its runs" },
];

const DAY = 86_400_000;

/** This function gives the round of the schedule on a day: the count of whole weeks after `REFRESH_EPOCH`, modulo `ROUNDS`. */
export const roundAt = (at: Date): number => {
  const weeks = Math.floor((at.getTime() - Date.parse(`${REFRESH_EPOCH}T00:00:00Z`)) / (7 * DAY));
  if (weeks < 0) throw new Error(`no round operates before ${REFRESH_EPOCH}`);
  return weeks % ROUNDS;
};

/** This function writes a text that a regular expression matches as it is. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** This function gives the selection of a round: each cell of its studies, by its whole name. */
export const refreshOf = (round: number): RegExp => {
  const names = REFRESHES.filter((each) => each.round === round).flatMap((each) => each.cells.map((cell) => literal(cell.name)));
  if (names.length === 0) throw new Error(`the round ${round} has no study`);
  return new RegExp(`^(?:${names.join("|")})$`);
};

/** These are the selections of the rounds, by name: `refresh-0` to `refresh-3`. */
export const REFRESH_CELLS: Readonly<Record<string, RegExp>> = Object.fromEntries(
  Array.from({ length: ROUNDS }, (_, round) => [`refresh-${round}`, refreshOf(round)]),
);
