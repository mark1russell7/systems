// The JSON lines of the Node programs of the HTTP cells: the server and its two Node clients.
//
// Each line has `ev` and `t`, as the TCP client of the harness writes them. `t` is
// process.hrtime, which libuv reads from CLOCK_MONOTONIC: the clock that the prober stamps the
// records of the kernel with. The arguments are the host and the port, then flags with a value.

import { existsSync, readFileSync } from "node:fs";

/** This function gives the current time, in nanoseconds on CLOCK_MONOTONIC. */
export const now = () => process.hrtime.bigint();

/** This function writes one line, with the time `at` (the current time when none is given). */
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

/** This function reads the command line: the host and the port first, then `--name value` pairs. */
export const commandLine = (usage) => {
  const argv = process.argv.slice(2);
  const [host, port] = argv;
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const number = (name, otherwise) => {
    const value = flag(name);
    return value === undefined ? otherwise : Number(value);
  };
  if (host === undefined || port === undefined) {
    emit("fail", { why: usage });
    process.exit(1);
  }
  return { host, port: Number(port), flag, number, has: (name) => argv.includes(name) };
};

/** This function waits until the file at `path` exists. It looks each 2 ms, as the ioredis client does. */
export const waitFor = (path) =>
  new Promise((resolve) => {
    const look = setInterval(() => {
      if (!existsSync(path)) return;
      clearInterval(look);
      resolve();
    }, 2);
  });

/** This function waits `ms` milliseconds on a Node timer. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** This function gives the path of the second request: a held reply, a long body, or the root. */
export const pathOf = ({ hold, bytes }) =>
  hold !== undefined ? `/hold?ms=${hold}` : bytes !== undefined ? `/big?bytes=${bytes}` : "/";
