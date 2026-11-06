import type { Cell, GroupPrediction } from "@mark1russell7/harness";
import { IOREDIS_SENTINEL } from "@mark1russell7/machines";
import type { Quantity } from "@mark1russell7/quantity";
import { q, seconds } from "./catalog.ts";
import type { Span } from "./t12.ts";
import { GROUP_RTT_MS, HOLD, MEASURED_WINDOW, SENTINEL_DEFAULTS, failoverOf, ioredisValues, spanOf, t12Cell } from "./t12.ts";
import { cycleOf, rounded } from "./writes.ts";

/**
 * This module holds the cells of SYS-62. The group and the records are the ones of T12, and each
 * write is `RPUSH w <n>`, thus the list keeps each copy. The question: does the resend of ioredis
 * 6.0.0 at a reconnect duplicate a write?
 *
 * Each term comes from the source of ioredis at the tag v6.0.0, in lib/:
 * - `sendCommand` writes a command to the socket, then pushes it on `commandQueue` (Redis.ts:630-637).
 *   A command that it cannot write goes on `offlineQueue` (Redis.ts:596), and that command was not sent.
 * - A close from status `ready` keeps `commandQueue` as `prevCommandQueue` (redis/event_handler.ts:375-382).
 * - At the next `ready`, `autoResendUnfulfilledCommands` sends each one again (redis/event_handler.ts:501-513).
 *   Its default is true (redis/RedisOptions.ts:329).
 * - With that option off, `prevCommandQueue` becomes null and no promise settles (redis/event_handler.ts:515).
 *
 * A resend adds a copy only if the first copy was applied and it survives. A black hole gives no
 * close until the conversion, and a reset ends the data of the first copy. Thus the close must
 * come from a timer of the client, while the server holds the first copy unread:
 * - `socketTimeout` has no default (redis/RedisOptions.ts:50). Its timer starts at the first command
 *   with no timer (Redis.ts:647-652), and each reply moves it (Redis.ts:736-741).
 * - The timer destroys the socket with an error (Redis.ts:725-732).
 * - The option says that the client rejects the running commands (redis/RedisOptions.ts:47). The close
 *   path has no such step: it keeps them for the resend.
 *
 * A frozen server leaves its kernel running, thus the kernel accepts each write and each new
 * connection. The commands of each later connect are in the status `connect`, thus they do not
 * replace `prevCommandQueue`. At the thaw, a read gives the queued bytes before it gives the end of
 * the stream. Valkey 9.1.2 runs those bytes before a read of 0 bytes frees the client
 * (src/networking.c:3171-3186, :4362, :4396).
 *
 * The law: the extra copies are W × c, with W commands in flight at each of c closes from `ready`,
 * if the first copies survive. A freeze inside down-after-milliseconds has one close from `ready`
 * and the first copies survive. A freeze that outlasts the failover has its first copies on the old
 * primary, and its conversion drops them, thus no copy stays.
 *
 * A stream of SET has no cell. The harness reads its keys as a set, thus each count of copies is 0
 * by construction, and a cell of that count tests nothing.
 */

/** This time is the hold of `T12.border-off.1`: a freeze that ends before the first `+sdown`. */
const INSIDE = 29;
/** This time is the chosen `socketTimeout`, in seconds: it is above each reply and below each hold. It has no source. */
export const SOCKET_TIMEOUT = 1;
/** This count is the chosen count of writers, which is W of the law. It has no source. */
export const WRITERS = 4;
/** This time is the chosen `commandTimeout`, in seconds. It has no source, and `resendCell` tests its lower bound. */
export const COMMAND_TIMEOUT = 40;
/** This count is the runs of a cell of SYS-62: the decision rule of the prediction reads 4. */
const RESEND_RUNS = 4;

/** This function gives the band of the extra copies of the law: one count, as each term is a count. */
export const copiesOf = (writers: number, closes: number, survives: boolean): { readonly low: number; readonly high: number } => {
  const count = survives ? writers * closes : 0;
  return { low: count, high: count };
};

/**
 * This function gives the first close from the fault, in seconds. The timer started up to one cycle
 * before the fault, at the last reply. It can also start up to one cycle after the fault, at the
 * first write into the freeze. The timer can come one step of the event loop late.
 */
export const firstCloseOf = (timeout = SOCKET_TIMEOUT): Span => {
  const cycle = cycleOf();
  const slack = seconds(ioredisValues(GROUP_RTT_MS)("slack") as Quantity, "slack");
  return { lo: rounded(timeout - cycle.hi), hi: rounded(timeout + cycle.hi + slack) };
};

/**
 * This function gives the most closes up to a hold. Each connect ends at its socket timer, after
 * the low edge of the wait of `retryStrategy` (redis/RedisOptions.ts:291-296, redis/event_handler.ts:394).
 * The 21st close flushes the queues (redis/event_handler.ts:411-424), and a count below it keeps the
 * resend alive.
 */
export const closesBy = (hold: number, timeout = SOCKET_TIMEOUT): number => {
  const values = ioredisValues(GROUP_RTT_MS);
  let closes = 0;
  for (let at = firstCloseOf(timeout).lo; at <= hold; closes += 1) at += spanOf(IOREDIS_SENTINEL, "retry_delay", values, closes).lo + timeout;
  return closes;
};

/** This function gives the latest `ready` after a thaw, in seconds: the connect that the thaw meets, the longest wait, and a connect. */
export const latestReadyOf = (hold: number, timeout = SOCKET_TIMEOUT): number => {
  const values = ioredisValues(GROUP_RTT_MS);
  const wait = spanOf(IOREDIS_SENTINEL, "retry_delay", values, 64);
  return rounded(hold + timeout + wait.hi + spanOf(IOREDIS_SENTINEL, "success", values).hi);
};

