/**
 * The map of the cells of a page of results. It has one tile for each cell, in rows by group and
 * client. A tile has the icon and the color of its verdict, and it links to the frame of its cell. The
 * pointer or the focus on a tile shows a line under its row. The line gives the name, the prediction
 * and the median of the cell. Thus a long page of results has one view of each cell at its head.
 *
 * The component has no state. The site renders it to HTML when it builds, and the lines need no script.
 */
import type { ReactElement } from "react";
import { duration, reading } from "../lib/format.ts";
import { predictionText } from "./CellFrame.tsx";
import { COPIES, cellId, type Copy, type RunCell } from "./RunResults.tsx";
import { VerdictIcon, statusOf } from "./Verdict.tsx";

/** The words of the stages of a copy. A stage that is not here shows by its own name. */
const STAGES: Readonly<Record<string, string>> = { defaults: "defaults", border: "borders", "border-off": "borders", array: "array", random: "random" };

/** A row of the map: the cells of one group, one client and one pooler, in clusters by stage. */
interface Row {
  readonly key: string;
  readonly group: string;
  readonly client: string | undefined;
  readonly via: string | undefined;
  readonly clusters: ReadonlyArray<{ readonly stage: string | undefined; readonly cells: readonly RunCell[] }>;
}

/** This function puts the cells of a copy in rows, in the sequence of the copy. */
export const rowsOf = (cells: readonly RunCell[]): Row[] => {
  const rows: Array<{ key: string; group: string; client: string | undefined; via: string | undefined; clusters: Array<{ stage: string | undefined; cells: RunCell[] }> }> = [];
  for (const cell of cells) {
    const key = `${cell.group} ${cell.client ?? ""} ${cell.via ?? ""}`;
    let row = rows.find((each) => each.key === key);
    if (row === undefined) {
      row = { key, group: cell.group, client: cell.client, via: cell.via, clusters: [] };
      rows.push(row);
    }
    const last = row.clusters.at(-1);
    if (last !== undefined && last.stage === cell.stage) last.cells.push(cell);
    else row.clusters.push({ stage: cell.stage, cells: [cell] });
  }
  return rows;
};

/** This function gives the line of a cell: its prediction, and what its runs measured. */
export const lineOf = (cell: RunCell): string => {
  const measured =
    cell.median === null ? (cell.prediction.kind === "silent" ? "nothing ended it" : "no time") : `median ${cell.median >= 1 && cell.median < 120 ? reading(cell.median * 1000) : duration(cell.median * 1000)}`;
  return `${cell.decision}: ${cell.counted} runs, prediction ${predictionText(cell.prediction)}, ${measured}`;
};

/** The map of the cells of one copy. */
export default function CellMap(props: { readonly copy: Copy }): ReactElement {
  const cells = COPIES[props.copy];
  const rows = rowsOf(cells);
  return (
    <nav className="sy-map not-content" aria-label={`The ${cells.length} cells of this page`}>
      <p className="sy-map-hint">Each tile is a cell. Point at a tile to read it, and select it to go to its frame.</p>
      {rows.map((row) => (
        <div className="sy-map-row" key={row.key}>
          <div className="sy-map-label">
            <code className="sy-tag">{row.group}</code>
            {row.client === undefined ? null : <span>{row.client}</span>}
            {row.via === undefined ? null : <span className="sy-map-via">through {row.via}</span>}
          </div>
          <div className="sy-map-tiles">
            {row.clusters.map((cluster, at) => (
              <span className="sy-map-cluster" key={`${cluster.stage ?? ""} ${at}`}>
                {cluster.stage === undefined || row.clusters.length === 1 ? null : <span className="sy-map-stage">{STAGES[cluster.stage] ?? cluster.stage}</span>}
                {cluster.cells.map((cell) => (
                  <a key={cellId(cell)} className="sy-tile" href={`#${cellId(cell)}`} data-status={statusOf(cell.decision)} aria-label={`${cell.plan ?? cell.catalog} ${cell.name}. ${lineOf(cell)}`}>
                    <VerdictIcon decision={cell.decision} />
                    <span className="sy-tile-line" aria-hidden="true">
                      <strong>{cell.plan ?? cell.catalog}</strong> {cell.name}
                      <br />
                      {lineOf(cell)}
                    </span>
                  </a>
                ))}
              </span>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
