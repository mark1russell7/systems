import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { UncaughtOrigin } from "./index.ts";
import { UNCAUGHT_ORIGINS, embeddedProcess, processPortOf } from "./index.ts";
import { exited, rig, run } from "./rig.ts";

/** SYS-46: an error that no code caught is a trigger of the staged shutdown, when `run()` opts in. */

/** This function makes an error of a socket, with its code, as Node gives it. */
const socketError = (code: string): Error => Object.assign(new Error(`read ${code}`), { code });

/** This function skips the errors of a peer socket. */
const peerSocket = (error: unknown): boolean => ["ECONNRESET", "EPIPE"].includes((error as { code?: unknown }).code as string);

describe("run({ uncaught }): an uncaught error starts the staged shutdown (SYS-46)", () => {
  it("adds no handler without the option, and one handler with it, which goes at the exit", async () => {
    const plain = rig();
    const before = await run(plain);
    const baseline = plain.process.handlers;
    plain.process.signal("SIGTERM");
    expect(await exited(plain, before)).toBe(0);

    const r = rig();
    const life = await run(r, () => {}, { uncaught: { exitCode: 1 } });
    expect(r.process.handlers).toBe(baseline + 1);
    r.process.signal("SIGTERM");
    expect(await exited(r, life)).toBe(0);
    expect(r.process.handlers).toBe(0);
  });

  it("logs the error at error with its stack, and runs each phase to the exit code of the option", async () => {
    const r = rig();
    const life = await run(r, () => {}, { uncaught: { exitCode: 3 } });
    r.process.uncaught(new Error("boom"));
    expect(life.state).toBe("running");
    expect(await exited(r, life)).toBe(3);
    const errors = r.logger.entries.filter((entry) => entry.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/^an uncaught exception: Error: boom\n\s+at /);
    // the shutdown is the staged shutdown of a signal: each phase, then the exit
    const info = r.logger.messages("info");
    expect(info).toContain("the shutdown of svc begins");
    expect(info).toContain("the phase drain ended in its cap");
    expect(info).toContain("the phase close the health server ended in its cap");
    expect(info.at(-1)).toBe("svc exited with the code 3");
    expect(r.events.find((event) => event.machine === "exit" && event.on === "exit.request")!.detail).toBe("an uncaught exception: boom");
    expect(life.errors).toHaveLength(1);
    expect(r.process.exits).toEqual([3]);
    expect(r.log.filter((line) => / (stop intake|drain|close) http$/.test(line))).toHaveLength(3);
  });

  it("gives the exit code 1 by default, and names an unhandled rejection", async () => {
    const r = rig();
    const life = await run(r, () => {}, { uncaught: {} });
    r.process.uncaught("a reason that is not an Error", "unhandledRejection");
    expect(await exited(r, life)).toBe(1);
    expect(r.logger.messages("error")).toEqual(["an unhandled rejection: a reason that is not an Error"]);
  });

  it("skips an error that ignore accepts, logs it at warn, and the service runs on", async () => {
    const r = rig();
    const seen: UncaughtOrigin[] = [];
    const ignore = (error: unknown, origin: UncaughtOrigin): boolean => {
      seen.push(origin);
      return peerSocket(error);
    };
    const life = await run(r, () => {}, { uncaught: { exitCode: 1, ignore } });
    r.process.uncaught(socketError("ECONNRESET"));
    r.process.uncaught(socketError("EPIPE"), "unhandledRejection");
    await r.clock.advance(5000);
    expect(life.state).toBe("running");
    expect(life.errors).toEqual([]);
    expect(r.logger.messages("warn")).toEqual([
      "an uncaught exception was skipped: read ECONNRESET",
      "an unhandled rejection was skipped: read EPIPE",
    ]);
    expect(r.logger.entries.find((entry) => entry.level === "warn")!.fields).toMatchObject({ origin: "uncaughtException" });
    expect(seen).toEqual(["uncaughtException", "unhandledRejection"]);
    // an error that ignore does not accept still starts the shutdown
    r.process.uncaught(new Error("not a socket"));
    expect(await exited(r, life)).toBe(1);
  });

  it("skips nothing when ignore throws, and a second error during the shutdown starts no second shutdown", async () => {
    const r = rig();
    const ignore = (): boolean => {
      throw new Error("a broken filter");
    };
    const life = await run(r, () => {}, { uncaught: { exitCode: 4, ignore } });
    r.process.uncaught(socketError("ECONNRESET"));
    // the phase fail readiness holds for its cap of 1 s
    await r.clock.advance(500);
    expect(life.state).toBe("draining");
    r.process.uncaught(new Error("a second error"));
    expect(await exited(r, life)).toBe(4);
    expect(r.process.exits).toEqual([4]);
    expect(r.logger.messages("error")).toHaveLength(2);
    expect(r.events.filter((event) => event.machine === "exit" && event.on === "exit.request")).toHaveLength(1);
  });

  it("refuses an exit code that is not from 0 to 255", async () => {
    const r = rig();
    await expect(r.svc.run({ process: r.process, clock: r.clock, uncaught: { exitCode: 256 } })).rejects.toThrow(
      "the exit code 256 of an uncaught error is not a whole number from 0 to 255",
    );
    expect(r.process.handlers).toBe(0);
  });
});

describe("the uncaught handler of the process port", () => {
  it("adds a handler of uncaughtException and of unhandledRejection on the host, and removes the two", () => {
    const fake = Object.assign(new EventEmitter(), { exit: () => {} });
    const got: Array<[unknown, UncaughtOrigin]> = [];
    const off = processPortOf(() => fake).onUncaught!((error, origin) => got.push([error, origin]));
    expect(UNCAUGHT_ORIGINS.map((origin) => fake.listenerCount(origin))).toEqual([1, 1]);
    fake.emit("uncaughtException", "thrown");
    fake.emit("unhandledRejection", "rejected");
    off();
    expect(UNCAUGHT_ORIGINS.map((origin) => fake.listenerCount(origin))).toEqual([0, 0]);
    expect(got).toEqual([
      ["thrown", "uncaughtException"],
      ["rejected", "unhandledRejection"],
    ]);
  });

  it("is not on the embedded port: the owner of the process keeps its errors", () => {
    expect(embeddedProcess().onUncaught).toBeUndefined();
  });
});
