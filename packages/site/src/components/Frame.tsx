/**
 * The frame of one result. Each page of results shows each cell in this frame, thus a cell has one layout
 * on the whole site. The frame has a head with the name, the tag and the verdicts. A readout of the main
 * numbers comes next. Then the frame has the chart or the table of the runs, the legend and the text.
 *
 * A frame with a chart and a table has a switch between the two views. A frame with only a table has a
 * button that shows the table.
 */
import { useState, type ReactElement, type ReactNode } from "react";
import { statusOf } from "./Verdict.tsx";

/** A view is what the frame shows above its text: the chart or the table of the runs. */
export type View = "chart" | "table";

/** One item of a readout: a short label and its value. */
export interface ReadoutItem {
  readonly label: string;
  readonly value: ReactNode;
}

/** The readout of a result: the main numbers in one row, as an instrument shows them. */
export function Readout(props: { readonly items: readonly ReadoutItem[] }): ReactElement | null {
  if (props.items.length === 0) return null;
  return (
    <dl className="sy-readout">
      {props.items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface FrameProps {
  /** the name of the result, in the head */
  readonly name: ReactNode;
  /** the accessible name of the frame */
  readonly label: string;
  /** the ID of the cell in its plan or catalog, or null */
  readonly tag?: string | null | undefined;
  /** the chips of the verdicts */
  readonly verdicts?: ReactNode;
  /** the main decision of the result: it gives the color of the rule at the edge of the frame */
  readonly decision?: string | undefined;
  readonly readout?: readonly ReadoutItem[] | undefined;
  /** the views that the frame has */
  readonly views?: readonly View[] | undefined;
  /** This function gives the chart or the table, for the view that the reader selected. */
  readonly render?: ((view: View) => ReactNode) | undefined;
  readonly children?: ReactNode;
}

export default function Frame(props: FrameProps): ReactElement {
  const views = props.views ?? [];
  const chart = views.includes("chart");
  const [view, setView] = useState<View>(chart ? "chart" : "table");
  const [open, setOpen] = useState(false);
  const shown: View | null = chart ? view : open ? "table" : null;
  return (
    <section className="sy-frame not-content" aria-label={props.label} data-status={props.decision === undefined ? undefined : statusOf(props.decision)}>
      <header className="sy-head">
        <div className="sy-title">
          <strong>{props.name}</strong>
          {props.tag === null || props.tag === undefined ? null : <code className="sy-tag">{props.tag}</code>}
        </div>
        <div className="sy-row">
          {props.verdicts}
          {chart && views.includes("table") ? (
            <span className="sy-switch" role="group" aria-label="View">
              <button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>
                Chart
              </button>
              <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
                Table
              </button>
            </span>
          ) : !chart && views.includes("table") ? (
            <span className="sy-switch">
              <button type="button" aria-pressed={open} onClick={() => setOpen(!open)}>
                Table
              </button>
            </span>
          ) : null}
        </div>
      </header>
      {props.readout === undefined ? null : <Readout items={props.readout} />}
      <div className="sy-body">
        {shown === null || props.render === undefined ? null : props.render(shown)}
        {props.children}
      </div>
    </section>
  );
}
