/**
 * The path of one request. A program sends one request, and a fault starts on the path. The page
 * computes, in the browser, when each layer finds the fault: the program, the socket, TCP,
 * Kubernetes and the NIC. The reader sets the knobs of each layer and selects the fault.
 *
 * Each layer is a lens of `../model/lenses/`, and the model `../model/request.ts` puts the five lanes on
 * one path. The timeline, the player and the cards are the parts of each page of lenses (`./Lens.tsx`),
 * and the knobs come from one registry (`PATH_KNOBS`). The timeline plays the story: a cursor moves
 * through the time, and each layer lights when it finds the fault.
 */
import { useMemo, useState, type ReactElement } from "react";
import { quantity, valueIn } from "@mark1russell7/quantity";
import { say, type LaneNames } from "../model/lens.ts";
import { DATAPLANES, DEFAULTS, PRESETS, lensOf, requestPath, type Fault, type LayerId, type PathResult, type Settings } from "../model/request.ts";
import { Choice, CountKnob, LensKnobs, OptionalTimeKnob, TimeKnob, type KnobRegistry } from "./Knobs.tsx";
import { EventsTable, LaneCard, PlayerBar, Timeline, TimelineLegend, axisOf, isLit, scaleCaption, usePlayer, type FaultSpan, type Scale } from "./Lens.tsx";
import Term, { type TermName } from "./Term.tsx";

export { playerStep, type PlayerAction, type PlayerState } from "./Lens.tsx";

const FAULTS: ReadonlyArray<{ readonly id: Fault; readonly label: string; readonly term: TermName }> = [
  { id: "blackhole", label: "Black hole", term: "black hole" },
  { id: "stall", label: "Stalled peer", term: "stall" },
  { id: "partition", label: "Partition", term: "partition" },
];

const namesOf = (id: string): LaneNames => lensOf(id as LayerId).names;

/** The control of each knob of the path, by its name. Each lens shows the knobs that it names. */
export const PATH_KNOBS: KnobRegistry<Settings> = {
  // the program
  timeout: (value, set) => <OptionalTimeKnob label={<Term name="deadline">Deadline</Term>} name="Deadline" value={value} unit="ms" min={100} max={120_000} onValue={10_000} onChange={set} />,
  retries: (value, set) => <CountKnob label={<Term name="retry">Retries</Term>} value={value} min={0} max={5} onChange={set} />,
  backoff: (value, set) => <TimeKnob label="First wait between tries" value={value} unit="ms" min={10} max={5000} onChange={set} />,
  // TCP
  keepaliveOn: (value, set) => (
    <Choice
      label={<Term name="SO_KEEPALIVE" />}
      name="SO_KEEPALIVE"
      options={[
        { id: "off", label: "Off" },
        { id: "on", label: "On" },
      ]}
      value={value ? "on" : "off"}
      onChange={(v) => set(v === "on")}
    />
  ),
  keepidle: (value, set) => <TimeKnob label={<Term name="keepalive">Keepalive idle time</Term>} value={value} unit="s" min={1} max={7200} onChange={set} />,
  keepintvl: (value, set) => <TimeKnob label="Probe interval" value={value} unit="s" min={1} max={75} onChange={set} />,
  keepcnt: (value, set) => <CountKnob label="Probes" value={value} min={1} max={9} onChange={set} />,
  retries2: (value, set) => <CountKnob label={<Term name="tcp_retries2" />} value={value} min={1} max={15} onChange={set} />,
  userTimeout: (value, set) => <OptionalTimeKnob label={<Term name="TCP_USER_TIMEOUT" />} name="TCP_USER_TIMEOUT" value={value} unit="ms" min={1000} max={1_800_000} onValue={30_000} onChange={set} />,
  rtt: (value, set) => <TimeKnob label="Round trip" value={value} unit="ms" min={0.1} max={300} onChange={set} />,
  hz: (value, set) => <Choice label={<Term name="HZ">Kernel clock, HZ</Term>} name="Kernel clock" options={[100, 250, 300, 1000].map((hz) => ({ id: hz, label: String(hz) }))} value={value} onChange={set} />,
  // Kubernetes
  dataplane: (value, set) => <Choice label={<Term name="kube-proxy">Dataplane</Term>} name="Dataplane" options={DATAPLANES.map((id) => ({ id, label: id }))} value={value} onChange={set} />,
  period: (value, set) => <TimeKnob label={<Term name="readiness probe">Probe period</Term>} value={value} unit="s" min={1} max={60} onChange={set} />,
  threshold: (value, set) => <CountKnob label="Failures before not ready" value={value} min={1} max={10} onChange={set} />,
  probeTimeout: (value, set) => <TimeKnob label="Probe timeout" value={value} unit="s" min={1} max={30} onChange={set} />,
  ctEstablished: (value, set) => <TimeKnob label={<Term name="conntrack">conntrack timeout</Term>} value={value} unit="s" min={60} max={432_000} onChange={set} />,
  // the NIC
  txqueuelen: (value, set) => <CountKnob label={<Term name="txqueuelen" />} value={value} min={10} max={10_000} onChange={set} />,
  rate: (value, set) => (
    <Choice label="Link rate" name="Link rate" options={[1, 10, 25, 100].map((rate) => ({ id: rate, label: `${rate} Gbit/s` }))} value={valueIn(value, "Gbit/s")} onChange={(rate) => set(quantity(rate, "Gbit/s"))} />
  ),
  mtu: (value, set) => <Choice label={<Term name="MTU" />} name="MTU" options={[1500, 9000].map((mtu) => ({ id: mtu, label: `${mtu} B` }))} value={valueIn(value, "B")} onChange={(mtu) => set(quantity(mtu, "B"))} />,
};

