/**
 * The borders of a copy as small charts. A border has two cells: a setting of the client inside the
 * border, and a setting outside it. One chart shows the two cells on one axis of time. The border is a
 * dashed line, and the setting of each cell is a mark. The chart also shows the band of each prediction
 * and each counted run. A reader thus sees on which side of the border each setting is, and which timer
 * ended each run.
 *
 * The charts come from the names of the cells: "query_timeout 9.5 s: outside O07 against a
 * statement_timeout of 10 s". A cell with a name in another form is not on a chart. A run is on the axis
 * only when its band counts from the event that the setting counts from. Otherwise the chart gives the
 * time as text, and the event that it counts from.
 *
 * The component has no state. The site renders it to HTML when it builds, and it needs no script.
 */
import type { ReactElement } from "react";
import { duration, reading, ticksBetween } from "../lib/format.ts";
import { COPIES, type Copy, type RunCell } from "./RunResults.tsx";
import { VerdictIcon, statusOf } from "./Verdict.tsx";

/** The form of the name of a border cell: the setting, its value, the side, the rule, and the border with its value. */
const NAME = /([A-Za-z_]+) ([\d.]+) s(?:, [^:]*)?: (?:.*?\b)?(inside|outside) (O\d+) against an? (.+?) (?:of|at) ([\d.]+) s$/;

/** One side of a border: its cell, and the value of its setting in seconds. */
export interface Side {
  readonly cell: RunCell;
  readonly value: number;
}

/** A border: the rule, the client, the setting, what it is against, and its two sides. */
export interface Border {
  readonly rule: string;
  readonly client: string | undefined;
  readonly setting: string;
  readonly against: string;
  readonly at: number;
  readonly inside: Side;
  readonly outside: Side;
}

/** This function finds the borders of a copy: two cells of one client and one rule, one on each side. */
export const bordersOf = (cells: readonly RunCell[]): Border[] => {
  type Found = { rule: string; client: string | undefined; setting: string; against: string; at: number; inside?: Side; outside?: Side };
  const found = new Map<string, Found>();
  for (const cell of cells) {
    const match = NAME.exec(cell.name);
    if (match === null) continue;
    const [, setting, value, side, rule, against, at] = match as unknown as [string, string, string, "inside" | "outside", string, string, string];
    const key = `${cell.client ?? ""} ${rule} ${setting} ${against} ${at}`;
    const border: Found = found.get(key) ?? { rule, client: cell.client, setting, against, at: Number(at) };
    border[side] = { cell, value: Number(value) };
    found.set(key, border);
  }
  return [...found.values()].flatMap((border) => (border.inside === undefined || border.outside === undefined ? [] : [{ ...border, inside: border.inside, outside: border.outside }]));
};

/** This function tells if the runs of a side count from the event of its setting. Then its band starts near its setting or near the border. */
export const onAxis = (side: Side, at: number): boolean => {
  const low = side.cell.prediction.low;
  if (side.cell.prediction.kind !== "detects" || low === null) return false;
  return Math.abs(low - side.value) <= 0.1 * side.value || Math.abs(low - at) <= 0.1 * at;
};

/** This function gives the event that the band of a cell counts from, from the text of its prediction. */
const referenceOf = (cell: RunCell): string => /after (the [^.]+?)(?:, the first segment after the fault)?\.\s*$/.exec(cell.prediction.text)?.[1] ?? "its reference";

const time = (s: number): string => (s >= 1 && s < 120 ? reading(s * 1000) : duration(s * 1000));
const runsOf = (cell: RunCell): number[] => cell.runs.flat().filter((t): t is number => t !== null);

/** This function tells what ended the runs of a side, as text. */
const outcomeOf = (side: Side, at: number): string => {
  const { cell } = side;
  if (cell.prediction.kind === "silent") return `nothing ended it in the window of ${duration((cell.prediction.window ?? 0) * 1000)}`;
  if (cell.median === null) return "no run has a time";
  return onAxis(side, at) ? `it ended at ${time(cell.median)}` : `it ended ${time(cell.median)} after ${referenceOf(cell)}`;
};

