import { fileURLToPath } from "node:url";
import type { Cell, LineCount, Prediction, Target } from "@mark1russell7/harness";
import { UNDICI_RETRY } from "@mark1russell7/machines";
import { ms, s } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";

/**
 * This module holds the first cells of Q18 (SYS-67): how many tries does one request cost across
 * hops? The answer of law O08 is a product. The deepest listener sees `A = t0 × t1 × … × tn` tries
 * for one logical request. The term `ti` is the tries of caller i against the answer of the listener below it.
 *
 * Each term comes from a pinned source:
 * - The RetryAgent of undici 8.12.2. The defaults are `maxRetries` 5, the methods GET HEAD OPTIONS
 *   PUT DELETE TRACE QUERY, and the statuses 500 502 503 504 429 (lib/handler/retry-handler.js:125-133).
 *   Each reply adds one to the counter (:380), and each socket error adds one (:610). The counter must
 *   pass `maxRetries` to stop (:348), thus the agent sends 1 + `maxRetries` times. A method or a
 *   status out of the lists is not retried (:332, :338). A socket close is `UND_ERR_SOCKET` (:144).
 * - The Transport of Go 1.27.2. A reply ends the round trip, for each status
 *   (src/net/http/transport.go:727-737). A read failure on a reused connection sends a replayable
 *   request again (:877-881, wrapped at :2510), and a fresh connection sends nothing again (:858).
 *   Thus a GET that meets a close on a reused connection costs 2 tries, and a status costs 1.
 * - `retry` of `@mark1russell7/service` 0.6.5. `tries` counts the first try, and the last try
 *   throws (packages/service/src/retrier.ts:121-125).
 *
 * The record shows each term. Each listener writes a line for each arrival, with the trail of the
 * tries above it (`targets/retry-chain/chain.ts`). The count at listener k is the product of the
 * tries of its callers. The hops share one process and talk over loopback: a count reads no
 * network term and no timer, thus a loaded runner cannot move it. The delays differ across the
 * cells for that reason, and `T14.count.2` and `T14.count.3` are the same chain at two delays.
 *
 * The chain needs no load generator, and the outage is the answer of the deepest listener. Thus
 * these cells use no fault, and no container for each hop.
 */

/** This folder is the build context of the target: its Dockerfile, its lockfile and its program. */
const CONTEXT = fileURLToPath(new URL("../targets/retry-chain/", import.meta.url));

/** These are the files of the build context. */
const FILES = ["Dockerfile", "package.json", "npm-lock.json", "chain.ts"];

/** This port is the port of listener 0, and each next listener has the next port. */
const PORT = 8080;

/** This count is the runs of a cell of SYS-67: the decision rule of the prediction reads 4. */
const COUNT_RUNS = 4;

/** These are the statuses that a RetryAgent retries at its defaults (lib/handler/retry-handler.js:133). */
const RETRIED_STATUSES: readonly number[] = [500, 502, 503, 504, 429];

/** These are the methods that a RetryAgent retries at its defaults (lib/handler/retry-handler.js:131). */
const RETRIED_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE", "QUERY"];

/** This status is the answer of a hop whose call ended with a close: the status of a bad gateway. */
const BAD_GATEWAY = 502;

/** An answer is what a caller gets: a status, or a close of the socket with no reply. */
export type Answer = number | "close";

/** A RetryAgent of undici is a caller, with its options over the defaults. */
export interface UndiciCaller {
  readonly kind: "undici";
  readonly maxRetries?: number;
  /** This time is `minTimeout` in ms. The delays do not enter the count. */
  readonly minTimeout?: number;
}

/** The Transport of Go is a caller, and only the client of a cell can be it. */
export interface GoCaller {
  readonly kind: "go";
}

/** A call of `retry` of the service is a caller, with its tries and the base of its backoff in ms. */
export interface ServiceCaller {
  readonly kind: "service";
  readonly tries: number;
  readonly base: number;
}

/** A hop is a caller in the chain. `answer` replaces the status that it gives up with. */
export type Hop = (UndiciCaller | ServiceCaller) & { readonly answer?: number };

/** A chain is the client of a cell, its hops from the client on, and the failure of the deepest listener. */
export interface Chain {
  readonly method: "GET" | "POST";
  readonly client: UndiciCaller | GoCaller;
  readonly hops: readonly Hop[];
  readonly failure: Answer;
}

