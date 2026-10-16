// @systems/kind: Kubernetes in Docker as an environment of the systems program. A scenario gives
// the configuration of kind. The lab finds the namespace of a pod through its node, and the
// injector and the prober of the harness work there. Each observation is on the one monotonic clock
// of the VM, and the ordering law gives the predictions.

export type { ServiceRule } from "./backends.ts";
export { backendsOf } from "./backends.ts";
export type {
  Band,
  Declaration,
  KindCell,
  KindRun,
  KubeletProbe,
  PodSettings,
  Prediction,
  RedisDeclaration,
  Reference,
  Replica,
  Template,
  Trigger,
  TriggerKind,
  Workload,
} from "./cell.ts";
export type { Cluster, ClusterManifest, Credentials } from "./cluster.ts";
export { createCluster } from "./cluster.ts";
export type { Parts } from "./compose.ts";
export { CONTROLLER, FLAG_CHECK, ROUTE, WATCHDOG, compose } from "./compose.ts";
export type { FaultPlan, Step, Target } from "./faults.ts";
export { deletes, planOf } from "./faults.ts";
export { labImage, stageLabImage } from "./image.ts";
export type { KindLab, Line, Stamp } from "./lab.ts";
export { KEPT_KERNEL, localPin, openKindLab } from "./lab.ts";
export { HEALTH_PORT, PORT, REDIS_IMAGE, clientObjects, namespaceOf, probeOf, redisObjects, serverObjects } from "./manifests.ts";
export * from "./observe.ts";
export type { DeletionWindow, Propagation } from "./predict.ts";
export {
  DOCUMENTED,
  capOf,
  deletionWindow,
  intakeAfter,
  kubeletBand,
  latchBand,
  pausedWindow,
  removalBand,
  restartBand,
  showBand,
  stallRemovalBand,
} from "./predict.ts";
export type { Verdicts } from "./rules.ts";
export { DRAIN_RULES, O04, O09, O10, O16, describeCell, lintCell, scenarioOf, verdictsOf } from "./rules.ts";
export type { KindCellResult, LoadSample, RunOptions } from "./run.ts";
export { RULES_EVERY, estimateSeconds, runKindCells, shardOf, writeResult } from "./run.ts";
export type { KindConfig, KindScenario, KubeProxyMode, NodeImage } from "./scenario.ts";
export {
  KUBE_PROXY_MODES,
  NODE_IMAGES,
  cidrOverlap,
  cidrRange,
  goDuration,
  kindConfig,
  kubeProxyPatch,
  nodeNames,
  scenario,
  scenarioProblems,
} from "./scenario.ts";
export type { Judged, TimeSpread } from "./report.ts";
export { calibrationOf, cellsTable, medianText, predictionText, timeSpread } from "./report.ts";
export type { Tool } from "./tools.ts";
export { KIND, KUBECTL, cacheFolder, ensureTool, platformKey, sha256, toolPath } from "./tools.ts";
export type { KindDecision, KindVerdict, RunCheck } from "./verdict.ts";
export { KIND_NOISE, LAST_SLACK, checkRun, factsOf, judgeKind, propagationOf, referenceOf } from "./verdict.ts";
