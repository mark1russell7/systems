// The one writer of the lines of the target, for the main thread and for the worker. A worker gives
// process.stdout to the main thread, and the main thread of this target blocks. Thus each line goes
// to the descriptor 1 at once, in one write. A line under PIPE_BUF bytes is atomic in a pipe.

import { writeSync } from "node:fs";

/** This function writes one line, with `t` from process.hrtime: CLOCK_MONOTONIC, the clock of the prober. */
export const emit = (ev: string, fields: Readonly<Record<string, unknown>> = {}): void => {
  writeSync(1, `${JSON.stringify({ ev, t: Number(process.hrtime.bigint()), ...fields })}\n`);
};
