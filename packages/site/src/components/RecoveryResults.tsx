/**
 * The results of the recovery drills of SYS-94, from the export of `scripts/recovery.ts`. `RecoveryRungs`
 * gives the ladder: the budgets of each rung and the worst value of its drills. `RecoveryTimes` puts each
 * counted run of each drill on one axis of seconds. Thus the growth of the time with the size is clear.
 * A dot is a counted run, and the dashed line is the median, as in each chart of the site.
 *
 * A pointer over a dot, a tap or the focus shows the run. The table view gives the same runs as rows.
 */
import { useState, type MouseEvent, type PointerEvent, type ReactElement } from "react";
import recovery from "../data/recovery-2026-11-04.json";
import { count, countTicks, duration, spacedLabels } from "../lib/format.ts";
import { LANES, lanesOf, useWidth } from "./Strip.tsx";
import Verdict from "./Verdict.tsx";

/** The CI run of the drills. */
export const RECOVERY_RUN = recovery.workflow;

/** A budget of a rung, in seconds, and the worst value of the drills against it. */
export interface Budgeted {
  readonly limit: number;
  readonly worst: number;
}

/** One rung of the ladder of recovery, as the page shows it. */
export interface RungRow {
  readonly rung: string;
  readonly tenants: number;
  readonly rpo: Budgeted;
  readonly rto: Budgeted;
  /** The outcome of the rung in the ladder verdict: `within`, `beyond` or `cannot decide`. */
  readonly outcome: string;
  readonly locked: boolean;
}

/** This function gives the rungs of the ladder, with the worst value of each budget in time. */
export const rungRows = (): RungRow[] =>
  recovery.ladder.rungs.map((rung) => {
    const record = recovery.records.find((each) => each.rung === rung.name)!;
    const verdict = recovery.verdict.rungs.find((each) => each.rung === rung.name)!;
    const budgeted = (measure: string): Budgeted => ({
      limit: rung.budgets.find((each) => each.measure === measure)!.limit,
      worst: Math.max(...record.evidence.find((each) => each.measure === measure)!.values),
    });
    return { rung: rung.name, tenants: rung.at.tenants, rpo: budgeted("rpo"), rto: budgeted("rto"), outcome: verdict.outcome, locked: rung.locked };
  });

/** One counted run of a drill. Times are in seconds. */
export interface DrillRun {
  readonly index: number;
  readonly rto: number;
  readonly lost: number;
  /** The writes that the records show after the last backup, or null for an election. */
  readonly afterBackup: number | null;
  /** The age of the newest kept write at the fault, past the last backup, or null for an election. */
  readonly excess: number | null;
  readonly holes: number;
  readonly sameData: boolean;
}

/** One drill, as a row of the chart. */
export interface DrillRow {
  readonly id: string;
  readonly label: string;
  readonly median: number;
  readonly runs: readonly DrillRun[];
}

/** The sequence of the rows: the restores by size, then the elections by size. */
const ROWS: readonly (readonly [string, string])[] = [
  ["RD.control", "1 MB, restore, no later write"],
  ["RD.1", "1 MB, restore"],
  ["RD.100.restore", "100 MB, restore"],
  ["RD.1000.restore", "1 GB, restore"],
  ["RD.100.failover", "100 MB, election"],
  ["RD.1000.failover", "1 GB, election"],
];

/** This function gives the drills in the sequence of the chart. */
export const drillRows = (): DrillRow[] =>
  ROWS.map(([id, label]) => {
    const drill = recovery.drills.find((each) => each.id === id)!;
    const cell = recovery.cells.find((each) => each.name.startsWith(`${id} `))!;
    return {
      id,
      label,
      median: cell.median,
      runs: drill.runs.map((run) => ({
        index: run.index,
        rto: run.rto.value,
        lost: run.lost,
        afterBackup: run.afterBackup,
        excess: run.excess?.value ?? null,
        holes: run.holes,
        sameData: run.sameData,
      })),
    };
  });

/** This function writes a time in seconds, to the hundredth. */
export const timeText = (seconds: number): string => duration(Math.round(seconds * 100) * 10);

/** This function writes the part of a budget that a value uses, in two digits. */
export const shareText = (each: Budgeted): string => `${Number(((each.worst / each.limit) * 100).toPrecision(2))} %`;

const writes = (n: number): string => `${count(n)} ${n === 1 ? "write" : "writes"}`;

/** This function writes what one run did, for the tooltip and for the label of its dot. */
export const runText = (row: DrillRow, run: DrillRun): string => {
  const loss = run.afterBackup === null ? "No accepted write lost." : run.lost === 0 ? "No write lost: none came after the backup." : `${writes(run.lost)} lost, each one after the last backup, and no hole.`;
  return `${row.id}, run ${run.index} of ${row.runs.length}. ${loss}`;
};

