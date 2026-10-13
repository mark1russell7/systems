// @mark1russell7/harness: a fault-injection harness for connection timers. A cell is a topology,
// its settings, a workload, a fault and a prediction. The harness runs it in new Docker
// environments that code builds (Testcontainers), measures on the one monotonic clock of the VM,
// and gives each cell a verdict.

export type {
  Cell,
  Client,
  Observer,
  Fault,
  KernelRecord,
  Prediction,
  ProbeEvent,
  Recovers,
  Reference,
  Run,
  Target,
} from "./cell.ts";
export type { Measured, Outcome } from "./observe.ts";
export { measure } from "./observe.ts";
export type { Decision, Interval, Verdict } from "./verdict.ts";
export { NOISE, RELATIVE, STEPS, medianInterval, verdictOf } from "./verdict.ts";
export type { FaultSide, Lab, Manifest, NetworkFault, Probe } from "./lab.ts";
export { harnessImage, nodeClientImage, openLab } from "./lab.ts";
export type { CellResult } from "./run.ts";
export { judge, runCell, spread } from "./run.ts";
