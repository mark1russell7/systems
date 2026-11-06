import type { Cell, Subject } from "@mark1russell7/harness";
import { ACCEPT_QUEUE_CELLS } from "./accept-queue.ts";
import { CAL_CELLS } from "./calibration.ts";
import { CELLS } from "./catalog.ts";
import { T01_GRPC } from "./grpc/t01.ts";
import { T02_GRPC } from "./grpc/t02.ts";
import { T03_GRPC } from "./grpc/t03.ts";
import { HTTP_CAL_CELLS, HTTP_HARNESS_CELLS } from "./http/cells.ts";
import { ACKS_CELLS } from "./kafka/acks.ts";
import { FABRIC_CELLS } from "./fabric.ts";
import { LIMITER_CELLS } from "./limiter.ts";
import { MONGO_CELLS } from "./mongo/harness.ts";
import { T11_WRITES_CELLS } from "./mongo/writes.ts";
import { T01_HIKARI } from "./pg/hikari.ts";
import { T01_PG } from "./pg/t01.ts";
import { T03_HIKARI } from "./pg/t03.ts";
import { COMMIT_CELLS } from "./pg/commit.ts";
import { T10_HIKARI, T10_PG } from "./pg/t10.ts";
import { T01_AMQP } from "./rabbit/t01.ts";
import { T11_RABBIT } from "./rabbit/t11.ts";
import { RESEND_CELLS } from "./resend.ts";
import { RECOVERY_CELLS } from "./recovery.ts";
import { T02_CELLS } from "./t02.ts";
import { T03_CELLS } from "./t03.ts";
import { PROCEDURES } from "./subjects.ts";
import { T12_CAL, T12_CELLS } from "./t12.ts";
import { LEASE_CELLS } from "./etcd-lease.ts";
import { WATCH_CELLS } from "./etcd-watch.ts";
import { COUNT_CELLS } from "./retries.ts";
import { TOX_CELLS } from "./toxiproxy.ts";
import { wstCells } from "./ws-topologies.ts";
import { WRITES_CELLS } from "./writes.ts";
import { wsCells } from "./ws.ts";

/**
 * These are the subjects of the catalogs that take one, by their names. `procedures` is the
 * subject of the WS and WST catalogs. Each one that a caller does not give is the procedures
 * subject of the client repository (`PROCEDURES`).
 */
export interface Subjects {
  readonly procedures: Subject;
}

/**
 * This function gives the cells of each catalog, on the subjects that a caller gives. T01, T03, T02
 * and Toxiproxy as the subject come first, then the calibration of each proxy. T12 and the
 * calibration of the stamps of its Sentinels come next. The cells of the writes and of the resend
 * of S3 use the same group. The cells of `acks` of S3 follow them, on a group of Kafka. The HTTP
 * cells of T01 and T03 come next,
 * with the calibration of the handling time of the Node clients. The WS cells follow, then the
 * WST cells: the same client through a router or a proxy. The cells of the writes of S3 on a replica
 * set come next, then the MongoDB cells of T01, T03 and T11. The PostgreSQL cells of T01, T03 and
 * T10 follow, then the cells of a COMMIT with no reply. The RabbitMQ cells of T01 and T11 come next,
 * then the gRPC cells of T01, T03 and T02. The cells of the keyed limiter (O29 and O30), of the
 * accept queue and of the routed fabric come next, then the retry count of T14 (O08). The recovery
 * drills are last.
 */
export const catalogs = (given: Partial<Subjects> = {}): readonly Cell[] => {
  const subjects: Subjects = { procedures: PROCEDURES, ...given };
  return [
    ...CELLS,
    ...T03_CELLS,
    ...T02_CELLS,
    ...TOX_CELLS,
    ...CAL_CELLS,
    ...T12_CELLS,
    T12_CAL,
    ...WRITES_CELLS,
    ...RESEND_CELLS,
    ...ACKS_CELLS,
    ...HTTP_HARNESS_CELLS,
    ...HTTP_CAL_CELLS,
    ...wsCells(subjects.procedures),
    ...wstCells(subjects.procedures),
    ...T11_WRITES_CELLS,
    ...MONGO_CELLS,
    ...T01_PG,
    ...T01_HIKARI,
    ...T03_HIKARI,
    ...T10_HIKARI,
    ...T10_PG,
    ...COMMIT_CELLS,
    ...T01_AMQP,
    ...T11_RABBIT,
    ...T01_GRPC,
    ...T03_GRPC,
    ...T02_GRPC,
    ...LIMITER_CELLS,
    ...ACCEPT_QUEUE_CELLS,
    ...FABRIC_CELLS,
    ...COUNT_CELLS,
    ...WATCH_CELLS,
    ...LEASE_CELLS,
    ...RECOVERY_CELLS,
  ];
};

/** These are the cells of each catalog, on the subjects that the harness ships. */
export const ALL: readonly Cell[] = catalogs();

/**
 * These are the selections of the scheduled runs of the workflow Cells, by name. The read of the
 * records takes a name and not a regular expression. The name `night` selects the nightly run. The
 * name `drills` selects the Sunday run.
 */
export const SCHEDULED_CELLS: Readonly<Record<string, RegExp>> = { night: /^WS/, drills: /^RD[.]/ };

/**
 * This function gives the cells of one shard: the cells whose names match `only`, then each `of`-th
 * cell from the `shard`-th. The runner and the read of its records use this one selection.
 */
export const selectedOf = (source: readonly Cell[], only: RegExp, shard: number, of: number): readonly Cell[] =>
  source.filter((each) => only.test(each.name)).filter((_, at) => at % of === shard);
