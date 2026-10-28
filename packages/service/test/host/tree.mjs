// A child of src/host-it.test.ts for the stop of a process tree (SYS-47). It starts a grandchild
// with no option, thus the grandchild stays in the tree of this process. It writes the line
// "grandchild <pid>" on stdout and stays alive.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const sleeper = fileURLToPath(new URL("./sleep.mjs", import.meta.url));
const grandchild = spawn(process.execPath, [sleeper], { stdio: "ignore" });
grandchild.once("spawn", () => process.stdout.write(`grandchild ${grandchild.pid}\n`));
setInterval(() => {}, 60_000);
