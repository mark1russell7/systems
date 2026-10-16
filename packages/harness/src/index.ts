// @mark1russell7/harness: a fault-injection harness for connection timers. A cell is a topology,
// its settings, a workload, a fault and a prediction. The harness runs it in new Docker
// environments that code builds (Testcontainers), measures on the one monotonic clock of the VM,
// and gives each cell a verdict. A topology is a chain of hops, or a replicated group under its
// Sentinels.

export type {
  Cell,
  Client,
  ClientImage,
  FaultPlace,
  Group,
  GroupPlace,
  GroupPrediction,
  GroupRole,
  Hop,
  HopPlace,
  MiddleboxEvent,
  MiddleboxExpectation,
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
  RunGroup,
  RunPart,
  RunTopology,
  SentinelEvent,
  Stage,
  StageBand,
  Target,
  Topology,
  Toxic,
} from "./cell.ts";
export { isHopPlace } from "./cell.ts";
export type { Crossings, Measured, Outcome, Reordering, SocketPlace } from "./observe.ts";
export { crossingsOf, measure, reorderingOf, socketOf } from "./observe.ts";
export type { ErrorOnTheWay, GroupMeasured, GroupReading, Writes } from "./timeline.ts";
export { STAGES, errorsOf, lagsOf, measureGroup, stagesOf, writesOf } from "./timeline.ts";
export type { Decision, GroupVerdict, Interval, Spread, StageVerdict, Verdict } from "./verdict.ts";
export { NOISE, RELATIVE, STEPS, groupVerdictOf, medianInterval, quantileOf, spreadOf, verdictOf } from "./verdict.ts";
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
export type { GroupClient, GroupLab, GroupNetworkFault, GroupView, Stamp } from "./group.ts";
export {
  CONVERGE_MS,
  deadlineOf,
  fieldsOf,
  groupOnce,
  infoOf,
  memberConfig,
  openGroupLab,
  peersOf,
  sentinelConfig,
  subscriptionsOf,
  viewOf,
} from "./group.ts";
export type { CellResult } from "./run.ts";
export { judge, runCell, spread } from "./run.ts";
