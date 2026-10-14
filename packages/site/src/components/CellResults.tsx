/**
 * The results of the S1 harness cells, from their latest run. Each cell has a chart: the band that the
 * algebra predicted, and a dot for each counted run, on one row for each environment. A table gives the
 * same numbers, and each void run with its reason. A cell predicts a detection, silence, or a
 * recovery after a stall.
 */
import { useState, type ReactElement } from "react";
import harness from "../data/harness-2026-10-13.json";
import { duration } from "../lib/format.ts";
import Legend from "./Legend.tsx";
import Strip from "./Strip.tsx";

type Cell = (typeof harness.cells)[number];
export type Group = Cell["group"];

const ms = (s: number | null | undefined): number | null => (s === null || s === undefined ? null : s * 1000);

function Chip(props: { readonly decision: string }): ReactElement {
  const holds = props.decision === "holds";
  return (
    <span className="sy-chip" data-state={holds ? "pass" : "fail"}>
      {holds ? "✓ holds" : `✗ ${props.decision}`}
    </span>
  );
}

function RunTable(props: { readonly cell: Cell }): ReactElement {
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Environment</th>
            <th>Outcome</th>
            <th>Kernel records</th>
            <th>TCP_INFO</th>
            <th>Client lag</th>
            <th>Probes</th>
            <th>Retransmissions</th>
            <th>Void</th>
          </tr>
        </thead>
        <tbody>
          {props.cell.runs.map((run, n) => (
            <tr key={n}>
              <td>{n + 1}</td>
              <td>{run.environment + 1}</td>
              <td>{run.outcome}</td>
              <td>{run.elapsed === null ? "" : duration(run.elapsed * 1000)}</td>
              <td>{run.socket === null ? "" : duration(run.socket * 1000)}</td>
              <td>{run.noticed === null ? "" : duration(run.noticed * 1000)}</td>
              <td>{run.probes}</td>
              <td>{run.retransmissions}</td>
              <td>{run.void ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellChart(props: { readonly cell: Cell }): ReactElement {
  const { cell } = props;
  const [table, setTable] = useState(false);
  const p = cell.prediction;
  const recovers = "recovers" in p ? p.recovers : undefined;
  const timed = p.detects ? { low: p.low, high: p.high } : recovers;
  const voided = cell.verdict.voided;
  const counted = cell.verdict.counted;

  const header = (
    <header>
      <strong>{cell.name}</strong>
      <span className="sy-row">
        <Chip decision={cell.verdict.decision} />
        <button type="button" className="sy-button" aria-pressed={table} onClick={() => setTable(!table)}>
          Table
        </button>
      </span>
    </header>
  );

  if (timed === undefined || timed.low === undefined || timed.high === undefined) {
    const acks = [...new Set(cell.runs.map((run) => run.acks))].sort((a, b) => a - b).join(", ");
    const window = "window" in p ? (p.window ?? 0) : 0;
    return (
      <section className="sy-frame not-content" aria-label={cell.name}>
        {header}
        <div className="sy-body">
          {table ? (
            <RunTable cell={cell} />
          ) : (
            <p>
              The algebra predicts that no TCP timer fires. The harness measured silence in {counted} of {counted} counted runs, over a window of {duration(window * 1000)}. In each run the frozen peer sent {acks} acknowledgments.
            </p>
          )}
          <p className="sy-muted">{cell.verdict.why}</p>
        </div>
      </section>
    );
  }

  const low = timed.low * 1000;
  const high = timed.high * 1000;
  const runs = cell.runs.flatMap((run, n) =>
    run.void !== null || run.elapsed === null ? [] : [{ t: run.elapsed * 1000, row: run.environment % 2, label: `Run ${n + 1}, environment ${run.environment + 1}` }],
  );
  const near = [low, high, ...runs.map((run) => run.t)];
  const span = Math.max(...near) - Math.min(...near);
  const median = ms(cell.verdict.median);
  const lines = median === null ? [] : [{ t: median, label: "The median" }];
  const what = recovers === undefined ? "the detection" : "the return of the reply";
  const label = `${cell.name}: the prediction for ${what} is ${duration(low)} to ${duration(high)}. The counted runs measured ${duration(Math.min(...runs.map((r) => r.t)))} to ${duration(Math.max(...runs.map((r) => r.t)))}.`;

  return (
    <section className="sy-frame not-content" aria-label={cell.name}>
      {header}
      <div className="sy-body">
        {table ? (
          <RunTable cell={cell} />
        ) : (
          <Strip from={Math.max(0, Math.min(...near) - span * 0.12)} to={Math.max(...near) + span * 0.12} band={{ low, high }} runs={runs} lines={lines} label={label} />
        )}
        <p className="sy-muted">
          {cell.verdict.why}
          {voided === 0 ? "" : `. ${voided} void ${voided === 1 ? "run" : "runs"} (in the table).`}
        </p>
      </div>
    </section>
  );
}

/** The cells of one group, in the sequence of the data. */
export default function CellResults(props: { readonly group: Group }): ReactElement {
  const cells = harness.cells.filter((cell) => cell.group === props.group);
  return (
    <div className="not-content">
      <Legend band runs line="Median" />
      {cells.map((cell) => (
        <CellChart key={cell.name} cell={cell} />
      ))}
    </div>
  );
}
