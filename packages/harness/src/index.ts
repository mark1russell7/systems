// @mark1russell7/harness: a fault-injection harness for connection timers. A cell is a topology,
// its settings, a workload, a fault and a prediction. The harness runs it in new Docker
// environments that code builds (Testcontainers), measures on the one monotonic clock of the VM,
// and gives each cell a verdict. A topology is a chain of hops, a replicated group under its
// Sentinels, or a replica set whose members elect their own primary. A program with its own
// detector, a WebSocket heartbeat, writes lines that the kernel stamps.

export type {
  Cell,
  Client,
  ClientImage,
  DriverBand,
  DriverStep,
  FaultPlace,
  Group,
  GroupPlace,
  GroupPrediction,
  GroupRole,
  HarnessImage,
  Hop,
  HopPlace,
  HttpProbe,
  LineMatch,
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
  Reconnects,
  Recovers,
  Reference,
  Replies,
  ReplicaSet,
  ReplicaSetStage,
  RouterHop,
  RequestPrediction,
  RttRange,
  Run,
  RunGroup,
  RunPart,
  RunTopology,
  SentinelEvent,
  SentinelStage,
  Stage,
  StageBand,
  Target,
  Topology,
  Toxic,
  WsProbe,
} from "./cell.ts";
export { isHopPlace } from "./cell.ts";
export type { CallReading, ProgramEvent, ReconnectReading } from "./application.ts";
export { callOf, dropOf, firstUnanswered, pingsOf, programLines, reconnectFinding, reconnectOf } from "./application.ts";
export type { Crossings, Measured, Outcome, Reordering, RequestReading, SocketPlace } from "./observe.ts";
export { crossingsOf, measure, reorderingOf, requestOf, socketOf } from "./observe.ts";
export type { DriverSocket, DriverStepTime } from "./driver.ts";
export { fieldOf, matches, measureDriver, referenceOf, socketAt, socketsOf } from "./driver.ts";
export type { ErrorOnTheWay, GroupMeasured, GroupReading, Writes } from "./timeline.ts";
export {
  MEMBER_MARKS,
  REPLICA_SET_STAGES,
  STAGES,
  errorsOf,
  lagsOf,
  measureGroup,
  replicaSetStagesOf,
  stagesOf,
  writesOf,
} from "./timeline.ts";
export type { Decision, GroupVerdict, Interval, ReconnectVerdict, Spread, StageVerdict, Verdict } from "./verdict.ts";
export { NOISE, RELATIVE, STEPS, groupVerdictOf, medianInterval, quantileOf, requestWords, spreadOf, verdictOf } from "./verdict.ts";
export type { Agent, FaultSide, Lab, Manifest, ManifestHop, NetworkFault, Probe } from "./lab.ts";
export {
  LISTING,
  PUMP,
  deviceOf,
  endpointAfter,
  goHttpImage,
  harnessImage,
  mongoClientImage,
  nodeClientImage,
  nodeHttpImage,
  openLab,
  proceduresImage,
  routerImage,
  routesOf,
  targetImageOf,
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
export type { Cut, MemberLine, ReplicaSetLab, Status } from "./replset.ts";
export {
  KEPT,
  STATUS_SCRIPT,
  STEP_DOWN,
  clockOffsetOf,
  cutOf,
  initiateScript,
  memberCommand,
  memberLineOf,
  onMonotonic,
  openReplicaSetLab,
  replicaSetArgs,
  replicaSetOnce,
  statusViewOf,
} from "./replset.ts";
export type { CellResult } from "./run.ts";
export { LINGER_MS, QUIET_MS, judge, runCell, spread } from "./run.ts";
