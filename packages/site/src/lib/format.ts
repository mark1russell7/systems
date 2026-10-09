/** This function removes the zeros at the end of a decimal: 5.000 becomes 5, and 6.340 becomes 6.34. */
const trim = (text: string): string => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);

/** This function writes a time in milliseconds with the units that a reader expects for its size. */
export const duration = (ms: number): string => {
  if (!Number.isFinite(ms)) return "never";
  if (ms < 1) return `${trim((ms * 1000).toFixed(0))} µs`;
  if (ms < 1000) return `${trim(ms.toFixed(ms < 10 ? 2 : 1))} ms`;
  const s = ms / 1000;
  if (s < 120) return `${trim(s.toFixed(3))} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  const parts = [h > 0 ? `${h} h` : "", m > 0 ? `${m} min` : "", rest > 0.0005 ? `${trim(rest.toFixed(1))} s` : ""];
  return parts.filter((part) => part !== "").join(" ");
};

/** The unit that the ticks of an axis use, for the span of the axis. */
export interface TickUnit {
  readonly ms: number;
  readonly name: string;
}

/** This function selects the unit for an axis that spans `span` milliseconds. */
export const unitFor = (span: number): TickUnit =>
  span < 2 ? { ms: 0.001, name: "µs" } : span < 2000 ? { ms: 1, name: "ms" } : span < 240_000 ? { ms: 1000, name: "s" } : span < 14_400_000 ? { ms: 60_000, name: "min" } : { ms: 3_600_000, name: "h" };

/** This function gives the step of an axis: 1, 2 or 5 times a power of 10, near `span / count`. */
const stepFor = (span: number, count: number): number => {
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((f) => f * power).find((s) => s >= raw) ?? power * 10;
};

/** This function gives tick values for an axis from 0 to `max`, at a step of 1, 2 or 5 times a power of 10. */
export const ticks = (max: number, count = 5): number[] => {
  if (max <= 0) return [0];
  const step = stepFor(max, count);
  const out: number[] = [];
  for (let t = 0; t <= max + step * 1e-9; t += step) out.push(Number(t.toPrecision(12)));
  return out;
};

/** This function gives the ticks of an axis from `from` to `to` milliseconds, in a unit that suits the end of the axis. */
export const ticksBetween = (from: number, to: number, count = 5): { readonly unit: TickUnit; readonly values: number[] } => {
  const unit = unitFor(to);
  const step = stepFor((to - from) / unit.ms, count) * unit.ms;
  const values: number[] = [];
  for (let t = Math.ceil(from / step - 1e-9) * step; t <= to + step * 1e-9; t += step) values.push(Number(t.toPrecision(12)));
  return { unit, values };
};
