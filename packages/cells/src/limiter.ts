import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { timerOf } from "@mark1russell7/automata";
import type { BuildImage, Cell, DriverStep, LineMatch, Measured, Prediction, Target } from "@mark1russell7/harness";
import { UNDICI_RETRY } from "@mark1russell7/machines";
import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import { type Arm, checkPairedTime, firstArm, type PairedTime } from "@mark1russell7/rigor-bench";
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

/** This folder is the build context of the target: its Dockerfile, its lockfile, the script of its server, its spec and its declaration. */
const CONTEXT = fileURLToPath(new URL("../targets/service-limiter/", import.meta.url));

/** These are the files of the build context of each target. */
const FILES = ["Dockerfile", "package.json", "npm-lock.json", "server.mjs", "spec.mjs", "declaration.mjs"];

/** This is the version of the service in the target. The name of each cell has its MAJOR and MINOR, thus the records of two versions stay apart. */
export const LIMITER_SERVICE = "0.6.0";

/**
 * A limiter build is one target of the cells. It has the version of the service and the label of
 * that version in the name of each cell. It also has the build context and the check of the declaration. The
 * standing target is the folder `targets/service-limiter`. A pair of versions builds a copy of
 * that folder for each version (the input `pair` of cells.yml).
 */
export interface LimiterBuild {
  readonly service: string;
  readonly label: string;
  readonly context: string;
  readonly lint: boolean;
}

/** This is the standing target: service 0.6.0, with the check of its declaration. */
export const LIMITER_BUILD: LimiterBuild = { service: LIMITER_SERVICE, label: LIMITER_SERVICE.split(".").slice(0, 2).join("."), context: CONTEXT, lint: true };

/** This port is the port of the server in the target. */
const PORT = 8080;

/** A limiter target always has a command, and its subject is a build with its files. */
export interface LimiterTarget extends Target {
  readonly command: readonly string[];
  readonly subject: BuildImage & { readonly files: readonly string[] };
}

