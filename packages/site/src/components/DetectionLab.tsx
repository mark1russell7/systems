/**
 * The detection lab. The reader sets the timers of Linux and selects what the connection does when its
 * peer goes silent. The lab computes the timer that tells the client first, and when it fires. A harness
 * cell loads its own settings, and the lab then shows the measurements of that cell beside the prediction.
 */
import { useMemo, useState, type ReactElement } from "react";
import harness from "../data/harness-2026-10-08.json";
import { duration } from "../lib/format.ts";
import { LINUX_66, detection, keepalive, retransmission, type Knobs, type Situation } from "../model/linux.ts";
import Legend from "./Legend.tsx";
import Strip from "./Strip.tsx";

interface Preset {
  readonly id: string;
  readonly label: string;
  readonly knobs: Knobs;
  readonly situation: Situation;
  /** the harness cell with these settings, or null */
  readonly cell: string | null;
}

const SCALED: Knobs = { ...LINUX_66, keepidle: 5000, keepintvl: 2000, keepcnt: 3, rtt: 1 };
const PRESETS: readonly Preset[] = [
  { id: "linux", label: "Linux 6.6", knobs: LINUX_66, situation: "idle", cell: null },
  { id: "q1", label: "Cell Q1", knobs: SCALED, situation: "idle", cell: "Q1 idle, black hole" },
  { id: "q2-3", label: "Cell Q2, retries 3", knobs: { ...SCALED, retries: 3 }, situation: "in-flight", cell: "Q2 in flight, black hole, tcp_retries2 = 3" },
  { id: "q2-5", label: "Cell Q2, retries 5", knobs: { ...SCALED, retries: 5 }, situation: "in-flight", cell: "Q2 in flight, black hole, tcp_retries2 = 5" },
  { id: "q3", label: "Cell Q3", knobs: { ...SCALED, retries: 3 }, situation: "frozen", cell: "Q3 in flight, frozen process" },
];
const SITUATIONS: ReadonlyArray<{ readonly id: Situation; readonly label: string }> = [
  { id: "idle", label: "Idle" },
  { id: "in-flight", label: "Request in flight" },
  { id: "frozen", label: "Frozen process" },
];
const HZ = [100, 250, 300, 1000] as const;

/** A slider on a logarithmic scale from `min` to `max`, for times that span several orders. */
const toLog = (value: number, min: number, max: number): number => (100 * Math.log(value / min)) / Math.log(max / min);
const fromLog = (step: number, min: number, max: number): number => min * (max / min) ** (step / 100);

