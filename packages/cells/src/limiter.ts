import { fileURLToPath } from "node:url";
import { timerOf } from "@mark1russell7/algebra";
import type { Cell, DriverStep, LineMatch, Prediction, Target } from "@mark1russell7/harness";
import { UNDICI_RETRY } from "@mark1russell7/machines";
import { valueIn } from "@mark1russell7/quantity";
import { retryAfterSeconds } from "@mark1russell7/service";
import { HZ, RUNS, s } from "./catalog.ts";
import { NODE_IMAGE } from "./http/cells.ts";
import { handlingOf } from "./http/race.ts";

/**
 * The cells of the keyed limiter (SYS-28): a real client meets the 429 of the keyed limiter of
 * `@mark1russell7/service`. They give the pairs of the laws O29 and O30 at the defaults of each client.
 * - O29: the longest Retry-After of the limiter is at most the retry window of the caller.
 * - O30: the least delay of the caller before a retry is at least the longest Retry-After.
 *
 * The target is the limiter of service 0.6.0 from npm: a sliding window of one take in `window`
 * seconds for each key. The first request of a run takes the one unit of its key, and the second
 * request meets the 429. Its Retry-After is the time until the first take leaves the window, in
 * whole seconds, rounded up. Each client sends a key of its own process, thus each run has its own count.
 *
 * The RetryAgent of undici reads Retry-After and caps it at 30 s. Thus a Retry-After of 30 s or
 * less holds O30, and a longer one sends each retry early. Five retries of 30 s are its window. A
 * Client of undici and the Transport of Go send nothing again: the caller gets the 429.
 */

/** This folder is the build context of the target: its Dockerfile, its lockfile, the script of its server and its declaration. */
const CONTEXT = fileURLToPath(new URL("../targets/service-limiter/", import.meta.url));

/** This is the version of the service in the target. The name of each cell has its MAJOR and MINOR, thus the records of two versions stay apart. */
export const LIMITER_SERVICE = "0.6.0";

/** This port is the port of the server in the target. */
const PORT = 8080;

/** This function gives the target: the limiter of service 0.6.0 over node:http, one take in `window` seconds for each key. */
export const limiterTarget = (window: number): Target => ({
  image: NODE_IMAGE,
  subject: { kind: "build", name: "service-limiter", context: CONTEXT, files: ["Dockerfile", "package.json", "npm-lock.json", "server.mjs", "declaration.mjs"] },
  port: PORT,
  ready: '"ev":"listening"',
  lines: true,
  command: ["node", "/srv/server.mjs", "--port", String(PORT), "--policy", "sliding-window", "--limit", "1", "--window-ms", String(window * 1000), "--max-keys", "100"],
});

/** A limiter client is the client of a cell: the RetryAgent of undici, a Client of undici, or the Transport of Go. */
export type LimiterClient = "undici-retry" | "undici" | "go";

/** A limiter spec is one cell: its plan, its client, and the window of the limiter in seconds. */
export interface LimiterSpec {
  readonly plan: string;
  readonly name: string;
  readonly client: LimiterClient;
  readonly window: number;
}

/** A retry plan is what the RetryAgent does against the limiter: each Retry-After and delay in seconds, and the outcome. */
export interface RetryPlan {
  readonly retryAfters: readonly number[];
  readonly delays: readonly number[];
  readonly letIn: boolean;
}

/** This function gives the values of the knobs of the RetryAgent at its defaults, with a Retry-After. */
const retryValues = (retryAfter: number) => (name: string) => {
  if (name === "retry_after") return s(retryAfter);
  if (name === "hz") return { value: HZ, unit: "Hz" };
  const knob = UNDICI_RETRY.knobs[name];
  return knob === undefined || knob.unit === null || knob.default === null ? undefined : { value: knob.default, unit: knob.unit };
};

/** This function gives an amount of the algebra in seconds. */
const seconds = (amount: unknown): number => valueIn(amount as { value: number; unit: string }, "s");

/**
 * This function gives what the RetryAgent does at its defaults against a window of `window`
 * seconds, from the two documents. Each refusal waits until the first take leaves the window (the
 * timer `oldest` of the sliding window), less the time since that take. Retry-After rounds it up to
 * whole seconds. The agent waits that time, capped at `maxTimeout` (its timer `retry_after`), and
 * it gives up after `maxRetries` retries. The second request and each retry come a little after their
 * reference, thus each wait before Retry-After is a little less than a whole second.
 */
export const retryPlan = (window: number): RetryPlan => {
  const maxRetries = UNDICI_RETRY.knobs["maxRetries"]!.default!;
  const retryAfters: number[] = [];
  const delays: number[] = [];
  let elapsed = 0;
  while (delays.length < maxRetries) {
    // the refusal comes a millisecond after the elapsed time: its Retry-After rounds the rest up
    const retryAfter = retryAfterSeconds({ value: (window - elapsed) * 1000 - 1, unit: "ms" });
    const delay = seconds(timerOf(UNDICI_RETRY, "retry_after", retryValues(retryAfter)).duration);
    retryAfters.push(retryAfter);
    delays.push(delay);
    elapsed += delay;
    if (elapsed >= window) return { retryAfters, delays, letIn: true };
  }
  return { retryAfters, delays, letIn: false };
};

/**
 * This function gives the band of one retry from the refusal before it. The low end is its timer,
 * less how early it fires. The high end adds its lateness and the handling of the refusal.
 */
