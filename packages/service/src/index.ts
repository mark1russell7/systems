// @mark1russell7/service: the service abstraction. A service is composed with plain calls,
// exported as data with nothing started, and checked against the timer-ordering law before it
// starts. `start()` gives the composed graph to the health runtime: each check on its own
// jittered loop, a latch for each policy, and probes that answer from the cache. `run()` runs the
// whole lifecycle: the startup in its sequence, the exit signals, the capped phases of the drain,
// and the exit. Its machines are documents (`machines.ts`). The seams for tests, and the contract
// test of a declaration, are in `@mark1russell7/service/testing`.

export type { Timing, Poll, Span, FailsBy } from "./timing.ts";
export { asDebounce, asWindow, failSpan, heartbeatDetection, recoverSpan } from "./timing.ts";
export type {
  Check,
  Controller,
  CooperativeFloor,
  Coupling,
  Dependency,
  ExitCodes,
  Gate,
  Phase,
  RepeatSignal,
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
export type { Cancel, Clock, PlatformClockOptions } from "./clock.ts";
export { platformClock, realClock } from "./clock.ts";
export type { Heartbeat, HeartbeatOptions } from "./heartbeat.ts";
export { detectionTime, heartbeat } from "./heartbeat.ts";
export type { Backoff, DelayBand, Jitter } from "./backoff.ts";
export { backoffBand, backoffDelay, backoffProblems } from "./backoff.ts";
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
  ShutdownOptions,
  Stage,
  TransportImpl,
} from "./lifecycle.ts";
export { STAGES, cooperativeAbortAt, stageRank } from "./lifecycle.ts";
export type { ExitSignal, ExitTrigger, HostStream, ProcessHost, ProcessPort, ProcessTrigger } from "./process.ts";
export { EXIT_SIGNALS, PROCESS_TRIGGERS, isExitCode, isExitSignal, nodeProcess, processPortOf } from "./process.ts";
export type { PodTiming, Profile } from "./profiles.ts";
export { ephemeral, kubernetes, localDev } from "./profiles.ts";
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
} from "./machines.ts";
// the replay of a trace moved to @mark1russell7/algebra, with open machine names: this export keeps it for the users of 0.3
export { replay } from "@mark1russell7/algebra/replay";
