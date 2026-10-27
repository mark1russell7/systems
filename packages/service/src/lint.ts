import type { Extent, Quantity } from "@mark1russell7/quantity";
import { convertExact, convertible, rationals as r } from "@mark1russell7/quantity";
import { backoffBand } from "./backoff.ts";
import type { Check, Dependency, ServiceDescription, Transport } from "./description.ts";
import type { Binding, Bound, Change, Evaluated, Rule, TimerMarks, Verdict } from "./law.ts";
import { compression, evaluate, symbolsOf, verdictOf } from "./law.ts";
import type { Limiter } from "./limiter/policy.ts";
import { idleSpan, longestRetryAfter, retryAfterSeconds } from "./limiter/policy.ts";
import { failSpan } from "./timing.ts";

/**
 * This module applies the ordering law to a declaration. The declaration binds the symbols of the
 * service, from its primitives: the polls of its checks, the windows of its policies, its drain.
 * The scenario binds the symbols of the platform (preStop, grace, the probes of the kubelet,
 * propagation) and of each dependency (its failover time, the idle close of its server). Thus the
 * service gives the inequalities, and the scenario gives the values.
 *
 * A rule about a client applies one time for each dependency. A rule about a server (`@server`)
 * also applies one time for each server transport of the service. A rule about a consumer applies
 * one time for each consumer and each worker. A rule about a limiter applies one time for each limiter.
 */

/** A statistic of a measured distribution. The law binds p99 (`LAW_STATISTIC`). */
export type Statistic = "p50" | "p90" | "p99" | "p999" | "max";

/** The law binds this statistic of a distribution. */
export const LAW_STATISTIC: Statistic = "p99";

/**
 * A claim is a value of the scenario that names its epoch: the component and the version that give
 * it, for example "node@22" (E2). A default is true only for a version: the keep-alive of Node is
 * 5 s, but 65 s on main. A claim gives a set value, or a measured distribution by its statistics.
 */
export type Claim =
  | { readonly epoch: string; readonly value: Extent }
  | { readonly epoch: string; readonly distribution: Readonly<Partial<Record<Statistic, Quantity>>> };

/**
 * A value of the scenario is an amount, or a claim. An amount names no epoch, thus the finding of
 * each rule that reads it gives null for its epoch.
 */
export type ScenarioValue = Extent | Claim;

/** A scenario gives the values of the platform and of each dependency, by the `symbol@hop` of the law. */
export interface Scenario {
  /** These are the values of the platform: prestop_sleep@pod, termination_grace@pod, probe_period@pod, propagation_bound@cluster. */
  readonly platform: Readonly<Record<string, ScenarioValue>>;
  /**
   * These are the probe windows of the kubelet, period × failure threshold. They add to the
   * windows of the declaration. A probe reads the cached verdict, thus detection is the latch,
   * then the probe.
   */
  readonly probes: { readonly readiness: Quantity; readonly liveness: Quantity };
  /** These are the values of each dependency, by its name: failover_time@dependency, server_idle_close@server. */
  readonly dependencies?: Readonly<Record<string, Readonly<Record<string, ScenarioValue>>>> | undefined;
  /**
   * These are the values of each transport, by its name and by the `symbol@hop` of the law. For a
   * consumer or a worker, they are the values of its source: lease_duration@broker. For a server,
   * they are the values of its clients: request_timeout@client.
   */
  readonly transports?: Readonly<Record<string, Readonly<Record<string, ScenarioValue>>>> | undefined;
  /**
   * These are the values of the callers of each limiter, by its name and by the `symbol@hop` of the
   * law: client_retry_window@caller, retry_delay@caller. A symbol without a hop binds at `caller`.
   */
  readonly limiters?: Readonly<Record<string, Readonly<Record<string, ScenarioValue>>>> | undefined;
}

/** The epochs of a scope map each symbol that the scenario binds to the epoch of its value, or null when the value names none. */
export type Epochs = Readonly<Record<string, string | null>>;

