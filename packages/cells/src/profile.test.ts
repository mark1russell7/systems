import { kubernetes } from "@mark1russell7/service";
import { describe, expect, it } from "vitest";
import { DESIGN, DESIGN_PHASES, kubeDefaults } from "./kind.ts";

/**
 * SYS-10: the phases of the design of the kind cells are the profile `kubernetes` of the service at
 * the defaults of Kubernetes. Thus the composition of a cell can take its phases from the profile,
 * and `describe()` shows the same values.
 */
describe("the design of the kind cells is the profile kubernetes of the service", () => {
  it("gives the same caps and the same cooperative window at a grace of 30 s and no preStop hook", () => {
    const pod = kubeDefaults(2);
    const profile = kubernetes({ grace: pod.grace, preStop: pod.preStop });
    expect(profile.phases!.map((phase) => [phase.name, phase.cap])).toEqual(DESIGN_PHASES.map(([name, cap]) => [name, cap]));
    expect(profile.cooperativeWindow).toEqual(DESIGN.cooperativeWindow);
  });
});
