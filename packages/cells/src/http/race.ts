import type { KnobValues, Machine } from "@mark1russell7/algebra";
import { timerOf } from "@mark1russell7/algebra";
import type { Extent, Unknown } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { GO_TRANSPORT } from "./go-transport.ts";
import type { AgentSettings } from "./node-agent.ts";
import { NODE_HTTP_AGENT } from "./node-agent.ts";
import type { NodeServerSettings } from "./node-server.ts";
import { NODE_HTTP_SERVER, hintOf } from "./node-server.ts";
import { NODE_EARLY_SECONDS, goLateSeconds, nodeLateSeconds } from "./timers.ts";
import type { UndiciSettings } from "./undici.ts";
import { UNDICI_CLIENT } from "./undici.ts";

/**
 * This module is the arithmetic of the keep-alive race (DV-08). Two requests go on one
 * connection, with a gap g between the end of the first reply and the send of the second. The
 * server closes the idle connection at S after its response, and the pool of the client drops it
 * at C after the reply. All times are in seconds.
 *
 * The time starts when the server finishes its response. The reply reaches the client one way
 * later (d_sc), and the second request goes at d_sc + g. It reaches the server at RTT + g. The FIN
 * of the server leaves at S and reaches the client at S + d_sc. Thus each ordering is a comparison
 * of g with S and C, and the one-way delays cancel but for the round trip:
 * - `kept`: g + RTT < S and g < C. The request reaches the server before its close.
 * - `dropped`: C < g. The pool closed the connection first, and the request opens a new one.
 * - `fin-first`: S < g. The FIN came before the send, and the client opens a new connection.
 * - `crossed`: S - RTT < g < S. The request leaves before the FIN arrives, and it reaches a socket
 *   that the server closed. The kernel of the server answers with a reset (`net/ipv4/tcp_input.c:6713-6724`
 *   at Linux v6.6). The window is one round trip wide.
 */

/** An interval is a closed range of seconds. */
export interface Interval {
  readonly low: number;
  readonly high: number;
}

/** An ordering is where the gap falls against the close of the server and the expiry of the pool. */
export type Ordering = "kept" | "dropped" | "fin-first" | "crossed";

/** A decision is an ordering that the bounds decide, or the reason that they do not decide one. */
export type Decision = { readonly ordering: Ordering } | { readonly border: string };

/** A race is the bounds of each time of one race. */
export interface Race {
  /** This interval is the gap: from the end of the first reply at the client to the write of the second request. */
  readonly gap: Interval;
  /** This interval is the close of the server after its response finished, or null for a server that does not close. */
  readonly server: Interval | null;
  /** This interval is the expiry of the pool at its reuse decision, from the end of the reply, or null for no expiry. */
  readonly pool: Interval | null;
  readonly rtt: Interval;
  /**
   * This time is how long the client takes to act on a FIN that arrived: its read loop, or its
   * event loop. The documents do not bound it. The cells assume 1 ms.
   */
  readonly notice: number;
}

/**
 * This function decides the ordering of a race, from its bounds. An ordering that the bounds do
 * not decide is a border. The connection can be surely gone before the send. Then the first of
 * its two ends decides what its socket met: the FIN of the server, or the close of the pool.
 */
export const decide = (race: Race): Decision => {
  const { gap, server, pool, rtt, notice } = race;
  const poolGone = pool !== null && gap.low > pool.high;
  const finThere = server !== null && gap.low > server.high + notice;
  if (poolGone || finThere) {
    const serverFirst = server !== null && (pool === null || server.high + notice < pool.low);
    const poolFirst = pool !== null && (server === null || pool.high < server.low);
    if (serverFirst && finThere) return { ordering: "fin-first" };
    if (poolFirst && poolGone) return { ordering: "dropped" };
    return { border: "the close of the server and the expiry of the pool fall in the bounds of each other" };
  }
  if (pool !== null && gap.high >= pool.low)
    return { border: `the gap [${gap.low}, ${gap.high}] s meets the expiry of the pool [${pool.low}, ${pool.high}] s` };
  if (server === null || gap.high + rtt.high < server.low) return { ordering: "kept" };
  if (gap.low + rtt.low > server.high && gap.high < server.low) return { ordering: "crossed" };
  return {
    border: `the gap [${gap.low}, ${gap.high}] s with a round trip of [${rtt.low}, ${rtt.high}] s meets the close of the server [${server.low}, ${server.high}] s`,
  };
};