/** A finding is the verdict of one rule for one scope: the service, or the client of a dependency. When a value of the scenario names an epoch, the finding gives the epoch of each value that the rule reads. */
export interface Finding {
  readonly rule: string;
  readonly scope: string;
  readonly verdict: Verdict;
  readonly statement: string;
  readonly window?: string | undefined;
  readonly evaluated: readonly Evaluated[];
  /** These are the symbols that have no bound. A "depends" verdict waits for them. */
  readonly unbound: readonly string[];
  /** These are the epochs of the symbols of the rule that the scenario binds (E2). Thus a finding is true for these versions. */
  readonly epochs?: Epochs | undefined;
}

/** These are the identifiers of the rules that each declaration gets. */
export const SERVICE_RULES: readonly string[] = [
  "O04",
  "O09",
  "O10",
  "O11",
  "O12",
  "O13",
  "O14",
  "O15",
  "O16",
  "O17",
  "O18",
  "O19",
  "O20",
  "O21",
  "O22",
  "O23",
  "O27",
  "O29",
  "O30",
];

/**
 * These are the two rules of the law for a keyed limiter, as data. The caller of `lint()` gives
 * them, as it gives each other rule. Each one applies one time for each limiter.
 * - O29: the longest `Retry-After` of a limiter is at most the retry window of its caller. Its
 *   second inequality applies the same bound to a new key at the cap of keys.
 *   Otherwise the caller stops before the limit lets its call in, and a refusal becomes a failure.
 * - O30: the least delay of a caller before it sends a refused call again is at least the longest
 *   `Retry-After` of the policy. Otherwise a caller that does not read the header sends again too
 *   early, and the limiter refuses each early call again.
 *
 * The identifiers O29 and O30 are provisional. The corpus of the law in jarvis (R3, track B) has 28
 * rules, O01 to O28. It does not have these two rules yet, thus they take the next two identifiers.
 */
export const LIMITER_RULES: readonly Rule[] = [
  {
    id: "O29",
    rule: "the longest Retry-After of a limiter, at its cap of keys too, is at most the retry window of its caller",
    window: "the caller stops before the limit lets its call in, thus a refusal becomes a failure",
    expr: {
      lhs: { terms: [{ knob: "retry_after", coef: 1, at: "limiter" }] },
      op: "<=",
      rhs: { terms: [{ knob: "client_retry_window", coef: 1, at: "caller" }] },
      margin: 0,
    },
    expr_more: [
      {
        lhs: { terms: [{ knob: "retry_after_at_cap", coef: 1, at: "limiter" }] },
        op: "<=",
        rhs: { terms: [{ knob: "client_retry_window", coef: 1, at: "caller" }] },
        margin: 0,
      },
    ],
  },
  {
    id: "O30",
    rule: "the least delay of a caller before it sends a refused call again is at least the longest Retry-After of the limiter",
    window: "a caller that does not read Retry-After sends again too early, and the limiter refuses each early call again",
    expr: {
      lhs: { terms: [{ knob: "retry_delay", coef: 1, at: "caller" }] },
      op: ">=",
      rhs: { terms: [{ knob: "retry_after", coef: 1, at: "limiter" }] },
      margin: 0,
    },
  },
];

/** This function gives a finite amount in seconds. */
const secondsOf = (amount: Quantity): number =>
  r.toNumber(convertExact(r.fromNumber(amount.value), amount.unit, "s"));
/** This function gives an amount, or no bound, as the law binds it. */
const boundOf = (amount: Extent): Bound =>
  amount.value === "infinite" ? "inf" : secondsOf(amount);
/**
 * This function gives a value of the scenario as the law binds it, with its epoch. A distribution
 * binds its p99. A distribution without a p99 binds nothing, thus each rule that reads it depends.
 */
