// The metrics of a loop (SYS-138 part 2): the records and the transitions of the loop core as instruments of
// OpenTelemetry. The names, the units and the attributes follow the semantic conventions. Each duration is in
// seconds. The entry `/otel` gives this function, thus only that entry loads the API of OpenTelemetry.

import type { Transition } from "@mark1russell7/algebra/replay";
import { type Attributes, type Meter, metrics } from "@opentelemetry/api";
import type { LoopRecord, RoundEnd } from "./loop.ts";

/**
 * These bounds of the buckets of the two histograms are in seconds. The last bound of a round is 30 min, for a stream
 * whose round is one connection.
 */
export const LOOP_BOUNDS: { readonly lateness: readonly number[]; readonly duration: readonly number[] } = {
  lateness: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  duration: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800],
};

/**
 * These two functions take the records and the transitions of one or more loops. Give each one to the option of the same
 * name of `loop()`, for example `loop(schedule, round, { name: "feed", ...meters })`. `loop.inflight` reads the two.
 */
export interface LoopMetrics {
  readonly record: (record: LoopRecord) => void;
  readonly onTransition: (transition: Transition) => void;
}

/**
 * This function gives the value of `error.type` for a failed round. A round past its timeout gives `timeout`. A
 * round that did not start because its lane was busy (the overlap `fail`) gives `blocked`. A round with no proof
 * gives `unproved`. Another failure gives the name of the class of the error, and a thrown value that is not an
 * `Error` gives `_OTHER`.
 */
export const loopErrorType = (end: RoundEnd): string => {
  if (end.timedOut) return "timeout";
  if (end.blocked) return "blocked";
  const error = end.error;
  if (!(error instanceof Error)) return "_OTHER";
  if (error.name === "UnprovedRoundError") return "unproved";
  const named = (error.constructor as { readonly name?: unknown } | undefined)?.name;
  if (typeof named === "string" && named !== "" && named !== "Object") return named;
  return error.name !== "" ? error.name : "_OTHER";
};

const SECOND = 1000;

/**
 * This function makes the instruments of the loops on a meter. The default meter is the meter
 * `@mark1russell7/service` of the provider that the program registers. Before a registration, each instrument does nothing.
 *
 * - `loop.rounds`, `loop.failures`, `loop.skipped` and `loop.deferred` are counters of rounds. A blocked round (the
 *   overlap `fail` on a busy lane) does not start: it is in `loop.failures` only.
 * - `loop.lateness` and `loop.round.duration` are histograms in seconds.
 * - `loop.inflight` counts the rounds whose scope did not close yet. A round past its timeout stays in it until it
 *   settles. At the stop of a loop, its rounds leave it.
 * - Each metric has the attributes `loop.name` and `loop.lane`. Each failure also has `error.type`.
 */
export const loopMetrics = (meter: Meter = metrics.getMeter("@mark1russell7/service")): LoopMetrics => {
  const rounds = meter.createCounter("loop.rounds", {
    unit: "{round}",
    description: "The rounds that started. A blocked round does not start, thus it is not in this count.",
  });
  const failures = meter.createCounter("loop.failures", { unit: "{round}", description: "The rounds that failed, with the rounds past their timeout." });
  const skipped = meter.createCounter("loop.skipped", { unit: "{round}", description: "The rounds that did not occur: a late loop or the overlap skip." });
  const deferred = meter.createCounter("loop.deferred", { unit: "{round}", description: "The rounds that waited for the window of the budget." });
  const lateness = meter.createHistogram("loop.lateness", {
    unit: "s",
    description: "The real start of a round minus its planned start.",
    advice: { explicitBucketBoundaries: [...LOOP_BOUNDS.lateness] },
  });
  const duration = meter.createHistogram("loop.round.duration", {
    unit: "s",
    description: "The end of a round minus its start. A round past its timeout gives the timeout.",
    advice: { explicitBucketBoundaries: [...LOOP_BOUNDS.duration] },
  });
  const inflight = meter.createUpDownCounter("loop.inflight", { unit: "{round}", description: "The rounds whose scope did not close yet." });
  /** The rounds in flight of each lane, by the instance of the lane: `<loop>#<lane>`. */
  const flying = new Map<string, number>();

  const attributes = (loop: string, lane: number): Attributes => ({ "loop.name": loop, "loop.lane": lane });
  const move = (loop: string, lane: number, by: number): void => {
    if (by === 0) return;
    const key = `${loop}#${lane}`;
    const next = (flying.get(key) ?? 0) + by;
    if (next === 0) flying.delete(key);
    else flying.set(key, next);
    inflight.add(by, attributes(loop, lane));
  };

  return {
    record: (record) => {
      const on = attributes(record.loop, record.lane);
      switch (record.kind) {
        case "start":
          rounds.add(1, on);
          lateness.record(Math.max(0, record.start - record.planned) / SECOND, on);
          move(record.loop, record.lane, 1);
          return;
        case "end": {
          const failed = record.outcome === "fail";
          const tagged = failed ? { ...on, "error.type": loopErrorType(record) } : on;
          if (failed) failures.add(1, tagged);
          if (!record.blocked) duration.record(Math.max(0, record.end - record.start) / SECOND, tagged);
          // the end of a round in its timeout comes after the close of its scope. A late round leaves at its late answer
          if (!record.blocked && !record.timedOut) move(record.loop, record.lane, -1);
          return;
        }
        case "skip":
          skipped.add(record.count, on);
          return;
        case "defer":
          deferred.add(1, on);
          return;
      }
    },
    onTransition: (transition) => {
      if (transition.on !== "late-answer" && transition.on !== "stop") return;
      const cut = transition.instance.lastIndexOf("#");
      const loop = transition.instance.slice(0, cut);
      const lane = Number(transition.instance.slice(cut + 1));
      if (cut < 0 || !Number.isInteger(lane)) return;
      // a late answer closes one round. The stop aborts and closes each round of the lane
      move(loop, lane, transition.on === "late-answer" ? -1 : -(flying.get(transition.instance) ?? 0));
    },
  };
};
