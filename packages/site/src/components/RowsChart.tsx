/**
 * A chart of rows on one axis of seconds, and its figure with a table view. Each row has a name, a number at
 * the right and a dot for each counted run. A row can also have a dashed median, a shaded band and a mark.
 *
 * A pointer over a dot, a tap or the focus shows the run. The table view gives the same runs as rows.
 */
import { useState, type MouseEvent, type PointerEvent, type ReactElement, type ReactNode } from "react";
import { count, countTicks, duration, spacedLabels } from "../lib/format.ts";
import { LANES, lanesOf, useWidth } from "./Strip.tsx";

/** One counted run on a row. */
export interface RowDot {
  readonly key: string;
  /** The place of the dot on the axis, in seconds. */
  readonly at: number;
  /** A hollow dot is a run in which the event of the chart did not occur. */
  readonly hollow?: boolean;
  /** The line of the dot on a row with `tracks`. */
  readonly track?: number;
  /** The first line of the tooltip. */
  readonly value: string;
  /** The second line of the tooltip. */
  readonly text: string;
}

/** One row of the chart. */
export interface ChartRow {
  readonly id: string;
  readonly label: string;
  /** The number at the right of the row. */
  readonly right: string;
  readonly median?: number;
  readonly band?: { readonly low: number; readonly high: number };
  /** A solid line at this place on the axis, in seconds. */
  readonly mark?: number;
  /** With this count, each dot goes on its `track`, thus each run has a line of its own. */
  readonly tracks?: number;
  readonly dots: readonly RowDot[];
}

/** This function writes a time in seconds, to the hundredth. */
export const timeText = (seconds: number): string => duration(Math.round(seconds * 100) * 10);

const PAD = 12;
/** the height of the line above a row: the name of the row and its number */
const HEAD = 18;
const ROW = 26;
const AFTER = 8;
const DOT = 4;
/** the distance between two lanes of dots */
const LANE = 7;
/** the distance between two tracks of a row with tracks */
const TRACK = 10;
const REACH = 16;
/** the width of one character in the mono font at 11 px */
const CHARACTER = 6.7;

interface Placed {
  readonly row: ChartRow;
  readonly top: number;
  readonly height: number;
}

interface PlacedDot {
  readonly row: ChartRow;
  readonly dot: RowDot;
  readonly x: number;
  readonly y: number;
}