/** A resend spec is one cell of SYS-62, before its prediction. */
export interface ResendSpec {
  /** This identifier is the name of the cell, for example `T12.resend.1`. */
  readonly plan: string;
  /** This text is the rest of the name. */
  readonly name: string;
  /** This time is how long the freeze holds, in seconds. */
  readonly hold: number;
  /** This count is the writers of the client, which is W of the law. */
  readonly writers: number;
  /** These are the ioredis options over its defaults. */
  readonly options: Readonly<Record<string, unknown>>;
  /** This band is the law of the extra copies in each run. */
  readonly copies: { readonly low: number; readonly high: number };
  /** This text is why the first write has no band, or null when the cell keeps the band of T12. */
  readonly why: string | null;
}

const socketTimer = { socketTimeout: SOCKET_TIMEOUT * 1000 };
const LADDER = "it waits for the ladder of connects, which the socket timer closes";
const SAME = `the first write after the thaw has no band: ${LADDER}. The band of extra copies judges the cell`;

/** These are the specs of SYS-62: the law at two values of W, its failover term, and its two controls. */
export const RESEND_SPECS: readonly ResendSpec[] = [
  {
    plan: "T12.resend.1",
    name: `freeze-process at the primary, ${INSIDE} s, socketTimeout ${SOCKET_TIMEOUT} s, RPUSH, one writer`,
    hold: INSIDE,
    writers: 1,
    options: socketTimer,
    copies: copiesOf(1, 1, true),
    why: SAME,
  },
  {
    plan: "T12.resend.2",
    name: `freeze-process at the primary, ${INSIDE} s, socketTimeout ${SOCKET_TIMEOUT} s, RPUSH, ${WRITERS} writers`,
    hold: INSIDE,
    writers: WRITERS,
    options: socketTimer,
    copies: copiesOf(WRITERS, 1, true),
    why: SAME,
  },
  {
    plan: "T12.resend.3",
    name: `freeze-process at the primary, ${HOLD} s, socketTimeout ${SOCKET_TIMEOUT} s, RPUSH, ${WRITERS} writers`,
    hold: HOLD,
    writers: WRITERS,
    options: socketTimer,
    copies: copiesOf(WRITERS, 1, false),
    why: `the first write on the new primary has no band: ${LADDER}, from a time that the failover sets. The band of extra copies judges the cell`,
  },
  {
    plan: "T12.resend.4",
    name: `freeze-process at the primary, ${INSIDE} s, no socketTimeout, RPUSH, ${WRITERS} writers`,
    hold: INSIDE,
    writers: WRITERS,
    options: {},
    copies: copiesOf(WRITERS, 0, true),
    why: null,
  },
  {
    plan: "T12.resend.5",
    name: `freeze-process at the primary, ${INSIDE} s, socketTimeout ${SOCKET_TIMEOUT} s, autoResendUnfulfilledCommands false, commandTimeout ${COMMAND_TIMEOUT} s, RPUSH, ${WRITERS} writers`,
    hold: INSIDE,
    writers: WRITERS,
    options: { ...socketTimer, autoResendUnfulfilledCommands: false, commandTimeout: COMMAND_TIMEOUT * 1000 },
    copies: copiesOf(WRITERS, 1, false),
    why: `the first write after the thaw has no band: no resend comes, thus each writer waits for commandTimeout, ${COMMAND_TIMEOUT} s. The band of extra copies judges the cell`,
  },
];

/** This function gives the cell of a spec. It throws if a term of the law does not hold for the spec. */
export const resendCell = (spec: ResendSpec): Cell => {
  const cell = t12Cell({ plan: spec.plan, name: spec.name, fault: "freeze-process", at: { role: "primary" }, hold: spec.hold });
  const { prediction, probe } = cell;
  const { driver } = probe;
  if (driver?.name !== "ioredis") throw new Error(`${spec.plan}: a T12 cell has an ioredis client`);
  const closes = spec.options["socketTimeout"] !== undefined;
  if (prediction.group!.failover && closes) {
    // a connect to the old primary before the advertisement must end before the thaw, or its resend lands there
    const advertised = failoverOf("silence", SENTINEL_DEFAULTS, GROUP_RTT_MS).advertised;
    if (advertised.hi + SOCKET_TIMEOUT >= spec.hold) throw new Error(`${spec.plan}: a connect to the old primary can outlast the freeze`);
  }
  const timeout = spec.options["commandTimeout"];
  // a command that times out stays in its queue (Command.ts:418-426): the queue must go first
  if (typeof timeout === "number" && latestReadyOf(spec.hold) >= timeout / 1000 - cycleOf().hi)
    throw new Error(`${spec.plan}: commandTimeout can come before the ready that drops the queue`);
  const first = firstCloseOf();
  const group: GroupPrediction = {
    ...prediction.group!,
    duplicates: spec.copies,
    ...(closes ? { errors: [{ name: "Error", low: q(first.lo), high: q(first.hi) }] } : {}),
  };
  return {
    ...cell,
    probe: { ...probe, driver: { ...driver, op: "rpush", window: spec.writers } },
    ...(Object.keys(spec.options).length === 0 ? {} : { driverOptions: spec.options }),
    runs: RESEND_RUNS,
    prediction: spec.why === null ? { ...prediction, group } : { detects: null, window: q(MEASURED_WINDOW), why: spec.why, from: "fault", group },
  };
};

/** These are the cells of SYS-62. */
export const RESEND_CELLS: readonly Cell[] = RESEND_SPECS.map(resendCell);
