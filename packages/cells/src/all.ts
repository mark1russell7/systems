import type { Cell } from "@mark1russell7/harness";
import { CAL_CELLS } from "./calibration.ts";
import { CELLS } from "./catalog.ts";
import { HTTP_CAL_CELLS, HTTP_HARNESS_CELLS } from "./http/cells.ts";
import { MONGO_CELLS } from "./mongo/harness.ts";
import { T02_CELLS } from "./t02.ts";
import { T03_CELLS } from "./t03.ts";
import { T12_CAL, T12_CELLS } from "./t12.ts";
import { TOX_CELLS } from "./toxiproxy.ts";
import { WST_CELLS } from "./ws-topologies.ts";
import { WS_CELLS } from "./ws.ts";

/**
 * These are the cells of each catalog: T01, T03, T02, Toxiproxy as the subject, then the
 * calibration of each proxy. T12 and the calibration of the stamps of its Sentinels come next. The
 * HTTP cells of T01 and T03 come next, with the calibration of the handling time of the Node
 * clients. The WS cells follow, then the WST cells: the same client through a router or a proxy.
 * The MongoDB cells of T01, T03 and T11 come last.
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
  ...HTTP_CAL_CELLS,
  ...WS_CELLS,
  ...WST_CELLS,
  ...MONGO_CELLS,
];