/** This component draws the rows. `to` is the end of the axis in seconds, and `label` tells a screen reader what the chart holds. */
export function RowsChart(props: { readonly rows: readonly ChartRow[]; readonly to: number; readonly label: string }): ReactElement {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const { rows, to, label } = props;
  const left = PAD;
  const right = width - PAD;
  const x = (seconds: number): number => left + ((right - left) * seconds) / to;

  const placed: Placed[] = [];
  let next = 0;
  for (const row of rows) {
    const height = row.tracks === undefined ? ROW : row.tracks * TRACK;
    placed.push({ row, top: next + HEAD, height });
    next += HEAD + height + AFTER;
  }
  const axis = next;
  const height = axis + 24;
  const ticks = countTicks(0, to, Math.max(4, Math.floor((right - left) / 72)));
  const labels = spacedLabels(
    ticks.map((t) => ({ t, x: x(t), text: `${count(t)} s`, width: (count(t).length + 2) * CHARACTER })),
    width,
  );

  const dots: PlacedDot[] = placed.flatMap(({ row, top, height: rowHeight }) => {
    const middle = top + rowHeight / 2;
    const lanes = lanesOf(
      row.dots.map((dot) => x(dot.at)),
      2 * DOT + 2,
    );
    return row.dots.map((dot, k): PlacedDot => {
      const y = row.tracks === undefined || dot.track === undefined ? middle + LANES[lanes[k] ?? 0]! * LANE : middle + (dot.track - (row.tracks - 1) / 2) * TRACK;
      return { row, dot, x: x(dot.at), y };
    });
  });

  const pointAt = (event: PointerEvent<SVGSVGElement> | MouseEvent<SVGSVGElement>): number | null => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = width / box.width;
    const px = (event.clientX - box.left) * scale;
    const py = (event.clientY - box.top) * scale;
    let best: number | null = null;
    let distance = REACH;
    dots.forEach((dot, n) => {
      const d = Math.hypot(dot.x - px, dot.y - py);
      if (d <= distance) [best, distance] = [n, d];
    });
    return best;
  };
  const onMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (event.pointerType === "mouse") setActive(pointAt(event));
  };

  const target = active === null ? undefined : dots[active];
  const margin = Math.min(114, width / 2);
  const tipX = target === undefined ? 0 : Math.min(width - margin, Math.max(margin, target.x));
  return (
    <div ref={ref} className="sy-strip" onBlur={() => setActive(null)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setActive(null)} onClick={(event) => setActive(pointAt(event))}>
        {placed.map(({ row, top, height: rowHeight }) =>
          row.band === undefined ? null : <rect key={`band ${row.id}`} className="sy-rows-band" x={x(row.band.low)} y={top} width={x(row.band.high) - x(row.band.low)} height={rowHeight} />,
        )}
        {ticks.map((t) => (
          <line key={`grid ${t}`} className="sy-grid" x1={x(t)} x2={x(t)} y1={HEAD - 4} y2={axis} />
        ))}
        {placed.map(({ row, top, height: rowHeight }) => (
          <g key={row.id}>
            <text className="sy-rows-name" x={left} y={top - 6}>
              {row.label}
            </text>
            <text x={right} y={top - 6} textAnchor="end">
              {row.right}
            </text>
            {row.median === undefined ? null : <line className="sy-median" x1={x(row.median)} x2={x(row.median)} y1={top} y2={top + rowHeight} />}
            {row.mark === undefined ? null : <line className="sy-rows-mark" x1={x(row.mark)} x2={x(row.mark)} y1={top} y2={top + rowHeight} />}
          </g>
        ))}
        {dots.map((each, n) => (
          <circle
            key={`${each.row.id} ${each.dot.key}`}
            className={each.dot.hollow === true ? "sy-run-hollow" : "sy-run"}
            cx={each.x}
            cy={each.y}
            r={DOT}
            tabIndex={0}
            role="img"
            aria-label={`${each.dot.value}. ${each.dot.text}`}
            onFocus={() => setActive(n)}
          />
        ))}
        <line className="sy-axis-line" x1={left} x2={right} y1={axis} y2={axis} />
        {ticks.map((t) => (
          <g key={t} className="sy-tick">
            <line x1={x(t)} x2={x(t)} y1={axis} y2={axis + 4} />
          </g>
        ))}
        {labels.map((each) => (
          <text key={each.t} x={each.at} y={axis + 16} textAnchor={each.anchor}>
            {each.text}
          </text>
        ))}
        {target === undefined ? null : <circle className="sy-focus" cx={target.x} cy={target.y} r={DOT + 3} />}
      </svg>
      {target === undefined ? null : (
        <div className="sy-tip" style={{ left: tipX, top: Math.max(0, target.y - 12) }}>
          <strong>{target.dot.value}</strong>
          <span>{target.dot.text}</span>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {target === undefined ? "" : `${target.dot.value}. ${target.dot.text}`}
      </p>
    </div>
  );
}

/** This component gives the chart of the rows and a table view of the same runs, with a caption. */
export function RowsFigure(props: { readonly rows: readonly ChartRow[]; readonly to: number; readonly label: string; readonly legend?: ReactNode; readonly table: ReactElement; readonly caption: ReactNode }): ReactElement {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <figure className="sy-rows-figure not-content">
      <div className="sy-row">
        <span className="sy-switch" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>
            Chart
          </button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
            Table
          </button>
        </span>
      </div>
      {view === "chart" ? <RowsChart rows={props.rows} to={props.to} label={props.label} /> : props.table}
      {view === "chart" ? props.legend : null}
      <figcaption>{props.caption}</figcaption>
    </figure>
  );
}