/** This function gives the tries of a RetryAgent: 1 + `maxRetries`, where its policy retries the answer. */
const undiciTries = (caller: UndiciCaller, method: string, answer: Answer): number => {
  const retried = RETRIED_METHODS.includes(method) && (answer === "close" || RETRIED_STATUSES.includes(answer));
  return retried ? (caller.maxRetries ?? UNDICI_RETRY.knobs["maxRetries"]!.default!) + 1 : 1;
};

/** This function gives the tries of a caller against an answer of the listener below it. */
export const triesOf = (caller: Chain["client"] | Hop, method: string, answer: Answer): number => {
  if (caller.kind === "undici") return undiciTries(caller, method, answer);
  if (caller.kind === "service") return answer === "close" || answer >= 500 ? caller.tries : 1;
  return answer === "close" && method === "GET" ? 2 : 1;
};

/** The law of a chain is the tries of each caller, and the arrivals at each listener. The last arrival is the product. */
export interface ChainLaw {
  readonly tries: readonly number[];
  readonly arrivals: readonly number[];
}

/** This function gives the law of a chain. It goes from the deepest listener up, because each answer sets the tries above it. */
export const lawOf = (chain: Chain): ChainLaw => {
  const tries: number[] = [];
  let answer = chain.failure;
  for (const hop of [...chain.hops].reverse()) {
    tries.unshift(triesOf(hop, chain.method, answer));
    answer = hop.answer ?? (answer === "close" ? BAD_GATEWAY : answer);
  }
  tries.unshift(triesOf(chain.client, chain.method, answer));
  const arrivals = tries.map((_, at) => tries.slice(0, at + 1).reduce((product, each) => product * each, 1));
  return { tries, arrivals };
};

/** This function gives the time of the delays of one caller that gives up, in seconds, with no time on the wire. */
export const delaysOf = (caller: UndiciCaller): number => {
  const retries = caller.maxRetries ?? UNDICI_RETRY.knobs["maxRetries"]!.default!;
  const first = caller.minTimeout ?? 500;
  return Array.from({ length: retries }, (_, at) => first * 2 ** at).reduce((sum, each) => sum + each, 0) / 1000;
};

/** This function gives the argument of the program of the target: its hops and its failure. */
export const chainArgument = (chain: Chain): unknown => ({
  hops: chain.hops.map((hop) => ({
    kind: hop.kind,
    ...(hop.kind === "service"
      ? { tries: hop.tries, base: hop.base }
      : { options: { ...(hop.maxRetries === undefined ? {} : { maxRetries: hop.maxRetries }), ...(hop.minTimeout === undefined ? {} : { minTimeout: hop.minTimeout }) } }),
    ...(hop.answer === undefined ? {} : { answer: hop.answer }),
  })),
  failure: chain.failure,
});

/** This function gives the target of a chain, with the chain as its argument. */
export const chainTarget = (chain: Chain): Target => ({
  image: NODE_IMAGE,
  subject: { kind: "build", name: "retry-chain", context: CONTEXT, files: FILES },
  port: PORT,
  ready: '"ev":"listening"',
  lines: true,
  command: ["node", "/srv/chain.ts", "--port", String(PORT), "--chain", JSON.stringify(chainArgument(chain))],
});

/** This function gives the flags of the client of a chain. */
const clientOptions = (client: Chain["client"]): Readonly<Record<string, number>> =>
  client.kind === "go"
    ? {}
    : {
        retry: 1,
        ...(client.maxRetries === undefined ? {} : { "retry-max-retries": client.maxRetries }),
        ...(client.minTimeout === undefined ? {} : { "retry-min-timeout-ms": client.minTimeout }),
      };

/** This function gives the name of a listener in the counts: the target for the deepest one. */
const listenerOf = (at: number, last: number): string => (at === last ? "the arrivals at the target" : `the arrivals at hop ${at}`);

/** This function gives the exact counts of a chain, one for each listener. */
export const countsOf = (chain: Chain): readonly LineCount[] => {
  const { arrivals } = lawOf(chain);
  return arrivals.map((count, at) => ({ what: listenerOf(at, arrivals.length - 1), match: { ev: "arrive", where: { hop: at } }, count }));
};

/** A count spec is one cell: its plan, its chain, what it shows, and the longest time of a run in seconds. */
export interface CountSpec {
  readonly plan: string;
  readonly chain: Chain;
  readonly name: string;
  readonly window: number;
}

