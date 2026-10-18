import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { HostStream, ProcessHost } from "./process.ts";
import { processPortOf } from "./process.ts";

/**
 * The port of the process of Node, on a fake host: the signals, the end of stdin, the close of the
 * IPC channel, the flush of the output and the exit. No test here touches the real process.
 */

/** This function makes a fake stream. Its writes complete when the test calls `drain()`. */
const stream = (state: { readableEnded?: boolean; writable?: boolean } = {}) => {
  const emitter = new EventEmitter();
  const pending: Array<() => void> = [];
  const fake = Object.assign(emitter, {
    readableEnded: state.readableEnded ?? false,
    writable: state.writable ?? true,
    destroyed: false,
    write(_chunk: string, done: () => void) {
      pending.push(done);
      return true;
    },
    drain() {
      for (const done of pending.splice(0)) done();
    },
  });
  return fake as typeof fake & HostStream;
};

const host = (parts: Partial<Pick<ProcessHost, "stdin" | "stdout" | "stderr">> = {}) => {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  return Object.assign(emitter, {
    exits,
    exit: (code: number) => void exits.push(code),
    ...parts,
  });
};

describe("the port of the process of Node", () => {
  it("adds and removes the handler of each exit signal", () => {
    const fake = host();
    const port = processPortOf(() => fake);
    let calls = 0;
    const off = port.on("SIGTERM", () => (calls += 1));
    fake.emit("SIGTERM");
    off();
    fake.emit("SIGTERM");
    expect(calls).toBe(1);
    expect(fake.listenerCount("SIGTERM")).toBe(0);
  });

  it("starts the shutdown one time when stdin ends and closes", () => {
    const stdin = stream();
    const fake = host({ stdin });
    let calls = 0;
    const off = processPortOf(() => fake).on("stdin-close", () => (calls += 1));
    stdin.emit("end");
    stdin.emit("close");
    expect(calls).toBe(1);
    off();
    expect(stdin.listenerCount("end") + stdin.listenerCount("close")).toBe(0);
  });

  it("starts the shutdown when stdin ended before the handler, unless the handler is removed first", async () => {
    let calls = 0;
    const fake = host({ stdin: stream({ readableEnded: true }) });
    processPortOf(() => fake).on("stdin-close", () => (calls += 1));
    const off = processPortOf(() => fake).on("stdin-close", () => (calls += 10));
    off();
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it("starts the shutdown when the IPC channel closes", () => {
    const fake = host();
    let calls = 0;
    processPortOf(() => fake).on("ipc-close", () => (calls += 1));
    fake.emit("disconnect");
    fake.emit("disconnect");
    expect(calls).toBe(1);
  });

  it("ends the flush only when stdout and stderr have written each line before it", async () => {
    const stdout = stream();
    const stderr = stream();
    const fake = host({ stdout, stderr });
    let flushed = false;
    const flush = Promise.resolve(processPortOf(() => fake).flush?.()).then(() => (flushed = true));
    await Promise.resolve();
    stdout.drain();
    await Promise.resolve();
    expect(flushed).toBe(false);
    stderr.drain();
    await flush;
    expect(flushed).toBe(true);
  });

  it("does not wait for a stream that is closed, and exits with the code", async () => {
    const fake = host({ stdout: stream({ writable: false }) });
    const port = processPortOf(() => fake);
    await port.flush?.();
    port.exit(143);
    expect(fake.exits).toEqual([143]);
  });

  it("throws when the platform has no process", () => {
    const port = processPortOf(() => undefined);
    expect(() => port.on("SIGINT", () => {})).toThrow(/no process: give the runtime a process port/);
  });
});
