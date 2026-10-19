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

// The owner of each stream of a request: the lifecycle whose `life.request` made it. A drain waits only
// for the streams of its own lifecycle, because only its cut ends them. A stream outside the lifecycle
// does not hold a drain, as in 0.5.4. The drain only counts it, for the record of the phase.
const owners = new WeakMap<object, object>();
const outside = new WeakMap<object, number>();

/** This function records the lifecycle that made a stream, and gives the stream. A stream keeps its first owner. */
export const ownStream = <T extends object>(stream: T, life: object): T => {
  if (!owners.has(stream)) owners.set(stream, life);
  return stream;
};

/** This function gives the lifecycle that made a stream, or null for a stream outside each lifecycle. */
export const ownerOf = (stream: object): object | null => owners.get(stream) ?? null;

/** This function adds the count of streams outside a lifecycle that a drain found open at its deadline. */
export const noteOutside = (life: object, count: number): void => {
  if (count > 0) outside.set(life, (outside.get(life) ?? 0) + count);
};

/** This function gives the count of streams outside a lifecycle that its drains found, and sets the count to zero. */
export const takeOutside = (life: object): number => {
  const count = outside.get(life) ?? 0;
  outside.delete(life);
  return count;
};
