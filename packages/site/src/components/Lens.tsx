/**
 * This module has the parts of each page of lenses (`../model/lens.ts`). The parts are one timeline of
 * lanes, the marks on a lane and the card of a lane. A player moves a cursor through the time, and a
 * legend and a table of events explain the marks. Each part takes lanes and the names of each lane.
 * Thus a page of one lens and a page of many lenses use the same parts.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactElement, type ReactNode } from "react";
import { quantity, valueIn, type Quantity } from "@mark1russell7/quantity";
import { spacedLabels } from "../lib/format.ts";
import { say, sayBand, type Lane, type LaneNames, type Mark } from "../model/lens.ts";
import { link } from "./Ledger.tsx";
import { useWidth } from "./Strip.tsx";
import Term, { TERMS, type TermName } from "./Term.tsx";

const s = (value: number): Quantity => quantity(value, "s");
const sec = (q: Quantity): number => valueIn(q, "s");

/** This function gives the names of a lane by its id. */
export type NamesOf = (id: string) => LaneNames;

/** The fault on the timeline: it starts at `start`, or at 0 with no start, and it ends at `end`, or it lasts to the end of the axis. */
export interface FaultSpan {
  readonly label: string;
  readonly start?: Quantity;
  readonly end: Quantity | null;
}

/** A group of lanes on the timeline, for example the lanes of one stage: its name, its count of lanes, and its start, or null. */
export interface TimelineGroup {
  /** a short name for the gutter, for example "Queue" */
  readonly label: string;
  readonly rows: number;
  readonly start: Quantity | null;
}

// ---------------------------------------------------------------------------------------------
// the axis
// ---------------------------------------------------------------------------------------------

export type Scale = "log" | "linear";

export interface Axis {
  /** This function gives the place of a time on the axis, from 0 to 1. */
  readonly x: (t: number) => number;
  /** This function gives the time at a place of the axis. */
  readonly t: (x: number) => number;
  readonly end: number;
  readonly ticks: readonly number[];
}

/** the time constant of the logarithmic axis: below it the axis is approximately linear */
const TAU = 0.1;
const LOG_TICKS = [0, 0.01, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 21_600, 86_400, 432_000];

const niceStep = (span: number): number => {
  const raw = span / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * power).find((k) => k >= raw);
  return step ?? 10 * power;
};

/** This function gives the times of the story: the marks, the bands, the measured values and the end of the fault. */
const timesOf = (lanes: readonly Lane[], end: Quantity | null): number[] => [
  ...lanes.flatMap((lane) => [
    ...lane.marks.map((m) => sec(m.t)),
    ...(lane.band === null ? [] : [sec(lane.band.low), sec(lane.band.high)]),
    ...lane.measured.flatMap((m) => (m.at === null ? [] : [sec(m.at)])),
  ]),
  ...(end === null ? [] : [sec(end)]),
];

/** This function gives the axis of the lanes: the whole story on a logarithmic axis, or a linear axis up to the first answer. */
export const axisOf = (lanes: readonly Lane[], faultEnd: Quantity | null, scale: Scale): Axis => {
  const all = timesOf(lanes, faultEnd).filter(Number.isFinite);
  if (scale === "linear") {
    // the linear axis ends a little after the first answer: a detection or a recovery
    const answers = lanes.flatMap((lane) => (lane.band === null || lane.verdict === "blind" ? [] : [sec(lane.band.high)]));
    const focus = Math.max(answers.length === 0 ? Math.max(...all, 1) : Math.min(...answers), faultEnd === null ? 0 : sec(faultEnd), 1);
    const end = focus * 1.15;
    const step = niceStep(end);
    const ticks = Array.from({ length: Math.floor(end / step) + 1 }, (_, n) => n * step);
    return { x: (t) => t / end, t: (x) => x * end, end, ticks };
  }
  const end = Math.max(...all, 1) * 1.25;
  const span = Math.log10(1 + end / TAU);
  return {
    x: (t) => Math.log10(1 + Math.max(t, 0) / TAU) / span,
    t: (x) => TAU * (10 ** (x * span) - 1),
    end,
    ticks: LOG_TICKS.filter((t) => t <= end),
  };
};

