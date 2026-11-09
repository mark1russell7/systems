import type { Machine } from "./machine.ts";

// The states of a document, without the schema: the replay reads them, and it does not import zod.

/** This function gives one value or many values as an array. */
export const arr = <T>(value: T | readonly T[]): readonly T[] =>
  Array.isArray(value) ? (value as readonly T[]) : [value as T];

/** This function gives the states that a transition leaves. The state "*" is each state that is not final. */
export const fromStates = (m: Pick<Machine, "states">, from: string | readonly string[]): string[] => {
  const out = new Set<string>();
  for (const state of arr(from)) {
    if (state !== "*") out.add(state);
    else for (const [name, def] of Object.entries(m.states)) if (def.final !== true) out.add(name);
  }
  return [...out];
};
