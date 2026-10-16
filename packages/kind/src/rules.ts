import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Finding, Rule, Scenario, ServiceDescription, Verdict } from "@mark1russell7/service";
import { lint } from "@mark1russell7/service";
import { redisClient } from "@mark1russell7/service/redis";
import type { KindCell } from "./cell.ts";
import { compose } from "./compose.ts";
import type { Propagation } from "./predict.ts";

/**
 * These are the rules of the ordering law that a drain in Kubernetes meets, as data. The caller of
 * `lint()` gives the rules, thus they are here and not in the service.
 */

/**
 * O04 with the hold of the service. The listener of a pod stays open through the preStop sleep and
 * then through the hold of `fail readiness`. Thus the sum of the two must cover the propagation of
 * the endpoints. The rule of the research is the case without a hold.
 */
export const O04: Rule = {
  id: "O04",
  rule: "the preStop sleep plus the hold of fail readiness is at least the endpoint propagation",
  window: "new connections reach a pod whose listener is closed",
  expr: {
    lhs: {
      terms: [
        { knob: "prestop_sleep", coef: 1, at: "pod" },
        { knob: "readiness_hold", coef: 1, at: "process" },
      ],
    },
    op: ">=",
    rhs: { terms: [{ knob: "propagation_bound", coef: 1, at: "cluster" }] },
  },
};

/** O09 is W8: readiness detection plus propagation is no longer than liveness detection plus the preStop sleep. */
export const O09: Rule = {
  id: "O09",
  rule: "readiness detection plus endpoint propagation is no longer than liveness detection plus the preStop sleep",
  window: "traffic reaches a container that its liveness probe kills",
  expr: {
    lhs: {
      terms: [
        { knob: "readiness_detection_window", coef: 1, at: "pod" },
        { knob: "propagation_bound", coef: 1, at: "cluster" },
      ],
    },
    op: "<=",
    rhs: {
      terms: [
        { knob: "liveness_detection_window", coef: 1, at: "pod" },
        { knob: "prestop_sleep", coef: 1, at: "pod" },
      ],
    },
  },
};

/** O10: the preStop sleep plus the drain of the process fits in the grace period. */
export const O10: Rule = {
  id: "O10",
  rule: "the preStop sleep plus the shutdown of the process fits in the grace period",
  window: "work in flight at SIGKILL is cut, and each connection closes at once",
  expr: {
    lhs: {
      terms: [
        { knob: "prestop_sleep", coef: 1, at: "pod" },
        { knob: "process_drain_time", coef: 1, at: "process" },
      ],
    },
    op: "<=",
    rhs: { terms: [{ knob: "termination_grace", coef: 1, at: "pod" }] },
  },
};

/** O16: the cooperative window is shorter than the drain, which is shorter than the grace less the preStop sleep. */
export const O16: Rule = {
  id: "O16",
  rule: "the cooperative window is shorter than the drain, which is shorter than the grace less the preStop sleep",
  window: "handlers are cut before they answer, or the drain itself gets SIGKILL",
  expr: {
    lhs: { terms: [{ knob: "cooperative_window", coef: 1, at: "process" }] },
    op: "<",
    rhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
  },
  expr_more: [
    {
      lhs: { terms: [{ knob: "process_drain_time", coef: 1, at: "process" }] },
      op: "<",
      rhs: {
        terms: [
          { knob: "termination_grace", coef: 1, at: "pod" },
          { knob: "prestop_sleep", coef: -1, at: "pod" },
        ],
      },
    },
  ],
};

/** These are the rules of the drain that each kind cell gets. */
export const DRAIN_RULES: readonly Rule[] = [O04, O09, O10, O16];

const seconds = (amount: Quantity): number => valueIn(amount, "s");
const s = (value: number): Quantity => ({ value, unit: "s" });

/**
 * This function gives the scenario of a cell for `lint()`: the preStop sleep, the grace, the probe
 * period and the propagation. The probe windows are the period times the threshold of each probe.
 */
export const scenarioOf = (cell: KindCell, propagation: Propagation): Scenario => ({
  platform: {
    "prestop_sleep@pod": cell.pod.preStop,
    "termination_grace@pod": cell.pod.grace,
    "probe_period@pod": cell.pod.readiness.period,
    "propagation_bound@cluster": s(propagation.hi),
  },
  probes: {
    readiness: s(seconds(cell.pod.readiness.period) * cell.pod.readiness.threshold),
    liveness: s(seconds(cell.pod.liveness.period) * cell.pod.liveness.threshold),
  },
});

/** A verdict set is the verdict of each drain rule for one declaration, by the identifier of the rule. */
export type Verdicts = Readonly<Record<string, Verdict>>;

/** This function applies the drain rules to the description of a cell, and gives each finding. */
export const lintCell = (description: ServiceDescription, cell: KindCell, propagation: Propagation): Finding[] =>
  lint(description, scenarioOf(cell, propagation), DRAIN_RULES);

/** This function gives the verdict of each drain rule, by its identifier. */
export const verdictsOf = (findings: readonly Finding[]): Verdicts =>
  Object.fromEntries(findings.map((finding) => [finding.rule, finding.verdict]));

/** This function gives the description of the service of a cell, as the app of the image composes it. Nothing connects. */
export const describeCell = (cell: KindCell): ServiceDescription => {
  const redis = cell.declaration.redis;
  const client =
    redis === null
      ? undefined
      : redisClient("redis", { host: "redis", port: 6379, system: "systems.component.redis", knobs: redis.knobs, heartbeatMisses: redis.misses });
  return compose("lab", cell.declaration, { redis: client }).describe();
};