/** This function gives the fault of the timeline: from 0 to the heal of a partition, or to the end of the axis. */
const faultSpanOf = (settings: Settings, result: PathResult): FaultSpan => ({
  label: result.heal === null ? (settings.fault === "stall" ? "The peer stalls at 0 s" : "The black hole starts at 0 s") : `Partition, healed at ${say(result.heal)}`,
  end: result.heal,
});

export default function RequestPath(): ReactElement {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [preset, setPreset] = useState<string | null>("defaults");
  const [scale, setScale] = useState<Scale>("log");
  const [table, setTable] = useState(false);
  const result = useMemo(() => requestPath(settings), [settings]);
  const player = usePlayer();
  const axis = useMemo(() => axisOf(result.layers, result.heal, scale), [result, scale]);

  const change = (next: Partial<Settings>): void => {
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

  const note = PRESETS.find((p) => p.id === preset)?.note ?? null;

  return (
    <div className="rp not-content">
      <section className="sy-frame rp-stage" aria-label="The path of one request">
        <header className="sy-head">
          <div className="sy-title">
            <strong>Who knows first?</strong>
          </div>
          <div className="sy-row" role="group" aria-label="Presets">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" className="sy-button" aria-pressed={preset === p.id} onClick={() => load(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </header>

        <div className="rp-controls">
          <div className="sy-knob">
            <span>The fault</span>
            <span className="sy-switch" role="group" aria-label="The fault">
              {FAULTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={settings.fault === f.id}
                  onClick={() => {
                    change({ fault: f.id });
                    player.restart();
                  }}
                >
                  {f.label}
                </button>
              ))}
            </span>
          </div>
          <div className="sy-knob">
            <span>The request</span>
            <span className="sy-switch" role="group" aria-label="The request">
              <button
                type="button"
                aria-pressed={settings.inFlight}
                onClick={() => {
                  change({ inFlight: true });
                  player.restart();
                }}
              >
                In flight
              </button>
              <button
                type="button"
                aria-pressed={!settings.inFlight}
                onClick={() => {
                  change({ inFlight: false });
                  player.restart();
                }}
              >
                Idle connection
              </button>
            </span>
          </div>
          {settings.fault === "partition" ? <TimeKnob label="The partition lasts" value={settings.heal} unit="s" min={0.2} max={120} onChange={(heal) => change({ heal })} /> : null}
        </div>

        <div className="rp-headline" aria-live="polite">
          <p>{result.headline}</p>
          {note === null ? null : <p className="sy-muted">{note}</p>}
        </div>

        <PlayerBar player={player} scale={scale} setScale={setScale} table={table} setTable={setTable} />

        <div className="sy-body">
          <Timeline
            lanes={result.layers}
            names={namesOf}
            fault={faultSpanOf(settings, result)}
            scale={scale}
            progress={player.progress}
            label={`${result.headline} The timeline shows each layer from the program to the NIC.`}
          />
          <TimelineLegend band="the layer knows, in this band" />
          <p className="sy-caption">{scaleCaption(scale)}</p>
          {table ? <EventsTable lanes={result.layers} names={namesOf} heading="Layer" /> : null}
        </div>
      </section>

      <ol className="rp-stack" aria-label="The layers, from the program down to the NIC">
        {result.layers.map((layer) => (
          <li key={layer.id}>
            <LaneCard lane={layer} names={namesOf(layer.id)} lit={isLit(layer, axis, player.progress)} first={result.first?.layer === layer.id}>
              <LensKnobs registry={PATH_KNOBS} knobs={lensOf(layer.id).knobs} settings={settings} change={change} />
            </LaneCard>
          </li>
        ))}
      </ol>
    </div>
  );
}
