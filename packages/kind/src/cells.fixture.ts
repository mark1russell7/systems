import type { Declaration, KindCell, KubeletProbe, TriggerKind } from "./cell.ts";

/** This module holds a declaration and a cell for the tests of this package. */

const s = (value: number) => ({ value, unit: "s" });

/** This probe is the default of Kubernetes. */
export const KUBE_PROBE: KubeletProbe = { period: s(10), threshold: 3, timeout: s(1) };
const PROBE = KUBE_PROBE;

/** This declaration is the health design, without Redis. */
export const DESIGN: Declaration = {
  poll: { interval: s(5), jitter: 0.2, timeout: s(4) },
  readiness: { type: "debounce", interval: s(5), failAfter: 3, recoverAfter: 1 },
  liveness: { type: "window", failAfter: s(45) },
  startup: s(60),
  phases: [
    ["fail readiness", s(2)],
    ["stop intake", s(5)],
    ["drain", s(15)],
    ["close transports", s(2)],
    ["stop the poller", s(1)],
    ["tear down dependencies", s(2)],
    ["close the health server", s(1)],
  ],
  cooperativeWindow: s(5),
  couplings: [{ from: "liveness", to: "readiness", effect: "fails" }],
  redis: null,
  flag: null,
  watchdog: { tick: s(1), threshold: s(2) },
};

/** This function gives a T07 or T18 cell of a trigger, with the defaults of Kubernetes. */
export const cellOf = (kind: TriggerKind, declaration: Declaration = DESIGN, template: "T07" | "T18" = "T07"): KindCell => ({
  id: "T07.defaults.1",
  name: `a test cell, ${kind}`,
  template,
  substitutes: null,
  mode: "iptables",
  workers: 2,
  trigger: { kind, hold: s(5), lead: s(0.5), cpuMax: { quota: 1000, period: 1_000_000 } },
  pod: { replicas: 2, grace: s(30), preStop: s(0), readiness: PROBE, liveness: PROBE, startup: null },
  declaration,
  workload: { every: { value: 20, unit: "ms" }, timeout: s(1) },
  prediction: { kind: "none", why: "a test" },
  calibrates: false,
  runs: 11,
});