/** This delay is the first delay of a chain whose time does not matter, in ms. */
const FAST = 1;

/** This caller is a RetryAgent with a first delay of 1 ms. */
const FAST_CALLER: UndiciCaller = { kind: "undici", minTimeout: FAST };

/** This time is the window of a cell with delays of milliseconds, in seconds. */
const SHORT_WINDOW = 30;

/** These are the specs of SYS-67. */
export const COUNT_SPECS: readonly CountSpec[] = [
  {
    plan: "T14.count.1",
    name: "a RetryAgent at its defaults against a 503: one caller, 6 tries",
    chain: { method: "GET", client: { kind: "undici" }, hops: [], failure: 503 },
    window: 40,
  },
  {
    plan: "T14.count.2",
    name: "two RetryAgents at their defaults against a 503: 6 × 6",
    chain: { method: "GET", client: { kind: "undici" }, hops: [{ kind: "undici" }], failure: 503 },
    window: 150,
  },
  {
    plan: "T14.count.3",
    name: "two RetryAgents with delays of milliseconds against a 503: 6 × 6, thus the delays do not enter the count",
    chain: { method: "GET", client: FAST_CALLER, hops: [FAST_CALLER], failure: 503 },
    window: SHORT_WINDOW,
  },
  {
    plan: "T14.count.4",
    name: "three callers, retry of the service in the middle, against a 503: 6 × 3 × 6",
    chain: { method: "GET", client: FAST_CALLER, hops: [{ kind: "service", tries: 3, base: FAST }, FAST_CALLER], failure: 503 },
    window: SHORT_WINDOW,
  },
  {
    plan: "T14.count.5",
    name: "the Transport of Go over a RetryAgent against a 503: Go sends nothing again for a status, 1 × 6",
    chain: { method: "GET", client: { kind: "go" }, hops: [FAST_CALLER], failure: 503 },
    window: SHORT_WINDOW,
  },
  {
    plan: "T14.count.6",
    name: "two RetryAgents with a POST against a 503: the method is out of the list, 1 × 1",
    chain: { method: "POST", client: FAST_CALLER, hops: [FAST_CALLER], failure: 503 },
    window: SHORT_WINDOW,
  },
  {
    plan: "T14.count.7",
    name: "two RetryAgents, and the hop gives up with a 501: the status is out of the list above it, 1 × 6",
    chain: { method: "GET", client: FAST_CALLER, hops: [{ ...FAST_CALLER, answer: 501 }], failure: 503 },
    window: SHORT_WINDOW,
  },
  {
    plan: "T14.count.8",
    name: "two RetryAgents against a close with no reply: a close costs what a status costs, 6 × 6",
    chain: { method: "GET", client: FAST_CALLER, hops: [FAST_CALLER], failure: "close" },
    window: SHORT_WINDOW,
  },
  {
    plan: "T14.count.9",
    name: "the Transport of Go against a close on a reused connection: one resend on a new connection, 2",
    chain: { method: "GET", client: { kind: "go" }, hops: [], failure: "close" },
    window: SHORT_WINDOW,
  },
];

/** This function gives the prediction of a spec: the exact count at each listener. */
export const countPrediction = (spec: CountSpec): Prediction => {
  const { tries } = lawOf(spec.chain);
  return {
    detects: null,
    window: s(spec.window),
    from: "request-sent",
    why: `the tries of each caller multiply (law O08): ${tries.join(" × ")}. The count reads no timer, thus it has no band`,
    counts: countsOf(spec.chain),
  };
};

/** This function gives the cell of a spec. */
export const countCell = (spec: CountSpec): Cell => ({
  name: `${spec.plan} ${spec.name}`,
  target: chainTarget(spec.chain),
  sysctls: {},
  client: spec.chain.client.kind === "go" ? "go-http" : "undici",
  // the hold only names the logical request: each path but the root fails, and no listener holds a reply
  probe: { mode: "gap", keepalive: false, http: { method: spec.chain.method, gap: s(0), hold: ms(1), options: clientOptions(spec.chain.client) } },
  fault: "none",
  prediction: countPrediction(spec),
  runs: COUNT_RUNS,
  environments: 2,
});

/** These are the cells of SYS-67. */
export const COUNT_CELLS: readonly Cell[] = COUNT_SPECS.map(countCell);
