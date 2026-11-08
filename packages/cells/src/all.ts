import type { Cell, Subject } from "@mark1russell7/harness";
import { ACCEPT_QUEUE_CELLS, SERVICE_QUEUE_CELLS } from "./accept-queue.ts";
import { CAL_CELLS } from "./calibration.ts";
import { CELLS } from "./catalog.ts";
import { CONNTRACK_CELLS } from "./conntrack.ts";
import { T01_GRPC } from "./grpc/t01.ts";
import { T02_GRPC } from "./grpc/t02.ts";
import { T03_GRPC } from "./grpc/t03.ts";
import { HTTP_CAL_CELLS, HTTP_HARNESS_CELLS } from "./http/cells.ts";
import { ACKS_CELLS } from "./kafka/acks.ts";
import { PAUSE_CELLS } from "./kafka/pause.ts";
import { FABRIC_CELLS } from "./fabric.ts";
import { LIMITER_CELLS } from "./limiter.ts";
import { MONGO_CELLS } from "./mongo/harness.ts";
import { T11_WRITES_CELLS } from "./mongo/writes.ts";
import { T01_HIKARI } from "./pg/hikari.ts";
import { POOL_CELLS } from "./pg/pool.ts";
import { T01_PG } from "./pg/t01.ts";
import { T03_HIKARI } from "./pg/t03.ts";
import { COMMIT_CELLS } from "./pg/commit.ts";
import { T10_HIKARI, T10_PG } from "./pg/t10.ts";
import { CONFIRM_CELLS } from "./rabbit/confirms.ts";
import { T01_AMQP } from "./rabbit/t01.ts";
import { T11_RABBIT } from "./rabbit/t11.ts";
import { LADDER_CELLS } from "./ladder.ts";
import { OPEN_LOOP_CELLS } from "./open-loop.ts";
import { RESEND_CELLS } from "./resend.ts";
import { RECOVERY_CELLS, RECOVERY_SIZE_CELLS } from "./recovery.ts";
import { REFRESH_CELLS } from "./refresh.ts";
import { T02_CELLS } from "./t02.ts";
import { T03_CELLS } from "./t03.ts";
import { PORT_RANGE_CELLS } from "./port-range.ts";
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
 * T10 follow, then the cells of a COMMIT with no reply. The RabbitMQ cells of T01 and T11 and of
 * the confirms come next, then the gRPC cells of T01, T03 and T02. The cells of the keyed limiter
 * (O29 and O30) and of a pool at its limit come next. The cells of the accept queue, of the port
 * range, of conntrack and of the routed fabric are after them. The retry count of T14 (O08) follows. The recovery
 * drills follow, and the open-loop cells are last.
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
    ...PAUSE_CELLS,
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
    ...CONFIRM_CELLS,
    ...T01_GRPC,
    ...T03_GRPC,
    ...T02_GRPC,
    ...LIMITER_CELLS,
    ...POOL_CELLS,
    ...ACCEPT_QUEUE_CELLS,
    ...SERVICE_QUEUE_CELLS,
    ...PORT_RANGE_CELLS,
    ...CONNTRACK_CELLS,
    ...FABRIC_CELLS,
    ...COUNT_CELLS,
    ...WATCH_CELLS,
    ...LEASE_CELLS,
    ...RECOVERY_CELLS,
    ...RECOVERY_SIZE_CELLS,
    ...OPEN_LOOP_CELLS,
    ...LADDER_CELLS,
  ];
};

/** These are the cells of each catalog, on the subjects that the harness ships. */
export const ALL: readonly Cell[] = catalogs();

/**
 * These are the selections of the scheduled runs of the workflow Cells, by name. The read of the
 * records takes a name and not a regular expression. The name `night` selects the nightly run. The
 * name `drills` selects the Sunday run. The names `refresh-0` to `refresh-3` select the rounds of the
 * refresh of the studies, each Wednesday (refresh.ts).
 *
 * The Sunday run does not hold the drill of 8 GB (SYS-97) yet. First, a run of `^RD[.]` on one
 * shard measures the time of the job with it. The job has a limit of 340 minutes.
 */
export const SCHEDULED_CELLS: Readonly<Record<string, RegExp>> = { night: /^WS/, drills: /^RD[.](?!8000[.])/, ...REFRESH_CELLS };

/**
 * This function gives the selection of a run: a scheduled selection by its name, or the regular
 * expression `only`. A selection names its cells, thus it takes no `only`.
 */
export const selectionOf = (selection: string | undefined, only: string | undefined): RegExp => {
  if (selection === undefined) return new RegExp(only ?? ".");
  const scheduled = SCHEDULED_CELLS[selection];
  if (scheduled === undefined) throw new Error(`no scheduled selection has the name ${selection}: ${Object.keys(SCHEDULED_CELLS).join(", ")}`);
  if ((only ?? ".") !== ".") throw new Error("CELLS_SELECTION takes no CELLS_ONLY: the selection names its cells");
  return scheduled;
};

/** This function tells if a cell needs containerlab: a cell of a fabric, on layer E3, needs its routers. */
export const needsContainerlab = (cell: Cell): boolean => cell.topology?.fabric !== undefined;

/**
 * This function gives the cells of one shard: the cells whose names match `only`, then each `of`-th
 * cell from the `shard`-th. The runner and the read of its records use this one selection.
 */
export const selectedOf = (source: readonly Cell[], only: RegExp, shard: number, of: number): readonly Cell[] =>
  source.filter((each) => only.test(each.name)).filter((_, at) => at % of === shard);
