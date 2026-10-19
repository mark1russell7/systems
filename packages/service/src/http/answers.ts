// The answers that the request tracking still writes (SYS-29). `writeOutcome` marks each response
// while it waits for the end of its request, with the lifecycle that made the stream. At the deadline
// of its drain, the transport waits for each response of its own lifecycle: the cut of the drain gives
// that end at the same time. A stream of another lifecycle, or of none, does not hold the drain.

const marked = new WeakMap<object, object | null>();
const watchers = new Set<() => void>();

/**
 * This function marks a response that waits for the end of its request. `owner` is the lifecycle
 * that made the stream, or null. It gives the function that removes the mark.
 */
export const markAnswer = (res: object, owner: object | null): (() => void) => {
  marked.set(res, owner);
  return () => {
    if (!marked.delete(res)) return;
    for (const watcher of [...watchers]) watcher();
  };
};

/**
 * This function gives the mark of a response: the lifecycle that made its stream. It gives null for a
 * stream outside each lifecycle, and undefined for a response with no mark.
 */
export const answerOwner = (res: object): object | null | undefined => marked.get(res);

/** This function starts `watcher` after each removal of a mark. It gives the function that stops it. */
export const watchAnswers = (watcher: () => void): (() => void) => {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
};