/** A client is one of the three HTTP clients of the cells. */
export type HttpClient = "go" | "agent" | "undici";

/** A request outcome is what the second request meets: its first connection, a retry, and the error that reaches the caller. */
export interface RequestOutcome {
  readonly connection: "reused" | "new";
  /** This flag tells that the client sent the request again on a new connection by itself. */
  readonly retried: boolean;
  /** This name is the error that reaches the caller, or null for a reply. */
  readonly error: string | null;
  /** This flag tells that nothing ends the request in the window of the cell. */
  readonly pending?: true;
}

/** This function gives a transition of a document by its identifier. */
const transition = (doc: Machine, id: string) => {
  const found = doc.transitions.find((each) => each.id === id);
  if (found === undefined) throw new Error(`${doc.id} has no transition ${id}`);
  return found;
};

/**
 * This function gives the outcome of the second request for an ordering, from the documents of the
 * clients. A crossed request meets the FIN of the server before its reply:
 * - Go sends a request that it can replay again on a new connection (`gt.retry`). It gives the
 *   caller the end of file of the read for another request (`gt.fail`).
 * - The agent gives the caller socket hang up (`na.hang-up`).
 * - undici gives the caller other side closed (`un.other-side-closed`).
 */
export const outcomeOf = (client: HttpClient, ordering: Ordering, method: "GET" | "POST"): RequestOutcome => {
  if (ordering === "kept") return { connection: "reused", retried: false, error: null };
  if (ordering === "dropped" || ordering === "fin-first") return { connection: "new", retried: false, error: null };
  if (client === "go") {
    // a GET can be replayed, and a POST without an Idempotency-Key cannot (request.go:1561-1573)
    return method === "GET"
      ? { connection: "reused", retried: transition(GO_TRANSPORT, "gt.retry").emits?.includes("req.retry") === true, error: null }
      : { connection: "reused", retried: false, error: transition(GO_TRANSPORT, "gt.fail").errno ?? null };
  }
  const errno =
    client === "agent"
      ? transition(NODE_HTTP_AGENT, "na.hang-up").errno
      : transition(UNDICI_CLIENT, "un.other-side-closed").errno;
  return { connection: "reused", retried: false, error: errno ?? null };
};

// ---------------------------------------------------------------------------------------------
// the bounds of each time, from the documents
// ---------------------------------------------------------------------------------------------

/** This function gives the seconds of a time of the algebra, or infinity for a time with no bound. */
const secondsOf = (extent: Extent | Unknown | undefined, what: string): number => {
  if (extent === undefined) return 0;
  if ("unknown" in extent) throw new Error(`${what}: ${extent.unknown}`);
  if (extent.value === "infinite") return Number.POSITIVE_INFINITY;
  return valueIn(extent, "s");
};

/** This function gives the interval of a timer of a document: its duration less how early it fires, to its duration plus how late. */
export const timerInterval = (doc: Machine, timer: string, values: KnobValues): Interval => {
  const bounds = timerOf(doc, timer, values);
  const duration = secondsOf(bounds.duration, `${doc.id} ${timer}`);
  return {
    low: round(duration - secondsOf(bounds.early, `${doc.id} ${timer}'s early bound`)),
    high: round(duration + secondsOf(bounds.lateness, `${doc.id} ${timer}'s lateness`)),
  };
};

/** This function rounds a time to the nanosecond, as the predictions of the cells do. */
const round = (value: number): number => (Number.isFinite(value) ? Math.round(value * 1e9) / 1e9 : value);

/** This function gives the values of a document's knobs: its defaults, then the settings, each in the unit of the knob. */
export const valuesOf =
  (doc: Machine, settings: object): KnobValues =>
  (name) => {
    const knob = doc.knobs[name];
    if (knob === undefined || knob.unit === null) return undefined;
    const given = (settings as Readonly<Record<string, number | "infinite" | undefined>>)[name];
    const value = given ?? knob.default;
    if (value === null || value === undefined) return undefined;
    if (value === "infinite") return { value: "infinite", unit: knob.unit };
    return { value, unit: knob.unit };
  };

