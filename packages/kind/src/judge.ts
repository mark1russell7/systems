// @mark1russell7/kind/judge: the part of the package that reads the raw record of a kind cell and
// judges it again. It holds the types and the schemas of the record, the upgrade from the format
// `/1`, the verdict and the report. It loads no Docker, no Testcontainers, no child process and no
// `node:` module, thus a program that only reads records can use it, in a browser too.

export type { CountBand } from "./bands.ts";
export { backlogEnd, bandOf, requestBand, seconds, secondsOf, showBand } from "./bands.ts";
export type {
  BacklogTerm,
  Band,
  Cycle,
  Declaration,
  EdgeProtocol,
  Flap,
  KindCell,
  KindRun,
  KubeletProbe,
  Mesh,
  MeshFlavor,
  MeshMode,
  NonePrediction,
  PodSettings,
  Prediction,
  RedisDeclaration,
  Reference,
  Replica,
  ResetReuse,
  Stack,
  Template,
  Trigger,
  TriggerKind,
  WindowPrediction,
  Workload,
} from "./cell.ts";
export { CLIENT, HEALTH_PORT, LOG_LABEL, PORT, REDIS, SERVER } from "./names.ts";
export * from "./observe.ts";
export type {
  BandV1,
  ClusterManifest,
  EnvironmentManifest,
  KindCellRecord,
  KindCellRecordV1,
  KindCellResult,
  KindCellV1,
  KindVerdictV1,
  LoadSample,
  PredictionV1,
  RunCheckV1,
  RunFactsV1,
  TriggerV1,
} from "./record.ts";
export { FORMAT, FORMAT_V1, judge, upgrade, upgradeCell } from "./record.ts";
export type { Judged, TimeSpread } from "./report.ts";
export { calibrationOf, cellsTable, medianText, predictionText, timeSpread } from "./report.ts";
export type { Dataplane, KubeProxyMode } from "./scenario.ts";
export { STAGES, kindCellRecordSchema, kindCellRecordV1Schema, readRecord } from "./schema.ts";
export { RELATIVE, medianInterval, middle, quantileOf } from "./stats.ts";
export type { Deleted, KindDecision, KindVerdict, Propagated, RunCheck, RunFacts } from "./verdict.ts";
export {
  KIND_NOISE,
  LAST_SLACK,
  checkRun,
  cyclesOf,
  deletionsOf,
  factsOf,
  judgeKind,
  observationAfter,
  observationEnd,
  propagationOf,
  propagationSource,
  referenceOf,
  reusesReset,
  unitOf,
  updatesOf,
} from "./verdict.ts";
