/**
 * The results of the network-fault cells of T01, for one manifestation. Each cell has a chart: the band that
 * the algebra predicted, and a dot for each counted run, on one row for each environment. A cell without a
 * band is a measurement only. Its chart shows the fastest, the median and the slowest reply of each run.
 */
import { useState, type ReactElement, type ReactNode } from "react";
import faults from "../data/faults-2026-10-14.json";
import { duration } from "../lib/format.ts";
import Legend from "./Legend.tsx";
import Strip from "./Strip.tsx";

type Cell = (typeof faults.cells)[number];

const ms = (s: number): number => s * 1000;

/** These phrases name the detector of a prediction, in a sentence. */
const BY: Readonly<Record<string, string>> = {
  keepalive: "keepalive",
  retrans_giveup: "the give-up of the retransmissions",
  "rx.fin": "the FIN of the peer",
};
/** These phrases name the event that the time of a detection counts from, in a sentence. */
const FROM: Readonly<Record<string, string>> = {
  "last-received": "the last segment that the observer received",
  "first-retransmission": "the first retransmission of the RTO timer",
  "peer-closed": "the close of the socket of the peer",
};
/** These rows show the replies of each run of a measurement-only cell. */
const REPLIES = ["fastest", "median", "slowest"] as const;

function Chip(props: { readonly decision: string }): ReactElement {
  if (props.decision === "measured") return <span className="sy-chip">∿ measured</span>;
  const holds = props.decision === "holds";
  return (
    <span className="sy-chip" data-state={holds ? "pass" : "fail"}>
      {holds ? "✓ holds" : `✗ ${props.decision}`}
    </span>
  );
}

/** This function joins a list of nodes into the text of a sentence: "a", "a and b", "a, b and c". */
const joined = (items: readonly ReactNode[]): ReactNode[] =>
  items.flatMap((item, n) => (n === 0 ? [item] : [n === items.length - 1 ? " and " : ", ", item]));

const code = (text: string): ReactElement => <code key={text}>{text}</code>;
/** This function gives a short setting in code font, on one line: `name = value` does not break at its spaces. */
const setting = (text: string): ReactElement => (
  <code key={text} style={{ whiteSpace: "nowrap" }}>
    {text}
  </code>
);

/** This component tells what the cell sets: the sysctls of each side, the settings of Redis and the fault itself. */
function Settings(props: { readonly cell: Cell }): ReactElement {
  const { settings } = props.cell;
  const sysctl = ({ name, value }: { readonly name: string; readonly value: string }) => setting(`${name.replace(/^net\.ipv4\./, "")} = ${value}`);
  const parts: ReactElement[] = [];
  if (settings.observer.length > 0) parts.push(<span key="observer">The observer sets {joined(settings.observer.map(sysctl))}. </span>);
  if (settings.peer.length > 0) parts.push(<span key="peer">The sender of the ICMP sets {joined(settings.peer.map(sysctl))}. </span>);
  if (settings.redis.length > 0) parts.push(<span key="redis">Redis sets {joined(settings.redis.map(({ name, value }) => setting(`${name} ${value}`)))}. </span>);
  if (settings.latency !== null) parts.push(<span key="latency">The target adds {duration(ms(settings.latency))} of latency to each segment that it sends. </span>);
  if (settings.stall !== null) parts.push(<span key="stall">The stall lasts {duration(ms(settings.stall))} from the send of the request. </span>);
  if (settings.mtu !== null) parts.push(<span key="mtu">Each segment to the client that is longer than {settings.mtu} bytes drops. </span>);
  if (settings.netem !== null) parts.push(<span key="netem">The target applies {code(`netem ${settings.netem}`)} to each segment that it sends. </span>);
  if (parts.length === 0) parts.push(<span key="none">The observer has the Linux 6.6 values of each TCP setting.</span>);
  return <p className="sy-muted">{parts}</p>;
}

/** This component tells what the algebra predicts for a cell, and how the counted runs ended. */
function Prediction(props: { readonly cell: Cell }): ReactElement {
  const { prediction: p, runs, verdict } = props.cell;
  const counted = runs.filter((run) => run.void === null);
  const tally = [...new Set(counted.map((run) => run.outcome))].map((outcome) => ({
    outcome,
    count: counted.filter((run) => run.outcome === outcome).length,
  }));
  const ended =
    tally.length === 1 && tally[0] !== undefined ? (
      <>Each counted run ended with {code(tally[0].outcome)}.</>
    ) : (
      <>The counted runs ended with {joined(tally.map(({ outcome, count }) => <span key={outcome}>{code(outcome)} {count} times</span>))}.</>
    );
  if (p.kind === "measured")
    return (
      <p>
        This cell has no band, because its reply times are a distribution. A prediction of a distribution needs a simulator, and the program has no simulator at this time. In this cell, {p.why}.
      </p>
    );
  if (p.kind === "silent")
    return (
      <p>
        The algebra predicts that no TCP timer fires in a window of {duration(ms(p.window ?? 0))}. The harness measured silence in {counted.filter((run) => run.outcome === "silent").length} of {verdict.counted} counted runs.
      </p>
    );
  if (p.kind === "recovers")
    return (
      <p>
        The algebra predicts that the reply comes back {duration(ms(p.low ?? 0))} to {duration(ms(p.high ?? 0))} after the send of the request.{" "}
        {counted.every((run) => run.outcome === "answered") ? <>Nothing detected the stall, and each counted run got its reply.</> : ended}
      </p>
    );
  return (
    <p>
      The algebra predicts {code(p.errno ?? "")} from {BY[p.timer ?? ""] ?? p.timer}, {duration(ms(p.low ?? 0))} to {duration(ms(p.high ?? 0))} after {FROM[p.from ?? ""] ?? p.from}. {ended}
    </p>
  );
}

