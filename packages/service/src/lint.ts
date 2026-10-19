import type { Extent, Quantity } from "@mark1russell7/quantity";
import { convertExact, convertible, rationals as r } from "@mark1russell7/quantity";
import type { Dependency, ServiceDescription, Transport } from "./description.ts";
import type { Binding, Bound, Evaluated, Rule, Verdict } from "./law.ts";
import { evaluate, symbolsOf, verdictOf } from "./law.ts";
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
 * A rule about a client applies one time for each dependency. A rule about a consumer applies one
 * time for each consumer and each worker. A rule about a limiter applies one time for each limiter.
 */

/** A scenario gives the values of the platform and of each dependency, by the `symbol@hop` of the law. */
export interface Scenario {
  /** These are the values of the platform: prestop_sleep@pod, termination_grace@pod, probe_period@pod, propagation_bound@cluster. */
  readonly platform: Readonly<Record<string, Extent>>;
  /**
   * These are the probe windows of the kubelet, period × failure threshold. They add to the
   * windows of the declaration. A probe reads the cached verdict, thus detection is the latch,
   * then the probe.
   */
  readonly probes: { readonly readiness: Quantity; readonly liveness: Quantity };
  /** These are the values of each dependency, by its name: failover_time@dependency, server_idle_close@server. */
  readonly dependencies?: Readonly<Record<string, Readonly<Record<string, Extent>>>> | undefined;
  /** These are the values of the source of each consumer and worker, by its name and by the `symbol@hop` of the law: lease_duration@broker. */
  readonly transports?: Readonly<Record<string, Readonly<Record<string, Extent>>>> | undefined;
  /**
   * These are the values of the callers of each limiter, by its name and by the `symbol@hop` of the
   * law: client_retry_window@caller, retry_delay@caller. A symbol without a hop binds at `caller`.
   */
  readonly limiters?: Readonly<Record<string, Readonly<Record<string, Extent>>>> | undefined;
}

