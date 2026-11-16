/**
 * The results of the cells of the accept queue (SYS-120 part 3), from the copy of `scripts/accept-queue.ts`.
 * Each cell has one table. Each row is one term of its law: the band of the prediction, the median of the
 * counted runs and the value of each run. The copy gives each value and each median, thus this component
 * computes nothing. A cell with no record shows its prediction and the words "no record".
 */
import type { ReactElement } from "react";
import { format, quantity } from "@mark1russell7/quantity";
import Verdict from "./Verdict.tsx";

/** One term of the law of a cell: its band, the value of each counted run, and their median. A count has a band of one value. */
export interface QueueTerm {
  readonly term: string;
  readonly unit: "count" | "s";
  readonly low: number;
  readonly high: number;
  readonly values: readonly (number | null)[];
  readonly median: number | null;
  /** This choice says if the median is inside the band. It is null with no median. */
  readonly inside: boolean | null;
}

/** The result of one cell with a record. */
export interface QueueResult {
  readonly decision: string;
  readonly counted: number;
  readonly voided: number;
  readonly why: string;
  readonly voids: string | null;
  readonly terms: readonly QueueTerm[];
  /** The first verdict of a cell that operated again, or null. */
  readonly first: string | null;
}

/** One cell of the copy. */
export interface QueueCellCopy {
  readonly id: string;
  readonly name: string;
  readonly why: string | null;
  readonly result: QueueResult | null;
}

/** The copy of the cells of the accept queue. */
export interface QueueCopy {
  readonly ranAt: string;
  readonly commit?: string;
  readonly workflows: readonly number[];
  readonly kernel: string;
  readonly hz: number;
  readonly cells: readonly QueueCellCopy[];
}

/** This function gives the words of one value of a term, through `format` of the quantity package. */
export const valueText = (unit: QueueTerm["unit"], value: number | null): string => (value === null ? "none" : format(quantity(value, unit)));

/** This function gives the words of the band of a term: one value for a count with one value, else its two ends. */
export const bandText = (term: QueueTerm): string =>
  term.low === term.high ? valueText(term.unit, term.low) : `${valueText(term.unit, term.low)} to ${valueText(term.unit, term.high)}`;

function TermTable(props: { readonly cell: QueueCellCopy; readonly result: QueueResult }): ReactElement {
  const { cell, result } = props;
  const runs = Math.max(0, ...result.terms.map((term) => term.values.length));
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <caption className="sy-muted">
          {cell.id}: the band of each term of the law, the median of the counted runs and each run.
        </caption>
        <thead>
          <tr>
            <th>Term</th>
            <th className="num">Band</th>
            <th className="num">Median</th>
            {Array.from({ length: runs }, (_, n) => (
              <th key={n} className="num">
                Trial {n + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.terms.map((term) => (
            <tr key={term.term} data-inside={term.inside === null ? undefined : String(term.inside)}>
              <td>{term.term}</td>
              <td className="num">{bandText(term)}</td>
              <td className="num">
                {term.inside === false ? <Verdict decision="fails" text={valueText(term.unit, term.median)} /> : valueText(term.unit, term.median)}
              </td>
              {Array.from({ length: runs }, (_, n) => (
                <td key={n} className="num">
                  {valueText(term.unit, term.values[n] ?? null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The results of each cell of the copy, one section for each cell. */
export default function QueueResults(props: { readonly copy: QueueCopy }): ReactElement {
  const { copy } = props;
  return (
    <div className="not-content">
      <p className="sy-muted">
        The runners of GitHub measured these cells on {copy.ranAt}, on the kernel {copy.kernel} with HZ {copy.hz}
        {copy.commit === undefined ? "" : `, at the commit ${copy.commit.slice(0, 7)}`}.
      </p>
      {copy.cells.map((cell) => (
        <section key={cell.id} className="sy-frame" aria-label={`${cell.id} ${cell.name}`}>
          <header className="sy-head">
            <div className="sy-title">
              <strong>{cell.id}</strong> {cell.name}
            </div>
            {cell.result === null ? <span className="sy-muted">no record</span> : <Verdict decision={cell.result.decision} prefix={cell.result.first === null ? undefined : "re-run"} />}
          </header>
          {cell.why === null ? null : <p className="sy-muted">{cell.why}</p>}
          {cell.result === null ? null : (
            <>
              <p>{cell.result.why}</p>
              <TermTable cell={cell} result={cell.result} />
            </>
          )}
        </section>
      ))}
    </div>
  );
}