const claimOf = (value: ScenarioValue): { readonly bound: Bound | undefined; readonly epoch: string | null } => {
  if (!("epoch" in value)) return { bound: boundOf(value), epoch: null };
  if ("value" in value) return { bound: boundOf(value.value), epoch: value.epoch };
  const statistic = value.distribution[LAW_STATISTIC];
  return { bound: statistic === undefined ? undefined : secondsOf(statistic), epoch: value.epoch };
};
/** This function binds each value of a part of the scenario, at the symbol that `at` gives, and records its epoch. */
const bindScenario = (
  values: Readonly<Record<string, ScenarioValue>>,
  at: (symbol: string) => string,
  bind: Record<string, Bound>,
  epochs: Record<string, string | null>,
): void => {
  for (const [symbol, value] of Object.entries(values)) {
    const claim = claimOf(value);
    const key = at(symbol);
    epochs[key] = claim.epoch;
    if (claim.bound !== undefined) bind[key] = claim.bound;
    else delete bind[key];
  }
};
/** This function tells if a unit is a time. A unit that the package does not know is not a time. */
const isTime = (unit: string): boolean => {
  try {
    return convertible(unit, "s");
  } catch {
    return false;
  }
};
/** This function gives the largest of some numbers of seconds, or undefined when there are none. */
const most = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : Math.max(...values);

/** This function gives what the declaration tells about the service, as symbols of the law, and the source of each. */
export const serviceBindings = (
  svc: ServiceDescription,
  scenario: Scenario,
): { readonly bind: Record<string, Bound>; readonly from: Record<string, string>; readonly epochs: Epochs } => {
  const bind: Record<string, Bound> = {};
  const from: Record<string, string> = {};
  const epochs: Record<string, string | null> = {};
  const set = (symbol: string, bound: Bound | undefined, said: string): void => {
    if (bound === undefined) return;
    bind[symbol] = bound;
    from[symbol] = said;
  };
  const gating = svc.checks.filter((check) => check.gates !== null);
  const readinessChecks = gating.filter((check) => check.gates === "readiness");
  const livenessChecks = gating.filter((check) => check.gates === "liveness");
  set(
    "check_poll_interval@service",
    most(gating.map((check) => secondsOf(check.poll.interval))),
    "the slowest gating check's interval",
  );
  set(
    "check_timeout@service",
    most(gating.map((check) => secondsOf(check.poll.timeout))),
    "the longest gating check's timeout",
  );
  set(
    "slowest_poll@service",
    most(
      gating.map(
        (check) =>
          secondsOf(check.poll.timeout) + secondsOf(check.poll.interval) * (1 + check.poll.jitter),
      ),
    ),
    "a check's timeout plus one jittered interval, at its slowest",
  );
  // the window of a policy is the time that its latch takes to fail when its slowest check times out
  const windowOf = (checks: typeof gating, policy: "readiness" | "liveness"): number | undefined =>
    most(
      checks.map((check) => secondsOf(failSpan(svc.policies[policy], check.poll, "timeout").max)),
    );
  const readiness = windowOf(readinessChecks, "readiness");
  const liveness = windowOf(livenessChecks, "liveness");
  set("readiness_detection_window@service", readiness, "the readiness latch, failing by timeout");
  if (readiness !== undefined) {
    set(
      "readiness_detection_window@pod",
      readiness + secondsOf(scenario.probes.readiness),
      "the readiness latch, then the kubelet's probe",
    );
  }
  if (liveness !== undefined) {
    set(
      "liveness_detection_window@pod",
      liveness + secondsOf(scenario.probes.liveness),
      "the liveness window, then the kubelet's probe",
    );
  }
  set("startup_budget@pod", secondsOf(svc.policies.startup), "the declared startup budget");
  set(
    "process_drain_time@process",
    svc.shutdown.phases.reduce((total, phase) => total + secondsOf(phase.cap), 0),
    `the shutdown phases' caps, summed (${svc.shutdown.phases.map((phase) => phase.name).join(", ")})`,
  );
  set(
    "cooperative_window@process",
    boundOf(svc.shutdown.cooperativeWindow),
    "the declared cooperative window",
  );
  // the hold of "fail readiness" keeps the listener open after the signal, as a preStop sleep does
  const hold = svc.shutdown.phases.find((phase) => phase.name === "fail readiness");
  set(
    "readiness_hold@process",
    hold === undefined ? 0 : secondsOf(hold.cap),
    hold === undefined
      ? "no fail readiness phase: the intake stops at once after the signal"
      : "the cap of the fail readiness phase, which holds while the endpoints update",
  );
  // the rules of the bounds read the cap of one phase, and `process_drain_time@process` is the sum of all the caps
  const capOf = (name: string): number | undefined => {
    const phase = svc.shutdown.phases.find((each) => each.name === name);
    return phase === undefined ? undefined : secondsOf(phase.cap);
  };
  set("drain_phase_cap@process", capOf("drain"), "the cap of the drain phase alone");
  set("close_phase_cap@process", capOf("close transports"), "the cap of the close transports phase alone");
  bindScenario(scenario.platform, (symbol) => symbol, bind, epochs);
  for (const [symbol, epoch] of Object.entries(epochs)) {
    if (bind[symbol] === undefined) delete from[symbol];
    else from[symbol] = epoch === null ? "the scenario" : `the scenario, for ${epoch}`;
  }
  return { bind, from, epochs };
};