/** This function tells if the cursor has passed the start of the band of a lane: the lane lights. */
export const isLit = (lane: Lane, axis: Axis, progress: number): boolean => lane.band !== null && lane.verdict !== "blind" && axis.x(sec(lane.band.low)) <= progress + 1e-9;

// ---------------------------------------------------------------------------------------------
// the timeline
// ---------------------------------------------------------------------------------------------

/** the color of each kind of mark, from the tokens of the site */
const MARK_CLASS: Readonly<Record<Mark["kind"], string>> = { send: "rp-send", fire: "rp-fire", probe: "rp-probe", detect: "rp-detect", recover: "rp-recover" };

const LANE = 50;
/** the width of one character of the mono font at 11 px, for the labels of the ticks */
const CHARACTER = 6.7;
const TOP = 30;
const BOTTOM = 30;

export function Timeline(props: {
  readonly lanes: readonly Lane[];
  readonly names: NamesOf;
  /** the fault, or null when the story ends before it */
  readonly fault: FaultSpan | null;
  readonly scale: Scale;
  readonly progress: number;
  /** what the timeline shows, for a reader who does not see it */
  readonly label: string;
  /** the groups of the lanes, in their order. With groups, a line goes between two groups */
  readonly groups?: readonly TimelineGroup[];
}): ReactElement {
  const [ref, width] = useWidth();
  const { lanes, scale, progress } = props;
  const faultEnd = props.fault?.end ?? null;
  const axis = useMemo(() => axisOf(lanes, faultEnd, scale), [lanes, faultEnd, scale]);
  const narrow = width < 560;
  const gutter = narrow ? 64 : 104;
  const right = 14;
  const plot = Math.max(width - gutter - right, 40);
  const X = (t: number): number => gutter + plot * Math.min(axis.x(t), 1);
  const height = TOP + LANE * lanes.length + BOTTOM;
  const cursorX = gutter + plot * progress;
  const now = axis.t(progress);
  const seen = (t: number): boolean => axis.x(t) <= progress + 1e-9;
  // the ticks, without two grid lines closer than 46 px
  const ticks: number[] = [];
  for (const t of axis.ticks) if (ticks.length === 0 || X(t) - X(ticks.at(-1)!) >= 46) ticks.push(t);
  // the labels of the ticks: a label that touches the label before it is dropped, and a label at the right edge ends at the edge
  const labels = spacedLabels(
    ticks.map((t) => ({ t, x: X(t), text: say(s(t)), width: say(s(t)).length * CHARACTER })),
    width,
  );
  const fault = props.fault;
  const from = fault === null ? 0 : sec(fault.start ?? s(0));
  const end = faultEnd === null ? null : sec(faultEnd);
  // a fault that starts in the right part of the plot has its label on the left of its edge
  const flip = X(from) > gutter + plot * 0.6;
  // the first row of each group
  const groups = (props.groups ?? []).reduce<Array<TimelineGroup & { readonly row: number }>>((out, group) => [...out, { ...group, row: (out.at(-1)?.row ?? 0) + (out.at(-1)?.rows ?? 0) }], []);

  return (
    <div ref={ref} className="rp-timeline">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.label}>
        {/* the fault */}
        {fault === null ? null : (
          <g>
            <rect className="rp-fault" x={X(from)} y={TOP - 6} width={Math.max((end === null ? gutter + plot : X(end)) - X(from), 1)} height={LANE * lanes.length + 6} />
            <line className="rp-fault-edge" x1={X(from)} x2={X(from)} y1={TOP - 14} y2={TOP + LANE * lanes.length} />
            <text className="rp-fault-label" x={flip ? X(from) - 4 : X(from) + 4} y={TOP - 16} textAnchor={flip ? "end" : "start"}>
              {fault.label}
            </text>
            {end === null ? null : <line className="rp-fault-edge" x1={X(end)} x2={X(end)} y1={TOP - 6} y2={TOP + LANE * lanes.length} />}
          </g>
        )}

        {/* the groups: a line between two groups, the name of each group, and the start of each group after 0 */}
        {groups.map((group) =>
          group.rows === 0 ? null : (
            <g key={group.label} className="rp-group">
              {group.row === 0 ? null : <line className="rp-group-line" x1={0} x2={gutter + plot + right} y1={TOP + LANE * group.row} y2={TOP + LANE * group.row} />}
              <text className="rp-group-name" x={8} y={TOP + LANE * group.row + 11}>
                {group.label}
              </text>
              {group.start === null || sec(group.start) <= 0 ? null : (
                <line className="rp-group-start" x1={X(sec(group.start))} x2={X(sec(group.start))} y1={TOP + LANE * group.row + 2} y2={TOP + LANE * (group.row + group.rows) - 2}>
                  <title>{`${group.label} starts at ${say(group.start)}`}</title>
                </line>
              )}
            </g>
          ),
        )}

        {/* the grid and the axis */}
        {ticks.map((t) => (
          <line key={t} className="rp-grid" x1={X(t)} x2={X(t)} y1={TOP - 6} y2={TOP + LANE * lanes.length} />
        ))}
        {labels.map((label) => (
          <text key={label.t} className="rp-tick" x={label.at} y={height - 10} textAnchor={label.anchor}>
            {label.text}
          </text>
        ))}

        {lanes.map((lane, row) => (
          <LaneRow key={lane.id} lane={lane} names={props.names(lane.id)} row={row} X={X} seen={seen} gutter={gutter} plot={plot} narrow={narrow} end={axis.end} />
        ))}

        {/* the cursor */}
        <line className="rp-cursor" x1={cursorX} x2={cursorX} y1={TOP - 6} y2={TOP + LANE * lanes.length + 4} />
        <text className="rp-cursor-label" x={Math.min(Math.max(cursorX, gutter + 30), width - right - 30)} y={TOP + LANE * lanes.length + 16} textAnchor="middle">
          {progress >= 1 ? "" : say(s(now))}
        </text>
      </svg>
    </div>
  );
}

