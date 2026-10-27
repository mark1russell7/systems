/**
 * The results of the cells from the hosted runners of GitHub: T12 under Sentinels, the HTTP
 * keep-alive race, MongoDB, PostgreSQL, RabbitMQ, gRPC and kind. Each harness cell has a frame with a strip chart,
 * its prediction and its verdict. The chart has a dot for each counted run, against the band. A frame
 * of a group also has the stages of the failover. A kind cell has a frame with its verdict, and a
 * strip chart when its main value is a time. The cells of T15 in kind and the S2 cells have their own copy.
 *
 * The scores of S6 for the S2 cells have their own copy too.
 */
import type { ReactElement } from "react";
import grpc from "../data/grpc-2026-10-20.json";
import http from "../data/http-2026-10-17.json";
import kind from "../data/kind-2026-10-18.json";
import mongodb from "../data/mongodb-2026-10-18.json";
import pg from "../data/pg-2026-10-19.json";
import r3 from "../data/r3-2026-10-17.json";
import rabbitmq from "../data/rabbitmq-2026-10-19.json";
import S2 from "../data/s2-2026-10-26.json";
import s2Partition from "../data/s2-partition-2026-10-26.json";
import s2PartitionChecked from "../data/s2-partition-session-check-2026-10-26.json";
import s2Stall from "../data/s2-stall-2026-10-26.json";
import s2Dependency from "../data/s2-dependency-2026-10-27.json";
import s2Flapping from "../data/s2-flapping-2026-10-27.json";
import s2Prober from "../data/s2-prober-2026-10-26.json";
import s2Zone from "../data/s2-zone-2026-10-27.json";
import s2Slow from "../data/s2-slow-2026-10-27.json";
import s2Checked from "../data/s2-session-check-2026-10-26.json";
import s6 from "../data/s6-2026-10-27.json";
import t15 from "../data/t15-2026-10-25.json";
import sentinel from "../data/sentinel-2026-10-17.json";
import { count as digits, duration, reading } from "../lib/format.ts";
import { axisOf, code, joined, predictionText, runsText } from "./CellFrame.tsx";
import Frame, { type ReadoutItem } from "./Frame.tsx";
import Legend, { keysOf } from "./Legend.tsx";
import Strip, { type StripData } from "./Strip.tsx";
import Verdict from "./Verdict.tsx";

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
/**
 * These are the writes of a group cell over its counted runs, and the member that the client wrote to after
 * the fault. The writes of a cluster of RabbitMQ are publishes (`kind`): its client publishes through one
 * node, thus no member is a new primary for it.
 */
interface Writes {
  readonly kind?: string;
  readonly lost: { readonly runs: number; readonly total: number; readonly median: number | null; readonly max: number | null };
  readonly old: { readonly median: number | null; readonly max: number | null };
  readonly errors: ReadonlyArray<{ readonly name: string; readonly runs: number; readonly first: number | null }>;
  readonly moved: number;
  readonly stayed: number;
}
/** A run cell is a harness cell of a copy of a CI run. Each time is in seconds. */
export interface RunCell {
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
  /** This name is the client of a cell, in a copy that has more than one: node-postgres or HikariCP. */
  readonly client?: string;
  /** This name is the pooler between the client and the server, for a cell of T03 or T10: PgBouncer, Pgpool-II or Supavisor. */
  readonly via?: string;
  readonly ordering?: string | null;
  readonly requests?: ReadonlyArray<{ readonly outcome: string; readonly count: number }>;
}

/** A copy is the copy of one CI run that a page of results shows. */
export type Copy = "sentinel" | "http" | "mongodb" | "pg" | "rabbitmq" | "grpc" | "r3";

export const COPIES: Readonly<Record<Copy, readonly RunCell[]>> = {
  sentinel: sentinel.cells,
  http: http.cells,
  mongodb: mongodb.cells,
  pg: pg.cells,
  rabbitmq: rabbitmq.cells,
  grpc: grpc.cells,
  r3: r3.cells,
};

/**
 * This function gives the ID of the frame of a cell on its page. One plan ID can name more than one cell:
 * a border of HTTP has two. Thus the ID also has a short hash of the client and the name of the cell.
 */
export const cellId = (cell: RunCell): string => {
  let hash = 5381;
  for (const char of `${cell.client ?? ""} ${cell.name}`) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return `cell-${(cell.plan ?? cell.catalog).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${hash.toString(36)}`;
};

const ms = (s: number): number => s * 1000;
const time = (s: number): string => duration(ms(s));
/** This function writes a time with 4 decimals at 1 s or more, for a band of the HTTP borders that is a few milliseconds wide. */
const fine = (s: number): string => reading(ms(s));

/** This function writes the count of a noun: "1 run", "2 runs". */
const count = (n: number, noun: string): string => `${digits(n)} ${n === 1 ? noun : `${noun}s`}`;