/** A scope binds its symbols, and records the epoch of each value of the scenario. */
interface Scoped {
  readonly bind: Record<string, Bound>;
  readonly epochs: Record<string, string | null>;
}

/** This function gives the client knobs of a dependency at @client, and the values of the scenario at its own hops. */
const dependencyBindings = (dependency: Dependency, scenario: Scenario): Scoped => {
  const bind: Record<string, Bound> = {};
  const epochs: Record<string, string | null> = {};
  for (const [knob, amount] of Object.entries(dependency.knobs))
    bind[`${knob}@client`] = boundOf(amount);
  bindScenario(scenario.dependencies?.[dependency.name] ?? {}, (symbol) => (symbol.includes("@") ? symbol : `${symbol}@dependency`), bind, epochs);
  return { bind, epochs };
};

/**
 * These are the hops of the law at which the knobs of a transport bind, by its kind. A worker does
 * its units as a consumer does, thus both bind at `consumer` (O20). A server binds at `server`, in a
 * scope of its own. In the scope of a dependency, `@server` is the server of that dependency. Thus
 * the knobs of a server of the service do not bind there, or O19 pairs the wrong two sides.
 */
const TRANSPORT_HOPS: Readonly<Record<Transport["kind"], "server" | "consumer">> = { server: "server", consumer: "consumer", worker: "consumer" };

/**
 * This function gives the time knobs of a transport at the hop of its kind, and the values of the
 * scenario for the transport. These values are of the source of a consumer, or of the clients of a
 * server. A knob with a hop in its name binds at that hop. A count binds no symbol.
 */
const transportBindings = (transport: Transport, hop: string, scenario: Scenario): Scoped => {
  const bind: Record<string, Bound> = {};
  const epochs: Record<string, string | null> = {};
  for (const [knob, amount] of Object.entries(transport.knobs)) {
    if (!isTime(amount.unit)) continue;
    bind[knob.includes("@") ? knob : `${knob}@${hop}`] = boundOf(amount);
  }
  bindScenario(scenario.transports?.[transport.name] ?? {}, (symbol) => symbol, bind, epochs);
  return { bind, epochs };
};

/**
 * This function gives the symbols of a limiter, and the values of the scenario for its callers.
 * - `retry_after@limiter` is the longest `Retry-After` of a refusal by the policy, in whole seconds.
 *   It is one interval of the bucket, or one window, as the HTTP edge sends it.
 * - `retry_after_at_cap@limiter` is the longest `Retry-After` of a new key at the cap of keys. It is
 *   the idle span, `burst / rate` or one window.
 */
const limiterBindings = (limiter: Limiter, scenario: Scenario): Scoped => {
  const bind: Record<string, Bound> = {
    "retry_after@limiter": retryAfterSeconds(longestRetryAfter(limiter.policy)),
    "retry_after_at_cap@limiter": retryAfterSeconds(idleSpan(limiter.policy)),
  };
  const epochs: Record<string, string | null> = {};
  bindScenario(scenario.limiters?.[limiter.name] ?? {}, (symbol) => (symbol.includes("@") ? symbol : `${symbol}@caller`), bind, epochs);
  return { bind, epochs };
};

