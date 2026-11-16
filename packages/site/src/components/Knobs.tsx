/**
 * The controls of the knobs of a lens: a time on a logarithmic slider, a count, a choice, and a time with
 * an off switch. A knob registry gives the control of each knob by its name. A knob has one name in all
 * lenses, thus a page of many lenses merges the registries of its lenses and shows each knob once.
 */
import { Fragment, type ReactElement, type ReactNode } from "react";
import { quantity, valueIn, type Quantity } from "@mark1russell7/quantity";
import { say } from "../model/lens.ts";
import Term from "./Term.tsx";

/** A slider on a logarithmic scale from `min` to `max`, in one unit, for times that span several orders. */
const toLog = (value: number, min: number, max: number): number => (100 * Math.log(Math.max(value, min) / min)) / Math.log(max / min);
const fromLog = (step: number, min: number, max: number): number => Number((min * (max / min) ** (step / 100)).toPrecision(2));

export function TimeKnob(props: {
  readonly label: ReactNode;
  readonly value: Quantity;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: Quantity) => void;
}): ReactElement {
  const now = valueIn(props.value, props.unit);
  return (
    <label className="sy-knob">
      <span>
        {props.label} <output>{say(props.value)}</output>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={0.5}
        value={toLog(now, props.min, props.max)}
        onChange={(e) => props.onChange(quantity(fromLog(Number(e.target.value), props.min, props.max), props.unit))}
      />
    </label>
  );
}

export function CountKnob(props: { readonly label: ReactNode; readonly value: number; readonly min: number; readonly max: number; readonly onChange: (value: number) => void }): ReactElement {
  return (
    <label className="sy-knob">
      <span>
        {props.label} <output>{props.value}</output>
      </span>
      <input type="range" min={props.min} max={props.max} step={1} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

export function Choice<T extends string | number>(props: {
  readonly label: ReactNode;
  readonly name: string;
  readonly options: ReadonlyArray<{ readonly id: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <div className="sy-knob">
      <span>{props.label}</span>
      <span className="sy-switch" role="group" aria-label={props.name}>
        {props.options.map((option) => (
          <button key={String(option.id)} type="button" aria-pressed={props.value === option.id} onClick={() => props.onChange(option.id)}>
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** A time knob with an off switch: the off value is 0. */
export function OptionalTimeKnob(props: {
  readonly label: ReactNode;
  readonly name: string;
  readonly value: Quantity;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly onValue: number;
  readonly onChange: (value: Quantity) => void;
}): ReactElement {
  const on = valueIn(props.value, props.unit) > 0;
  return (
    <div className="sy-knob">
      <span>
        {props.label} <output>{on ? say(props.value) : "off"}</output>
      </span>
      <span className="rp-optional">
        <span className="sy-switch" role="group" aria-label={props.name}>
          <button type="button" aria-pressed={!on} onClick={() => props.onChange(quantity(0, props.unit))}>
            Off
          </button>
          <button type="button" aria-pressed={on} onClick={() => props.onChange(quantity(on ? valueIn(props.value, props.unit) : props.onValue, props.unit))}>
            On
          </button>
        </span>
        <input
          type="range"
          aria-label={props.name}
          min={0}
          max={100}
          step={0.5}
          disabled={!on}
          value={on ? toLog(valueIn(props.value, props.unit), props.min, props.max) : 0}
          onChange={(e) => props.onChange(quantity(fromLog(Number(e.target.value), props.min, props.max), props.unit))}
        />
      </span>
    </div>
  );
}

/** The control of one knob: its value, and the function that sets a new value. */
export type KnobControl<V> = (value: V, set: (next: V) => void) => ReactElement;

/** A knob registry gives the control of each knob of the settings `S`, by the name of the knob. */
export type KnobRegistry<S> = { readonly [K in keyof S]?: KnobControl<S[K]> };

/** The controls of the knobs of one lens, in the order of the lens. A lens without knobs shows nothing. */
export function LensKnobs<S>(props: {
  readonly registry: KnobRegistry<S>;
  readonly knobs: ReadonlyArray<keyof S & string>;
  readonly settings: S;
  readonly change: (next: Partial<S>) => void;
}): ReactElement | null {
  const { registry, settings, change } = props;
  const shown = props.knobs.flatMap((name) => {
    const control = registry[name];
    if (control === undefined) return [];
    const set = (next: S[typeof name]): void => change({ [name]: next } as unknown as Partial<S>);
    return [<Fragment key={name}>{control(settings[name], set)}</Fragment>];
  });
  return shown.length === 0 ? null : <div className="sy-knobs rp-knobs">{shown}</div>;
}

/** The control of the round trip. The lenses of the kernel share it: TCP, the socket and the port range. */
export const rttKnob: KnobControl<Quantity> = (value, set) => <TimeKnob label="Round trip" value={value} unit="ms" min={0.1} max={300} onChange={set} />;

/** The control of HZ, the clock of the kernel. The lenses of the kernel share it. */
export const hzKnob: KnobControl<number> = (value, set) => (
  <Choice label={<Term name="HZ">Kernel clock, HZ</Term>} name="Kernel clock" options={[100, 250, 300, 1000].map((hz) => ({ id: hz, label: String(hz) }))} value={value} onChange={set} />
);