export default function DetectionLab(): ReactElement {
  const [knobs, setKnobs] = useState<Knobs>(SCALED);
  const [situation, setSituation] = useState<Situation>("idle");
  const [keepaliveOn, setKeepaliveOn] = useState(true);
  const [cell, setCell] = useState<string | null>("Q1 idle, black hole");

  const change = (next: Partial<Knobs>): void => {
    setKnobs((now) => ({ ...now, ...next }));
    setCell(null);
  };
  const load = (preset: Preset): void => {
    setKnobs(preset.knobs);
    setSituation(preset.situation);
    setKeepaliveOn(true);
    setCell(preset.cell);
  };

  const found = useMemo(() => detection(knobs, situation, keepaliveOn), [knobs, situation, keepaliveOn]);
  const measured = harness.cells.find((c) => c.name === cell);
  const runs = (measured?.runs ?? []).flatMap((run, n) =>
    run.elapsed === null ? [] : [{ t: run.elapsed * 1000, row: run.environment, label: `Run ${n + 1}, environment ${run.environment + 1}` }],
  );

  const bounds = found.bounds;
  const giveUp = found.timer === "retransmission" ? retransmission(knobs).giveUp : undefined;
  const marks =
    found.timer === "keepalive"
      ? keepalive(knobs).probes.map((t, n) => ({ t, label: `Keepalive probe ${n + 1}` }))
      : found.timer === "retransmission"
        ? retransmission(knobs).firings.map((t, n) => ({ t, label: `RTO firing ${n + 1}` }))
        : [];
  const low = bounds === null ? 0 : bounds.duration - bounds.early;
  const high = bounds === null ? 0 : bounds.duration + bounds.late;
  const end = Math.max(high, ...marks.map((m) => m.t), ...runs.map((r) => r.t)) * 1.04;
  // the zoomed view: the band and the measured runs, with a margin on each side
  const near = [low, high, ...runs.map((r) => r.t), ...(giveUp === undefined ? [] : [giveUp])];
  const span = Math.max(...near) - Math.min(...near);
  const zoom = { from: Math.max(0, Math.min(...near) - span * 0.15), to: Math.max(...near) + span * 0.15 };
  const lines = giveUp === undefined ? [] : [{ t: giveUp, label: "The give-up without the rounding of the wheel" }];

  const summary =
    bounds === null
      ? "No TCP timer can tell the client. The failure is silent at the TCP level."
      : `${found.timer === "keepalive" ? "Keepalive" : "The retransmission give-up"} tells the client after ${duration(bounds.duration)}, at most ${duration(bounds.late)} late.`;

  return (
    <section className="sy-frame not-content" aria-label="The detection lab">
      <header>
        <strong>When does the client know?</strong>
        <span className="sy-row">
          {PRESETS.map((preset) => (
            <button key={preset.id} type="button" className="sy-button" aria-pressed={cell === preset.cell && preset.cell !== null} onClick={() => load(preset)}>
              {preset.label}
            </button>
          ))}
        </span>
      </header>

      <div className="sy-knobs">
        <div className="sy-row sy-wide" role="group" aria-label="What the connection does">
          {SITUATIONS.map((s) => (
            <button key={s.id} type="button" className="sy-button" aria-pressed={situation === s.id} onClick={() => { setSituation(s.id); setCell(null); }}>
              {s.label}
            </button>
          ))}
          <button type="button" className="sy-button" aria-pressed={keepaliveOn} onClick={() => { setKeepaliveOn(!keepaliveOn); setCell(null); }}>
            SO_KEEPALIVE
          </button>
        </div>
        <label className="sy-knob">
          <span>
            Keepalive idle time <output>{duration(knobs.keepidle)}</output>
          </span>
          <input type="range" min={0} max={100} step={0.5} value={toLog(knobs.keepidle, 1000, 7_200_000)} onChange={(e) => change({ keepidle: Math.round(fromLog(Number(e.target.value), 1000, 7_200_000) / 1000) * 1000 })} />
        </label>
        <label className="sy-knob">
          <span>
            Probe interval <output>{duration(knobs.keepintvl)}</output>
          </span>
          <input type="range" min={0} max={100} step={0.5} value={toLog(knobs.keepintvl, 1000, 75_000)} onChange={(e) => change({ keepintvl: Math.round(fromLog(Number(e.target.value), 1000, 75_000) / 1000) * 1000 })} />
        </label>
        <label className="sy-knob">
          <span>
            Probes <output>{knobs.keepcnt}</output>
          </span>
          <input type="range" min={1} max={9} step={1} value={knobs.keepcnt} onChange={(e) => change({ keepcnt: Number(e.target.value) })} />
        </label>
        <label className="sy-knob">
          <span>
            Retransmission budget <output>{knobs.retries}</output>
          </span>
          <input type="range" min={1} max={15} step={1} value={knobs.retries} onChange={(e) => change({ retries: Number(e.target.value) })} />
        </label>
        <label className="sy-knob">
          <span>
            Round trip <output>{duration(knobs.rtt)}</output>
          </span>
          <input type="range" min={0} max={100} step={0.5} value={toLog(knobs.rtt, 0.1, 300)} onChange={(e) => change({ rtt: Number(fromLog(Number(e.target.value), 0.1, 300).toPrecision(2)) })} />
        </label>
        <div className="sy-knob">
          <span>
            Kernel clock <output>HZ {knobs.hz}</output>
          </span>
          <span className="sy-row">
            {HZ.map((hz) => (
              <button key={hz} type="button" className="sy-button" aria-pressed={knobs.hz === hz} onClick={() => change({ hz })}>
                {hz}
              </button>
            ))}
          </span>
        </div>
      </div>

      <dl className="sy-readout">
        <div>
          <dt>First detector</dt>
          <dd>{found.timer === null ? "none" : found.timer}</dd>
        </div>
        <div>
          <dt>Closed form</dt>
          <dd>{bounds === null ? "never" : duration(bounds.duration)}</dd>
        </div>
        <div>
          <dt>Lands in</dt>
          <dd>{bounds === null ? "never" : `${duration(low)} to ${duration(high)}`}</dd>
        </div>
        {measured === undefined ? null : (
          <div>
            <dt>Measured</dt>
            <dd>{runs.length === 0 ? `silent in ${measured.runs.length} runs` : `${duration(Math.min(...runs.map((r) => r.t)))} to ${duration(Math.max(...runs.map((r) => r.t)))}`}</dd>
          </div>
        )}
      </dl>

      <div className="sy-body">
        <p className="sy-muted">{summary}</p>
        {found.held.length === 0 ? null : (
          <ul className="sy-muted">
            {found.held.map((why) => (
              <li key={why}>{why}</li>
            ))}
          </ul>
        )}
        {bounds === null ? null : (
          <>
            <Legend band marks={found.timer === "keepalive" ? "Keepalive probes" : "RTO firings"} runs={runs.length > 0} line={lines.length > 0 ? "Give-up without the wheel" : undefined} />
            <p className="sy-caption">The whole timeline</p>
            <Strip from={0} to={end} band={{ low, high }} closed={bounds.duration} marks={marks} runs={runs} lines={lines} label={summary} />
            <p className="sy-caption">Near the prediction</p>
            <Strip from={zoom.from} to={zoom.to} band={{ low, high }} closed={bounds.duration} marks={marks} runs={runs} lines={lines} label={`Near the prediction: ${duration(low)} to ${duration(high)}`} />
          </>
        )}
      </div>
    </section>
  );
}
