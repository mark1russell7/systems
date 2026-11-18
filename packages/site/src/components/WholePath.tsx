/**
 * The whole path of one connection. A client takes a local port, its handshake meets the accept queue
 * of the target, and its request meets a fault. The page computes, in the browser, where the story of
 * the connection ends, and when. The reader sets the knobs of each stage.
 *
 * Each stage is the lenses of its own page: the port range (`./PortRange.tsx`), the accept queue
 * (`./AcceptQueue.tsx`) and the path of one request (`./RequestPath.tsx`). The model
 * `../model/whole-path.ts` puts each stage after the exit of the stage before it. The timeline, the
 * player and the cards are the parts of each page of lenses (`./Lens.tsx`). Each knob has one control,
 * on the first lens that shows it.
 */
import { useMemo, useState, type ReactElement } from "react";
import { controlsOf, say, sayBand, type LaneNames, type Lens, type Staged } from "../model/lens.ts";
import { LINKED_KNOBS, STAGES, WHOLE_DEFAULTS, WHOLE_PRESETS, wholePath, type StageId, type WholeLaneId, type WholeResult, type WholeSettings } from "../model/whole-path.ts";
import { QUEUE_KNOBS } from "./AcceptQueue.tsx";
import { LensKnobs, type KnobRegistry } from "./Knobs.tsx";
import { EventsTable, LaneCard, PlayerBar, Timeline, TimelineLegend, axisOf, isLit, scaleCaption, usePlayer, type FaultSpan, type Scale, type TimelineGroup } from "./Lens.tsx";
import { PORT_KNOBS } from "./PortRange.tsx";
import { FaultControls, PATH_KNOBS } from "./RequestPath.tsx";

/** The control of each knob of the whole path: the knobs of the three pages. A knob with one name in two pages has one control. */
const WHOLE_KNOBS: KnobRegistry<WholeSettings> = { ...PATH_KNOBS, ...PORT_KNOBS, ...QUEUE_KNOBS };

const LENSES: ReadonlyArray<Lens<WholeSettings, WholeLaneId>> = STAGES.flatMap((stage) => stage.lenses);
const LENS_OF = new Map(LENSES.map((lens) => [lens.id, lens]));
const namesOf = (id: string): LaneNames => {
  const lens = LENS_OF.get(id as WholeLaneId);
  if (lens === undefined) throw new Error(`no lens for the lane ${id}`);
  return lens.names;
};

/** The controls of each lens: each knob once, on the first lens that shows it, and no control for a knob that the path sets. */
const CONTROLS: ReadonlyMap<string, ReadonlyArray<keyof WholeSettings & string>> = new Map([...controlsOf(LENSES)].map(([id, knobs]) => [id, knobs.filter((knob) => !LINKED_KNOBS.has(knob))]));
const controls = (id: string): ReadonlyArray<keyof WholeSettings & string> => CONTROLS.get(id) ?? [];

/** This function gives the label of the fault on the timeline. */
const faultLabel = (settings: WholeSettings, fault: NonNullable<WholeResult["fault"]>): string => {
  if (settings.fault === "partition") return `Partition from ${say(fault.start)}${fault.end === null ? "" : ` to ${say(fault.end)}`}`;
  return settings.fault === "stall" ? `The peer stalls at ${say(fault.start)}` : `The black hole starts at ${say(fault.start)}`;
};

/** This function tells how a stage ends, for the trail of the stages. */
const exitText = (staged: Staged<WholeSettings, WholeLaneId>): string => {
  const exit = staged.exit;
  if (exit === null) return "The connection does not reach this stage.";
  return exit.at === null ? `${exit.label}.` : `${exit.label}, at ${sayBand(exit.at)}.`;
};

/** This function tells the clock of the cards of a stage. */
const clockText = (staged: Staged<WholeSettings, WholeLaneId>): string => {
  if (staged.start === null) return "The connection does not reach this stage. Its knobs are below.";
  const from = sayBand(staged.start);
  return staged.stage.id === "request" ? `The times of these cards count from the fault, at ${from} on the timeline.` : `The times of these cards count from the start of this stage, at ${from}.`;
};

