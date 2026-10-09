/** The legend of a strip chart: each swatch beside its label, in the order of the marks. */
import type { ReactElement } from "react";

export default function Legend(props: {
  readonly band?: boolean;
  readonly marks?: string | undefined;
  readonly runs?: boolean;
  readonly line?: string | undefined;
}): ReactElement {
  return (
    <ul className="sy-legend" aria-label="Legend">
      {props.band === true ? (
        <li>
          <svg width="16" height="10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="15" height="9" rx="2" fill="var(--color-accent-wash)" stroke="var(--color-accent)" />
          </svg>
          Prediction
        </li>
      ) : null}
      {props.marks === undefined ? null : (
        <li>
          <svg width="10" height="10" aria-hidden="true">
            <circle cx="5" cy="5" r="4" fill="var(--series-1)" />
          </svg>
          {props.marks}
        </li>
      )}
      {props.runs === true ? (
        <li>
          <svg width="10" height="10" aria-hidden="true">
            <circle cx="5" cy="5" r="4" fill="var(--series-2)" />
          </svg>
          Measured runs
        </li>
      ) : null}
      {props.line === undefined ? null : (
        <li>
          <svg width="16" height="10" aria-hidden="true">
            <line x1="0" y1="5" x2="16" y2="5" stroke="var(--color-ink)" strokeWidth="1.5" strokeDasharray="3 3" />
          </svg>
          {props.line}
        </li>
      )}
    </ul>
  );
}
