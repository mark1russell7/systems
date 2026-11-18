/**
 * The lens contract of the visuals of the site. A lens is a set of named knobs, a pure model and its
 * lanes. A lane is one row of a timeline: a verdict, a band, marks, facts and the measured values of
 * cells. The timeline, the player and the cards of the site take lanes. Thus each page of one lens or of
 * many lenses uses the same parts.
 *
 * A knob has one name in all lenses. The knob `rtt` of TCP and the knob `rtt` of a later lens are one
 * value of the settings. Thus a page of many lenses has one control for each knob (`controlsOf`).
 *
 * Each time is a quantity of `@mark1russell7/quantity`, from the start of the story of the page, and
 * each time prints through `say`.
 *
 * A stage is a part of one story: its lenses and its exit. `sequence` puts each stage after the exit of
 * the stage before it. Thus a page of one connection, from its port to its request, uses the lenses of
 * each page with no change.
 */
import { convert, format, formatDuration, isUnbounded, quantity, valueIn, type Extent, type Quantity, type Unknown } from "@mark1russell7/quantity";

const s = (value: number): Quantity => quantity(value, "s");

// ---------------------------------------------------------------------------------------------
// the lanes
// ---------------------------------------------------------------------------------------------

/** A band is the range of times in which an event comes, from the start of the story. */
export interface Band {
  readonly low: Quantity;
  readonly high: Quantity;
}

/** A verdict tells what a lane does with the fault. */
export type Verdict = "detects" | "recovers" | "silent" | "blind";

/** A mark is one event on a lane: a send, a firing, a probe, a detection or a recovery. */
export interface Mark {
  readonly t: Quantity;
  readonly label: string;
  readonly kind: "send" | "fire" | "probe" | "detect" | "recover";
}

/** A measured value is a value of a cell beside the value that the page computes. */
export interface Measured {
  readonly cell: string;
  readonly measured: string;
  readonly computed: string;
  readonly href: string;
  /** the measured median on the timeline, from the start of the story, or null */
  readonly at: Quantity | null;
}

/** A fact is one computed value of a lane, with its label. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** A lane is one row of the timeline, and one card under it. */
export interface Lane<Id extends string = string> {
  readonly id: Id;
  readonly verdict: Verdict;
  /** the band in which the lane finds the fault or recovers from it, or null */
  readonly band: Band | null;
  /** one sentence: what the lane does */
  readonly summary: string;
  readonly facts: readonly Fact[];
  readonly marks: readonly Mark[];
  readonly measured: readonly Measured[];
  /** a warning for these settings, or null */
  readonly warning: string | null;
}

// ---------------------------------------------------------------------------------------------
// the lenses
// ---------------------------------------------------------------------------------------------

/** The names of a lane for a reader: on its card, on the timeline, and on a narrow timeline. */
export interface LaneNames {
  /** the title of the card, for example "The program" */
  readonly title: string;
  /** the name on the timeline, for example "Program" */
  readonly label: string;
  /** the name on a narrow timeline, for example "Kube" */
  readonly short: string;
  /** the term of the glossary that explains the lane, or null */
  readonly term: string | null;
}

/**
 * A lens is a set of named knobs, a pure model and its lanes. `S` is the settings of the page: one value
 * for each knob of each lens on it.
 */
export interface Lens<S, Id extends string = string> {
  readonly id: Id;
  readonly names: LaneNames;
  /** the knobs whose controls the lens shows, in their order on its card */
  readonly knobs: ReadonlyArray<keyof S & string>;
  /** the model: the lanes of the lens for the settings. It is pure: the same settings give the same lanes */
  readonly lanes: (settings: S) => ReadonlyArray<Lane<Id>>;
}

/** This function gives the lanes of each lens for the settings, in the order of the lenses. */
export const lanesOf = <S, Id extends string>(lenses: ReadonlyArray<Lens<S, Id>>, settings: S): Array<Lane<Id>> => lenses.flatMap((lens) => lens.lanes(settings));

/**
 * This function gives the controls of each lens on a page of many lenses: each knob once, on the first
 * lens that shows it. A later lens that reads the same knob shows no second control.
 */
export const controlsOf = <S>(lenses: ReadonlyArray<Lens<S>>): ReadonlyMap<string, ReadonlyArray<keyof S & string>> => {
  const shown = new Set<string>();
  const out = new Map<string, ReadonlyArray<keyof S & string>>();
  for (const lens of lenses) {
    const own = lens.knobs.filter((knob) => !shown.has(knob));
    for (const knob of own) shown.add(knob);
    out.set(lens.id, own);
  }
  return out;
};

/**
 * This function makes a pure function remember its results, by the identity of its settings.
 * Two lenses that need one model, for example the lane of TCP below the program, compute it one time.
 */
export const memo = <S extends object, R>(model: (settings: S) => R): ((settings: S) => R) => {
  const seen = new WeakMap<S, R>();
  return (settings) => {
    const known = seen.get(settings);
    if (known !== undefined) return known;
    const result = model(settings);
    seen.set(settings, result);
    return result;
  };
};

// ---------------------------------------------------------------------------------------------
// the stages
// ---------------------------------------------------------------------------------------------

