/**
 * The cells of the port range, from one copy of a CI run. Each cell has a frame with its settings, its
 * prediction, its verdict and the table of its counted runs. A cell of a held port also has a strip chart.
 * The chart has a dot for the first free port of each counted run, against the band of the prediction.
 *
 * The lenses of the page of the port range link to these frames. Thus the ID of a frame comes from
 * `portCellAnchor` of the lenses.
 */
import type { ReactElement } from "react";
import { count, duration } from "../lib/format.ts";
import { PORT_COPY_RAW, portCellAnchor } from "../model/lenses/ports.ts";
import { axisOf } from "./CellFrame.tsx";
import Frame, { type ReadoutItem } from "./Frame.tsx";
import Strip, { type StripData } from "./Strip.tsx";
import Verdict from "./Verdict.tsx";

type Cell = (typeof PORT_COPY_RAW.cells)[number];
type Run = NonNullable<Cell["result"]>["runs"][number];

const CLOSES: Readonly<Record<string, string>> = { reset: "a reset after each round", client: "the client closes first", target: "the target closes first" };

/** This function writes the counts of connects of a prediction: "16", or "4 or 5". */
const countsText = (counts: readonly number[]): string => [...counts].sort((a, b) => a - b).map((n) => count(n)).join(" or ");

/** This function writes the counts of one run: "16 in 50 searches", or each count with its searches. */
const runCounts = (run: Run): string =>
  Object.entries(run.counts as Readonly<Record<string, number>>)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([connects, n]) => `${connects} in ${count(n)}`)
    .join(", ");

/** This function writes a time of the copy, in seconds, or a dash for no time. */
const time = (seconds: number | null): string => (seconds === null ? "—" : duration(seconds * 1000));

/** The readout of a cell: its settings, then what it predicts. */
const readoutOf = (cell: Cell): ReadoutItem[] => {
  const { settings, prediction } = cell;
  const items: ReadoutItem[] = [
    { label: "Ports", value: count(settings.size) },
    { label: "Destinations", value: count(settings.destinations) },
    { label: "tcp_tw_reuse", value: String(settings.reuse) },
    { label: "Each connection", value: CLOSES[settings.close] ?? settings.close, wide: true },
    { label: "Connects of a search", value: countsText(prediction.counts) },
  ];
  if (prediction.freed !== null) items.push({ label: "First free port", value: `${time(prediction.freed.low)} to ${time(prediction.freed.high)}`, wide: true });
  if (prediction.retransmissions !== null) items.push({ label: "Retransmissions", value: count(prediction.retransmissions) });
  if (settings.fault !== null) items.push({ label: "Fault", value: "the first ACK of each FIN of the client drops", wide: true });
  return items;
};

/** This function gives the strip of a cell of a held port: the band of the prediction, and the first free port of each run. Each time is in milliseconds. */
const stripOf = (cell: Cell): StripData | null => {
  const { freed } = cell.prediction;
  const runs = cell.result?.runs ?? [];
  if (freed === null || runs.length === 0) return null;
  return {
    band: { low: freed.low * 1000, high: freed.high * 1000 },
    runs: runs.flatMap((run, at) => (run.firstFreed === null ? [] : [{ t: run.firstFreed * 1000, row: at, label: `env ${run.environment} run ${run.index}: ${time(run.firstFreed)}` }])),
  };
};

/** The table of the counted runs of a cell. */
function RunTable(props: { readonly runs: readonly Run[] }): ReactElement {
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Connects in each search</th>
            <th className="num">First free port</th>
            <th className="num">Retransmissions</th>
          </tr>
        </thead>
        <tbody>
          {props.runs.map((run) => (
            <tr key={`${run.environment} ${run.index}`}>
              <td className="sy-text">
                env {run.environment}, run {run.index}
              </td>
              <td className="sy-text">{runCounts(run)}</td>
              <td className="num">{time(run.firstFreed)}</td>
              <td className="num">{count(run.retransmissions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The frame of one cell of the port range. */
function PortCell(props: { readonly cell: Cell }): ReactElement {
  const { cell } = props;
  const result = cell.result;
  const strip = stripOf(cell);
  const axis = strip === null ? null : axisOf([strip]);
  return (
    <Frame
      id={portCellAnchor(cell.plan)}
      name={cell.name}
      label={`${cell.plan} ${cell.name}`}
      tag={cell.plan}
      decision={result?.decision}
      verdicts={result === null ? <Verdict decision="no record" /> : <Verdict decision={result.decision} />}
      readout={readoutOf(cell)}
      views={strip === null ? ["table"] : ["chart", "table"]}
      render={(view) =>
        result === null ? null : view === "chart" && strip !== null && axis !== null ? (
          <Strip {...strip} from={axis.from} to={axis.to} label={`${cell.plan}: the first free port of each run, against the band of the prediction`} />
        ) : (
          <RunTable runs={result.runs} />
        )
      }
    >
      <p>{cell.prediction.why}</p>
      <p>{result === null ? "The copy has no record of this cell." : `${result.why} ${result.voided === 0 ? "No run was void." : `${count(result.voided)} runs were void.`}`}</p>
    </Frame>
  );
}

/**
 * The frames of the cells of one part, in the sequence of the copy. The part `search` has the cells with a
 * reset after each round, PR.1 to PR.4. The part `hold` has the cells of a held port, PR.5 to PR.8.
 */
export default function PortCells(props: { readonly part: "search" | "hold" }): ReactElement {
  const cells = PORT_COPY_RAW.cells.filter((cell) => (cell.settings.close === "reset") === (props.part === "search"));
  if (cells.length === 0) throw new Error(`the copy of the port range has no cell of the part ${props.part}`);
  return (
    <div className="not-content sy-cells">
      {cells.map((cell) => (
        <PortCell key={cell.plan} cell={cell} />
      ))}
    </div>
  );
}
