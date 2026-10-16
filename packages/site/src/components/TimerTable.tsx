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
            <th className="num">Firings</th>
            <th className="num">On the slot</th>
            <th className="num">1 jiffy late</th>
            <th className="num">2 jiffies or more</th>
            <th className="num">Socket held</th>
            <th className="num">Void runs</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <tr key={cell.name}>
              <td className="sy-text">{cell.name}</td>
              <td className="num">{cell.timers.firings}</td>
              <td className="num">{cell.timers.onSlot}</td>
              <td className="num">{cell.timers.oneBehind}</td>
              <td className="num">{cell.timers.twoOrMore}</td>
              <td className="num">{cell.timers.owned}</td>
              <td className="num">
                {cell.verdict.voided} of {cell.runs.length}
              </td>
            </tr>
          ))}
          <tr className="sy-total">
            <th scope="row">All {cells.length} cells</th>
            <td className="num">{total.firings}</td>
            <td className="num">{total.onSlot}</td>
            <td className="num">{total.oneBehind}</td>
            <td className="num">{total.twoOrMore}</td>
            <td className="num">{total.owned}</td>
            <td className="num">
              {total.voided} of {total.runs}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