const retryBand = (retryAfter: number): { low: number; high: number } => {
  const bounds = timerOf(UNDICI_RETRY, "retry_after", retryValues(retryAfter));
  const early = seconds(bounds.early ?? { value: 0, unit: "s" });
  const late = seconds(bounds.lateness ?? { value: 0, unit: "s" });
  const delay = seconds(bounds.duration);
  return { low: delay - early, high: delay + late + handlingOf("undici").high };
};

/**
 * This time bounds the time from the send of a request to the line of its reply. It holds the round
 * trip in the lab, the take of the server, and the handling of the reply by the client. The cells
 * assume it. It does not count toward a law, only toward the end of a cell without a retry.
 */
const ANSWER = 0.02;

const attempt = (n: number): LineMatch => ({ ev: "attempt", where: { i: 2, n }, name: "why" });
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** This function gives the prediction of a spec, from the documents of the limiter and of the client. */
export const limiterPrediction = (spec: LimiterSpec): Prediction => {
  if (spec.client !== "undici-retry") {
    // no retry: the caller gets the 429 of the second request, and nothing is sent again
    const quiet: LineMatch[] = spec.client === "go" ? [{ ev: "retry", where: { i: 2 } }] : [attempt(2)];
    return {
      detects: true,
      timer: `no retry: ${spec.client === "go" ? "the Transport of Go" : "a Client of undici"} gives the 429 to the caller`,
      errno: "429",
      from: "request-sent",
      low: s(0),
      high: s(round(ANSWER + handlingOf(spec.client === "go" ? "go" : "undici").high)),
      driver: { socket: "pool", ends: { ev: "response", where: { i: 2 }, name: "status" }, quiet },
    };
  }
  const plan = retryPlan(spec.window);
  const [first, ...rest] = plan.retryAfters.map(retryBand);
  const later: DriverStep[] = rest.map((band, at) => ({
    what: `retry ${at + 2}, after Retry-After ${plan.retryAfters[at + 1]} s`,
    name: "retry",
    from: "last-reply",
    ends: attempt(at + 3),
    low: s(round(band.low)),
    high: s(round(band.high)),
  }));
  const last = plan.delays.length + 1;
  // the end: the limiter lets the last retry in, or the agent gives up with the status of the last refusal
  const end: DriverStep = plan.letIn
    ? { what: "the limiter lets the last retry in", name: "200", from: "last-reply", ends: { ev: "response", where: { i: 2 }, name: "status" }, low: s(0), high: s(round(handlingOf("undici").high)) }
    : { what: "the agent gives up: RequestRetryError with the 429", name: "UND_ERR_REQ_RETRY", from: "last-reply", ends: { ev: "error", where: { i: 2 }, name: "errno" }, low: s(0), high: s(round(handlingOf("undici").high)) };
  return {
    detects: true,
    timer: `the RetryAgent of undici: Retry-After ${plan.retryAfters[0]} s, capped at 30 s (its timer retry_after)`,
    errno: "retry",
    from: "last-reply",
    low: s(round(first!.low)),
    high: s(round(first!.high)),
    driver: { socket: "pool", ends: attempt(2), then: [...later, end], quiet: [attempt(last + 1)] },
  };
};

/** These are the flags of each client: the key of its process, and the RetryAgent at its defaults. */
const OPTIONS: Readonly<Record<LimiterClient, Readonly<Record<string, number>>>> = {
  "undici-retry": { retry: 1, "limiter-key": 1 },
  undici: { "limiter-key": 1 },
  go: { "limiter-key": 1 },
};

/** These are the specs of the catalog: the borders of O30 and O29 for the RetryAgent, and the two clients that do not retry. */
export const LIMITER_SPECS: readonly LimiterSpec[] = [
  { plan: "O30.1", client: "undici-retry", window: 30, name: "the RetryAgent of undici at its defaults, Retry-After 30 s: the retry waits 30 s, and the limiter lets it in" },
  {
    plan: "O30.2",
    client: "undici-retry",
    window: 60,
    name: "the RetryAgent of undici at its defaults, Retry-After 60 s: its cap of 30 s sends the retry 30 s early, the limiter refuses it again, and the second retry gets in",
  },
  { plan: "O29.1", client: "undici-retry", window: 150, name: "the RetryAgent of undici at its defaults, Retry-After 150 s: five retries of 30 s, and the last one gets in" },
  {
    plan: "O29.2",
    client: "undici-retry",
    window: 151,
    name: "the RetryAgent of undici at its defaults, Retry-After 151 s: five retries of 30 s end before the window, and the caller gets UND_ERR_REQ_RETRY with the 429",
  },
  { plan: "O29.3", client: "undici", window: 30, name: "a Client of undici at its defaults: the caller gets the 429 at once, and the client sends nothing again" },
  { plan: "O29.4", client: "go", window: 30, name: "the Transport of Go at its defaults: the caller gets the 429 at once, and the client sends nothing again" },
];

/** This function gives the cell of the harness for a spec. */
export const limiterCell = (spec: LimiterSpec): Cell => ({
  name: `${spec.plan} ${spec.client === "go" ? "go net/http 1.27" : "undici 8.12"} to the keyed limiter of service ${LIMITER_SERVICE.split(".").slice(0, 2).join(".")}, ${spec.name}`,
  target: limiterTarget(spec.window),
  sysctls: {},
  client: spec.client === "go" ? "go-http" : "undici",
  probe: { mode: "gap", keepalive: false, http: { method: "GET", gap: s(0), options: OPTIONS[spec.client] } },
  fault: "none",
  prediction: limiterPrediction(spec),
  runs: RUNS,
  environments: 2,
});

/** These are the cells of the keyed limiter, for the harness. */
export const LIMITER_CELLS: readonly Cell[] = LIMITER_SPECS.map(limiterCell);
