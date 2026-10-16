import type { Extent, Quantity } from "@mark1russell7/quantity";
import { convertExact, rationals as r } from "@mark1russell7/quantity";
import type { Dependency, ServiceDescription } from "./description.ts";
import type { Binding, Bound, Evaluated, Rule, Verdict } from "./law.ts";
import { evaluate, symbolsOf, verdictOf } from "./law.ts";
import { failSpan } from "./timing.ts";

/**
 * This module applies the ordering law to a declaration. The declaration binds the symbols of the
 * service, from its primitives: the polls of its checks, the windows of its policies, its drain.
 * The scenario binds the symbols of the platform (preStop, grace, the probes of the kubelet,
 * propagation) and of each dependency (its failover time, the idle close of its server). Thus the
 * service gives the inequalities, and the scenario gives the values. A rule about a client
 * applies one time for each dependency.
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
  "O21",
  "O22",
  "O23",
  "O27",
];

/** This function gives a finite amount in seconds. */
const secondsOf = (amount: Quantity): number =>
  r.toNumber(convertExact(r.fromNumber(amount.value), amount.unit, "s"));
/** This function gives an amount, or no bound, as the law binds it. */
const boundOf = (amount: Extent): Bound =>
  amount.value === "infinite" ? "inf" : secondsOf(amount);
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

const SCOPED = /@(client|dependency|server)$/;

/** This function applies each service rule to a declaration and a scenario: one time for the service, and one time for each client. */
export const lint = (
  svc: ServiceDescription,
  scenario: Scenario,
  rules: readonly Rule[],
): Finding[] => {
  const service = serviceBindings(svc, scenario).bind;
  const findings: Finding[] = [];
  for (const rule of rules) {
    if (!SERVICE_RULES.includes(rule.id)) continue;
    const symbols = symbolsOf(rule);
    const scopes: Array<[string, Binding]> = symbols.some((symbol) => SCOPED.test(symbol))
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
