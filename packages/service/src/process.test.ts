import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { HostStream, ProcessHost } from "./process.ts";
import { embeddedProcess, isMessageShape, matchesMessage, processPortOf } from "./process.ts";

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

  it("gives each message of the IPC channel to the handler of ipc-message, until its removal (SYS-21)", () => {
    const fake = host();
    const seen: unknown[] = [];
    const off = processPortOf(() => fake).on("ipc-message", (message) => void seen.push(message));
    fake.emit("message", "shutdown");
    fake.emit("message", { type: "stop" });
    off();
    fake.emit("message", "late");
    expect(seen).toEqual(["shutdown", { type: "stop" }]);
    expect(fake.listenerCount("message")).toBe(0);
  });

  it("matches a message with a shape of JSON: equal values, the fields of an object, and an array item by item", () => {
    expect(matchesMessage("shutdown", "shutdown")).toBe(true);
    expect(matchesMessage("shutdown", "Shutdown")).toBe(false);
    expect(matchesMessage({ type: "stop" }, { type: "stop", reason: "deploy" })).toBe(true);
    expect(matchesMessage({ type: "stop" }, { kind: "stop" })).toBe(false);
    expect(matchesMessage({ type: "stop", from: { name: "ci" } }, { type: "stop", from: { name: "ci", pid: 1 } })).toBe(true);
    expect(matchesMessage(["stop", 1], ["stop", 1])).toBe(true);
    expect(matchesMessage(["stop", 1], ["stop", 1, 2])).toBe(false);
    expect(matchesMessage(null, null)).toBe(true);
    expect(matchesMessage({}, "shutdown")).toBe(false);
    expect(matchesMessage({ type: "stop" }, ["stop"])).toBe(false);
    expect(isMessageShape({ a: [1, "b", null, true] })).toBe(true);
    expect(isMessageShape({ a: undefined })).toBe(false);
    expect(isMessageShape(() => {})).toBe(false);
    expect(isMessageShape(new Date())).toBe(false);
    expect(isMessageShape(Number.NaN)).toBe(false);
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

  it("holds the process with one timer of the event loop until the release (A14)", () => {
    const port = processPortOf(() => host());
    const timers = (): number => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const before = timers();
    const release = port.hold!();
    expect(timers()).toBe(before + 1);
    release();
    release();
    expect(timers()).toBe(before);
    expect(() => processPortOf(() => undefined).hold!()).toThrow(/no process: give the runtime a process port/);
  });

  it("throws when the platform has no process", () => {
    const port = processPortOf(() => undefined);
    expect(() => port.on("SIGINT", () => {})).toThrow(/no process: give the runtime a process port/);
  });
});

describe("the embedded process port (SYS-27)", () => {
  it("adds no handler, does not hold the process, and records the first exit code without an exit", async () => {
    const port = embeddedProcess();
    let calls = 0;
    const remove = port.on("SIGTERM", () => {
      calls += 1;
    });
    remove();
    expect(calls).toBe(0);
    expect(port.hold).toBeUndefined();
    expect(port.exitCode).toBeNull();
    port.exit(3);
    port.exit(0);
    expect(port.exitCode).toBe(3);
    await expect(port.exited).resolves.toBe(3);
  });
});
