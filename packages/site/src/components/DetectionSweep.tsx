/**
 * The results of the detection sweep of SYS-57: four settings of memberlist in MetalLB. `DetectionTrade` gives
 * the trade-off in one table. `DetectionTimes` puts each zone-loss run on one axis of seconds, in the band of
 * the law. `DetectionPauses` puts each pause on one axis of seconds. A filled dot is a pause that gave a false
 * death, and the solid line is T0, the least pause that can give one.
 */
import type { ReactElement } from "react";
import sweep from "../data/s2-detection-2026-11-04.json";
import { count } from "../lib/format.ts";
import { RowsFigure, timeText, type ChartRow } from "./RowsChart.tsx";

/** The end of the axis of the failure times, in seconds: past the highest band. */
const TIMES_TO = 8;
/** The end of the axis of the pauses, in seconds: past the longest pause. */
const PAUSES_TO = 10;

/** The false deaths of one counted run of a setting. */
export const deathsOf = (run: (typeof sweep.settings)[number]["runs"][number]): number => run.pauses.filter((pause) => pause.died).length;

/** This function gives the rows of the failure times: a dot for each zone-loss run, and the band of the law. */
export const timeRows = (): ChartRow[] =>
  sweep.settings.map((setting) => ({
    id: setting.id,
    label: `${setting.label}, T0 ${timeText(setting.t0)}`,
    right: timeText(setting.medians.failure),
    median: setting.medians.failure,
    band: setting.band,
    dots: setting.zone.map((run, n) => ({
      key: `${n}`,
      at: run.dead,
      value: timeText(run.dead),
      text: `${setting.label}, run ${n + 1} of ${setting.zone.length}. ${count(run.outside)} failed requests outside the cluster, and none in it.`,
    })),
  }));

/** This function gives the rows of the pauses: a line for each counted run, and a dot for each pause of that run. */
export const pauseRows = (): ChartRow[] =>
  sweep.settings.map((setting) => ({
    id: setting.id,
    label: `${setting.label}, T0 ${timeText(setting.t0)}`,
    right: `${count(setting.medians.deaths)} of ${sweep.holds.length}`,
    band: setting.pauseBand,
    mark: setting.t0,
    tracks: setting.runs.length,
    dots: setting.runs.flatMap((run, n) =>
      run.pauses.map((pause, k) => ({
        key: `${n} ${k}`,
        at: pause.length,
        hollow: !pause.died,
        track: n,
        value: timeText(pause.length),
        text: `${setting.label}, run ${n + 1} of ${setting.runs.length}. ${pause.died ? "A false death." : "No death."}`,
      })),
    ),
  }));

/** This component gives the trade-off: a row for each setting. */
export function DetectionTrade(): ReactElement {
  return (
    <figure className="sy-rows-figure not-content">
      <div className="sy-scroll">
        <table className="sy-table">
          <thead>
            <tr>
              <th>Setting</th>
              <th className="num">T0</th>
              <th className="num">Median failure time</th>
              <th className="num">Median failed requests outside</th>
              <th className="num">False deaths in each run</th>
            </tr>
          </thead>
          <tbody>
            {sweep.settings.map((setting) => (
              <tr key={setting.id}>
                <th scope="row">{setting.label}</th>
                <td className="num">{timeText(setting.t0)}</td>
                <td className="num">{timeText(setting.medians.failure)}</td>
                <td className="num">{count(setting.medians.outside)}</td>
                <td className="num">{setting.runs.map(deathsOf).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption>
        Each setting is the probe interval × the suspicion multiplier, and 1 s × 4 is the default. Each run has 5 pauses. The setting 500 ms × 2 has 2 counted pause runs of 4, because the wait for a quiet VM voided the others.
      </figcaption>
    </figure>
  );
}

function TimesTable(): ReactElement {
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Setting</th>
            <th className="num">Run</th>
            <th className="num">Failure time</th>
            <th className="num">Band of the law</th>
            <th className="num">Suspicion time</th>
            <th className="num">Failed requests outside</th>
          </tr>
        </thead>
        <tbody>
          {sweep.settings.flatMap((setting) =>
            setting.zone.map((run, n) => (
              <tr key={`${setting.id} ${n}`}>
                <th scope="row">{setting.label}</th>
                <td className="num">{n + 1}</td>
                <td className="num">{timeText(run.dead)}</td>
                <td className="num">
                  {timeText(setting.band.low)} to {timeText(setting.band.high)}
                </td>
                <td className="num">{timeText(run.suspicion)}</td>
                <td className="num">{count(run.outside)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** This component puts each zone-loss run of each setting on one axis of seconds, with a table view. */
export function DetectionTimes(): ReactElement {
  const rows = timeRows();
  return (
    <RowsFigure
      rows={rows}
      to={TIMES_TO}
      label={`The time from the zone loss to the death of the speaker, for each run of each setting, from 0 to ${TIMES_TO} s. ${sweep.settings.map((setting) => `${setting.label}: the median is ${timeText(setting.medians.failure)}.`).join(" ")}`}
      table={<TimesTable />}
      caption="The time from the zone loss to the death of the speaker. A dot is a counted run, the dashed line and the number at the right are the median, and the shaded band is the law."
    />
  );
}

function PausesTable(): ReactElement {
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <thead>
          <tr>
            <th>Setting</th>
            <th className="num">Run</th>
            {sweep.holds.map((hold) => (
              <th key={hold} className="num">
                Hold of {hold} s
              </th>
            ))}
            <th className="num">False deaths</th>
          </tr>
        </thead>
        <tbody>
          {sweep.settings.flatMap((setting) =>
            setting.runs.map((run, n) => (
              <tr key={`${setting.id} ${n}`}>
                <th scope="row">{setting.label}</th>
                <td className="num">{n + 1}</td>
                {run.pauses.map((pause, k) => (
                  <td key={k} className="num">
                    {timeText(pause.length)}, {pause.died ? "death" : "none"}
                  </td>
                ))}
                <td className="num">{deathsOf(run)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** This component puts each pause of each counted run on one axis of seconds, with a table view. */
export function DetectionPauses(): ReactElement {
  const rows = pauseRows();
  return (
    <RowsFigure
      rows={rows}
      to={PAUSES_TO}
      label={`The measured length of each pause of a live speaker, for each run of each setting, from 0 to ${PAUSES_TO} s. ${sweep.settings.map((setting) => `${setting.label}: T0 is ${timeText(setting.t0)}, and the median run has ${count(setting.medians.deaths)} false deaths of ${sweep.holds.length} pauses.`).join(" ")}`}
      legend={
        <ul className="sy-legend" aria-label="Legend">
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <circle className="sy-run" cx="6" cy="6" r="4" />
            </svg>
            A false death
          </li>
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <circle className="sy-run-hollow" cx="6" cy="6" r="4" />
            </svg>
            No death
          </li>
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <line className="sy-rows-mark" x1="6" x2="6" y1="0" y2="12" />
            </svg>
            T0
          </li>
          <li>
            <svg width="12" height="12" aria-hidden="true">
              <rect className="sy-rows-band" width="12" height="12" />
            </svg>
            The phase of the probe decides
          </li>
        </ul>
      }
      table={<PausesTable />}
      caption="Each line of a row is one counted run, and each dot is one pause at its measured length. The number at the right is the median count of false deaths in a run."
    />
  );
}
