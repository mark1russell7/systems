/**
 * The results of the first harness cells. Each cell has a chart. The chart shows the band that the
 * algebra predicted, and a dot for each measurement, on one row for each environment. A table gives
 * the same numbers.
 */
import { useState, type ReactElement } from "react";
import harness from "../data/harness-2026-10-08.json";
import { duration } from "../lib/format.ts";
import Legend from "./Legend.tsx";
import Strip from "./Strip.tsx";

type Cell = (typeof harness.cells)[number];

function CellChart(props: { readonly cell: Cell }): ReactElement {
  const { cell } = props;
  const [table, setTable] = useState(false);
  const p = cell.prediction;
  const runs = cell.runs.flatMap((run, n) =>
    run.elapsed === null ? [] : [{ t: run.elapsed * 1000, row: run.environment, label: `Run ${n + 1}, environment ${run.environment + 1}` }],
  );
  const holds = cell.verdict.decision === "holds";
  const chip = (
    <span className="sy-chip" data-state={holds ? "pass" : "fail"}>
      {holds ? "✓ holds" : "✗ fails"}
    </span>
  );

  if (p.low === undefined || p.high === undefined) {
    const acks = [...new Set(cell.runs.map((run) => run.acks))].join(", ");
    return (
      <section className="sy-frame not-content" aria-label={cell.name}>
        <header>
          <strong>{cell.name}</strong>
          {chip}
        </header>
        <p className="sy-body">
          The algebra predicts that no TCP timer fires. The harness measured silence in {cell.runs.length} of {cell.runs.length} runs, over a window of {duration((p.window ?? 0) * 1000)}. In each run the frozen kernel sent {acks} acknowledgments.
        </p>
      </section>
    );
  }

  const low = p.low * 1000;
  const high = p.high * 1000;
  const near = [low, high, ...runs.map((run) => run.t)];
  const span = Math.max(...near) - Math.min(...near);
  const median = cell.verdict.median === null ? [] : [{ t: cell.verdict.median * 1000, label: "The median" }];
  const label = `${cell.name}: the prediction is ${duration(low)} to ${duration(high)}. The runs measured ${duration(Math.min(...runs.map((r) => r.t)))} to ${duration(Math.max(...runs.map((r) => r.t)))}.`;

  return (
    <section className="sy-frame not-content" aria-label={cell.name}>
      <header>
        <strong>{cell.name}</strong>
        <span className="sy-row">
          {chip}
          <button type="button" className="sy-button" aria-pressed={table} onClick={() => setTable(!table)}>
            Table
          </button>
        </span>
      </header>
      <div className="sy-body">
        {table ? (
          <div className="sy-scroll">
            <table className="sy-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Environment</th>
                  <th>Kernel records</th>
                  <th>TCP_INFO</th>
                  <th>Client lag</th>
                  <th>Probes</th>
                  <th>Retransmissions</th>
                </tr>
              </thead>
              <tbody>
                {cell.runs.map((run, n) => (
                  <tr key={n}>
                    <td>{n + 1}</td>
                    <td>{run.environment + 1}</td>
                    <td>{run.elapsed === null ? "silent" : duration(run.elapsed * 1000)}</td>
                    <td>{run.socket === null ? "" : duration(run.socket * 1000)}</td>
                    <td>{run.noticed === null ? "" : duration(run.noticed * 1000)}</td>
                    <td>{run.probes}</td>
                    <td>{run.retransmissions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Strip from={Math.max(0, Math.min(...near) - span * 0.12)} to={Math.max(...near) + span * 0.12} band={{ low, high }} runs={runs} lines={median} label={label} />
        )}
        <p className="sy-muted">{cell.verdict.why}</p>
      </div>
    </section>
  );
}

export default function HarnessResults(): ReactElement {
  return (
    <div className="not-content">
      <Legend band runs line="Median" />
      {harness.cells.map((cell) => (
        <CellChart key={cell.name} cell={cell} />
      ))}
    </div>
  );
}