/**
 * The exit of a stage: the story passes to the next stage in a band, or it ends in the stage. An end
 * with no band is an end that no event marks, for example a client that waits forever.
 */
export type Exit =
  | { readonly kind: "pass"; readonly at: Band; readonly label: string }
  | { readonly kind: "end"; readonly at: Band | null; readonly label: string };

/**
 * A stage is a part of one story: its lenses, and its exit. The times of a stage count from its start.
 * Thus a lens keeps its own page, and a page of many stages puts the same lens after the stage before it.
 */
export interface Stage<S, Id extends string = string> {
  readonly id: string;
  /** the name of the stage for a reader, for example "The accept queue" */
  readonly title: string;
  /** a short name for the gutter of a timeline, for example "Queue" */
  readonly short: string;
  readonly lenses: ReadonlyArray<Lens<S, Id>>;
  /** the model of the exit. It is pure: the same settings give the same exit */
  readonly exit: (settings: S) => Exit;
}

/** A stage on the whole timeline: its start, its lanes in its own time and on the whole timeline, and its exit. */
export interface Staged<S, Id extends string = string> {
  readonly stage: Stage<S, Id>;
  /** the start of the stage on the whole timeline, or null when the story ends before the stage */
  readonly start: Band | null;
  /** the lanes in the time of the stage, from its start */
  readonly own: ReadonlyArray<Lane<Id>>;
  /** the lanes on the whole timeline */
  readonly lanes: ReadonlyArray<Lane<Id>>;
  /** the exit on the whole timeline, or null when the story ends before the stage */
  readonly exit: Exit | null;
}

const plus = (a: Quantity, b: Quantity): Quantity => quantity(valueIn(a, "s") + valueIn(b, "s"), "s");

/** This function moves a band by a band: the low end by the low end, and the high end by the high end. */
export const shiftBand = (band: Band, by: Band): Band => ({ low: plus(band.low, by.low), high: plus(band.high, by.high) });

/**
 * This function moves a lane by the start of its stage. A band moves by the band of the start. A mark
 * and a measured median are points, thus they move by the low end of the start.
 */
export const shiftLane = <Id extends string>(lane: Lane<Id>, by: Band): Lane<Id> => ({
  ...lane,
  band: lane.band === null ? null : shiftBand(lane.band, by),
  marks: lane.marks.map((mark) => ({ ...mark, t: plus(mark.t, by.low) })),
  measured: lane.measured.map((m) => ({ ...m, at: m.at === null ? null : plus(m.at, by.low) })),
});

/** This function moves an exit by the start of its stage. */
export const shiftExit = (exit: Exit, by: Band): Exit => (exit.kind === "pass" ? { ...exit, at: shiftBand(exit.at, by) } : { ...exit, at: exit.at === null ? null : shiftBand(exit.at, by) });

/**
 * This function puts the stages of one story on one timeline. The first stage starts at 0 s, and each
 * next stage starts at the pass of the stage before it. After an end, the next stages get no start and
 * no lanes.
 */
export const sequence = <S, Id extends string>(stages: ReadonlyArray<Stage<S, Id>>, settings: S): Array<Staged<S, Id>> => {
  const out: Array<Staged<S, Id>> = [];
  let start: Band | null = bandOf(s(0));
  for (const stage of stages) {
    if (start === null) {
      out.push({ stage, start: null, own: [], lanes: [], exit: null });
      continue;
    }
    const from: Band = start;
    const own = lanesOf(stage.lenses, settings);
    const exit = shiftExit(stage.exit(settings), from);
    out.push({ stage, start: from, own, lanes: own.map((lane) => shiftLane(lane, from)), exit });
    start = exit.kind === "pass" ? exit.at : null;
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// the times
// ---------------------------------------------------------------------------------------------

/** This function gives a band in seconds. One time gives a band of one point. */
export const bandOf = (low: Quantity, high: Quantity = low): Band => ({ low: convert(low, "s"), high: convert(high, "s") });

/** This function tells if an extent is a finite quantity. */
export const finite = (extent: Extent | Unknown | undefined): extent is Quantity => extent !== undefined && !("unknown" in extent) && !isUnbounded(extent);

/**
 * This function prints a time for a reader: "204 ms", "6.528 s", "15 min 24.6 s", "never". Each form
 * comes from `format` or `formatDuration` of the quantity package, in a unit that suits the size.
 */
export const say = (extent: Extent | Unknown | undefined): string => {
  if (extent === undefined) return "never";
  if ("unknown" in extent) return `unknown (${extent.unknown})`;
  if (isUnbounded(extent)) return "never";
  const seconds = valueIn(extent, "s");
  if (seconds === 0) return format(s(0));
  if (Math.abs(seconds) < 1) return format(convert(extent, "ms"), { digits: Math.abs(seconds) < 0.01 ? 2 : 1 });
  if (Math.abs(seconds) < 120) return format(convert(extent, "s"), { digits: 3 });
  return formatDuration(extent, 3);
};

/** This function prints a band: "21 s to 31.092 s", or one time when the two ends are the same. */
export const sayBand = (band: Band): string => (valueIn(band.low, "s") === valueIn(band.high, "s") ? say(band.low) : `${say(band.low)} to ${say(band.high)}`);
