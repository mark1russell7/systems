/**
 * The results of the cells from the hosted runners of GitHub: T12 under Sentinels, the HTTP
 * keep-alive race, MongoDB, and Kubernetes in kind. Each harness cell has a frame with a strip chart,
 * its prediction and its verdict. The chart has a dot for each counted run, against the band. A frame
 * of a group also has the stages of the failover. A kind cell has a frame with its verdict, and a
 * strip chart when its main value is a time.
 */
import type { ReactElement, ReactNode } from "react";
import http from "../data/http-2026-10-16.json";
import kind from "../data/kind-2026-10-16.json";
import mongodb from "../data/mongodb-2026-10-16.json";
import sentinel from "../data/sentinel-2026-10-16.json";
import { duration } from "../lib/format.ts";
import { code, joined } from "./CellFrame.tsx";
import Legend from "./Legend.tsx";
import Strip from "./Strip.tsx";

interface Band {
  readonly low: number;
  readonly high: number;
}
/** A stage is one step of the timeline of a group: its band, when the prediction gives one, and its median. */
interface Stage {
  readonly stage: string;
  readonly low: number | null;
  readonly high: number | null;
  readonly median: number | null;
  readonly decision: string | null;
}
/** These are the writes of a group cell over its counted runs, and the member that the client wrote to after the fault. */
interface Writes {
  readonly lost: { readonly runs: number; readonly total: number; readonly median: number | null; readonly max: number | null };
  readonly old: { readonly median: number | null; readonly max: number | null };
  readonly errors: ReadonlyArray<{ readonly name: string; readonly runs: number; readonly first: number | null }>;
  readonly moved: number;
  readonly stayed: number;
}
/** A run cell is a harness cell of a copy of a CI run. Each time is in seconds. */
interface RunCell {
  readonly plan: string | null;
  readonly catalog: string;
  readonly name: string;
  readonly group: string;
  readonly decision: string;
  readonly counted: number;
  readonly voided: number;
  readonly band: Band | null;
  readonly median: number | null;
  readonly why: string;
  /** These are the times of each counted run, by environment. A run with no time has null. */
  readonly runs: ReadonlyArray<ReadonlyArray<number | null>>;
  readonly warmups: ReadonlyArray<number | null>;
  readonly voids: string | null;
  readonly prediction: { readonly kind: string; readonly low: number | null; readonly high: number | null; readonly window: number | null; readonly text: string };
  readonly first?: string | null;
  readonly repeated?: string | null;
  readonly stages?: readonly Stage[] | null;
  readonly writes?: Writes | null;
  readonly stage?: string;
  readonly ordering?: string | null;
  readonly requests?: ReadonlyArray<{ readonly outcome: string; readonly count: number }>;
}

const COPIES: Readonly<Record<string, readonly RunCell[]>> = {
  sentinel: sentinel.cells,
  http: http.cells,
  mongodb: mongodb.cells,
};

const ms = (s: number): number => s * 1000;
const time = (s: number): string => duration(ms(s));
/** This function writes a time with 4 decimals at 1 s or more, for a band of the HTTP borders that is a few milliseconds wide. */
const fine = (s: number): string => (s >= 1 ? `${Number(s.toFixed(4))} s` : time(s));

/** This function writes a number with a comma in each group of three digits: 11,462. */
const number = (n: number): string => n.toLocaleString("en-US");
/** This function writes the count of a noun: "1 run", "2 runs". */
const count = (n: number, noun: string): string => `${number(n)} ${n === 1 ? noun : `${noun}s`}`;

/** This component is the chip of a decision: holds, fails, a measurement or a calibration. */
export function Chip(props: { readonly decision: string; readonly text?: string }): ReactElement {
  const text = props.text === undefined ? "" : ` ${props.text}`;
  if (props.decision === "measured") return <span className="sy-chip">∿ measured{text}</span>;
  if (props.decision === "calibration") return <span className="sy-chip">◇ calibration{text}</span>;
  const holds = props.decision === "holds";
  return (
    <span className="sy-chip" data-state={holds ? "pass" : "fail"}>
      {holds ? "✓ holds" : `✗ ${props.decision}`}
      {text}
    </span>
  );
}

