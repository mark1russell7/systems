/**
 * The port range. A client connects again and again from a small `ip_local_port_range`, and each
 * closed connection holds its port for a time. The page computes, in the browser, when a connect
 * gets EADDRNOTAVAIL and when the first port is free again. The reader sets the range, the gap between
 * two connects, and how each connection closes.
 *
 * The two lanes are the lenses of `../model/lenses/ports.ts`. The timeline, the player and the cards
 * are the parts of each page of lenses (`./Lens.tsx`). The controls of the round trip and of HZ are
 * the controls of the path of one request (`./Knobs.tsx`). Thus a page with both shows one of each.
 */
import { useMemo, useState, type ReactElement } from "react";
import { format, quantity } from "@mark1russell7/quantity";
import { say, sayBand, type LaneNames } from "../model/lens.ts";
import { PORT_DEFAULTS, PORT_LENSES, portModel, type Close, type PortLaneId, type PortSettings } from "../model/lenses/ports.ts";
import { s } from "../model/path.ts";
import { Choice, CountKnob, LensKnobs, TimeKnob, hzKnob, rttKnob, type KnobRegistry } from "./Knobs.tsx";
import { EventsTable, LaneCard, PlayerBar, Timeline, TimelineLegend, axisOf, isLit, scaleCaption, usePlayer, type Scale } from "./Lens.tsx";
import Term from "./Term.tsx";

const LENSES = PORT_LENSES;
const ORDER: readonly PortLaneId[] = ["search", "hold"];
const namesOf = (id: string): LaneNames => LENSES[id as PortLaneId].names;

const CLOSES: ReadonlyArray<{ readonly id: Close; readonly label: string }> = [
  { id: "open", label: "Stays open" },
  { id: "client", label: "Client first" },
  { id: "target", label: "Target first" },
  { id: "reset", label: "Reset" },
];

/** The control of each knob of the port range, by its name. */
export const PORT_KNOBS: KnobRegistry<PortSettings> = {
  portRange: (value, set) => (
    <Choice
      label={<Term name="ip_local_port_range">Ports in the range</Term>}
      name="Ports in the range"
      options={[3, 4, 5, 16, 1024, 28232].map((n) => ({ id: n, label: format(quantity(n, "count")) }))}
      value={value}
      onChange={set}
    />
  ),
  destinations: (value, set) => <CountKnob label="Destinations" value={value} min={1} max={8} onChange={set} />,
  connectGap: (value, set) => <TimeKnob label="One connect each" value={value} unit="ms" min={0.01} max={60_000} onChange={set} />,
  close: (value, set) => <Choice label="Each connection" name="Each connection" options={CLOSES} value={value} onChange={set} />,
  twReuse: (value, set) => (
    <Choice
      label={<Term name="tcp_tw_reuse" />}
      name="tcp_tw_reuse"
      options={[
        { id: 2, label: "2, loopback" },
        { id: 1, label: "1" },
      ]}
      value={value ? 1 : 2}
      onChange={(v) => set(v === 1)}
    />
  ),
  reuseDelay: (value, set) => <TimeKnob label="tcp_tw_reuse_delay" value={value} unit="ms" min={1} max={60_000} onChange={set} />,
  finAckLoss: (value, set) => (
    <Choice
      label="The ACK of the FIN of the client"
      name="The ACK of the FIN of the client"
      options={[
        { id: "pass", label: "Arrives" },
        { id: "drop", label: "Drops once" },
      ]}
      value={value ? "drop" : "pass"}
      onChange={(v) => set(v === "drop")}
    />
  ),
  rtt: rttKnob,
  hz: hzKnob,
};

