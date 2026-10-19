// @mark1russell7/harness: a fault-injection harness for connection timers. A cell is a topology,
// its settings, a workload, a fault and a prediction. The harness runs it in new Docker
// environments that code builds (Testcontainers), measures on the one monotonic clock of the VM,
// and gives each cell a verdict. A topology is a chain of hops, a replicated group under its
// Sentinels, a replica set whose members elect their own primary, or a cluster of RabbitMQ whose
// quorum queue elects its leader. A program with its own
// detector, a WebSocket heartbeat, writes lines that the kernel stamps. The subject of a cell is
// data: an image pinned by digest, a build context, or an image that the harness ships.

export type {
  BuildImage,
  Cell,
  Client,
  ClientImage,
  Cluster,
  ClusterClientAt,
  ClusterStage,
  DriverBand,
  DriverStep,
  FaultPlace,
  Group,
  GroupPlace,
  GroupPrediction,
  GroupRole,
  HarnessImage,
  Hop,
  HopEvent,
  HopPlace,
  HttpProbe,
  ImageSource,
  LineMatch,
  MiddleboxEvent,
  MiddleboxExpectation,
  MiddleboxForm,
  Observer,
  Fault,
  PinnedImage,
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
  Shipped,
  ShippedImage,
  Stage,
  StageBand,
  Subject,
  Target,
  Topology,
  Toxic,
  WsProbe,
} from "./cell.ts";
export { isHopPlace, latestEndOf } from "./cell.ts";
export type { CallReading, ProgramEvent, ReconnectReading } from "./application.ts";
export {
  callOf,
  closeOrExit,
  dropFinding,
  dropOf,
  exitOf,
  firstUnanswered,
  leftAfter,
  pingsOf,
  programLines,
  reconnectFinding,
  reconnectOf,
} from "./application.ts";
export type { Crossings, Measured, Outcome, Reordering, RequestReading, SocketPlace } from "./observe.ts";
export { crossingsOf, measure, reorderingOf, requestOf, socketOf } from "./observe.ts";
export type { DriverSocket, DriverStepTime } from "./driver.ts";
export { fieldOf, matches, measureDriver, referenceOf, socketAt, socketsOf } from "./driver.ts";
export type { ErrorOnTheWay, GroupMeasured, GroupReading, Writes } from "./timeline.ts";
export {
  CLUSTER_STAGES,
  MEMBER_MARKS,
  NODE_MARKS,
  REPLICA_SET_STAGES,
  STAGES,
  errorsOf,
  lagsOf,
  clusterStagesOf,
  measureGroup,
  replicaSetStagesOf,
  stagesOf,
  writesOf,
} from "./timeline.ts";
export type { Decision, GroupVerdict, Interval, ReconnectVerdict, Spread, StageVerdict, Verdict } from "./verdict.ts";
export { INJECT, NOISE, RELATIVE, STEPS, delayVoids, groupVerdictOf, medianInterval, noiseOf, quantileOf, requestWords, spreadOf, verdictOf } from "./verdict.ts";
export type { Agent, FaultSide, Lab, Manifest, ManifestHop, NetworkFault, Probe } from "./lab.ts";
export { LISTING, PUMP, PUMP_SLACK, deviceOf, endpointAfter, hzOf, openLab, routesOf, templated, toxicBody } from "./lab.ts";
export type { ImagePlan } from "./image.ts";
export {
  CLIENT_NAMES,
  PINNED,
  REPOSITORY,
  SHIPPED_CLIENTS,
  SHIPPED_NAMES,
  SUBJECTS,
  amqpClientImage,
  goHttpImage,
  harnessImage,
  imageOf,
  imageProblems,
  inContext,
  mongoClientImage,
  nodeClientImage,
  nodeHttpImage,
  pgClientImage,
  hikariClientImage,
  planOf,
  proceduresImage,
  programOf,
  routerImage,
  subjectClient,
  subjectProblems,
  targetImageOf,
  targetSourceOf,
  unlockedManifests,
  unpinnedBases,
} from "./image.ts";
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
export type { ClusterLab, NodeLine, StatusRow, WallStamp } from "./cluster.ts";
export {
  clusterArgs,
  clusterConf,
  clusterCutOf,
  clusterHostsOf,
  clusterOnce,
  clusterViewOf,
  logNameOf,
  monotonicOf,
  nodeCommand,
  nodeLineOf,
  nodeNameOf,
  nodesOnMonotonic,
  openClusterLab,
} from "./cluster.ts";
export type { CellResult } from "./run.ts";
export { LINGER_MS, QUIET_MS, judge, runCell, spread } from "./run.ts";