function LaneRow(props: {
  readonly lane: Lane;
  readonly names: LaneNames;
  readonly row: number;
  readonly X: (t: number) => number;
  readonly seen: (t: number) => boolean;
  readonly gutter: number;
  readonly plot: number;
  readonly narrow: boolean;
  readonly end: number;
}): ReactElement {
  const { lane, row, X, seen, gutter, plot } = props;
  const y = TOP + LANE * row + LANE / 2;
  const band = lane.band;
  const lit = band !== null && lane.verdict !== "blind" && seen(sec(band.low));
  const inside = (t: number): boolean => t <= props.end;
  const later = lane.marks.filter((m) => !inside(sec(m.t))).length;
  const bandText = band === null ? null : lane.verdict === "recovers" ? `recovers ${say(band.low)}` : `knows ${say(band.low)}`;
  return (
    <g className="rp-lane" data-verdict={lane.verdict} data-lit={lit ? "true" : undefined}>
      <rect className="rp-lane-bg" x={0} y={y - LANE / 2} width={gutter + plot + 14} height={LANE} />
      <text className="rp-lane-name" x={8} y={y + 4}>
        {props.narrow ? props.names.short : props.names.label}
      </text>
      <line className="rp-lane-line" x1={gutter} x2={gutter + plot} y1={y} y2={y} />
      {lane.verdict === "blind" || lane.verdict === "silent" ? (
        <text className="rp-lane-note" x={gutter + 8} y={y - 10}>
          {lane.verdict === "blind" ? "cannot see the fault" : "never knows"}
        </text>
      ) : null}
      {band === null || lane.verdict === "blind" ? null : (
        <g className={lane.verdict === "recovers" ? "rp-band rp-band-recover" : "rp-band"} opacity={lit ? 1 : 0.25}>
          <rect x={X(sec(band.low))} y={y - 9} width={Math.max(X(sec(band.high)) - X(sec(band.low)), 3)} height={18} rx={2}>
            <title>{`${props.names.title}: ${sayBand(band)}`}</title>
          </rect>
          {bandText === null || !inside(sec(band.low)) ? null : (
            <text
              className="rp-band-label"
              x={X(sec(band.low)) > gutter + plot * 0.6 ? Math.min(X(sec(band.high)), gutter + plot) : X(sec(band.low))}
              y={y - 13}
              textAnchor={X(sec(band.low)) > gutter + plot * 0.6 ? "end" : "start"}
            >
              {bandText}
            </text>
          )}
        </g>
      )}
      {lane.marks.filter((m) => inside(sec(m.t))).map((m, n) => (
        <MarkGlyph key={n} mark={m} x={X(sec(m.t))} y={y} seen={seen(sec(m.t))} />
      ))}
      {lane.measured.flatMap((m, n) =>
        m.at === null || !inside(sec(m.at)) ? [] : [
          <circle key={`m${n}`} className="rp-measured" cx={X(sec(m.at))} cy={y} r={4.5} opacity={seen(sec(m.at)) ? 1 : 0.2}>
            <title>{`Measured, ${m.cell}: ${m.measured}`}</title>
          </circle>,
        ],
      )}
      {later === 0 && (band === null || inside(sec(band.low)) || lane.verdict === "blind") ? null : (
        <text className="rp-later" x={gutter + plot} y={y + 4} textAnchor="end">
          {band !== null && lane.verdict !== "blind" && !inside(sec(band.low)) ? `${say(band.low)} →` : `+${later} →`}
        </text>
      )}
    </g>
  );
}

