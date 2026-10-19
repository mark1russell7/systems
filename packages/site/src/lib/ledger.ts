/**
 * The ledger of the results: one entry for each page of results, from the copies that the pages show. The
 * home page and the head of each page of results read their numbers from here. Thus a person types no
 * number by hand, and each number changes with its copy.
 *
 * The first harness cells are not in the ledger, because the S1 cells replace them.
 */
import faults from "../data/faults-2026-10-17.json";
import harness from "../data/harness-2026-10-13.json";
import http from "../data/http-2026-10-17.json";
import kind from "../data/kind-2026-10-18.json";
import mongodb from "../data/mongodb-2026-10-18.json";
import pg from "../data/pg-2026-10-19.json";
import r3 from "../data/r3-2026-10-17.json";
import rabbitmq from "../data/rabbitmq-2026-10-19.json";
import sentinel from "../data/sentinel-2026-10-17.json";
import topologies from "../data/topologies-2026-10-17.json";

/** The count of the cells of each decision. */
export interface Tally {
  readonly holds: number;
  readonly fails: number;
  readonly measured: number;
  readonly calibration: number;
}

/** One entry of the ledger: a page of results and the numbers of its copy. */
export interface Entry {
  readonly key: string;
  /** the path of the page, from the base of the site */
  readonly href: string;
  readonly label: string;
  /** the catalogs or the slice of the cells */
  readonly tags: readonly string[];
  readonly ranAt: string;
  /** the version of Linux, as major and minor */
  readonly kernel: string;
  readonly hz: number;
  readonly cells: number;
  readonly tally: Tally;
  /** the cells that failed, and then held when the harness repeated them */
  readonly heldOnRerun: number;
  readonly counted: number;
  readonly voided: number;
}

/** This function gives the major and the minor version of a kernel: 6.6.87.2 becomes 6.6. */
const short = (kernel: string): string => kernel.split(".").slice(0, 2).join(".");

/** This function counts the decisions of a list of cells. */
const tallyOf = (decisions: readonly string[]): Tally => ({
  holds: decisions.filter((each) => each === "holds").length,
  fails: decisions.filter((each) => each === "fails").length,
  measured: decisions.filter((each) => each === "measured").length,
  calibration: decisions.filter((each) => each === "calibration").length,
});

const sum = <T>(items: readonly T[], of: (item: T) => number): number => items.reduce((total, item) => total + of(item), 0);
const unique = (items: readonly string[]): string[] => [...new Set(items)];
const latest = (dates: readonly string[]): string => [...dates].sort().at(-1) ?? "";

const s1 = harness.cells.filter((cell) => cell.group !== "calibration");
const stage0 = harness.cells.filter((cell) => cell.group === "calibration");

/** A harness cell of the S1 copy or the calibration, with the fields that the ledger reads. */
type HarnessCell = (typeof harness.cells)[number];
const harnessEntry = (key: string, href: string, label: string, tags: readonly string[], cells: readonly HarnessCell[]): Entry => ({
  key,
  href,
  label,
  tags,
  ranAt: latest(cells.map((cell) => cell.ranAt)),
  kernel: short(cells[0]?.kernel ?? ""),
  hz: Number(cells[0]?.hz ?? 0),
  cells: cells.length,
  tally: tallyOf(cells.map((cell) => cell.verdict.decision)),
  heldOnRerun: 0,
  counted: sum(cells, (cell) => cell.verdict.counted),
  voided: sum(cells, (cell) => cell.verdict.voided),
});

/** A cell of a CI copy, with the fields that the ledger reads. */
interface CiCell {
  readonly catalog: string;
  readonly decision: string;
  readonly counted: number;
  readonly voided: number;
}
const ciEntry = (key: string, label: string, copy: { readonly ranAt: string; readonly kernel: string; readonly hz: number; readonly cells: readonly CiCell[] }): Entry => ({
  key,
  href: `results/${key}/`,
  label,
  tags: unique(copy.cells.map((cell) => cell.catalog).filter((catalog) => catalog !== "CAL")),
  ranAt: copy.ranAt,
  kernel: short(copy.kernel),
  hz: copy.hz,
  cells: copy.cells.length,
  tally: tallyOf(copy.cells.map((cell) => cell.decision)),
  heldOnRerun: 0,
  counted: sum(copy.cells, (cell) => cell.counted),
  voided: sum(copy.cells, (cell) => cell.voided),
});

