import { describe, expect, it } from "vitest";
import { testLogger } from "../testing.ts";
import { fakeHost } from "./fakes.ts";
import { acquireInstanceLock, inspectInstanceLock, lockText, parseLockOwner } from "./lock.ts";
import type { HostPorts } from "./ports.ts";

const PATH = "/state/demo.lock";
const WALL = 1_000_000_000_000;

/** This function gives the ports of a second process on the same fake host. */
const other = (ports: HostPorts, pid: number, startedAt: number, processes: Map<number, number | null>): HostPorts => {
  processes.set(pid, startedAt);
  return { ...ports, self: { pid, startedAt } };
};

describe("parseLockOwner and lockText", () => {
  it("read the record that they write, with a child or without", () => {
    expect(lockText({ pid: 7, startedAt: 5 })).toBe('{"pid":7,"startedAt":5}\n');
    expect(parseLockOwner(lockText({ pid: 7, startedAt: 5 }))).toEqual({ pid: 7, startedAt: 5 });
    expect(parseLockOwner(lockText({ pid: 7, startedAt: 5, child: { pid: 8, startedAt: 6 } }))).toEqual({ pid: 7, startedAt: 5, child: { pid: 8, startedAt: 6 } });
  });

  it("give null for a text that is not a record", () => {
    for (const text of ["", "{", "[]", '{"pid":0,"startedAt":1}', '{"pid":"7","startedAt":1}', '{"pid":7,"startedAt":1,"child":{"pid":-1,"startedAt":1}}'])
      expect(parseLockOwner(text), text).toBeNull();
  });
});