function MarkGlyph(props: { readonly mark: Mark; readonly x: number; readonly y: number; readonly seen: boolean }): ReactElement {
  const { mark, x, y } = props;
  const title = <title>{`${mark.label}: ${say(mark.t)}`}</title>;
  const opacity = props.seen ? 1 : 0.2;
  const cls = MARK_CLASS[mark.kind];
  switch (mark.kind) {
    case "send":
      return (
        <circle className={cls} cx={x} cy={y} r={4} opacity={opacity}>
          {title}
        </circle>
      );
    case "probe":
      return (
        <path className={cls} d={`M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5} L ${x - 5} ${y} Z`} opacity={opacity}>
          {title}
        </path>
      );
    case "fire":
      return (
        <line className={cls} x1={x} x2={x} y1={y - 6} y2={y + 6} opacity={opacity}>
          {title}
        </line>
      );
    case "detect":
      return (
        <path className={cls} d={`M ${x} ${y + 9} L ${x} ${y - 10} L ${x + 8} ${y - 6.5} L ${x} ${y - 3}`} opacity={opacity}>
          {title}
        </path>
      );
    case "recover":
      return (
        <circle className={cls} cx={x} cy={y} r={5} opacity={opacity}>
          {title}
        </circle>
      );
  }
}

// ---------------------------------------------------------------------------------------------
// the player
// ---------------------------------------------------------------------------------------------

/** the time of one play of the timeline, in milliseconds of the clock of the reader */
const PLAY = 6500;

/** The state of the player: its progress from 0 to 1, if it plays, and the count of its seeks. */
export interface PlayerState {
  readonly progress: number;
  readonly playing: boolean;
  readonly run: number;
}

/** An action of the player: a reader plays, pauses or seeks, and the loop gives the progress of a frame. */
export type PlayerAction = { readonly type: "play" } | { readonly type: "pause" } | { readonly type: "seek"; readonly progress: number } | { readonly type: "frame"; readonly progress: number };

