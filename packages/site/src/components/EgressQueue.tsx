/**
 * The egress queue. A program sends bursts of UDP datagrams, and a qdisc in front of the device holds
 * them. The netem qdisc has a rate, a delay and a limit in packets. The tbf qdisc has a rate, a bucket
 * and a limit in bytes. The page computes, in the browser, when each datagram leaves, which datagrams
 * drop, and who knows of a drop.
 *
 * The three lanes are the lenses of `../model/lenses/egress.ts`. The timeline, the player and the cards
 * are the parts of each page of lenses (`./Lens.tsx`). The chart of the datagrams shows the mechanism
 * under the lanes. It shows the time of each datagram in the queue, and what the queue holds.
 */
import { useMemo, useState, type ReactElement } from "react";
import { format, quantity, valueIn, type Quantity } from "@mark1russell7/quantity";
import { say, type Lane, type LaneNames } from "../model/lens.ts";
import { EGRESS_DEFAULTS, EGRESS_LENSES, EGRESS_PRESETS, UDP_HEADERS, egressModel, headlineOf, limitText, sec, type EgressLaneId, type EgressModel, type EgressSettings, type Qdisc, type TrainBurst } from "../model/lenses/egress.ts";
import { AmountKnob, Choice, CountKnob, LensKnobs, OptionalTimeKnob, TimeKnob, mtuKnob, type KnobRegistry } from "./Knobs.tsx";
import { EventsTable, LaneCard, PlayerBar, Timeline, TimelineLegend, axisOf, isLit, usePlayer, type Scale } from "./Lens.tsx";
import { useWidth } from "./Strip.tsx";
import Term from "./Term.tsx";

const LENSES = EGRESS_LENSES;
const ORDER: readonly EgressLaneId[] = ["program", "qdisc", "device"];
const namesOf = (id: string): LaneNames => LENSES[id as EgressLaneId].names;

const B = (value: number): Quantity => quantity(value, "B");
const ms = (value: number): Quantity => quantity(value, "ms");
const bytes = (amount: Quantity): number => Math.round(valueIn(amount, "B"));
const nanos = (time: Quantity): number => Math.round(valueIn(time, "ns"));

// ---------------------------------------------------------------------------------------------
// the bursts
// ---------------------------------------------------------------------------------------------

/** A uniform train: bursts of one size and one payload, from 0 s, one gap apart. */
interface Uniform {
  readonly bursts: number;
  readonly frames: number;
  readonly payload: Quantity;
  readonly gap: Quantity;
}

const gapOf = (train: readonly TrainBurst[]): Quantity | null => (train.length < 2 ? null : ms((nanos(train[1]!.at) - nanos(train[0]!.at)) / 1e6));

/** This function gives the uniform form of a train, or null when its bursts differ. */
const uniformOf = (train: readonly TrainBurst[]): Uniform | null => {
  const first = train[0];
  if (first === undefined || nanos(first.at) !== 0) return null;
  const gap = gapOf(train);
  const same = train.every(
    (burst, index) => burst.frames === first.frames && bytes(burst.payload) === bytes(first.payload) && (index === 0 || gap === null || nanos(burst.at) - nanos(train[index - 1]!.at) === nanos(gap)),
  );
  return same ? { bursts: train.length, frames: first.frames, payload: first.payload, gap: gap ?? ms(30) } : null;
};

const trainOf = (uniform: Uniform): TrainBurst[] => Array.from({ length: uniform.bursts }, (_, index) => ({ at: ms(index * valueIn(uniform.gap, "ms")), frames: uniform.frames, payload: uniform.payload }));

