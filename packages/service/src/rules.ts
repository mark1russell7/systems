// @mark1russell7/service/rules: the rules of the ordering law that a drain in Kubernetes meets, as
// data (SYS-32). The caller of `lint()` gives the rules. This entry gives the drain rules from one
// source, thus a service does not copy them into its tests. It loads no module at run time: only the
// type of a rule comes from the law. Thus it loads no Testcontainers, no `node:` module and no zod.

import type { Rule } from "./law.ts";

export type { Rule } from "./law.ts";

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

/**
 * These are the rules of the drain. For each way that a pod stops, `lintStop()` applies only the
 * rules of this set that guard that way. `DRAIN_RULE_IDS` gives their identifiers.
 */
export const DRAIN_RULES: readonly Rule[] = [O04, O09, O10, O16];
