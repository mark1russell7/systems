/**
 * A strip chart on one time axis. It shows a predicted band, the closed form, the nominal firings of a
 * timer and the measured runs. Each page of results draws its runs with this chart, thus each mark has
 * one meaning on the whole site:
 *
 * - the band of the prediction: a blue wash between two blue edges
 * - a counted run: an orange dot
 * - a warm-up run, which the verdict does not count: an open orange dot
 * - an event of the kernel, for example a keepalive probe: an aqua diamond on the bottom row
 * - the median: a dashed line in ink.
 *
 * The chart draws at its real width in pixels, so its text stays at its real size on a narrow page. A
 * pointer over the chart, or the arrow keys on the focused chart, show the value of the nearest mark.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import { reading, ticksBetween } from "../lib/format.ts";

/** A point is one run on the chart. Without names of rows, the chart puts the runs on lanes, thus they do not cover each other. */
export interface Point {
  readonly t: number;
  readonly row: number;
  readonly label: string;
}

/** The data of a strip, before its axis. Each time is in milliseconds. */
export interface StripData {
  readonly band?: { readonly low: number; readonly high: number } | undefined;
  readonly closed?: number | undefined;
  /** the nominal firings of the timer, on the bottom row */
  readonly marks?: ReadonlyArray<{ readonly t: number; readonly label: string }> | undefined;
  readonly runs?: readonly Point[] | undefined;
  /** the warm-up runs, which the verdict does not count, as open dots */
  readonly warmups?: readonly Point[] | undefined;
  /** the names of the rows of runs, at the left edge */
  readonly rows?: readonly string[] | undefined;
  /** dashed lines with a label, for example the median */
  readonly lines?: ReadonlyArray<{ readonly t: number; readonly label: string }> | undefined;
}

export interface StripProps extends StripData {
  /** the start and the end of the axis, in milliseconds */
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

const PAD = 12;
/** the smallest width of the names of the rows, at the left edge */
const GUTTER = 36;
/** the width of one character in the mono font at 11 px */
const CHARACTER = 6.7;
/** the space between two rows with names */
const ROW = 20;
/** the space between two lanes of runs without names */
const LANE = 13;
/** the offsets of the lanes from the middle lane, in the sequence that the runs fill them */
const LANES = [0, -1, 1] as const;
/** the radius of the dot of a run */
const DOT = 4;
/** the distance from the pointer to a mark, in pixels, inside which the mark is the target */
const REACH = 16;

/** This hook gives the width of an element in pixels, and follows each change of the width. */
export const useWidth = (): [React.RefObject<HTMLDivElement | null>, number] => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
};

/** A target is a mark that the tooltip can name: its place on the chart, its value and its label. */
interface Target {
  readonly x: number;
  readonly y: number;
  readonly value: string;
  readonly label: string;
  readonly kind: "run" | "warmup" | "mark" | "line" | "band" | "closed";
}

/** This function puts each run on a lane: the first lane where it does not cover a run before it. */
const lanesOf = (xs: readonly number[]): number[] => {
  const order = xs.map((x, n) => ({ x, n })).sort((a, b) => a.x - b.x);
  const last = LANES.map(() => -Infinity);
  const lane = new Array<number>(xs.length).fill(0);
  for (const { x, n } of order) {
    const free = last.findIndex((at) => x - at >= 2 * DOT + 3);
    const k = free >= 0 ? free : last.indexOf(Math.min(...last));
    lane[n] = k;
    last[k] = x;
  }
  return lane;
};

