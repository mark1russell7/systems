// The JSON lines of the Socket.IO programs: the client and the server.
//
// Each line has `ev` and `t`, as the TCP client of the harness writes them. `t` is process.hrtime,
// which libuv reads from CLOCK_MONOTONIC: the clock that the prober stamps the records of the
// kernel with. A write to a pipe is synchronous on Linux, thus a line goes out before the program
// does the act that it announces.
//
// The protocol of the lines is the protocol of the procedures subject of the client repository
// (harness/procedures-subject/lines.ts), thus the judge of the harness reads both. Each folder of a
// target is its own context of the build, thus this folder has its own copy of these helpers.

import { existsSync, readFileSync } from "node:fs";

/** This function gives the current time, in nanoseconds on CLOCK_MONOTONIC. */
export const now = (): bigint => process.hrtime.bigint();

/** This function writes one line, with the time `at` (the current time when none is given). */
export const emit = (ev: string, fields: Record<string, unknown> = {}, at: bigint = now()): boolean =>
  process.stdout.write(`${JSON.stringify({ ev, t: Number(at), ...fields })}\n`);

/** This function gives the boot id of the kernel, or null where the file does not exist. */
export const bootId = (): string | null => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};

/** This function gives the version of each package of Socket.IO in the image, from its package.json. */
export const versions = (names: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    names.map((name) => {
      const manifest = JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8")) as { version: string };
      return [name, manifest.version];
    }),
  );

/** The command line of a program: its positional arguments, and the readers of its flags. */
export interface CommandLine {
  args: string[];
  flag(name: string): string | undefined;
  required(name: string): string;
  number(name: string): number;
  toggle(name: string): boolean;
  fail(why: string): never;
}

/**
 * This function reads the command line: positional arguments first, then `--name value` pairs.
 * A setting that the caller must give and does not is a failure: the program has no default.
 */
export const commandLine = (usage: string, positional = 0): CommandLine => {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const fail: (why: string) => never = (why) => {
    emit("fail", { why: `${why}. Usage: ${usage}` });
    process.exit(1);
  };
  const required = (name: string): string => {
    const value = flag(name);
    if (value === undefined) fail(`no ${name}`);
    return value;
  };
  const number = (name: string): number => {
    const value = Number(required(name));
    if (!Number.isFinite(value)) fail(`${name} is not a number`);
    return value;
  };
  const toggle = (name: string): boolean => {
    const value = required(name);
    if (value !== "on" && value !== "off") fail(`${name} is on or off`);
    return value === "on";
  };
  const args = argv.slice(0, positional);
  if (args.length < positional || args.some((arg) => arg.startsWith("--"))) fail("the positional arguments are missing");
  return { args, flag, required, number, toggle, fail };
};

/**
 * This function does `act` `count` times, one time each `interval` milliseconds, with the numbers 1
 * to `count`. Each act has its time from the start (start + (n − 1) × interval), not from the act
 * before it. Thus the lateness of a timer does not add up over the stream.
 */
export const every = (count: number, interval: number, act: (n: number) => void): void => {
  const start = now();
  const next = (n: number): void => {
    const due = start + BigInt(Math.round((n - 1) * interval * 1e6));
    setTimeout(
      () => {
        act(n);
        if (n < count) next(n + 1);
      },
      Math.max(0, Number(due - now()) / 1e6),
    );
  };
  next(1);
};

/** This function waits until the file at `path` exists. It looks each 2 ms, as the other clients of the harness do. */
export const waitFor = (path: string): Promise<void> =>
  new Promise((resolve) => {
    const look = setInterval(() => {
      if (!existsSync(path)) return;
      clearInterval(look);
      resolve();
    }, 2);
  });
