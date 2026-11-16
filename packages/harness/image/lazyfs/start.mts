/**
 * The command of the image `lazyfs`. It starts LazyFS in the foreground: `/mnt/disk` is the mount, and `/var/disk`
 * holds the files. Node.js 24 of the image strips the types of this file.
 *
 * LazyFS opens `done.fifo` to write, and that open waits for a reader. LazyFS gets a reader of `done.fifo` as its
 * descriptor 3, and this process keeps the reader open. Thus LazyFS starts at once, and a write after a reader went away
 * does not stop it.
 *
 * This process is PID 1 of the container. It gives `SIGTERM` and `SIGINT` to LazyFS, and it ends with the exit of LazyFS.
 */
import { execFileSync, spawn } from "node:child_process";
import { constants, openSync } from "node:fs";
import { constants as os } from "node:os";

const FAULTS = "/run/lazyfs/faults.fifo";
const DONE = "/run/lazyfs/done.fifo";

execFileSync("mkfifo", [FAULTS, DONE], { stdio: "inherit" });
// On Linux, an open of a FIFO to read and write does not wait for the other end, the same as `exec 3<>` of a shell
const reader = openSync(DONE, constants.O_RDWR);
const lazyfs = spawn(
  "/usr/local/bin/lazyfs",
  ["/mnt/disk", "--config-path", "/etc/lazyfs/config.toml", "-o", "allow_other", "-o", "modules=subdir", "-o", "subdir=/var/disk", "-f"],
  { stdio: ["inherit", "inherit", "inherit", reader] },
);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => lazyfs.kill(signal));
lazyfs.on("error", (error) => {
  console.error(`LazyFS did not start: ${error.message}`);
  process.exit(1);
});
lazyfs.on("exit", (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 128 + os.signals[signal]));
});
