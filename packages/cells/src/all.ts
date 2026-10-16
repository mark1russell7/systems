import type { Cell } from "@mark1russell7/harness";
import { CELLS } from "./catalog.ts";
import { T02_CELLS } from "./t02.ts";
import { T03_CELLS } from "./t03.ts";
import { TOX_CELLS } from "./toxiproxy.ts";

/** These are the cells of each catalog: T01, T03, T02, then Toxiproxy as the subject. */
export const ALL: readonly Cell[] = [...CELLS, ...T03_CELLS, ...T02_CELLS, ...TOX_CELLS];