const SCOPED = /@(client|dependency|server)$/;
const SERVER_SCOPED = /@server$/;
const TRANSPORT_SCOPED = /@consumer$/;
const LIMITER_SCOPED = /@(limiter|caller)$/;

/** This identifier is the rule of the findings about a field that the declaration does not give. */
export const DECLARATION_RULE = "declaration";

/**
 * This function gives a finding for each field of the shutdown that a description does not give.
 * `describe()` refuses such a declaration. A description from another source, for example the
 * JSON of 0.4, can lack the field. The verdict is `depends`, and `unbound` names the field.
 */
const declarationFindings = (svc: ServiceDescription): Finding[] =>
  (svc.shutdown as { onRepeatSignal?: unknown }).onRepeatSignal === undefined
    ? [
        {
          rule: DECLARATION_RULE,
          scope: svc.name,
          verdict: "depends",
          statement: "the declaration tells what a signal does while the shutdown runs: ignore or exit",
          window: "a repeat signal has no declared effect",
          evaluated: [],
          unbound: ["shutdown.onRepeatSignal"],
        },
      ]
    : [];

/** This identifier is the rule of the findings for two parts that have one name in the scopes of a rule. */
export const NAME_RULE = "unique-names";

/**
 * This function gives a finding for each name that two parts share in one set of scopes. A rule
 * about a client applies to each dependency and each server transport. A rule about a consumer
 * applies to each consumer and each worker, and a rule about a limiter to each limiter. Two parts
 * with one name in a set give findings with one scope, thus a reader cannot tell them apart.
 */
const nameFindings = (svc: ServiceDescription): Finding[] => {
  const sets: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      "the dependencies and the server transports",
      [...svc.dependencies.map((each) => each.name), ...svc.transports.filter((each) => each.kind === "server").map((each) => each.name)],
    ],
    ["the consumers and the workers", svc.transports.filter((each) => each.kind !== "server").map((each) => each.name)],
    ["the limiters", (svc.limiters ?? []).map((each) => each.name)],
  ];
  return sets.flatMap(([set, names]) =>
    [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].map(
      (name): Finding => ({
        rule: NAME_RULE,
        scope: name,
        verdict: "violated",
        statement: `each of ${set} has a name of its own`,
        window: `two parts have the name ${name}, thus their findings have one scope`,
        evaluated: [],
        unbound: [],
      }),
    ),
  );
};

/** This identifier is the rule of the findings about the stall time of a progress check (`Check.marks`). */
export const PROGRESS_RULE = "progress";

/**
 * This rule compares the stall time of a progress check with the longest gap between two marks of
 * the slowest loop that it names. A shorter stall time trips the check while each loop turns on time.
 */
const PROGRESS_LAW: Rule = {
  id: PROGRESS_RULE,
  rule: "the stall time of a progress check is at least the longest gap between two marks of the slowest loop that it names",
  window: "a loop that turns on time can trip the check",
  expr: {
    lhs: { terms: [{ knob: "stall", coef: 1, at: "check" }] },
    op: ">=",
    rhs: { terms: [{ knob: "mark_gap", coef: 1, at: "loop" }] },
    margin: 0,
  },
};

/** A gap is the longest time between two marks of one loop, in seconds, or the knobs that it needs. */
interface Gap {
  readonly loop: string;
  readonly seconds: number | undefined;
  readonly unbound: readonly string[];
}

/** These are the knobs of a worker that bound the gap between two of its marks. */
const WORKER_GAP_KNOBS = ["worker_sleep", "unit_processing_time", "retry_base", "retry_cap"] as const;

/**
 * This function gives the longest gap between two marks of each loop with a name. The rule counts
 * a mark at the end of each turn of the loop, also a turn that fails.
 * - A check polls on a fixed delay from the start of each poll, and each poll ends at its timeout
 *   at the latest. Thus the gap is `interval × (1 + jitter) + timeout`.
 * - After an iteration, a lane of a worker waits its sleep, or its backoff after a failure. The
 *   longest backoff is `retry_cap` plus its jitter of up to `retry_base`. The next iteration then
 *   takes up to `unit_processing_time`. Thus the gap is the longer wait plus that bound.
 *
 * A sleep or a bound without a limit gives a gap without a limit. An iteration that does not end
 * at its abort can take more time, and the rule does not bound it.
 */
