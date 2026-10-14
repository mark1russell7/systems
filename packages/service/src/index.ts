// @mark1russell7/service: the service abstraction. A service is composed with plain calls,
// exported as data with nothing started, and checked against the timer-ordering law before it
// starts. `start()` gives the composed graph to the health runtime: each check on its own
// jittered loop, a latch for each policy, and probes that answer from the cache. The lifecycle
// and the drain come in a later release. The seams for tests are in `@mark1russell7/service/testing`.

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