/** The control of the bursts: a count of bursts, the datagrams and the payload of each, and the gap between two. */
function TrainControl(props: { readonly value: readonly TrainBurst[]; readonly room: number; readonly onChange: (train: TrainBurst[]) => void }): ReactElement {
  const uniform = uniformOf(props.value);
  const first = props.value[0];
  const base: Uniform = uniform ?? { bursts: props.value.length, frames: first?.frames ?? 1, payload: first?.payload ?? B(1472), gap: gapOf(props.value) ?? ms(30) };
  const set = (patch: Partial<Uniform>): void => props.onChange(trainOf({ ...base, ...patch }));
  return (
    <div className="eq-train" role="group" aria-label="The bursts of the program">
      <CountKnob label="Bursts" value={base.bursts} min={1} max={4} onChange={(bursts) => set({ bursts })} />
      <CountKnob label="Datagrams in each burst" value={base.frames} min={1} max={40} onChange={(frames) => set({ frames })} />
      <AmountKnob label="Payload of each datagram" value={base.payload} unit="B" min={1} max={Math.max(props.room, 1)} step={1} onChange={(payload) => set({ payload })} />
      {base.bursts > 1 ? <TimeKnob label="From one burst to the next" value={base.gap} unit="ms" min={1} max={1000} onChange={(gap) => set({ gap })} /> : null}
      {uniform === null ? (
        <p className="sy-muted sy-wide eq-note">
          {props.value.map((burst, index) => `Burst ${index + 1}: ${burst.frames} × ${format(burst.payload)} at ${say(burst.at)}.`).join(" ")} A change gives each burst the same size.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// the knobs
// ---------------------------------------------------------------------------------------------

const QDISCS: ReadonlyArray<{ readonly id: Qdisc; readonly label: string }> = [
  { id: "netem", label: "netem" },
  { id: "tbf", label: "tbf" },
];

/** The controls of the knobs for the settings. tbf has no delay and no limit in packets, and netem has no bucket. */
const knobsOf = (settings: EgressSettings): KnobRegistry<EgressSettings> => {
  const common: KnobRegistry<EgressSettings> = {
    train: (value, set) => <TrainControl value={value} room={bytes(settings.mtu) - UDP_HEADERS} onChange={set} />,
    recverr: (value, set) => (
      <Choice
        label={<Term name="IP_RECVERR" />}
        name="IP_RECVERR"
        options={[
          { id: "off", label: "Off, the default" },
          { id: "on", label: "On" },
        ]}
        value={value ? "on" : "off"}
        onChange={(v) => set(v === "on")}
      />
    ),
    mtu: mtuKnob,
    qdisc: (value, set) => <Choice label={<Term name="qdisc">The qdisc</Term>} name="The qdisc" options={QDISCS} value={value} onChange={set} />,
    shapeRate: (value, set) => <AmountKnob label="The rate of the qdisc" value={value} unit="Mbit/s" min={0.1} max={1000} onChange={set} />,
  };
  if (settings.qdisc === "tbf") {
    return {
      ...common,
      bucket: (value, set) => <AmountKnob label={<Term name="tbf">The bucket of tbf</Term>} value={value} unit="B" min={100} max={1_000_000} onChange={set} />,
      byteLimit: (value, set) => <AmountKnob label="The limit of tbf" value={value} unit="B" min={1000} max={10_000_000} onChange={set} />,
    };
  }
  return {
    ...common,
    delay: (value, set) => <OptionalTimeKnob label={<Term name="netem">The delay of netem</Term>} name="The delay of netem" value={value} unit="ms" min={0.1} max={1000} onValue={100} onChange={set} />,
    packetLimit: (value, set) => (
      <AmountKnob label="The limit of netem, in packets" value={quantity(value, "count")} unit="count" min={1} max={10_000} onChange={(limit) => set(Math.max(1, Math.round(valueIn(limit, "count"))))} />
    ),
  };
};

// ---------------------------------------------------------------------------------------------
// the chart of the datagrams
// ---------------------------------------------------------------------------------------------

const niceStep = (span: number): number => {
  const raw = span / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * power).find((k) => k >= raw) ?? 10 * power;
};

const levelAt = (model: EgressModel, ns: number, tbfQueue: boolean): number => {
  let level = 0;
  for (const step of model.backlog) {
    if (step.t > ns) break;
    level = tbfQueue ? step.bytes : step.packets;
  }
  return level;
};

/**
 * The chart of the datagrams. The upper part has one row for each datagram. A sent datagram has a line
 * from its send to its departure, and a dot at the departure. A dropped datagram has a cross at its
 * send. The lower part is
 * what the qdisc holds at each time, with its limit. The cursor of the player crosses the two parts.
 */
function EgressChart(props: { readonly settings: EgressSettings; readonly now: number; readonly label: string }): ReactElement {
  const [ref, width] = useWidth();
  const { settings, now } = props;
  const model = egressModel(settings);
  const tbfQueue = settings.qdisc === "tbf";
  const end = Math.max(model.end, 1e6) * 1.08;
  const narrow = width < 560;
  const left = narrow ? 34 : 48;
  const right = 14;
  const plot = Math.max(width - left - right, 40);
  const X = (ns: number): number => left + plot * Math.min(Math.max(ns / end, 0), 1);
  const count = model.frames.length;
  const row = Math.min(9, Math.max(2, 200 / Math.max(count, 1)));
  const top = 28;
  const framesBottom = top + row * count;
  const backTop = framesBottom + 44;
  const backHeight = 92;
  const axisY = backTop + backHeight;
  const height = axisY + 26;
  const nowNs = now * 1e9;
  const cursor = Number.isFinite(nowNs) ? X(nowNs) : null;

  const limit = tbfQueue ? bytes(settings.byteLimit) : settings.packetLimit;
  const peak = Math.max(tbfQueue ? model.peak.bytes : model.peak.packets, 1);
  const showLimit = limit <= peak * 3;
  const ceiling = (showLimit ? Math.max(peak, limit) : peak) * 1.12;
  const Y = (level: number): number => axisY - (backHeight * level) / ceiling;
  const steps = model.backlog.map((step) => ({ t: step.t, level: tbfQueue ? step.bytes : step.packets }));
  const path = steps.reduce((d, step, index) => (index === 0 ? `M ${X(step.t)} ${Y(step.level)}` : `${d} H ${X(step.t)} V ${Y(step.level)}`), "") + ` H ${X(end)}`;
  const area = `${path} V ${axisY} H ${X(0)} Z`;
  const unit = (level: number): string => (tbfQueue ? format(B(level)) : `${level} packets`);

  const step = niceStep(end / 1e9);
  const ticks = Array.from({ length: Math.floor(end / 1e9 / step) + 1 }, (_, n) => n * step);
  const held = Number.isFinite(nowNs) ? levelAt(model, nowNs, tbfQueue) : null;
  // the first row of each burst, for the labels of the rows
  const starts = model.frames.filter((frame, index) => index === 0 || model.frames[index - 1]!.burst !== frame.burst);

  return (
    <figure className="eq-chart">
      <div ref={ref} className="rp-timeline">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.label}>
          <text className="eq-panel" x={left} y={14}>
            Each datagram, from its send to its departure
          </text>
          {ticks.map((t) => (
            <line key={`g${t}`} className="rp-grid" x1={X(t * 1e9)} x2={X(t * 1e9)} y1={top - 4} y2={axisY} />
          ))}
          {starts.map((frame) => (
            <text key={`b${frame.n}`} className="rp-tick" x={left - 6} y={top + row * (frame.n - 1) + Math.min(row, 9) - 1} textAnchor="end">
              {frame.n}
            </text>
          ))}
          {model.frames.map((frame) => {
            const y = top + row * (frame.n - 1) + row / 2;
            const outcome = frame.outcome;
            const sent = outcome.kind === "sent";
            const gone = sent && outcome.at <= nowNs;
            const tip = sent
              ? `Datagram ${frame.n}, burst ${frame.burst}: sent at ${say(sec(frame.at))}, ${outcome.ahead} ahead of it, leaves at ${say(sec(outcome.at))}`
              : `Datagram ${frame.n}, burst ${frame.burst}: dropped at ${say(sec(frame.at))}, ${outcome.why === "size" ? "longer than the bucket" : "the queue is full"}`;
            return (
              <g key={frame.n} className={sent ? "eq-frame" : "eq-frame eq-drop"} opacity={frame.at <= nowNs ? 1 : 0.3}>
                <title>{tip}</title>
                <rect className="eq-hit" x={left} y={y - row / 2} width={plot} height={row} />
                {sent ? (
                  <>
                    <line className="eq-wait" x1={X(frame.at)} x2={X(outcome.at)} y1={y} y2={y} />
                    <circle className={gone ? "eq-leave" : "eq-leave eq-later"} cx={X(outcome.at)} cy={y} r={Math.max(1.5, Math.min(row / 2, 3.5))} />
                  </>
                ) : (
                  <path className="eq-cross" d={`M ${X(frame.at) - 3} ${y - 3} L ${X(frame.at) + 3} ${y + 3} M ${X(frame.at) - 3} ${y + 3} L ${X(frame.at) + 3} ${y - 3}`} />
                )}
              </g>
            );
          })}

          <text className="eq-panel" x={left} y={backTop - 14}>
            {`What the qdisc holds, in ${tbfQueue ? "bytes" : "packets"}${showLimit ? "" : `. Its limit of ${limitText(settings)} is above the chart`}`}
          </text>
          <path className="eq-area" d={area} />
          <path className="eq-level" d={path} />
          {showLimit ? (
            <g>
              <line className="eq-limit" x1={left} x2={left + plot} y1={Y(limit)} y2={Y(limit)} />
              <text className="eq-limit-label" x={left + plot} y={Y(limit) - 4} textAnchor="end">
                {`limit ${unit(limit)}`}
              </text>
            </g>
          ) : null}
          <line className="rp-lane-line" x1={left} x2={left + plot} y1={axisY} y2={axisY} />
          {ticks.map((t) => (
            <text key={`t${t}`} className="rp-tick" x={X(t * 1e9)} y={height - 8} textAnchor={t === 0 ? "start" : "middle"}>
              {say(quantity(t, "s"))}
            </text>
          ))}
          {cursor === null ? null : (
            <g>
              <line className="rp-cursor" x1={cursor} x2={cursor} y1={top - 4} y2={axisY} />
              {held === null ? null : (
                <text className="rp-cursor-label" x={Math.min(Math.max(cursor + 6, left), width - right - 90)} y={backTop + 2}>
                  {`holds ${unit(held)}`}
                </text>
              )}
            </g>
          )}
        </svg>
      </div>
      <ul className="rp-legend" aria-label="Legend of the chart">
        <li>
          <span className="eq-key eq-key-wait" /> in the queue
        </li>
        <li>
          <span className="eq-key eq-key-leave" /> leaves the qdisc
        </li>
        <li>
          <span className="eq-key eq-key-drop" aria-hidden="true">
            ✕
          </span>{" "}
          dropped
        </li>
        <li>
          <span className="eq-key eq-key-limit" /> the limit of the queue
        </li>
      </ul>
    </figure>
  );
}

/** The table of the datagrams: the view of the chart for a reader who does not see it. */
function FramesTable(props: { readonly model: EgressModel }): ReactElement {
  return (
    <div className="sy-scroll">
      <table className="sy-table">
        <caption>Each datagram at the qdisc</caption>
        <thead>
          <tr>
            <th scope="col">Datagram</th>
            <th scope="col">Burst</th>
            <th scope="col">Frame</th>
            <th scope="col">Sent at</th>
            <th scope="col">Ahead of it</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {props.model.frames.map((frame) => (
            <tr key={frame.n}>
              <td>{frame.n}</td>
              <td>{frame.burst}</td>
              <td>{format(B(frame.length))}</td>
              <td>{say(sec(frame.at))}</td>
              <td>{frame.outcome.ahead}</td>
              <td>{frame.outcome.kind === "sent" ? `leaves at ${say(sec(frame.outcome.at))}` : frame.outcome.why === "size" ? "dropped, longer than the bucket" : "dropped, the queue is full"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------------------------

export default function EgressQueue(): ReactElement {
  const [settings, setSettings] = useState<EgressSettings>(EGRESS_DEFAULTS);
  const [preset, setPreset] = useState<string | null>("defaults");
  const [scale, setScale] = useState<Scale>("linear");
  const [table, setTable] = useState(false);
  const lanes = useMemo(() => ORDER.flatMap((id): Array<Lane<EgressLaneId>> => LENSES[id].lanes(settings)), [settings]);
  const model = egressModel(settings);
  // the axis holds the whole story: the last departure or the last send
  const least = useMemo(() => sec(Math.max(model.end, 1e6)), [model.end]);
  const player = usePlayer();
  const axis = useMemo(() => axisOf(lanes, null, scale, least), [lanes, scale, least]);
  const registry = knobsOf(settings);

  const change = (next: Partial<EgressSettings>): void => {
    setSettings((now) => ({ ...now, ...next }));
    setPreset(null);
  };
  const load = (id: string): void => {
    const found = EGRESS_PRESETS.find((p) => p.id === id);
    if (found === undefined) return;
    setSettings(found.settings);
    setPreset(id);
    player.restart();
  };

  const headline = headlineOf(settings);
  const note = EGRESS_PRESETS.find((p) => p.id === preset)?.note ?? null;
  const first = lanes.find((lane) => lane.verdict === "detects")?.id ?? null;
  const last = model.bursts.at(-1);
  const span = last === undefined || nanos(last.at) === 0 ? null : last.at;
  const now = player.progress >= 1 ? Number.POSITIVE_INFINITY : axis.t(player.progress);

  return (
    <div className="rp not-content">
      <section className="sy-frame rp-stage" aria-label="The egress queue">
        <header className="sy-head">
          <div className="sy-title">
            <strong>Which datagrams leave, and who knows of a drop?</strong>
          </div>
          <div className="sy-row" role="group" aria-label="Presets">
            {EGRESS_PRESETS.map((p) => (
              <button key={p.id} type="button" className="sy-button" aria-pressed={preset === p.id} onClick={() => load(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </header>

        <div className="rp-headline" aria-live="polite">
          <p>{headline}</p>
          {note === null ? null : <p className="sy-muted">{note}</p>}
        </div>

        <PlayerBar player={player} scale={scale} setScale={setScale} table={table} setTable={setTable} />

        <div className="sy-body">
          <Timeline
            lanes={lanes}
            names={namesOf}
            fault={{ label: span === null ? `${model.frames.length} datagrams at 0 s` : `${model.bursts.length} bursts, to ${say(span)}`, start: ms(0), end: span }}
            scale={scale}
            progress={player.progress}
            least={least}
            label={`${headline} The timeline shows the program, the qdisc and the device.`}
          />
          <TimelineLegend band="the lane knows, at this time" />
          <p className="sy-caption">
            {scale === "log" ? "The axis is logarithmic, thus the first millisecond and the last frame both fit." : "The axis is linear, up to the last frame."}
          </p>
          <EgressChart settings={settings} now={now} label={`The chart of the ${model.frames.length} datagrams. ${headline}`} />
          {table ? (
            <>
              <EventsTable lanes={lanes} names={namesOf} heading="Lane" />
              <FramesTable model={model} />
            </>
          ) : null}
        </div>
      </section>

      <ol className="rp-stack" aria-label="The program, the qdisc and the device">
        {lanes.map((lane) => (
          <li key={lane.id}>
            <LaneCard lane={lane} names={namesOf(lane.id)} lit={isLit(lane, axis, player.progress)} first={first === lane.id}>
              <LensKnobs registry={registry} knobs={LENSES[lane.id].knobs} settings={settings} change={change} />
            </LaneCard>
          </li>
        ))}
      </ol>
    </div>
  );
}