/** The presets of the page: the defaults of Linux, and the settings of the cells of the harness. */
const PRESETS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly settings: PortSettings; readonly note: string | null }> = [
  { id: "defaults", label: "Linux defaults", settings: PORT_DEFAULTS, note: null },
  { id: "even", label: "16 ports", settings: { ...PORT_DEFAULTS, portRange: 16, close: "open" }, note: "The settings of the cell PR.1: each connection stays open until the error." },
  { id: "odd", label: "5 ports", settings: { ...PORT_DEFAULTS, portRange: 5, close: "open" }, note: "The settings of the cell PR.3: an odd range gives 4 or 5 connects." },
  { id: "reuse", label: "tcp_tw_reuse 1", settings: { ...PORT_DEFAULTS, portRange: 4, twReuse: true, hz: 250 }, note: "The settings of the cell PR.6." },
  { id: "target", label: "Target first", settings: { ...PORT_DEFAULTS, portRange: 4, close: "target", hz: 250 }, note: "The settings of the cell PR.7." },
  { id: "lost", label: "A lost ACK", settings: { ...PORT_DEFAULTS, portRange: 4, close: "target", finAckLoss: true, connectGap: s(0.05), hz: 250 }, note: "The settings of the cell PR.8, with one connect each 50 ms." },
];

/** This function gives the headline of the page: when the first connect fails, or why no connect fails. */
const headlineOf = (settings: PortSettings): string => {
  const model = portModel(settings);
  const { error, hold, search } = model;
  const cap = search.counts.map((n) => format(quantity(n, "count"))).join(" or ");
  if (error !== null) {
    const kept = hold.band === null ? "until its close" : `for ${sayBand(hold.band)}`;
    return `At ${sayBand(error)}, a connect gets EADDRNOTAVAIL. Each destination gets ${cap} ports, and each port stays held ${kept}.`;
  }
  return `No connect fails. A port comes back after ${hold.band === null ? "an unknown time" : sayBand(hold.band)}, before the connects of one destination use the ${cap} ports.`;
};

export default function PortRange(): ReactElement {
  const [settings, setSettings] = useState<PortSettings>(PORT_DEFAULTS);
  const [preset, setPreset] = useState<string | null>("defaults");
  const [scale, setScale] = useState<Scale>("log");
  const [table, setTable] = useState(false);
  const lanes = useMemo(() => ORDER.flatMap((id) => LENSES[id].lanes(settings)), [settings]);
  const player = usePlayer();
  const axis = useMemo(() => axisOf(lanes, null, scale), [lanes, scale]);

  const change = (next: Partial<PortSettings>): void => {
    setSettings((now) => ({ ...now, ...next }));
    setPreset(null);
  };
  const load = (id: string): void => {
    const found = PRESETS.find((p) => p.id === id);
    if (found === undefined) return;
    setSettings(found.settings);
    setPreset(id);
    player.restart();
  };

  const headline = headlineOf(settings);
  const note = PRESETS.find((p) => p.id === preset)?.note ?? null;
  const first = lanes.find((lane) => lane.verdict === "detects")?.id ?? null;

  return (
    <div className="rp not-content">
      <section className="sy-frame rp-stage" aria-label="The port range">
        <header className="sy-head">
          <div className="sy-title">
            <strong>When does the range run out?</strong>
          </div>
          <div className="sy-row" role="group" aria-label="Presets">
            {PRESETS.map((p) => (
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
            fault={{ label: `One connect each ${say(settings.connectGap)}, from 0 s`, end: null }}
            scale={scale}
            progress={player.progress}
            label={`${headline} The timeline shows the search for a port and the held port.`}
          />
          <TimelineLegend band="the lane acts, in this band" />
          <p className="sy-caption">{scaleCaption(scale)}</p>
          {table ? <EventsTable lanes={lanes} names={namesOf} heading="Lane" /> : null}
        </div>
      </section>

      <ol className="rp-stack" aria-label="The search for a port and the held port">
        {lanes.map((lane) => (
          <li key={lane.id}>
            <LaneCard lane={lane} names={namesOf(lane.id)} lit={isLit(lane, axis, player.progress)} first={first === lane.id}>
              <LensKnobs registry={PORT_KNOBS} knobs={LENSES[lane.id].knobs} settings={settings} change={change} />
            </LaneCard>
          </li>
        ))}
      </ol>
    </div>
  );
}
