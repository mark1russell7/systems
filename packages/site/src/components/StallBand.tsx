/**
 * The band of the stall cells of C, before and after SYS-48. In a stall, candidate C (GOAWAY on HTTP/2)
 * fails the requests of each session on the target until the event loop resumes. SYS-48 adds the backlog
 * term to the band of these cells. With n sessions on the target, the window closes up to
 * (n − 1) × 45 ms + 100 ms later.
 *
 * For each dataplane, the chart puts two bands of the count of failed requests on one axis. The grey bar
 * is the band without the term, and the blue bar is the band with the term. The dots on the grey bar are
 * the counted runs of the earlier copy. The dots on the blue bar are the counted runs of SYS-48. A run
 * out of its band is a red mark with a cross and a note, thus it does not depend on color alone.
 *
 * A pointer over a dot, a tap or the focus shows the run, the cell, the count and the two bands. Each dot
 * links to the frame of its cell. The table view gives the same runs as rows.
 */
import { useState, type MouseEvent, type PointerEvent, type ReactElement } from "react";
import s2Stall from "../data/s2-stall-2026-10-26.json";
import s2StallBand from "../data/s2-stall-band-2026-10-28.json";
import s2StallCilium from "../data/s2-stall-cilium-2026-10-27.json";
import { count, countTicks, spacedLabels } from "../lib/format.ts";
import { kindCellId } from "./RunResults.tsx";
import { LANES, lanesOf, useWidth } from "./Strip.tsx";
import { VerdictIcon } from "./Verdict.tsx";

/** The dataplanes of the stall cells of C, in the sequence of the kind page. */
export const STALL_MODES = ["iptables", "ipvs", "nftables", "cilium"] as const;
type Mode = (typeof STALL_MODES)[number];

/** The CI runs of the copies: the stall of kube-proxy, the stall of Cilium, and the stall band of SYS-48. */
export const STALL_RUNS = { stall: 40406199754, cilium: 40558968382, band: 40643221421 } as const;

interface Band {
  readonly low: number;
  readonly high: number;
}

/** One counted run on the chart: its copy, its CI run, its place in the cell, its count, and the frame of its cell. */
export interface BandRun {
  readonly mode: Mode;
  /** `before`: the copy without the term. `after`: the copy of SYS-48, with the term. */
  readonly copy: "before" | "after";
  readonly run: number;
  readonly index: number;
  readonly of: number;
  readonly value: number;
  readonly cell: string;
  readonly href: string;
  /** the band that the verdict of the run used */
  readonly band: Band;
  /** the count above the band without the term, or 0 */
  readonly overOld: number;
  /** the count above the band with the term, or 0 */
  readonly overNew: number;
}

/** The two bands of one dataplane, the decisions of its two cells, and its counted runs. */
export interface ModeBands {
  readonly mode: Mode;
  readonly old: Band;
  readonly new: Band;
  readonly before: { readonly run: number; readonly decision: string };
  readonly after: { readonly run: number; readonly decision: string };
  readonly runs: readonly BandRun[];
}

type StallCell = (typeof s2Stall.cells)[number];

const cellOf = (cells: readonly StallCell[], mode: Mode): StallCell => {
  const found = cells.find((cell) => cell.id === `S2.T07.${mode}.goaway.stall`);
  if (found === undefined) throw new Error(`no stall cell of C in ${mode}`);
  return found;
};

const bandOf = (cell: StallCell): Band => {
  const expected = (cell as { readonly candidate?: { readonly expected?: Band } }).candidate?.expected;
  if (expected === undefined) throw new Error(`the stall cell ${cell.id} has no expected count`);
  return { low: expected.low, high: expected.high };
};

/** This function gives the two bands and the counted runs of each dataplane, from the three copies. */
export const stallBands = (): ModeBands[] =>
  STALL_MODES.map((mode) => {
    const earlier = mode === "cilium" ? s2StallCilium : s2Stall;
    const beforeRun = mode === "cilium" ? STALL_RUNS.cilium : STALL_RUNS.stall;
    const before = cellOf(earlier.cells as readonly StallCell[], mode);
    const after = cellOf(s2StallBand.cells as readonly StallCell[], mode);
    const old = bandOf(before);
    const now = bandOf(after);
    const over = (value: number, band: Band): number => Math.max(0, value - band.high);
    const runsOf = (cell: StallCell, copy: "before" | "after", run: number, band: Band): BandRun[] =>
      cell.values.map((value, n) => ({
        mode,
        copy,
        run,
        index: n + 1,
        of: cell.values.length,
        value,
        cell: cell.id,
        href: `#${kindCellId(cell, copy === "after" ? "sys-48" : undefined)}`,
        band,
        overOld: over(value, old),
        overNew: over(value, now),
      }));
    return {
      mode,
      old,
      new: now,
      before: { run: beforeRun, decision: before.decision },
      after: { run: STALL_RUNS.band, decision: after.decision },
      runs: [...runsOf(before, "before", beforeRun, old), ...runsOf(after, "after", STALL_RUNS.band, now)],
    };
  });

