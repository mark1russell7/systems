/**
 * The quota lab. The reader selects a quota, takes units, gives units back and moves the clock. The strip
 * shows the window of the quota on the wall clock of its zone:
 *
 * - the window: a blue wash
 * - a take: a dot
 * - a shift of the clock: a dashed line
 * - the instant of the reader: a line in ink.
 *
 * Each count comes from the pure step of `@mark1russell7/service/limiter`, through the model `../model/quota.ts`.
 */
import { useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import { duration, spacedLabels } from "../lib/format.ts";
import {
  LIMIT,
  PRESETS,
  bucketsBetween,
  clockOf,
  frameOf,
  newestCounted,
  opening,
  replay,
  rowsOf,
  say,
  shiftsOf,
  stamp,
  ticksOf,
  type Act,
  type Preset,
  type Saying,
  type TakeMark,
} from "../model/quota.ts";
import { Readout, type View } from "./Frame.tsx";
import { useWidth } from "./Strip.tsx";
import { VerdictIcon } from "./Verdict.tsx";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The steps of the clock. The clock goes only forward: each act of the lab is at or before the instant of the reader. */
const STEPS = [
  { label: "+10 min", ms: 10 * MINUTE },
  { label: "+1 h", ms: HOUR },
  { label: "+6 h", ms: 6 * HOUR },
] as const;

const PAD = 12;
/** the width of one character in the mono font at 11 px */
const CHARACTER = 6.7;
const DOT = 4;
/** the space between two dots in one column */
const STACK = 2 * DOT + 3;
/** the most dots in one column: the limit, and four refused takes */
const COLUMN = LIMIT + 4;
/** the distance from the pointer to a dot, in pixels, inside which the dot is the target */
const REACH = 16;
/** the lines of the labels above the plot: the shifts of the clock, then the instant of the reader */
const SHIFT_Y = 11;
const NOW_Y = 24;
const TOP = 30;
const AXIS = TOP + COLUMN * STACK + 6;
const HEIGHT = AXIS + 22;
/** the places of a label of a tick, from the smallest step: a label each 10 min to a label each 12 h */
const MAJORS = [10, 30, 60, 120, 180, 360, 720] as const;

const ICONS: Readonly<Record<Saying["status"], string>> = { good: "holds", critical: "fails", neutral: "calibration" };

/** A take on the strip: its instant, its place, its mark, and the text of its tooltip. */
interface Dot {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly mark: TakeMark;
  readonly label: string;
}

interface StripProps {
  readonly preset: Preset;
  readonly acts: readonly Act[];
  readonly at: number;
  readonly label: string;
}

/** The strip of the window and its legend. The axis runs one eighth of the window past each edge, thus the takes just before the window show. */
function WindowStrip(props: StripProps): ReactElement {
  const { preset, acts, at } = props;
  const { rule, zone } = preset;
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);

  const drawn = useMemo(() => {
    const frame = frameOf(rule, at);
    const lead = (frame.to - frame.from) / 8;
    const from = frame.from - lead;
    const to = frame.to + lead;
    const result = replay(rule, acts, at);
    const span = (to - from) / MINUTE;
    const every = span >= 6 * 60 ? 60 : 10;
    const room = Math.max(3, Math.floor((width - 2 * PAD) / 56));
    const major = MAJORS.find((m) => m % every === 0 && span / m <= room) ?? 720;
    return { frame, from, to, result, ticks: ticksOf(zone, from, to, every, major), shifts: shiftsOf(zone, from, to), buckets: bucketsBetween(rule, from, to).filter((b) => b > from) };
  }, [rule, zone, acts, at, width]);
  const { frame, from, to, result, ticks, shifts, buckets } = drawn;

  const x = (t: number): number => PAD + ((width - 2 * PAD) * (t - from)) / (to - from);
  const numbers = new Map<number, number>();
  acts.forEach((act, n) => {
    if (act.kind === "take") numbers.set(n, numbers.size + 1);
  });
  // the takes of one instant stack up from the axis, in the sequence of the acts
  const placed: Dot[] = [];
  acts.forEach((act, n) => {
    if (act.kind !== "take" || act.at < from || act.at > to) return;
    const cx = x(act.at);
    const below = placed.filter((dot) => Math.abs(dot.x - cx) < STACK).length;
    const mark = result.marks.get(n) ?? "counted";
    placed.push({ t: act.at, x: cx, y: AXIS - 6 - DOT - Math.min(below, COLUMN - 1) * STACK, mark, label: `Take ${String(numbers.get(n))}, ${mark}` });
  });
  const dots = [...placed].sort((a, b) => a.x - b.x || b.y - a.y);

  const nearest = (px: number, py: number): number | null => {
    let best: number | null = null;
    let distance = REACH;
    dots.forEach((dot, n) => {
      const d = Math.hypot(dot.x - px, dot.y - py);
      if (d <= distance) [best, distance] = [n, d];
    });
    return best;
  };
  const onMove = (event: PointerEvent<SVGSVGElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = width / box.width;
    setActive(nearest((event.clientX - box.left) * scale, (event.clientY - box.top) * scale));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") setActive(null);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0 || dots.length === 0) return;
    event.preventDefault();
    const now = active === null ? (step > 0 ? -1 : dots.length) : active;
    setActive(Math.min(dots.length - 1, Math.max(0, now + step)));
  };

  const labels = spacedLabels(
    ticks.filter((tick) => tick.major).map((tick) => ({ x: x(tick.at), width: tick.text.length * CHARACTER, text: tick.text, t: tick.at })),
    width,
    10,
  );
  const shiftLabels = spacedLabels(
    shifts.map((shift) => ({ x: x(shift.at), width: 13 * CHARACTER, text: `${shift.before} → ${shift.after}`, t: shift.at })),
    width,
  );
  const nowText = clockOf(at, zone);
  const [nowLabel] = spacedLabels([{ x: x(at), width: nowText.length * CHARACTER }], width);
  const target = active === null ? undefined : dots[active];
  const margin = Math.min(114, width / 2);
  const tipX = target === undefined ? 0 : Math.min(width - margin, Math.max(margin, target.x));
  return (
    <>
    <div ref={ref} className="sy-strip" tabIndex={0} onKeyDown={onKey} onBlur={() => setActive(null)}>
      <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={props.label} onPointerMove={onMove} onPointerLeave={() => setActive(null)}>
        <g className="sy-band">
          <rect x={x(frame.from)} y={TOP} width={x(frame.to) - x(frame.from)} height={AXIS - TOP} />
          <line x1={x(frame.from)} x2={x(frame.from)} y1={TOP} y2={AXIS} />
          <line x1={x(frame.to)} x2={x(frame.to)} y1={TOP} y2={AXIS} />
        </g>
        {buckets.map((b) => (
          <line key={`bucket ${b}`} className="sy-bucket" x1={x(b)} x2={x(b)} y1={TOP} y2={AXIS} />
        ))}
        {labels.map((label) => (
          <line key={`grid ${label.t}`} className="sy-grid" x1={label.x} x2={label.x} y1={TOP} y2={AXIS} />
        ))}
        {shifts.map((shift) => (
          <line key={`shift ${shift.at}`} className="sy-shift" x1={x(shift.at)} x2={x(shift.at)} y1={SHIFT_Y + 4} y2={AXIS} />
        ))}
        {shiftLabels.map((label) => (
          <text key={`shift label ${label.t}`} className="sy-shift-text" x={label.at} y={SHIFT_Y} textAnchor={label.anchor}>
            {label.text}
          </text>
        ))}
        <line className="sy-now" x1={x(at)} x2={x(at)} y1={NOW_Y + 4} y2={AXIS} />
        {nowLabel === undefined ? null : (
          <text className="sy-now-text" x={nowLabel.at} y={NOW_Y} textAnchor={nowLabel.anchor}>
            {nowText}
          </text>
        )}
        {dots.map((dot) =>
          dot.mark === "refused" ? (
            <path key={`${dot.t} ${dot.y}`} className="sy-refused" d={`M${dot.x - 3.5} ${dot.y - 3.5}l7 7m0 -7l-7 7`} />
          ) : (
            <circle key={`${dot.t} ${dot.y}`} className={dot.mark === "counted" ? "sy-run" : dot.mark === "given back" ? "sy-run-hollow" : "sy-expired"} cx={dot.x} cy={dot.y} r={DOT} />
          ),
        )}
        <line className="sy-axis-line" x1={PAD} x2={width - PAD} y1={AXIS} y2={AXIS} />
        {ticks.map((tick) => (
          <line key={`tick ${tick.at}`} className="sy-tick-line" x1={x(tick.at)} x2={x(tick.at)} y1={AXIS} y2={AXIS + (tick.major ? 5 : 3)} />
        ))}
        {labels.map((label) => (
          <text key={`label ${label.t}`} x={label.at} y={AXIS + 16} textAnchor={label.anchor}>
            {label.text}
          </text>
        ))}
        {target === undefined ? null : <circle className="sy-focus" cx={target.x} cy={target.y} r={DOT + 3} />}
      </svg>
      {target === undefined ? null : (
        <div className="sy-tip" style={{ left: tipX, top: Math.max(0, target.y - 12) }}>
          <strong>{stamp(target.t, zone)}</strong>
          <span>{target.label}</span>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {target === undefined ? "" : `${target.label}: ${stamp(target.t, zone)}`}
      </p>
    </div>
    <QuotaLegend marks={new Set(dots.map((dot) => dot.mark))} shift={shifts.length > 0} />
    </>
  );
}

/** The legend of the strip: each swatch beside its label. It names only the marks that the strip draws. */
function QuotaLegend(props: { readonly marks: ReadonlySet<TakeMark>; readonly shift: boolean }): ReactElement {
  const dot = (className: string): ReactElement => (
    <svg width="12" height="12" aria-hidden="true">
      <circle className={className} cx="6" cy="6" r="4" />
    </svg>
  );
  const line = (className: string): ReactElement => (
    <svg width="10" height="12" aria-hidden="true">
      <path className={className} d="M5 0v12" />
    </svg>
  );
  const items: Array<{ readonly key: string; readonly swatch: ReactElement; readonly text: string }> = [
    {
      key: "window",
      text: "Window",
      swatch: (
        <svg width="18" height="12" aria-hidden="true">
          <rect className="sy-band-fill" x="1" y="0" width="16" height="12" />
          <path className="sy-band-edge" d="M1 0v12M17 0v12" />
        </svg>
      ),
    },
    ...(props.marks.has("counted") ? [{ key: "counted", text: "Counted", swatch: dot("sy-run") }] : []),
    ...(props.marks.has("given back") ? [{ key: "given back", text: "Given back", swatch: dot("sy-run-hollow") }] : []),
    ...(props.marks.has("expired") ? [{ key: "expired", text: "Stopped counting", swatch: dot("sy-expired") }] : []),
    ...(props.marks.has("refused")
      ? [
          {
            key: "refused",
            text: "Refused",
            swatch: (
              <svg width="12" height="12" aria-hidden="true">
                <path className="sy-refused" d="M2.5 2.5l7 7m0 -7l-7 7" />
              </svg>
            ),
          },
        ]
      : []),
    ...(props.shift ? [{ key: "shift", text: "Clock shift", swatch: line("sy-shift") }] : []),
    { key: "clock", text: "Your clock", swatch: line("sy-now") },
  ];
  return (
    <ul className="sy-legend" aria-label="Legend">
      {items.map((item) => (
        <li key={item.key}>
          {item.swatch}
          {item.text}
        </li>
      ))}
    </ul>
  );
}

export default function QuotaLab(): ReactElement {
  const [presetId, setPresetId] = useState(PRESETS[0]?.id ?? "back");
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;
  const [acts, setActs] = useState<readonly Act[]>(() => opening(preset).acts);
  const [at, setAt] = useState(() => opening(preset).at);
  const [view, setView] = useState<View>("chart");

  const load = (next: Preset): void => {
    const first = opening(next);
    setPresetId(next.id);
    setActs(first.acts);
    setAt(first.at);
  };

  const { rule, zone } = preset;
  const result = useMemo(() => replay(rule, acts, at), [rule, acts, at]);
  const frame = useMemo(() => frameOf(rule, at), [rule, at]);
  const saying = say(result, zone, at);
  const newest = newestCounted(result);
  const shifts = useMemo(() => shiftsOf(zone, frame.from, frame.to), [zone, frame]);
  const rows = rowsOf(result, zone);

  const take = (): void => setActs([...acts, { kind: "take", at }]);
  const giveBack = (): void => {
    if (newest >= 0) setActs([...acts, { kind: "give-back", at, take: newest }]);
  };
  // the reset of a window with no unit is the end of the window
  const toReset = (): void => setAt(result.state.resetAt ?? frame.to);

  const length = rule.window.kind === "rolling" ? `last ${duration(rule.window.span)}` : duration(frame.to - frame.from);
  const readout = [
    { label: "Clock", value: stamp(at, zone) },
    { label: "Used", value: `${String(result.state.used)} of ${String(LIMIT)}` },
    { label: "Window", value: length },
    { label: "Shift", value: shifts.length === 0 ? "none" : shifts.map((shift) => `${shift.before} → ${shift.after}`).join(", ") },
  ];
  const summary = `${saying.verdict}: ${saying.title}. The window runs from ${stamp(frame.from, zone)} to ${stamp(frame.to, zone)}.`;

  return (
    <section className="sy-frame sy-lab not-content" aria-label="The quota lab">
      <header className="sy-head">
        <div className="sy-title">
          <strong>What does the window count?</strong>
        </div>
        <div className="sy-row" role="group" aria-label="Quotas">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="sy-button" aria-pressed={p.id === presetId} onClick={() => load(p)}>
              {p.label}
            </button>
          ))}
        </div>
      </header>

      <div className="sy-knobs">
        <div className="sy-row sy-wide">
          <span className="sy-switch" role="group" aria-label="Units">
            <button type="button" onClick={take}>
              Take 1
            </button>
            <button type="button" onClick={giveBack} disabled={newest < 0}>
              Give 1 back
            </button>
          </span>
          <span className="sy-switch" role="group" aria-label="Move the clock">
            {STEPS.map((step) => (
              <button key={step.label} type="button" onClick={() => setAt(at + step.ms)}>
                {step.label}
              </button>
            ))}
            <button type="button" onClick={toReset}>
              To the reset
            </button>
          </span>
          <button type="button" className="sy-button" onClick={() => load(preset)}>
            Start again
          </button>
        </div>
      </div>

      <Readout items={readout} />

      <div className="sy-body">
        <p className="sy-lede" aria-live="polite">
          <span className="sy-verdict" data-status={saying.status}>
            <VerdictIcon decision={ICONS[saying.status]} />
            <span>{saying.verdict}</span>
          </span>{" "}
          {saying.title}. {saying.detail}
        </p>
        <div className="sy-row sy-between">
          <p className="sy-caption">{view === "chart" ? `The window on the clock of ${zone}` : "The acts"}</p>
          <span className="sy-switch" role="group" aria-label="View">
            <button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>
              Chart
            </button>
            <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
              Table
            </button>
          </span>
        </div>
        {view === "table" ? (
          <div className="sy-scroll">
            <table className="sy-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Act</th>
                  <th>Verdict</th>
                  <th className="num">Used</th>
                  <th className="num">Left</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, n) => (
                  <tr key={n}>
                    <td>{row.when}</td>
                    <td>{row.what}</td>
                    <td>{row.verdict}</td>
                    <td className="num">{row.used}</td>
                    <td className="num">{row.left}</td>
                    <td>{row.mark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <WindowStrip preset={preset} acts={acts} at={at} label={summary} />
        )}
        <p className="sy-muted">{preset.note}</p>
      </div>
    </section>
  );
}
