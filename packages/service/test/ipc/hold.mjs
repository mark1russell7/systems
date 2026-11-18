// The child of src/process-it.test.ts for the hold of the process (A14): a service under run()
// whose only part is a worker loop. The service gets a clock whose timers do not keep the process
// alive. Thus only the hold of the lifecycle keeps it alive until its exit. The child has no IPC
// channel and no socket. Each stage writes a line on stdout.

import { ephemeral, platformClock, service, workerLoop } from "../../src/index.ts";

const line = (text) => void process.stdout.write(`${text}\n`);
const s = (value) => ({ value, unit: "s" });

const beat = workerLoop(
  { worker_sleep: s(3600), unit_processing_time: s(1), retry_base: s(1), retry_cap: s(1), close_bound: s(1), concurrency: { value: 1, unit: "count" } },
  { iteration: () => line("iteration"), teardown: () => line("teardown") },
);
const svc = service("held").profile(ephemeral).worker("beat", beat.knobs, beat);

await svc.run({ clock: platformClock({ unref: true }) });
line("ready");
