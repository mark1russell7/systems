/**
 * The CI ledger, from `lib/ci.ts` and the files of `data/ci/`. For each workflow of cells, a readout gives the
 * runs and the shards that the ledger examined, and its flake rate. A table gives the flake rate of each
 * dataplane, and if the idle share of 60% holds for it. A second table gives each event.
 *
 * These components have no state. The site renders them to HTML when it builds, and they need no script.
 */
import type { ReactElement } from "react";
import cells from "../data/ci/cells.json";
import kind from "../data/ci/kind.json";
import type { Cause, EventKind, Ledger, LedgerEvent } from "../lib/ci.ts";
import { QUIET_LIMIT, ratesOf } from "../lib/ci.ts";
import { count, duration } from "../lib/format.ts";

/** The ledgers, by the name of their workflow. */
export const LEDGERS: Readonly<Record<string, Ledger>> = { kind: kind as Ledger, cells: cells as Ledger };

/** The words of each kind of event. */
const KINDS: Readonly<Record<EventKind, string>> = {
  void: "void run",
  hung: "hung shard",
  cancelled: "cancelled shard",
  timeout: "step timeout",
  failed: "failed job",
};

/** The words of each cause. */
const CAUSES: Readonly<Record<Cause, string>> = {
  quiet: "the wait for a quiet VM",
  rest: "the cell was not at rest",
  person: "a person cancelled the run",
  timeout: "the bound of the step",
  runner: "the runner",
  test: "a test outside the cells",
  other: "other",
};

/** This function writes a share as a percent with one decimal: 0.0357 becomes 3.6%. */
const percent = (share: number): string => `${(Math.round(share * 1000) / 10).toString()}%`;

/** This function gives the name of a dataplane for a reader. */
const dataplaneName = (dataplane: string | null): string => (dataplane === null ? "–" : dataplane === "docker" ? "Docker (the harness)" : dataplane);

/** The readout and the table of the dataplanes of one workflow. */
export function CiRates(props: { readonly workflow: string }): ReactElement {
  const ledger = LEDGERS[props.workflow];
  if (ledger === undefined) throw new Error(`no CI ledger for the workflow ${props.workflow}`);
  const rates = ratesOf(ledger);
  const causes = Object.entries(rates.causes) as [Cause, number][];
  return (
    <section className="not-content" aria-label={`The flake rate of the workflow ${ledger.workflow}`}>
      <dl className="sy-readout">
        <div>
          <dt>Workflow</dt>
          <dd>
            <code>{ledger.file}</code>
          </dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{count(rates.runs)}</dd>
        </div>
        <div>
          <dt>Shards</dt>
          <dd>{count(rates.shards)}</dd>
        </div>
        <div>
          <dt>Shards with a flake</dt>
          <dd>{count(rates.flaky)}</dd>
        </div>
        <div>
          <dt>Shards with only failed tests</dt>
          <dd>{count(rates.failed)}</dd>
        </div>
        <div>
          <dt>Flake rate</dt>
          <dd>{percent(rates.rate)}</dd>
        </div>
        <div>
          <dt>Events</dt>
          <dd>{causes.length === 0 ? "none" : causes.map(([cause, n]) => `${n} ${CAUSES[cause]}`).join(" · ")}</dd>
        </div>
      </dl>
      <div className="sy-scroll">
        <table className="sy-table">
          <thead>
            <tr>
              <th>Dataplane</th>
              <th className="num">Runs</th>
              <th className="num">Events</th>
              <th className="num">Flake rate</th>
              <th className="num">Wait for a quiet VM</th>
              <th className="num">Lowest idle</th>
              <th>The share of {percent(ledger.idle)} idle</th>
            </tr>
          </thead>
          <tbody>
            {rates.dataplanes.map((each) => (
              <tr key={each.dataplane}>
                <td>{dataplaneName(each.dataplane)}</td>
                <td className="num">{count(each.runs)}</td>
                <td className="num">{count(each.events)}</td>
                <td className="num">{percent(each.rate)}</td>
                <td className="num">
                  {each.quiet} · {percent(each.quietRate)}
                </td>
                <td className="num">{each.lowest === null ? "–" : percent(each.lowest)}</td>
                <td>{each.threshold === "holds" ? `holds: ${percent(QUIET_LIMIT)} or fewer runs void by the wait` : `change: more than ${percent(QUIET_LIMIT)} of the runs void by the wait`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** This function gives the text of the place of an event in its run: the environment and the run. */
const placeOf = (event: LedgerEvent): string => {
  if (event.env === null) return "";
  if (event.index === null) return `environment ${event.env}`;
  return `environment ${event.env}, ${event.index === -1 ? "the warm-up" : `run ${event.index + 1}`}`;
};

/** The table of the events of one workflow: one row for each event, with a link to its job. */
export function CiEvents(props: { readonly workflow: string }): ReactElement {
  const ledger = LEDGERS[props.workflow];
  if (ledger === undefined) throw new Error(`no CI ledger for the workflow ${props.workflow}`);
  if (ledger.events.length === 0) return <p>The ledger of this workflow has no event.</p>;
  return (
    <div className="sy-scroll not-content">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Run</th>
            <th className="num">Shard</th>
            <th>Event</th>
            <th>Cell</th>
            <th>Step</th>
            <th className="num">Duration</th>
            <th>Cause</th>
          </tr>
        </thead>
        <tbody>
          {[...ledger.events].reverse().map((event) => (
            <tr key={`${event.run}/${event.job}/${event.cell ?? ""}/${event.env ?? ""}/${event.index ?? ""}/${event.kind}`}>
              <td>
                <a href={event.link}>{event.run}</a>
              </td>
              <td className="num">{event.shard ?? "–"}</td>
              <td>
                {KINDS[event.kind]}
                {event.dataplane === null ? "" : `, ${dataplaneName(event.dataplane)}`}
              </td>
              <td className="sy-text">
                {event.cell === null ? "–" : <code>{event.cell}</code>}
                {placeOf(event) === "" ? null : <div className="sy-muted">{placeOf(event)}</div>}
              </td>
              <td>{event.step ?? "–"}</td>
              <td className="num">{event.duration === null ? "–" : duration(event.duration.value * 1000)}</td>
              <td className="sy-text">
                <strong>{CAUSES[event.cause]}</strong>
                <div className="sy-muted">{event.detail}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