/** This function gives the target: the limiter of a build over node:http, one take in `window` seconds for each key. */
export const limiterTarget = (window: number, build: LimiterBuild = LIMITER_BUILD): LimiterTarget => ({
  image: NODE_IMAGE,
  subject: { kind: "build", name: build === LIMITER_BUILD ? "service-limiter" : `service-limiter-${build.service}`, context: build.context, files: FILES },
  port: PORT,
  ready: '"ev":"listening"',
  lines: true,
  command: [
    "node",
    "/srv/server.mjs",
    "--port",
    String(PORT),
    "--policy",
    "sliding-window",
    "--limit",
    "1",
    "--window-ms",
    String(window * 1000),
    "--max-keys",
    "100",
    ...(build.lint ? [] : ["--lint", "off"]),
  ],
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

/** This function gives the prediction of a spec, from the documents of the limiter and of the client. Each spec is a detection. */
export const limiterPrediction = (spec: LimiterSpec): Extract<Prediction, { readonly detects: true }> => {
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

/** This function gives the cell of the harness for a spec, on a build of the target. */
export const limiterCell = (spec: LimiterSpec, build: LimiterBuild = LIMITER_BUILD): Cell => ({
  name: `${spec.plan} ${spec.client === "go" ? "go net/http 1.27" : "undici 8.12"} to the keyed limiter of service ${build.label}, ${spec.name}`,
  target: limiterTarget(spec.window, build),
  sysctls: {},
  client: spec.client === "go" ? "go-http" : "undici",
  probe: { mode: "gap", keepalive: false, http: { method: "GET", gap: s(0), options: OPTIONS[spec.client] } },
  fault: "none",
  prediction: limiterPrediction(spec),
  runs: RUNS,
  environments: 2,
});

/** These are the cells of the keyed limiter, for the harness. */
export const LIMITER_CELLS: readonly Cell[] = LIMITER_SPECS.map((spec) => limiterCell(spec));

/** A version of the service is MAJOR.MINOR.PATCH, with no range. */
const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * This function gives the two builds of a pair from the input `pair` of cells.yml, for example
 * "0.5.6,0.6.0". The control comes first, then the candidate. Each build is the folder of its
 * version in `dir`, where the workflow copies the target. Only the candidate checks its
 * declaration, because the control can be a version without that lint().
 */
export const pairOf = (text: string, dir: string): readonly [LimiterBuild, LimiterBuild] => {
  const versions = text.split(",").map((each) => each.trim());
  if (versions.length !== 2 || !versions.every((each) => VERSION.test(each)) || versions[0] === versions[1])
    throw new Error(`the pair ${JSON.stringify(text)} is not two different versions, for example "0.5.6,0.6.0"`);
  const [control, candidate] = versions as [string, string];
  const build = (service: string, lint: boolean): LimiterBuild => ({ service, label: service, context: join(dir, service), lint });
  return [build(control, false), build(candidate, true)];
};

/**
 * This count is the rounds of a pair (SYS-52). Each round runs each arm of the A/B pair and of the
 * A/A pair once. A run of O29.1 takes approximately 157 s with its warm-up, thus 7 rounds take
 * approximately 2.5 hours on its runner.
 */
export const PAIR_ROUNDS = 7;

/** A pair block is the A/B pair (arm a is the control, arm b is the candidate) or the A/A pair (the control in both arms). */
export type PairBlock = "ab" | "aa";

/**
 * A pair slot tells what one cell of a paired run is: its spec, its round, its block and its arm.
 * The offset is the index of the spec in the selection. `firstArm(round, offset)` of rigor-bench gives
 * the arm that runs first in the round, thus the order turns each round.
 */
export interface PairSlot {
  readonly plan: string;
  readonly offset: number;
  readonly round: number;
  readonly block: PairBlock;
  readonly arm: Arm;
  readonly first: Arm;
  readonly service: string;
}

/** A pair cell is one cell of a paired run, with its slot. */
export interface PairCell {
  readonly cell: Cell;
  readonly slot: PairSlot;
}

/**
 * This function gives the cells of a paired run of the specs that `only` selects. In each round,
 * each spec runs the two arms of its A/B pair, then the two arms of its A/A pair. Each arm is a cell
 * of one run in a new environment. In each pair, `firstArm(round, offset)` gives the arm that runs first.
 *
 * The list puts the cells of each step of the rounds in the order of the specs. The runner gives
 * cell k of a selection to shard k % n. Thus if n divides the count of specs, each cell of a spec
 * operates on the same runner, in the order of its rounds. The function stops with an error if the
 * selection takes other specs of the control than of the candidate. It also stops if n does not divide them.
 */
export const limiterBench = (builds: readonly [LimiterBuild, LimiterBuild], shards: number, only: RegExp = /./, rounds: number = PAIR_ROUNDS): readonly PairCell[] => {
  const [control, candidate] = builds;
  const [ofControl, ofCandidate] = builds.map((build) => LIMITER_SPECS.filter((spec) => only.test(limiterCell(spec, build).name))) as [LimiterSpec[], LimiterSpec[]];
  const plans = (specs: LimiterSpec[]) => specs.map((spec) => spec.plan).join(",");
  if (ofControl.length === 0 || plans(ofControl) !== plans(ofCandidate))
    throw new Error(`the selection takes the specs ${plans(ofControl) || "none"} of the control and ${plans(ofCandidate) || "none"} of the candidate`);
  if (!Number.isInteger(shards) || shards < 1 || ofControl.length % shards !== 0)
    throw new Error(`a pair of ${ofControl.length} specs needs a count of shards that divides ${ofControl.length}, and it has ${shards}`);
  if (!Number.isInteger(rounds) || rounds < 2) throw new Error(`a pair needs 2 rounds or more, and it has ${rounds}`);
  const armsOf: Readonly<Record<PairBlock, Readonly<Record<Arm, LimiterBuild>>>> = { ab: { a: control, b: candidate }, aa: { a: control, b: control } };
  const steps = Array.from({ length: rounds }, (_, round) => round).flatMap((round) =>
    (["ab", "aa"] as const).flatMap((block) => [0, 1].map((order) => ({ round, block, order }))),
  );
  return steps.flatMap(({ round, block, order }) =>
    ofControl.map((spec, offset) => {
      const first = firstArm(round, offset);
      const arm: Arm = order === 0 ? first : first === "a" ? "b" : "a";
      const build = armsOf[block][arm];
      const base = limiterCell(spec, build);
      const slot: PairSlot = { plan: spec.plan, offset, round, block, arm, first, service: build.service };
      const name = `${base.name} (${block === "ab" ? "A/B" : "A/A"} round ${round + 1}, arm ${arm})`;
      return { cell: { ...base, name, runs: 1, environments: 1 }, slot };
    }),
  );
};

/** A measure of a pair: the delay of a retry after the refusal before it, or the time of the answer that ends the cell. */
export type PairMeasure = "retry" | "answer";

/** A bench time is one time of one run of a pair cell: its case (the spec and the band), its measure and the time. */
export interface BenchTime {
  readonly case: string;
  readonly measure: PairMeasure;
  readonly time: Quantity;
}

/**
 * This function gives the times of one run of a spec, one for each band of its prediction. A case is a
 * spec and a band. For the RetryAgent, the first band and each later retry are the measure `retry`,
 * and the end of the cell is the measure `answer`. For a client that does not retry, the 429 is the
 * measure `answer`. A void run gives no time. A band whose line did not come gives no time.
 */
export const benchTimes = (spec: LimiterSpec, run: Measured): readonly BenchTime[] => {
  if (run.void !== null) return [];
  const times: BenchTime[] = [];
  if (spec.client !== "undici-retry") {
    if (run.elapsed !== null) times.push({ case: `${spec.plan} answer`, measure: "answer", time: run.elapsed });
    return times;
  }
  const retries = retryPlan(spec.window).delays.length;
  if (run.elapsed !== null) times.push({ case: `${spec.plan} retry 1`, measure: "retry", time: run.elapsed });
  (run.driver?.steps ?? []).forEach((step, at) => {
    if (step.elapsed === null) return;
    const retry = at < retries - 1;
    times.push(retry ? { case: `${spec.plan} retry ${at + 2}`, measure: "retry", time: step.elapsed } : { case: `${spec.plan} answer`, measure: "answer", time: step.elapsed });
  });
  return times;
};

/** A paired line is one PairedTime of rigor-bench in the records of a run: its pair, its measure, and each time as an amount. */
export interface PairedLine {
  readonly pair: PairBlock;
  readonly measure: PairMeasure;
  readonly case: string;
  readonly round: number;
  readonly first: Arm;
  readonly a: Quantity;
  readonly b: Quantity;
}

/** This function gives the PairedTime of rigor-bench of a paired line, in seconds. `checkPairedTime` refuses a time that is not above 0. */
export const pairedTimeOf = (line: PairedLine): PairedTime =>
  checkPairedTime({ case: line.case, round: line.round, first: line.first, a: valueIn(line.a, "s"), b: valueIn(line.b, "s") });

/**
 * This function gives the paired lines of the two arms of one pair in one round: a line for each case
 * that each arm timed. It stops with an error if the two slots are not the two arms of one pair.
 */
export const pairedLines = (one: { readonly slot: PairSlot; readonly times: readonly BenchTime[] }, two: { readonly slot: PairSlot; readonly times: readonly BenchTime[] }): readonly PairedLine[] => {
  const [a, b] = one.slot.arm === "a" ? [one, two] : [two, one];
  const same = (key: keyof PairSlot) => a.slot[key] === b.slot[key];
  if (!same("plan") || !same("round") || !same("block") || !same("first") || a.slot.arm !== "a" || b.slot.arm !== "b")
    throw new Error(`the slots ${JSON.stringify(one.slot)} and ${JSON.stringify(two.slot)} are not the two arms of one pair`);
  return a.times.flatMap((time) => {
    const other = b.times.find((each) => each.case === time.case);
    if (other === undefined) return [];
    const line: PairedLine = { pair: a.slot.block, measure: time.measure, case: time.case, round: a.slot.round, first: a.slot.first, a: time.time, b: other.time };
    pairedTimeOf(line);
    return [line];
  });
};
