import type { ChildProcess } from "node:child_process";
import { fork, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SYS-21 and A14: child processes under run() on the process of Node, opt-in with PROCESS_IT=1.
 * - The parent sends the IPC message "shutdown", and the child stops through its staged shutdown,
 *   as at SIGTERM.
 * - A child whose only part is a worker on the real clock stays alive through the hold of its
 *   lifecycle, because its timers do not keep it alive.
 * These tests start real processes, thus only CI starts them (.github/workflows/process.yml), on
 * Linux and on Windows. The same parts on the fake process run in the unit tests (runner.test.ts).
 */

const RUN = process.env["PROCESS_IT"] === "1";
const here = dirname(fileURLToPath(import.meta.url));
const IPC_CHILD = join(here, "..", "test", "ipc", "child.mjs");
const HELD_CHILD = join(here, "..", "test", "ipc", "hold.mjs");
const STAGES = ["start", "ready", "stop intake", "drain", "close"];
const WINDOWS = process.platform === "win32";

interface Run {
  readonly child: ChildProcess;
  readonly lines: string[];
  /** This promise ends when the process exited and its output closed. */
  readonly closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  until(line: string): Promise<void>;
}

/** This function keeps each line of the stdout of a child. */
const watch = (child: ChildProcess): Run => {
  const lines: string[] = [];
  let rest = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    const parts = (rest + chunk).split(/\r?\n/);
    rest = parts.pop() ?? "";
    lines.push(...parts.filter((part) => part.length > 0));
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const until = async (line: string): Promise<void> => {
    const end = Date.now() + 20_000;
    while (!lines.includes(line)) {
      if (Date.now() > end) throw new Error(`the child did not write "${line}" in 20 s: ${JSON.stringify(lines)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { child, lines, closed, until };
};

describe.skipIf(!RUN)("a child under run() and the IPC message of its parent (SYS-21)", () => {
  it("stops through its staged shutdown at the message shutdown, with the exit code of SIGTERM", async () => {
    const run = watch(fork(IPC_CHILD, [], { stdio: ["ignore", "pipe", "inherit", "ipc"] }));
    await run.until("ready");
    run.child.send("shutdown");
    expect(await run.closed).toEqual({ code: 143, signal: null });
    expect(run.lines).toEqual(STAGES);
  }, 30_000);

  it("gets its staged shutdown from a SIGTERM of its parent on Linux, and not on Windows (the control)", async () => {
    const run = watch(fork(IPC_CHILD, [], { stdio: ["ignore", "pipe", "inherit", "ipc"] }));
    await run.until("ready");
    run.child.kill("SIGTERM");
    const end = await run.closed;
    if (WINDOWS) {
      // Windows ends the child at once, thus no stage occurs, and the exit code is not the code of the shutdown
      expect(run.lines).toEqual(["start", "ready"]);
      expect(end.code).not.toBe(143);
    } else {
      expect(end).toEqual({ code: 143, signal: null });
      expect(run.lines).toEqual(STAGES);
    }
  }, 30_000);
});

describe.skipIf(!RUN)("the hold of the process: a child whose only part is a worker (A14)", () => {
  it("stays alive until its exit, and on Linux a SIGTERM gives its teardown and the exit code", async () => {
    // no IPC channel and no socket: only the hold of the lifecycle keeps the child alive
    const run = watch(spawn(process.execPath, [HELD_CHILD], { stdio: ["ignore", "pipe", "inherit"] }));
    await run.until("iteration");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(run.child.exitCode).toBeNull();
    expect(run.lines).toEqual(["ready", "iteration"]);
    run.child.kill("SIGTERM");
    const end = await run.closed;
    if (WINDOWS) expect(run.lines).toEqual(["ready", "iteration"]);
    else {
      expect(end).toEqual({ code: 143, signal: null });
      expect(run.lines).toEqual(["ready", "iteration", "teardown"]);
    }
  }, 30_000);
});
