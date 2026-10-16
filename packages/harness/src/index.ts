// @mark1russell7/harness: a fault-injection harness for connection timers. A cell is a topology,
// its settings, a workload, a fault and a prediction. The harness runs it in new Docker
// environments that code builds (Testcontainers), measures on the one monotonic clock of the VM,
// and gives each cell a verdict.

export type {
  Cell,
  Client,
  ClientImage,
  FaultPlace,
  Hop,
  MiddleboxEvent,
  MiddleboxForm,
  Observer,
  Fault,
  KernelRecord,
  Prediction,
  ProbeEvent,
  ProxyHop,
  ProxyTime,
  Recovers,
  Reference,
  Replies,
  RouterHop,
  RttRange,
  Run,
  RunTopology,
  Target,
  Topology,
  Toxic,
} from "./cell.ts";
export type { Crossings, Measured, Outcome, Reordering, SocketPlace } from "./observe.ts";
export { crossingsOf, measure, reorderingOf, socketOf } from "./observe.ts";
export type { Decision, Interval, Spread, Verdict } from "./verdict.ts";
export { NOISE, RELATIVE, STEPS, medianInterval, quantileOf, spreadOf, verdictOf } from "./verdict.ts";
export type { Agent, FaultSide, Lab, Manifest, ManifestHop, NetworkFault, Probe } from "./lab.ts";
export {
  LISTING,
  PUMP,
  deviceOf,
  endpointAfter,
  harnessImage,
  nodeClientImage,
  openLab,
  routerImage,
  routesOf,
  templated,
  toxicBody,
} from "./lab.ts";
export type { CellResult } from "./run.ts";
export { judge, runCell, spread } from "./run.ts";
