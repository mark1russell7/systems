// @mark1russell7/algebra: state machines as data, and the timer algebra over them. A machine
// document gives the states, transitions, timers and knobs of one machine. The algebra gives the
// closed forms of its timers in exact rationals, the detection of a failure as the first live
// timer, and the recovery after a stall. `replay` finds each transition of a trace that a document
// does not permit. Its entry "@mark1russell7/algebra/replay" does not import zod.

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
  machineSchema,
  readsFired,
} from "./machine.ts";
export type { Replayable, ReplayOptions, Transition } from "./replay.ts";
export { replay } from "./replay.ts";
export type {
  Detection,
  Detector,
  Firing,
  KnobValues,
  Manifestation,
  Node,
  Recovery,
  Situation,
  TimerBounds,
} from "./algebra.ts";
export {
  algebraProblems,
  detection,
  errnoOf,
  evaluate,
  modelSource,
  overValues,
  parseExpr,
  realizationKnobs,
  realizationOf,
  recovery,
  stackedDetection,
  timerOf,
  timerUnder,
  transitionOn,
} from "./algebra.ts";