/** This function tells if a run is out of the band that its verdict used. */
export const outOfBand = (run: BandRun): boolean => run.value < run.band.low || run.value > run.band.high;

const requests = (n: number): string => `${count(n)} failed ${n === 1 ? "request" : "requests"}`;
const bandText = (band: Band): string => `${count(band.low)} to ${count(band.high)}`;
const runName = (run: BandRun): string => `run ${run.index} of ${run.of} of CI run ${run.run}`;
const sideText = (over: number): string => (over === 0 ? "in" : `${count(over)} over`);

/** This function writes what a run measured against each band, for the tooltip and for the label of its link. */
export const runText = (run: BandRun, bands: ModeBands): string =>
  `${run.cell}, ${runName(run)}. Without the term, the band is ${bandText(bands.old)}: ${sideText(run.overOld)}. With the term, the band is ${bandText(bands.new)}: ${sideText(run.overNew)}.`;

const PAD = 12;
/** the height of the line above the bars of a dataplane: its name and the note of a run out of its band */
const HEAD = 18;
/** the height of one bar, with three lanes of dots */
const BAR = 26;
const GAP = 3;
const AFTER = 10;
const BLOCK = HEAD + BAR + GAP + BAR + AFTER;
const DOT = 4;
/** the distance between two lanes of dots */
const LANE = 7;
const MISS = 6;
const REACH = 16;
/** the width of one character in the mono font at 11 px */
const CHARACTER = 6.7;

/** The ranges of the axis: the whole band, or its top end, where the two bands end. */
const RANGES = { whole: { from: 0, label: "The whole band" }, top: { from: 1400, label: "The top end" } } as const;
type Range = keyof typeof RANGES;

interface Dot {
  readonly run: BandRun;
  readonly bands: ModeBands;
  readonly x: number;
  readonly y: number;
  readonly miss: boolean;
}

