/**
 * The calibration of the harness: the two reference cells at 1, 4 and 8 environments at the same time.
 * One chart shows each reset (the noise of the pipeline itself), and one shows each scaled keepalive
 * against its band. Each row is one level of concurrency.
 */
import type { ReactElement, ReactNode } from "react";
import harness from "../data/harness-2026-10-13.json";
import { duration, reading } from "../lib/format.ts";
import { axisOf } from "./CellFrame.tsx";
import Frame from "./Frame.tsx";
import Legend from "./Legend.tsx";
import Strip from "./Strip.tsx";
import Verdict from "./Verdict.tsx";

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
            <th className="num">Counted</th>
            <th className="num">Void</th>
            <th className="num">Fastest</th>
            <th className="num">Median</th>
            <th className="num">Slowest</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {props.cells.map((cell, row) => {
            const times = cell.runs.flatMap((run) => (run.void === null && run.elapsed !== null ? [run.elapsed * 1000] : []));
            return (
              <tr key={cell.name}>
                <td>{ROWS[row]}</td>
                <td className="num">{cell.verdict.counted}</td>
                <td className="num">{cell.verdict.voided}</td>
                <td className="num">{duration(Math.min(...times))}</td>
                <td className="num">{cell.verdict.median === null ? "" : duration(cell.verdict.median * 1000)}</td>
                <td className="num">{duration(Math.max(...times))}</td>
                <td>
                  <Verdict decision={cell.verdict.decision} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Level(props: { readonly title: string; readonly cells: readonly Cell[]; readonly prediction: string; readonly chart: ReactNode; readonly children: ReactNode }): ReactElement {
  const holds = props.cells.every((cell) => cell.verdict.decision === "holds");
  const counted = props.cells.reduce((sum, cell) => sum + cell.verdict.counted, 0);
  return (
    <Frame
      name={props.title}
      label={props.title}
      decision={holds ? "holds" : "fails"}
      verdicts={<Verdict decision={holds ? "holds" : "fails"} text={holds ? "at each level" : "at a level"} />}
      readout={[
        { label: "Prediction", value: props.prediction },
        { label: "Levels", value: ROWS.join(" · ") },
        { label: "Runs", value: `${counted} counted` },
      ]}
      views={["chart", "table"]}
      render={(view) => (view === "table" ? <Table cells={props.cells} /> : props.chart)}
    >
      {props.children}
    </Frame>
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
  const axis = axisOf([{ band: { low, high }, runs: keepaliveRuns }]);
  const reset = resets[0]!.prediction;
  return (
    <div className="not-content sy-cells">
      <Level
        title="Reset on the next send: the noise of the harness"
        cells={resets}
        prediction={`${reading(("low" in reset ? reset.low : 0) * 1000)} to ${reading(("high" in reset ? reset.high : 0) * 1000)}`}
        chart={
          <>
            <Strip from={0} to={worst * 1.15} runs={resetRuns} rows={ROWS} label={`Each reset at 1, 4 and 8 environments at the same time. The slowest of ${resetRuns.length} took ${duration(worst)}.`} />
            <Legend runs />
          </>
        }
      >
        <p className="sy-muted">The slowest of {resetRuns.length} resets took {duration(worst)}. The noise of the pipeline, δ_abs, has one jiffy (4 ms) as its minimum, thus δ_abs is 4 ms.</p>
      </Level>
      <Level
        title="Scaled keepalive: the spread of a timer"
        cells={keepalives}
        prediction={`${reading(low)} to ${reading(high)}`}
        chart={
          <>
            <Strip from={axis.from} to={axis.to} band={{ low, high }} runs={keepaliveRuns} rows={ROWS} label={`Each scaled keepalive at 1, 4 and 8 environments at the same time, against the prediction of ${duration(low)} to ${duration(high)}.`} />
            <Legend band runs />
          </>
        }
      >
        <p className="sy-muted">The prediction is {duration(low)} to {duration(high)}, for an idle time of 5 s and 3 probes 2 s apart.</p>
      </Level>
    </div>
  );
}
