/**
 * The frame of one result cell. It has a chart of the runs of the cell against the band that the algebra
 * predicted, and a table of the same runs. It also tells the prediction, the settings and the verdict. The
 * chart has a dot for each counted run, on one row for each environment. A cell without a band is a
 * measurement only. Its chart shows the fastest, the median and the slowest reply of each run, or the time
 * of each run from its reference.
 *
 * The page of the network failures and the page of the topologies show their cells in this frame. A cell
 * of the topologies can also have a re-run, warm-ups, and the times when a router forgot the flow.
 */
import { useState, type ReactElement, type ReactNode } from "react";
import { duration } from "../lib/format.ts";
import Strip from "./Strip.tsx";

/** These are the fastest, the median and the slowest reply of one run of a distribution cell. */
interface Replies {
  readonly count: number;
  readonly fastest: number | null;
  readonly median: number | null;
  readonly slowest: number | null;
}

/** A result run is one run of a cell, as a copy of the site keeps it. Each time is in seconds. */
export interface ResultRun {
  readonly environment: number;
  readonly outcome: string;
  readonly elapsed: number | null;
  readonly void: string | null;
  readonly retransmissions?: number | undefined;
  readonly replies?: Replies | null | undefined;
  /** This time is when a router forgot the flow, from the last segment that the client received. Null tells that the router kept it. */
  readonly forgot?: number | null | undefined;
  /** This text tells what in the run disagrees with the prediction, or null. */
  readonly finding?: string | null | undefined;
}

/** A warm-up is the start of an environment: one run that the verdict does not count. */
export interface ResultWarmup {
  readonly environment: number;
  readonly outcome: string;
  readonly elapsed: number | null;
}

/** A result is one run of a cell: its verdict, its counted and void runs, and its warm-up runs. */
export interface Result {
  readonly verdict: {
    readonly decision: string;
    readonly counted: number;
    readonly voided: number;
    readonly median: number | null;
    readonly why: string;
  };
  readonly runs: readonly ResultRun[];
  readonly warmups?: readonly ResultWarmup[] | undefined;
}

/** A result cell is a cell of a copy of the site: its name, its prediction, its result and its re-run. */
export interface ResultCell extends Result {
  readonly name: string;
  readonly prediction: {
    readonly kind: string;
    readonly timer: string | null;
    readonly errno: string | null;
    readonly from: string | null;
    readonly low: number | null;
    readonly high: number | null;
    readonly window: number | null;
    readonly why: string | null;
  };
  /** This decision is the decision of an earlier run that a rerun replaced, or null. */
  readonly firstRun?: string | null | undefined;
  /** This result is the re-run of the cell, or null. */
  readonly rerun?: Result | null | undefined;
}

const ms = (s: number): number => s * 1000;

/** These phrases name the detector of a prediction, in a sentence. */
const BY: Readonly<Record<string, string>> = {
  keepalive: "keepalive",
  retrans_giveup: "the give-up of the retransmissions",
  "rx.fin": "the FIN of the peer",
  "rx.rst": "a reset",
  expire_established: "the expiry of the flow",
};
/** These phrases name the event that the time of a detection counts from, in a sentence. */
const FROM: Readonly<Record<string, string>> = {
  "last-received": "the last segment that the observer received",
  "first-retransmission": "the first retransmission of the RTO timer",
  "peer-closed": "the close of the socket of the peer",
  "request-sent": "the send of the request",
  fault: "the start of the commit of the toxic",
};
/** These rows show the replies of each run of a measurement-only cell. */
const REPLIES = ["fastest", "median", "slowest"] as const;

function Chip(props: { readonly decision: string; readonly prefix?: string }): ReactElement {
  const prefix = props.prefix === undefined ? "" : `${props.prefix} `;
  if (props.decision === "measured") return <span className="sy-chip">∿ {prefix}measured</span>;
  const holds = props.decision === "holds";
  return (
    <span className="sy-chip" data-state={holds ? "pass" : "fail"}>
      {holds ? `✓ ${prefix}holds` : `✗ ${prefix}${props.decision}`}
    </span>
  );
}

