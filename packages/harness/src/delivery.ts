import type { Cell, CountBand, DeliveryPrediction, ProbeEvent, Run } from "./cell.ts";

/**
 * This module reads the stream of a delivery cell (`DeliveryPrediction`): the events that the
 * sender emitted, and the events that the receiver got. The lines of the client are the events of
 * the run, and the lines of the target are its `server` lines.
 */

/** A stream is the workload of a delivery cell: its count of events, and the program that sends them. */
export interface DeliveryStream {
  readonly count: number;
  readonly sender: "client" | "target";
}

/** A delivery reading is what a run of a stream delivered. */
export interface DeliveryReading {
  /** This count is the distinct events that the sender emitted. */
  readonly emitted: number;
  /** This count is the distinct events that the receiver got. */
  readonly got: number;
  /** This count is the emitted events that the receiver did not get. */
  readonly lost: number;
  /** This count is the extra copies that the receiver got. */
  readonly duplicates: number;
  /** This count is the distinct events that the receiver got and the sender did not emit. */
  readonly unknown: number;
  /** This value is the field `recovered` of the second connection of the client, or null without a second connection. */
  readonly recovered: boolean | null;
  /** This flag tells that the receiver got the last event of the stream. */
  readonly ended: boolean;
}

/**
 * This function gives the stream of a cell with a delivery law. It throws for a cell with no count
 * of events: the law has no last event without it. It also throws for a target without its lines
 * (`Target.lines`): the law reads the lines of the two programs.
 */
export const streamOf = (cell: Cell): DeliveryStream => {
  const { count, sender } = cell.probe;
  if (cell.probe.mode !== "stream" || count === undefined || count < 1)
    throw new RangeError(`${cell.name}: a delivery law needs a stream of 1 or more events (probe.mode "stream" and probe.count)`);
  if (cell.target.lines !== true) throw new RangeError(`${cell.name}: a delivery law needs the lines of the target (target.lines)`);
  return { count, sender: sender ?? "client" };
};

/** This function gives the numbers of the lines `ev` of a program: the field `n` of each. */
const numbersOf = (lines: readonly ProbeEvent[], ev: string): number[] =>
  lines.filter((line) => line.ev === ev && typeof line["n"] === "number").map((line) => line["n"] as number);

/** This function gives the lines of the sender and of the receiver of a stream, in that sequence. */
const sidesOf = (run: Run, stream: DeliveryStream): readonly [readonly ProbeEvent[], readonly ProbeEvent[]] =>
  stream.sender === "client" ? [run.events, run.server ?? []] : [run.server ?? [], run.events];

/** This function tells that the receiver of a stream got its last event: the end of the wait of a run. */
export const streamEnded = (run: Run, stream: DeliveryStream): boolean => numbersOf(sidesOf(run, stream)[1], "got").includes(stream.count);

/** This function gives what a run of a stream delivered. */
export const deliveryOf = (run: Run, stream: DeliveryStream): DeliveryReading => {
  const [sender, receiver] = sidesOf(run, stream);
  const emitted = new Set(numbersOf(sender, "emitted"));
  const got = numbersOf(receiver, "got");
  const distinct = new Set(got);
  const second = run.events.filter((line) => line.ev === "status" && line["status"] === "connected")[1];
  return {
    emitted: emitted.size,
    got: distinct.size,
    lost: [...emitted].filter((n) => !distinct.has(n)).length,
    duplicates: got.length - distinct.size,
    unknown: [...distinct].filter((n) => !emitted.has(n)).length,
    recovered: second === undefined ? null : second["recovered"] === true,
    ended: distinct.has(stream.count),
  };
};

/** This function tells that a count is outside its band. */
const outside = (band: CountBand, value: number): boolean => value < band.low || value > band.high;

/** This function gives the words of a count band. */
const bandWords = (band: CountBand): string => (band.low === band.high ? `${band.low}` : `${band.low} to ${band.high}`);

/** This function gives the finding of a run of a stream against its law, or null when the run holds it. */
export const deliveryFinding = (prediction: DeliveryPrediction, stream: DeliveryStream, read: DeliveryReading): string | null => {
  const sender = `the ${stream.sender}`;
  const receiver = stream.sender === "client" ? "the target" : "the client";
  const found = [
    read.emitted === stream.count ? null : `${sender} emitted ${read.emitted} of the ${stream.count} events of the stream`,
    read.ended ? null : `${receiver} did not get event ${stream.count}, the last of the stream`,
    read.unknown === 0 ? null : `${receiver} got ${read.unknown} events that ${sender} did not emit`,
    outside(prediction.lost, read.lost) ? `${receiver} lost ${read.lost} events, outside ${bandWords(prediction.lost)}` : null,
    outside(prediction.duplicates, read.duplicates)
      ? `${receiver} got ${read.duplicates} extra copies, outside ${bandWords(prediction.duplicates)}`
      : null,
    prediction.recovered === undefined || read.recovered === prediction.recovered
      ? null
      : read.recovered === null
        ? "the client made no second connection, thus it gave no value of recovered"
        : `the second connection of the client has recovered ${read.recovered}, not ${prediction.recovered}`,
  ].filter((each) => each !== null);
  return found.length === 0 ? null : found.join(". ");
};
