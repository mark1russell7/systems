/**
 * The results of the S1 harness cells, from their latest run. Each cell has a chart: the band that the
 * algebra predicted, and a dot for each counted run. A table gives the same numbers from each vantage, and
 * each void run with its reason. A cell predicts a detection, silence, or a recovery after a stall.
 *
 * `HarnessFrame` is also the frame of the first harness cells, on their own page.
 */
import type { ReactElement } from "react";
import harness from "../data/harness-2026-10-13.json";
import { duration, reading } from "../lib/format.ts";
import { axisOf, runsText, VoidCell } from "./CellFrame.tsx";
import Frame, { type ReadoutItem } from "./Frame.tsx";
import Legend, { keysOf } from "./Legend.tsx";
import Strip, { type StripData } from "./Strip.tsx";
import Verdict from "./Verdict.tsx";

type Cell = (typeof harness.cells)[number];
export type Group = Cell["group"];

/** A harness run is one run of a cell, with the time from each vantage. Each time is in seconds. */
export interface HarnessRun {
  readonly environment: number;
  readonly outcome: string;
  readonly elapsed: number | null;
  readonly socket: number | null;
  readonly noticed: number | null;
  readonly probes: number;
  readonly retransmissions: number;
  readonly acks: number;
  readonly void?: string | null | undefined;
}

/** A harness cell is a cell of the harness copies: its prediction, its verdict and its runs. */
export interface HarnessCell {
  readonly name: string;
  readonly prediction: {
    readonly detects: boolean;
    readonly low?: number | undefined;
    readonly high?: number | undefined;
    readonly window?: number | undefined;
    readonly recovers?: { readonly low: number; readonly high: number } | undefined;
  };
  readonly verdict: { readonly decision: string; readonly why: string; readonly median: number | null; readonly counted?: number; readonly voided?: number };
  readonly runs: readonly HarnessRun[];
}

const ms = (s: number): number => s * 1000;
const time = (s: number | null): string => (s === null ? "" : duration(ms(s)));

function RunTable(props: { readonly cell: HarnessCell }): ReactElement {
  const voids = props.cell.runs.some((run) => run.void !== undefined);
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th className="num">Run</th>
            <th className="num">Environment</th>
            <th>Outcome</th>
            <th className="num">Kernel records</th>
            <th className="num">TCP_INFO</th>
            <th className="num">Client lag</th>
            <th className="num">Probes</th>
            <th className="num">Retransmissions</th>
            {voids ? <th>Void</th> : null}
          </tr>
        </thead>
        <tbody>
          {props.cell.runs.map((run, n) => (
            <tr key={n}>
              <td className="num">{n + 1}</td>
              <td className="num">{run.environment + 1}</td>
              <td>{run.outcome}</td>
              <td className="num">{time(run.elapsed)}</td>
              <td className="num">{time(run.socket)}</td>
              <td className="num">{time(run.noticed)}</td>
              <td className="num">{run.probes}</td>
              <td className="num">{run.retransmissions}</td>
              {voids ? <VoidCell reason={run.void ?? null} /> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The frame of one harness cell: its readout, its strip or its table, and its verdict. */
export function HarnessFrame(props: { readonly cell: HarnessCell }): ReactElement {
  const { cell } = props;
  const p = cell.prediction;
  const timed = p.detects ? (p.low === undefined || p.high === undefined ? undefined : { low: p.low, high: p.high }) : p.recovers;
  const counted = cell.verdict.counted ?? cell.runs.length;
  const voided = cell.verdict.voided ?? 0;
  const median = cell.verdict.median;
  const readout: ReadoutItem[] = [
    { label: "Prediction", value: timed === undefined ? `silent for ${duration(ms(p.window ?? 0))}` : `${reading(ms(timed.low))} to ${reading(ms(timed.high))}` },
    { label: "Median", value: median === null ? "none" : reading(ms(median)) },
    { label: "Runs", value: runsText(counted, voided, 0) },
  ];
  const frame = { name: cell.name, label: cell.name, decision: cell.verdict.decision, verdicts: <Verdict decision={cell.verdict.decision} />, readout };

  if (timed === undefined) {
    const acks = [...new Set(cell.runs.map((run) => run.acks))].sort((a, b) => a - b).join(", ");
    return (
      <Frame {...frame} views={["table"]} render={() => <RunTable cell={cell} />}>
        <p>
          The algebra predicts that no TCP timer fires. The harness measured silence in {counted} of {counted} counted runs, over a window of {duration(ms(p.window ?? 0))}. In each run the frozen peer sent {acks}{" "}
          acknowledgments.
        </p>
        <p className="sy-muted">{cell.verdict.why}</p>
      </Frame>
    );
  }

  const runs = cell.runs.flatMap((run, n) =>
    (run.void ?? null) !== null || run.elapsed === null ? [] : [{ t: ms(run.elapsed), row: 0, label: `Run ${n + 1}, environment ${run.environment + 1}` }],
  );
  const band = { low: ms(timed.low), high: ms(timed.high) };
  const data: StripData = { band, runs, lines: median === null ? [] : [{ t: ms(median), label: "The median" }] };
  const what = p.recovers === undefined ? "the detection" : "the return of the reply";
  const label = `${cell.name}: the prediction for ${what} is ${duration(band.low)} to ${duration(band.high)}. The counted runs measured ${duration(Math.min(...runs.map((r) => r.t)))} to ${duration(Math.max(...runs.map((r) => r.t)))}.`;
  const axis = axisOf([data]);
  return (
    <Frame
      {...frame}
      views={["chart", "table"]}
      render={(view) =>
        view === "table" ? (
          <RunTable cell={cell} />
        ) : (
          <>
            <Strip from={axis.from} to={axis.to} {...data} label={label} />
            <Legend {...keysOf([data])} />
          </>
        )
      }
    >
      <p className="sy-muted">
        {cell.verdict.why}
        {voided === 0 ? "" : `. ${voided} void ${voided === 1 ? "run" : "runs"} (in the table).`}
      </p>
    </Frame>
  );
}

/** The cells of one group, in the sequence of the data. */
export default function CellResults(props: { readonly group: Group }): ReactElement {
  const cells = harness.cells.filter((cell) => cell.group === props.group);
  return (
    <div className="not-content sy-cells">
      {cells.map((cell) => (
        <HarnessFrame key={cell.name} cell={cell} />
      ))}
    </div>
  );
}
