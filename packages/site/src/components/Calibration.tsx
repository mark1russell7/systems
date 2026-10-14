/**
 * The calibration of the harness: the two reference cells at 1, 4 and 8 environments at the same time.
 * One chart shows each reset (the noise of the pipeline itself), and one shows each scaled keepalive
 * against its band. Each row is one level of concurrency.
 */
import { useState, type ReactElement } from "react";
import harness from "../data/harness-2026-10-13.json";
import { duration } from "../lib/format.ts";
import Legend from "./Legend.tsx";
import Strip from "./Strip.tsx";

type Cell = (typeof harness.cells)[number];

const LEVELS = [1, 4, 8] as const;
const ROWS = LEVELS.map((level) => `×${level}`);
const cellsOf = (prefix: string): Cell[] =>
  LEVELS.map((level) => {
    const cell = harness.cells.find((each) => each.name === `${prefix} ×${level}`);
    if (cell === undefined) throw new Error(`no cell ${prefix} ×${level}`);
    return cell;
  });

/** each counted run of the cells, on the row of its level of concurrency */
const runsOf = (cells: readonly Cell[]) =>
  cells.flatMap((cell, row) =>
    cell.runs.flatMap((run, n) =>
      run.void !== null || run.elapsed === null ? [] : [{ t: run.elapsed * 1000, row, label: `${ROWS[row]}, run ${n + 1}` }],
    ),
  );

function Table(props: { readonly cells: readonly Cell[] }): ReactElement {
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Environments at the same time</th>
            <th>Counted</th>
            <th>Void</th>
            <th>Fastest</th>
            <th>Median</th>
            <th>Slowest</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {props.cells.map((cell, row) => {
            const times = cell.runs.flatMap((run) => (run.void === null && run.elapsed !== null ? [run.elapsed * 1000] : []));
            return (
              <tr key={cell.name}>
                <td>{ROWS[row]}</td>
                <td>{cell.verdict.counted}</td>
                <td>{cell.verdict.voided}</td>
                <td>{duration(Math.min(...times))}</td>
                <td>{cell.verdict.median === null ? "" : duration(cell.verdict.median * 1000)}</td>
                <td>{duration(Math.max(...times))}</td>
                <td>{cell.verdict.decision}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Frame(props: { readonly title: string; readonly cells: readonly Cell[]; readonly children: ReactElement }): ReactElement {
  const [table, setTable] = useState(false);
  const holds = props.cells.every((cell) => cell.verdict.decision === "holds");
  return (
    <section className="sy-frame not-content" aria-label={props.title}>
      <header>
        <strong>{props.title}</strong>
        <span className="sy-row">
          <span className="sy-chip" data-state={holds ? "pass" : "fail"}>
            {holds ? "✓ holds at each level" : "✗ fails at a level"}
          </span>
          <button type="button" className="sy-button" aria-pressed={table} onClick={() => setTable(!table)}>
            Table
          </button>
        </span>
      </header>
      <div className="sy-body">{table ? <Table cells={props.cells} /> : props.children}</div>
    </section>
  );
}

export default function Calibration(): ReactElement {
  const resets = cellsOf("reset on the next send");
  const keepalives = cellsOf("scaled keepalive");
  const resetRuns = runsOf(resets);
  const worst = Math.max(...resetRuns.map((run) => run.t));
  const band = keepalives[0]!.prediction;
  const low = ("low" in band ? band.low : 0) * 1000;
  const high = ("high" in band ? band.high : 0) * 1000;
  const keepaliveRuns = runsOf(keepalives);
  const near = [low, high, ...keepaliveRuns.map((run) => run.t)];
  const span = Math.max(...near) - Math.min(...near);
  return (
    <div className="not-content">
      <Legend band runs />
      <Frame title="Reset on the next send: the noise of the harness" cells={resets}>
        <>
          <Strip from={0} to={worst * 1.15} runs={resetRuns} rows={ROWS} label={`Each reset at 1, 4 and 8 environments at the same time. The slowest of ${resetRuns.length} took ${duration(worst)}.`} />
          <p className="sy-muted">The slowest of {resetRuns.length} resets took {duration(worst)}. The noise of the pipeline, δ_abs, has one jiffy (4 ms) as its minimum, thus δ_abs is 4 ms.</p>
        </>
      </Frame>
      <Frame title="Scaled keepalive: the spread of a timer" cells={keepalives}>
        <>
          <Strip from={Math.max(0, Math.min(...near) - span * 0.12)} to={Math.max(...near) + span * 0.12} band={{ low, high }} runs={keepaliveRuns} rows={ROWS} label={`Each scaled keepalive at 1, 4 and 8 environments at the same time, against the prediction of ${duration(low)} to ${duration(high)}.`} />
          <p className="sy-muted">The prediction is {duration(low)} to {duration(high)}, for an idle time of 5 s and 3 probes 2 s apart.</p>
        </>
      </Frame>
    </div>
  );
}
