// The child of src/process-it.test.ts for the deadline of a scope (SYS-134). The root scope has a deadline
// 200 ms away, and the child awaits the abort of its signal. The child has no socket, no IPC channel and no
// other timer. Thus only the timer of the deadline keeps it alive. At the abort, it writes the name of the reason.
// With no argument, the root uses realClock. With the argument "unrefClock", the root gets a clock whose timers
// do not keep the process alive: this is the control of the test.

import { realClock, unrefClock } from "../../src/clock.ts";
import { rootScope } from "../../src/scope.ts";

const clock = process.argv[2] === "unrefClock" ? unrefClock(realClock) : realClock;
const scope = rootScope({ name: "child", clock, timeout: 200 });
await new Promise<void>((resolve) => scope.signal.addEventListener("abort", () => resolve(), { once: true }));
process.stdout.write(`${(scope.signal.reason as DOMException).name}\n`);
