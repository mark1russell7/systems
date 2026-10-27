import type { Quantity } from "@mark1russell7/quantity";
import { valueIn } from "@mark1russell7/quantity";
import type { Finding, Scenario, ServiceDescription, StopWay, Verdict } from "@mark1russell7/service";
import { lint, lintStop } from "@mark1russell7/service";
import { redisClient } from "@mark1russell7/service/redis";
import { DRAIN_RULES } from "@mark1russell7/service/rules";
import type { KindCell } from "./cell.ts";
import { compose } from "./compose.ts";
import type { Propagation } from "./predict.ts";

/**
 * The rules of the ordering law that a drain in Kubernetes meets are data in the entry
 * `@mark1russell7/service/rules` (SYS-32). That entry loads no Testcontainers, thus a service can
 * import the rules without kind. This module gives them again, thus the exports of kind stay the
 * same. A kind cell gets the rules that guard the way that its plan stops a pod.
 */
export { DRAIN_RULES, O04, O09, O10, O16 } from "@mark1russell7/service/rules";

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
    "propagation_bound@cluster": propagation.hi,
  },
  probes: {
    readiness: s(seconds(cell.pod.readiness.period) * cell.pod.readiness.threshold),
    liveness: s(seconds(cell.pod.liveness.period) * cell.pod.liveness.threshold),
  },
});

/** A verdict set is the verdict of each drain rule for one declaration, by the identifier of the rule. */
export type Verdicts = Readonly<Record<string, Verdict>>;

/**
 * This function gives the way that the fault plan of a cell stops a pod, or null when the plan stops no pod.
 * - A deletion, a rolling update, a node drain, a scale-in and a rollout delete a pod with its grace.
 * - In T07 a pause of kube-proxy comes before a deletion. In T18 the pause is on Redis.
 * - The crash of the lab is SIGKILL from the node. Like a crash, it has no preStop hook and no drain.
 * - The other faults are on a link, on Redis or on the process. The kubelet can restart a pod after them.
 *   A zone loss freezes the pods of its node and deletes none of them in its hold.
 */
export const stopOf = (cell: KindCell): StopWay | null => {
  switch (cell.trigger.kind) {
    case "pod-deletion":
    case "rolling-update":
    case "node-drain":
    case "scale-in":
    case "rollout":
      return "deletion";
    case "freeze-process":
      return cell.template === "T07" ? "deletion" : null;
    case "crash":
      return "crash";
    case "liveness-restart":
      return "liveness-restart";
    case "rst":
    case "blackhole":
    case "peer-gone-without-close":
    case "app-stall":
    case "cpu-throttle":
    case "authorization-policy":
    case "idle":
    case "ztunnel-restart":
    case "certificate-expiry":
    case "cannot-serve":
    case "zone-loss":
      return null;
  }
};

/**
 * This function applies the drain rules to the description of a cell, and gives each finding. A cell
 * whose plan stops a pod gets the rules of that way (`lintStop()`). A plan that stops no pod gets each
 * drain rule, because a restart by the kubelet or a later deletion can follow its fault.
 */
export const lintCell = (description: ServiceDescription, cell: KindCell, propagation: Propagation): Finding[] => {
  const way = stopOf(cell);
  const scenario = scenarioOf(cell, propagation);
  return way === null ? lint(description, scenario, DRAIN_RULES) : lintStop(description, scenario, DRAIN_RULES, way);
};

/** This function gives the verdict of each drain rule, by its identifier. */
export const verdictsOf = (findings: readonly Finding[]): Verdicts =>
  Object.fromEntries(findings.map((finding) => [finding.rule, finding.verdict]));

/** This function gives the description of the service of a cell, as the app of the image composes it. Nothing connects. */
export const describeCell = (cell: KindCell): ServiceDescription => {
  if (cell.declaration === null) throw new Error(`${cell.name}: the server is not the service, thus the cell has no declaration to describe`);
  const redis = cell.declaration.redis;
  const client =
    redis === null
      ? undefined
      : redisClient("redis", { host: "redis", port: 6379, system: "systems.component.redis", knobs: redis.knobs, heartbeatMisses: redis.misses });
  return compose("lab", cell.declaration, { redis: client }).describe();
};
