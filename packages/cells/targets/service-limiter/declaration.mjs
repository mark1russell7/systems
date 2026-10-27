// The declaration of the target, and its check with lint() of @mark1russell7/service. server.mjs
// checks its declaration before it listens. src/limiter.test.ts checks the declaration of each cell
// on the service of the workspace.

import { LIMITER_RULES, lint, service } from "@mark1russell7/service";

const count = (value) => ({ value, unit: "count" });
const s = (value) => ({ value, unit: "s" });

/** This is the name of the one limiter of the target. */
export const LIMITER = "calls";

/**
 * This function gives the spec of the limiter from the flags of the server. A token bucket has its
 * rate in count/s. A sliding window has its window in ms. Each request has its key in the header
 * x-limiter-key.
 */
export const specOf = ({ policy, limit, windowMs, ratePerS, burst, maxKeys }) => ({
  key: "x-limiter-key",
  policy:
    policy === "token-bucket"
      ? { type: "token-bucket", rate: { value: ratePerS, unit: "count/s" }, burst: count(burst) }
      : { type: "sliding-window", limit: count(limit), window: { value: windowMs, unit: "ms" } },
  store: { kind: "local" },
  evict: { maxKeys: count(maxKeys) },
});

/**
 * This function gives the description of the target: a service with one keyed limiter. describe()
 * has no defaults. Thus the declaration also gives the policies and the shutdown that it needs.
 * The target starts none of them, and LIMITER_RULES read only the limiter.
 */
export const declarationOf = (spec) =>
  service("service-limiter")
    .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(45) })
    .startup(s(60))
    .phase("drain", s(10))
    .cooperativeWindow(s(2))
    .onRepeatSignal("ignore")
    .limiter(LIMITER, spec)
    .describe();

/**
 * This function gives the longest Retry-After of a policy in whole seconds, for a refusal and for
 * a new key at the cap of keys. A token bucket refuses for one interval at most, and its idle span
 * is burst / rate. A sliding window refuses for one window at most, and its idle span is one window.
 */
const longestOf = (policy) =>
  policy.type === "token-bucket"
    ? { refusal: Math.ceil(1 / policy.rate.value), cap: Math.ceil(policy.burst.value / policy.rate.value) }
    : { refusal: Math.ceil(policy.window.value / 1000), cap: Math.ceil(policy.window.value / 1000) };

/** This scenario gives no callers. The client of a cell is the caller, and the target does not know it. */
const SCENARIO = { platform: {}, probes: { readiness: s(30), liveness: s(30) } };

/**
 * This function lints the description of the target with O29 and O30, and gives each finding and
 * each problem. O29 and O30 compare the limiter with its caller, and the scenario has no callers.
 * Thus each rule gives `depends`, and `unbound` names the symbol of the caller. The side of the
 * limiter is bound: the longest Retry-After, also at the cap of keys. Each other finding is a
 * problem, for example a `violated` finding of NAME_RULE or a finding of the declaration.
 */
export const lintTarget = (spec) => {
  const findings = lint(declarationOf(spec), SCENARIO, LIMITER_RULES).map((finding) => ({
    rule: finding.rule,
    scope: finding.scope,
    verdict: finding.verdict,
    unbound: finding.unbound,
    // the side of the limiter: the left side of O29, and the right side of O30
    limiter: finding.evaluated.map((each) => (finding.rule === "O30" ? each.rhs : each.lhs)),
  }));
  const { refusal, cap } = longestOf(spec.policy);
  const expected = [
    { rule: "O29", scope: LIMITER, verdict: "depends", unbound: ["client_retry_window@caller"], limiter: [refusal, cap] },
    { rule: "O30", scope: LIMITER, verdict: "depends", unbound: ["retry_delay@caller"], limiter: [refusal] },
  ];
  const problems =
    JSON.stringify(findings) === JSON.stringify(expected)
      ? []
      : [`lint() gives ${JSON.stringify(findings)}, and the target expects ${JSON.stringify(expected)}`];
  return { findings, problems };
};