/**
 * This function gives the next state of the player. A seek stops the loop and counts one more run.
 * The loop starts again on each run, thus a restart while the player plays starts from the seek.
 */
export const playerStep = (state: PlayerState, action: PlayerAction): PlayerState => {
  switch (action.type) {
    case "play":
      return state.playing ? state : { ...state, playing: true };
    case "pause":
      return state.playing ? { ...state, playing: false } : state;
    case "seek":
      return { progress: action.progress, playing: false, run: state.run + 1 };
    case "frame":
      return action.progress >= 1 ? { ...state, progress: 1, playing: false } : { ...state, progress: action.progress };
  }
};

export interface Player {
  readonly progress: number;
  readonly playing: boolean;
  readonly play: () => void;
  readonly pause: () => void;
  readonly seek: (p: number) => void;
  /** This function plays the story again from its start. */
  readonly restart: () => void;
}

/** This hook plays the timeline: a progress from 0 to 1 in PLAY milliseconds. */
export const usePlayer = (): Player => {
  const [state, dispatch] = useReducer(playerStep, { progress: 1, playing: false, run: 0 });
  const { progress, playing, run } = state;
  const start = useRef<{ at: number; from: number } | null>(null);
  useEffect(() => {
    // A reader who asks for less motion, and a browser under automation, for example the job of the
    // screenshots, see the whole story at once.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || navigator.webdriver;
    if (!reduced) {
      dispatch({ type: "seek", progress: 0 });
      dispatch({ type: "play" });
    }
  }, []);
  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const step = (time: number): void => {
      if (start.current === null) start.current = { at: time, from: progress >= 1 ? 0 : progress };
      const p = Math.min(start.current.from + (time - start.current.at) / PLAY, 1);
      dispatch({ type: "frame", progress: p });
      if (p >= 1) {
        start.current = null;
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      start.current = null;
    };
    // The loop reads the progress only at its start, thus the progress is not a dependency. A seek
    // changes the run, thus a restart while the player plays starts a new loop from the seek.
  }, [playing, run]);
  const play = useCallback(() => dispatch({ type: "play" }), []);
  const pause = useCallback(() => dispatch({ type: "pause" }), []);
  const seek = useCallback((p: number) => dispatch({ type: "seek", progress: p }), []);
  const restart = useCallback(() => {
    dispatch({ type: "seek", progress: 0 });
    dispatch({ type: "play" });
  }, []);
  return { progress, playing, play, pause, seek, restart };
};

