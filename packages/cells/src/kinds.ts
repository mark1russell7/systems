import type { KindCell } from "@mark1russell7/kind";
import { CALLERS_CELLS } from "./callers.ts";
import { GATE_CELLS } from "./gate.ts";
import { BACKLOG_BAND_CELLS, BACKLOG_CELLS, BACKLOG_DRAIN_CELLS, BACKLOG_TERMS_CELLS } from "./backlog.ts";
import { DETECTION_CELLS } from "./detection.ts";
import { DNS_CELLS } from "./dns.ts";
import { METALLB_CELLS } from "./metallb.ts";
import { VIP_CELLS } from "./vip.ts";
import { T07_GRPC } from "./grpc/t07.ts";
import { T15_GRPC } from "./grpc/t15.ts";
import { T07_CELLS } from "./t07.ts";
import { T18_CELLS } from "./t18.ts";

/** This is each kind catalog, in the sequence of the runner (`kind.test.ts`). */
export const KIND_CATALOG: readonly KindCell[] = [
  ...T07_CELLS,
  ...T18_CELLS,
  ...T07_GRPC,
  ...T15_GRPC,
  ...CALLERS_CELLS,
  ...GATE_CELLS,
  ...BACKLOG_CELLS,
  ...BACKLOG_BAND_CELLS,
  ...BACKLOG_DRAIN_CELLS,
  ...BACKLOG_TERMS_CELLS,
  ...DNS_CELLS,
  ...VIP_CELLS,
  ...METALLB_CELLS,
  ...DETECTION_CELLS,
];