/** This function joins a list of nodes into the text of a sentence: "a", "a and b", "a, b and c". */
export const joined = (items: readonly ReactNode[]): ReactNode[] =>
  items.flatMap((item, n) => (n === 0 ? [item] : [n === items.length - 1 ? " and " : ", ", item]));

export const code = (text: string): ReactElement => <code key={text}>{text}</code>;
/** This function gives a short setting in code font, on one line: `name = value` does not break at its spaces. */
export const setting = (text: string): ReactElement => (
  <code key={text} style={{ whiteSpace: "nowrap" }}>
    {text}
  </code>
);

/** This function gives the detector of a prediction in a sentence. A toxic of Toxiproxy gets its name in code font. */
const by = (timer: string): ReactNode => (timer.startsWith("toxic ") ? <>the toxic {code(timer.slice("toxic ".length))}</> : (BY[timer] ?? timer));

/** This function gives a sysctl in code font, without its prefix `net.ipv4.`. */
export const sysctl = ({ name, value }: { readonly name: string; readonly value: string }): ReactElement =>
  setting(`${name.replace(/^net\.ipv4\./, "")} = ${value}`);

/** This function tells the outcome of each counted run of a result. */
const endedOf = (result: Result): ReactNode => {
  const counted = result.runs.filter((run) => run.void === null);
  const tally = [...new Set(counted.map((run) => run.outcome))].map((outcome) => ({
    outcome,
    count: counted.filter((run) => run.outcome === outcome).length,
  }));
  if (tally.length === 1 && tally[0]?.outcome === "answered") return <>Each counted run got its reply.</>;
  return tally.length === 1 && tally[0] !== undefined ? (
    <>Each counted run ended with {code(tally[0].outcome)}.</>
  ) : (
    <>The counted runs ended with {joined(tally.map(({ outcome, count }) => <span key={outcome}>{code(outcome)} {count} times</span>))}.</>
  );
};

