/**
 * The results of the first harness cells. Each cell has the frame of the S1 cells (`HarnessFrame`). The
 * frame has the band that the algebra predicted, a dot for each measurement, and a table of the same numbers.
 */
import type { ReactElement } from "react";
import harness from "../data/harness-2026-10-08.json";
import { HarnessFrame } from "./CellResults.tsx";

export default function HarnessResults(): ReactElement {
  return (
    <div className="not-content sy-cells">
      {harness.cells.map((cell) => (
        <HarnessFrame key={cell.name} cell={cell} />
      ))}
    </div>
  );
}
