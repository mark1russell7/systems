// What a shard of the workflow Cells needs before its cells operate. A cell on a fabric needs
// containerlab, thus a run of '.' or of a refresh round installs it too, and not only a run whose
// `only` names E3. The step of the workflow starts needs-cli.ts.

import type { Cell } from "@mark1russell7/harness";
import { catalogs, needsContainerlab, selectedOf, selectionOf } from "./all.ts";

/** The needs of one shard: if it needs containerlab, and the names of its cells on a fabric. */
export interface ShardNeeds {
  readonly containerlab: boolean;
  readonly cells: readonly string[];
}

/**
 * This function gives the needs of a shard from the variables of the runner (run.test.ts):
 * CELLS_ONLY, CELLS_SELECTION, CELLS_SHARD, CELLS_FILE and CELLS_PAIR.
 */
export const needsOf = (env: Readonly<Record<string, string | undefined>>, read: (path: string) => string): ShardNeeds => {
  // The cells of the limiter pair replace the catalogs, and no cell of the pair is on a fabric.
  if (env["CELLS_PAIR"]) return { containerlab: false, cells: [] };
  const only = selectionOf(env["CELLS_SELECTION"] || undefined, env["CELLS_ONLY"] || undefined);
  const [shard, of] = (env["CELLS_SHARD"] ?? "0/1").split("/").map(Number) as [number, number];
  const file = env["CELLS_FILE"] || undefined;
  const source: readonly Cell[] = file === undefined ? catalogs() : (JSON.parse(read(file)) as Cell[]);
  const cells = selectedOf(source, only, shard, of)
    .filter(needsContainerlab)
    .map((each) => each.name);
  return { containerlab: cells.length > 0, cells };
};
