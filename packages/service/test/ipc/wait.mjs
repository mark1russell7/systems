// The child of src/process-it.test.ts for the waits that a caller awaits (SYS-126): retry, a retrier
// and within. The child has no socket, no IPC channel and no other timer. Thus only the timer of each
// wait keeps it alive. Each wait writes a line on stdout at its end.
// With no argument, each wait uses its default clock. With the argument "unref", each wait gets a
// clock whose timers do not keep the process alive: this is the control of the test.

import { within } from "../../src/channel.ts";
import { platformClock, retrier, retry } from "../../src/index.ts";

const line = (text) => void process.stdout.write(`${text}\n`);
const given = process.argv[2] === "unref" ? { clock: platformClock({ unref: true }) } : {};

const value = await retry(
  async (attempt) => {
    if (attempt < 2) throw new Error("the first try fails");
    return `retry ended at the try ${attempt}`;
  },
  { tries: 2, base: 200, ...given },
);
line(value);

await new Promise((resolve) => retrier({ base: 200, ...given }).schedule(resolve));
line("the retrier started its try");

const result = await within(new Promise(() => {}), 200, given.clock);
line(result.ok ? "within ended" : result.late ? "within is late" : "within failed");
