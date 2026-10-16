/**
 * The ledger of the results, from `lib/ledger.ts`. The home page shows each page of results in one row.
 * The head of each page of results shows its own row as a summary. A status bar shows the share of each
 * decision. The counts beside the bar give the same numbers as text, thus the bar is not the only source of
 * a number.
 *
 * These components have no state. The site renders them to HTML when it builds, and they need no script.
 */
import type { ReactElement } from "react";
import { count } from "../lib/format.ts";
import { LEDGER, TOTAL, entryOf, type Entry, type Tally } from "../lib/ledger.ts";
import { VerdictIcon } from "./Verdict.tsx";

/** This function gives the path of a page from the base of the site. */
export const link = (href: string): string => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/${href}`;

/** The decisions of a tally, in the sequence of the bar, with their status and their word. */
const PARTS = [
  { key: "holds", decision: "holds", word: "hold" },
  { key: "fails", decision: "fails", word: "fail" },
  { key: "measured", decision: "measured", word: "measured" },
  { key: "calibration", decision: "calibration", word: "calibration" },
] as const;

/** The bar of a tally: one segment for each decision, with a width for its share of the cells. */
export function StatusBar(props: { readonly tally: Tally }): ReactElement {
  const total = PARTS.reduce((sum, part) => sum + props.tally[part.key], 0);
  return (
    <span className="sy-bar" aria-hidden="true">
      {PARTS.filter((part) => props.tally[part.key] > 0).map((part) => (
        <span key={part.key} data-decision={part.decision} style={{ flexGrow: props.tally[part.key] }} title={`${props.tally[part.key]} of ${total} ${part.word}`} />
      ))}
    </span>
  );
}

/** The counts of a tally as text, each with the icon of its decision. A compact count shows the word of its decision only to a screen reader. */
export function Counts(props: { readonly tally: Tally; readonly heldOnRerun?: number; readonly compact?: boolean }): ReactElement {
  return (
    <span className="sy-counts">
      {PARTS.filter((part) => props.tally[part.key] > 0).map((part) => (
        <span key={part.key} data-decision={part.decision} title={props.compact === true ? part.word : undefined}>
          <VerdictIcon decision={part.decision} />
          {count(props.tally[part.key])}
          {props.compact === true ? <span className="sr-only"> {part.word}</span> : ` ${part.word}`}
        </span>
      ))}
      {props.heldOnRerun === undefined || props.heldOnRerun === 0 ? null : <span className="sy-counts-note">{props.heldOnRerun} held on a re-run</span>}
    </span>
  );
}

/** This function gives the text of the count of runs of an entry, with its void runs. */
const runsOf = (counted: number, voided: number): string => `${count(counted)} runs${voided === 0 ? "" : ` · ${voided} void`}`;

/** One row of the ledger: the page, its catalogs, its date and its environment, and its tally. */
function Row(props: { readonly entry: Entry }): ReactElement {
  const { entry } = props;
  return (
    <li>
      <a className="sy-ledger-row" href={link(entry.href)}>
        <span className="sy-ledger-name">
          <strong>{entry.label}</strong>
          <span className="sy-ledger-tags">{entry.tags.join(" · ")}</span>
        </span>
        <span className="sy-ledger-tally">
          <StatusBar tally={entry.tally} />
          <Counts tally={entry.tally} compact />
        </span>
        <span className="sy-ledger-meta">
          {entry.cells} cells · {entry.ranAt} · Linux {entry.kernel} · HZ {entry.hz}
        </span>
      </a>
    </li>
  );
}

/** The ledger of the home page: the totals, then one row for each page of results. */
export default function Ledger(): ReactElement {
  const tiles = [
    { label: "Cells", value: TOTAL.cells, decision: null },
    { label: "Hold", value: TOTAL.tally.holds, decision: "holds" },
    { label: "Fail", value: TOTAL.tally.fails, decision: "fails" },
    { label: "Measured", value: TOTAL.tally.measured, decision: "measured" },
  ] as const;
  return (
    <section className="sy-ledger" aria-labelledby="ledger-title">
      <header className="sy-ledger-head">
        <h2 id="ledger-title">The results so far</h2>
        <span>
          {TOTAL.first} to {TOTAL.last}
        </span>
      </header>
      <dl className="sy-tiles">
        {tiles.map((tile) => (
          <div key={tile.label} data-decision={tile.decision ?? undefined}>
            <dt>
              {tile.decision === null ? null : <VerdictIcon decision={tile.decision} />}
              {tile.label}
            </dt>
            <dd>{count(tile.value)}</dd>
          </div>
        ))}
      </dl>
      <div className="sy-ledger-total">
        <StatusBar tally={TOTAL.tally} />
        <p>
          The cells have {count(TOTAL.counted)} counted runs and {TOTAL.voided} void runs, on {TOTAL.pages} pages of results. {TOTAL.tally.calibration} cells are calibrations. {TOTAL.heldOnRerun} cells that
          failed held on a re-run.
        </p>
      </div>
      <ol className="sy-ledger-rows">
        {LEDGER.map((entry) => (
          <Row key={entry.key} entry={entry} />
        ))}
      </ol>
    </section>
  );
}

/** The summary at the head of a page of results: its own row of the ledger, with its runs. */
export function Summary(props: { readonly of: string }): ReactElement {
  const entry = entryOf(props.of);
  return (
    <section className="sy-summary not-content" aria-label="Summary of the results">
      <dl className="sy-readout">
        <div>
          <dt>Catalogs</dt>
          <dd>{entry.tags.join(" · ")}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{entry.ranAt}</dd>
        </div>
        <div>
          <dt>Kernel</dt>
          <dd>
            Linux {entry.kernel} · HZ {entry.hz}
          </dd>
        </div>
        <div>
          <dt>Cells</dt>
          <dd>{entry.cells}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{runsOf(entry.counted, entry.voided)}</dd>
        </div>
      </dl>
      <div className="sy-summary-tally">
        <StatusBar tally={entry.tally} />
        <Counts tally={entry.tally} heldOnRerun={entry.heldOnRerun} />
      </div>
    </section>
  );
}
