/**
 * This table counts the firings of the timers of each observed socket, from the records of the prober.
 * It tells how many fired on their wheel slot, and how many fired one jiffy late or more. It also tells
 * how many found their socket held by its owner. The totals row adds the S1 cells, not the calibration.
 */
import type { ReactElement } from "react";
import harness from "../data/harness-2026-10-13.json";

const cells = harness.cells.filter((cell) => cell.group !== "calibration");
const total = cells.reduce(
  (sum, cell) => ({
    firings: sum.firings + cell.timers.firings,
    onSlot: sum.onSlot + cell.timers.onSlot,
    oneBehind: sum.oneBehind + cell.timers.oneBehind,
    twoOrMore: sum.twoOrMore + cell.timers.twoOrMore,
    owned: sum.owned + cell.timers.owned,
    runs: sum.runs + cell.runs.length,
    voided: sum.voided + cell.verdict.voided,
  }),
  { firings: 0, onSlot: 0, oneBehind: 0, twoOrMore: 0, owned: 0, runs: 0, voided: 0 },
);

export default function TimerTable(): ReactElement {
  return (
    <div className="sy-scroll not-content">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Cell</th>
            <th>Firings</th>
            <th>On the slot</th>
            <th>1 jiffy late</th>
            <th>2 jiffies or more</th>
            <th>Socket held</th>
            <th>Void runs</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <tr key={cell.name}>
              <td>{cell.name}</td>
              <td>{cell.timers.firings}</td>
              <td>{cell.timers.onSlot}</td>
              <td>{cell.timers.oneBehind}</td>
              <td>{cell.timers.twoOrMore}</td>
              <td>{cell.timers.owned}</td>
              <td>
                {cell.verdict.voided} of {cell.runs.length}
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row">All {cells.length} cells</th>
            <th>{total.firings}</th>
            <th>{total.onSlot}</th>
            <th>{total.oneBehind}</th>
            <th>{total.twoOrMore}</th>
            <th>{total.owned}</th>
            <th>
              {total.voided} of {total.runs}
            </th>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
