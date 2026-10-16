/**
 * The legend of a strip chart: each swatch beside its label, in the order of the marks. The legend of a
 * chart comes from the data of the chart (`keysOf`), thus it names only the marks that the chart draws.
 */
import type { ReactElement } from "react";
import type { StripData } from "./Strip.tsx";

/** The keys of a legend: each kind of mark that a chart draws. */
export interface LegendKeys {
  readonly band?: boolean | undefined;
  readonly closed?: boolean | undefined;
  /** the name of the events of the kernel, for example "Keepalive probes" */
  readonly marks?: string | undefined;
  readonly runs?: boolean | undefined;
  readonly warmups?: boolean | undefined;
  /** the name of the dashed line, for example "Median" */
  readonly line?: string | undefined;
}

/** This function gives the keys of the legend of one or more charts that share an axis. */
export const keysOf = (plots: ReadonlyArray<StripData | null>, names: { readonly marks?: string; readonly line?: string } = {}): LegendKeys => {
  const drawn = plots.filter((plot): plot is StripData => plot !== null);
  return {
    band: drawn.some((plot) => plot.band !== undefined),
    closed: drawn.some((plot) => plot.closed !== undefined),
    marks: drawn.some((plot) => (plot.marks ?? []).length > 0) ? (names.marks ?? "Events of the kernel") : undefined,
    runs: drawn.some((plot) => (plot.runs ?? []).length > 0),
    warmups: drawn.some((plot) => (plot.warmups ?? []).length > 0),
    line: drawn.some((plot) => (plot.lines ?? []).length > 0) ? (names.line ?? "Median") : undefined,
  };
};

export default function Legend(props: LegendKeys): ReactElement | null {
  const items: Array<{ readonly key: string; readonly swatch: ReactElement; readonly text: string }> = [];
  if (props.band === true)
    items.push({
      key: "band",
      text: "Prediction",
      swatch: (
        <svg width="18" height="12" aria-hidden="true">
          <rect className="sy-band-fill" x="1" y="0" width="16" height="12" />
          <path className="sy-band-edge" d="M1 0v12M17 0v12" />
        </svg>
      ),
    });
  if (props.closed === true)
    items.push({
      key: "closed",
      text: "Closed form",
      swatch: (
        <svg width="10" height="12" aria-hidden="true">
          <path className="sy-closed-line" d="M5 0v12" />
        </svg>
      ),
    });
  if (props.runs === true)
    items.push({
      key: "runs",
      text: "Counted run",
      swatch: (
        <svg width="12" height="12" aria-hidden="true">
          <circle className="sy-run" cx="6" cy="6" r="4" />
        </svg>
      ),
    });
  if (props.warmups === true)
    items.push({
      key: "warmups",
      text: "Warm-up, not counted",
      swatch: (
        <svg width="12" height="12" aria-hidden="true">
          <circle className="sy-warmup" cx="6" cy="6" r="3.5" />
        </svg>
      ),
    });
  if (props.marks !== undefined)
    items.push({
      key: "marks",
      text: props.marks,
      swatch: (
        <svg width="12" height="12" aria-hidden="true">
          <path className="sy-event" d="M6 1 11 6 6 11 1 6Z" />
        </svg>
      ),
    });
  if (props.line !== undefined)
    items.push({
      key: "line",
      text: props.line,
      swatch: (
        <svg width="10" height="12" aria-hidden="true">
          <path className="sy-median" d="M5 0v12" />
        </svg>
      ),
    });
  if (items.length === 0) return null;
  return (
    <ul className="sy-legend" aria-label="Legend">
      {items.map((item) => (
        <li key={item.key}>
          {item.swatch}
          {item.text}
        </li>
      ))}
    </ul>
  );
}