/** A plot is what the strip of one cell shows. Each time is in milliseconds. */
interface Plot {
  readonly from: number;
  readonly to: number;
  readonly band: Band | undefined;
  readonly runs: ReadonlyArray<{ readonly t: number; readonly row: number; readonly label: string }>;
  readonly warmups: ReadonlyArray<{ readonly t: number; readonly row: number; readonly label: string }>;
  readonly lines: ReadonlyArray<{ readonly t: number; readonly label: string }>;
  readonly label: string;
}

/** This function gives the axis of a strip: the times that it must show, and 12 % of their span on each side. */
const axisOf = (times: readonly number[]): { readonly from: number; readonly to: number } => {
  const span = Math.max(...times) - Math.min(...times) || Math.max(...times) || 1;
  return { from: Math.max(0, Math.min(...times) - span * 0.12), to: Math.max(...times) + span * 0.12 };
};

/** This function gives the plot of a harness cell, or null for a cell whose runs have no time. */
const plotOf = (cell: RunCell): Plot | null => {
  let n = 0;
  const runs = cell.runs.flatMap((times, environment) =>
    times.flatMap((t) => {
      n += 1;
      return t === null ? [] : [{ t: ms(t), row: environment % 2, label: `Run ${n}, environment ${environment + 1}` }];
    }),
  );
  if (runs.length === 0) return null;
  const warmups = cell.warmups.flatMap((t, environment) => (t === null ? [] : [{ t: ms(t), row: environment % 2, label: `Warm-up, environment ${environment + 1}` }]));
  const p = cell.prediction;
  const band = p.low === null || p.high === null ? undefined : { low: ms(p.low), high: ms(p.high) };
  const axis = axisOf([...runs, ...warmups].map((run) => run.t).concat(band === undefined ? [] : [band.low, band.high]));
  const span = `The counted runs measured ${duration(Math.min(...runs.map((run) => run.t)))} to ${duration(Math.max(...runs.map((run) => run.t)))}.`;
  const label = band === undefined ? `${cell.name}: no band. ${span}` : `${cell.name}: the prediction is ${duration(band.low)} to ${duration(band.high)}. ${span}`;
  return { ...axis, band, runs, warmups, lines: cell.median === null ? [] : [{ t: ms(cell.median), label: "The median" }], label };
};