const gapsOf = (svc: ServiceDescription, loop: string): Gap[] => {
  const gaps: Gap[] = svc.checks
    .filter((check) => check.name === loop)
    .map((check) => ({
      loop,
      seconds: secondsOf(check.poll.interval) * (1 + check.poll.jitter) + secondsOf(check.poll.timeout),
      unbound: [],
    }));
  for (const worker of svc.transports) {
    if (worker.kind !== "worker" || worker.name !== loop) continue;
    const knob = (name: string): number | undefined => {
      const amount = worker.knobs[name];
      if (amount === undefined || !isTime(amount.unit)) return undefined;
      return amount.value === "infinite" ? Infinity : secondsOf(amount as Quantity);
    };
    const unbound = WORKER_GAP_KNOBS.filter((name) => knob(name) === undefined).map((name) => `${loop}.${name}`);
    if (unbound.length > 0) {
      gaps.push({ loop, seconds: undefined, unbound });
      continue;
    }
    const [sleep, unit, base, cap] = WORKER_GAP_KNOBS.map((name) => knob(name)!) as [number, number, number, number];
    const backoff = Number.isFinite(base) && Number.isFinite(cap)
      ? backoffBand({ base, factor: 2, cap, jitter: { kind: "add", amount: base } }).high
      : Infinity;
    gaps.push({ loop, seconds: Math.max(sleep, backoff) + unit, unbound: [] });
  }
  return gaps;
};

/**
 * This function gives the findings of each check that names the loops that mark it. A name that is
 * not a check or a worker of the service gets a finding of its own, with the verdict `depends`.
 * Without `marks`, a check gets no finding.
 */
const progressFindings = (svc: ServiceDescription): Finding[] => {
  const findings: Finding[] = [];
  const finding = (check: Check, fields: Pick<Finding, "verdict" | "evaluated" | "unbound"> & Partial<Finding>): Finding => ({
    rule: PROGRESS_RULE,
    scope: check.name,
    statement: PROGRESS_LAW.rule,
    window: PROGRESS_LAW.window,
    ...fields,
  });
  for (const check of svc.checks) {
    const marks = check.marks;
    if (marks === undefined) continue;
    const gaps: Gap[] = [];
    for (const loop of marks.loops) {
      const found = gapsOf(svc, loop);
      if (found.length > 0) gaps.push(...found);
      else
        findings.push(
          finding(check, {
            verdict: "depends",
            statement: "each loop that a progress check names is a check or a worker of the service",
            window: `the check waits for the marks of ${loop}, and the service has no loop with that name`,
            evaluated: [],
            unbound: [loop],
          }),
        );
    }
    if (gaps.length === 0) continue;
    const unbound = [
      ...(isTime(marks.stall.unit) ? [] : [`${check.name}.marks.stall`]),
      ...gaps.flatMap((gap) => gap.unbound),
    ];
    const slowest = gaps.reduce((worst, gap) => ((gap.seconds ?? -Infinity) > (worst.seconds ?? -Infinity) ? gap : worst));
    const bind: Record<string, Bound> = {};
    if (isTime(marks.stall.unit)) bind["stall@check"] = boundOf(marks.stall);
    if (unbound.length === 0 && slowest.seconds !== undefined)
      bind["mark_gap@loop"] = Number.isFinite(slowest.seconds) ? slowest.seconds : "inf";
    const evaluated = evaluate(PROGRESS_LAW, bind);
    findings.push(
      finding(check, {
        verdict: verdictOf(PROGRESS_LAW, bind, evaluated),
        ...(unbound.length === 0 ? { statement: `${PROGRESS_LAW.rule} (${slowest.loop})` } : {}),
        evaluated,
        unbound,
      }),
    );
  }
  return findings;
};

/** This identifier is the rule of the findings about the bound of a unit against the cap of the `drain` phase. */
export const UNIT_BOUND_RULE = "unit-bound";

