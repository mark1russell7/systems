// The answers that the request tracking still writes (SYS-29). `writeOutcome` marks each response
// while it waits for the end of its request. At the deadline of its drain, the transport waits for
// each marked response: the cut of the drain gives that end at the same time.

const marked = new WeakSet<object>();
const watchers = new Set<() => void>();

/** This function marks a response that waits for the end of its request. It gives the function that removes the mark. */
export const markAnswer = (res: object): (() => void) => {
  marked.add(res);
  return () => {
    if (!marked.delete(res)) return;
    for (const watcher of [...watchers]) watcher();
  };
};

/** This function tells if a response waits for the end of its request. */
export const awaitsAnswer = (res: object): boolean => marked.has(res);

/** This function starts `watcher` after each removal of a mark. It gives the function that stops it. */
export const watchAnswers = (watcher: () => void): (() => void) => {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
};