/** A plot is what the strip of one cell shows, with its axis and its accessible label. Each time is in milliseconds. */
interface Plot extends StripData {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

/** This function gives the plot of a harness cell, or null for a cell whose runs have no time. */
const plotOf = (cell: RunCell): Plot | null => {
  let n = 0;
  const runs = cell.runs.flatMap((times, environment) =>
    times.flatMap((t) => {
      n += 1;
      return t === null ? [] : [{ t: ms(t), row: 0, label: `Run ${n}, environment ${environment + 1}` }];
    }),
  );
  if (runs.length === 0) return null;
  const warmups = cell.warmups.flatMap((t, environment) => (t === null ? [] : [{ t: ms(t), row: 0, label: `Warm-up, environment ${environment + 1}` }]));
  const p = cell.prediction;
  const band = p.low === null || p.high === null ? undefined : { low: ms(p.low), high: ms(p.high) };
  const data: StripData = { band, runs, warmups, lines: cell.median === null ? [] : [{ t: ms(cell.median), label: "The median" }] };
  const span = `The counted runs measured ${duration(Math.min(...runs.map((run) => run.t)))} to ${duration(Math.max(...runs.map((run) => run.t)))}.`;
  const label = band === undefined ? `${cell.name}: no band. ${span}` : `${cell.name}: the prediction is ${duration(band.low)} to ${duration(band.high)}. ${span}`;
  return { ...axisOf([data]), ...data, label };
};

/** This component is the table of the counted runs and the warm-ups of a harness cell, by environment. */
function TimeTable(props: { readonly cell: RunCell }): ReactElement {
  const { cell } = props;
  let n = 0;
  const rows = cell.runs.flatMap((times, environment) =>
    times.map((t) => {
      n += 1;
      return { key: `${n}`, run: `${n}`, environment, t };
    }),
  );
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th className="num">Run</th>
            <th className="num">Environment</th>
            <th className="num">Time</th>
          </tr>
        </thead>
        <tbody>
          {cell.warmups.map((t, environment) =>
            t === null ? null : (
              <tr key={`warm-up ${environment}`} className="sy-warm-row">
                <td className="num">Warm-up</td>
                <td className="num">{environment + 1}</td>
                <td className="num">{fine(t)}</td>
              </tr>
            ),
          )}
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="num">{row.run}</td>
              <td className="num">{row.environment + 1}</td>
              <td className="num">{row.t === null ? "no time" : fine(row.t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** This component is the table of the stages of a group in one cell. It gives the band of each stage, and its median over the counted runs. */
function StageTable(props: { readonly stages: readonly Stage[] }): ReactElement {
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th className="num">Prediction</th>
            <th className="num">Median</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {props.stages.map((stage) => (
            <tr key={stage.stage}>
              <td>{code(stage.stage)}</td>
              <td className="num">{stage.low === null || stage.high === null ? <span className="sy-muted">no band</span> : `${time(stage.low)} to ${time(stage.high)}`}</td>
              <td className="num">{stage.median === null ? "" : time(stage.median)}</td>
              <td>{stage.decision === null ? null : <Verdict decision={stage.decision} />}</td>
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
  if (writes.kind === "publishes")
    return (
      <p className="sy-muted">
        {lost.total === 0
          ? "The queue kept each publish that it confirmed. "
          : `The queue lost ${count(lost.total, "confirmed publish")} in all: ${digits(lost.median ?? 0)} in the median run, and ${digits(lost.max ?? 0)} at most. `}
      </p>
    );
  return (
    <p className="sy-muted">
      <span>
        The client wrote to a new primary in {writes.moved} of the {cell.counted} counted runs.{" "}
      </span>
      <span>
        {lost.total === 0
          ? "The group kept each write that a primary accepted. "
          : `The group lost ${count(lost.total, "accepted write")} in all: ${digits(lost.median ?? 0)} in the median run, and ${digits(lost.max ?? 0)} at most. `}
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

const FIRST: Readonly<Record<string, string>> = { holds: "held", fails: "failed", measured: "was a measurement only" };

/** The frame of one harness cell of a CI run: its readout, its strip or its table of runs, and its text. */
function RunFrame(props: { readonly cell: RunCell }): ReactElement {
  const { cell } = props;
  const plot = plotOf(cell);
  const warmups = cell.warmups.filter((t) => t !== null).length;
  const readout: ReadoutItem[] = [
    { label: "Prediction", value: predictionText(cell.prediction) },
    { label: "Median", value: cell.median === null ? "none" : fine(cell.median) },
    { label: "Runs", value: runsText(cell.counted, cell.voided, warmups) },
  ];
  return (
    <Frame
      id={cellId(cell)}
      name={cell.name}
      label={cell.name}
      tag={cell.plan ?? cell.catalog}
      decision={cell.decision}
      verdicts={<Verdict decision={cell.decision} />}
      readout={readout}
      views={plot === null ? ["table"] : ["chart", "table"]}
      render={(view) =>
        view === "table" ? (
          <TimeTable cell={cell} />
        ) : plot === null ? null : (
          <>
            <Strip {...plot} />
            <Legend {...keysOf([plot])} />
          </>
        )
      }
    >
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
  );
}

/**
 * The cells of one group of a copy, in the sequence of the catalog. `stage` selects the defaults or
 * the borders of the plan, and `pool` selects the cells of one client. The name is not `client`,
 * because Astro reads each `client:` attribute as a directive.
 */
export default function RunResults(props: {
  readonly copy: Copy;
  readonly group: string;
  readonly stage?: string;
  readonly pool?: string;
  /** This name selects the cells through one pooler: PgBouncer, Pgpool-II or Supavisor. Null selects the cells with no pooler. */
  readonly via?: string | null;
}): ReactElement {
  const cells = (COPIES[props.copy] ?? []).filter(
    (cell) =>
      cell.group === props.group &&
      (props.stage === undefined || cell.stage === props.stage) &&
      (props.pool === undefined || cell.client === props.pool) &&
      (props.via === undefined || (props.via === null ? cell.via === undefined : cell.via === props.via)),
  );
  if (cells.length === 0)
    throw new Error(`no cell of ${props.copy} has the group ${props.group}${props.pool === undefined ? "" : ` and the client ${props.pool}`}${props.via === undefined ? "" : props.via === null ? " with no pooler" : ` through ${props.via}`}`);
  return (
    <div className="not-content sy-cells">
      {cells.map((cell) => (
        <RunFrame key={`${cell.plan ?? cell.catalog} ${cell.name}`} cell={cell} />
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
            <th className="num">New primary</th>
            <th className="num">Lost writes in a run</th>
            <th className="num">Writes to the old primary</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => {
            const writes = cell.writes!;
            return (
              <tr key={`${cell.plan ?? cell.catalog} ${cell.name}`}>
                <td className="sy-text">
                  {cell.name}
                  <br />
                  <code className="sy-tag">{cell.plan ?? cell.catalog}</code>
                </td>
                <td className="num">
                  {writes.moved} of {cell.counted}
                </td>
                <td className="num">{writes.lost.total === 0 ? "none" : `${digits(writes.lost.median ?? 0)}, at most ${digits(writes.lost.max ?? 0)}`}</td>
                <td className="num">{writes.old.max === 0 || writes.old.median === null ? "none" : `${digits(writes.old.median)}, at most ${digits(writes.old.max ?? 0)}`}</td>
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
                <td className="sy-text">
                  {setting}
                  <br />
                  <code className="sy-tag">{plan}</code>
                </td>
                <td>
                  <Verdict decision={before.decision} text="kept" />
                  <br />
                  <span className="sy-muted">at {gap(before)}</span>
                </td>
                <td>
                  <Verdict decision={after.decision} text={after.median === null ? "" : fine(after.median)} />
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

/** The kind cells of each copy: T07 and T18, T15 over gRPC through Istio, and the S2 cells of each incident. The later run of D adds its cells. */
const KIND_CELLS = [...kind.cells, ...t15.cells, ...S2.cells, ...s2Checked.cells, ...s2Partition.cells, ...s2PartitionChecked.cells, ...s2Stall.cells, ...s2Prober.cells, ...s2Dependency.cells, ...s2Flapping.cells, ...s2Zone.cells, ...s2Slow.cells];
type KindCell = (typeof KIND_CELLS)[number];

/** This function writes the main value of a kind cell: a count of failed requests, of replicas, or a time. */
const valueOf = (cell: KindCell, value: number): string =>
  cell.unit === "requests" ? count(value, "failed request") : cell.unit === "replicas" ? count(value, "replica") : cell.unit === "sockets" ? count(value, "ended socket") : fine(value);

/** This function gives the plot of a kind cell whose main value is a time, or null. */
const kindPlotOf = (cell: KindCell): Plot | null => {
  if (cell.unit !== "s" || cell.values.length === 0) return null;
  const runs = cell.values.map((t, n) => ({ t: ms(t), row: 0, label: `Run ${n + 1}` }));
  const p = cell.prediction.band;
  const band = p === null ? undefined : { low: ms(p.low), high: ms(p.high) };
  const data: StripData = { band, runs, lines: cell.median === null ? [] : [{ t: ms(cell.median), label: "The median" }] };
  const label = `${cell.name}: ${band === undefined ? "no band" : `the prediction is ${duration(band.low)} to ${duration(band.high)}`}. The counted runs measured ${duration(Math.min(...runs.map((run) => run.t)))} to ${duration(Math.max(...runs.map((run) => run.t)))}.`;
  return { ...axisOf([data]), ...data, label };
};

/** This component is the table of the main value of each counted run of a kind cell. */
function ValueTable(props: { readonly cell: KindCell }): ReactElement {
  const { cell } = props;
  const head = cell.unit === "requests" ? "Failed requests" : cell.unit === "replicas" ? "Replicas" : cell.unit === "sockets" ? "Ended sockets" : "Time";
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th className="num">Run</th>
            <th className="num">{head}</th>
          </tr>
        </thead>
        <tbody>
          {cell.values.map((value, n) => (
            <tr key={n}>
              <td className="num">{n + 1}</td>
              <td className="num">{cell.unit === "s" ? fine(value) : digits(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The cells of one group of a kind catalog, in the sequence of the catalog. */
export function KindResults(props: { readonly template: "T07" | "T18" | "T15"; readonly group: string }): ReactElement {
  const cells = KIND_CELLS.filter((cell) => cell.template === props.template && cell.group === props.group);
  if (cells.length === 0) throw new Error(`no cell of ${props.template} has the group ${props.group}`);
  return (
    <div className="not-content sy-cells">
      {cells.map((cell) => {
        const plot = kindPlotOf(cell);
        const band = cell.prediction.band;
        const readout: ReadoutItem[] = [
          ...(band === null ? [] : [{ label: "Prediction", value: `${fine(band.low)} to ${fine(band.high)}` }]),
          { label: "Median", value: cell.median === null ? "none" : valueOf(cell, cell.median) },
          { label: "Runs", value: `${cell.counted} counted${cell.failed === 0 ? "" : ` · ${cell.failed} disagree`}` },
        ];
        return (
          <Frame
            key={cell.name}
            name={cell.name}
            label={cell.name}
            tag={cell.id}
            decision={cell.decision}
            verdicts={<Verdict decision={cell.decision} />}
            readout={readout}
            views={plot === null ? ["table"] : ["chart", "table"]}
            render={(view) =>
              view === "table" ? (
                <ValueTable cell={cell} />
              ) : plot === null ? null : (
                <>
                  <Strip {...plot} />
                  <Legend {...keysOf([plot])} />
                </>
              )
            }
          >
            <p>{cell.prediction.text}</p>
            {cell.unit === "requests" && cell.values.some((value) => value > 0) ? (
              <p className="sy-muted">The failed requests of each counted run: {cell.values.map(digits).join(", ")}.</p>
            ) : null}
            <p className="sy-muted">{cell.why}</p>
            {"first" in cell && cell.first === "fails" ? <p className="sy-muted">The first run of this cell failed. These runs are of its next run, after the fix that the page gives.</p> : null}
          </Frame>
        );
      })}
    </div>
  );
}

/** These are the modes of kube-proxy, in the sequence of the catalog. */
const MODES = ["iptables", "ipvs", "nftables"] as const;

/** These phrases name the reference event of the end of a window of S2. */
const S2_FROM: Readonly<Record<string, string>> = { fault: "the fault", heal: "the heal" };

/**
 * This table shows the candidates of S2 side by side, in each mode of kube-proxy of the catalog. The
 * columns come from the predictions of the copy, thus a candidate with no run has a column too.
 * Each cell gives the verdict and the failed requests of the median run. Then it gives the
 * prediction: the expected count of failed requests, and the band of the end of the window. The
 * incident `partition` shows the copies of the partitioned pod, and `stall` the copy of the stalled pod.
 *
 * The incident `prober` shows the copy of the failed prober. Its main value is the time of the false
 * removal, thus each cell gives the median of its failed requests apart. The incident `dependency`
 * shows the copy of the black-holed shared dependency. Its main value is the time of the empty
 * Service, thus each cell also gives its failed requests apart.
 *
 * The incident `flapping` shows the copy of the flapping dependency: the same black hole, 3 times in
 * one run. Its main value is the time of the empty Service after the first fault. The prediction also
 * gives the failed requests of each fault.
 *
 * The incident `zone` shows the copy of the lost zone. Its main value is the time of the removal of
 * the target, thus each cell also gives its failed requests apart.
 *
 * The incident `slow` shows the copy of the slow dependency. Its main value is the count of failed
 * requests. The last failure of A and B comes before the heal, and C and D have no window.
 */
export function CallersTable(props: { readonly incident?: "cannot serve" | "partition" | "stall" | "prober" | "dependency" | "flapping" | "zone" | "slow" }): ReactElement {
  // the copies of an incident: the first run of A, B and C, then the run of D. One run of the stall, and one of the prober, has each candidate. The latest copy has the prediction of each candidate
  const copies = (
    props.incident === "partition"
      ? [s2Partition, s2PartitionChecked]
      : props.incident === "stall"
        ? [s2Stall]
        : props.incident === "prober"
          ? [s2Prober]
          : props.incident === "dependency"
            ? [s2Dependency]
            : props.incident === "flapping"
              ? [s2Flapping]
              : props.incident === "zone"
                ? [s2Zone]
                : props.incident === "slow"
                  ? [s2Slow]
                  : [S2, s2Checked]
  ) as unknown as readonly (typeof S2)[];
  const prober = props.incident === "prober";
  const zone = props.incident === "zone";
  const dependency = props.incident === "dependency" || props.incident === "flapping";
  const flapping = props.incident === "flapping";
  // the failed requests of the median run of a false failure: the copy keeps them apart from the main value
  const failuresOf = (cell: object): number | null => {
    const failures = (cell as { readonly failures?: readonly number[] }).failures;
    if (failures === undefined || failures.length === 0) return null;
    // the middle value, or the mean of the two middle values, as the scores of the cells give it
    const sorted = [...failures].sort((a, b) => a - b);
    const half = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
  };
  const latest = copies.at(-1)!;
  const s2 = { predictions: latest.predictions, cells: copies.flatMap((copy) => copy.cells) };
  const candidates = [...new Set(s2.predictions.map((each) => each.candidate.name))];
  const modes = MODES.filter((mode) => s2.predictions.some((each) => each.mode === mode));
  const predicted = (mode: string, name: string) => {
    const found = s2.predictions.find((each) => each.mode === mode && each.candidate.name === name);
    if (found === undefined) throw new Error(`no S2 prediction ${mode}, ${name}`);
    return found.candidate;
  };
  return (
    <div className="not-content sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Mode</th>
            {candidates.map((name) => {
              const label = s2.predictions.find((each) => each.candidate.name === name)?.candidate.label ?? "";
              return (
                <th key={name}>{`${label}: ${name}`}</th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {modes.map((mode) => (
            <tr key={mode}>
              <td>{code(mode)}</td>
              {candidates.map((name) => {
                const cell = s2.cells.find((each) => each.mode === mode && each.candidate.name === name);
                const candidate = predicted(mode, name);
                const { expected, connections } = candidate;
                // a candidate of the slow dependency with no failed request has no window, thus no end
                const end = candidate.end as { readonly from: string; readonly low: number; readonly high: number } | null;
                const ends =
                  end === null
                    ? ""
                    : end.high <= 0
                      ? ` The last one starts ${fine(-end.high)} to ${fine(-end.low)} before ${S2_FROM[end.from] ?? end.from}.`
                      : ` The last one starts ${fine(end.low)} to ${fine(end.high)} after ${S2_FROM[end.from] ?? end.from}.`;
                const on =connections.low === connections.high ? `${connections.low}` : `${connections.low} to ${connections.high}`;
                const leaves = (candidate as { readonly leaves?: { readonly from: string; readonly low: number; readonly high: number } }).leaves;
                const removal = (candidate as { readonly removal?: { readonly from: string; readonly low: number; readonly high: number } }).removal;
                const each = (candidate as { readonly each?: { readonly low: number; readonly high: number } }).each;
                const returns = (candidate as { readonly returns?: { readonly from: string; readonly low: number; readonly high: number } }).returns;
                const failures = cell === undefined ? null : failuresOf(cell);
                const text =
                  cell === undefined || cell.median === null
                    ? ""
                    : zone
                      ? `${failures === null ? "" : `${count(failures, "failed request")}, and `}the removal of the target ${fine(cell.median)} after the fault, in the median run`
                      : prober
                      ? `${failures === null ? "" : `${count(failures, "failed request")}, and `}the false removal ${fine(cell.median)} after the fault, in the median run`
                      : dependency
                        ? `${failures === null ? "" : `${count(failures, "failed request")}, and `}the empty Service ${fine(cell.median)} after the ${flapping ? "first fault" : "fault"}, in the median run`
                        : `${count(cell.median, "failed request")} in the median run`;
                return (
                  <td key={name}>
                    {cell === undefined ? <span>No run in the copy yet.</span> : <Verdict decision={cell.decision} text={text} />}
                    {cell === undefined ? null : <RunOf cell={cell.id} />}
                    <br />
                    <span className="sy-muted">
                      {end === null && expected.high === 0
                        ? "The prediction: no failed request."
                        : `The prediction: ${digits(expected.low)} to ${digits(expected.high)} failed requests, with ${on} of the ${connections.of} connections on the target.${ends}`}
                      {leaves === undefined ? "" : ` The ${zone ? "removal" : "false removal"} comes ${fine(leaves.low)} to ${fine(leaves.high)} after ${S2_FROM[leaves.from] ?? leaves.from}.`}
                      {returns === undefined ? "" : ` The target is ready again ${fine(returns.low)} to ${fine(returns.high)} after ${S2_FROM[returns.from] ?? returns.from}.`}
                      {removal === undefined ? "" : ` The Service is empty ${fine(removal.low)} to ${fine(removal.high)} after ${S2_FROM[removal.from] ?? removal.from}${flapping ? ", for each fault" : ""}.`}
                      {each === undefined ? "" : ` Each fault has ${digits(each.low)} to ${digits(each.high)} failed requests.`}
                      {cell === undefined || cell.failed === 0 ? "" : ` ${cell.failed} of ${cell.counted} runs ${cell.failed === 1 ? "disagrees" : "disagree"}.`}
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

/** A quantity of the scorecard of S6: a value and its unit, `s`, `{request}` or `{ping}`. */
interface Amount {
  readonly value: number;
  readonly unit: string;
}
/** A score of the scorecard of S6, as `scoreCallers` of the cells writes it. */
type ScoreCopy =
  | { readonly criterion: string; readonly kind: "measured"; readonly median: Amount; readonly values: readonly Amount[]; readonly prediction: { readonly lo: Amount; readonly hi: Amount }; readonly from?: string; readonly holds: boolean; readonly evidence: { readonly run: number; readonly cell: string } }
  | { readonly criterion: string; readonly kind: "bounded"; readonly prediction: { readonly from: string; readonly band: { readonly lo: Amount; readonly hi: Amount } }; readonly holds: boolean; readonly evidence: { readonly run: number; readonly cell: string }; readonly why: string }
  | { readonly criterion: string; readonly kind: "derived"; readonly value: Amount; readonly why: string }
  | { readonly criterion: string; readonly kind: "not measured"; readonly why: string };
/** The scores of one mode of the scorecard: each candidate, and the label of the candidate with the fewest failed requests. */
interface ModeCopy {
  readonly mode: string;
  readonly candidates: ReadonlyArray<{ readonly candidate: string; readonly label: string; readonly cell: string; readonly scores: readonly ScoreCopy[] }>;
  readonly fewest: string | null;
}
/** The scores of one incident of the scorecard: its kind run, and the scores of each mode. */
interface ScoredCopy {
  readonly incident: string;
  readonly kind: "scored";
  readonly run: number;
  readonly modes: readonly ModeCopy[];
}
/** The scorecard of S6: the runs, the criteria, and the scores of each incident. */
interface ScorecardCopy {
  readonly run: number;
  readonly criteria: readonly string[];
  readonly incidents: ReadonlyArray<ScoredCopy | { readonly incident: string; readonly kind: "not measured"; readonly why: string }>;
}
const SCORES = s6 as unknown as ScorecardCopy;

/** This function gives the link of a CI run of the repository. */
const runLink = (run: number): string => `https://github.com/mark1russell7/systems/actions/runs/${run}`;

/** This function gives the CI run of the evidence of an S2 cell in the scorecard of S6, or null. */
const runOfCell = (cell: string): number | null => {
  for (const incident of SCORES.incidents) {
    if (incident.kind !== "scored") continue;
    for (const mode of incident.modes)
      for (const each of mode.candidates) {
        if (each.cell !== cell) continue;
        const score = each.scores.find((one) => one.kind === "measured" || one.kind === "bounded");
        if (score?.kind === "measured" || score?.kind === "bounded") return score.evidence.run;
      }
  }
  return null;
};

/** This component is the link of the CI run of an S2 cell, from the scorecard of S6. */
function RunOf(props: { readonly cell: string }): ReactElement | null {
  const run = runOfCell(props.cell);
  if (run === null) return null;
  return (
    <>
      {" "}
      <a href={runLink(run)}>{`Run ${run}`}</a>
    </>
  );
}

/**
 * This function names the time that a score measures, for an incident and a criterion. In a shared
 * dependency and in a flapping one, the callers know at the last slow failure. In a lost zone, the
 * routes go down at the removal of the target, and the target recovers when it is ready again.
 */
const measureOf = (incident: string, criterion: string): string =>
  criterion === "false removals on a blip"
    ? "the false removal"
    : incident === "a lost zone" && criterion === "routes down"
      ? "the removal of the target"
      : incident === "a lost zone" && criterion === "time to recover"
        ? "the ready target"
        : criterion === "routes down"
      ? "the empty Service"
      : criterion === "time until callers know" && (incident === "a black-holed shared dependency" || incident === "a flapping dependency")
        ? "the last slow failure"
        : "the last failure";

/** This function writes a criterion as the head of a row: its first letter in capitals. */
const headOf = (criterion: string): string => `${criterion.charAt(0).toUpperCase()}${criterion.slice(1)}`;

/**
 * This function gives the scores of each candidate for a criterion with no run, or null when a mode
 * gives a different score. Such a criterion has a reason or a value of the code (`derived`).
 */
const reasonsOf = (modes: readonly ModeCopy[], criterion: string): readonly ScoreCopy[] | null => {
  const of = (mode: ModeCopy): ScoreCopy[] => mode.candidates.flatMap((each) => each.scores.filter((one) => one.criterion === criterion));
  const first = modes[0] === undefined ? [] : of(modes[0]);
  return modes.every((mode) => JSON.stringify(of(mode)) === JSON.stringify(first)) ? first : null;
};

/**
 * This table shows the scores of S6 for "how callers learn" of one incident, side by side in each
 * mode of kube-proxy. A row gives each criterion that has a score from the run, with the prediction
 * next to the measure. Each cell links to the run of its evidence. A criterion that the data cannot
 * support gives its reason, and no number.
 */
function IncidentScoresTable(props: { readonly scored: ScoredCopy }): ReactElement {
  const { scored } = props;
  const modes = scored.modes;
  const heads = modes[0]?.candidates ?? [];
  const scoreAt = (mode: ModeCopy, label: string, criterion: string): ScoreCopy => {
    const score = mode.candidates.find((each) => each.label === label)?.scores.find((each) => each.criterion === criterion);
    if (score === undefined) throw new Error(`no score of S6 for ${mode.mode}, ${label}, ${criterion}`);
    return score;
  };
  const cellOf = (mode: ModeCopy, label: string, criterion: string): ReactElement => {
    const score = scoreAt(mode, label, criterion);
    if (score.kind === "not measured") return <span className="sy-muted">{`Not measured. ${score.why}`}</span>;
    // a value of the code: the candidate sends no PING, with no run
    if (score.kind === "derived")
      return (
        <>
          {`${count(score.value.value, "PING")}, by the code`}
          <br />
          <span className="sy-muted">{score.why}</span>
        </>
      );
    const evidence = (
      <a href={runLink(score.evidence.run)}>
        <code>{score.evidence.cell}</code>
      </a>
    );
    // in a slow dependency, the last failure comes before the heal, thus a time before it is not negative
    const before = scored.incident === "a slow dependency (gray failure)" && score.kind === "measured" && score.median.value < 0;
    if (score.kind === "measured" && score.from !== undefined)
      return (
        <>
          <Verdict
            decision={score.holds ? "holds" : "fails"}
            text={`${measureOf(scored.incident, criterion)} ${fine(before ? -score.median.value : score.median.value)} ${before ? "before" : "after"} ${S2_FROM[score.from] ?? score.from} in the median run`}
          />
          <br />
          <span className="sy-muted">
            {before && score.prediction.hi.value <= 0
              ? `The prediction: ${fine(-score.prediction.hi.value)} to ${fine(-score.prediction.lo.value)} before ${S2_FROM[score.from] ?? score.from}. The counted runs: ${score.values.map((each) => (each.value <= 0 ? `${fine(-each.value)} before` : `${fine(each.value)} after`)).join(", ")}. `
              : `The prediction: ${fine(score.prediction.lo.value)} to ${fine(score.prediction.hi.value)}. The counted runs: ${score.values.map((each) => fine(each.value)).join(", ")}. `}
            {evidence}
          </span>
        </>
      );
    if (score.kind === "measured")
      return (
        <>
          <Verdict decision={score.holds ? "holds" : "fails"} text={`${count(score.median.value, criterion === "probe load" ? "PING" : "failed request")} in the median run`} />
          {mode.fewest === label && criterion === "failed requests" ? <strong> The fewest in this mode.</strong> : null}
          <br />
          <span className="sy-muted">
            {`The prediction: ${digits(score.prediction.lo.value)} to ${digits(score.prediction.hi.value)}. The counted runs: ${score.values.map((each) => digits(each.value)).join(", ")}. `}
            {evidence}
          </span>
        </>
      );
    const { from, band } = score.prediction;
    return (
      <>
        <Verdict decision={score.holds ? "holds" : "fails"} text="each failure in the window" />
        <br />
        <span className="sy-muted">
          {`The prediction: the last failure ${fine(band.lo.value)} to ${fine(band.hi.value)} after ${S2_FROM[from] ?? from}. `}
          {evidence}
        </span>
      </>
    );
  };
  // a criterion with a score from a run, and the rest with a reason or a value of the code
  const measured = SCORES.criteria.filter((criterion) => modes.some((mode) => mode.candidates.some((each) => ["measured", "bounded"].includes(scoreAt(mode, each.label, criterion).kind))));
  const unmeasured = SCORES.criteria.filter((criterion) => !measured.includes(criterion));
  const notes = [...new Set(measured.flatMap((criterion) => modes.flatMap((mode) => mode.candidates.flatMap((each) => {
    const score = scoreAt(mode, each.label, criterion);
    return score.kind === "bounded" ? [score.why] : [];
  }))))];
  // a note that another note holds is not shown twice
  const shown = notes.filter((note) => !notes.some((other) => other !== note && other.includes(note)));
  // the run of the incident first, then each later run that adds a candidate
  const runs = [
    scored.run,
    ...new Set(
      modes.flatMap((mode) => mode.candidates.flatMap((each) => each.scores.flatMap((score) => (score.kind === "not measured" || score.kind === "derived" || score.evidence.run === scored.run ? [] : [score.evidence.run])))),
    ),
  ];
  return (
    <>
      <p>
        {`The scores of ${scored.incident}, from the ${runs.length === 1 ? "run" : "runs"} `}
        {runs.map((run, at) => (
          <span key={run}>
            {at === 0 ? "" : at === runs.length - 1 ? " and " : ", "}
            <a href={runLink(run)}>{run}</a>
          </span>
        ))}
        .
      </p>
      <div className="sy-scroll">
        <table className="sy-table">
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Mode</th>
              {heads.map((each) => (
                <th key={each.label}>{`${each.label}: ${each.candidate}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {measured.flatMap((criterion) =>
              modes.map((mode, row) => (
                <tr key={`${criterion} ${mode.mode}`}>
                  {row === 0 ? <td rowSpan={modes.length}>{headOf(criterion)}</td> : null}
                  <td>{code(mode.mode)}</td>
                  {heads.map((each) => (
                    <td key={each.label}>{cellOf(mode, each.label, criterion)}</td>
                  ))}
                </tr>
              )),
            )}
            {unmeasured.map((criterion) => {
              const reasons = reasonsOf(modes, criterion);
              if (reasons === null)
                return modes.map((mode, row) => (
                  <tr key={`${criterion} ${mode.mode}`}>
                    {row === 0 ? <td rowSpan={modes.length}>{headOf(criterion)}</td> : null}
                    <td>{code(mode.mode)}</td>
                    {heads.map((each) => (
                      <td key={each.label}>{cellOf(mode, each.label, criterion)}</td>
                    ))}
                  </tr>
                ));
              return (
                <tr key={criterion}>
                  <td>{headOf(criterion)}</td>
                  <td>Each mode</td>
                  {reasons.every((each) => each.kind === "not measured") && new Set(reasons.map((each) => (each.kind === "not measured" ? each.why : ""))).size === 1 ? (
                    <td colSpan={heads.length}>{cellOf(modes[0]!, heads[0]?.label ?? "", criterion)}</td>
                  ) : (
                    heads.map((each) => <td key={each.label}>{cellOf(modes[0]!, each.label, criterion)}</td>)
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown.map((note) => (
        <p key={note} className="sy-muted">
          {note}
        </p>
      ))}
    </>
  );
}

/**
 * These tables show the scores of S6 for "how callers learn": one table for each incident with
 * cells, each with the link of its run. The incidents with no cell of the candidates follow them.
 */
export function CallersScores(): ReactElement {
  const scored = SCORES.incidents.flatMap((each) => (each.kind === "scored" ? [each] : []));
  if (scored.length === 0) throw new Error("the scorecard of S6 has no incident with scores");
  const rest = SCORES.incidents.flatMap((each) => (each.kind === "not measured" ? [each] : []));
  return (
    <div className="not-content">
      {scored.map((each) => (
        <IncidentScoresTable key={each.incident} scored={each} />
      ))}
      <p className="sy-muted">{`Not measured yet: ${rest.map((each) => each.incident).join(", ")}. Each incident has its own reason:`}</p>
      {/* each incident with no cell gives the part of the lab that it needs */}
      <ul className="sy-muted">
        {rest.map((each) => (
          <li key={each.incident}>{`${each.incident}: ${each.why}`}</li>
        ))}
      </ul>
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
                    <Verdict decision={cell.decision} />
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
  const axis = axisOf([{ runs }]);
  const label = `The propagation of a deletion to the rules of each node, by mode: ${modes.map(({ mode, spread }) => `${mode} ${duration(ms(spread.all?.median ?? 0))}`).join(", ")} at the median.`;
  return (
    <section className="sy-panel not-content" aria-label="The propagation of a deletion">
      <div className="sy-body">
        <Strip from={0} to={axis.to} runs={runs} rows={[...MODES]} label={label} />
        <Legend runs />
        <div className="sy-scroll">
          <table className="sy-table">
            <thead>
              <tr>
                <th>Mode</th>
                <th className="num">Median</th>
                <th className="num">99th percentile</th>
                <th className="num">Slowest</th>
                <th className="num">EndpointSlice</th>
                <th className="num">Intake stops</th>
              </tr>
            </thead>
            <tbody>
              {modes.map(({ mode, spread }) => (
                <tr key={mode}>
                  <td>{code(mode)}</td>
                  <td className="num">{spread.all === null ? "" : time(spread.all.median)}</td>
                  <td className="num">{spread.all === null ? "" : time(spread.all.p99)}</td>
                  <td className="num">{spread.all === null ? "" : time(spread.all.max)}</td>
                  <td className="num">{spread.slice === null ? "" : time(spread.slice.median)}</td>
                  <td className="num">{spread.intake === null ? "" : time(spread.intake.median)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sy-muted">
          Each dot is the propagation to one node in one counted run: {modes[0]?.spread.all?.count ?? 0} values for each mode. The EndpointSlice and the stop of the intake give their median time after
          the deletion.
        </p>
      </div>
    </section>
  );
}