/** This identifier is the rule of the findings about the close bound against the cap of the `close transports` phase. */
export const CLOSE_BOUND_RULE = "close-bound";

/**
 * These are the rules of the bounds of a loop. Each one applies one time for each consumer and
 * each worker (S6 A10, A11). `lint()` gives them, as it gives `PROGRESS_RULE`.
 * - unit-bound: `unit_processing_time` is less than the cap of the `drain` phase. Otherwise the
 *   drain can cut a unit that ends in its bound. A unit without a bound violates the rule.
 * - close-bound: `close_bound` is less than the cap of the `close transports` phase. Otherwise the
 *   phase can end before the loop closes.
 *
 * The corpus of the law (R3) does not have these rules, thus they have identifiers of the service,
 * not O-numbers. The symbols `drain_phase_cap@process` and `close_phase_cap@process` are the caps of
 * one phase. `process_drain_time@process` is the sum of the caps of all the phases. A phase that the
 * declaration does not give binds no symbol, thus its finding is `depends`.
 */
export const BOUND_RULES: readonly Rule[] = [
  {
    id: UNIT_BOUND_RULE,
    rule: "the bound of one unit of a consumer or a worker is less than the cap of the drain phase",
    window: "the drain can cut a unit that ends in its bound",
    expr: {
      lhs: { terms: [{ knob: "unit_processing_time", coef: 1, at: "consumer" }] },
      op: "<",
      rhs: { terms: [{ knob: "drain_phase_cap", coef: 1, at: "process" }] },
      margin: 0,
    },
  },
  {
    id: CLOSE_BOUND_RULE,
    rule: "the close bound of a consumer or a worker is less than the cap of the close transports phase",
    window: "the phase can end before the loop closes",
    expr: {
      lhs: { terms: [{ knob: "close_bound", coef: 1, at: "consumer" }] },
      op: "<",
      rhs: { terms: [{ knob: "close_phase_cap", coef: 1, at: "process" }] },
      margin: 0,
    },
  },
];

/**
 * This function gives the scopes of a rule that reads these symbols: the service, each client, each
 * consumer and worker, or each limiter. A rule that reads a symbol at `server` applies to each client
 * and to each server transport. In the scope of a server, the scenario gives the client side.
 */
const scopesOf = (
  svc: ServiceDescription,
  scenario: Scenario,
  service: { readonly bind: Binding; readonly epochs: Epochs },
  symbols: readonly string[],
): Array<[string, Binding, Epochs]> => {
  const within = (name: string, scoped: Scoped): [string, Binding, Epochs] => {
    // a value of the scope that binds nothing hides the value of the service, as its epoch does
    const bind: Record<string, Bound | readonly number[] | undefined> = { ...service.bind, ...scoped.bind };
    for (const symbol of Object.keys(scoped.epochs)) if (!(symbol in scoped.bind)) delete bind[symbol];
    return [name, bind, { ...service.epochs, ...scoped.epochs }];
  };
  const transports = (hop: "server" | "consumer"): Array<[string, Binding, Epochs]> =>
    svc.transports
      .filter((transport) => TRANSPORT_HOPS[transport.kind] === hop)
      .map((transport) => within(transport.name, transportBindings(transport, hop, scenario)));
  return symbols.some((symbol) => LIMITER_SCOPED.test(symbol))
    ? (svc.limiters ?? []).map((limiter) => within(limiter.name, limiterBindings(limiter, scenario)))
    : symbols.some((symbol) => TRANSPORT_SCOPED.test(symbol))
      ? transports("consumer")
      : symbols.some((symbol) => SCOPED.test(symbol))
        ? [
            ...svc.dependencies.map((dependency) => within(dependency.name, dependencyBindings(dependency, scenario))),
            ...(symbols.some((symbol) => SERVER_SCOPED.test(symbol)) ? transports("server") : []),
          ]
        : [[svc.name, service.bind, service.epochs]];
};

/** This function gives the epochs of the symbols of a rule that the scenario binds. */
const epochsOf = (symbols: readonly string[], epochs: Epochs): Epochs =>
  Object.fromEntries(symbols.flatMap((symbol) => (symbol in epochs ? [[symbol, epochs[symbol] ?? null]] : [])));

