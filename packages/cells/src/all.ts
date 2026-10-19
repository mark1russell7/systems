import type { Cell, Subject } from "@mark1russell7/harness";
import { SUBJECTS } from "@mark1russell7/harness";
import { CAL_CELLS } from "./calibration.ts";
import { CELLS } from "./catalog.ts";
import { T01_GRPC } from "./grpc/t01.ts";
import { T02_GRPC } from "./grpc/t02.ts";
import { T03_GRPC } from "./grpc/t03.ts";
import { HTTP_CAL_CELLS, HTTP_HARNESS_CELLS } from "./http/cells.ts";
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
import { wstCells } from "./ws-topologies.ts";
import { wsCells } from "./ws.ts";

/**
 * These are the subjects of the catalogs that take one, by their names. `procedures` is the
 * subject of the WS and WST catalogs. Each one that a caller does not give is the subject that the
 * harness ships.
 */
export interface Subjects {
  readonly procedures: Subject;
}

/**
 * This function gives the cells of each catalog, on the subjects that a caller gives. T01, T03, T02
 * and Toxiproxy as the subject come first, then the calibration of each proxy. T12 and the
 * calibration of the stamps of its Sentinels come next. The HTTP cells of T01 and T03 come next,
 * with the calibration of the handling time of the Node clients. The WS cells follow, then the
 * WST cells: the same client through a router or a proxy. The MongoDB cells of T01, T03 and T11
 * come next, then the PostgreSQL cells of T01, T03 and T10. The RabbitMQ cells of T01 and T11 come next, and the gRPC cells of T01 and T03 last.
 */
export const catalogs = (given: Partial<Subjects> = {}): readonly Cell[] => {
  const subjects: Subjects = { procedures: SUBJECTS.procedures, ...given };
  return [
    ...CELLS,
    ...T03_CELLS,
    ...T02_CELLS,
    ...TOX_CELLS,
    ...CAL_CELLS,
    ...T12_CELLS,
    T12_CAL,
    ...HTTP_HARNESS_CELLS,
    ...HTTP_CAL_CELLS,
    ...wsCells(subjects.procedures),
    ...wstCells(subjects.procedures),
    ...MONGO_CELLS,
    ...T01_PG,
    ...T01_HIKARI,
    ...T03_HIKARI,
    ...T10_HIKARI,
    ...T10_PG,
    ...T01_AMQP,
    ...T11_RABBIT,
    ...T01_GRPC,
    ...T03_GRPC,
    ...T02_GRPC,
  ];
};

/** These are the cells of each catalog, on the subjects that the harness ships. */
export const ALL: readonly Cell[] = catalogs();
