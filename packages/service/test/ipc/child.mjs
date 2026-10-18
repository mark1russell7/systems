// The child of src/process-it.test.ts (SYS-21): a service under run() on the process of Node. It
// stops through its staged shutdown at the IPC message "shutdown", as at SIGTERM. Each stage writes
// a line on stdout, and the stage "flush the output" waits for the lines before the exit.
// Node strips the types of the source of the service, thus the child needs no build.

import { ephemeral, service } from "../../src/index.ts";

const line = (text) => void process.stdout.write(`${text}\n`);

const svc = service("child")
  .profile(ephemeral)
  .trigger("ipc-message", { match: "shutdown", as: "SIGTERM" })
  .server("work", {}, {
    start: () => line("start"),
    stopIntake: () => line("stop intake"),
    drain: () => line("drain"),
    inFlight: () => 0,
    close: () => line("close"),
  });
svc.controller("work").route("RUN", { idempotent: true });

await svc.run();
line("ready");