describe("acquireInstanceLock", () => {
  it("takes a free lock, writes the record and removes it at the release", async () => {
    const host = fakeHost();
    const result = await acquireInstanceLock(PATH, host.ports);
    expect(result.kind).toBe("acquired");
    expect(host.text(PATH)).toBe(lockText({ pid: 100, startedAt: WALL }));
    if (result.kind !== "acquired") return;
    expect(result.recovered).toBeNull();
    await result.lock.release();
    expect(host.text(PATH)).toBeNull();
    // a second release does nothing
    await result.lock.release();
  });

  it("gives held to a second process while the first is alive", async () => {
    const host = fakeHost();
    expect((await acquireInstanceLock(PATH, host.ports)).kind).toBe("acquired");
    const second = await acquireInstanceLock(PATH, other(host.ports, 200, WALL, host.processes));
    expect(second).toEqual({ kind: "held", owner: { pid: 100, startedAt: WALL } });
  });

  it("removes the lock of an owner that stopped, and tells why", async () => {
    const logger = testLogger();
    const host = fakeHost({ files: { [PATH]: lockText({ pid: 555, startedAt: WALL - 10_000 }) }, logger });
    const result = await acquireInstanceLock(PATH, host.ports);
    expect(result.kind === "acquired" && result.recovered).toBe("the owner process 555 stopped");
    expect(host.text(PATH)).toBe(lockText({ pid: 100, startedAt: WALL }));
    expect(host.text(`${PATH}.rm`)).toBeNull();
    expect(logger.messages("warn")).toEqual([`the host removed the stale lock ${PATH}: the owner process 555 stopped`]);
  });

  it("finds a process ID in use again by its start time", async () => {
    const host = fakeHost({ files: { [PATH]: lockText({ pid: 555, startedAt: WALL - 10_000 }) } });
    // a new process has the ID 555: it started after the record
    host.processes.set(555, WALL - 1000);
    expect((await acquireInstanceLock(PATH, host.ports)).kind).toBe("acquired");
  });

  it("counts an owner whose start time the system does not give as alive", async () => {
    const host = fakeHost({ files: { [PATH]: lockText({ pid: 555, startedAt: WALL - 10_000 }) } });
    host.processes.set(555, null);
    expect((await acquireInstanceLock(PATH, host.ports)).kind).toBe("held");
  });

  it("stays held while the child of a stopped owner is alive", async () => {
    const owner = { pid: 555, startedAt: WALL - 10_000, child: { pid: 777, startedAt: WALL - 9000 } };
    const host = fakeHost({ files: { [PATH]: lockText(owner) } });
    host.processes.set(777, WALL - 9000);
    expect(await acquireInstanceLock(PATH, host.ports)).toEqual({ kind: "held", owner });
    expect(await inspectInstanceLock(PATH, host.ports)).toEqual({ kind: "held", owner });
  });

  it("reads a malformed file again after a pause, and then removes it", async () => {
    const host = fakeHost({ files: { [PATH]: "{" } });
    const taking = acquireInstanceLock(PATH, host.ports, { tries: 3, pause: 100 });
    await host.settle();
    expect(host.text(PATH)).toBe("{");
    await host.clock.advance(100);
    await host.clock.advance(100);
    const result = await taking;
    expect(result.kind === "acquired" && result.recovered).toBe("the lock file was not a lock record");
    expect(host.text(PATH)).toBe(lockText({ pid: 100, startedAt: WALL }));
  });

  it("does not remove a lock that a removal of a live process holds", async () => {
    const host = fakeHost({
      files: { [PATH]: lockText({ pid: 555, startedAt: WALL - 10_000 }), [`${PATH}.rm`]: lockText({ pid: 300, startedAt: WALL - 5000 }) },
    });
    host.processes.set(300, WALL - 5000);
    const result = await acquireInstanceLock(PATH, host.ports);
    expect(result).toEqual({ kind: "failed", problem: `the lock ${PATH} did not come free after 6 tries` });
    expect(host.text(PATH)).toBe(lockText({ pid: 555, startedAt: WALL - 10_000 }));
  });

  it("writes the child in the record, and gives failed and not a throw when the file system fails", async () => {
    const host = fakeHost();
    const result = await acquireInstanceLock(PATH, host.ports, { child: { pid: 1000, startedAt: WALL } });
    expect(host.text(PATH)).toBe(lockText({ pid: 100, startedAt: WALL, child: { pid: 1000, startedAt: WALL } }));
    if (result.kind !== "acquired") throw new Error("no lock");
    await result.lock.update({ pid: 1001, startedAt: WALL + 5 });
    expect(result.lock.owner).toEqual({ pid: 100, startedAt: WALL, child: { pid: 1001, startedAt: WALL + 5 } });
    expect(parseLockOwner(host.text(PATH) ?? "")).toEqual(result.lock.owner);
    await result.lock.update(null);
    expect(host.text(PATH)).toBe(lockText({ pid: 100, startedAt: WALL }));
    const broken = fakeHost();
    broken.failFiles = (operation) => operation === "create";
    expect(await acquireInstanceLock(PATH, broken.ports)).toEqual({ kind: "failed", problem: `the file system failed: the fake create of ${PATH} failed` });
  });
});

describe("inspectInstanceLock never throws", () => {
  it("tells free, held, stale and malformed", async () => {
    const host = fakeHost();
    expect(await inspectInstanceLock(PATH, host.ports)).toEqual({ kind: "free" });
    host.files.set(PATH, lockText({ pid: 100, startedAt: WALL }));
    expect((await inspectInstanceLock(PATH, host.ports)).kind).toBe("held");
    host.files.set(PATH, lockText({ pid: 555, startedAt: WALL }));
    expect(await inspectInstanceLock(PATH, host.ports)).toEqual({ kind: "stale", owner: { pid: 555, startedAt: WALL }, why: "the owner process 555 stopped" });
    host.files.set(PATH, "not json");
    expect(await inspectInstanceLock(PATH, host.ports)).toEqual({ kind: "malformed", problem: "the lock file is not a lock record" });
    host.failFiles = () => true;
    expect(await inspectInstanceLock(PATH, host.ports)).toEqual({ kind: "malformed", problem: `the read failed: the fake read of ${PATH} failed` });
  });
});
