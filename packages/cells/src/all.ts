import type { Cell } from "@mark1russell7/harness";
import { CAL_CELLS } from "./calibration.ts";
import { CELLS } from "./catalog.ts";
import { HTTP_HARNESS_CELLS } from "./http/cells.ts";
import { T02_CELLS } from "./t02.ts";
import { T03_CELLS } from "./t03.ts";
import { T12_CAL, T12_CELLS } from "./t12.ts";
import { TOX_CELLS } from "./toxiproxy.ts";

/**
 * These are the cells of each catalog: T01, T03, T02, Toxiproxy as the subject, then the
 * calibration of each proxy. T12 and the calibration of the stamps of its Sentinels come next. The
 * HTTP cells of T01 and T03 come last.
 */
export const ALL: readonly Cell[] = [
  ...CELLS,
  ...T03_CELLS,
  ...T02_CELLS,
  ...TOX_CELLS,
  ...CAL_CELLS,
  ...T12_CELLS,
  T12_CAL,
  ...HTTP_HARNESS_CELLS,
];
