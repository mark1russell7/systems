import { describe, expect, it, vi } from "vitest";
import type { Rule } from "./index.ts";
import { DRAIN_RULE_IDS, lint, lintStop, service } from "./index.ts";

// The entry ./rules must not import Testcontainers or zod: a service imports it in its tests without
// kind and without a schema. Thus an import of either in this file fails.
vi.mock("testcontainers", () => {
  throw new Error("The entry ./rules imported testcontainers");
});
vi.mock("zod", () => {
  throw new Error("The entry ./rules imported zod");
});

const s = (value: number) => ({ value, unit: "s" });

/** This function gives a service with a hold of fail readiness and a drain of `drain` seconds. */
const declared = (hold: number, drain: number) =>
  service("svc")
    .readiness({ type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 })
    .liveness({ type: "window", failAfter: s(45) })
    .startup(s(60))
    .phase("fail readiness", s(hold))
    .phase("drain", s(drain))
    .onRepeatSignal("ignore")
    .cooperativeWindow(s(5))
    .describe();

/** This function gives a scenario of a pod: its grace, its preStop sleep, its probes and the propagation of the endpoints. */
const pod = (grace: number, preStop: number) => ({
  platform: { "termination_grace@pod": s(grace), "prestop_sleep@pod": s(preStop), "propagation_bound@cluster": s(1) },
  probes: { readiness: s(30), liveness: s(30) },
});

describe("the entry ./rules (SYS-32)", () => {
  it("imports no Testcontainers and no zod, and gives the four drain rules as data", async () => {
    const entry = await import("./rules.ts");
    expect(entry.DRAIN_RULES.map((rule: Rule) => rule.id)).toEqual(["O04", "O09", "O10", "O16"]);
    expect(entry.DRAIN_RULES.map((rule: Rule) => rule.id)).toEqual(DRAIN_RULE_IDS);
    // each rule tells the window that its violation opens
    for (const rule of entry.DRAIN_RULES) expect(rule.window, rule.id).toMatch(/\w/);
  });

  it("gives lint() the verdict of each drain rule", async () => {
    const { DRAIN_RULES } = await import("./rules.ts");
    const verdicts = (description: ReturnType<typeof declared>, grace: number, preStop: number) =>
      Object.fromEntries(lint(description, pod(grace, preStop), DRAIN_RULES).map((finding) => [finding.rule, finding.verdict]));
    // a hold of 2 s covers the propagation, and 10 s of drain fit in the grace of 30 s
    expect(verdicts(declared(2, 10), 30, 0)).toMatchObject({ O04: "holds", O10: "holds", O16: "holds" });
    // without a hold or a preStop sleep, new connections reach a closed listener
    expect(verdicts(declared(0, 10), 30, 0)).toMatchObject({ O04: "violated", O10: "holds" });
    // a drain of 40 s does not fit in the grace of 30 s
    expect(verdicts(declared(2, 40), 30, 0)).toMatchObject({ O04: "holds", O10: "violated", O16: "violated" });
  });

  it("gives lintStop() the rules of each way that a pod stops", async () => {
    const { DRAIN_RULES } = await import("./rules.ts");
    const rulesOf = (way: "deletion" | "liveness-restart" | "crash") =>
      lintStop(declared(2, 10), pod(30, 0), DRAIN_RULES, way)
        .map((finding) => finding.rule)
        .filter((id) => DRAIN_RULE_IDS.includes(id));
    expect(rulesOf("deletion")).toEqual(["O04", "O10", "O16"]);
    expect(rulesOf("liveness-restart")).toContain("O09");
    expect(rulesOf("crash")).toEqual([]);
  });
});