/**
 * These are the marks of the timers of the platform (E10). Kubernetes takes the probe period, the
 * preStop sleep and the termination grace in whole seconds, thus each is stepped by 1 s. The
 * cluster sets the propagation of the endpoints, thus a compression of the service cannot scale it.
 */
export const PLATFORM_MARKS: TimerMarks = {
  "probe_period@pod": { kind: "stepped", step: 1 },
  "prestop_sleep@pod": { kind: "stepped", step: 1 },
  "termination_grace@pod": { kind: "stepped", step: 1 },
  "propagation_bound@cluster": { kind: "fixed" },
};

/** A change of a compression of a service: a rule and a scope whose verdict the compression changes. */
export interface ScopedChange extends Change {
  readonly scope: string;
}

/**
 * This function tells which findings of `lint` a compression by k changes (E10). It scales the
 * bindings of each scope by the marks. Thus a harness that runs the service k times faster learns
 * the orderings that its run breaks. The unmarked symbols are the symbols of the rules with no mark.
 * It reads the rules that `lint` applies with their bindings: the service rules and `BOUND_RULES`.
 */
export const compressionOf = (
  svc: ServiceDescription,
  scenario: Scenario,
  rules: readonly Rule[],
  k: number,
  marks: TimerMarks,
): { readonly changed: readonly ScopedChange[]; readonly unmarked: readonly string[] } => {
  const service = serviceBindings(svc, scenario);
  const changed: ScopedChange[] = [];
  const unmarked = new Set<string>();
  for (const rule of [...rules.filter((each) => SERVICE_RULES.includes(each.id)), ...BOUND_RULES]) {
    for (const [scope, bind] of scopesOf(svc, scenario, service, symbolsOf(rule))) {
      const result = compression([rule], bind, k, marks);
      for (const change of result.changed) changed.push({ ...change, scope });
      for (const symbol of result.unmarked) unmarked.add(symbol);
    }
  }
  return { changed, unmarked: [...unmarked] };
};

/** This function gives the findings of one rule, one for each scope of the rule. */
const findingsOf = (
  svc: ServiceDescription,
  scenario: Scenario,
  service: { readonly bind: Binding; readonly epochs: Epochs },
  rule: Rule,
): Finding[] => {
  const symbols = symbolsOf(rule);
  return scopesOf(svc, scenario, service, symbols).map(([scope, bind, all]) => {
    const evaluated = evaluate(rule, bind);
    const epochs = epochsOf(symbols, all);
    return {
      rule: rule.id,
      scope,
      verdict: verdictOf(rule, bind, evaluated),
      statement: rule.rule,
      ...(rule.window !== undefined ? { window: rule.window } : {}),
      evaluated,
      unbound: symbols.filter((symbol) => bind[symbol] === undefined),
      // a scenario of plain amounts names no epoch, thus its findings stay as they were
      ...(Object.values(epochs).some((epoch) => epoch !== null) ? { epochs } : {}),
    };
  });
};

/**
 * This function applies each service rule to a declaration and a scenario. A rule applies one time
 * for the service, for each client, for each consumer and worker, or for each limiter. It also
 * gives a finding for each necessary field that the description does not give (`DECLARATION_RULE`).
 * It gives a finding for each name that two parts share in the scopes of a rule (`NAME_RULE`). Each progress check
 * that names its loops also gets its findings (`PROGRESS_RULE`). The findings of the bounds of each
 * consumer and each worker come last (`BOUND_RULES`).
 */
export const lint = (
  svc: ServiceDescription,
  scenario: Scenario,
  rules: readonly Rule[],
): Finding[] => {
  const service = serviceBindings(svc, scenario);
  return [
    ...declarationFindings(svc),
    ...nameFindings(svc),
    ...progressFindings(svc),
    ...rules.filter((rule) => SERVICE_RULES.includes(rule.id)).flatMap((rule) => findingsOf(svc, scenario, service, rule)),
    ...BOUND_RULES.flatMap((rule) => findingsOf(svc, scenario, service, rule)),
  ];
};