function RunTable(props: { readonly cell: Cell }): ReactElement {
  const measured = props.cell.prediction.kind === "measured";
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Environment</th>
            <th>Outcome</th>
            {measured ? (
              <>
                <th>Replies</th>
                <th>Fastest</th>
                <th>Median</th>
                <th>Slowest</th>
              </>
            ) : (
              <th>Time</th>
            )}
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
              {measured ? (
                <>
                  <td>{run.replies?.count ?? ""}</td>
                  {REPLIES.map((key) => {
                    const t = run.replies?.[key] ?? null;
                    return <td key={key}>{t === null ? "" : duration(ms(t))}</td>;
                  })}
                </>
              ) : (
                <td>{run.elapsed === null ? "" : duration(ms(run.elapsed))}</td>
              )}
              <td>{run.retransmissions}</td>
              <td>{run.void ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** This function gives the axis of a chart: the times that it must show, and 12 % of their span on each side. */
const axisOf = (times: readonly number[]): { from: number; to: number } => {
  const span = Math.max(...times) - Math.min(...times) || Math.max(...times) || 1;
  return { from: Math.max(0, Math.min(...times) - span * 0.12), to: Math.max(...times) + span * 0.12 };
};

function Chart(props: { readonly cell: Cell }): ReactElement | null {
  const { cell } = props;
  const p = cell.prediction;
  if (p.kind === "measured") {
    const runs = cell.runs.flatMap((run, n) =>
      run.void !== null || run.replies === null
        ? []
        : REPLIES.flatMap((key, row) => {
            const t = run.replies[key];
            return t === null ? [] : [{ t: ms(t), row, label: `Run ${n + 1}, the ${key} reply` }];
          }),
    );
    if (runs.length === 0) return null;
    const { from, to } = axisOf(runs.map((run) => run.t));
    const label = `${cell.name}: no band. The replies of the counted runs took ${duration(Math.min(...runs.map((r) => r.t)))} to ${duration(Math.max(...runs.map((r) => r.t)))}.`;
    return <Strip from={from} to={to} runs={runs} rows={[...REPLIES]} label={label} />;
  }
  if (p.low === null || p.high === null) return null;
  const low = ms(p.low);
  const high = ms(p.high);
  const runs = cell.runs.flatMap((run, n) =>
    run.void !== null || run.elapsed === null ? [] : [{ t: ms(run.elapsed), row: run.environment % 2, label: `Run ${n + 1}, environment ${run.environment + 1}` }],
  );
  const { from, to } = axisOf([low, high, ...runs.map((run) => run.t)]);
  const median = cell.verdict.median;
  const lines = median === null ? [] : [{ t: ms(median), label: "The median" }];
  const what = p.kind === "recovers" ? "the return of the reply" : "the detection";
  const measured = runs.length === 0 ? "No run counted." : `The counted runs measured ${duration(Math.min(...runs.map((r) => r.t)))} to ${duration(Math.max(...runs.map((r) => r.t)))}.`;
  const label = `${cell.name}: the prediction for ${what} is ${duration(low)} to ${duration(high)}. ${measured}`;
  return <Strip from={from} to={to} band={{ low, high }} runs={runs} lines={lines} label={label} />;
}

function CellFrame(props: { readonly cell: Cell }): ReactElement {
  const { cell } = props;
  const [table, setTable] = useState(false);
  const { voided } = cell.verdict;
  return (
    <section className="sy-frame not-content" aria-label={cell.name}>
      <header>
        <strong>{cell.name}</strong>
        <span className="sy-row">
          <Chip decision={cell.verdict.decision} />
          <button type="button" className="sy-button" aria-pressed={table} onClick={() => setTable(!table)}>
            Table
          </button>
        </span>
      </header>
      <div className="sy-body">
        {table ? <RunTable cell={cell} /> : <Chart cell={cell} />}
        <Prediction cell={cell} />
        <Settings cell={cell} />
        <p className="sy-muted">
          {cell.verdict.why}
          {voided === 0 ? "" : `. ${voided} void ${voided === 1 ? "run" : "runs"} (in the table).`}
        </p>
        {cell.firstRun === null ? null : (
          <p className="sy-muted">
            The harness repeated this cell after two fixes. Before the fixes, the cell {cell.firstRun === "holds" ? "held" : "failed"}.
          </p>
        )}
      </div>
    </section>
  );
}

/** The cells of one manifestation, in the sequence of the catalog. */
export default function FaultResults(props: { readonly manifestation: string }): ReactElement {
  const cells = faults.cells.filter((cell) => cell.manifestation === props.manifestation);
  if (cells.length === 0) throw new Error(`no cell has the manifestation ${props.manifestation}`);
  const timed = cells.some((cell) => cell.prediction.kind === "detects" || cell.prediction.kind === "recovers");
  const measured = cells.some((cell) => cell.prediction.kind === "measured");
  return (
    <div className="not-content">
      {timed ? <Legend band runs line="Median" /> : measured ? <Legend runs /> : null}
      {cells.map((cell) => (
        <CellFrame key={cell.name} cell={cell} />
      ))}
    </div>
  );
}