/** This function gives the close of the server after its response finished, or null when its keep-alive timeout is 0. */
export const serverClose = (settings: NodeServerSettings): Interval | null => {
  if (hintOf(settings) === null) return null;
  return timerInterval(NODE_HTTP_SERVER, "keep_alive", valuesOf(NODE_HTTP_SERVER, settings));
};

/**
 * This function gives the expiry of the pool of a client at its reuse decision, from the end of
 * the reply. It reads the hint of the server. Null is no expiry, and [0, 0] is no reuse at all.
 * - Go compares the idle time with `IdleConnTimeout` by the wall clock when it takes a connection
 *   from the pool (`transport.go:1261-1283`). Thus its reuse has no lateness: [C, C].
 * - The agent has no free socket timer without a timeout, and then the hint does not apply
 *   (`_http_agent.js:637-664`). With a hint of 0 or less after the buffer, it does not reuse the socket.
 * - undici takes the hint less the threshold, capped by the maximum, and does not reuse the socket
 *   when that is 0 or less (`client-h1.js:705-717`). Without a hint, it takes `keepAliveTimeout`.
 */
export const poolExpiry = (
  client: HttpClient,
  settings: GoSettingsLike | AgentSettings | UndiciSettings,
  hint: number | null,
): Interval | null => {
  if (client === "go") {
    const c = (settings as GoSettingsLike).IdleConnTimeout ?? GO_TRANSPORT.knobs["IdleConnTimeout"]!.default!;
    return c > 0 ? { low: c, high: c } : null;
  }
  if (client === "agent") {
    const agent = settings as AgentSettings;
    const timeout = agent.timeout ?? NODE_HTTP_AGENT.knobs["timeout"]!.default!;
    if (timeout === 0) return null;
    const buffer = agent.agentKeepAliveTimeoutBuffer ?? NODE_HTTP_AGENT.knobs["agentKeepAliveTimeoutBuffer"]!.default!;
    if (hint !== null && hint * 1000 - buffer <= 0) return { low: 0, high: 0 };
    return timerInterval(
      NODE_HTTP_AGENT,
      "free_socket",
      valuesOf(NODE_HTTP_AGENT, { ...agent, hint: hint ?? "infinite" }),
    );
  }
  const undici = settings as UndiciSettings;
  const threshold = undici.keepAliveTimeoutThreshold ?? UNDICI_CLIENT.knobs["keepAliveTimeoutThreshold"]!.default!;
  if (hint !== null && hint * 1000 - threshold <= 0) return { low: 0, high: 0 };
  if (hint === null) {
    // without a hint, the timer is keepAliveTimeout: the same timer, with its duration as the maximum
    const kat = undici.keepAliveTimeout ?? UNDICI_CLIENT.knobs["keepAliveTimeout"]!.default!;
    return timerInterval(
      UNDICI_CLIENT,
      "keep_alive",
      valuesOf(UNDICI_CLIENT, { ...undici, hint: "infinite", keepAliveMaxTimeout: kat }),
    );
  }
  return timerInterval(UNDICI_CLIENT, "keep_alive", valuesOf(UNDICI_CLIENT, { ...undici, hint }));
};

/** These are the settings of the Go client that the race reads. */
interface GoSettingsLike {
  readonly IdleConnTimeout?: number;
}

/**
 * This time is the most that a client takes from its call to the write of the request. That time
 * is the goroutines of Go, or one turn of the event loop of Node. The documents do not bound it.
 * The cells assume 1 ms.
 */
export const DISPATCH = 0.001;

/**
 * This function gives the gap of a client that sleeps `g` seconds after the reply. The gap is the
 * sleep of its runtime, late as its timers are, and the dispatch. Go sleeps with a Go timer, and
 * the Node clients with a Node timer (`timers.ts`).
 */
export const gapOf = (client: HttpClient, g: number): Interval =>
  client === "go"
    ? { low: round(g), high: round(g + goLateSeconds(g) + DISPATCH) }
    : { low: round(g - NODE_EARLY_SECONDS), high: round(g + nodeLateSeconds(g) + DISPATCH) };
