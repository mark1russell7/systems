import type { Extent, Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { realClock } from "../clock.ts";
import type { Attempt, CheckOptions, Client, ClientJoin, ClientKnobs, ClientOptions, ClientSpec, ClientStep, DialFn, SendOptions, Sent } from "../client/core.ts";
import {
  attachClient,
  clientBounds,
  clientProblems,
  clientRecorder,
  dialCheck,
  finiteMs,
  inFlight,
  localStateCheck,
  message,
  ms,
  notSent,
  operationTable,
  roundTripCheck,
  sendWithReissue,
  socketEnds,
  stepChecks,
  timeProblems,
  withinBound,
} from "../client/core.ts";
import { helloDial } from "../client/dial.ts";
import type { Dependency } from "../description.ts";
import type { DependencyHandle } from "../lifecycle.ts";
import type { Operation } from "../operation.ts";
import type { PgPool, PgPoolClient, PgPoolOptions, PgResult, PoolFactory } from "./connection.ts";
import { nodePostgres } from "./connection.ts";
import { pgMeetings } from "./meets.ts";

/**
 * These are the knobs of the client, each a time, by the names of the ordering law where the law
 * has them. The runtime has no defaults, thus each knob is necessary. A bound that nobody gives is
 * "infinite", not zero. `PG_STARTING_KNOBS` gives a declaration from the cells of S1. The knobs
 * that each client has come from the core.
 */
export interface PgKnobs extends ClientKnobs {
  /**
   * This time bounds a new connection (`connectionTimeoutMillis`): the TCP connect, the startup and
   * the authentication. The pool uses the same knob to bound a checkout from a full pool.
   * At the defaults pg has no bound, and the kernel gives up on the SYNs only after 131 s (A3, O15).
   */
  readonly connect_bound: Quantity;
  /** This time bounds each query on the client (`query_timeout`). pg sends no cancel at its end. */
  readonly request_timeout: Quantity;
  /**
   * This time is the deadline of each statement on the server (`statement_timeout`). The server then
   * ends the statement with ERROR 57014, a certain outcome. "infinite" sends no deadline.
   */
  readonly statement_timeout: Extent;
  /** This time ends an idle client of the pool (`idleTimeoutMillis`). The pool sends no test on an idle client. */
  readonly pool_idle_expiry: Extent;
  /** This time is the idle time of TCP keepalive, in whole seconds. Node then sends 10 probes 1 s apart. */
  readonly keepalive_idle: Extent;
  /** This time is the age at which the pool replaces a client (`maxLifetimeSeconds`), in whole seconds. */
  readonly max_connection_age: Extent;
  /** This time bounds the close of the pool at the shutdown: its end, then a destroy of each socket that stays. */
  readonly close_bound: Quantity;
}

/** A pg client spec is the declaration of one PostgreSQL client: where it connects, its pool, and its knobs. */
export interface PgClientSpec extends ClientSpec<PgKnobs> {
  readonly database?: string | undefined;
  readonly user?: string | undefined;
  /** These counts are the sizes of the pool: at most `max` clients, and an idle timer only above `min`. */
  readonly pool: { readonly max: number; readonly min: number };
  /**
   * These operations are the queries of the service, by name, with their idempotency. SQL text does
   * not tell if a statement changes a state, thus the client sends again only a query that this table names.
   */
  readonly operations?: Readonly<Record<string, Operation>> | undefined;
}

/** These options make a client. Without them, it uses pg, the real clock, and a dial with an SSLRequest. */
export type PgClientOptions = ClientOptions<PoolFactory>;

/**
 * A join is one connection of the pool, at its connect (D1, D2). The prober joins its kernel records
 * to the server's view of the connection through it. The server's view is the process id of the backend.
 */
export interface PgJoin extends ClientJoin {
  /** This number is the process id of the backend, or null when the server gave none. Through a pooler, it is the id that the pooler gives. */
  readonly backendPid: number | null;
}

/** The steps that the pg client gives a check for: the steps of each client, and a checkout from the pool (B14). */
export type PgStep = ClientStep | "checkout";

/** A pg client is a dependency of a service: its declaration, its handle, its checks and its queries. */
export interface PgClient extends Client<PgStep, PgJoin> {
  /** This text is the state of the client, as `PG_CLIENT_MACHINE` names it. */
  readonly status: string;
  /**
   * This method sends a query, and gives its outcome in three values. `operation` names the query
   * in the table of operations. The client sends again only an idempotent operation, one time at
   * most, after an outcome that is not certain. The second try stays in the bound of the request.
   */
  query<Row = Record<string, unknown>>(
    operation: string,
    text: string,
    values?: readonly unknown[],
    options?: SendOptions,
  ): Promise<Sent<PgResult<Row>>>;
}

const wholeMs = (amount: Extent): boolean => amount.value === "infinite" || Number.isInteger(ms(amount));
const wholeSeconds = (amount: Extent): boolean =>
  amount.value === "infinite" || Number.isInteger(valueIn(amount as Quantity, "s"));
/** This function writes a bound for pg: "infinite" is 0, which pg reads as no timer. */
const orZero = (amount: Extent): number => finiteMs(amount) ?? 0;

/** This function gives the problems of a spec: the knobs that pg cannot use. */
export const specProblems = (name: string, spec: PgClientSpec): string[] => {
  const { knobs, pool } = spec;
  const problems = timeProblems(name, knobs);
  // pg reads 0 as no timer, thus a bound of 0 is not a bound
  for (const knob of ["connect_bound", "request_timeout", "close_bound"] as const) {
    if (!(ms(knobs[knob]) > 0) || !Number.isFinite(ms(knobs[knob])))
      problems.push(`${name}'s ${knob} is not a finite time above zero: pg reads 0 as no bound`);
  }
  for (const knob of ["statement_timeout", "pool_idle_expiry", "keepalive_idle", "max_connection_age"] as const) {
    if (knobs[knob].value !== "infinite" && !(ms(knobs[knob]) > 0))
      problems.push(`${name}'s ${knob} is zero: give "infinite" for no bound`);
  }
  for (const knob of ["connect_bound", "request_timeout", "statement_timeout", "pool_idle_expiry"] as const) {
    if (!wholeMs(knobs[knob])) problems.push(`${name}'s ${knob} is not a whole number of milliseconds`);
  }
  // Node truncates the keepalive delay to whole seconds, and pg takes the age in whole seconds
  if (!wholeSeconds(knobs.keepalive_idle)) problems.push(`${name}'s keepalive_idle is not a whole number of seconds`);
  if (!wholeSeconds(knobs.max_connection_age)) problems.push(`${name}'s max_connection_age is not a whole number of seconds`);
  if (!Number.isInteger(pool.max) || pool.max < 1) problems.push(`${name}'s pool has a max of ${pool.max}, not a whole number above zero`);
  if (!Number.isInteger(pool.min) || pool.min < 0 || pool.min > pool.max)
    problems.push(`${name}'s pool has a min of ${pool.min}, not a whole number from 0 to its max`);
  return problems;
};

/** This function gives the options of `pg.Pool` from a spec. Each timer of pg comes from the declaration. */
export const poolOptions = (name: string, spec: PgClientSpec): PgPoolOptions => {
  const { knobs } = spec;
  return {
    host: spec.host,
    port: spec.port,
    ...(spec.database === undefined ? {} : { database: spec.database }),
    ...(spec.user === undefined ? {} : { user: spec.user }),
    ...(spec.password === undefined ? {} : { password: spec.password }),
    application_name: name,
    max: spec.pool.max,
    min: spec.pool.min,
    connectionTimeoutMillis: ms(knobs.connect_bound),
    query_timeout: ms(knobs.request_timeout),
    statement_timeout: finiteMs(knobs.statement_timeout),
    idleTimeoutMillis: orZero(knobs.pool_idle_expiry),
    maxLifetimeSeconds: orZero(knobs.max_connection_age) / 1000,
    keepAlive: knobs.keepalive_idle.value !== "infinite",
    keepAliveInitialDelayMillis: orZero(knobs.keepalive_idle),
    allowExitOnIdle: true,
  };
};

/** The bytes of an SSLRequest: a length of 8, then the code 80877103. A server answers with one byte, S or N. */
const SSL_REQUEST = Uint8Array.of(0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f);

/**
 * This dial function opens a TCP connection, sends an SSLRequest, and waits for its one byte. The
 * server answers it before the authentication, thus the dial needs no password and opens no backend.
 */
export const sslRequestDial: DialFn = helloDial(SSL_REQUEST, (received) => {
  const answer = String.fromCharCode(received[0] ?? 0);
  return answer === "S" || answer === "N" ? null : new Error(`the answer to the SSLRequest was ${JSON.stringify(answer)}`);
});

/** A database error is an ErrorResponse of the server: pg gives its severity and its SQLSTATE code. */
const replyOf = (error: unknown): { readonly severity: string; readonly code: string } | null => {
  if (typeof error !== "object" || error === null) return null;
  const { severity, code } = error as { severity?: unknown; code?: unknown };
  return typeof severity === "string" && typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? { severity, code } : null;
};

/**
 * This function makes a PostgreSQL client, a dependency of a service over a `pg.Pool`.
 * - It sets each timer of pg from the declaration. The driver sends nothing again by itself, and the client
 *   sends again only an idempotent operation of its table.
 * - It tells the outcome of a query in three values. An ERROR of the server is certain. A FATAL
 *   ends the session, thus its outcome is not certain.
 * - It gives back a client whose query has no certain outcome with an error. The pool then ends it,
 *   thus an orphaned query does not hold the next checkout.
 * - It listens to each error of the pool and of a client that it holds. In Node, an error with no
 *   listener throws, and library code does not end the process (A5).
 * - It records the process id of the backend of each connection (D1).
 *
 * The outcomes, the second try, the queries in flight, the bounded close and the checks come from
 * the core of the clients. This entry gives what pg does in its own way.
 */
export const pgClient = (name: string, spec: PgClientSpec, options: PgClientOptions = {}): PgClient => {
  const problems = specProblems(name, spec);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { knobs } = spec;
  const clock = options.clock ?? realClock;
  const create = options.create ?? nodePostgres;
  const dial = options.dial ?? sslRequestDial;
  const operations = operationTable({}, spec.operations);
  const requestTimeout = ms(knobs.request_timeout);

  let pool: PgPool | null = null;
  let status = "none";
  const joins: PgJoin[] = [];
  // the clients of the pool whose socket did not close yet: the bound of the close destroys them
  const open = new Set<PgPoolClient>();
  // the queries in flight: the end of the close settles each one
  const flight = inFlight();

  const emit = clientRecorder(options.record, clock, name);
  // the state of the pg client is the outcome of its last connect: each record can move it
  const record = (on: string, to: string = status, detail?: string): void => {
    const from = status;
    status = to;
    emit(from, to, on, detail);
  };
  const closing = (): boolean => status === "closing" || status === "end";

  const onConnect = (client: PgPoolClient): void => {
    open.add(client);
    const generation = joins.length + 1;
    const pid = client.processID;
    joins.push({ generation, at: clock.now(), backendPid: typeof pid === "number" ? pid : null, ...socketEnds(client.connection?.stream) });
    record("join", closing() ? status : "ready", `generation ${generation}, backend ${pid ?? "unknown"}`);
  };
  const onRemove = (client: PgPoolClient): void => {
    open.delete(client);
    record("client.removed");
  };
  // an idle client failed. The pool removed it, and the next checkout opens a new connection
  // after the end, the listener only keeps the error from a throw
  const onPoolError = (error: Error): void => {
    if (status !== "end") record("client.error", status, message(error));
  };

  /** This function records a failed checkout: a full pool at its bound, or a connect that failed. */
  const checkoutFailed = (error: unknown): void => {
    const text = message(error);
    if (/timeout exceeded when trying to connect/i.test(text)) record("checkout.timeout", status, text);
    else record("connect.failed", closing() ? status : "failing", text);
  };

  /** This function checks out a client, or gives the reason why the query cannot leave the client. */
  const checkout = (signal: AbortSignal | undefined): Promise<PgPoolClient | Attempt> => {
    const p = pool;
    if (p === null) return Promise.resolve(notSent(`${name} has not connected`));
    if (closing()) return Promise.resolve(notSent(`${name} is ${status}: the query did not leave the client`));
    if (signal?.aborted) return Promise.resolve(notSent("the caller aborted the query before it left the client"));
    return new Promise((resolve) => {
      let done = false;
      const aborted = (): void => {
        done = true;
        resolve(notSent("the caller abandoned the query before it left the client"));
      };
      signal?.addEventListener("abort", aborted, { once: true });
      p.connect().then(
        (client) => {
          signal?.removeEventListener("abort", aborted);
          // the caller left while the pool connected: the client goes back unused
          if (done) client.release();
          else resolve(client);
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", aborted);
          checkoutFailed(error);
          if (!done) resolve(notSent(message(error)));
        },
      );
    });
  };

  /** This function makes one try of a query: a checkout, the query, and the release. */
  const attempt = async (text: string, values: readonly unknown[] | undefined, signal: AbortSignal | undefined): Promise<Attempt> => {
    const got = await checkout(signal);
    if (!("release" in got)) return got;
    const client = got;
    // a client that the application holds emits its own errors, and the pool does not listen to them
    const onClientError = (error: Error): void => record("client.error", status, message(error));
    client.on("error", onClientError);
    return flight.track(
      signal,
      "the caller abandoned the query after it was sent",
      (settle) => {
        client.query(text, values).then(
          (result) => settle({ outcome: "ok", value: { rows: result.rows, rowCount: result.rowCount } }),
          (error: unknown) => {
            const reply = replyOf(error);
            const said = reply === null ? message(error) : `${reply.code} ${message(error)}`;
            // an ERROR ends the statement and keeps the session. A FATAL or a PANIC ends the session, and the commit is not certain
            if (reply !== null && reply.severity === "ERROR") settle({ outcome: "error", error: said, reply: true });
            else settle({ outcome: "indeterminate", error: said }, error instanceof Error ? error : new Error(said));
          },
        );
      },
      (_value, cause) => {
        client.off("error", onClientError);
        // pg keeps a query active on the server after its timeout: an error makes the pool end the client, and the end destroys the socket
        client.release(cause);
      },
    );
  };

  const query = <Row>(operation: string, text: string, values?: readonly unknown[], sendOptions: SendOptions = {}): Promise<Sent<PgResult<Row>>> =>
    sendWithReissue({
      clock,
      bound: requestTimeout,
      operation: operations[operation],
      options: sendOptions,
      attempt: (signal) => attempt(text, values, signal) as Promise<Attempt<PgResult<Row>>>,
      onReissue: () => record("command.reissue", status, operation),
    });

  const handle: DependencyHandle = {
    async connect(signal) {
      record("status.connecting", "connecting");
      const p = await create(poolOptions(name, spec));
      pool = p;
      p.on("connect", onConnect);
      p.on("remove", onRemove);
      p.on("error", onPoolError);
      if (signal.aborted) throw new Error(`${name}: the service stopped before the connect`);
      // one checkout opens the first connection. A server that is down does not stop the startup:
      // the checks keep readiness tripped until a connect succeeds (readiness is earned)
      const first = await checkout(signal);
      if ("release" in first) first.release();
    },
    async close() {
      const p = pool;
      if (p === null || closing()) return;
      record("close.request", "closing");
      if (!(await withinBound(clock, ms(knobs.close_bound), p.end()))) {
        // the end of a client sends Terminate and half-closes the socket. Behind a black hole the
        // socket never closes, and the pool waits with no bound: the bound destroys each socket
        record("close.bound");
        for (const client of [...open]) client.connection?.stream?.destroy?.();
        record("close.destroy", status, `${open.size} sockets`);
      }
      flight.settleAll("the client closed with the query in flight");
      p.off("connect", onConnect);
      p.off("remove", onRemove);
      // the error listener stays: a socket that closes later emits an error, and with no listener it throws
      record("status.end", "end");
    },
  };

  const declaration: Omit<Dependency, "name"> = {
    system: spec.system,
    knobs: {
      connect_bound: knobs.connect_bound,
      request_timeout: knobs.request_timeout,
      statement_timeout: knobs.statement_timeout,
      pool_idle_expiry: knobs.pool_idle_expiry,
      keepalive_idle: knobs.keepalive_idle,
      // pg sends nothing on an idle connection, thus its keepalive is the only refresh of an idle flow (O03)
      idle_refresh_interval: knobs.keepalive_idle,
      max_connection_age: knobs.max_connection_age,
      close_bound: knobs.close_bound,
      retrans_giveup_time: knobs.retrans_giveup_time,
    },
    operations,
  };

  const checks = (checkOptions: CheckOptions<PgStep>) =>
    stepChecks<PgStep>(name, checkOptions, {
      // the outcome of the last connect, without a round trip. pg does not connect again by itself,
      // thus pair it with a check that uses the pool
      "local-state": localStateCheck(() => status === "ready"),
      // a checkout and its release, with no query: it finds a full pool and a connect that fails,
      // but the pool sends no test on an idle client, thus not a dead idle connection
      checkout: {
        ownConnection: true,
        run: async (signal) => {
          const got = await checkout(signal);
          if (!("release" in got)) return "error";
          got.release();
          return "ok";
        },
      },
      // a SELECT 1 through the pool of the application
      "round-trip": roundTripCheck((sendOptions) => query("check", "SELECT 1", [], sendOptions)),
      // a new connection each time, with no backend
      dial: dialCheck(dial, spec.host, spec.port),
    });

  return {
    name,
    declaration,
    handle,
    meets: pgMeetings(name, knobs),
    get status() {
      return status;
    },
    joins,
    query,
    checks,
    attach: (svc, checkOptions) => attachClient(svc, name, declaration, handle, checks(checkOptions)),
    problems(description) {
      const found = clientProblems(name, description, clientBounds(knobs));
      // O07: the client waits longer than the deadline of the server. Then the server ends a slow
      // statement with a certain error. Otherwise the client gives up first, and the server goes on
      if (knobs.statement_timeout.value !== "infinite" && requestTimeout <= ms(knobs.statement_timeout))
        found.push(`${name}'s request_timeout is not above its statement_timeout: the server goes on with a statement that the client gave up (O07)`);
      return found;
    },
  };
};
