import type { ServiceDescription } from "./description.ts";
import type { Rule } from "./law.ts";
import type { Finding, Scenario } from "./lint.ts";
import { BOUND_RULES, lint } from "./lint.ts";

/**
 * This module keeps apart the four ways that a pod stops (B11). Each way runs a different part of
 * the shutdown, thus a different set of the rules of the drain guards it.
 */

/** A way that a pod stops: a deletion, a liveness restart, a crash, or a stop for lack of memory (OOM). */
export type StopWay = "deletion" | "liveness-restart" | "crash" | "oom";

/** What a way of stopping runs, and the rules of the drain that guard it. */
export interface Stop {
  readonly way: StopWay;
  /** This is the signal that the process gets first, or null when the process exits by itself. */
  readonly signal: "SIGTERM" | "SIGKILL" | null;
  /** This flag tells if the kubelet runs the preStop hook. */
  readonly preStop: boolean;
  /** This flag tells if the process runs its shutdown phases. */
  readonly drain: boolean;
  /**
   * This is how the pod leaves its endpoints: by its deletion, when its readiness fails, or when
   * the kubelet finds that the container exited.
   */
  readonly leaves: "deletion" | "readiness" | "exit";
  /** These are the identifiers of the rules of the drain that guard this way. */
  readonly rules: readonly string[];
}

/** These are the rules of the drain. Each way of stopping applies only its own rules of this set. */
export const DRAIN_RULE_IDS: readonly string[] = ["O04", "O09", "O10", "O16"];

/**
 * These are the four ways that a pod stops.
 * - A deletion runs the preStop hook, then SIGTERM. The endpoints drop the pod at its deletion,
 *   thus the preStop sleep and the hold must cover the propagation (O04).
 * - A liveness restart also runs the preStop hook and SIGTERM, with the grace. The pod stays in its
 *   endpoints until its readiness fails, thus readiness must fail first (O09).
 * - A crash and an OOM stop run no hook and no drain. The kubelet finds the exit at its relist, and
 *   no rule bounds that time. A client that can reissue a request is the only guard.
 */
export const STOPS: Readonly<Record<StopWay, Stop>> = {
  deletion: { way: "deletion", signal: "SIGTERM", preStop: true, drain: true, leaves: "deletion", rules: ["O04", "O10", "O16"] },
  "liveness-restart": { way: "liveness-restart", signal: "SIGTERM", preStop: true, drain: true, leaves: "readiness", rules: ["O09", "O10", "O16"] },
  crash: { way: "crash", signal: null, preStop: false, drain: false, leaves: "exit", rules: [] },
  oom: { way: "oom", signal: "SIGKILL", preStop: false, drain: false, leaves: "exit", rules: [] },
};

/** The identifier of the finding of a way of stopping that runs no drain. */
export const STOP_RULE = "stop";

/**
 * This function applies the rules to a declaration for one way of stopping. A rule of the drain
 * applies only when it guards that way. The other rules apply as `lint()` applies them. A way with
 * no drain also gets a finding of `STOP_RULE` that depends. No rule bounds the time until the
 * kubelet finds the exit, and the work in flight is lost. Such a way starts no phase, thus it gets no
 * finding of `BOUND_RULES`.
 */
export const lintStop = (svc: ServiceDescription, scenario: Scenario, rules: readonly Rule[], way: StopWay): Finding[] => {
  const stop = STOPS[way];
  const applies = rules.filter((rule) => !DRAIN_RULE_IDS.includes(rule.id) || stop.rules.includes(rule.id));
  const findings = lint(svc, scenario, applies);
  if (stop.drain) return findings;
  return [
    ...findings.filter((finding) => !BOUND_RULES.some((rule) => rule.id === finding.rule)),
    {
      rule: STOP_RULE,
      scope: svc.name,
      verdict: "depends",
      statement: `a ${way} runs no preStop hook and no drain, and no rule bounds the time until the kubelet finds the exit`,
      window: "the work in flight is lost, and the endpoints keep the pod until the kubelet finds the exit",
      evaluated: [],
      unbound: ["exit_detection@pod"],
    },
  ];
};