/** A verdict of a topology cell, with the fields that the ledger reads. */
interface TopologyVerdict {
  readonly decision: string;
  readonly counted: number;
  readonly voided: number;
}
/** A topology cell: its verdict, and the verdict of its re-run, or null when the copy has no re-run of it. */
interface TopologyCell {
  readonly catalog: string;
  readonly verdict: TopologyVerdict;
  readonly rerun: { readonly verdict: TopologyVerdict } | null;
}
const topologyCells: readonly TopologyCell[] = topologies.cells;

/** The entries of the ledger, in the sequence of the program: the calibration first, then each step. */
export const LEDGER: readonly Entry[] = [
  harnessEntry("calibration", "results/calibration/", "Calibration", ["Stage 0"], stage0),
  harnessEntry("cells", "results/cells/", "The S1 cells", ["S1"], s1),
  {
    key: "faults",
    href: "results/faults/",
    label: "Network failures",
    tags: [faults.topology],
    ranAt: faults.ranAt,
    kernel: short(faults.kernel),
    hz: faults.hz,
    cells: faults.cells.length,
    tally: tallyOf(faults.cells.map((cell) => cell.verdict.decision)),
    heldOnRerun: 0,
    counted: sum(faults.cells, (cell) => cell.verdict.counted),
    voided: sum(faults.cells, (cell) => cell.verdict.voided),
  },
  {
    key: "topologies",
    href: "results/topologies/",
    label: "Middleboxes and proxies",
    tags: unique(topologyCells.map((cell) => cell.catalog)),
    ranAt: topologies.ranAt,
    kernel: short(topologies.kernel),
    hz: topologies.hz,
    cells: topologyCells.length,
    tally: tallyOf(topologyCells.map((cell) => cell.verdict.decision)),
    heldOnRerun: topologyCells.filter((cell) => cell.verdict.decision === "fails" && cell.rerun?.verdict.decision === "holds").length,
    counted: sum(topologyCells, (cell) => cell.verdict.counted + (cell.rerun?.verdict.counted ?? 0)),
    voided: sum(topologyCells, (cell) => cell.verdict.voided + (cell.rerun?.verdict.voided ?? 0)),
  },
  ciEntry("sentinel", "Valkey under Sentinel", sentinel),
  ciEntry("http", "HTTP keep-alive", http),
  ciEntry("mongodb", "MongoDB", mongodb),
  ciEntry("pg", "PostgreSQL", pg),
  ciEntry("rabbitmq", "RabbitMQ", rabbitmq),
  {
    key: "kind",
    href: "results/kind/",
    label: "Kubernetes in kind",
    tags: unique(kind.cells.map((cell) => cell.template)),
    ranAt: kind.ranAt,
    kernel: short(kind.kernel),
    hz: kind.hz,
    cells: kind.cells.length,
    tally: tallyOf(kind.cells.map((cell) => cell.decision)),
    heldOnRerun: 0,
    counted: sum(kind.cells, (cell) => cell.counted),
    voided: sum(kind.cells, (cell) => cell.voided),
  },
  {
    key: "r3",
    href: "results/r3/",
    label: "R3: the compiled queue",
    tags: unique(r3.cells.map((cell) => cell.catalog)),
    ranAt: r3.ranAt,
    kernel: short(r3.kernel),
    hz: r3.hz,
    cells: r3.cells.length,
    tally: tallyOf(r3.cells.map((cell) => cell.decision)),
    // a re-run replaces its first run in the copy: the counts are of the re-run
    heldOnRerun: r3.cells.filter((cell) => cell.first === "fails" && cell.decision === "holds").length,
    counted: sum(r3.cells, (cell) => cell.counted),
    voided: sum(r3.cells, (cell) => cell.voided),
  },
];

/** The totals of the ledger over each page of results. */
export const TOTAL = {
  pages: LEDGER.length,
  cells: sum(LEDGER, (entry) => entry.cells),
  tally: {
    holds: sum(LEDGER, (entry) => entry.tally.holds),
    fails: sum(LEDGER, (entry) => entry.tally.fails),
    measured: sum(LEDGER, (entry) => entry.tally.measured),
    calibration: sum(LEDGER, (entry) => entry.tally.calibration),
  },
  heldOnRerun: sum(LEDGER, (entry) => entry.heldOnRerun),
  counted: sum(LEDGER, (entry) => entry.counted),
  voided: sum(LEDGER, (entry) => entry.voided),
  first: [...LEDGER.map((entry) => entry.ranAt)].sort()[0] ?? "",
  last: latest(LEDGER.map((entry) => entry.ranAt)),
} as const;

/** This function gives the entry of a page of results. */
export const entryOf = (key: string): Entry => {
  const entry = LEDGER.find((each) => each.key === key);
  if (entry === undefined) throw new Error(`no entry ${key} in the ledger`);
  return entry;
};