/** This component tells what the algebra predicts for a cell, and how the counted runs ended. */
function Prediction(props: { readonly cell: ResultCell }): ReactElement {
  const { cell } = props;
  const { prediction: p, runs, verdict } = cell;
  const counted = runs.filter((run) => run.void === null);
  const ended = endedOf(cell);
  if (p.kind === "measured" && p.from !== null)
    return (
      <p>
        This cell has no band, and the algebra does not predict it. {p.why} The harness measures the time from {FROM[p.from] ?? p.from} to the end of the connection, or to the last data. {ended}
      </p>
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
  if (p.kind === "replies")
    return (
      <p>
        The algebra predicts that the reply comes back {duration(ms(p.low ?? 0))} to {duration(ms(p.high ?? 0))} after the send of the request, and that nothing detects the fault. {ended}
      </p>
    );
  return (
    <p>
      The algebra predicts {code(p.errno ?? "")} from {by(p.timer ?? "")}, {duration(ms(p.low ?? 0))} to {duration(ms(p.high ?? 0))} after {FROM[p.from ?? ""] ?? p.from}. {ended}
    </p>
  );
}

function RunTable(props: { readonly cell: ResultCell; readonly result: Result; readonly forget: boolean }): ReactElement {
  const { cell, result, forget } = props;
  const replies = cell.prediction.kind === "measured" && cell.prediction.from === null;
  const retransmissions = result.runs.some((run) => run.retransmissions !== undefined);
  const finding = result.runs.some((run) => (run.finding ?? null) !== null);
  const time = (t: number | null): string => (t === null ? "" : duration(ms(t)));
  const timeCells = (run: ResultRun) =>
    replies ? (
      <>
        <td>{run.replies?.count ?? ""}</td>
        {REPLIES.map((key) => (
          <td key={key}>{time(run.replies?.[key] ?? null)}</td>
        ))}
      </>
    ) : (
      <td>{time(run.elapsed)}</td>
    );
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Environment</th>
            <th>Outcome</th>
            {replies ? (
              <>
                <th>Replies</th>
                <th>Fastest</th>
                <th>Median</th>
                <th>Slowest</th>
              </>
            ) : (
              <th>Time</th>
            )}
            {forget ? <th>Forget</th> : null}
            {retransmissions ? <th>Retransmissions</th> : null}
            <th>Void</th>
            {finding ? <th>Finding</th> : null}
          </tr>
        </thead>
        <tbody>
          {(result.warmups ?? []).map((run, n) => (
            <tr key={`warm-up ${n}`} className="sy-muted">
              <td>Warm-up</td>
              <td>{run.environment + 1}</td>
              <td>{run.outcome}</td>
              {replies ? <td colSpan={4} /> : <td>{time(run.elapsed)}</td>}
              {forget ? <td /> : null}
              {retransmissions ? <td /> : null}
              <td>Not counted</td>
              {finding ? <td /> : null}
            </tr>
          ))}
          {result.runs.map((run, n) => (
            <tr key={n}>
              <td>{n + 1}</td>
              <td>{run.environment + 1}</td>
              <td>{run.outcome}</td>
              {timeCells(run)}
              {forget ? <td>{run.forgot === null || run.forgot === undefined ? "kept" : time(run.forgot)}</td> : null}
              {retransmissions ? <td>{run.retransmissions}</td> : null}
              <td>{run.void ?? ""}</td>
              {finding ? <td>{run.finding ?? ""}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A plot is what the strip of one result shows, before its axis. Each time is in milliseconds. */
interface Plot {
  readonly band?: { readonly low: number; readonly high: number };
  readonly runs: ReadonlyArray<{ readonly t: number; readonly row: number; readonly label: string }>;
  readonly warmups: ReadonlyArray<{ readonly t: number; readonly row: number; readonly label: string }>;
  readonly marks: ReadonlyArray<{ readonly t: number; readonly label: string }>;
  readonly lines: ReadonlyArray<{ readonly t: number; readonly label: string }>;
  readonly rows?: readonly string[];
  readonly label: string;
}

/** This function gives the plot of one result of a cell, or null for a cell that the harness measured as silent. */
const plotOf = (cell: ResultCell, result: Result, forget: boolean): Plot | null => {
  const p = cell.prediction;
  const counted = result.runs.map((run, n) => ({ run, n })).filter(({ run }) => run.void === null);
  const span = (times: readonly number[]): string => `${duration(Math.min(...times))} to ${duration(Math.max(...times))}`;
  if (p.kind === "measured" && p.from === null) {
    const runs = counted.flatMap(({ run, n }) =>
      REPLIES.flatMap((key, row) => {
        const t = run.replies?.[key] ?? null;
        return t === null ? [] : [{ t: ms(t), row, label: `Run ${n + 1}, the ${key} reply` }];
      }),
    );
    if (runs.length === 0) return null;
    return { runs, warmups: [], marks: [], lines: [], rows: [...REPLIES], label: `${cell.name}: no band. The replies of the counted runs took ${span(runs.map((r) => r.t))}.` };
  }
  const timed = p.kind !== "measured" && p.low !== null && p.high !== null;
  if (!timed && p.kind !== "measured") return null;
  const runs = counted.flatMap(({ run, n }) =>
    run.elapsed === null ? [] : [{ t: ms(run.elapsed), row: run.environment % 2, label: `Run ${n + 1}, environment ${run.environment + 1}` }],
  );
  const warmups = (result.warmups ?? []).flatMap((run, n) =>
    run.elapsed === null ? [] : [{ t: ms(run.elapsed), row: run.environment % 2, label: `Warm-up ${n + 1}, environment ${run.environment + 1}` }],
  );
  // the forget counts from the last segment that the client received: it shares the axis of a detection from that segment
  const marks =
    forget && p.from === "last-received"
      ? counted.flatMap(({ run, n }) => (run.forgot === null || run.forgot === undefined ? [] : [{ t: ms(run.forgot), label: `Run ${n + 1}: the router forgot the flow` }]))
      : [];
  const median = result.verdict.median;
  const lines = median === null ? [] : [{ t: ms(median), label: "The median" }];
  const measured = runs.length === 0 ? "No run counted." : `The counted runs measured ${span(runs.map((r) => r.t))}.`;
  if (!timed) return { runs, warmups, marks, lines, label: `${cell.name}: no band. ${measured}` };
  const band = { low: ms(p.low!), high: ms(p.high!) };
  const what = p.kind === "detects" ? "the detection" : "the return of the reply";
  return { band, runs, warmups, marks, lines, label: `${cell.name}: the prediction for ${what} is ${duration(band.low)} to ${duration(band.high)}. ${measured}` };
};

/** This function gives the axis of the charts of a cell: the times that they must show, and 12 % of their span on each side. */
const axisOf = (plots: readonly Plot[]): { from: number; to: number } => {
  const times = plots.flatMap((plot) => [
    ...(plot.band === undefined ? [] : [plot.band.low, plot.band.high]),
    ...[...plot.runs, ...plot.warmups, ...plot.marks].map((each) => each.t),
  ]);
  const span = Math.max(...times) - Math.min(...times) || Math.max(...times) || 1;
  return { from: Math.max(0, Math.min(...times) - span * 0.12), to: Math.max(...times) + span * 0.12 };
};

/** This function writes a verdict as one paragraph, with the count of its void runs and its warm-ups. */
const verdictText = (result: Result): string => {
  const { why, voided } = result.verdict;
  const warmups = result.warmups?.length ?? 0;
  const extra = [
    ...(voided === 0 ? [] : [`${voided} void ${voided === 1 ? "run" : "runs"}`]),
    ...(warmups === 0 ? [] : [`${warmups} warm-up ${warmups === 1 ? "run" : "runs"}`]),
  ];
  return `${why.endsWith(".") ? why : `${why}.`}${extra.length === 0 ? "" : ` ${extra.join(" and ")} (in the table).`}`;
};

/**
 * The frame of one cell: its chart or its table, its prediction, its settings and its verdict. A cell with a
 * re-run shows its first result, and then the re-run, on one axis. With `forget`, the chart and the table
 * also show when the router of the topology forgot the flow.
 */
export default function CellFrame(props: { readonly cell: ResultCell; readonly details: ReactNode; readonly forget?: boolean }): ReactElement {
  const { cell } = props;
  const forget = props.forget === true;
  const [table, setTable] = useState(false);
  const results: Result[] = cell.rerun === null || cell.rerun === undefined ? [cell] : [cell, cell.rerun];
  const plots = results.map((result) => plotOf(cell, result, forget));
  const drawn = plots.filter((plot): plot is Plot => plot !== null);
  const axis = drawn.length === 0 ? null : axisOf(drawn);
  const again = results.length > 1;
  return (
    <section className="sy-frame not-content" aria-label={cell.name}>
      <header>
        <strong>{cell.name}</strong>
        <span className="sy-row">
          <Chip decision={cell.verdict.decision} />
          {cell.rerun === null || cell.rerun === undefined ? null : <Chip decision={cell.rerun.verdict.decision} prefix="re-run" />}
          <button type="button" className="sy-button" aria-pressed={table} onClick={() => setTable(!table)}>
            Table
          </button>
        </span>
      </header>
      <div className="sy-body">
        {results.map((result, n) => {
          const plot = plots[n] ?? null;
          return (
            <div key={n} className={again ? "sy-result" : undefined}>
              {again ? <p className="sy-caption">{n === 0 ? "First run" : "Re-run"}</p> : null}
              {table ? (
                <RunTable cell={cell} result={result} forget={forget} />
              ) : plot === null || axis === null ? null : (
                <Strip from={axis.from} to={axis.to} band={plot.band} runs={plot.runs} warmups={plot.warmups} marks={plot.marks} lines={plot.lines} rows={plot.rows} label={plot.label} />
              )}
              {again ? <p className="sy-muted">{verdictText(result)}</p> : null}
            </div>
          );
        })}
        <Prediction cell={cell} />
        {props.details}
        {again ? null : <p className="sy-muted">{verdictText(cell)}</p>}
        {cell.firstRun === null || cell.firstRun === undefined ? null : (
          <p className="sy-muted">
            The harness repeated this cell after two fixes. Before the fixes, the cell {cell.firstRun === "holds" ? "held" : "failed"}.
          </p>
        )}
      </div>
    </section>
  );
}
