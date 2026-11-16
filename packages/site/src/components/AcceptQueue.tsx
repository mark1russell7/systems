/**
 * The accept queue. A program listens and does not accept, and new connects come to its port. The
 * page computes, in the browser, how many connections a full queue holds, and what each overflow does:
 * a SYN that drops meets the SYN ladder of the client, and a final ACK that drops leaves a client that
 * thinks that it is connected. The reader sets the backlog, the connects, the accept of the program and
 * the send of the client.
 *
 * The three lanes are the lenses of `../model/lenses/accept-queue.ts`. The timeline, the player and the
 * cards are the parts of each page of lenses (`./Lens.tsx`). The controls of the round trip and of HZ
 * are the shared controls of the kernel (`./Knobs.tsx`).
 */
import { useMemo, useState, type ReactElement } from "react";
import { format, quantity } from "@mark1russell7/quantity";
import { say, sayBand, type LaneNames } from "../model/lens.ts";
import { QUEUE_DEFAULTS, queueLenses, queueModel, type Arrival, type Listener, type QueueLaneId, type QueueSettings, type Send } from "../model/lenses/accept-queue.ts";
import { ms, s } from "../model/path.ts";
import { Choice, CountKnob, LensKnobs, TimeKnob, hzKnob, rttKnob, type KnobRegistry } from "./Knobs.tsx";
import { EventsTable, LaneCard, PlayerBar, Timeline, TimelineLegend, axisOf, isLit, scaleCaption, usePlayer, type Scale } from "./Lens.tsx";
import Term from "./Term.tsx";

const LENSES = queueLenses();
const ORDER: readonly QueueLaneId[] = ["queue", "syn", "ack"];
const namesOf = (id: string): LaneNames => LENSES[id as QueueLaneId].names;
const n = (value: number): string => format(quantity(value, "count"));
const counts = (values: readonly number[]): ReadonlyArray<{ readonly id: number; readonly label: string }> => values.map((value) => ({ id: value, label: n(value) }));

const LISTENERS: ReadonlyArray<{ readonly id: Listener; readonly label: string }> = [
  { id: "native", label: "The backlog as given" },
  { id: "node", label: "Node: 511 for 0" },
];
const ARRIVALS: ReadonlyArray<{ readonly id: Arrival; readonly label: string }> = [
  { id: "once", label: "At once" },
  { id: "turn", label: "One each round trip" },
];
const SENDS: ReadonlyArray<{ readonly id: Send; readonly label: string }> = [
  { id: "never", label: "Nothing" },
  { id: "connected", label: "At once" },
  { id: "later", label: "Later" },
];

/** The control of each knob of the accept queue, by its name. */
export const QUEUE_KNOBS: KnobRegistry<QueueSettings> = {
  listener: (value, set) => <Choice label="listen(2) gets" name="listen(2) gets" options={LISTENERS} value={value} onChange={set} />,
  backlog: (value, set) => <Choice label={<Term name="backlog">Backlog</Term>} name="Backlog" options={counts([0, 1, 4, 8, 128, 511, 4096])} value={value} onChange={set} />,
  somaxconn: (value, set) => <Choice label={<Term name="somaxconn" />} name="somaxconn" options={counts([8, 128, 4096])} value={value} onChange={set} />,
  queued: (value, set) => <Choice label="In the queue at 0 s" name="In the queue at 0 s" options={counts([0, 1, 2, 4, 5, 8, 512])} value={value} onChange={set} />,
  connections: (value, set) => <Choice label="New connects" name="New connects" options={counts([1, 2, 3, 7, 11, 514])} value={value} onChange={set} />,
  arrival: (value, set) => <Choice label="The connects come" name="The connects come" options={ARRIVALS} value={value} onChange={set} />,
  accept: (value, set) => (
    <Choice
      label="The program accepts"
      name="The program accepts"
      options={[
        { id: "never", label: "Never" },
        { id: "at", label: "At a time" },
      ]}
      value={value ? "at" : "never"}
      onChange={(v) => set(v === "at")}
    />
  ),
  acceptAt: (value, set) => <TimeKnob label="The accept at" value={value} unit="s" min={0.05} max={200} onChange={set} />,
  synRetries: (value, set) => <CountKnob label={<Term name="tcp_syn_retries" />} value={value} min={1} max={8} onChange={set} />,
  abort: (value, set) => (
    <Choice
      label={<Term name="tcp_abort_on_overflow" />}
      name="tcp_abort_on_overflow"
      options={[
        { id: 0, label: "0" },
        { id: 1, label: "1" },
      ]}
      value={value ? 1 : 0}
      onChange={(v) => set(v === 1)}
    />
  ),
  synackRetries: (value, set) => <CountKnob label={<Term name="tcp_synack_retries" />} value={value} min={1} max={7} onChange={set} />,
  send: (value, set) => <Choice label="The client sends" name="The client sends" options={SENDS} value={value} onChange={set} />,
  sendAt: (value, set) => <TimeKnob label="The later send at" value={value} unit="s" min={0.05} max={300} onChange={set} />,
  rtt: rttKnob,
  hz: hzKnob,
};