/** This component is the table of the stages of a group in one cell. It gives the band of each stage, and its median over the counted runs. */
function StageTable(props: { readonly stages: readonly Stage[] }): ReactElement {
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Prediction</th>
            <th>Median</th>
          </tr>
        </thead>
        <tbody>
          {props.stages.map((stage) => (
            <tr key={stage.stage}>
              <td>{code(stage.stage)}</td>
              <td>{stage.low === null || stage.high === null ? <span className="sy-muted">no band</span> : `${time(stage.low)} to ${time(stage.high)}`}</td>
              <td>
                {stage.median === null ? "" : time(stage.median)}
                {stage.decision === null ? null : (
                  <>
                    {" "}
                    <Chip decision={stage.decision} />
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** This component tells what became of the writes of a group cell. */
function WritesText(props: { readonly cell: RunCell; readonly writes: Writes }): ReactElement {
  const { cell, writes } = props;
  const { lost, old } = writes;
  const errors = writes.errors.filter((each) => each.name !== "Error");
  return (
    <p className="sy-muted">
      <span>
        The client wrote to a new primary in {writes.moved} of the {cell.counted} counted runs.{" "}
      </span>
      <span>
        {lost.total === 0
          ? "The group kept each write that a primary accepted. "
          : `The group lost ${count(lost.total, "accepted write")} in all: ${number(lost.median ?? 0)} in the median run, and ${number(lost.max ?? 0)} at most. `}
      </span>
      {old.median === null || old.median === 0 ? null : <span>The old primary accepted {count(old.median, "write")} after the fault in the median run. </span>}
      {errors.map((each) => (
        <span key={each.name}>
          The client met {code(each.name)} in {count(each.runs, "run")}
          {each.first === null ? "" : `, first at ${time(each.first)} in the median run`}.{" "}
        </span>
      ))}
    </p>
  );
}

/** This component tells what the request of an HTTP cell met in the counted runs, and the ordering of a race. */
function RequestText(props: { readonly cell: RunCell }): ReactElement | null {
  const { cell } = props;
  const requests = (cell.requests ?? []).filter((each) => each.outcome !== "no second request");
  if (requests.length === 0 && (cell.ordering ?? null) === null) return null;
  return (
    <p className="sy-muted">
      {cell.ordering === null || cell.ordering === undefined ? null : <span>The ordering of the race is {code(cell.ordering)}. </span>}
      {requests.length === 0 ? null : (
        <span>
          The request met {joined(requests.map((each) => <span key={each.outcome}>{code(each.outcome)} in {count(each.count, "run")}</span>))}.
        </span>
      )}
    </p>
  );
}

/** This component is the frame of one cell: its name and verdict, its strip, its prediction and the text of its verdict. */
function Frame(props: { readonly name: string; readonly plan: string | null; readonly decision: string; readonly plot: Plot | null; readonly children: ReactNode }): ReactElement {
  const { plot } = props;
  return (
    <section className="sy-frame not-content" aria-label={props.name}>
      <header>
        <strong>{props.name}</strong>
        <span className="sy-row">
          {props.plan === null ? null : <code>{props.plan}</code>}
          <Chip decision={props.decision} />
        </span>
      </header>
      <div className="sy-body">
        {plot === null ? null : <Strip from={plot.from} to={plot.to} band={plot.band} runs={plot.runs} warmups={plot.warmups} lines={plot.lines} label={plot.label} />}
        {props.children}
      </div>
    </section>
  );
}

const FIRST: Readonly<Record<string, string>> = { holds: "held", fails: "failed", measured: "was a measurement only" };

/** The cells of one group of a copy, in the sequence of the catalog. `stage` selects the defaults or the borders of the plan. */
export default function RunResults(props: { readonly copy: "sentinel" | "http" | "mongodb"; readonly group: string; readonly stage?: string }): ReactElement {
  const cells = (COPIES[props.copy] ?? []).filter((cell) => cell.group === props.group && (props.stage === undefined || cell.stage === props.stage));
  if (cells.length === 0) throw new Error(`no cell of ${props.copy} has the group ${props.group}`);
  const timed = cells.some((cell) => cell.prediction.low !== null);
  const warm = cells.some((cell) => cell.warmups.some((t) => t !== null));
  return (
    <div className="not-content">
      <Legend band={timed} runs warmups={warm} line="Median" />
      {cells.map((cell) => (
        <Frame key={`${cell.plan ?? cell.catalog} ${cell.name}`} name={cell.name} plan={cell.plan ?? cell.catalog} decision={cell.decision} plot={plotOf(cell)}>
          <p>{cell.prediction.text}</p>
          <RequestText cell={cell} />
          {cell.stages === null || cell.stages === undefined || cell.stages.length === 0 ? null : <StageTable stages={cell.stages} />}
          {cell.writes === null || cell.writes === undefined ? null : <WritesText cell={cell} writes={cell.writes} />}
          <p className="sy-muted">
            {cell.why}
            {cell.voids === null ? "" : ` ${cell.voids}`}
          </p>
          {cell.repeated === null || cell.repeated === undefined ? null : (
            <p className="sy-muted">
              {cell.repeated} Before the fix, the cell {FIRST[cell.first ?? ""] ?? cell.first}.
            </p>
          )}
        </Frame>
      ))}
    </div>
  );
}

/** The table of the writes of each group cell of a copy. It tells where the client wrote after the fault, and the writes that the group lost. */
export function WritesTable(props: { readonly copy: "sentinel" | "mongodb"; readonly group?: string }): ReactElement {
  const cells = (COPIES[props.copy] ?? []).filter((cell) => cell.writes !== null && cell.writes !== undefined && (props.group === undefined || cell.group === props.group));
  return (
    <div className="not-content sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Cell</th>
            <th>New primary</th>
            <th>Lost writes in a run</th>
            <th>Writes to the old primary</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => {
            const writes = cell.writes!;
            return (
              <tr key={`${cell.plan ?? cell.catalog} ${cell.name}`}>
                <td>
                  {cell.name}
                  <br />
                  <span className="sy-muted">{cell.plan ?? cell.catalog}</span>
                </td>
                <td>
                  {writes.moved} of {cell.counted}
                </td>
                <td>{writes.lost.total === 0 ? "none" : `${number(writes.lost.median ?? 0)}, at most ${number(writes.lost.max ?? 0)}`}</td>
                <td>{writes.old.max === 0 || writes.old.median === null ? "none" : `${number(writes.old.median)}, at most ${number(writes.old.max ?? 0)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The table of the borders of O01 for the HTTP clients. Each border has two cells. A GET before C
 * goes on the same connection, and a GET after C meets a connection that the pool closed.
 */
export function RaceBorder(): ReactElement {
  const borders = [...new Set(http.cells.filter((cell) => cell.plan?.includes(".border-off.") === true).map((cell) => cell.plan!))];
  return (
    <div className="not-content sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Client and setting</th>
            <th>A GET before C</th>
            <th>A GET after C</th>
          </tr>
        </thead>
        <tbody>
          {borders.map((plan) => {
            const pair = http.cells.filter((cell) => cell.plan === plan);
            const before = pair.find((cell) => cell.prediction.kind === "silent");
            const after = pair.find((cell) => cell.prediction.kind === "detects");
            if (before === undefined || after === undefined) throw new Error(`${plan}: not a pair of a border`);
            const setting = /^(.+), a GET [\d.]+ s after the reply$/.exec(after.name)?.[1] ?? after.name;
            const gap = (cell: RunCell): string => /a GET ([\d.]+ s) after the reply$/.exec(cell.name)?.[1] ?? "";
            return (
              <tr key={plan}>
                <td>
                  {setting}
                  <br />
                  <span className="sy-muted">{plan}</span>
                </td>
                <td>
                  <Chip decision={before.decision} text="kept" />
                  <br />
                  <span className="sy-muted">at {gap(before)}</span>
                </td>
                <td>
                  <Chip decision={after.decision} text={after.median === null ? "" : fine(after.median)} />
                  <br />
                  <span className="sy-muted">
                    at {gap(after)}, the band {after.prediction.low === null ? "" : fine(after.prediction.low)} to {after.prediction.high === null ? "" : fine(after.prediction.high)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// the kind cells
// ---------------------------------------------------------------------------------------------

type KindCell = (typeof kind.cells)[number];

/** This function writes the main value of a kind cell: a count of failed requests, of replicas, or a time. */
const valueOf = (cell: KindCell, value: number): string =>
  cell.unit === "requests" ? count(value, "failed request") : cell.unit === "replicas" ? count(value, "replica") : time(value);

/** This function gives the plot of a kind cell whose main value is a time, or null. */
const kindPlotOf = (cell: KindCell): Plot | null => {
  if (cell.unit !== "s" || cell.values.length === 0) return null;
  const runs = cell.values.map((t, n) => ({ t: ms(t), row: 0, label: `Run ${n + 1}` }));
  const p = cell.prediction.band;
  const band = p === null ? undefined : { low: ms(p.low), high: ms(p.high) };
  const axis = axisOf(runs.map((run) => run.t).concat(band === undefined ? [] : [band.low, band.high]));
  const label = `${cell.name}: ${band === undefined ? "no band" : `the prediction is ${duration(band.low)} to ${duration(band.high)}`}. The counted runs measured ${duration(Math.min(...runs.map((run) => run.t)))} to ${duration(Math.max(...runs.map((run) => run.t)))}.`;
  return { ...axis, band, runs, warmups: [], lines: cell.median === null ? [] : [{ t: ms(cell.median), label: "The median" }], label };
};

/** The cells of one group of a kind catalog, in the sequence of the catalog. */
export function KindResults(props: { readonly template: "T07" | "T18"; readonly group: string }): ReactElement {
  const cells = kind.cells.filter((cell) => cell.template === props.template && cell.group === props.group);
  if (cells.length === 0) throw new Error(`no cell of ${props.template} has the group ${props.group}`);
  const timed = cells.some((cell) => kindPlotOf(cell) !== null);
  return (
    <div className="not-content">
      {timed ? <Legend band runs line="Median" /> : null}
      {cells.map((cell) => (
        <Frame key={cell.name} name={cell.name} plan={cell.id} decision={cell.decision} plot={kindPlotOf(cell)}>
          <p>{cell.prediction.text}</p>
          {cell.unit === "requests" && cell.values.some((value) => value > 0) ? (
            <p className="sy-muted">The failed requests of each counted run: {cell.values.map(number).join(", ")}.</p>
          ) : null}
          <p className="sy-muted">{cell.why}</p>
        </Frame>
      ))}
    </div>
  );
}

/** These are the rows of the table of the modes: each pair of T07 that operates in each mode of kube-proxy. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["pod deletion, the design's hold of 2 s", "A deletion, the hold of 2 s"],
  ["pod deletion, no hold and no preStop", "A deletion, no hold"],
  ["pod deletion while kube-proxy pauses 5 s on one node, the design's hold of 2 s", "A pause of kube-proxy, the hold of 2 s"],
  ["pod deletion while kube-proxy pauses 5 s on one node, a hold of 8 s", "A pause of kube-proxy, a hold of 8 s"],
];
const MODES = ["iptables", "ipvs", "nftables"] as const;

/** The table of the deletion pair and the pause pair of T07 in each mode of kube-proxy, with the failed requests of the median run. */
export function ModeTable(): ReactElement {
  const find = (mode: string, name: string): KindCell => {
    const cell = kind.cells.find((each) => each.template === "T07" && each.name === `${mode}, ${name}`);
    if (cell === undefined) throw new Error(`no cell T07 ${mode}, ${name}`);
    return cell;
  };
  return (
    <div className="not-content sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Cell</th>
            {MODES.map((mode) => (
              <th key={mode}>{code(mode)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PAIRS.map(([name, label]) => (
            <tr key={name}>
              <td>{label}</td>
              {MODES.map((mode) => {
                const cell = find(mode, name);
                return (
                  <td key={mode}>
                    <Chip decision={cell.decision} />
                    <br />
                    <span className="sy-muted">
                      {cell.median === null ? "" : `${valueOf(cell, cell.median)} in the median run`}
                      {cell.failed === 0 ? "" : `, ${cell.failed} of ${cell.counted} runs ${cell.failed === 1 ? "disagrees" : "disagree"}`}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The propagation of a deletion in each mode: a strip of the time of each node in each run, and a table of the spreads. */
export function Propagation(): ReactElement {
  const modes = MODES.map((mode) => {
    const spread = (kind.propagation as Readonly<Record<string, (typeof kind.propagation)["iptables"]>>)[mode];
    if (spread === undefined) throw new Error(`no propagation for ${mode}`);
    return { mode, spread };
  });
  const runs = modes.flatMap(({ spread }, row) => spread.values.map((t, n) => ({ t: ms(t), row, label: `${MODES[row]}, value ${n + 1}` })));
  const axis = axisOf(runs.map((run) => run.t));
  const label = `The propagation of a deletion to the rules of each node, by mode: ${modes.map(({ mode, spread }) => `${mode} ${duration(ms(spread.all?.median ?? 0))}`).join(", ")} at the median.`;
  return (
    <div className="not-content">
      <Strip from={0} to={axis.to} runs={runs} rows={[...MODES]} label={label} />
      <div className="sy-scroll">
        <table className="sy-table">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Median</th>
              <th>99th percentile</th>
              <th>Slowest</th>
              <th>EndpointSlice</th>
              <th>Intake stops</th>
            </tr>
          </thead>
          <tbody>
            {modes.map(({ mode, spread }) => (
              <tr key={mode}>
                <td>{code(mode)}</td>
                <td>{spread.all === null ? "" : time(spread.all.median)}</td>
                <td>{spread.all === null ? "" : time(spread.all.p99)}</td>
                <td>{spread.all === null ? "" : time(spread.all.max)}</td>
                <td>{spread.slice === null ? "" : time(spread.slice.median)}</td>
                <td>{spread.intake === null ? "" : time(spread.intake.median)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sy-muted">
        Each dot is the propagation to one node in one counted run: {modes[0]?.spread.all?.count ?? 0} values for each mode. The EndpointSlice and the stop of the intake give their median time after the
        deletion.
      </p>
    </div>
  );
}