/** The bar of the player: play or pause, the slider of the time, the scale of the axis, and the table switch. */
export function PlayerBar(props: {
  readonly player: Player;
  readonly scale: Scale;
  readonly setScale: (scale: Scale) => void;
  readonly table: boolean;
  readonly setTable: (table: boolean) => void;
}): ReactElement {
  const { player, scale, setScale, table, setTable } = props;
  return (
    <div className="rp-player">
      <button type="button" className="sy-button" onClick={player.playing ? player.pause : player.progress >= 1 ? player.restart : player.play}>
        {player.playing ? "Pause" : player.progress >= 1 ? "Play again" : "Play"}
      </button>
      <input type="range" aria-label="Time on the timeline" min={0} max={1000} step={1} value={Math.round(player.progress * 1000)} onChange={(e) => player.seek(Number(e.target.value) / 1000)} />
      <span className="sy-switch" role="group" aria-label="Time axis">
        <button type="button" aria-pressed={scale === "log"} onClick={() => setScale("log")}>
          Whole story
        </button>
        <button type="button" aria-pressed={scale === "linear"} onClick={() => setScale("linear")}>
          First answer
        </button>
      </span>
      <span className="sy-switch">
        <button type="button" aria-pressed={table} onClick={() => setTable(!table)}>
          Table
        </button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// the legend, the table and the cards
// ---------------------------------------------------------------------------------------------

/** The legend of the marks and the bands of the timeline. */
export function TimelineLegend(props: { readonly band: string }): ReactElement {
  return (
    <ul className="rp-legend" aria-label="Legend">
      <li>
        <span className="rp-key rp-key-fault" /> the fault
      </li>
      <li>
        <span className="rp-key rp-key-band" /> {props.band}
      </li>
      <li>
        <span className="rp-key rp-key-recover" /> recovers
      </li>
      <li>
        <span className="rp-key rp-key-fire" /> a send again or a timer
      </li>
      <li>
        <span className="rp-key rp-key-probe" /> a probe
      </li>
      <li>
        <span className="rp-key rp-key-measured" /> measured median of a cell
      </li>
    </ul>
  );
}

/** The caption of the axis. */
export const scaleCaption = (scale: Scale): string =>
  scale === "log" ? "The axis is logarithmic, thus the first second and the last hour both fit." : "The axis is linear, up to the first answer. An arrow at the right edge shows a later event.";

/** The events of all lanes, in the order of their times: each mark, and each measured median. */
export function EventsTable(props: { readonly lanes: readonly Lane[]; readonly names: NamesOf; readonly heading: string }): ReactElement {
  const events = props.lanes
    .flatMap((lane) => [
      ...lane.marks.map((m) => ({ lane: lane.id, what: m.label, t: sec(m.t) })),
      ...lane.measured.flatMap((m) => (m.at === null ? [] : [{ lane: lane.id, what: `Measured median, ${m.cell}`, t: sec(m.at) }])),
    ])
    .sort((a, b) => a.t - b.t);
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>{props.heading}</th>
            <th>Event</th>
            <th className="num">Time</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, n) => (
            <tr key={n}>
              <td>{props.names(e.lane).title}</td>
              <td>{e.what}</td>
              <td className="num">{say(s(e.t))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const verdictText = (lane: Lane): string => {
  if (lane.verdict === "detects" && lane.band !== null) return `Knows at ${sayBand(lane.band)}`;
  if (lane.verdict === "recovers" && lane.band !== null) return `Recovers at ${sayBand(lane.band)}`;
  if (lane.verdict === "silent") return "Never knows";
  return "Cannot see it";
};

const isTerm = (name: string | null): name is TermName => name !== null && Object.hasOwn(TERMS, name);

/** The card of one lane: its verdict, its summary, its warning, its facts, its measured values, and the knobs of its lens. */
export function LaneCard(props: { readonly lane: Lane; readonly names: LaneNames; readonly lit: boolean; readonly first: boolean; readonly children?: ReactNode }): ReactElement {
  const { lane, names } = props;
  const term = names.term;
  return (
    <section className="rp-card" data-verdict={lane.verdict} data-lit={props.lit ? "true" : undefined} aria-label={names.title}>
      <header className="rp-card-head">
        <h3>
          {names.title}
          {isTerm(term) ? (
            <span className="rp-card-term">
              <Term name={term}>?</Term>
            </span>
          ) : null}
        </h3>
        <span className="rp-chip" data-verdict={lane.verdict}>
          {props.first ? "First · " : ""}
          {verdictText(lane)}
        </span>
      </header>
      <p className="rp-summary">{lane.summary}</p>
      {lane.warning === null ? null : (
        <p className="rp-warning" role="note">
          {lane.warning}
        </p>
      )}
      {lane.facts.length === 0 ? null : (
        <dl className="rp-facts">
          {lane.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {lane.measured.length === 0 ? null : (
        <ul className="rp-measured-list">
          {lane.measured.map((m) => (
            <li key={m.cell}>
              <span className="rp-dot" aria-hidden="true" />
              <span>
                <a href={link(m.href)}>{m.cell}</a>
                <span className="rp-pair">
                  <span>
                    Measured <strong>{m.measured}</strong>
                  </span>
                  <span>
                    Computed <strong>{m.computed}</strong>
                  </span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {props.children}
    </section>
  );
}