export default function WholePath(): ReactElement {
  const [settings, setSettings] = useState<WholeSettings>(WHOLE_DEFAULTS);
  const [preset, setPreset] = useState<string | null>("defaults");
  const [scale, setScale] = useState<Scale>("log");
  const [table, setTable] = useState(false);
  const result = useMemo(() => wholePath(settings), [settings]);
  const player = usePlayer();
  const faultEnd = result.fault?.end ?? null;
  const axis = useMemo(() => axisOf(result.lanes, faultEnd, scale), [result, faultEnd, scale]);

  const change = (next: Partial<WholeSettings>): void => {
    setSettings((now) => ({ ...now, ...next }));
    setPreset(null);
  };
  const load = (id: string): void => {
    const found = WHOLE_PRESETS.find((p) => p.id === id);
    if (found === undefined) return;
    setSettings(found.settings);
    setPreset(id);
    player.restart();
  };

  const note = WHOLE_PRESETS.find((p) => p.id === preset)?.note ?? null;
  const fault: FaultSpan | null = result.fault === null ? null : { label: faultLabel(settings, result.fault), start: result.fault.start, end: result.fault.end };
  const groups: readonly TimelineGroup[] = result.stages.map((staged) => ({ label: staged.stage.short, rows: staged.lanes.length, start: staged.start?.low ?? null }));

  return (
    <div className="rp not-content">
      <section className="sy-frame rp-stage" aria-label="The whole path of one connection">
        <header className="sy-head">
          <div className="sy-title">
            <strong>Where does the connection end?</strong>
          </div>
          <div className="sy-row" role="group" aria-label="Presets">
            {WHOLE_PRESETS.map((p) => (
              <button key={p.id} type="button" className="sy-button" aria-pressed={preset === p.id} onClick={() => load(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </header>

        <div className="rp-controls">
          <FaultControls settings={settings} change={change} restart={player.restart} />
        </div>

        <div className="rp-headline" aria-live="polite">
          <p>{result.headline}</p>
          {note === null ? null : <p className="sy-muted">{note}</p>}
        </div>

        <ol className="wp-trail" aria-label="The stages of the connection">
          {result.stages.map((staged, n) => (
            <li key={staged.stage.id} data-kind={staged.exit === null ? "none" : staged.exit.kind}>
              <span className="wp-step" aria-hidden="true">
                {n + 1}
              </span>
              <span className="wp-trail-text">
                <strong>{staged.stage.title}</strong>
                <span>{exitText(staged)}</span>
              </span>
            </li>
          ))}
        </ol>

        <PlayerBar player={player} scale={scale} setScale={setScale} table={table} setTable={setTable} />

        <div className="sy-body">
          <Timeline
            lanes={result.lanes}
            names={namesOf}
            fault={fault}
            groups={groups}
            scale={scale}
            progress={player.progress}
            label={`${result.headline} The timeline shows the port, the accept queue and the request of one connection.`}
          />
          <TimelineLegend band="the lane acts, in this band" />
          <p className="sy-caption">{scaleCaption(scale)} A dashed line is the start of a stage.</p>
          {table ? <EventsTable lanes={result.lanes} names={namesOf} heading="Lane" /> : null}
        </div>
      </section>

      {result.stages.map((staged) => (
        <section key={staged.stage.id} className="wp-stage" aria-label={staged.stage.title} data-reached={staged.start === null ? undefined : "true"}>
          <header className="wp-stage-head">
            <h2>{staged.stage.title}</h2>
            <p className="sy-muted">{clockText(staged)}</p>
          </header>
          {staged.start === null ? (
            <div className="wp-knobs">
              {staged.stage.lenses.map((lens) => (
                <LensKnobs key={lens.id} registry={WHOLE_KNOBS} knobs={controls(lens.id)} settings={settings} change={change} />
              ))}
            </div>
          ) : (
            <ol className="rp-stack" aria-label={staged.stage.title}>
              {staged.own.map((lane, n) => {
                const placed = staged.lanes[n] ?? lane;
                return (
                  <li key={lane.id}>
                    <LaneCard lane={lane} names={namesOf(lane.id)} lit={isLit(placed, axis, player.progress)} first={result.first[staged.stage.id as StageId] === lane.id}>
                      <LensKnobs registry={WHOLE_KNOBS} knobs={controls(lane.id)} settings={settings} change={change} />
                    </LaneCard>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}
