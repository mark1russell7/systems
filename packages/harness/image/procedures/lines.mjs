// The JSON lines of the procedures programs of the harness: the WebSocket client and the server.
//
// Each line has `ev` and `t`, as the TCP client of the harness writes them. `t` is
// process.hrtime, which libuv reads from CLOCK_MONOTONIC: the clock that the prober stamps the
// records of the kernel with. A write to a pipe is synchronous on Linux, thus a line goes out
// before the program does the act that it announces.

import { existsSync, readFileSync } from "node:fs";

/** This function gives the time now, in nanoseconds on CLOCK_MONOTONIC. */
export const now = () => process.hrtime.bigint();

/** This function writes one line, with the time `at` (the time now when none is given). */
export const emit = (ev, fields = {}, at = now()) =>
  process.stdout.write(`${JSON.stringify({ ev, t: Number(at), ...fields })}\n`);

/** This function gives the boot id of the kernel, or null where the file does not exist. */
export const bootId = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};

/**
 * This function reads the command line: positional arguments first, then `--name value` pairs.
 * A setting that the caller must give and does not is a failure: the program has no default.
 */
export const commandLine = (usage, positional = 0) => {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const fail = (why) => {
    emit("fail", { why: `${why}. Usage: ${usage}` });
    process.exit(1);
  };
  const required = (name) => {
    const value = flag(name);
    if (value === undefined) fail(`no ${name}`);
    return value;
  };
  const number = (name) => {
    const value = Number(required(name));
    if (!Number.isFinite(value)) fail(`${name} is not a number`);
    return value;
  };
  const toggle = (name) => {
    const value = required(name);
    if (value !== "on" && value !== "off") fail(`${name} is on or off`);
    return value === "on";
  };
  const args = argv.slice(0, positional);
  if (args.length < positional || args.some((arg) => arg.startsWith("--"))) fail("the positional arguments are missing");
  return { args, flag, required, number, toggle, fail };
};

/** This function waits until the file at `path` exists. It looks each 2 ms, as the other clients of the harness do. */
export const waitFor = (path) =>
  new Promise((resolve) => {
    const look = setInterval(() => {
      if (!existsSync(path)) return;
      clearInterval(look);
      resolve();
    }, 2);
  });
