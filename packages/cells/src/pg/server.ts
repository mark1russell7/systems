import { timerOf, transitionOn } from "@mark1russell7/algebra";
import type { Target } from "@mark1russell7/harness";
import { POSTGRES_SESSION } from "@mark1russell7/machines";
import type { Extent } from "@mark1russell7/quantity";
import { given, seconds } from "../catalog.ts";
import type { Span } from "../mongo/model.ts";
import { span } from "../mongo/model.ts";

/**
 * The server side of the PostgreSQL cells: the settings of a backend that a cell changes, as the
 * document `postgres-session` names them. A setting goes to the command line of the server
 * (`postgres -c name=value`), thus each session of the server has it, and no client sets it.
 */

/** This value is the statement deadline of the server that the borders of O07 bind: 10 s. */
export const STATEMENT_DEADLINE = 10;

/** This text is the query in flight of the O07 cells: it sleeps longer than each timer of the cell. */
export const SLOW_QUERY = `SELECT pg_sleep(${2 * STATEMENT_DEADLINE})`;

/** This function gives the values of the knobs of the PostgreSQL session: the defaults, with the settings of the cell in their units. */
export const serverValues = (settings: Readonly<Record<string, number>> = {}): Record<string, Extent> => {
  const out: Record<string, Extent> = {};
  for (const [name, knob] of Object.entries(POSTGRES_SESSION.knobs)) {
    if (knob.unit === null) continue;
    const value = settings[name] ?? knob.default;
    if (value === null) continue;
    out[name] = { value: knob.off !== undefined && value === knob.off ? "infinite" : value, unit: knob.unit };
  }
  const unknown = Object.keys(settings).filter((name) => POSTGRES_SESSION.knobs[name]?.unit == null);
  if (unknown.length > 0) throw new Error(`postgres-session has no knob with a unit for ${unknown.join(", ")}`);
  return out;
};

/**
 * This function gives a target of PostgreSQL with the settings of a cell. Each setting is a `-c`
 * of the server, in the unit of its knob. The entrypoint gives the arguments after `postgres` to
 * the server.
 */
export const pgTargetWith = (target: Target, settings: Readonly<Record<string, number>>): Target => {
  const flags = Object.entries(serverValues(settings))
    .filter(([name]) => settings[name] !== undefined)
    .map(([name, value]) => `-c ${name}=${value.value}`)
    .join(" ");
  return { ...target, command: target.command!.map((part) => part.replace("docker-entrypoint.sh postgres &", `docker-entrypoint.sh postgres ${flags} &`)) };
};

/** A deadline is the statement timer of the server as the client sees it: its band from the send of the query, and its SQLState. */
export interface Deadline {
  readonly band: Span;
  readonly errno: string;
}

/**
 * This function gives the statement deadline of the server, as the client sees it. The server arms
 * statement_timeout at the arrival of the query, and at its end it sends the ERROR 57014. The band
 * counts from the send of the query. Thus it adds one round trip (0 to `rttMs`) to the band of the
 * timer, and the steps of the client that read the error (`clientSlack`, in seconds).
 */
export const statementDeadline = (settings: Readonly<Record<string, number>>, rttMs: number, clientSlack: number): Deadline | null => {
  const values = given(serverValues(settings));
  const timer = timerOf(POSTGRES_SESSION, "statement_timeout", values);
  if ("unknown" in timer.duration || timer.duration.value === "infinite") return null;
  const duration = seconds(timer.duration, "statement_timeout");
  const errno = transitionOn(POSTGRES_SESSION, "RUNNING", "timer.statement")?.errno;
  if (errno === undefined) throw new Error("postgres-session has no transition on timer.statement from RUNNING");
  return { band: span(duration, duration + seconds(timer.lateness, "its lateness") + rttMs / 1000 + clientSlack), errno };
};
