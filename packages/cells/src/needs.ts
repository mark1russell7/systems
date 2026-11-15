// What a shard of the workflow Cells needs before its cells operate. A cell on a fabric needs
// containerlab, thus a run of '.' or of a refresh round installs it too, and not only a run whose
// `only` names E3. A drill of a large store needs disk: the step "Room on the disk" frees disk
// when the runner has less. The step of the workflow starts needs-cli.ts.

import type { Cell } from "@mark1russell7/harness";
import { roomNeeded } from "@mark1russell7/harness";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { catalogs, needsContainerlab, selectedOf, selectionOf } from "./all.ts";

/** The needs of one shard: containerlab or not, its cells on a fabric, and the most disk of one of its drills. */
export interface ShardNeeds {
  readonly containerlab: boolean;
  readonly cells: readonly string[];
  readonly disk: Quantity;
}

const NO_DISK: Quantity = { value: 0, unit: "B" };

/**
 * This function gives the most disk that the drill of a cell can need, before the runner tells its
 * free disk. With no limit on the disk, the oplog of each member holds the whole data. Thus this is
 * an upper bound of the need that the drill reads on its runner (`roomNeeded`).
 */
export const diskOf = (cell: Cell): Quantity =>
  cell.drill === undefined ? NO_DISK : roomNeeded(cell.drill, cell.replicaSet?.members.length ?? 1, { value: Infinity, unit: "B" });

/**
 * This function gives the needs of a shard from the variables of the runner (run.test.ts):
 * CELLS_ONLY, CELLS_SELECTION, CELLS_SHARD, CELLS_FILE and CELLS_PAIR.
 */
export const needsOf = (env: Readonly<Record<string, string | undefined>>, read: (path: string) => string): ShardNeeds => {
  // The cells of the limiter pair replace the catalogs, and no cell of the pair is on a fabric or is a drill.
  if (env["CELLS_PAIR"]) return { containerlab: false, cells: [], disk: NO_DISK };
  const only = selectionOf(env["CELLS_SELECTION"] || undefined, env["CELLS_ONLY"] || undefined);
  const [shard, of] = (env["CELLS_SHARD"] ?? "0/1").split("/").map(Number) as [number, number];
  const file = env["CELLS_FILE"] || undefined;
  const source: readonly Cell[] = file === undefined ? catalogs() : (JSON.parse(read(file)) as Cell[]);
  const selected = selectedOf(source, only, shard, of);
  const cells = selected.filter(needsContainerlab).map((each) => each.name);
  const disk = selected.map(diskOf).reduce((most, each) => (valueIn(each, "B") > valueIn(most, "B") ? each : most), NO_DISK);
  return { containerlab: cells.length > 0, cells, disk };
};
