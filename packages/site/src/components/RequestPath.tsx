/**
 * The path of one request. A program sends one request, and a fault starts on the path. The page
 * computes, in the browser, when each layer finds the fault: the program, the socket, TCP,
 * Kubernetes and the NIC. The reader sets the knobs of each layer and selects the fault.
 *
 * The times come from the model `../model/request.ts`, which runs the algebra of
 * `@mark1russell7/automata` over the machine documents of `@mark1russell7/machines`. Each amount
 * prints through the quantity package. The timeline plays the story: a cursor moves through the
 * time, and each layer lights when it finds the fault.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactElement, type ReactNode } from "react";
import { quantity, valueIn, type Quantity } from "@mark1russell7/quantity";
import { spacedLabels } from "../lib/format.ts";
import { link } from "./Ledger.tsx";
import { useWidth } from "./Strip.tsx";
import Term, { type TermName } from "./Term.tsx";
import {
  DATAPLANES,
  DEFAULTS,
  PRESETS,
  layerName,
  requestPath,
  say,
  sayBand,
  type Fault,
  type LayerId,
  type LayerResult,
  type Mark,
  type PathResult,
  type Settings,
} from "../model/request.ts";

const s = (value: number): Quantity => quantity(value, "s");
const sec = (q: Quantity): number => valueIn(q, "s");

const FAULTS: ReadonlyArray<{ readonly id: Fault; readonly label: string; readonly term: TermName }> = [
  { id: "blackhole", label: "Black hole", term: "black hole" },
  { id: "stall", label: "Stalled peer", term: "stall" },
  { id: "partition", label: "Partition", term: "partition" },
];

/** the short names of the lanes, for a narrow screen */
const SHORT: Readonly<Record<LayerId, string>> = { process: "Program", socket: "Socket", tcp: "TCP", kube: "Kube", nic: "NIC" };
const LANE_NAMES: Readonly<Record<LayerId, string>> = { ...SHORT, kube: "Kubernetes" };

/** the time of one play of the timeline, in milliseconds of the clock of the reader */
const PLAY = 6500;

// ---------------------------------------------------------------------------------------------
// the controls
// ---------------------------------------------------------------------------------------------

/** A slider on a logarithmic scale from `min` to `max`, in one unit, for times that span several orders. */
const toLog = (value: number, min: number, max: number): number => (100 * Math.log(Math.max(value, min) / min)) / Math.log(max / min);
const fromLog = (step: number, min: number, max: number): number => Number((min * (max / min) ** (step / 100)).toPrecision(2));

function TimeKnob(props: {
  readonly label: ReactNode;
  readonly value: Quantity;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: Quantity) => void;
}): ReactElement {
  const now = valueIn(props.value, props.unit);
  return (
    <label className="sy-knob">
      <span>
        {props.label} <output>{say(props.value)}</output>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={0.5}
        value={toLog(now, props.min, props.max)}
        onChange={(e) => props.onChange(quantity(fromLog(Number(e.target.value), props.min, props.max), props.unit))}
      />
    </label>
  );
}