function Chart(props: { readonly modes: readonly ModeBands[]; readonly range: Range }): ReactElement {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const { modes } = props;
  const highest = Math.max(...modes.flatMap((m) => [m.old.high, m.new.high, ...m.runs.map((run) => run.value)]));
  const to = Math.ceil((highest * 1.03) / 100) * 100;
  const from = RANGES[props.range].from;
  const left = PAD;
  const right = width - PAD;
  const x = (n: number): number => left + ((right - left) * (Math.min(Math.max(n, from), to) - from)) / (to - from);
  const axis = modes.length * BLOCK;
  const height = axis + 24;
  const ticks = countTicks(from, to, Math.max(4, Math.floor((right - left) / 72)));
  const labels = spacedLabels(
    ticks.map((t) => ({ t, x: x(t), text: count(t), width: count(t).length * CHARACTER })),
    width,
  );

  const dots: Dot[] = modes.flatMap((bands, row) => {
    const top = row * BLOCK + HEAD;
    return (["before", "after"] as const).flatMap((copy, bar) => {
      const shown = bands.runs.filter((run) => run.copy === copy && run.value >= from);
      const lanes = lanesOf(
        shown.map((run) => x(run.value)),
        2 * DOT + 2,
      );
      const middle = top + bar * (BAR + GAP) + BAR / 2;
      return shown.map((run, n): Dot => ({ run, bands, x: x(run.value), y: middle + LANES[lanes[n] ?? 0]! * LANE, miss: outOfBand(run) }));
    });
  });
  const hidden = modes.flatMap((bands) => bands.runs).filter((run) => run.value < from).length;

  const nearest = (px: number, py: number): number | null => {
    let best: number | null = null;
    let distance = REACH;
    dots.forEach((dot, n) => {
      const d = Math.hypot(dot.x - px, dot.y - py);
      if (d <= distance) [best, distance] = [n, d];
    });
    return best;
  };
  const pointAt = (event: PointerEvent<SVGSVGElement> | MouseEvent<SVGSVGElement>): number | null => {
    const box = event.currentTarget.getBoundingClientRect();
    const scale = width / box.width;
    return nearest((event.clientX - box.left) * scale, (event.clientY - box.top) * scale);
  };
  const onMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (event.pointerType === "mouse") setActive(pointAt(event));
  };
  // a tap shows the run first, and a second tap on the same dot goes to its cell. A mouse goes at once, because the pointer showed the run
  const onClick = (event: MouseEvent<SVGSVGElement>): void => {
    if (event.detail === 0) return;
    const n = pointAt(event);
    const onDot = (event.target as Element).closest("a") !== null;
    if (onDot && n !== null && n === active) return;
    if (onDot) event.preventDefault();
    setActive(n);
  };

  const target = active === null ? undefined : dots[active];
  const margin = Math.min(114, width / 2);
  const tipX = target === undefined ? 0 : Math.min(width - margin, Math.max(margin, target.x));
  const label = `The failed requests of the stall cells of C, against the band without the backlog term and the band with it, from ${count(from)} to ${count(to)}. ${modes
    .map((bands) => {
      const misses = bands.runs.filter(outOfBand);
      return `${bands.mode}: without the term ${bandText(bands.old)}, with the term ${bandText(bands.new)}. ${misses.length === 0 ? "Each run is in its band" : misses.map((run) => `${requests(run.value)} in ${runName(run)}, ${count(run.overOld)} over the band without the term`).join(". ")}.`;
    })
    .join(" ")}`;
  return (
    <div ref={ref} className="sy-strip sy-stall" onBlur={() => setActive(null)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setActive(null)} onClick={onClick}>
        {ticks.map((t) => (
          <line key={`grid ${t}`} className="sy-grid" x1={x(t)} x2={x(t)} y1={HEAD - 4} y2={axis} />
        ))}
        {modes.map((bands, row) => {
          const top = row * BLOCK + HEAD;
          const miss = bands.runs.find(outOfBand);
          const missX = miss === undefined ? 0 : x(miss.value);
          const note = miss === undefined ? "" : `${count(miss.value)}: ${count(miss.overOld)} over its band`;
          return (
            <g key={bands.mode}>
              <text className="sy-stall-mode" x={left} y={top - 6}>
                {bands.mode}
              </text>
              {miss === undefined ? null : (
                <text
                  className="sy-stall-note"
                  // the note ends at the miss, but never covers the name of the mode
                  x={Math.min(width - 2, Math.max(left + (bands.mode.length + 2 + note.length) * CHARACTER, missX + MISS))}
                  y={top - 6}
                  textAnchor="end"
                >
                  {note}
                </text>
              )}
              {([
                ["old", bands.old, 0],
                ["new", bands.new, 1],
              ] as const).map(([kind, band, bar]) => {
                const y = top + bar * (BAR + GAP);
                const low = x(band.low);
                const high = x(band.high);
                return (
                  <g key={kind} className={kind === "old" ? "sy-stall-old" : "sy-band"}>
                    <rect x={low} y={y} width={Math.max(high - low, 1)} height={BAR} />
                    {band.low >= from ? <line x1={low} x2={low} y1={y} y2={y + BAR} /> : null}
                    <line x1={high} x2={high} y1={y} y2={y + BAR} />
                  </g>
                );
              })}
            </g>
          );
        })}
        {dots.map((dot, n) => (
          <a key={`${dot.run.mode} ${dot.run.copy} ${dot.run.index}`} href={dot.run.href} aria-label={`${requests(dot.run.value)}. ${runText(dot.run, dot.bands)}`} onFocus={() => setActive(n)}>
            {dot.miss ? (
              <g className="sy-stall-miss">
                <circle cx={dot.x} cy={dot.y} r={MISS} />
                <path d={`M${dot.x - 2.5} ${dot.y - 2.5}l5 5M${dot.x + 2.5} ${dot.y - 2.5}l-5 5`} />
              </g>
            ) : (
              <circle className="sy-run" cx={dot.x} cy={dot.y} r={DOT} />
            )}
          </a>
        ))}
        <line className="sy-axis-line" x1={left} x2={right} y1={axis} y2={axis} />
        {ticks.map((t) => (
          <g key={t} className="sy-tick">
            <line x1={x(t)} x2={x(t)} y1={axis} y2={axis + 4} />
          </g>
        ))}
        {labels.map((each) => (
          <text key={each.t} className="sy-stall-tick" x={each.at} y={axis + 16} textAnchor={each.anchor}>
            {each.text}
          </text>
        ))}
        {target === undefined ? null : <circle className="sy-focus" cx={target.x} cy={target.y} r={(target.miss ? MISS : DOT) + 3} />}
      </svg>
      {target === undefined ? null : (
        <div className="sy-tip" style={{ left: tipX, top: Math.max(0, target.y - 12) }}>
          <strong>{requests(target.run.value)}</strong>
          <span>{runText(target.run, target.bands)}</span>
          <span className="sy-muted">Select the dot to go to its cell.</span>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {target === undefined ? "" : `${requests(target.run.value)}. ${runText(target.run, target.bands)}`}
      </p>
      {hidden === 0 ? null : <p className="sy-caption">The axis starts at {count(from)}, thus it does not show the {count(hidden)} runs with fewer failed requests.</p>}
    </div>
  );
}

function Table(props: { readonly modes: readonly ModeBands[] }): ReactElement {
  const { modes } = props;
  const first = modes[0]!;
  return (
    <div className="sy-scroll">
      <table className="sy-table sy-stall-table">
        <thead>
          <tr>
            <th>Mode</th>
            <th>CI run</th>
            <th className="num">Run</th>
            <th className="num">
              <span>Failed</span>
              <span>requests</span>
            </th>
            <th className="num">
              <span>Without the term</span>
              <span>{bandText(first.old)}</span>
            </th>
            <th className="num">
              <span>With the term</span>
              <span>{bandText(first.new)}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {modes.flatMap((bands) =>
            bands.runs.map((run) => (
              <tr key={`${run.mode} ${run.copy} ${run.index}`}>
                <td>
                  <a href={run.href}>
                    <code>{run.mode}</code>
                  </a>
                </td>
                <td>
                  <a href={`https://github.com/mark1russell7/systems/actions/runs/${run.run}`}>{`${run.run}`}</a>
                </td>
                <td className="num">{`${run.index} of ${run.of}`}</td>
                <td className="num">{count(run.value)}</td>
                {[run.overOld, run.overNew].map((over, side) => (
                  <td key={side} className="num">
                    {over === 0 ? (
                      "in"
                    ) : (
                      <span className="sy-note" data-status="critical">
                        <VerdictIcon decision="fails" />
                        {sideText(over)}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The chart of the stall band of SYS-48, with a switch to its table and a switch of the range of its axis. */
export default function StallBand(): ReactElement {
  const modes = stallBands();
  const [view, setView] = useState<"chart" | "table">("chart");
  const [range, setRange] = useState<Range>("whole");
  const misses = modes.flatMap((bands) => bands.runs).filter(outOfBand);
  const first = modes[0]!;
  return (
    <figure className="sy-stall-figure not-content">
      <div className="sy-row sy-stall-controls">
        <span className="sy-switch" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>
            Chart
          </button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
            Table
          </button>
        </span>
        {view === "chart" ? (
          <span className="sy-switch" role="group" aria-label="The range of the axis">
            {(Object.keys(RANGES) as Range[]).map((each) => (
              <button key={each} type="button" aria-pressed={range === each} onClick={() => setRange(each)}>
                {RANGES[each].label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {view === "chart" ? (
        <>
          <ul className="sy-legend" aria-label="Legend">
            <li>
              <svg width="18" height="12" aria-hidden="true">
                <rect className="sy-stall-old-fill" x="1" y="0" width="16" height="12" />
                <path className="sy-stall-old-edge" d="M17 0v12" />
              </svg>
              {`Without the backlog term, ${bandText(first.old)}, and its runs`}
            </li>
            <li>
              <svg width="18" height="12" aria-hidden="true">
                <rect className="sy-band-fill" x="1" y="0" width="16" height="12" />
                <path className="sy-band-edge" d="M17 0v12" />
              </svg>
              {`With the term (SYS-48), ${bandText(first.new)}, and its runs`}
            </li>
            <li>
              <svg width="12" height="12" aria-hidden="true">
                <circle className="sy-run" cx="6" cy="6" r="4" />
              </svg>
              Counted run in its band
            </li>
            {misses.length === 0 ? null : (
              <li>
                <svg width="14" height="14" aria-hidden="true">
                  <g className="sy-stall-miss">
                    <circle cx="7" cy="7" r="6" />
                    <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" />
                  </g>
                </svg>
                Counted run out of its band
              </li>
            )}
          </ul>
          <Chart modes={modes} range={range} />
        </>
      ) : (
        <Table modes={modes} />
      )}
      <figcaption>
        The failed requests of each counted run of the stall cells of C, on one axis. The bands are at the setting of 20 ms. The earlier copies are from the CI runs {STALL_RUNS.stall} and {STALL_RUNS.cilium}, and SYS-48 is from {STALL_RUNS.band}.
      </figcaption>
    </figure>
  );
}
