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
  Recovers,
  Reference,
  Replies,
  RouterHop,
  Run,
  RunTopology,
  Target,
  Topology,
  Toxic,
} from "./cell.ts";
export type { Measured, Outcome, SocketPlace } from "./observe.ts";
export { measure, socketOf } from "./observe.ts";
export type { Decision, Interval, Verdict } from "./verdict.ts";
export { NOISE, RELATIVE, STEPS, medianInterval, verdictOf } from "./verdict.ts";
export type { Agent, FaultSide, Lab, Manifest, ManifestHop, NetworkFault, Probe } from "./lab.ts";
export {
  LISTING,
  PUMP,
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