export default function Strip(props: StripProps): ReactElement {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const { from, to } = props;
  const named = props.rows !== undefined;
  const inside = (t: number): boolean => t >= from && t <= to;
  const runs = (props.runs ?? []).filter((run) => inside(run.t));
  const warmups = (props.warmups ?? []).filter((run) => inside(run.t));
  const marks = (props.marks ?? []).filter((mark) => inside(mark.t));
  const lines = (props.lines ?? []).filter((line) => inside(line.t));
  const top = props.closed === undefined ? 8 : 22;
  const count = props.rows?.length ?? LANES.length;
  // a longer name of a row makes a wider gutter, thus the name does not meet the first run
  const gutter = Math.max(GUTTER, ...(props.rows ?? []).map((name) => Math.ceil(name.length * CHARACTER) + 12));
  const left = named ? PAD + gutter : PAD;
  const middle = top + 12 + LANE;
  const rowY = (row: number): number => (named ? top + 14 + row * ROW : middle + LANES[row % LANES.length]! * LANE);
  const runsBottom = named ? rowY(count - 1) + 12 : middle + LANE + 12;
  const axis = runsBottom + (marks.length > 0 ? 16 : 2);
  const height = axis + 22;
  const x = (t: number): number => left + ((width - left - PAD) * (t - from)) / (to - from);
  const ticks = ticksBetween(from, to, Math.max(3, Math.floor((width - left) / 96)));

  // without names, the runs and the warm-ups share the lanes
  const lanes = named ? [] : lanesOf([...runs, ...warmups].map((run) => x(run.t)));
  const yOf = (run: Point, n: number): number => (named ? rowY(run.row) : rowY(lanes[n] ?? 0));
  const eventY = axis - 9;

  const dots: Target[] = [
    ...runs.map((run, n): Target => ({ x: x(run.t), y: yOf(run, n), value: reading(run.t), label: run.label, kind: "run" })),
    ...warmups.map((run, n): Target => ({ x: x(run.t), y: yOf(run, runs.length + n), value: reading(run.t), label: `${run.label}, not counted`, kind: "warmup" })),
    ...marks.map((mark): Target => ({ x: x(mark.t), y: eventY, value: reading(mark.t), label: mark.label, kind: "mark" })),
  ].sort((a, b) => a.x - b.x);
  const bandLow = props.band === undefined ? 0 : x(Math.max(from, props.band.low));
  const bandHigh = props.band === undefined ? 0 : Math.max(bandLow + 2, x(Math.min(to, props.band.high)));
  const others: Target[] = [
    ...lines.map((line): Target => ({ x: x(line.t), y: top + 6, value: reading(line.t), label: line.label, kind: "line" })),
    ...(props.closed === undefined || !inside(props.closed) ? [] : [{ x: x(props.closed), y: top, value: reading(props.closed), label: "The closed form", kind: "closed" } as Target]),
    ...(props.band === undefined ? [] : [{ x: (bandLow + bandHigh) / 2, y: top, value: `${reading(props.band.low)} to ${reading(props.band.high)}`, label: "The prediction", kind: "band" } as Target]),
  ];
  const targets = [...dots, ...others];

  /** This function finds the target nearest to a point of the chart: a dot, then a line, then the band. */
  const nearest = (px: number, py: number): number | null => {
    let best: number | null = null;
    let distance = REACH;
    dots.forEach((dot, n) => {
      const d = Math.hypot(dot.x - px, dot.y - py);
      if (d <= distance) [best, distance] = [n, d];
    });
    if (best !== null) return best;
    if (py > axis + 4) return null;
    const line = others.findIndex((other) => (other.kind === "line" || other.kind === "closed") && Math.abs(other.x - px) <= 5);
    if (line >= 0) return dots.length + line;
    const band = others.findIndex((other) => other.kind === "band");
    if (band >= 0 && py >= top && px >= bandLow - 2 && px <= bandHigh + 2) return dots.length + band;
    return null;
  };

  const onMove = (event: PointerEvent<SVGSVGElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = width / box.width;
    setActive(nearest((event.clientX - box.left) * scale, (event.clientY - box.top) * scale));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") setActive(null);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0 || dots.length === 0) return;
    event.preventDefault();
    const now = active === null || active >= dots.length ? (step > 0 ? -1 : dots.length) : active;
    setActive(Math.min(dots.length - 1, Math.max(0, now + step)));
  };

  const target = active === null ? undefined : targets[active];
  // the tooltip is at most 224 px wide, and it stays inside the chart
  const margin = Math.min(114, width / 2);
  const tipX = target === undefined ? 0 : Math.min(width - margin, Math.max(margin, target.x));
  return (
    <div ref={ref} className="sy-strip" tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.label} onPointerMove={onMove} onPointerLeave={() => setActive(null)}>
        {ticks.values.map((t) => (
          <line key={`grid ${t}`} className="sy-grid" x1={x(t)} x2={x(t)} y1={top} y2={axis} />
        ))}
        {props.band === undefined ? null : (
          <g className="sy-band" data-active={target?.kind === "band" ? "" : undefined}>
            <rect x={bandLow} y={top} width={bandHigh - bandLow} height={axis - top} />
            <line x1={bandLow} x2={bandLow} y1={top} y2={axis} />
            <line x1={bandHigh} x2={bandHigh} y1={top} y2={axis} />
          </g>
        )}
        {(props.rows ?? []).map((name, row) => (
          <text key={name} className="sy-row-name" x={PAD} y={rowY(row) + 4}>
            {name}
          </text>
        ))}
        {props.closed === undefined || !inside(props.closed) ? null : (
          <g className="sy-closed">
            <line x1={x(props.closed)} x2={x(props.closed)} y1={top - 4} y2={axis} />
            <text x={Math.min(width - 40, Math.max(40, x(props.closed)))} y={top - 9} textAnchor="middle">
              closed form
            </text>
          </g>
        )}
        {lines.map((line) => (
          <line key={line.label} className="sy-median" x1={x(line.t)} x2={x(line.t)} y1={top} y2={axis} />
        ))}
        {marks.map((mark) => {
          const cx = x(mark.t);
          return <path key={mark.label} className="sy-event" d={`M${cx} ${eventY - 5}L${cx + 5} ${eventY}L${cx} ${eventY + 5}L${cx - 5} ${eventY}Z`} />;
        })}
        {warmups.map((run, n) => (
          <circle key={`warm-up ${n}`} className="sy-warmup" cx={x(run.t)} cy={yOf(run, runs.length + n)} r={DOT - 0.5} />
        ))}
        {runs.map((run, n) => (
          <circle key={n} className="sy-run" cx={x(run.t)} cy={yOf(run, n)} r={DOT} />
        ))}
        <line className="sy-axis-line" x1={left} x2={width - PAD} y1={axis} y2={axis} />
        {ticks.values.map((t) => {
          const text = `${Number((t / ticks.unit.ms).toPrecision(6))} ${ticks.unit.name}`;
          // a label at an edge of the chart ends at that edge, thus it stays in the chart
          const half = (text.length * CHARACTER) / 2;
          const anchor = x(t) + half > width ? "end" : x(t) - half < 0 ? "start" : "middle";
          const at = anchor === "end" ? width : anchor === "start" ? 0 : x(t);
          return (
            <g key={t} className="sy-tick">
              <line x1={x(t)} x2={x(t)} y1={axis} y2={axis + 4} />
              <text x={at} y={axis + 16} textAnchor={anchor}>
                {text}
              </text>
            </g>
          );
        })}
        {target === undefined || active === null || active >= dots.length ? null : <circle className="sy-focus" cx={target.x} cy={target.y} r={DOT + 3} />}
      </svg>
      {target === undefined ? null : (
        <div className="sy-tip" style={{ left: tipX, top: Math.max(0, target.y - 12) }}>
          <strong>{target.value}</strong>
          <span>{target.label}</span>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {target === undefined ? "" : `${target.label}: ${target.value}`}
      </p>
    </div>
  );
}