/** A finding is the verdict of one rule for one scope: the service, or the client of a dependency. */
export interface Finding {
  readonly rule: string;
  readonly scope: string;
  readonly verdict: Verdict;
  readonly statement: string;
  readonly window?: string | undefined;
  readonly evaluated: readonly Evaluated[];
  /** These are the symbols that have no bound. A "depends" verdict waits for them. */
  readonly unbound: readonly string[];
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
 * - O29: the longest `Retry-After` of a limiter is at most the retry window of its caller.
 *   Otherwise the caller stops before the limit lets its call in, and a refusal becomes a failure.
 * - O30: the least delay of a caller before it sends a refused call again is at least the longest
 *   `Retry-After`. Otherwise a caller that does not read the header sends again too early, and the
 *   limiter refuses each early call again.
 *
 * The corpus of the law in jarvis (R3, track B) has 28 rules, O01 to O28. It does not have these two
 * rules yet, thus they take the next two identifiers.
 */
export const LIMITER_RULES: readonly Rule[] = [
  {
    id: "O29",
    rule: "the longest Retry-After of a limiter is at most the retry window of its caller",
    window: "the caller stops before the limit lets its call in, thus a refusal becomes a failure",
    expr: {
      lhs: { terms: [{ knob: "retry_after", coef: 1, at: "limiter" }] },
      op: "<=",
      rhs: { terms: [{ knob: "client_retry_window", coef: 1, at: "caller" }] },
      margin: 0,
    },
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
): { readonly bind: Record<string, Bound>; readonly from: Record<string, string> } => {
  const bind: Record<string, Bound> = {};
  const from: Record<string, string> = {};
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
  for (const [symbol, amount] of Object.entries(scenario.platform))
    set(symbol, boundOf(amount), "the scenario");
  return { bind, from };
};

/** This function gives the client knobs of a dependency at @client, and the values of the scenario at its own hops. */
const dependencyBindings = (dependency: Dependency, scenario: Scenario): Record<string, Bound> => {
  const bind: Record<string, Bound> = {};
  for (const [knob, amount] of Object.entries(dependency.knobs))
    bind[`${knob}@client`] = boundOf(amount);
  for (const [symbol, amount] of Object.entries(scenario.dependencies?.[dependency.name] ?? {})) {
    bind[symbol.includes("@") ? symbol : `${symbol}@dependency`] = boundOf(amount);
  }
  return bind;
};

/**
 * These are the hops of the law at which the knobs of a transport bind, by its kind. A worker does
 * its units as a consumer does, thus both bind at `consumer` (O20). A server binds at no hop yet.
 */
const TRANSPORT_HOPS: Readonly<Record<Transport["kind"], string | null>> = { server: null, consumer: "consumer", worker: "consumer" };

/**
 * This function gives the time knobs of a transport at the hop of its kind, and the values of the
 * scenario for its source. A knob with a hop in its name binds at that hop. A count binds no symbol.
 */
const transportBindings = (transport: Transport, hop: string, scenario: Scenario): Record<string, Bound> => {
  const bind: Record<string, Bound> = {};
  for (const [knob, amount] of Object.entries(transport.knobs)) {
    if (!isTime(amount.unit)) continue;
    bind[knob.includes("@") ? knob : `${knob}@${hop}`] = boundOf(amount);
  }
  for (const [symbol, amount] of Object.entries(scenario.transports?.[transport.name] ?? {})) bind[symbol] = boundOf(amount);
  return bind;
};

/**
 * This function gives the symbols of a limiter, and the values of the scenario for its callers.
 * - `retry_after@limiter` is the longest `Retry-After` of a refusal by the policy, in whole seconds.
 *   It is one interval of the bucket, or one window, as the HTTP edge sends it.
 * - `retry_after_at_cap@limiter` is the longest `Retry-After` of a new key at the cap of keys. It is
 *   the idle span, `burst / rate` or one window.
 */
const limiterBindings = (limiter: Limiter, scenario: Scenario): Record<string, Bound> => {
  const bind: Record<string, Bound> = {
    "retry_after@limiter": retryAfterSeconds(longestRetryAfter(limiter.policy)),
    "retry_after_at_cap@limiter": retryAfterSeconds(idleSpan(limiter.policy)),
  };
  for (const [symbol, amount] of Object.entries(scenario.limiters?.[limiter.name] ?? {}))
    bind[symbol.includes("@") ? symbol : `${symbol}@caller`] = boundOf(amount);
  return bind;
};

const SCOPED = /@(client|dependency|server)$/;
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

/**
 * This function applies each service rule to a declaration and a scenario. A rule applies one time
 * for the service, for each client, for each consumer and worker, or for each limiter. The function
 * also gives a finding for each necessary field that the description does not give (`DECLARATION_RULE`).
 */
export const lint = (
  svc: ServiceDescription,
  scenario: Scenario,
  rules: readonly Rule[],
): Finding[] => {
  const service = serviceBindings(svc, scenario).bind;
  const findings: Finding[] = [...declarationFindings(svc)];
  for (const rule of rules) {
    if (!SERVICE_RULES.includes(rule.id)) continue;
    const symbols = symbolsOf(rule);
    const scopes: Array<[string, Binding]> = symbols.some((symbol) => LIMITER_SCOPED.test(symbol))
      ? (svc.limiters ?? []).map((limiter): [string, Binding] => [limiter.name, { ...service, ...limiterBindings(limiter, scenario) }])
      : symbols.some((symbol) => TRANSPORT_SCOPED.test(symbol))
      ? svc.transports.flatMap((transport): Array<[string, Binding]> => {
          const hop = TRANSPORT_HOPS[transport.kind];
          return hop === null ? [] : [[transport.name, { ...service, ...transportBindings(transport, hop, scenario) }]];
        })
      : symbols.some((symbol) => SCOPED.test(symbol))
        ? svc.dependencies.map((dependency) => [
            dependency.name,
            { ...service, ...dependencyBindings(dependency, scenario) },
          ])
        : [[svc.name, service]];
    for (const [scope, bind] of scopes) {
      const evaluated = evaluate(rule, bind);
      findings.push({
        rule: rule.id,
        scope,
        verdict: verdictOf(rule, bind, evaluated),
        statement: rule.rule,
        ...(rule.window !== undefined ? { window: rule.window } : {}),
        evaluated,
        unbound: symbols.filter((symbol) => bind[symbol] === undefined),
      });
    }
  }
  return findings;
};
