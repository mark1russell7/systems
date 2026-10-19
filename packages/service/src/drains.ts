// The holds of the drains after their deadline (SYS-29). A transport that waits after the deadline of
// its drain gives its hold under its lifecycle. At the cap of the drain, the lifecycle reads each hold.
// A drain that waits only for the bytes of its answers did its work, thus the phase does not fail.

/** A late hold tells what holds the drain of a transport after its deadline. */
export interface LateHold {
  /** This count is the number of calls whose end did not come: their handler still runs. */
  readonly running: number;
  /** This count is the number of answers whose bytes did not go to the client, for example to a client that does not read. */
  readonly unflushed: number;
}

const holds = new WeakMap<object, Set<() => LateHold>>();

/** This function adds the hold of a drain under its lifecycle. It gives the function that removes the hold. */
export const holdLate = (life: object, hold: () => LateHold): (() => void) => {
  const set = holds.get(life) ?? new Set<() => LateHold>();
  holds.set(life, set);
  set.add(hold);
  return () => {
    set.delete(hold);
  };
};

/** This function gives the hold of each drain under a lifecycle, as it is at this time. */
export const lateHolds = (life: object): LateHold[] => [...(holds.get(life) ?? [])].map((hold) => hold());
