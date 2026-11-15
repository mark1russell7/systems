// The child of src/clock-process.test.ts (SYS-126). It awaits a delay of 200 ms, and then it writes a
// line on stdout. It has no socket and no other timer. Thus only the timer of the delay keeps it alive.
// With no argument, the delay uses realClock. With the argument "unref", the delay uses a clock whose
// timers do not keep the process alive: this is the control of the test.

import { delay, platformClock, realClock } from "../../src/clock.ts";

const clock = process.argv[2] === "unref" ? platformClock({ unref: true }) : realClock;
await delay(clock, 200);
process.stdout.write("the delay ended\n");
