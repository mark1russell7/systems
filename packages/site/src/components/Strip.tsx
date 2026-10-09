/**
 * A strip chart on one time axis. It shows a predicted band, the closed form, the nominal firings of a
 * timer and the measured runs. The chart draws at its real width in pixels, so its text stays at its real
 * size on a narrow page.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { duration, ticksBetween } from "../lib/format.ts";

export interface StripProps {
  /** the start and the end of the axis, in milliseconds */
  readonly from: number;
  readonly to: number;
  readonly band?: { readonly low: number; readonly high: number } | undefined;
  readonly closed?: number | undefined;
  /** the nominal firings of the timer, on the bottom row */
  readonly marks?: ReadonlyArray<{ readonly t: number; readonly label: string }>;
  /** the measured runs, on one row for each environment */
  readonly runs?: ReadonlyArray<{ readonly t: number; readonly row: number; readonly label: string }>;
  /** dashed lines with a label, for example the median */
  readonly lines?: ReadonlyArray<{ readonly t: number; readonly label: string }>;
  readonly label: string;
}

const HEIGHT = 118;
const AXIS = 92;
const PAD = 14;

/** This hook gives the width of an element in pixels, and follows each change of the width. */
const useWidth = (): [React.RefObject<HTMLDivElement | null>, number] => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
};

export default function Strip(props: StripProps): ReactElement {
  const [ref, width] = useWidth();
  const { from, to } = props;
  const x = (t: number): number => PAD + ((width - 2 * PAD) * (t - from)) / (to - from);
  const inside = (t: number): boolean => t >= from && t <= to;
  const ticks = ticksBetween(from, to, Math.max(3, Math.floor(width / 110)));
  return (
    <div ref={ref} className="sy-strip">
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={props.label}>
        {props.band === undefined ? null : (
          <rect x={x(Math.max(from, props.band.low))} y={16} width={Math.max(3, x(Math.min(to, props.band.high)) - x(Math.max(from, props.band.low)))} height={AXIS - 26} rx={4} fill="var(--color-accent-wash)" stroke="var(--color-accent)">
            <title>{`The prediction: ${duration(props.band.low)} to ${duration(props.band.high)}`}</title>
          </rect>
        )}
        {props.closed === undefined || !inside(props.closed) ? null : (
          <g>
            <line x1={x(props.closed)} x2={x(props.closed)} y1={12} y2={AXIS} stroke="var(--color-accent)" strokeWidth={2} />
            <text x={x(props.closed)} y={10} textAnchor="middle">closed form</text>
          </g>
        )}
        {(props.lines ?? []).filter((line) => inside(line.t)).map((line) => (
          <line key={line.label} x1={x(line.t)} x2={x(line.t)} y1={20} y2={AXIS - 6} stroke="var(--color-ink)" strokeWidth={1.5} strokeDasharray="3 3">
            <title>{`${line.label}: ${duration(line.t)}`}</title>
          </line>
        ))}
        {(props.marks ?? []).filter((mark) => inside(mark.t)).map((mark) => (
          <circle key={mark.label} cx={x(mark.t)} cy={AXIS - 12} r={4} fill="var(--series-1)" stroke="var(--color-surface)" strokeWidth={2}>
            <title>{`${mark.label}: ${duration(mark.t)}`}</title>
          </circle>
        ))}
        {(props.runs ?? []).filter((run) => inside(run.t)).map((run, n) => (
          <circle key={n} cx={x(run.t)} cy={run.row === 0 ? 36 : 56} r={4.5} fill="var(--series-2)" stroke="var(--color-surface)" strokeWidth={2}>
            <title>{`${run.label}: ${duration(run.t)}`}</title>
          </circle>
        ))}
        <line className="sy-grid" x1={PAD} x2={width - PAD} y1={AXIS} y2={AXIS} />
        {ticks.values.map((t) => (
          <g key={t} className="sy-axis">
            <line x1={x(t)} x2={x(t)} y1={AXIS} y2={AXIS + 5} />
            <text x={x(t)} y={AXIS + 18} textAnchor="middle">{`${Number((t / ticks.unit.ms).toPrecision(6))} ${ticks.unit.name}`}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