function CountKnob(props: { readonly label: ReactNode; readonly value: number; readonly min: number; readonly max: number; readonly onChange: (value: number) => void }): ReactElement {
  return (
    <label className="sy-knob">
      <span>
        {props.label} <output>{props.value}</output>
      </span>
      <input type="range" min={props.min} max={props.max} step={1} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

function Choice<T extends string | number>(props: {
  readonly label: ReactNode;
  readonly name: string;
  readonly options: ReadonlyArray<{ readonly id: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <div className="sy-knob">
      <span>{props.label}</span>
      <span className="sy-switch" role="group" aria-label={props.name}>
        {props.options.map((option) => (
          <button key={String(option.id)} type="button" aria-pressed={props.value === option.id} onClick={() => props.onChange(option.id)}>
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** A time knob with an off switch: the off value is 0. */
function OptionalTimeKnob(props: {
  readonly label: ReactNode;
  readonly name: string;
  readonly value: Quantity;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly onValue: number;
  readonly onChange: (value: Quantity) => void;
}): ReactElement {
  const on = valueIn(props.value, props.unit) > 0;
  return (
    <div className="sy-knob">
      <span>
        {props.label} <output>{on ? say(props.value) : "off"}</output>
      </span>
      <span className="rp-optional">
        <span className="sy-switch" role="group" aria-label={props.name}>
          <button type="button" aria-pressed={!on} onClick={() => props.onChange(quantity(0, props.unit))}>
            Off
          </button>
          <button type="button" aria-pressed={on} onClick={() => props.onChange(quantity(on ? valueIn(props.value, props.unit) : props.onValue, props.unit))}>
            On
          </button>
        </span>
        <input
          type="range"
          aria-label={props.name}
          min={0}
          max={100}
          step={0.5}
          disabled={!on}
          value={on ? toLog(valueIn(props.value, props.unit), props.min, props.max) : 0}
          onChange={(e) => props.onChange(quantity(fromLog(Number(e.target.value), props.min, props.max), props.unit))}
        />
      </span>
    </div>
  );
}

/** The knobs of each layer. */
function LayerKnobs(props: { readonly id: LayerId; readonly settings: Settings; readonly change: (next: Partial<Settings>) => void }): ReactElement | null {
  const { settings, change } = props;
  switch (props.id) {
    case "process":
      return (
        <div className="sy-knobs rp-knobs">
          <OptionalTimeKnob label={<Term name="deadline">Deadline</Term>} name="Deadline" value={settings.timeout} unit="ms" min={100} max={120_000} onValue={10_000} onChange={(timeout) => change({ timeout })} />
          <CountKnob label={<Term name="retry">Retries</Term>} value={settings.retries} min={0} max={5} onChange={(retries) => change({ retries })} />
          <TimeKnob label="First wait between tries" value={settings.backoff} unit="ms" min={10} max={5000} onChange={(backoff) => change({ backoff })} />
        </div>
      );
    case "socket":
      return null;
    case "tcp":
      return (
        <div className="sy-knobs rp-knobs">
          <Choice
            label={<Term name="SO_KEEPALIVE" />}
            name="SO_KEEPALIVE"
            options={[
              { id: "off", label: "Off" },
              { id: "on", label: "On" },
            ]}
            value={settings.keepaliveOn ? "on" : "off"}
            onChange={(v) => change({ keepaliveOn: v === "on" })}
          />
          <TimeKnob label={<Term name="keepalive">Keepalive idle time</Term>} value={settings.keepidle} unit="s" min={1} max={7200} onChange={(keepidle) => change({ keepidle })} />
          <TimeKnob label="Probe interval" value={settings.keepintvl} unit="s" min={1} max={75} onChange={(keepintvl) => change({ keepintvl })} />
          <CountKnob label="Probes" value={settings.keepcnt} min={1} max={9} onChange={(keepcnt) => change({ keepcnt })} />
          <CountKnob label={<Term name="tcp_retries2" />} value={settings.retries2} min={1} max={15} onChange={(retries2) => change({ retries2 })} />
          <OptionalTimeKnob label={<Term name="TCP_USER_TIMEOUT" />} name="TCP_USER_TIMEOUT" value={settings.userTimeout} unit="ms" min={1000} max={1_800_000} onValue={30_000} onChange={(userTimeout) => change({ userTimeout })} />
          <TimeKnob label="Round trip" value={settings.rtt} unit="ms" min={0.1} max={300} onChange={(rtt) => change({ rtt })} />
          <Choice
            label={<Term name="HZ">Kernel clock, HZ</Term>}
            name="Kernel clock"
            options={[100, 250, 300, 1000].map((hz) => ({ id: hz, label: String(hz) }))}
            value={settings.hz}
            onChange={(hz) => change({ hz })}
          />
        </div>
      );
    case "kube":
      return (
        <div className="sy-knobs rp-knobs">
          <Choice
            label={<Term name="kube-proxy">Dataplane</Term>}
            name="Dataplane"
            options={DATAPLANES.map((id) => ({ id, label: id }))}
            value={settings.dataplane}
            onChange={(dataplane) => change({ dataplane })}
          />
          <TimeKnob label={<Term name="readiness probe">Probe period</Term>} value={settings.period} unit="s" min={1} max={60} onChange={(period) => change({ period })} />
          <CountKnob label="Failures before not ready" value={settings.threshold} min={1} max={10} onChange={(threshold) => change({ threshold })} />
          <TimeKnob label="Probe timeout" value={settings.probeTimeout} unit="s" min={1} max={30} onChange={(probeTimeout) => change({ probeTimeout })} />
          <TimeKnob label={<Term name="conntrack">conntrack timeout</Term>} value={settings.ctEstablished} unit="s" min={60} max={432_000} onChange={(ctEstablished) => change({ ctEstablished })} />
        </div>
      );
    case "nic":
      return (
        <div className="sy-knobs rp-knobs">
          <CountKnob label={<Term name="txqueuelen" />} value={settings.txqueuelen} min={10} max={10_000} onChange={(txqueuelen) => change({ txqueuelen })} />
          <Choice
            label="Link rate"
            name="Link rate"
            options={[1, 10, 25, 100].map((rate) => ({ id: rate, label: `${rate} Gbit/s` }))}
            value={valueIn(settings.rate, "Gbit/s")}
            onChange={(rate) => change({ rate: quantity(rate, "Gbit/s") })}
          />
          <Choice
            label={<Term name="MTU" />}
            name="MTU"
            options={[1500, 9000].map((mtu) => ({ id: mtu, label: `${mtu} B` }))}
            value={valueIn(settings.mtu, "B")}
            onChange={(mtu) => change({ mtu: quantity(mtu, "B") })}
          />
        </div>
      );
  }
}

// ---------------------------------------------------------------------------------------------
// the timeline
// ---------------------------------------------------------------------------------------------

type Scale = "log" | "linear";

interface Axis {
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

/** This function gives the times of the story of the path: the marks, the bands, the heal and the measured values. */
const timesOf = (result: PathResult): number[] => [
  ...result.layers.flatMap((layer) => [
    ...layer.marks.map((m) => sec(m.t)),
    ...(layer.band === null ? [] : [sec(layer.band.low), sec(layer.band.high)]),
    ...layer.measured.flatMap((m) => (m.at === null ? [] : [sec(m.at)])),
  ]),
  ...(result.heal === null ? [] : [sec(result.heal)]),
];

const axisOf = (result: PathResult, scale: Scale): Axis => {
  const all = timesOf(result).filter(Number.isFinite);
  if (scale === "linear") {
    // the linear axis ends a little after the first answer of the path: a detection or a recovery
    const answers = result.layers.flatMap((layer) => (layer.band === null || layer.verdict === "blind" ? [] : [sec(layer.band.high)]));
    const focus = Math.max(answers.length === 0 ? Math.max(...all, 1) : Math.min(...answers), result.heal === null ? 0 : sec(result.heal), 1);
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

/** the color of each kind of mark, from the tokens of the site */
const MARK_CLASS: Readonly<Record<Mark["kind"], string>> = { send: "rp-send", fire: "rp-fire", probe: "rp-probe", detect: "rp-detect", recover: "rp-recover" };

const LANE = 50;
/** the width of one character of the mono font at 11 px, for the labels of the ticks */
const CHARACTER = 6.7;
const TOP = 30;
const BOTTOM = 30;

function Timeline(props: { readonly result: PathResult; readonly scale: Scale; readonly progress: number; readonly settings: Settings }): ReactElement {
  const [ref, width] = useWidth();
  const { result, scale, progress } = props;
  const axis = useMemo(() => axisOf(result, scale), [result, scale]);
  const narrow = width < 560;
  const gutter = narrow ? 64 : 104;
  const right = 14;
  const plot = Math.max(width - gutter - right, 40);
  const X = (t: number): number => gutter + plot * Math.min(axis.x(t), 1);
  const height = TOP + LANE * result.layers.length + BOTTOM;
  const cursorX = gutter + plot * progress;
  const now = axis.t(progress);
  const seen = (t: number): boolean => axis.x(t) <= progress + 1e-9;
  // the ticks, without two grid lines closer than 46 px
  const ticks: number[] = [];
  for (const t of axis.ticks) if (ticks.length === 0 || X(t) - X(ticks.at(-1)!) >= 46) ticks.push(t);
  // the labels of the ticks: a label that would touch the label before it is dropped, and a label at the right edge ends at the edge
  const labels = spacedLabels(
    ticks.map((t) => ({ t, x: X(t), text: say(s(t)), width: say(s(t)).length * CHARACTER })),
    width,
  );
  const heal = result.heal === null ? null : sec(result.heal);
  const label = `${result.headline} The timeline shows each layer from the program to the NIC.`;

  return (
    <div ref={ref} className="rp-timeline">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        {/* the fault */}
        {heal === null ? (
          <rect className="rp-fault" x={X(0)} y={TOP - 6} width={plot} height={LANE * result.layers.length + 6} />
        ) : (
          <rect className="rp-fault" x={X(0)} y={TOP - 6} width={Math.max(X(heal) - X(0), 1)} height={LANE * result.layers.length + 6} />
        )}
        <line className="rp-fault-edge" x1={X(0)} x2={X(0)} y1={TOP - 14} y2={TOP + LANE * result.layers.length} />
        <text className="rp-fault-label" x={X(0) + 4} y={TOP - 16}>
          {heal === null ? (props.settings.fault === "stall" ? "The peer stalls at 0 s" : "The black hole starts at 0 s") : `Partition, healed at ${say(s(heal))}`}
        </text>
        {heal === null ? null : <line className="rp-fault-edge" x1={X(heal)} x2={X(heal)} y1={TOP - 6} y2={TOP + LANE * result.layers.length} />}

        {/* the grid and the axis */}
        {ticks.map((t) => (
          <line key={t} className="rp-grid" x1={X(t)} x2={X(t)} y1={TOP - 6} y2={TOP + LANE * result.layers.length} />
        ))}
        {labels.map((label) => (
          <text key={label.t} className="rp-tick" x={label.at} y={height - 10} textAnchor={label.anchor}>
            {label.text}
          </text>
        ))}

        {result.layers.map((layer, row) => (
          <Lane key={layer.id} layer={layer} row={row} X={X} seen={seen} gutter={gutter} plot={plot} narrow={narrow} end={axis.end} />
        ))}

        {/* the cursor */}
        <line className="rp-cursor" x1={cursorX} x2={cursorX} y1={TOP - 6} y2={TOP + LANE * result.layers.length + 4} />
        <text className="rp-cursor-label" x={Math.min(Math.max(cursorX, gutter + 30), width - right - 30)} y={TOP + LANE * result.layers.length + 16} textAnchor="middle">
          {progress >= 1 ? "" : say(s(now))}
        </text>
      </svg>
    </div>
  );
}

function Lane(props: {
  readonly layer: LayerResult;
  readonly row: number;
  readonly X: (t: number) => number;
  readonly seen: (t: number) => boolean;
  readonly gutter: number;
  readonly plot: number;
  readonly narrow: boolean;
  readonly end: number;
}): ReactElement {
  const { layer, row, X, seen, gutter, plot } = props;
  const y = TOP + LANE * row + LANE / 2;
  const band = layer.band;
  const lit = band !== null && layer.verdict !== "blind" && seen(sec(band.low));
  const inside = (t: number): boolean => t <= props.end;
  const later = layer.marks.filter((m) => !inside(sec(m.t))).length;
  const bandText = band === null ? null : layer.verdict === "recovers" ? `recovers ${say(band.low)}` : `knows ${say(band.low)}`;
  return (
    <g className="rp-lane" data-verdict={layer.verdict} data-lit={lit ? "true" : undefined}>
      <rect className="rp-lane-bg" x={0} y={y - LANE / 2} width={gutter + plot + 14} height={LANE} />
      <text className="rp-lane-name" x={8} y={y + 4}>
        {props.narrow ? SHORT[layer.id] : LANE_NAMES[layer.id]}
      </text>
      <line className="rp-lane-line" x1={gutter} x2={gutter + plot} y1={y} y2={y} />
      {layer.verdict === "blind" || layer.verdict === "silent" ? (
        <text className="rp-lane-note" x={gutter + 8} y={y - 10}>
          {layer.verdict === "blind" ? "cannot see the fault" : "never knows"}
        </text>
      ) : null}
      {band === null || layer.verdict === "blind" ? null : (
        <g className={layer.verdict === "recovers" ? "rp-band rp-band-recover" : "rp-band"} opacity={lit ? 1 : 0.25}>
          <rect x={X(sec(band.low))} y={y - 9} width={Math.max(X(sec(band.high)) - X(sec(band.low)), 3)} height={18} rx={2}>
            <title>{`${layerName(layer.id)}: ${sayBand(band)}`}</title>
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
      {layer.marks.filter((m) => inside(sec(m.t))).map((m, n) => (
        <MarkGlyph key={n} mark={m} x={X(sec(m.t))} y={y} seen={seen(sec(m.t))} />
      ))}
      {layer.measured.flatMap((m, n) =>
        m.at === null || !inside(sec(m.at)) ? [] : [
          <circle key={`m${n}`} className="rp-measured" cx={X(sec(m.at))} cy={y} r={4.5} opacity={seen(sec(m.at)) ? 1 : 0.2}>
            <title>{`Measured, ${m.cell}: ${m.measured}`}</title>
          </circle>,
        ],
      )}
      {later === 0 && (band === null || inside(sec(band.low)) || layer.verdict === "blind") ? null : (
        <text className="rp-later" x={gutter + plot} y={y + 4} textAnchor="end">
          {band !== null && layer.verdict !== "blind" && !inside(sec(band.low)) ? `${say(band.low)} →` : `+${later} →`}
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

/** This hook plays the timeline: a progress from 0 to 1 in PLAY milliseconds. */
const usePlayer = (): { progress: number; playing: boolean; play: () => void; pause: () => void; seek: (p: number) => void } => {
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
  return { progress, playing, play, pause, seek };
};

// ---------------------------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------------------------

const VERDICT_TEXT = (layer: LayerResult): string => {
  if (layer.verdict === "detects" && layer.band !== null) return `Knows at ${sayBand(layer.band)}`;
  if (layer.verdict === "recovers" && layer.band !== null) return `Recovers at ${sayBand(layer.band)}`;
  if (layer.verdict === "silent") return "Never knows";
  return "Cannot see it";
};

const LAYER_TERMS: Readonly<Partial<Record<LayerId, TermName>>> = { socket: "socket", tcp: "RTO", kube: "kube-proxy", nic: "NIC" };

function LayerCard(props: { readonly layer: LayerResult; readonly lit: boolean; readonly settings: Settings; readonly change: (next: Partial<Settings>) => void; readonly first: boolean }): ReactElement {
  const { layer } = props;
  const term = LAYER_TERMS[layer.id];
  return (
    <section className="rp-card" data-verdict={layer.verdict} data-lit={props.lit ? "true" : undefined} aria-label={layerName(layer.id)}>
      <header className="rp-card-head">
        <h3>
          {layerName(layer.id)}
          {term === undefined ? null : (
            <span className="rp-card-term">
              <Term name={term}>?</Term>
            </span>
          )}
        </h3>
        <span className="rp-chip" data-verdict={layer.verdict}>
          {props.first ? "First · " : ""}
          {VERDICT_TEXT(layer)}
        </span>
      </header>
      <p className="rp-summary">{layer.summary}</p>
      {layer.warning === null ? null : (
        <p className="rp-warning" role="note">
          {layer.warning}
        </p>
      )}
      {layer.facts.length === 0 ? null : (
        <dl className="rp-facts">
          {layer.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {layer.measured.length === 0 ? null : (
        <ul className="rp-measured-list">
          {layer.measured.map((m) => (
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
      <LayerKnobs id={layer.id} settings={props.settings} change={props.change} />
    </section>
  );
}

export default function RequestPath(): ReactElement {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [preset, setPreset] = useState<string | null>("defaults");
  const [scale, setScale] = useState<Scale>("log");
  const [table, setTable] = useState(false);
  const result = useMemo(() => requestPath(settings), [settings]);
  const player = usePlayer();
  const axis = useMemo(() => axisOf(result, scale), [result, scale]);

  const change = (next: Partial<Settings>): void => {
    setSettings((now) => ({ ...now, ...next }));
    setPreset(null);
  };
  const restart = (): void => {
    player.seek(0);
    player.play();
  };
  const load = (id: string): void => {
    const found = PRESETS.find((p) => p.id === id);
    if (found === undefined) return;
    setSettings(found.settings);
    setPreset(id);
    restart();
  };

  const litOf = (layer: LayerResult): boolean => layer.band !== null && layer.verdict !== "blind" && axis.x(sec(layer.band.low)) <= player.progress + 1e-9;
  const note = PRESETS.find((p) => p.id === preset)?.note ?? null;
  const events = result.layers
    .flatMap((layer) => [
      ...layer.marks.map((m) => ({ layer: layer.id, what: m.label, t: sec(m.t) })),
      ...layer.measured.flatMap((m) => (m.at === null ? [] : [{ layer: layer.id, what: `Measured median, ${m.cell}`, t: sec(m.at) }])),
    ])
    .sort((a, b) => a.t - b.t);

  return (
    <div className="rp not-content">
      <section className="sy-frame rp-stage" aria-label="The path of one request">
        <header className="sy-head">
          <div className="sy-title">
            <strong>Who knows first?</strong>
          </div>
          <div className="sy-row" role="group" aria-label="Presets">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className="sy-button" aria-pressed={preset === p.id} onClick={() => load(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </header>

        <div className="rp-controls">
          <div className="sy-knob">
            <span>The fault</span>
            <span className="sy-switch" role="group" aria-label="The fault">
              {FAULTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={settings.fault === f.id}
                  onClick={() => {
                    change({ fault: f.id });
                    restart();
                  }}
                >
                  {f.label}
                </button>
              ))}
            </span>
          </div>
          <div className="sy-knob">
            <span>The request</span>
            <span className="sy-switch" role="group" aria-label="The request">
              <button
                type="button"
                aria-pressed={settings.inFlight}
                onClick={() => {
                  change({ inFlight: true });
                  restart();
                }}
              >
                In flight
              </button>
              <button
                type="button"
                aria-pressed={!settings.inFlight}
                onClick={() => {
                  change({ inFlight: false });
                  restart();
                }}
              >
                Idle connection
              </button>
            </span>
          </div>
          {settings.fault === "partition" ? <TimeKnob label="The partition lasts" value={settings.heal} unit="s" min={0.2} max={120} onChange={(heal) => change({ heal })} /> : null}
        </div>

        <div className="rp-headline" aria-live="polite">
          <p>{result.headline}</p>
          {note === null ? null : <p className="sy-muted">{note}</p>}
        </div>

        <div className="rp-player">
          <button type="button" className="sy-button" onClick={player.playing ? player.pause : player.progress >= 1 ? restart : player.play}>
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

        <div className="sy-body">
          <Timeline result={result} scale={scale} progress={player.progress} settings={settings} />
          <ul className="rp-legend" aria-label="Legend">
            <li>
              <span className="rp-key rp-key-fault" /> the fault
            </li>
            <li>
              <span className="rp-key rp-key-band" /> the layer knows, in this band
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
          <p className="sy-caption">{scale === "log" ? "The axis is logarithmic, thus the first second and the last hour both fit." : "The axis is linear, up to the first answer. An arrow at the right edge shows a later event."}</p>
          {table ? (
            <div className="sy-scroll">
              <table className="sy-table">
                <thead>
                  <tr>
                    <th>Layer</th>
                    <th>Event</th>
                    <th className="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, n) => (
                    <tr key={n}>
                      <td>{layerName(e.layer)}</td>
                      <td>{e.what}</td>
                      <td className="num">{say(s(e.t))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>

      <ol className="rp-stack" aria-label="The layers, from the program down to the NIC">
        {result.layers.map((layer) => (
          <li key={layer.id}>
            <LayerCard layer={layer} lit={litOf(layer)} settings={settings} change={change} first={result.first?.layer === layer.id} />
          </li>
        ))}
      </ol>
    </div>
  );
}