/** One chart of a border. */
function BorderChart(props: { readonly border: Border }): ReactElement {
  const { border } = props;
  const sides = [
    { word: "inside", side: border.inside },
    { word: "outside", side: border.outside },
  ] as const;
  // the axis holds the border, the two settings, and the bands and runs that are on its clock
  const values = [border.at, border.inside.value, border.outside.value];
  for (const { side } of sides) {
    if (!onAxis(side, border.at)) continue;
    const p = side.cell.prediction;
    if (p.low !== null && p.high !== null) values.push(p.low, p.high);
    values.push(...runsOf(side.cell));
  }
  const span = Math.max(...values) - Math.min(...values);
  const pad = Math.max(span * 0.08, 0.25);
  const from = Math.max(0, Math.min(...values) - pad);
  const to = Math.max(...values) + pad;
  const x = (s: number): string => `${(((s - from) / (to - from)) * 100).toFixed(3)}%`;
  const { unit, values: ticks } = ticksBetween(from * 1000, to * 1000, 4);
  const label = `${border.rule}${border.client === undefined ? "" : `, ${border.client}`}: ${border.setting} against ${border.against} at ${time(border.at)}. ${sides
    .map(({ word, side }) => `${word}, ${border.setting} ${time(side.value)}: ${outcomeOf(side, border.at)}`)
    .join(". ")}.`;
  return (
    <figure className="sy-border">
      <figcaption>
        <strong>{border.rule}</strong>
        {border.client === undefined ? null : <span> · {border.client}</span>}
        <span className="sy-border-what">
          {" "}
          · <code>{border.setting}</code> against {border.against} at {time(border.at)}
        </span>
      </figcaption>
      <div className="sy-border-plot" role="img" aria-label={label}>
        <div className="sy-border-row sy-border-top" aria-hidden="true">
          <span />
          <span className="sy-border-track">
            <span className="sy-border-at" style={{ left: x(border.at) }}>
              {border.against} {time(border.at)}
            </span>
          </span>
        </div>
        {sides.map(({ word, side }) => {
          const p = side.cell.prediction;
          const plotted = onAxis(side, border.at);
          return (
            <div className="sy-border-row" key={word} aria-hidden="true">
              <span className="sy-border-side" data-status={statusOf(side.cell.decision)} title={side.cell.decision}>
                <VerdictIcon decision={side.cell.decision} />
                {word} · {time(side.value)}
              </span>
              <span className="sy-border-track">
                <span className="sy-border-line" style={{ left: x(border.at) }} />
                {plotted && p.low !== null && p.high !== null ? <span className="sy-border-band" style={{ left: x(p.low), width: `calc(${x(p.high)} - ${x(p.low)})` }} /> : null}
                <span className="sy-border-setting" style={{ left: x(side.value) }} title={`${border.setting} ${time(side.value)}`} />
                {plotted
                  ? runsOf(side.cell).map((t, n) => <span key={n} className="sy-border-run" style={{ left: x(t), top: `${30 + (n % 3) * 20}%` }} title={`run ${n + 1}: ${time(t)}`} />)
                  : null}
                {plotted ? null : <span className="sy-border-note">{outcomeOf(side, border.at)}</span>}
              </span>
            </div>
          );
        })}
        <div className="sy-border-row sy-border-axis" aria-hidden="true">
          <span />
          <span className="sy-border-track">
            {ticks.map((t) => (
              <span key={t} className="sy-border-tick" style={{ left: x(t / 1000) }}>
                {Number((t / unit.ms).toPrecision(6))} {unit.name}
              </span>
            ))}
          </span>
        </div>
      </div>
      <p className="sy-border-text">
        {sides.map(({ word, side }, n) => (
          <span key={word}>
            {n === 0 ? "" : " "}
            {word === "inside" ? "Inside" : "Outside"}, at {time(side.value)}, {outcomeOf(side, border.at)}.
          </span>
        ))}
      </p>
    </figure>
  );
}

/** The charts of the borders of one copy, for one client or for each client. */
export default function Borders(props: { readonly copy: Copy; readonly pool?: string }): ReactElement {
  const borders = bordersOf(COPIES[props.copy]).filter((border) => props.pool === undefined || border.client === props.pool);
  if (borders.length === 0) throw new Error(`no border of ${props.copy} has a name of the form of this chart`);
  return (
    <div className="sy-borders not-content">
      <p className="sy-border-key" aria-hidden="true">
        <span>
          <i className="sy-border-key-line" /> the border
        </span>
        <span>
          <i className="sy-border-key-setting" /> the setting of the cell
        </span>
        <span>
          <i className="sy-border-key-band" /> the band of the prediction
        </span>
        <span>
          <i className="sy-border-key-run" /> a counted run
        </span>
      </p>
      <div className="sy-border-grid">
        {borders.map((border) => (
          <BorderChart key={`${border.client ?? ""} ${border.rule} ${border.setting}`} border={border} />
        ))}
      </div>
    </div>
  );
}
