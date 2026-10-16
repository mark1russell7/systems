/**
 * The chip of a verdict. Each page of results shows its verdicts with this chip, thus a status has one look
 * on the whole site. A status has a fixed color, and it always comes with an icon and a word, not with
 * color alone.
 *
 * - `holds`: the runs agree with the prediction (good).
 * - `fails`: the runs disagree with the prediction (critical).
 * - `void`: the verdict does not count the run (warning).
 * - `measured` and `calibration`: the cell has no band to judge (neutral).
 */
import type { ReactElement } from "react";

/** A status is the color of a verdict. */
export type Status = "good" | "critical" | "warning" | "neutral";

/** This function gives the status of a decision. A decision that the site does not know is critical. */
export const statusOf = (decision: string): Status =>
  decision === "holds" ? "good" : decision === "void" ? "warning" : decision === "measured" || decision === "calibration" ? "neutral" : "critical";

const PATHS: Readonly<Record<string, string>> = {
  holds: "M2.4 6.4 4.8 8.8 9.6 3.4",
  fails: "M3 3l6 6M9 3l-6 6",
  measured: "M1.4 6c1.1-2.9 2.6-2.9 3.6 0s2.5 2.9 3.6 0 1.6-1.5 2-1.5",
  calibration: "M6 1.6 10.4 6 6 10.4 1.6 6Z",
  void: "M2.8 9.2 9.2 2.8M6 1.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 1 0 0-8.8Z",
};

/** The icon of a decision: a check, a cross, a wave, a diamond or a struck circle. */
export function VerdictIcon(props: { readonly decision: string }): ReactElement {
  const path = PATHS[props.decision] ?? PATHS["fails"]!;
  return (
    <svg className="sy-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The chip of one decision. `text` adds a value after the word, for example a median. `prefix` names the run
 * that the chip is about, for example "re-run".
 */
export default function Verdict(props: { readonly decision: string; readonly text?: string | undefined; readonly prefix?: string | undefined }): ReactElement {
  const { decision } = props;
  return (
    <span className="sy-verdict" data-status={statusOf(decision)}>
      <VerdictIcon decision={decision} />
      <span>{props.prefix === undefined ? decision : `${props.prefix} ${decision}`}</span>
      {props.text === undefined || props.text === "" ? null : <span className="sy-verdict-value">{props.text}</span>}
    </span>
  );
}
