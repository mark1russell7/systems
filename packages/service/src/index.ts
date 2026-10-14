// @mark1russell7/service: the service abstraction. A service is composed with plain calls,
// exported as data with nothing started, and checked against the timer-ordering law before it
// starts. `start()` gives the composed graph to the health runtime: each check on its own
// jittered loop, a latch for each policy, and probes that answer from the cache. `run()` runs the
// whole lifecycle: the startup in its sequence, the exit signals, the capped phases of the drain,
// and the exit. Its machines are documents (`machines.ts`). The seams for tests, and the contract
// test of a declaration, are in `@mark1russell7/service/testing`.

export type { Timing, Poll, Span, FailsBy } from "./timing.ts";
export { asDebounce, asWindow, failSpan, recoverSpan } from "./timing.ts";
export type {
  Check,
  Controller,
  Coupling,
  Dependency,
  Gate,
  Phase,
  ServiceDescription,
  Step,
  Transport,
} from "./description.ts";
export { FORMAT } from "./description.ts";
export type { Idempotency, Operation } from "./operation.ts";
export { mayReissue } from "./operation.ts";
export type { ControllerBuilder, ServiceBuilder } from "./builder.ts";
export { service } from "./builder.ts";
export type { Binding, Bound, Evaluated, Inequality, Rule, Side, Term, Verdict } from "./law.ts";
export { evaluate, inequalities, symbolsOf, verdictOf } from "./law.ts";
export type { Finding, Scenario } from "./lint.ts";
export { SERVICE_RULES, lint, serviceBindings } from "./lint.ts";
export type { Cancel, Clock } from "./clock.ts";
export { realClock } from "./clock.ts";
export type { Outcome, Result } from "./latch.ts";
export type { CheckFn } from "./poller.ts";
export type {
  CheckVerdict,
  Health,
  HealthVerdict,
  ProbeAnswer,
  ProbeKind,
  StartOptions,
} from "./health.ts";
export type { LifecycleEvent, MachineName, Recorder } from "./events.ts";
export type {
  DependencyHandle,
  HealthServer,
  Lifecycle,
  LifecycleState,
  PhaseContext,
  PhaseWork,
  RunOptions,
  Stage,
  TransportImpl,
} from "./lifecycle.ts";
export { STAGES, cooperativeAbortAt, stageRank } from "./lifecycle.ts";
export type { ExitSignal, ProcessPort } from "./process.ts";
export { EXIT_SIGNALS, nodeProcess } from "./process.ts";
export type { RequestFn, RequestOutcome } from "./requests.ts";
export type { Watchdog, WatchdogSpec } from "./watchdog.ts";
export { watchdog } from "./watchdog.ts";
export {
  EXIT_MACHINE,
  GATE_MACHINE,
  LATCH_MACHINE,
  MACHINES,
  POLLER_MACHINE,
  WATCHDOG_MACHINE,
  WINDOW_MACHINE,
  capKnob,
  drainMachine,
  replay,
} from "./machines.ts";
