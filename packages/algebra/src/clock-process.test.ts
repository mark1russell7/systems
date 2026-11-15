import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SYS-126: a wait that a caller awaits keeps the process alive. The child awaits a delay of 200 ms,
 * and it has no other work. On a timer that does not keep the process alive, Node ends the child in
 * the delay. The promise does not settle, and the line does not come.
 */

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "clock", "wait.ts");

/** This function starts the child with its arguments, and gives its exit code and its stdout. */
const start = (args: readonly string[]): Promise<{ readonly code: number | null; readonly out: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out }));
  });

describe("a wait on realClock keeps the process alive (SYS-126)", () => {
  it("ends the delay of a child whose only work is the delay", async () => {
    expect(await start([])).toEqual({ code: 0, out: "the delay ended\n" });
  }, 20_000);

  it("exits in the delay on a clock with unref, with the code of a top-level await that does not settle (the control)", async () => {
    expect(await start(["unref"])).toEqual({ code: 13, out: "" });
  }, 20_000);
});