/** This component gives the ladder of recovery: a row for each rung. */
export function RecoveryRungs(): ReactElement {
  return (
    <figure className="sy-recovery-figure not-content">
      <div className="sy-scroll">
        <table className="sy-table">
          <thead>
            <tr>
              <th>Rung</th>
              <th className="num">RPO budget</th>
              <th className="num">Worst RPO</th>
              <th className="num">RTO budget</th>
              <th className="num">Worst RTO</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rungRows().map((row) => (
              <tr key={row.rung}>
                <th scope="row">{count(row.tenants)}</th>
                <td className="num">{timeText(row.rpo.limit)}</td>
                <td className="num">
                  {timeText(row.rpo.worst)} ({shareText(row.rpo)})
                </td>
                <td className="num">{timeText(row.rto.limit)}</td>
                <td className="num">
                  {timeText(row.rto.worst)} ({shareText(row.rto)})
                </td>
                <td>
                  <Verdict decision={row.outcome === "within" ? "holds" : "fails"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption>
        The worst value of 4 counted runs of each drill, and the part of the budget that it uses. The RPO is the backup schedule of the rung plus the excess that the drill measured, thus the schedule gives most of it. Each rung has{" "}
        <a href={`https://github.com/mark1russell7/systems/actions/runs/${RECOVERY_RUN}`}>the same CI run</a> as its record.
      </figcaption>
    </figure>
  );
}

const PAD = 12;
/** the height of the line above a row: the name of the drill and its median */
const HEAD = 18;
const ROW = 26;
const AFTER = 8;
const BLOCK = HEAD + ROW + AFTER;
const DOT = 4;
/** the distance between two lanes of dots */
const LANE = 7;
const REACH = 16;
/** the width of one character in the mono font at 11 px */
const CHARACTER = 6.7;

interface Dot {
  readonly row: DrillRow;
  readonly run: DrillRun;
  readonly x: number;
  readonly y: number;
}

function Chart(props: { readonly rows: readonly DrillRow[] }): ReactElement {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const { rows } = props;
  const highest = Math.max(...rows.flatMap((row) => row.runs.map((run) => run.rto)));
  const to = Math.ceil((highest * 1.03) / 5) * 5;
  const left = PAD;
  const right = width - PAD;
  const x = (seconds: number): number => left + ((right - left) * seconds) / to;
  const axis = rows.length * BLOCK;
  const height = axis + 24;
  const ticks = countTicks(0, to, Math.max(4, Math.floor((right - left) / 72)));
  const labels = spacedLabels(
    ticks.map((t) => ({ t, x: x(t), text: `${count(t)} s`, width: (count(t).length + 2) * CHARACTER })),
    width,
  );

  const dots: Dot[] = rows.flatMap((row, n) => {
    const middle = n * BLOCK + HEAD + ROW / 2;
    const lanes = lanesOf(
      row.runs.map((run) => x(run.rto)),
      2 * DOT + 2,
    );
    return row.runs.map((run, k): Dot => ({ row, run, x: x(run.rto), y: middle + LANES[lanes[k] ?? 0]! * LANE }));
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
  const label = `The time from the fault to the first accepted write, for each run of each drill, from 0 to ${to} s. ${rows.map((row) => `${row.label}: the median is ${timeText(row.median)}.`).join(" ")}`;
  return (
    <div ref={ref} className="sy-strip" onBlur={() => setActive(null)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setActive(null)} onClick={(event) => setActive(pointAt(event))}>
        {ticks.map((t) => (
          <line key={`grid ${t}`} className="sy-grid" x1={x(t)} x2={x(t)} y1={HEAD - 4} y2={axis} />
        ))}
        {rows.map((row, n) => {
          const top = n * BLOCK + HEAD;
          return (
            <g key={row.id}>
              <text className="sy-recovery-name" x={left} y={top - 6}>
                {row.label}
              </text>
              <text x={right} y={top - 6} textAnchor="end">
                {timeText(row.median)}
              </text>
              <line className="sy-median" x1={x(row.median)} x2={x(row.median)} y1={top} y2={top + ROW} />
            </g>
          );
        })}
        {dots.map((dot, n) => (
          <circle key={`${dot.row.id} ${dot.run.index}`} className="sy-run" cx={dot.x} cy={dot.y} r={DOT} tabIndex={0} role="img" aria-label={`${timeText(dot.run.rto)}. ${runText(dot.row, dot.run)}`} onFocus={() => setActive(n)} />
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
          <strong>{timeText(target.run.rto)}</strong>
          <span>{runText(target.row, target.run)}</span>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {target === undefined ? "" : `${timeText(target.run.rto)}. ${runText(target.row, target.run)}`}
      </p>
    </div>
  );
}

function Table(props: { readonly rows: readonly DrillRow[] }): ReactElement {
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Drill</th>
            <th className="num">Run</th>
            <th className="num">RTO</th>
            <th className="num">Lost</th>
            <th className="num">After the backup</th>
            <th className="num">Excess</th>
            <th className="num">Holes</th>
            <th>Same data</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.flatMap((row) =>
            row.runs.map((run) => (
              <tr key={`${row.id} ${run.index}`}>
                <th scope="row">{row.label}</th>
                <td className="num">{run.index}</td>
                <td className="num">{timeText(run.rto)}</td>
                <td className="num">{count(run.lost)}</td>
                <td className="num">{run.afterBackup === null ? "–" : count(run.afterBackup)}</td>
                <td className="num">{run.excess === null ? "–" : timeText(run.excess)}</td>
                <td className="num">{count(run.holes)}</td>
                <td>{run.sameData ? "yes" : "no"}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** This component puts each run of each drill on one axis of seconds, with a table view. */
export function RecoveryTimes(): ReactElement {
  const rows = drillRows();
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <figure className="sy-recovery-figure not-content">
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
      {view === "chart" ? <Chart rows={rows} /> : <Table rows={rows} />}
      <figcaption>The time from the fault to the first accepted write. A dot is a counted run, and the dashed line and the number at the right are the median. The time has no detection and no human.</figcaption>
    </figure>
  );
}
