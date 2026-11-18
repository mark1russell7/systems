// @mark1russell7/automata: state machines as data, and the timer algebra over them. A machine
// document gives the states, transitions, timers and knobs of one machine. The algebra gives the
// closed forms of its timers in exact rationals, the detection of a failure as the first live
// timer, and the recovery after a stall. `replay` finds each transition of a trace that a document
// does not permit. Its entry "@mark1russell7/automata/replay" does not import zod. `runMachine`
// operates a live instance of a document on a clock. Its entry "@mark1russell7/automata/run" does
// not import zod.
//
// This entry does not import zod either. The schema of a machine document, `machineSchema`, is in
// the entry "@mark1russell7/automata/schema".

export type {
  Expr,
  Machine,
  Over,
  Realization,
  Timer,
  TransitionDef,
  Unit,
  Vantage,
} from "./machine.ts";
export {
  FIRED,
  arr,
  exprKnobs,
  fromStates,
  machineProblems,
  readsFired,
} from "./machine.ts";
export { acceptQueueHeld, acceptQueueLimit } from "./accept-queue.ts";
export { conntrackFloor } from "./conntrack.ts";
export type {
  EgressOutcome,
  EgressPacket,
  NetemQueue,
  NetemRate,
  PschedFactor,
  PschedRate,
  TbfBuckets,
  TbfPeak,
  TbfQueue,
} from "./egress.ts";
export {
  fifoDefaultLimit,
  gsoQdiscLength,
  netemPacketTime,
  netemSchedule,
  pschedFactor,
  pschedLengthTime,
  tbfBuckets,
  tbfSchedule,
  udpFrameLength,
} from "./egress.ts";
export type { MemcgLevel, MemcgSleepBounds, MemcgThrottle, OomTask } from "./memcg.ts";
export {
  memcgHighDelay,
  memcgHighSleep,
  memcgSleepBounds,
  memcgThrottle,
  oomBadness,
  oomVictim,
} from "./memcg.ts";
export { PORT_SEARCH_CHAIN_LARGEST, portSearchChain, portSearchShares, portSearchSpan } from "./port-search.ts";
export type { Replayable, ReplayOptions, Transition } from "./replay.ts";
export { replay } from "./replay.ts";
export type { MachineRun, RunMachineOptions } from "./run.ts";
export { runMachine } from "./run.ts";
export type {
  Band,
  Detection,
  Detector,
  Firing,
  KnobValues,
  Manifestation,
  Node,
  Recovery,
  Scheduled,
  ScheduleOptions,
  Situation,
  TimerBounds,
} from "./algebra.ts";
export {
  algebraProblems,
  detection,
  errnoOf,
  evaluate,
  firings,
  modelSource,
  overValues,
  parseExpr,
  probeTrain,
  realizationKnobs,
  realizationOf,
  recovery,
  stackedDetection,
  synGiveUpSends,
  timerBand,
  timerOf,
  timerUnder,
  transitionOn,
} from "./algebra.ts";
