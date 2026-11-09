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
  ClientCapability,
  ClientImage,
  Cluster,
  Kafka,
  KafkaPause,
  PauseBand,
  PausePrediction,
  RunPause,
  ClusterClientAt,
  ClusterStage,
  DriverBand,
  DriverStep,
  FaultPlace,
  Group,
  GroupPlace,
  GroupPrediction,
  GroupRole,
  Fabric,
  FabricManifest,
  Hop,
  HopEvent,
  HopPlace,
  HopSignal,
  HopWrite,
  HttpProbe,
  Jitter,
  ImageSource,
  LineCount,
  LineMatch,
  MiddleboxEvent,
  MiddleboxExpectation,
  MiddleboxForm,
  Observer,
  Outcomes,
  Pair,
  CountBand,
  Fault,
  PinnedImage,
  KernelRecord,
  Prediction,
  ConntrackPrediction,
  HostSysctl,
  LoadBand,
  LoadPlan,
  LoadStream,
  LoadPrediction,
  PortsPrediction,
  ProbeEvent,
  ProxyHop,
  ProxyTime,
  QueueBand,
  QueueConnection,
  QueueEnd,
  QueuePrediction,
  Reconnects,
  Recovers,
  Reference,
  Replies,
  Drill,
  ReplicaSet,
  ReplicaSetStage,
  RouterHop,
  RequestPrediction,
  RttRange,
  Run,
  RunBackup,
  RunDrill,
  DrillRoom,
  RunGroup,
  RunPart,
  RunFabric,
  RunRoute,
  RunStream,
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
export { CLIENT_CAPABILITIES, environmentProblems, isHopPlace, latestEndOf } from "./cell.ts";
export type { CallReading, ProgramEvent, ReconnectReading } from "./application.ts";
export {
  DROP_HANDLING,
  callOf,
  closeOrExit,
  dropFinding,
  dropOf,
  exitOf,
  firstUnanswered,
  jitterOfLines,
  leftAfter,
  pingsOf,
  programLines,
  reconnectFinding,
  reconnectOf,
} from "./application.ts";
export type { EstimateVerdict, LoadJudgement, LoadSpread, LoadVerdict, RunEstimate, RunLoad } from "./load.ts";
export { CLOSED_TOLERANCE, LOAD_FORMAT, LOAD_PATH, SCHEDULE_PATH, estimateOf, estimateVerdict, loadOf, loadPlanOf, loadVerdict, poolOf, streamsLoadOf } from "./load.ts";
export type { Crossings, Measured, Outcome, Reordering, RequestReading, SocketPlace } from "./observe.ts";
export { crossingsOf, jitterOf, measure, reorderingOf, requestOf, socketOf } from "./observe.ts";
export type { ConntrackReading, StallReading } from "./conntrack.ts";
export { measureConntrack } from "./conntrack.ts";
export type { PortsReading } from "./ports.ts";
export { measurePorts } from "./ports.ts";
export type { QueueConnectionReading, QueueReading } from "./queue.ts";
export { measureQueue } from "./queue.ts";
export type { DriverSocket, DriverStepTime } from "./driver.ts";
export { fieldOf, matches, measureDriver, referenceOf, socketAt, socketsOf } from "./driver.ts";
export type { ErrorOnTheWay, GroupMeasured, GroupReading, PairSets, Writes } from "./timeline.ts";
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
export type { Decision, GroupVerdict, Interval, Pairing, ReconnectVerdict, Spread, StageVerdict, TimeFromFault, Verdict } from "./verdict.ts";
export {
  INJECT,
  NOISE,
  RELATIVE,
  STEPS,
  commitVoid,
  delayVoids,
  groupVerdictOf,
  medianInterval,
  noiseOf,
  pairingOf,
  pairingsOf,
  quantileOf,
  requestWords,
  spreadOf,
  verdictOf,
} from "./verdict.ts";
export type { Agent, FaultSide, HostSetting, Lab, Manifest, ManifestHop, NetworkFault, Probe, Sibling } from "./lab.ts";
export { LISTING, PUMP, PUMP_SLACK, buildOf, deviceOf, endpointAfter, harnessRecord, hzOf, openLab, routesOf, shippedClientRecord, templated, toxicBody } from "./lab.ts";
export { INSERT, RESTART, STANDBY_READY, cancelsOf, numbersOf, openStandby, pairArgs, pairOnce, standbyCommand } from "./standby.ts";
export type { ClockPair, FabricLab, FabricParts, LeafViews, RouteLine } from "./fabric.ts";
export {
  DAEMONS,
  FABRIC_CLIENT,
  FABRIC_DEVICE,
  FABRIC_TARGET,
  FRR_IMAGE,
  ROUTERS,
  frrConf,
  laterMove,
  leafLacks,
  monotonicAt,
  openFabric,
  routeLine,
  sessionsOf,
  topologyOf,
} from "./fabric.ts";
export type { Cloud, Host, Layer, Substrate, SubstrateSource } from "./substrate.ts";
export { AWS_FROM, CLOUDS, LAYERS, cloudOf, comparable, readCpu, readHost, stealShare, substrateHere, substrateKey, substrateOf, substrateOn, unpoolable } from "./substrate.ts";
export type { BuildRecord, ImagePlan } from "./image.ts";
export type { ContextFile } from "./locks.ts";
export { LOCK_NAMES, cargoVersions, goVersions, jarVersions, locksOf, npmVersions, versionsOf } from "./locks.ts";
export type { Pinnable, RecordCode } from "./pins.ts";
export { commitProblems, DEBUG, DIRTY, imagePinProblems, manifestProblems, recordProblems } from "./pins.ts";
export {
  CLIENT_NAMES,
  PINNED,
  REPOSITORY,
  SHIPPED_CLIENTS,
  SHIPPED_NAMES,
  amqpClientImage,
  basesOf,
  buildRecordOf,
  goHttpImage,
  grpcClientImage,
  harnessImage,
  harnessVersion,
  imageOf,
  imageProblems,
  inContext,
  mongoClientImage,
  nodeClientImage,
  nodeHttpImage,
  pgClientImage,
  hikariClientImage,
  kafkaClientImage,
  planOf,
  programOf,
  routerImage,
  shippedSource,
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
export { drillOnce } from "./drill.ts";
export type { OplogRead, OplogTime, RecoveryMeasured } from "./recovery.ts";
export {
  HASH_SCRIPT,
  LOSS_MARGIN,
  SEED_DOCUMENT,
  drillSpan,
  hashOf,
  highestHeld,
  memAvailableOf,
  readOplog,
  recoveryFindings,
  recoveryOf,
  roomNeeded,
  roomVoidOf,
  seedScript,
  sliceQuery,
  standaloneCommand,
  stopScript,
} from "./recovery.ts";
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
  GIVES_AWAY,
  MONITOR_DOWN,
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
  plainOf,
  restamped,
  toolJsonOf,
} from "./cluster.ts";
export type { KafkaLab, KafkaMember, PartitionView } from "./kafka.ts";
export {
  KAFKA_TAIL_MS,
  bootstrapOf,
  brokerEnv,
  controllerEnv,
  envOf,
  kafkaArgs,
  kafkaCutOf,
  kafkaOnce,
  kafkaPauseOnce,
  kafkaViewOf,
  nodeIdOf,
  openKafkaLab,
  topicOf,
} from "./kafka.ts";
export type { PauseCommit, PauseReading } from "./pause.ts";
export { isFenceLine, logTimeOf, measurePause, namesGroup, pauseReady } from "./pause.ts";
export type { CellResult } from "./run.ts";
export { LINGER_MS, QUIET_MS, environmentCounts, judge, runCell, spread } from "./run.ts";