/** The presets of the page: the settings of the cells of the harness. */
const PRESETS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly settings: QueueSettings; readonly note: string | null }> = [
  { id: "half", label: "Half open", settings: QUEUE_DEFAULTS, note: "The settings of the cell AQ.5: a queue of 5 with 4 in it, and a burst of three connects. The client sends nothing." },
  { id: "busy", label: "Busy", settings: { ...QUEUE_DEFAULTS, send: "connected" }, note: "The busy connection of the cell AQ.5: it sends at once, and its retransmissions meet the expiry." },
  { id: "quiet", label: "Quiet", settings: { ...QUEUE_DEFAULTS, send: "later", sendAt: s(70) }, note: "The quiet connection of the cell AQ.5: it sends at 70 s, after the expiry." },
  { id: "abort", label: "tcp_abort_on_overflow 1", settings: { ...QUEUE_DEFAULTS, abort: true }, note: "The settings of the cell AQ.6." },
  { id: "drain", label: "Drain", settings: { ...QUEUE_DEFAULTS, accept: true, acceptAt: ms(2500) }, note: "The settings of the cell AQ.7: the program accepts at 2.5 s." },
  { id: "syn", label: "SYN drop", settings: { ...QUEUE_DEFAULTS, backlog: 1, queued: 2, connections: 1 }, note: "The settings of the cell AQ.4: the queue is full before the connect." },
  { id: "count", label: "The count", settings: { ...QUEUE_DEFAULTS, queued: 0, connections: 7, arrival: "turn" }, note: "The settings of the cell AQ.1: 7 connects, one each round trip." },
  {
    id: "node",
    label: "Node, backlog 0",
    settings: { ...QUEUE_DEFAULTS, listener: "node", backlog: 0, queued: 0, connections: 514, arrival: "turn" },
    note: "The settings of the cell AQ.10: Node gives listen(2) 511 for a backlog of 0.",
  },
];

/** This function gives the headline of the page: the first overflow and its end, or why no connect overflows. */
const headlineOf = (settings: QueueSettings): string => {
  const model = queueModel(settings);
  const { held, first, syn, ack } = model;
  const count = `The queue holds ${n(held)} connections.`;
  if (first === null) return `${count} Each new connect finds a place.`;
  if (first.what === "syn" && syn !== null) {
    const when = syn.end.band === null ? say(s(syn.end.at)) : sayBand(syn.end.band);
    const end = syn.end.kind === "timeout" ? `The connect ends with ETIMEDOUT at ${when}.` : `A later SYN finds a place at ${when}.`;
    return `${count} At ${say(s(first.at))}, the SYN of connect ${first.connection} drops with no answer. ${end}`;
  }
  if (ack !== null) {
    const when = ack.end.band === null ? (ack.end.at === null ? "" : say(s(ack.end.at))) : sayBand(ack.end.band);
    const end =
      ack.end.kind === "reset" ? `The client gets ECONNRESET at ${when}.` : ack.end.kind === "connected" ? `It finds a place at ${when}.` : "The client stays connected to nothing.";
    return `${count} At ${say(s(first.at))}, the final ACK of connect ${first.connection} overflows, but the client is connected. ${end}`;
  }
  return count;
};

export default function AcceptQueue(): ReactElement {
  const [settings, setSettings] = useState<QueueSettings>(QUEUE_DEFAULTS);
  const [preset, setPreset] = useState<string | null>("half");
  const [scale, setScale] = useState<Scale>("log");
  const [table, setTable] = useState(false);
  const lanes = useMemo(() => ORDER.flatMap((id) => LENSES[id].lanes(settings)), [settings]);
  const player = usePlayer();
  const faultEnd = settings.accept ? settings.acceptAt : null;
  const axis = useMemo(() => axisOf(lanes, faultEnd, scale), [lanes, faultEnd, scale]);

  const change = (next: Partial<QueueSettings>): void => {
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
  const fault = settings.accept ? `The program does not accept until ${say(settings.acceptAt)}` : "The program does not accept";

  return (
    <div className="rp not-content">
      <section className="sy-frame rp-stage" aria-label="The accept queue">
        <header className="sy-head">
          <div className="sy-title">
            <strong>What does a full queue do?</strong>
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
            fault={{ label: fault, end: faultEnd }}
            scale={scale}
            progress={player.progress}
            label={`${headline} The timeline shows the queue, the first SYN that drops and the first final ACK that overflows.`}
          />
          <TimelineLegend band="the lane acts, in this band" />
          <p className="sy-caption">{scaleCaption(scale)}</p>
          {table ? <EventsTable lanes={lanes} names={namesOf} heading="Lane" /> : null}
        </div>
      </section>

      <ol className="rp-stack" aria-label="The queue, the SYN and the final ACK">
        {lanes.map((lane) => (
          <li key={lane.id}>
            <LaneCard lane={lane} names={namesOf(lane.id)} lit={isLit(lane, axis, player.progress)} first={first === lane.id}>
              <LensKnobs registry={QUEUE_KNOBS} knobs={LENSES[lane.id].knobs} settings={settings} change={change} />
            </LaneCard>
          </li>
        ))}
      </ol>
    </div>
  );
}
